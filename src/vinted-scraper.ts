import axios from "axios";
import { logger } from "./lib/logger.js";
import { PROXY_BRIDGE_URL, VINTED_USER_AGENT, PROXY_RETRY_CONFIG } from "./config/proxy.js";

export interface VintedItem {
  id: string;
  title: string;
  price: number;
  currency: string;
  brand: string;
  size: string;
  condition: string;
  imageUrl: string;
  url: string;
  seller: string;
  sellerId?: string;
  platform: "vinted";
  countryTitle?: string;
  photos?: string[];
  reviewCount?: number;
  publishedAt?: string;
}

export interface SearchOptions {
  maxPrice?: number;
  catalogIds?: number[];
}

// Support multiple Vinted marketplaces
const VINTED_MARKETPLACES: Record<string, string> = {
  "de": "https://www.vinted.de",
  "fr": "https://www.vinted.fr",
  "uk": "https://www.vinted.co.uk",
  "pl": "https://www.vinted.pl",
  "cz": "https://www.vinted.cz",
  "lt": "https://www.vinted.lt",
  "es": "https://www.vinted.es",
  "it": "https://www.vinted.it",
  "be": "https://www.vinted.be",
  "nl": "https://www.vinted.nl",
  "at": "https://www.vinted.at",
};

// Country to flag emoji mapping
export const COUNTRY_FLAGS: Record<string, string> = {
  "Germany": "🇩🇪",
  "France": "🇫🇷",
  "United Kingdom": "🇬🇧",
  "Poland": "🇵🇱",
  "Czech Republic": "🇨🇿",
  "Lithuania": "🇱🇹",
  "Spain": "🇪🇸",
  "Italy": "🇮🇹",
  "Belgium": "🇧🇪",
  "Netherlands": "🇳🇱",
  "Austria": "🇦🇹",
  "Deutschland": "🇩🇪",
  "Frankreich": "🇫🇷",
  "Vereinigtes Königreich": "🇬🇧",
  "Polen": "🇵🇱",
  "Tschechien": "🇨🇿",
  "Litauen": "🇱🇹",
  "Spanien": "🇪🇸",
  "Italien": "🇮🇹",
  "Belgien": "🇧🇪",
  "Niederlande": "🇳🇱",
  "Österreich": "🇦🇹",
};

const VINTED_BASE = "https://www.vinted.de";

const CONDITION_LABELS: Record<string, string> = {
  "1": "Neu mit Etikett",
  "2": "Sehr gut",
  "3": "Gut",
  "4": "Befriedigend",
  new_with_tags: "Neu mit Etikett",
  very_good: "Sehr gut",
  good: "Gut",
  satisfactory: "Befriedigend",
};

/**
 * Fetches content via the proxy bridge with retry logic
 */
async function fetchViaProxy(targetUrl: string, retryCount = 0): Promise<string> {
  try {
    const proxyUrl = `${PROXY_BRIDGE_URL}/fetch-vinted?url=${encodeURIComponent(targetUrl)}`;
    logger.info(`🔄 Fetching via proxy: ${targetUrl}`);
    
    const response = await axios.get(proxyUrl, {
      timeout: 15000,
      validateStatus: () => true,
    });

    if (response.status === 500 || response.status >= 400) {
      throw new Error(`Proxy returned status ${response.status}`);
    }

    return response.data;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.warn(`⚠️ Proxy bridge error (attempt ${retryCount + 1}/${PROXY_RETRY_CONFIG.maxRetries}): ${errorMsg}`);
    
    if (retryCount < PROXY_RETRY_CONFIG.maxRetries) {
      logger.info(`⏳ Waiting ${PROXY_RETRY_CONFIG.retryDelay / 1000}s before retry...`);
      await new Promise(resolve => setTimeout(resolve, PROXY_RETRY_CONFIG.retryDelay));
      return fetchViaProxy(targetUrl, retryCount + 1);
    }
    
    throw new Error(`Proxy bridge failed after ${PROXY_RETRY_CONFIG.maxRetries} attempts: ${errorMsg}`);
  }
}

export function parseItem(item: Record<string, any>): VintedItem {
  const photos = (item["photos"] as Record<string, any>[]) ?? [];
  const firstPhoto = photos[0];
  const thumbnails = (firstPhoto?.["thumbnails"] as Record<string, any>[]) ?? [];
  const bigThumb = thumbnails.find((t) => (t["type"] as string) === "thumb310x430");
  const imageUrl =
    (bigThumb?.["url"] as string) ??
    (firstPhoto?.["url"] as string) ??
    (firstPhoto?.["full_size_url"] as string) ??
    "";

  // Extract all photo URLs
  const allPhotos = photos.map((photo: Record<string, any>) => {
    const thumbs = (photo["thumbnails"] as Record<string, any>[]) ?? [];
    const bigThumb = thumbs.find((t) => (t["type"] as string) === "thumb310x430");
    return (bigThumb?.["url"] as string) ?? (photo["url"] as string) ?? (photo["full_size_url"] as string) ?? "";
  }).filter(Boolean);

  const priceObj = (item["price"] as Record<string, any>) ?? {};
  const statusObj = (item["status"] as Record<string, any>) ?? {};
  const sizeObj = (item["size"] as Record<string, any>) ?? {};
  const userObj = (item["user"] as Record<string, any>) ?? {};
  const rawCondition = String(statusObj["value"] ?? item["status"] ?? "");

  // Extract country information
  const countryTitle = String(
    item["country_title"] ?? 
    userObj["country_title"] ?? 
    ""
  );

  // Extract review count
  const reviewCount = parseInt(String(userObj["feedback_reputation"] ?? userObj["positive_feedback_count"] ?? "0"), 10);

  // Extract published timestamp
  const publishedAt = String(item["photo_updated_at"] ?? item["created_at_ts"] ?? "");

  return {
    id: String(item["id"] ?? ""),
    title: String(item["title"] ?? ""),
    price: parseFloat(String(priceObj["amount"] ?? item["price_numeric"] ?? "0")),
    currency: String(priceObj["currency_code"] ?? "EUR"),
    brand: String(item["brand_title"] ?? ""),
    size: String(sizeObj["title"] ?? item["size_title"] ?? ""),
    condition: CONDITION_LABELS[rawCondition] ?? rawCondition,
    imageUrl,
    url: `${VINTED_BASE}/items/${item["id"]}`,
    seller: String(userObj["login"] ?? ""),
    sellerId: String(userObj["id"] ?? ""),
    platform: "vinted",
    countryTitle,
    photos: allPhotos,
    reviewCount,
    publishedAt,
  };
}

export async function searchVinted(
  searchText: string,
  options: SearchOptions = {},
): Promise<VintedItem[]> {
  try {
    // Build catalog URL like Python version (public page, no auth needed)
    const params = new URLSearchParams({
      "search_text": searchText,
      "order": "newest_first",
    });
    
    if (options.maxPrice && options.maxPrice > 0) {
      params.append("price_to", options.maxPrice.toString());
    }
    
    if (options.catalogIds && options.catalogIds.length > 0) {
      params.append("catalog_ids", options.catalogIds.join(","));
    }

    const catalogUrl = `${VINTED_BASE}/catalog?${params.toString()}`;
    logger.info(`🔍 Vinted Suche: ${searchText}`);

    // Fetch via proxy bridge
    const html = await fetchViaProxy(catalogUrl);
    const jsonMatch = html.match(/<script[^>]*>window\.App\s*=\s*({.*?})<\/script>/s);
    
    if (!jsonMatch) {
      logger.warn("⚠️ Konnte keine Vinted-Daten im HTML finden");
      return [];
    }

    const appData = JSON.parse(jsonMatch[1]);
    const items: Record<string, any>[] = appData?.items?.catalogItems ?? [];
    
    if (items.length === 0) {
      logger.info("✅ Vinted: 0 Items gefunden");
      return [];
    }

    const parsed = items.map(parseItem).filter(item => item.id && item.price > 0);
    logger.info(`✅ Vinted: ${parsed.length} Items gefunden`);
    return parsed;

  } catch (error) {
    logger.error(`❌ Vinted Fehler: ${String(error)}`);
    return [];
  }
}

export async function findCheaperAlternatives(
  item: VintedItem,
  maxResults = 5,
): Promise<VintedItem[]> {
  if (!item.brand) return [];
  const targetPrice = item.price - 0.01;
  if (targetPrice <= 0) return [];

  try {
    const results = await searchVinted(`${item.brand} ${item.title.split(" ").slice(0, 3).join(" ")}`, {
      maxPrice: targetPrice,
    });

    return results
      .filter((r) => r.id !== item.id && r.price < item.price)
      .sort((a, b) => a.price - b.price)
      .slice(0, maxResults);
  } catch {
    return [];
  }
}
