import { logger } from "../lib/logger.js";
import { ScrapedItem, SearchOptions, Scraper } from "./types.js";
import { execFile, spawn, ChildProcessWithoutNullStreams } from "child_process";
import { promisify } from "util";
import path from "path";
import { fileURLToPath } from "url";
import readline from "readline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFileAsync = promisify(execFile);

const VINTED_HELPER_PATH = path.join(__dirname, "../../vinted_helper.py");
const VINTED_DAEMON_PATH = path.join(__dirname, "../../vinted_daemon.py");

/**
 * One-shot fallback: spawns a fresh Python process per call and re-does the full cookie
 * bootstrap every time. This is the ORIGINAL approach, kept only as a safety net for if
 * the persistent daemon can't be started/kept alive — always a known-working path.
 */
async function scrapeViaOneShotPython(searchText: string, maxPrice?: number): Promise<ScrapedItem[]> {
  try {
    const args = [VINTED_HELPER_PATH, searchText];
    if (maxPrice && maxPrice > 0) args.push(maxPrice.toString());

    const { stdout, stderr } = await execFileAsync("python3", args, {
      timeout: 15000,
      maxBuffer: 1024 * 1024 * 5,
    });
    if (stderr) logger.warn(`Python stderr: ${stderr}`);

    const result = JSON.parse(stdout);
    if (!result.success) throw new Error(result.error || "Python scraper failed");
    return result.items || [];
  } catch (error) {
    logger.error(`❌ Python Vinted scraper (one-shot fallback) failed: ${String(error)}`);
    return [];
  }
}

// ---- Persistent daemon management ----
// One long-lived Python process keeps a single authenticated Vinted session alive and
// reused across every search, instead of re-doing the cookie-bootstrap dance from scratch
// on every call. Communication is line-delimited JSON over stdin/stdout.

export interface SellerEnrichment {
  reviewCount?: number;
  reviewRating?: number;
  sellerCountryCode?: string;
}

interface PendingSearchRequest {
  kind: "search";
  resolve: (items: ScrapedItem[]) => void;
  timeout: NodeJS.Timeout;
}

interface PendingEnrichRequest {
  kind: "enrich";
  resolve: (data: SellerEnrichment | null) => void;
  timeout: NodeJS.Timeout;
}

type PendingRequest = PendingSearchRequest | PendingEnrichRequest;

let daemonProcess: ChildProcessWithoutNullStreams | null = null;
let daemonReady = false;
let daemonReadyPromise: Promise<boolean> | null = null;
let requestCounter = 0;
const pendingRequests = new Map<string, PendingRequest>();
const DAEMON_REQUEST_TIMEOUT_MS = 20000;
let daemonRestartAttempts = 0;
const MAX_DAEMON_RESTART_ATTEMPTS = 5;
let daemonPermanentlyFailed = false;
let daemonStoppedIntentionally = false;

function startDaemon(): Promise<boolean> {
  if (daemonReadyPromise) return daemonReadyPromise;

  daemonReadyPromise = new Promise((resolveReady) => {
    logger.info("🐍 Starting persistent Vinted session daemon...");
    const proc = spawn("python3", [VINTED_DAEMON_PATH], { stdio: ["pipe", "pipe", "pipe"] });
    daemonProcess = proc;
    daemonReady = false;

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let data: any;
      try {
        data = JSON.parse(line);
      } catch {
        logger.warn(`🐍 Daemon sent unparseable line: ${line.slice(0, 200)}`);
        return;
      }

      if (data.type === "ready") {
        daemonReady = Boolean(data.ok);
        daemonRestartAttempts = 0;
        if (daemonReady) {
          logger.info("✅ Vinted session daemon ready (persistent session established)");
        } else {
          logger.warn("⚠️ Vinted session daemon started but could not establish a session");
        }
        resolveReady(daemonReady);
        return;
      }

      const pending = pendingRequests.get(data.id);
      if (!pending) return;
      pendingRequests.delete(data.id);
      clearTimeout(pending.timeout);

      if (pending.kind === "search") {
        if (data.success) {
          pending.resolve(data.items || []);
        } else {
          logger.warn(`⚠️ Daemon search failed: ${data.error || "unknown"}`);
          pending.resolve([]);
        }
      } else {
        if (data.success) {
          pending.resolve({
            reviewCount: data.reviewCount,
            reviewRating: data.reviewRating,
            sellerCountryCode: data.sellerCountryCode,
          });
        } else {
          pending.resolve(null);
        }
      }
    });

    proc.stderr.on("data", (chunk) => {
      logger.debug(`🐍 Daemon stderr: ${String(chunk).trim()}`);
    });

    proc.on("exit", (code, signal) => {
      daemonProcess = null;
      daemonReady = false;
      daemonReadyPromise = null;

      // Fail any in-flight requests immediately so callers don't hang until their own timeout.
      for (const [, pending] of pendingRequests) {
        clearTimeout(pending.timeout);
        if (pending.kind === "search") pending.resolve([]);
        else pending.resolve(null);
      }
      pendingRequests.clear();

      if (daemonStoppedIntentionally) {
        logger.info("🐍 Vinted session daemon stopped.");
        return;
      }

      logger.warn(`⚠️ Vinted session daemon exited unexpectedly (code=${code}, signal=${signal})`);

      if (daemonRestartAttempts < MAX_DAEMON_RESTART_ATTEMPTS) {
        daemonRestartAttempts++;
        const delay = Math.min(2000 * daemonRestartAttempts, 30000);
        logger.info(`🐍 Restarting Vinted session daemon in ${delay / 1000}s (attempt ${daemonRestartAttempts}/${MAX_DAEMON_RESTART_ATTEMPTS})...`);
        setTimeout(() => startDaemon(), delay);
      } else {
        logger.error(`❌ Vinted session daemon failed ${MAX_DAEMON_RESTART_ATTEMPTS} times in a row — falling back to one-shot mode for the rest of this run.`);
        daemonPermanentlyFailed = true;
      }
    });

    proc.on("error", (err) => {
      logger.error(`❌ Failed to spawn Vinted session daemon: ${String(err)}`);
      resolveReady(false);
    });
  });

  return daemonReadyPromise;
}

/** Call once at bot startup so the daemon's cookie bootstrap overlaps with Discord login instead of delaying the first search. */
export function startVintedDaemon(): void {
  if (!daemonPermanentlyFailed) startDaemon().catch(() => {});
}

/** Call on process shutdown (SIGTERM/SIGINT) so PM2 restarts never leave an orphaned Python process behind. */
export function stopVintedDaemon(): void {
  daemonStoppedIntentionally = true;
  if (daemonProcess) {
    daemonProcess.kill();
    daemonProcess = null;
  }
}

async function scrapeViaDaemon(searchText: string, maxPrice?: number): Promise<ScrapedItem[] | null> {
  if (daemonPermanentlyFailed) return null;

  if (!daemonProcess) {
    const ok = await startDaemon();
    if (!ok) return null;
  } else if (!daemonReady) {
    const ok = await daemonReadyPromise!;
    if (!ok) return null;
  }
  if (!daemonProcess) return null;

  const id = `req_${++requestCounter}_${Date.now()}`;
  return new Promise<ScrapedItem[]>((resolve) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      logger.warn(`⚠️ Daemon request timed out for "${searchText}"`);
      resolve([]);
    }, DAEMON_REQUEST_TIMEOUT_MS);

    pendingRequests.set(id, { kind: "search", resolve, timeout });

    const payload: Record<string, unknown> = { id, search_text: searchText };
    if (maxPrice && maxPrice > 0) payload.max_price = maxPrice;

    daemonProcess!.stdin.write(JSON.stringify(payload) + "\n", (err) => {
      if (err) {
        pendingRequests.delete(id);
        clearTimeout(timeout);
        logger.warn(`⚠️ Failed to write to daemon stdin: ${String(err)}`);
        resolve([]);
      }
    });
  });
}

/**
 * Real seller rating + country for ONE seller, fetched via the persistent daemon. Meant to be
 * called for every item that survives dedup and is about to be posted — NOT for raw search
 * results — so every published deal gets real data instead of a partial top-N subset.
 * Returns null if the daemon is unavailable or the lookup fails (caller should treat this the
 * same as "no data", not as an error worth retrying).
 */
export async function enrichSeller(sellerId: string | number | undefined | null): Promise<SellerEnrichment | null> {
  if (!sellerId) return null;
  if (daemonPermanentlyFailed) return null;

  if (!daemonProcess) {
    const ok = await startDaemon();
    if (!ok) return null;
  } else if (!daemonReady) {
    const ok = await daemonReadyPromise!;
    if (!ok) return null;
  }
  if (!daemonProcess) return null;

  const id = `enrich_${++requestCounter}_${Date.now()}`;
  return new Promise<SellerEnrichment | null>((resolve) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      resolve(null);
    }, DAEMON_REQUEST_TIMEOUT_MS);

    pendingRequests.set(id, { kind: "enrich", resolve, timeout });

    const payload = { id, action: "enrich_seller", seller_id: sellerId };
    daemonProcess!.stdin.write(JSON.stringify(payload) + "\n", (err) => {
      if (err) {
        pendingRequests.delete(id);
        clearTimeout(timeout);
        resolve(null);
      }
    });
  });
}

async function search(searchText: string, options: SearchOptions = {}): Promise<ScrapedItem[]> {
  logger.info(`🔍 Vinted (daemon): ${searchText}`);

  const daemonResult = await scrapeViaDaemon(searchText, options.maxPrice);
  if (daemonResult !== null) {
    logger.info(`✅ Vinted: ${daemonResult.length} items`);
    return daemonResult;
  }

  logger.warn(`⚠️ Vinted daemon unavailable, falling back to one-shot subprocess for "${searchText}"`);
  const items = await scrapeViaOneShotPython(searchText, options.maxPrice);
  logger.info(`✅ Vinted (fallback): ${items.length} items`);
  return items;
}

export const vintedScraper: Scraper = {
  name: "vinted",
  search,
};
