import { kleinanzeigenScraper } from "./kleinanzeigen.js";
import { vintedScraper } from "./vinted.js";
import { logger } from "../lib/logger.js";
/**
 * Source Hierarchy Configuration
 * - Primary: Vinted (always check first)
 * - Backup: Kleinanzeigen (only if Vinted fails or returns 0 results)
 */
const PRIMARY_SCRAPER = vintedScraper;
const BACKUP_SCRAPER = kleinanzeigenScraper;
const MAX_VINTED_RETRIES = 3;
const VINTED_RETRY_DELAY = 2000; // 2 seconds between retries
/**
 * Rate limiting state
 */
let rateLimitedUntil = 0;
let isInVintedOnlyWindow = false;
let vintedOnlyWindowStart = 0;
const VINTED_ONLY_WINDOW_DURATION = 30000; // 30 seconds
/**
 * Start a new Vinted-only window
 * During this window, only Vinted will be queried
 */
export function startVintedOnlyWindow() {
    isInVintedOnlyWindow = true;
    vintedOnlyWindowStart = Date.now();
    logger.info("🎯 Starting Vinted-only window (30 seconds)");
}
/**
 * Check if we're still in the Vinted-only window
 */
function isVintedOnlyWindowActive() {
    if (!isInVintedOnlyWindow)
        return false;
    const elapsed = Date.now() - vintedOnlyWindowStart;
    if (elapsed >= VINTED_ONLY_WINDOW_DURATION) {
        isInVintedOnlyWindow = false;
        logger.info("✅ Vinted-only window ended");
        return false;
    }
    return true;
}
/**
 * Set rate limit pause
 * @param durationMs Duration in milliseconds to pause all scrapers
 */
export function setRateLimit(durationMs) {
    rateLimitedUntil = Date.now() + durationMs;
    logger.warn(`⏸️ Rate limit activated for ${durationMs / 1000}s`);
}
/**
 * Check if we're currently rate limited
 */
export function isRateLimited() {
    return Date.now() < rateLimitedUntil;
}
/**
 * Search with Vinted (primary source) with retry logic
 */
async function searchVintedWithRetry(query, options, retryCount = 0) {
    try {
        logger.info(`🔍 Vinted search (attempt ${retryCount + 1}/${MAX_VINTED_RETRIES}): "${query}"`);
        const results = await PRIMARY_SCRAPER.search(query, options);
        if (results.length === 0 && retryCount < MAX_VINTED_RETRIES - 1) {
            logger.warn(`⚠️ Vinted returned 0 items, retrying in ${VINTED_RETRY_DELAY / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, VINTED_RETRY_DELAY));
            return searchVintedWithRetry(query, options, retryCount + 1);
        }
        return results;
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error(`❌ Vinted error (attempt ${retryCount + 1}): ${errorMsg}`);
        // Check for rate limiting (429)
        if (errorMsg.includes("429") || errorMsg.includes("Too Many Requests")) {
            logger.error("🚫 Rate limit detected (429) - pausing all scrapers for 10 minutes");
            setRateLimit(10 * 60 * 1000); // 10 minutes
            throw new Error("Rate limited - switching to backup");
        }
        if (retryCount < MAX_VINTED_RETRIES - 1) {
            logger.info(`⏳ Retrying Vinted in ${VINTED_RETRY_DELAY / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, VINTED_RETRY_DELAY));
            return searchVintedWithRetry(query, options, retryCount + 1);
        }
        throw error;
    }
}
/**
 * Search all platforms with source hierarchy
 * 1. Try Vinted first (with retries)
 * 2. If Vinted fails or returns 0 results after retries, use Kleinanzeigen as backup
 * 3. During Vinted-only window, skip Kleinanzeigen entirely
 */
export async function searchAllPlatforms(query, options = {}) {
    // Check if we're rate limited
    if (isRateLimited()) {
        const waitTime = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
        logger.warn(`⏸️ Rate limited - skipping search (${waitTime}s remaining)`);
        return [];
    }
    const allResults = [];
    // Try Vinted first (primary source)
    try {
        const vintedResults = await searchVintedWithRetry(query, options);
        if (vintedResults.length > 0) {
            logger.info(`✅ Vinted: ${vintedResults.length} items found`);
            allResults.push(...vintedResults);
            // If we got results from Vinted, we're done
            return allResults;
        }
        logger.warn("⚠️ Vinted returned 0 items after all retries");
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error(`❌ Vinted failed completely: ${errorMsg}`);
        // If rate limited, return empty results
        if (errorMsg.includes("Rate limited")) {
            return [];
        }
    }
    // Check if we're in Vinted-only window
    if (isVintedOnlyWindowActive()) {
        logger.info("🎯 Vinted-only window active - skipping Kleinanzeigen");
        return allResults;
    }
    // Fallback to Kleinanzeigen only if Vinted failed or returned 0 results
    logger.info("🔄 Falling back to Kleinanzeigen (backup source)");
    try {
        const kleinanzeigenResults = await BACKUP_SCRAPER.search(query, options);
        if (kleinanzeigenResults.length === 0) {
            logger.warn("⚠️ Kleinanzeigen also returned 0 items");
        }
        else {
            logger.info(`✅ Kleinanzeigen: ${kleinanzeigenResults.length} items found`);
            allResults.push(...kleinanzeigenResults);
        }
    }
    catch (error) {
        logger.error(`❌ Kleinanzeigen failed: ${String(error)}`);
    }
    return allResults;
}
/**
 * Export scrapers for direct access if needed
 */
export const SCRAPERS = [PRIMARY_SCRAPER, BACKUP_SCRAPER];
