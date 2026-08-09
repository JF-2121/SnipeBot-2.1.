import { Client, GatewayIntentBits, EmbedBuilder, TextChannel, Events, ActivityType, SlashCommandBuilder, REST, Routes, ButtonBuilder, ButtonStyle, ActionRowBuilder, } from "discord.js";
import axios from "axios";
import { CATEGORIES } from "./config/categories.js";
import { BRAND_CHANNELS, getRandomizedInterval, getAllBrands } from "./config/brand-channels.js";
import { logger } from "./lib/logger.js";
import { vintedScraper } from "./scrapers/vinted.js";
import { kleinanzeigenScraper } from "./scrapers/kleinanzeigen.js";
import { COUNTRY_FLAGS } from "./vinted-scraper.js";
const FALLBACK_CHANNEL_ID = "1483482170583678976";
const DEFAULT_BRANDS = getAllBrands();
const itemCache = new Map();
const MAX_CACHE_SIZE = 2000;
const CACHE_TTL_MS = 3600000; // 1 hour in milliseconds
function cacheItem(item) {
    const cached = {
        item,
        timestamp: Date.now()
    };
    itemCache.set(item.id, cached);
    // LRU eviction: Remove oldest entries if cache exceeds size
    if (itemCache.size > MAX_CACHE_SIZE) {
        // Find oldest entry
        let oldestKey = null;
        let oldestTime = Date.now();
        for (const [key, value] of itemCache.entries()) {
            if (value.timestamp < oldestTime) {
                oldestTime = value.timestamp;
                oldestKey = key;
            }
        }
        if (oldestKey) {
            itemCache.delete(oldestKey);
            logger.debug(`🗑️ LRU eviction: Removed item ${oldestKey} (age: ${Math.floor((Date.now() - oldestTime) / 1000)}s)`);
        }
    }
}
function getCachedItem(itemId) {
    const cached = itemCache.get(itemId);
    if (!cached) {
        return null;
    }
    const age = Date.now() - cached.timestamp;
    // Check if item is within 1-hour window
    if (age > CACHE_TTL_MS) {
        itemCache.delete(itemId);
        logger.debug(`⏰ Cache expired: Item ${itemId} (age: ${Math.floor(age / 1000)}s)`);
        return null;
    }
    return cached.item;
}
const WHOP_API_KEY = process.env["WHOP_API_KEY"];
const WHOP_PRODUCT_ID = process.env["WHOP_PRODUCT_ID"];
const licenseCache = new Map();
async function isGuildLicensed(guildId) {
    if (!WHOP_API_KEY || !WHOP_PRODUCT_ID)
        return true;
    const cached = licenseCache.get(guildId);
    if (cached && Date.now() < cached.expiry)
        return cached.valid;
    try {
        const res = await axios.get("https://api.whop.com/api/v2/memberships", {
            headers: { Authorization: `Bearer ${WHOP_API_KEY}` },
            params: { product_id: WHOP_PRODUCT_ID, metadata_discord_guild_id: guildId, valid: true },
            timeout: 8000,
        });
        const valid = (res.data?.data?.length ?? 0) > 0;
        licenseCache.set(guildId, { valid, expiry: Date.now() + 10 * 60 * 1000 });
        return valid;
    }
    catch (err) {
        logger.error("Whop license check failed for Guild " + guildId + ": " + String(err));
        return false;
    }
}
const CATEGORY_CHOICES = [
    { name: "Shirts & Polos", value: "shirts" },
    { name: "Hosen & Jeans", value: "pants" },
    { name: "Schuhe", value: "shoes" },
    { name: "Accessoires", value: "accessories" },
];
const watchConfig = {
    brands: [...DEFAULT_BRANDS],
    maxPrice: undefined,
    active: true,
    categoryKey: "accessories",
    gender: "beide",
};
const seenItemIds = new Set();
let rateLimitedUntil = 0;
let consecutiveRateLimits = 0;
function genderLabel(g) {
    if (g === "herren")
        return "Herren";
    if (g === "damen")
        return "Damen";
    return "Herren & Damen";
}
async function findChannelByName(client, channelName) {
    for (const [, guild] of client.guilds.cache) {
        const ch = guild.channels.cache.find((c) => c.name === channelName && c instanceof TextChannel);
        if (ch)
            return ch;
    }
    return null;
}
async function getFallbackChannel(client) {
    try {
        const ch = await client.channels.fetch(FALLBACK_CHANNEL_ID);
        if (ch instanceof TextChannel)
            return ch;
    }
    catch { /* ignore */ }
    return null;
}
function runFakeCheck(item) {
    const warnings = [];
    const positives = [];
    let riskScore = 0;
    const knownExpensiveBrands = ["ralph lauren", "lacoste", "carhartt"];
    const isExpensiveBrand = knownExpensiveBrands.some((b) => item.brand.toLowerCase().includes(b));
    if (item.price < 3) {
        warnings.push("💸 Preis extrem niedrig (unter 3€)");
        riskScore += 35;
    }
    else if (item.price < 8 && isExpensiveBrand) {
        warnings.push("💸 Preis sehr niedrig für diese Marke");
        riskScore += 20;
    }
    else if (item.price < 5) {
        warnings.push("💸 Preis sehr niedrig");
        riskScore += 15;
    }
    else {
        positives.push("💰 Preis im normalen Bereich");
    }
    if (!item.condition || item.condition === "—") {
        warnings.push("❓ Kein Zustand angegeben");
        riskScore += 10;
    }
    else if (item.condition.toLowerCase().includes("neu")) {
        positives.push("✨ Als 'Neu' eingestuft");
    }
    else {
        positives.push(`✨ Zustand: ${item.condition}`);
    }
    if (!item.size || item.size === "—") {
        warnings.push("📐 Keine Größenangabe");
        riskScore += 10;
    }
    else {
        positives.push(`📐 Größe angegeben: ${item.size}`);
    }
    if (item.brand && !item.title.toLowerCase().includes(item.brand.toLowerCase())) {
        warnings.push("🏷️ Markenname nicht im Titel");
        riskScore += 15;
    }
    else if (item.brand) {
        positives.push("🏷️ Markenname im Titel bestätigt");
    }
    if (!item.seller || item.seller === "—") {
        warnings.push("👤 Kein Verkäufername");
        riskScore += 10;
    }
    else {
        positives.push(`👤 Verkäufer: ${item.seller}`);
    }
    let verdict;
    let color;
    if (riskScore >= 45) {
        verdict = "🔴 HOHES RISIKO — Vorsicht!";
        color = 0xff0000;
    }
    else if (riskScore >= 20) {
        verdict = "🟡 MITTLERES RISIKO — Genau prüfen";
        color = 0xffa500;
    }
    else {
        verdict = "🟢 NIEDRIGES RISIKO — Wirkt legitim";
        color = 0x00cc66;
    }
    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(`🔍 Fake-Check: ${item.brand || "—"} | ${item.title}`.slice(0, 250))
        .setURL(item.url)
        .setDescription(`**${verdict}**\nRisiko-Score: **${riskScore}/100**`)
        .addFields({ name: "💰 Preis", value: `${item.price.toFixed(2)} ${item.currency}`, inline: true }, { name: "🏷️ Marke", value: item.brand || "—", inline: true }, { name: "📐 Größe", value: item.size || "—", inline: true }, { name: "✨ Zustand", value: item.condition || "—", inline: true }, { name: "👤 Verkäufer", value: item.seller || "—", inline: true })
        .setFooter({ text: "Fake-Check • Snipebot" })
        .setTimestamp();
    if (warnings.length > 0)
        embed.addFields({ name: "⚠️ Warnzeichen", value: warnings.join("\n") });
    if (positives.length > 0)
        embed.addFields({ name: "✅ Positive Zeichen", value: positives.join("\n") });
    if (item.imageUrl)
        embed.setThumbnail(item.imageUrl);
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("🔗 Inserat öffnen").setStyle(ButtonStyle.Link).setURL(item.url));
    return { embed, row };
}
function buildDealEmbed(item) {
    // Extract all metadata - NO validation, just display what we have
    const countryTitle = item.countryTitle || "Germany";
    const condition = item.condition || "N/A";
    const photos = item.photos || [];
    const publishedAt = item.publishedAt || "";
    const reviewCount = item.reviewCount || 0;
    // SIZE: Always show, even if N/A
    const size = item.size || "N/A";
    // CONDITION: Always show, even if N/A
    const conditionDisplay = condition;
    // REVIEWS: Always show
    const reviewsDisplay = reviewCount > 0 ? `⭐ ${reviewCount}` : "N/A";
    // PUBLISHED: Parse timestamp or show N/A
    let published = "N/A";
    if (publishedAt && publishedAt !== "") {
        try {
            // Try parsing as Unix timestamp first
            const timestamp = parseInt(publishedAt) * 1000;
            if (!isNaN(timestamp) && timestamp > 0) {
                const now = Date.now();
                const diff = Math.floor((now - timestamp) / 1000);
                if (diff < 60)
                    published = "vor wenigen Sekunden";
                else if (diff < 3600)
                    published = `vor ${Math.floor(diff / 60)} Min.`;
                else if (diff < 86400)
                    published = `vor ${Math.floor(diff / 3600)} Std.`;
                else if (diff < 604800)
                    published = `vor ${Math.floor(diff / 86400)} Tagen`;
                else if (diff < 2592000)
                    published = `vor ${Math.floor(diff / 604800)} Wochen`;
                else
                    published = `vor ${Math.floor(diff / 2592000)} Monaten`;
            }
            else {
                // If not a timestamp, use the raw string (e.g., "vor 2 Stunden")
                published = publishedAt;
            }
        }
        catch (e) {
            // If parsing fails, use raw string
            published = publishedAt || "N/A";
        }
    }
    // BRAND: Always show
    const brand = item.brand || "Unknown";
    // Calculate buyer protection fee (5% + 0.70€)
    const protectionFee = item.price * 0.05 + 0.70;
    const totalPrice = item.price + protectionFee;
    // Get country flag
    const countryFlag = COUNTRY_FLAGS[countryTitle] || "🌍";
    // TITLE: [Flag] [First 5 words] | [Total Price] €
    const titleWords = item.title.split(/\s+/).slice(0, 5).join(" ");
    const title = `${countryFlag} ${titleWords} | ${totalPrice.toFixed(2)} €`;
    // Brand color: 0x6EB6FF
    const color = 0x6EB6FF;
    // Price breakdown
    const priceBreakdown = `${item.price.toFixed(2)} € (+ ${protectionFee.toFixed(2)} €)`;
    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(title.slice(0, 256))
        .setURL(item.url)
        .addFields({ name: "🏷️ Brand", value: brand, inline: true }, { name: "📏 Size", value: size, inline: true }, { name: "✨ Condition", value: conditionDisplay, inline: true }, { name: "⏰ Published", value: published, inline: true }, { name: "⭐️ Reviews", value: reviewsDisplay, inline: true }, { name: "💶 Price", value: priceBreakdown, inline: true })
        .setFooter({ text: "Vinted Sniper •" })
        .setTimestamp();
    // Use photos with fallback - always try to show an image
    if (photos.length > 0) {
        embed.setImage(photos[0]);
    }
    else if (item.imageUrl) {
        embed.setImage(item.imageUrl);
    }
    return embed;
}
function buildDealButtons(item) {
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`save_${item.id}`).setLabel("💾 Merken").setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId(`interested_${item.id}`).setLabel("⚡ Interessiert").setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId(`fakecheck_${item.id}`).setLabel("🔍 Fake Check").setStyle(ButtonStyle.Secondary));
    return [row];
}
/**
 * Calculate composite deal-score for a listing.
 * Higher score = better deal.
 * Based on the scoring algorithm from TestArchitecture/snipebot.py
 */
function calculateDealScore(item) {
    if (!item.price || item.price <= 0)
        return 0;
    let score = 0;
    // Price Discount: Lower price = higher points
    if (item.price < 15) {
        score += 30;
    }
    else if (item.price < 30) {
        score += 15;
    }
    // Keyword Bonuses: High-value keywords get +20 points each
    const highValueKeywords = [
        "vintage", "heavyweight", "spellout", "box logo", "gore-tex",
        "y2k", "deadstock", "made in usa", "fleece", "nuptse", "big logo",
        "archive", "rare", "limited", "og", "original"
    ];
    const titleLower = item.title.toLowerCase();
    for (const keyword of highValueKeywords) {
        if (titleLower.includes(keyword)) {
            score += 20;
        }
    }
    // Size Bonus: Preferred sizes (M, L, XL) get +10 points
    const preferredSizes = ["m", "l", "xl", "medium", "large"];
    const sizeLower = (item.size || "").toLowerCase();
    if (preferredSizes.some(size => sizeLower === size || sizeLower.includes(size))) {
        score += 10;
    }
    // Base score: cheaper items get exponentially higher scores
    score += 1000.0 / item.price;
    return score;
}
/**
 * Post deals for a specific brand to its dedicated channel
 * CRITICAL FALLBACK LOGIC: Try Vinted first, if 0 items -> immediately try Kleinanzeigen
 */
async function postDealsForBrand(client, brandConfig) {
    try {
        const channel = await client.channels.fetch(brandConfig.channelId).catch(() => null);
        if (!channel || !(channel instanceof TextChannel)) {
            logger.warn(`❌ Channel not found for ${brandConfig.brand} (ID: ${brandConfig.channelId})`);
            return;
        }
        logger.info(`🔍 Searching ${brandConfig.brand}...`);
        // STEP 1: Try Vinted first (Python subprocess)
        let allItems = await vintedScraper.search(brandConfig.query, {
            maxPrice: watchConfig.maxPrice,
        });
        logger.info(`📊 Vinted: ${allItems.length} items for ${brandConfig.brand}`);
        // STEP 2: FALLBACK - If Vinted returns 0 items, immediately try Kleinanzeigen
        if (allItems.length === 0) {
            logger.warn(`⚠️ Vinted returned 0 items for ${brandConfig.brand}, triggering Kleinanzeigen fallback...`);
            const kleinItems = await kleinanzeigenScraper.search(brandConfig.query, {
                maxPrice: watchConfig.maxPrice,
            });
            logger.info(`📊 Kleinanzeigen fallback: ${kleinItems.length} items for ${brandConfig.brand}`);
            allItems = kleinItems;
        }
        if (allItems.length > 0) {
            consecutiveRateLimits = 0;
        }
        logger.info(`✅ ${brandConfig.brand}: ${allItems.length} total items`);
        const newItems = allItems.filter((i) => !seenItemIds.has(i.id));
        logger.info(`📌 ${brandConfig.brand}: ${newItems.length} new items`);
        // SCORING & THROTTLING: Calculate scores and sort by deal quality
        const scoredItems = newItems.map(item => ({
            item,
            score: calculateDealScore(item)
        }));
        // Sort by score DESC (best deals first)
        scoredItems.sort((a, b) => b.score - a.score);
        // Throttle: Only post TOP 5 highest-scoring items per brand per cycle
        const topItems = scoredItems.slice(0, 5);
        const suppressedCount = newItems.length - topItems.length;
        if (suppressedCount > 0) {
            logger.info(`🔇 ${brandConfig.brand}: Suppressed ${suppressedCount} lower-scoring items to prevent spam`);
        }
        // Post top-scoring deals
        for (const { item, score } of topItems) {
            seenItemIds.add(item.id);
            const dealItem = {
                ...item,
                currency: "EUR",
                condition: "—",
                seller: "—",
                location: "—",
                url: item.link,
            };
            cacheItem(dealItem);
            const embed = buildDealEmbed(dealItem);
            const rows = buildDealButtons(dealItem);
            await channel.send({ embeds: [embed], components: rows });
            logger.info(`📤 ${brandConfig.brand}: Posted ${item.platform.toUpperCase()} deal - ${item.price}€ (Score: ${score.toFixed(1)})`);
            await new Promise((r) => setTimeout(r, 300));
        }
        // Adaptive interval with jitter
        const baseInterval = brandConfig.refreshInterval * 1000;
        const randomizedInterval = getRandomizedInterval(baseInterval);
        logger.info(`⏱️ ${brandConfig.brand}: Next check in ${randomizedInterval / 1000}s`);
        await new Promise((r) => setTimeout(r, randomizedInterval));
    }
    catch (err) {
        logger.error(`❌ Error searching ${brandConfig.brand}: ${String(err)}`);
    }
}
async function postDeals(client) {
    if (!watchConfig.active)
        return;
    if (Date.now() < rateLimitedUntil) {
        const waitMinutes = Math.ceil((rateLimitedUntil - Date.now()) / 60000);
        logger.warn(`⏸️ Rate-limit active - waiting ${waitMinutes} minutes`);
        return;
    }
    logger.info("🚀 Starting deal search with brand-channel system + Kleinanzeigen fallback");
    // DYNAMIC RANDOMIZED CYCLING: Shuffle brands to prevent last brands from waiting too long
    const shuffledBrands = [...BRAND_CHANNELS].sort(() => Math.random() - 0.5);
    logger.info(`🔀 Randomized brand order: ${shuffledBrands.map(b => b.brand).join(", ")}`);
    // Search each brand in its dedicated channel (randomized order)
    for (const brandConfig of shuffledBrands) {
        await postDealsForBrand(client, brandConfig);
    }
    logger.info("✅ Deal search cycle completed");
}
const commands = [
    new SlashCommandBuilder()
        .setName("deals")
        .setDescription("Deal-Bot Control")
        .addSubcommand((sub) => sub.setName("start").setDescription("Start deal search"))
        .addSubcommand((sub) => sub.setName("stop").setDescription("Stop deal search"))
        .addSubcommand((sub) => sub.setName("status").setDescription("Show current status"))
        .addSubcommand((sub) => sub.setName("marken").setDescription("Set brands (comma-separated)")
        .addStringOption((o) => o.setName("liste").setDescription("e.g. Nike,Adidas,Lacoste").setRequired(true)))
        .addSubcommand((sub) => sub.setName("maxpreis").setDescription("Set max price in EUR")
        .addIntegerOption((o) => o.setName("preis").setDescription("e.g. 50 for max 50 EUR (0 = no limit)").setRequired(true)))
        .addSubcommand((sub) => sub.setName("kategorie").setDescription("Search specific category only")
        .addStringOption((o) => o.setName("typ").setDescription("Select category").setRequired(true).addChoices(...CATEGORY_CHOICES)))
        .addSubcommand((sub) => sub.setName("suche").setDescription("Search for deals now"))
        .addSubcommand((sub) => sub.setName("reset").setDescription("Reset cache (shows old deals again)")),
    new SlashCommandBuilder()
        .setName("lizenz")
        .setDescription("Show license status of this server"),
];
let botOwnerId = null;
export async function startBot() {
    const token = process.env["DISCORD_BOT_TOKEN"];
    if (!token) {
        logger.error("DISCORD_BOT_TOKEN not set.");
        return;
    }
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildMessageReactions,
            GatewayIntentBits.DirectMessages,
        ],
        partials: [2, 3],
    });
    client.once(Events.ClientReady, async (c) => {
        logger.info(`Discord Bot logged in as ${c.user.tag}`);
        c.user.setActivity("🔍 Deal search running...", { type: ActivityType.Watching });
        try {
            const app = await c.application.fetch();
            botOwnerId = app.owner && "id" in app.owner ? app.owner.id : null;
            if (botOwnerId)
                logger.info(`Bot owner detected: ${botOwnerId}`);
        }
        catch (err) {
            logger.warn("Could not fetch bot owner ID: " + String(err));
        }
        const rest = new REST({ version: "10" }).setToken(token);
        try {
            const guilds = await c.guilds.fetch();
            for (const [guildId] of guilds) {
                await rest.put(Routes.applicationGuildCommands(c.user.id, guildId), {
                    body: commands.map((cmd) => cmd.toJSON()),
                });
            }
            logger.info("Slash commands registered");
        }
        catch (err) {
            logger.error("Failed to register slash commands: " + String(err));
        }
        logger.info("🚀 Starting continuous brand-channel monitoring with Kleinanzeigen fallback...");
        // Initial search
        await postDeals(client);
        // Continuous monitoring loop
        async function continuousMonitoring() {
            while (watchConfig.active) {
                try {
                    await postDeals(client);
                }
                catch (err) {
                    logger.error("Monitoring cycle failed: " + String(err));
                }
                // Minimum 1 minute between full cycles
                const minCycleDelay = 60000;
                await new Promise(resolve => setTimeout(resolve, minCycleDelay));
            }
        }
        continuousMonitoring().catch((err) => logger.error("Continuous monitoring crashed: " + String(err)));
    });
    client.on(Events.InteractionCreate, async (interaction) => {
        if (interaction.isButton()) {
            const { customId, user } = interaction;
            if (customId.startsWith("save_")) {
                await interaction.deferUpdate();
                const itemId = customId.replace("save_", "");
                const item = getCachedItem(itemId);
                if (!item) {
                    await interaction.followUp({ content: "❌ Item not in cache or expired (older than 1 hour). Please use a newer deal.", flags: 64 });
                    return;
                }
                const savedEmbed = new EmbedBuilder()
                    .setColor(0xe91e63)
                    .setTitle(`❤️ Saved Deal: ${item.brand || ""} | ${item.title}`.slice(0, 250))
                    .setURL(item.url)
                    .addFields({ name: "💰 Price", value: `**${item.price.toFixed(2)} ${item.currency}**`, inline: true }, { name: "📐 Size", value: item.size || "—", inline: true }, { name: "✨ Condition", value: item.condition || "—", inline: true }, { name: "👤 Seller", value: item.seller || "—", inline: true })
                    .setFooter({ text: "Your saved deals • Snipebot" })
                    .setTimestamp();
                if (item.imageUrl)
                    savedEmbed.setImage(item.imageUrl);
                const platformName = item.platform === "vinted" ? "Vinted" : "Kleinanzeigen";
                const linkRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel(`🛒 View on ${platformName}`).setStyle(ButtonStyle.Link).setURL(item.url));
                try {
                    const dm = await user.createDM();
                    await dm.send({
                        content: `❤️ **You saved a deal!**`,
                        embeds: [savedEmbed],
                        components: [linkRow],
                    });
                    await interaction.followUp({ content: "✅ Deal saved to your DMs!", flags: 64 });
                }
                catch {
                    await interaction.followUp({
                        content: "⚠️ Your DMs are disabled. Enable DMs to save deals.",
                        flags: 64,
                    });
                }
                return;
            }
            if (customId.startsWith("interested_")) {
                await interaction.deferUpdate();
                try {
                    await interaction.message.react("👍");
                    await interaction.followUp({ content: "👍 Marked as interesting!", flags: 64 });
                }
                catch {
                    await interaction.followUp({ content: "❌ Error reacting.", flags: 64 });
                }
                return;
            }
            if (customId.startsWith("fakecheck_")) {
                await interaction.deferReply({ flags: 64 });
                const itemId = customId.replace("fakecheck_", "");
                const item = getCachedItem(itemId);
                if (!item) {
                    await interaction.editReply("❌ Item not in cache or expired (older than 1 hour). Please use a newer deal.");
                    return;
                }
                const { embed, row } = runFakeCheck(item);
                try {
                    const dm = await user.createDM();
                    await dm.send({
                        content: `🔍 **Your fake-check for a deal from the server:**`,
                        embeds: [embed],
                        components: [row],
                    });
                    await interaction.editReply("✅ Fake-check sent to your DMs!");
                }
                catch {
                    const fakeChannel = await findChannelByName(client, "fake-check");
                    if (fakeChannel) {
                        await fakeChannel.send({ content: `Fake-check requested by <@${user.id}>:`, embeds: [embed], components: [row] });
                        await interaction.editReply(`✅ Fake-check posted in ${fakeChannel} (DMs disabled).`);
                    }
                    else {
                        await interaction.editReply({ embeds: [embed], components: [row] });
                    }
                }
                return;
            }
            return;
        }
        if (!interaction.isChatInputCommand())
            return;
        const cmd = interaction;
        const guildId = cmd.guildId;
        if (guildId && WHOP_API_KEY && WHOP_PRODUCT_ID) {
            const licensed = await isGuildLicensed(guildId);
            if (!licensed) {
                await cmd.reply({
                    content: "❌ **No active subscription!**\nThis bot is for premium members only.\n👉 Buy license: https://whop.com",
                    flags: 64,
                });
                return;
            }
        }
        try {
            if (cmd.commandName === "deals") {
                const sub = cmd.options.getSubcommand();
                if (sub === "start") {
                    await cmd.deferReply();
                    watchConfig.active = true;
                    await cmd.editReply("✅ Deal search started! Searching now...");
                    await postDeals(client);
                    await cmd.followUp("✅ First search completed!");
                }
                else if (sub === "stop") {
                    watchConfig.active = false;
                    await cmd.reply("⏹️ Deal search stopped.");
                }
                else if (sub === "status") {
                    await cmd.reply(`📊 **Status**\n` +
                        `• Active: ${watchConfig.active ? "✅ Yes" : "❌ No"}\n` +
                        `• Brands: ${watchConfig.brands.join(", ")}\n` +
                        `• Max Price: ${watchConfig.maxPrice ? `${watchConfig.maxPrice} EUR` : "no limit"}\n` +
                        `• Items in cache: ${seenItemIds.size} (${itemCache.size} in memory)`);
                }
                else if (sub === "marken") {
                    const liste = cmd.options.getString("liste", true);
                    watchConfig.brands = liste.split(",").map((b) => b.trim()).filter(Boolean);
                    seenItemIds.clear();
                    await cmd.reply(`✅ Brands updated: **${watchConfig.brands.join(", ")}**`);
                }
                else if (sub === "maxpreis") {
                    const preis = cmd.options.getInteger("preis", true);
                    watchConfig.maxPrice = preis > 0 ? preis : undefined;
                    seenItemIds.clear();
                    await cmd.reply(`✅ Max price: ${preis > 0 ? `**${preis} EUR**` : "**no limit**"}`);
                }
                else if (sub === "kategorie") {
                    const typ = cmd.options.getString("typ", true);
                    if (!CATEGORIES[typ]) {
                        await cmd.reply("❌ Unknown category.");
                        return;
                    }
                    watchConfig.categoryKey = typ;
                    seenItemIds.clear();
                    await cmd.reply(`✅ Category set: **${CATEGORIES[typ].label}** → #${CATEGORIES[typ].channelName}`);
                }
                else if (sub === "suche") {
                    await cmd.deferReply();
                    await postDeals(client);
                    await cmd.editReply("✅ Search completed!");
                }
                else if (sub === "reset") {
                    seenItemIds.clear();
                    itemCache.clear();
                    await cmd.reply("🗑️ Cache cleared. Next search will treat all items as 'new'.");
                }
            }
            else if (cmd.commandName === "lizenz") {
                if (!WHOP_API_KEY || !WHOP_PRODUCT_ID) {
                    await cmd.reply({ content: "ℹ️ Whop not configured — bot running in free mode.", flags: 64 });
                    return;
                }
                const licensed = guildId ? await isGuildLicensed(guildId) : false;
                await cmd.reply({
                    content: licensed
                        ? "✅ **License active!** This server has a valid premium subscription."
                        : "❌ **No license!** Buy license at: https://whop.com",
                    flags: 64,
                });
            }
        }
        catch (err) {
            logger.error("Error processing slash command: " + String(err));
            try {
                const msg = { content: "❌ Error processing command.", flags: 64 };
                if (cmd.deferred || cmd.replied)
                    await cmd.followUp(msg);
                else
                    await cmd.reply(msg);
            }
            catch { /* ignore */ }
        }
    });
    client.on(Events.Error, (err) => { logger.error("Discord client error: " + String(err)); });
    client.on(Events.ShardDisconnect, (event, shardId) => { logger.warn(`Shard ${shardId} disconnected (Code: ${event.code})`); });
    client.on(Events.ShardReconnecting, (shardId) => { logger.info(`Shard ${shardId} reconnecting...`); });
    client.on(Events.ShardResume, (shardId) => { logger.info(`Shard ${shardId} resumed successfully`); });
    await client.login(token);
}
