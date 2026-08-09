/**
 * Brand-Channel Configuration
 * Maps each brand to its dedicated Discord channel ID and search query
 */
/**
 * Master brand-channel mapping
 * Each brand has a dedicated Discord channel for posting deals
 */
export const BRAND_CHANNELS = [
    {
        brand: "Lacoste",
        channelId: "1524155099029438545",
        query: "Lacoste Polo Jacke Tracksuit Sweatshirt",
        refreshInterval: 180,
    },
    {
        brand: "Ralph Lauren",
        channelId: "1524155913575858447",
        query: "Ralph Lauren Polo Jacke Pullover Hemd Cap",
        refreshInterval: 180,
    },
    {
        brand: "Nike",
        channelId: "1524155940075471110",
        query: "Nike Air Jordan Tech Fleece Tracksuit Sneaker",
        refreshInterval: 180,
    },
    {
        brand: "Adidas",
        channelId: "1524155964071084133",
        query: "Adidas Samba Gazelle Spezial Tracksuit Hoodie",
        refreshInterval: 180,
    },
    {
        brand: "Carhartt",
        channelId: "1524156123119095988",
        query: "Carhartt WIP Detroit Active Jacket Vintage",
        refreshInterval: 180,
    },
    {
        brand: "Fear of God",
        channelId: "1524162090305065230",
        query: "Essentials Fear of God Hoodie Sweatpants",
        refreshInterval: 180,
    },
    {
        brand: "Stüssy",
        channelId: "1524162183066419210",
        query: "Stüssy Vintage Hoodie T-Shirt Crewneck",
        refreshInterval: 180,
    },
    {
        brand: "Levi's",
        channelId: "1524162356584644760",
        query: "Levi's 501 Vintage Denim Jacke Jeans",
        refreshInterval: 180,
    },
    {
        brand: "Corteiz",
        channelId: "1524162447542452284",
        query: "Corteiz Alcatraz Hoodie T-Shirt Tracksuit",
        refreshInterval: 180,
    },
    {
        brand: "Supreme",
        channelId: "1524466165022331012",
        query: "Supreme Box Logo Hoodie Jacke T-Shirt",
        refreshInterval: 90,
    },
    {
        brand: "Arc'teryx",
        channelId: "1525547888317300776",
        query: "Arcteryx Gore-Tex Beta Alpha Atom Jacke",
        refreshInterval: 180,
    },
    {
        brand: "The North Face",
        channelId: "1525548069284872192",
        query: "The North Face Nuptse 700 Mountain Jacket",
        refreshInterval: 180,
    },
    {
        brand: "Salomon",
        channelId: "1525548207789183077",
        query: "Salomon XT-6 ACS Pro Gore-Tex Sneaker",
        refreshInterval: 180,
    },
    {
        brand: "Patagonia",
        channelId: "1525548346406605035",
        query: "Patagonia Synchilla Retro-X Fleece Jacke",
        refreshInterval: 180,
    },
    {
        brand: "Oakley",
        channelId: "1525548501520617592",
        query: "Oakley Software Y2K Archive Sonnenbrille",
        refreshInterval: 180,
    },
];
/**
 * Get randomized interval with jitter (±15%)
 */
export function getRandomizedInterval(baseInterval) {
    const jitter = 0.15; // ±15%
    const min = baseInterval * (1 - jitter);
    const max = baseInterval * (1 + jitter);
    return Math.floor(Math.random() * (max - min + 1) + min);
}
/**
 * Get brand configuration by brand name
 */
export function getBrandConfig(brandName) {
    return BRAND_CHANNELS.find((config) => config.brand.toLowerCase() === brandName.toLowerCase());
}
/**
 * Get all brand names
 */
export function getAllBrands() {
    return BRAND_CHANNELS.map((config) => config.brand);
}
