import { logger } from "../lib/logger.js";
import { ScrapedItem, SearchOptions, Scraper } from "./types.js";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { fileURLToPath } from "url";

// ESM __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execFileAsync = promisify(execFile);

/**
 * Call Python helper script to scrape Vinted using aiohttp (bypasses WAF)
 */
async function scrapeViaPython(searchText: string, maxPrice?: number): Promise<ScrapedItem[]> {
  try {
    const pythonScript = path.join(__dirname, "../../vinted_helper.py");
    const args = [pythonScript, searchText];
    
    if (maxPrice && maxPrice > 0) {
      args.push(maxPrice.toString());
    }
    
    logger.debug(`🐍 Calling Python helper: python3 ${args.join(" ")}`);
    
    const { stdout, stderr } = await execFileAsync("python3", args, {
      timeout: 5000, // 5s timeout
      maxBuffer: 1024 * 1024 * 5, // 5MB buffer
    });
    
    if (stderr) {
      logger.warn(`Python stderr: ${stderr}`);
    }
    
    const result = JSON.parse(stdout);
    
    if (!result.success) {
      throw new Error(result.error || "Python scraper failed");
    }
    
    return result.items || [];
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error(`❌ Python Vinted scraper failed: ${errorMsg}`);
    return [];
  }
}

async function search(searchText: string, options: SearchOptions = {}): Promise<ScrapedItem[]> {
  try {
    logger.info(`🔍 Vinted (Python): ${searchText}`);
    
    const items = await scrapeViaPython(searchText, options.maxPrice);
    
    logger.info(`✅ Vinted: ${items.length} items`);
    return items;
  } catch (error) {
    logger.error(`❌ Vinted: ${String(error)}`);
    return [];
  }
}

export const vintedScraper: Scraper = {
  name: "vinted",
  search,
};
