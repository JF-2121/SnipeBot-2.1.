import axios from "axios";
import * as cheerio from "cheerio";
import { logger } from "./lib/logger.js";
const KLEINANZEIGEN_BASE = "https://www.kleinanzeigen.de";
const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];
function randomUA() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}
const CATEGORY_MAPPING = {
    shirts: "87", // Herrenkleidung
    pants: "87", // Herrenkleidung
    shoes: "158", // Herrenschuhe
    accessories: "87", // Herrenkleidung (for general items)
};
function getCategoryId(categoryKey) {
    return CATEGORY_MAPPING[categoryKey] || "87";
}
function parsePrice(priceText) {
    // Handle formats: "50 €", "50€", "VB", "Zu verschenken"
    const cleaned = priceText.replace(/\s+/g, "").toLowerCase();
    if (cleaned.includes("verschenken") || cleaned === "vb") {
        return 0;
    }
    const match = cleaned.match(/(\d+(?:[.,]\d+)?)/);
    return match ? parseFloat(match[1].replace(",", ".")) : 0;
}
function extractBrand(title, searchQuery) {
    const brands = ["Nike", "Adidas", "Lacoste", "Ralph Lauren", "Carhartt", "Puma", "Tommy Hilfiger"];
    const titleLower = title.toLowerCase();
    for (const brand of brands) {
        if (titleLower.includes(brand.toLowerCase())) {
            return brand;
        }
    }
    // Fallback to first word of search query
    return searchQuery.split(" ")[0] || "—";
}
function extractSize(title) {
    // Match common size formats: M, L, XL, XXL, 42, 44, 46, etc.
    const sizePatterns = [
        /\b(XXS|XS|S|M|L|XL|XXL|XXXL)\b/i,
        /\b(3XL|4XL|5XL)\b/i,
        /\bGr\.?\s*(\d{2})\b/i,
        /\bGröße\s*(\d{2})\b/i,
        /\b(\d{2})\s*\/\s*\d{2}\b/,
        /\b(\d{2})\b(?=\s|$)/,
    ];
    for (const pattern of sizePatterns) {
        const match = title.match(pattern);
        if (match) {
            return match[1] || match[0];
        }
    }
    return "—";
}
function isValidMensSize(size) {
    if (size === "—")
        return true; // Allow unknown sizes
    const sizeUpper = size.toUpperCase();
    // Valid letter sizes for men
    const validLetterSizes = ["S", "M", "L", "XL", "XXL", "XXXL", "3XL", "4XL"];
    if (validLetterSizes.includes(sizeUpper))
        return true;
    // Valid numeric sizes (42-48 for men)
    const numericSize = parseInt(size);
    if (!isNaN(numericSize) && numericSize >= 42 && numericSize <= 48)
        return true;
    return false;
}
function isQualityDeal(item, searchText) {
    const titleLower = item.title.toLowerCase();
    // Filter out kids items
    const kidsKeywords = ["kinder", "baby", "junge", "mädchen", "kids", "junior"];
    if (kidsKeywords.some(k => titleLower.includes(k)))
        return false;
    // Filter out damaged/defect items
    const defectKeywords = ["defekt", "kaputt", "beschädigt", "riss", "loch", "fleck"];
    if (defectKeywords.some(k => titleLower.includes(k)))
        return false;
    // Must have valid brand
    const brands = ["nike", "adidas", "lacoste", "ralph lauren", "carhartt", "puma", "tommy hilfiger"];
    const hasBrand = brands.some(b => titleLower.includes(b));
    if (!hasBrand)
        return false;
    // Check size validity for clothing
    if (!isValidMensSize(item.size))
        return false;
    // Price must be reasonable (not free, not suspiciously cheap)
    if (item.price < 1 || item.price > 200)
        return false;
    return true;
}
export async function searchKleinanzeigen(searchText, options = {}) {
    try {
        const categoryId = options.category ? getCategoryId(options.category) : "87";
        // Build search URL
        const params = new URLSearchParams({
            keywords: searchText,
            sortingField: "SORTING_DATE", // Newest first
        });
        if (options.maxPrice && options.maxPrice > 0) {
            params.append("maxPrice", options.maxPrice.toString());
        }
        // Use men's clothing section for all searches
        const searchUrl = `${KLEINANZEIGEN_BASE}/s-herrenbekleidung/c87?${params.toString()}`;
        logger.info(`🔍 Kleinanzeigen Suche: ${searchText}`);
        const headers = {
            "User-Agent": randomUA(),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
            "Accept-Encoding": "gzip, deflate, br",
            "Connection": "keep-alive",
            "Upgrade-Insecure-Requests": "1",
        };
        const response = await axios.get(searchUrl, {
            headers,
            timeout: 12000,
            validateStatus: () => true,
        });
        if (response.status !== 200) {
            logger.warn(`⚠️ Kleinanzeigen Status ${response.status}`);
            return [];
        }
        const $ = cheerio.load(response.data);
        const items = [];
        // Kleinanzeigen uses article.aditem for listings
        $("article.aditem").each((_, element) => {
            try {
                const $item = $(element);
                const id = $item.attr("data-adid") || "";
                if (!id)
                    return;
                const title = $item.find(".ellipsis").first().text().trim();
                if (!title)
                    return;
                const priceText = $item.find(".aditem-main--middle--price-shipping--price").text().trim();
                const price = parsePrice(priceText);
                const relativeUrl = $item.find("a.ellipsis").attr("href") || "";
                const url = relativeUrl.startsWith("http") ? relativeUrl : `${KLEINANZEIGEN_BASE}${relativeUrl}`;
                // Extract image URL - try multiple selectors
                let imageUrl = $item.find("img.galleryimage-element").attr("src") || "";
                if (!imageUrl) {
                    imageUrl = $item.find("img").first().attr("src") || "";
                }
                // Ensure full URL
                if (imageUrl && !imageUrl.startsWith("http")) {
                    imageUrl = imageUrl.startsWith("//") ? `https:${imageUrl}` : `${KLEINANZEIGEN_BASE}${imageUrl}`;
                }
                const location = $item.find(".aditem-main--top--left").text().trim();
                const brand = extractBrand(title, searchText);
                const size = extractSize(title);
                const item = {
                    id,
                    title,
                    price,
                    currency: "EUR",
                    brand,
                    size,
                    condition: "—",
                    imageUrl,
                    url,
                    seller: "—",
                    location: location || "—",
                    platform: "kleinanzeigen",
                };
                // Only add quality deals
                if (isQualityDeal(item, searchText)) {
                    items.push(item);
                }
            }
            catch (err) {
                logger.warn("Fehler beim Parsen eines Kleinanzeigen-Items:", err);
            }
        });
        const validItems = items.filter(item => item.price > 0);
        logger.info(`✅ Kleinanzeigen: ${validItems.length} Items gefunden`);
        return validItems;
    }
    catch (error) {
        logger.error(`❌ Kleinanzeigen Fehler: ${String(error)}`);
        return [];
    }
}
