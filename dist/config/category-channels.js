/**
 * Category-Channel Configuration
 *
 * Unlike BRAND_CHANNELS (one channel per brand), these 3 channels aggregate items
 * from ALL tracked brands, routed by category instead of brand. They do NOT run their
 * own searches — items are classified from the same 15 brand searches already running,
 * so adding these channels costs zero extra Vinted requests and no extra rate-limit risk.
 */
// Shoes/pants are checked before polos: "Polo Ralph Lauren" is a brand name, not just a garment
// type, so titles like "Polo Ralph Lauren Sneaker" or "...Socken" contain the word "polo" without
// being an actual polo shirt — excludeKeywords below catches the ones that slip through anyway
// (cardigans, socks, dresses have no competing category keyword to naturally take priority).
export const CATEGORY_CHANNELS = [
    {
        category: "shoes",
        label: "Shoes",
        channelId: "1537851689363701853",
        // Vinted.de has French/Italian/Dutch sellers too, not just German — "baskets"/"scarpe"/
        // "chaussures" were being missed entirely, plus common sneaker model names that don't
        // include the word "shoe" at all (e.g. "Nike Dunk Low", "Salomon Speedcross 6").
        // Root/stem forms (not "schuhe"/"sandalen") so both singular and plural match via substring,
        // e.g. "schuh" matches both "Schuh" and "Schuhe", "basket" matches both "basket" and "baskets".
        keywords: [
            "schuh", "sneaker", "turnschuh", "boots", "stiefel", "sandale",
            "basket", "scarpe", "chaussures", "trekking",
            "af1", "air force", "dunk", "jordan", "blazer", "cortez",
            "yeezy", "ultraboost", "stan smith", "superstar", "campus", "gazelle", "samba", "nmd",
            "speedcross", "xt-6", "xt6",
        ],
    },
    {
        category: "pants",
        label: "Pants",
        channelId: "1537851940648656996",
        keywords: ["hose", "jeans", "pants", "chino", "cargo", "jogginghose", "sweatpants", "pantalon", "pantaloni", "broek"],
    },
    {
        category: "polos",
        label: "Polos",
        channelId: "1537852251270291537",
        keywords: ["polo", "poloshirt", "polohemd"],
        excludeKeywords: ["socken", "socks", "kleid", "dress", "cardigan", "strickjacke", "strickcardigan", "tasche", "bag", "mütze", "cap", "gürtel", "belt"],
    },
];
/**
 * Classifies an item title into a category by keyword match. Returns the first
 * matching category config, or undefined if the title doesn't match any category.
 */
export function classifyCategory(title) {
    const normalized = String(title || "").toLowerCase();
    if (!normalized)
        return undefined;
    return CATEGORY_CHANNELS.find((config) => {
        if (!config.keywords.some((kw) => normalized.includes(kw)))
            return false;
        if (config.excludeKeywords?.some((kw) => normalized.includes(kw)))
            return false;
        return true;
    });
}
