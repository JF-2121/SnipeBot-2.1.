import * as cheerio from "cheerio";
import { logger } from "../lib/logger.js";
import { fetchWithRetry } from "../utils/fetchWrapper.js";
const KLEINANZEIGEN_BASE = "https://www.kleinanzeigen.de";
const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
];
function randomUA() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}
function parsePrice(priceText) {
    const cleaned = priceText.replace(/\s+/g, "").toLowerCase();
    if (cleaned.includes("verschenken") || cleaned === "vb")
        return 0;
    const match = cleaned.match(/(\d+(?:[.,]\d+)?)/);
    return match ? parseFloat(match[1].replace(",", ".")) : 0;
}
function extractBrand(title, searchQuery) {
    const brands = [
        "Nike", "Adidas", "Carhartt", "Lacoste", "Ralph Lauren", "Tommy Hilfiger",
        "Fred Perry", "Hugo Boss", "Burberry", "Hermes", "Louis Vuitton",
        "Loro Piana", "Brooks Brothers", "Stussy", "Supreme", "Palace", "Dickies"
    ];
    const titleLower = title.toLowerCase();
    for (const brand of brands) {
        if (titleLower.includes(brand.toLowerCase()))
            return brand;
    }
    return searchQuery.split(" ")[0] || "—";
}
function extractSize(title) {
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
        if (match)
            return match[1] || match[0];
    }
    return "—";
}
function isValidMensSize(size) {
    if (size === "—")
        return true;
    const sizeUpper = size.toUpperCase();
    const validLetterSizes = ["S", "M", "L", "XL", "XXL", "XXXL", "3XL", "4XL"];
    if (validLetterSizes.includes(sizeUpper))
        return true;
    const numericSize = parseInt(size);
    if (!isNaN(numericSize) && numericSize >= 42 && numericSize <= 48)
        return true;
    return false;
}
function parseUploadDate(dateText) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (dateText.includes("Heute") || dateText.includes("heute")) {
        return today;
    }
    if (dateText.includes("Gestern") || dateText.includes("gestern")) {
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        return yesterday;
    }
    const match = dateText.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    if (match) {
        const day = parseInt(match[1]);
        const month = parseInt(match[2]) - 1;
        const year = parseInt(match[3]);
        return new Date(year, month, day);
    }
    return null;
}
function isWithin7Days(uploadDate) {
    if (!uploadDate)
        return false;
    const now = new Date();
    const diffMs = now.getTime() - uploadDate.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    return diffDays <= 7;
}
function isQualityDeal(item, searchText, uploadDate) {
    const titleLower = item.title.toLowerCase();
    const kidsKeywords = ["kinder", "baby", "junge", "mädchen", "kids", "junior"];
    if (kidsKeywords.some(k => titleLower.includes(k)))
        return false;
    const defectKeywords = ["defekt", "kaputt", "beschädigt", "riss", "loch", "fleck"];
    if (defectKeywords.some(k => titleLower.includes(k)))
        return false;
    const brands = [
        "nike", "adidas", "carhartt", "lacoste", "ralph lauren", "tommy hilfiger",
        "fred perry", "hugo boss", "burberry", "hermes", "louis vuitton",
        "loro piana", "brooks brothers", "stussy", "supreme", "palace", "dickies"
    ];
    const hasBrand = brands.some(b => titleLower.includes(b));
    if (!hasBrand)
        return false;
    if (!isValidMensSize(item.size))
        return false;
    if (item.price < 1 || item.price > 200)
        return false;
    if (!isWithin7Days(uploadDate))
        return false;
    return true;
}
async function search(searchText, options = {}) {
    try {
        const category = options.category || "accessories";
        const categoryPath = category === "shoes" ? "c153" : "c153";
        const params = new URLSearchParams({
            keywords: searchText,
            sortingField: "SORTING_DATE",
        });
        if (options.maxPrice && options.maxPrice > 0) {
            params.append("maxPrice", options.maxPrice.toString());
        }
        const searchUrl = `${KLEINANZEIGEN_BASE}/s-herrenbekleidung/${categoryPath}?${params.toString()}`;
        logger.info(`🔍 Kleinanzeigen: ${searchText}`);
        const response = await fetchWithRetry(searchUrl, {
            headers: {
                "User-Agent": randomUA(),
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
                "Accept-Encoding": "gzip, deflate, br",
                "Connection": "keep-alive",
                "Upgrade-Insecure-Requests": "1",
            },
        });
        kleinanzeigenScraper.lastRawHtml = response.data;
        const $ = cheerio.load(response.data);
        const items = [];
        $("article.aditem").each((_, element) => {
            try {
                const $item = $(element);
                const id = $item.attr("data-adid") || "";
                if (!id)
                    return;
                const rawTitle = $item.find(".ellipsis").first().text().trim();
                if (!rawTitle)
                    return;
                // Clean title (remove excessive whitespace/junk)
                const cleanTitle = rawTitle.replace(/\s+/g, " ").replace(/\|/g, "-").trim();
                const priceText = $item.find(".aditem-main--middle--price-shipping--price").text().trim();
                const price = parsePrice(priceText);
                const dateText = $item.find(".aditem-main--top--right").text().trim();
                // Fallback to 'now' when date is missing so items are not excluded
                const uploadDate = parseUploadDate(dateText) || new Date();
                const relativeUrl = $item.find("a.ellipsis").attr("href") || "";
                const link = relativeUrl.startsWith("http") ? relativeUrl : `${KLEINANZEIGEN_BASE}${relativeUrl}`;
                // Extract up to 3 images from the listing preview
                const images = [];
                $item.find("img").each((_, imgEl) => {
                    if (images.length >= 3)
                        return;
                    let src = $(imgEl).attr("data-src") || $(imgEl).attr("src") || "";
                    if (!src)
                        return;
                    if (!src.startsWith("http")) {
                        src = src.startsWith("//") ? `https:${src}` : `${KLEINANZEIGEN_BASE}${src}`;
                    }
                    if (!images.includes(src))
                        images.push(src);
                });
                // Ensure at least one main image
                let mainImage = images[0] || "";
                if (!mainImage) {
                    mainImage = "https://i.imgur.com/8Km9tLL.png"; // generic placeholder avatar/image
                }
                const brand = extractBrand(cleanTitle, searchText);
                const size = extractSize(cleanTitle);
                // Seller information (listing preview doesn't always include seller) - provide safe fallbacks
                const sellerUsername = $item.find(".seller-name, .user-name").first().text().trim() || "Kleinanzeigen Verkäufer";
                const sellerAvatar = $item.find("img.user-avatar").attr("src") || sellerUsername ? "https://i.imgur.com/8Km9tLL.png" : "https://i.imgur.com/8Km9tLL.png";
                const condition = $item.find(".condition, .aditem-attributes").first().text().trim() || "—";
                const shortDescription = $item.find(".aditem-main--middle--description").text().trim() || "Keine Beschreibung";
                // Compose totalPrice (Kleinanzeigen: no protection fee assumed)
                const totalPrice = Number(price || 0);
                const item = {
                    id,
                    title: cleanTitle,
                    price,
                    size,
                    brand,
                    link,
                    imageUrl: mainImage,
                    platform: "kleinanzeigen",
                    // Extended fields to match Vinted's updated structure
                    cleanTitle,
                    sellerUsername: sellerUsername || "Kleinanzeigen Verkäufer",
                    sellerAvatar: sellerAvatar || "https://i.imgur.com/8Km9tLL.png",
                    condition: condition || "—",
                    publishedAt: uploadDate ? (uploadDate instanceof Date ? (uploadDate.toDateString() === new Date().toDateString() ? "Gerade eben" : uploadDate.toLocaleDateString("de-DE")) : String(uploadDate)) : "Gerade eben",
                    description: shortDescription,
                    images_array: images,
                    main_image_url: mainImage,
                    totalPrice: totalPrice,
                    buyerProtectionFee: 0,
                };
                if (isQualityDeal(item, searchText, uploadDate)) {
                    items.push(item);
                }
            }
            catch (err) {
                logger.warn("Parse error:", err);
            }
        });
        logger.info(`✅ Kleinanzeigen: ${items.length} items`);
        return items;
    }
    catch (error) {
        logger.error(`❌ Kleinanzeigen: ${String(error)}`);
        return [];
    }
}
export const kleinanzeigenScraper = {
    name: "kleinanzeigen",
    search,
};
