import { Client, GatewayIntentBits, EmbedBuilder, TextChannel, Events, ActivityType, SlashCommandBuilder, REST, Routes, ButtonBuilder, ButtonStyle, ActionRowBuilder, AttachmentBuilder, } from "discord.js";
import axios from "axios";
import { CATEGORIES } from "./config/categories.js";
import { CATEGORY_CHANNELS, classifyCategory } from "./config/category-channels.js";
import { BRAND_CHANNELS, getAllBrands, getRandomizedInterval, } from "./config/brand-channels.js";
import { logger } from "./lib/logger.js";
import { vintedScraper, enrichSeller } from "./scrapers/vinted.js";
import { kleinanzeigenScraper } from "./scrapers/kleinanzeigen.js";
const DEFAULT_BRANDS = getAllBrands();
const itemCache = new Map();
const MAX_CACHE_SIZE = 2000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
function cacheItem(item) {
    const canonicalId = String(item.id || item.link || "").trim();
    if (!canonicalId)
        return;
    item.id = canonicalId;
    const cached = {
        item,
        timestamp: Date.now()
    };
    itemCache.set(canonicalId, cached);
    itemCache.set(encodeURIComponent(canonicalId), cached);
    if (item.url) {
        itemCache.set(item.url, cached);
    }
    if (itemCache.size > MAX_CACHE_SIZE) {
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
        }
    }
}
function getCachedItem(identifier) {
    const normalized = String(identifier || "").trim();
    if (!normalized)
        return null;
    const hit = itemCache.get(normalized) || itemCache.get(encodeURIComponent(normalized));
    if (hit) {
        if (Date.now() - hit.timestamp > CACHE_TTL_MS) {
            itemCache.delete(normalized);
            return null;
        }
        return hit.item;
    }
    for (const [, cached] of itemCache.entries()) {
        if (cached.item.id === normalized || cached.item.url === normalized) {
            if (Date.now() - cached.timestamp > CACHE_TTL_MS)
                return null;
            return cached.item;
        }
    }
    return null;
}
const postedMessages = new Map(); // channelId -> messages
const PURGE_AFTER_MS = 30 * 60 * 1000; // 30 minutes
const PURGE_SWEEP_INTERVAL_MS = 3 * 60 * 1000; // check every 3 minutes (tighter window needs tighter checks)
const purgeWarned = new Set();
function trackPostedMessage(channelId, messageId) {
    const list = postedMessages.get(channelId) || [];
    list.push({ id: messageId, postedAt: Date.now() });
    postedMessages.set(channelId, list);
}
async function purgeOldMessages(client) {
    const now = Date.now();
    for (const [channelId, messages] of postedMessages.entries()) {
        const due = messages.filter((m) => now - m.postedAt >= PURGE_AFTER_MS);
        if (due.length === 0)
            continue;
        try {
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (!(channel instanceof TextChannel))
                continue;
            const dueIds = due.map((m) => m.id);
            for (let i = 0; i < dueIds.length; i += 100) {
                const batch = dueIds.slice(i, i + 100);
                if (batch.length === 1) {
                    await channel.messages.delete(batch[0]).catch(() => { });
                }
                else {
                    await channel.bulkDelete(batch, true).catch(() => { });
                }
                // small gap between batches to stay well clear of Discord's bulk-delete rate limit
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
            const remaining = messages.filter((m) => now - m.postedAt < PURGE_AFTER_MS);
            postedMessages.set(channelId, remaining);
            logger.debug(`🧹 Purged ${due.length} message(s) older than 1h in channel ${channelId}`);
        }
        catch (err) {
            if (!purgeWarned.has(channelId)) {
                purgeWarned.add(channelId);
                logger.warn(`⚠️ Auto-purge failed for channel ${channelId} (check bot has "Manage Messages" permission there): ${String(err)}`);
            }
        }
    }
}
function startAutoPurge(client) {
    logger.info(`🧹 Auto-purge active: bot-posted messages are deleted ${PURGE_AFTER_MS / 60000}min after posting (checked every ${PURGE_SWEEP_INTERVAL_MS / 60000}min)`);
    setInterval(() => {
        purgeOldMessages(client).catch((err) => logger.error("Purge sweep failed: " + String(err)));
    }, PURGE_SWEEP_INTERVAL_MS);
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
// Global dispatch pacing: ALL 15 brand workers share this single queue, so no matter
// how many brands find new items at the same moment, actual posts to Discord are
// serialized at least GLOBAL_DISPATCH_GAP_MS apart system-wide. This is what actually
// protects us from Discord rate limits/connection bursts — a per-brand-only stagger
// does nothing to stop 15 independent workers from posting in the same instant.
// (A single item going to multiple channels for the SAME brand still fans out
// simultaneously within one slot — only the slots themselves are paced.)
const GLOBAL_DISPATCH_GAP_MS = 500;
let dispatchGate = Promise.resolve();
function nextDispatchSlot() {
    const mySlot = dispatchGate.then(() => new Promise((resolve) => setTimeout(resolve, GLOBAL_DISPATCH_GAP_MS)));
    dispatchGate = mySlot;
    return mySlot;
}
/**
 * Sends to a channel with a couple of short retries. Most failures at this point are
 * transient connection blips (e.g. undici "Received one or more errors" from a brief
 * network hiccup), not permanent — retrying once or twice clears the vast majority.
 */
async function sendWithRetry(channel, payload, maxRetries = 2) {
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await channel.send(payload);
        }
        catch (err) {
            lastErr = err;
            if (attempt < maxRetries) {
                const delay = 500 * (attempt + 1);
                logger.debug(`↻ Retrying send to channel ${channel.id} (attempt ${attempt + 2}/${maxRetries + 1}) after: ${String(err)}`);
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
    }
    throw lastErr;
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
    // Real Vinted seller reputation (only available for the freshest few items per search —
    // see SELLER_RATING_LOOKUP_LIMIT in vinted_helper.py). reviewRating stays undefined/null
    // when we genuinely don't have the data, vs. a real 0.0 for a confirmed brand-new seller —
    // don't guess when we don't know.
    const reviewCount = Number(item.reviewCount ?? 0);
    const reviewRatingRaw = item.reviewRating;
    const hasRatingData = reviewRatingRaw !== undefined && reviewRatingRaw !== null;
    const reviewRating = hasRatingData ? Number(reviewRatingRaw) : undefined;
    if (hasRatingData) {
        if (reviewCount === 0) {
            warnings.push("🆕 Verkäufer hat noch keine Bewertungen auf Vinted");
            riskScore += 15;
        }
        else if (reviewRating < 3.5) {
            warnings.push(`⭐ Unterdurchschnittliche Verkäufer-Bewertung (${reviewRating.toFixed(1)}★, ${reviewCount} Bewertungen)`);
            riskScore += 20;
        }
        else if (reviewCount >= 20 && reviewRating >= 4.5) {
            positives.push(`⭐ Vertrauenswürdiger Verkäufer (${reviewRating.toFixed(1)}★, ${reviewCount} Bewertungen)`);
        }
        else {
            positives.push(`⭐ Verkäufer-Bewertung: ${reviewRating.toFixed(1)}★ (${reviewCount} Bewertungen)`);
        }
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
        .addFields({ name: "💰 Preis", value: `${item.price.toFixed(2)} ${item.currency}`, inline: true }, { name: "🏷️ Marke", value: item.brand || "—", inline: true }, { name: "📐 Größe", value: item.size || "—", inline: true }, { name: "✨ Zustand", value: item.condition || "—", inline: true }, {
        name: "👤 Verkäufer",
        value: hasRatingData
            ? `${item.seller || "—"} (${reviewRating.toFixed(1)}★, ${reviewCount} Bewertungen)`
            : item.seller || "—",
        inline: true,
    })
        .setFooter({ text: "Fake-Check • Snipebot" })
        .setTimestamp();
    if (warnings.length > 0)
        embed.addFields({ name: "⚠️ Warnzeichen", value: warnings.join("\n") });
    if (positives.length > 0)
        embed.addFields({ name: "✅ Positive Zeichen", value: positives.join("\n") });
    if (item.imageUrl)
        embed.setThumbnail(item.imageUrl);
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("🔗 Inserat öffnen").setStyle(ButtonStyle.Link).setURL(item.url));
    if (item.sellerProfileUrl) {
        row.addComponents(new ButtonBuilder().setLabel("👤 Verkäuferprofil").setStyle(ButtonStyle.Link).setURL(item.sellerProfileUrl));
    }
    return { embed, row };
}
function ratingToStars(rating, count) {
    const r = Math.max(0, Math.min(5, Math.round(rating ?? 0)));
    const stars = r > 0 ? "⭐️".repeat(r) : "";
    const cnt = count ?? 0;
    return stars ? `${stars} (${cnt})` : `(0)`;
}
/**
 * Converts a 2-letter ISO country code (e.g. "DE") into its flag emoji via Unicode regional
 * indicator symbols — pure computation, no lookup table needed.
 */
function countryCodeToFlagEmoji(isoCode) {
    if (!isoCode || isoCode.length !== 2)
        return "";
    const codePoints = [...isoCode.toUpperCase()].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65));
    return String.fromCodePoint(...codePoints);
}
function buildDealEmbed(item) {
    const meta = item;
    const images = meta.images_array || meta.photos || [];
    const mainImage = images[0] || meta.main_image_url || item.imageUrl || "https://i.imgur.com/8Km9tLL.png";
    const safeTitle = meta.cleanTitle || item.cleanTitle || item.title || "—";
    const basePrice = Number(meta.base_price ?? item.price ?? 0);
    const buyerFee = Number(meta.buyerProtectionFee ?? meta.protection_fee ?? 0);
    const totalPrice = Number(meta.totalPrice ?? item.totalPrice ?? (basePrice + buyerFee));
    const reviewsDisplay = ratingToStars(meta.reviewRating, meta.reviewCount);
    // Prefer Vinted's real publish timestamp, rendered via Discord's native <t:...> tag —
    // Discord itself displays this as a live-updating relative time ("5 minutes ago") in the
    // viewer's own timezone, and shows the exact date/time on hover. Falls back to Kleinanzeigen's
    // parsed date string (already legitimate), or an honest "—" instead of a fake default.
    const publishedTs = meta.publishedAtTs ?? item.publishedAtTs;
    const published = publishedTs
        ? `<t:${Math.floor(Number(publishedTs))}:R>`
        : meta.publishedAt || item.publishedAt || "—";
    const sellerName = (meta.sellerUsername || item.sellerUsername || item.seller || "—").toString();
    const sellerAvatar = (meta.sellerAvatar || item.sellerAvatar || "").toString() || undefined;
    const total = Number(totalPrice || 0);
    const base = Number(basePrice || 0);
    const fee = total > base ? total - base : 0;
    const priceStr = fee > 0 ? `${base.toFixed(2)} € (+ ${fee.toFixed(2)} €)` : `${base.toFixed(2)} €`;
    const mainEmbed = new EmbedBuilder()
        .setColor(0x6EB6FF)
        .setAuthor({ name: sellerName, iconURL: sellerAvatar })
        .setTitle(`${countryCodeToFlagEmoji(meta.sellerCountryCode)} ${safeTitle} | ${Number(total || base).toFixed(2)} €`.trim().slice(0, 256))
        .setURL(item.url)
        .addFields({ name: "🏷️ Brand", value: (meta.brand || item.brand || "—") || "—", inline: true }, { name: "📏 Size", value: (meta.size || item.size || "—") || "—", inline: true }, { name: "✨ Condition", value: (meta.condition || item.condition || "—") || "—", inline: true }, { name: "⏰ Published", value: published || "—", inline: true }, { name: "🌟 Reviews", value: reviewsDisplay || "—", inline: true }, { name: "💰 Price", value: priceStr || "—", inline: true })
        .setImage(mainImage)
        .setFooter({ text: `🔗 ${item.brand || "Vinted"}`, iconURL: sellerAvatar })
        .setTimestamp();
    return mainEmbed;
}
function buildDealButtons(item) {
    const itemId = String(item.id || "").trim();
    // "Jetzt kaufen" is a Link button (direct one-tap to Vinted) — Discord doesn't allow custom
    // colors on Link buttons (they're always the same fixed grey/link appearance), only on
    // interactive buttons, which would cost an extra tap. Direct link wins here.
    // Secondary is the lightest style Discord offers for "Merken & Check" — there's no true
    // white-background/black-text option in Discord's component system.
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`save_and_check_${itemId}`).setLabel('Merken & Check').setStyle(ButtonStyle.Secondary).setEmoji('💾'), new ButtonBuilder().setLabel('Jetzt kaufen').setStyle(ButtonStyle.Link).setURL(item.url).setEmoji('🛒'));
    return [row];
}
/**
 * Downloads an image and returns it as a Discord attachment instead of a hotlinked URL.
 * Once the bytes live on Discord's own CDN there's no external fetch dependency left that
 * can fail — this is the reliable path vs. embedding raw Vinted CDN URLs directly.
 */
async function downloadImageAttachment(url, filename) {
    try {
        const res = await axios.get(url, { responseType: "arraybuffer", timeout: 5000 });
        return new AttachmentBuilder(Buffer.from(res.data), { name: filename });
    }
    catch (err) {
        logger.debug(`↻ Image download failed for ${filename}, falling back to hotlinked URL: ${String(err)}`);
        return null;
    }
}
// Category channels (Polos/Pants/Shoes) aggregate items from ALL brand searches instead of
// running their own — resolved once and cached, same pattern as discord.js's own channel
// cache, so adding them costs no extra Vinted requests and no extra rate-limit exposure.
const categoryChannelCache = new Map();
const categoryChannelWarned = new Set();
async function resolveCategoryChannel(client, category) {
    if (categoryChannelCache.has(category))
        return categoryChannelCache.get(category);
    const config = CATEGORY_CHANNELS.find((c) => c.category === category);
    if (!config || !config.channelId || config.channelId.startsWith("REPLACE_WITH_")) {
        if (!categoryChannelWarned.has(category)) {
            categoryChannelWarned.add(category);
            logger.warn(`⚠️ Category channel "${category}" has no valid channel ID configured yet — skipping category routing for it until you provide one.`);
        }
        categoryChannelCache.set(category, null);
        return null;
    }
    const channel = await client.channels.fetch(config.channelId).catch(() => null);
    const resolved = channel instanceof TextChannel ? channel : null;
    if (!resolved && !categoryChannelWarned.has(category)) {
        categoryChannelWarned.add(category);
        logger.warn(`⚠️ Could not resolve category channel "${category}" (id=${config.channelId})`);
    }
    categoryChannelCache.set(category, resolved);
    return resolved;
}
async function postDealsForBrand(client, brandConfig) {
    const brandChannelIds = String(brandConfig.channelId || "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
    const fetchedChannels = await Promise.all(brandChannelIds.map((id) => client.channels.fetch(id).catch(() => null)));
    const targetChannels = fetchedChannels.filter((ch) => ch instanceof TextChannel);
    if (targetChannels.length === 0) {
        logger.warn(`❌ No valid channels found for brand: ${brandConfig.brand}`);
        return;
    }
    logger.info(`📡 Brand ${brandConfig.brand}: SIMULTANEOUS dispatch across all ${targetChannels.length} dedicated channel(s)`);
    logger.info(`🔍 Searching ${brandConfig.brand}...`);
    let allItems = await vintedScraper.search(brandConfig.query, {
        maxPrice: watchConfig.maxPrice,
    });
    logger.info(`📊 Vinted: ${allItems.length} items for ${brandConfig.brand}`);
    if (allItems.length === 0) {
        logger.warn(`⚠️ Vinted returned 0 items for ${brandConfig.brand}, triggering Kleinanzeigen fallback...`);
        const kleinItems = await kleinanzeigenScraper.search(brandConfig.query, {
            maxPrice: watchConfig.maxPrice,
        });
        logger.info(`📊 Kleinanzeigen fallback: ${kleinItems.length} items for ${brandConfig.brand}`);
        allItems = kleinItems;
    }
    logger.info(`✅ ${brandConfig.brand}: ${allItems.length} total items`);
    for (const item of allItems) {
        const canonicalId = String(item.id || item.link || "").trim();
        if (!canonicalId || seenItemIds.has(canonicalId))
            continue;
        // Mark seen immediately (before the async dispatch below) so a concurrent
        // worker or a manual /deals suche can never double-post the same item.
        seenItemIds.add(canonicalId);
        // Isolated per item: if ONE item fails for any reason (bad data, transient network
        // error even after retries), it must not block the rest of this brand's items —
        // otherwise a single hiccup could starve every remaining channel for a whole cycle.
        try {
            // Enrich BEFORE building the embed, for every item that reaches this point (i.e. every
            // item that's actually about to be posted) — not a blind subset of raw search results.
            // Vinted-only: Kleinanzeigen items have no sellerId/this endpoint.
            const enrichment = item.platform === "vinted" && item.sellerId
                ? await enrichSeller(item.sellerId)
                : null;
            const dealItem = {
                ...item,
                id: canonicalId,
                currency: item.currency || "EUR",
                condition: item.condition || "N/A",
                seller: item.sellerUsername || item.seller || "N/A",
                location: "—",
                url: item.link,
                description: item.description || "",
                main_image_url: item.main_image_url || item.imageUrl,
                buyerProtectionFee: Number(item.buyerProtectionFee ?? 0),
                shippingFee: Number(item.shippingFee ?? 0),
                feeTotal: Number(item.feeTotal ?? 0),
                totalPrice: Number(item.totalPrice ?? 0),
                sellerUsername: item.sellerUsername || item.seller || "",
                sellerAvatar: item.sellerAvatar || "",
                reviewRating: Number(enrichment?.reviewRating ?? item.reviewRating ?? item.sellerRating ?? 0),
                reviewCount: enrichment?.reviewCount ?? item.reviewCount,
                sellerCountryCode: enrichment?.sellerCountryCode ?? item.sellerCountryCode,
            };
            // Category routing: same item, ALSO fanned out to its matching Polos/Pants/Shoes
            // channel (if any) in the SAME dispatch event below — not a separate search or a
            // separate pacing slot, so this adds zero extra Vinted load and zero extra rate-limit risk.
            const matchedCategory = classifyCategory(dealItem.cleanTitle || dealItem.title);
            let itemChannels = targetChannels;
            if (matchedCategory) {
                const categoryChannel = await resolveCategoryChannel(client, matchedCategory.category);
                if (categoryChannel && !itemChannels.some((ch) => ch.id === categoryChannel.id)) {
                    itemChannels = [...itemChannels, categoryChannel];
                }
            }
            const images = dealItem.images_array || dealItem.photos || [];
            const mainImageUrl = images[0] || dealItem.main_image_url || dealItem.imageUrl;
            const imageUrls = [mainImageUrl, images[1], images[2]].filter((u) => Boolean(u)).slice(0, 3);
            const filenames = imageUrls.map((_, idx) => `deal_${canonicalId}_${idx}.jpg`);
            // Download and attach directly instead of hotlinking Vinted's CDN — this removes
            // Discord's external-image-fetch step (and whatever undocumented limits it hits under
            // load) as a point of failure entirely. Falls back to the hotlinked URL per-image if a
            // download fails, rather than dropping the picture.
            const downloaded = await Promise.all(imageUrls.map((url, idx) => downloadImageAttachment(url, filenames[idx])));
            const files = downloaded.filter((a) => a !== null);
            const mainEmbed = buildDealEmbed(dealItem);
            if (downloaded[0])
                mainEmbed.setImage(`attachment://${filenames[0]}`);
            const embeds = [mainEmbed];
            for (let i = 1; i < imageUrls.length; i++) {
                const extraEmbed = new EmbedBuilder().setURL(dealItem.url);
                extraEmbed.setImage(downloaded[i] ? `attachment://${filenames[i]}` : imageUrls[i]);
                embeds.push(extraEmbed);
            }
            const payload = {
                embeds,
                components: buildDealButtons(dealItem),
                files,
            };
            // Wait for our turn in the global pacing queue (>=500ms since the last dispatch, from ANY brand).
            await nextDispatchSlot();
            // SIMULTANEOUS DISPATCH: Send THIS specific item to its brand channel(s) AND its matching
            // category channel (if any) all at the same time — one dispatch event, one pacing slot.
            const dispatchResults = await Promise.allSettled(itemChannels.map(async (channel) => {
                const msg = await sendWithRetry(channel, payload);
                trackPostedMessage(channel.id, msg.id);
                logger.debug(`✅ Posted item ${canonicalId} to channel #${channel.name} (${channel.id}) for brand ${brandConfig.brand}`);
                return msg;
            }));
            let successCount = 0;
            dispatchResults.forEach((r, idx) => {
                if (r.status === "fulfilled") {
                    successCount++;
                }
                else {
                    logger.warn(`⚠️ Failed to post to channel ${itemChannels[idx].id}: ${String(r.reason)}`);
                }
            });
            if (successCount > 0) {
                cacheItem(dealItem);
                logger.debug(`✅ Item ${canonicalId} dispatched simultaneously to ${successCount}/${itemChannels.length} channels for brand ${brandConfig.brand}${matchedCategory ? ` (+ ${matchedCategory.label} category)` : ""}`);
            }
            else {
                logger.warn(`❌ All dispatches failed for item ${canonicalId}`);
            }
        }
        catch (err) {
            logger.warn(`⚠️ Skipped item ${canonicalId} for ${brandConfig.brand} after unexpected error: ${String(err)}`);
        }
    }
    logger.info(`📌 ${brandConfig.brand}: Processing completed`);
}
/**
 * Independent per-brand worker: loops forever (while active) on the brand's OWN
 * refreshInterval (with jitter), searching and posting to ONLY that brand's channel(s).
 * All 15 workers run concurrently, so every channel finds and posts its own deals
 * in real time instead of waiting in a shared sequential queue.
 */
async function runBrandWorker(client, brandConfig) {
    let consecutiveErrors = 0;
    while (watchConfig.active) {
        try {
            await postDealsForBrand(client, brandConfig);
            consecutiveErrors = 0;
        }
        catch (err) {
            consecutiveErrors++;
            logger.error(`❌ Worker error for ${brandConfig.brand}: ${String(err)}`);
        }
        // Back off a bit longer after repeated failures instead of hammering a broken source.
        const backoffMultiplier = consecutiveErrors > 0 ? Math.min(consecutiveErrors, 5) : 1;
        const waitMs = getRandomizedInterval(brandConfig.refreshInterval) * 1000 * backoffMultiplier;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    logger.info(`⏹️ Worker stopped for ${brandConfig.brand}`);
}
let workersRunning = false;
/**
 * Launches one independent worker per brand. Idempotent — safe to call from
 * /deals start even if workers are already running.
 */
function startAllBrandWorkers(client) {
    if (workersRunning)
        return;
    workersRunning = true;
    logger.info(`🚀 Launching ${BRAND_CHANNELS.length} parallel brand workers (staggered start, ${GLOBAL_DISPATCH_GAP_MS}ms global pacing) — each brand posts to its own channel(s) as soon as deals are found`);
    BRAND_CHANNELS.forEach((brandConfig, index) => {
        // Stagger each worker's FIRST search by GLOBAL_DISPATCH_GAP_MS so all 15 don't hit
        // Discord's API (channel resolution, then posting) in the same instant at startup.
        // After this first run, each worker settles into its own independent refreshInterval.
        setTimeout(() => {
            runBrandWorker(client, brandConfig).catch((err) => logger.error(`Worker crashed for ${brandConfig.brand}: ${String(err)}`));
        }, index * GLOBAL_DISPATCH_GAP_MS);
    });
}
/** One-off parallel search across all brands, used by /deals suche (doesn't affect the ongoing workers' schedule). */
async function runImmediateSearchAllBrands(client) {
    logger.info("⚡ Manual immediate search across all brands (parallel)");
    const results = await Promise.allSettled(BRAND_CHANNELS.map((brandConfig) => postDealsForBrand(client, brandConfig)));
    results.forEach((r, idx) => {
        if (r.status === "rejected") {
            logger.error(`❌ Error searching ${BRAND_CHANNELS[idx].brand}: ${String(r.reason)}`);
        }
    });
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
        logger.info("🚀 Starting parallel brand-channel monitoring with Kleinanzeigen fallback...");
        startAllBrandWorkers(client);
        startAutoPurge(client);
    });
    client.on(Events.InteractionCreate, async (interaction) => {
        if (interaction.isButton()) {
            const { customId, user } = interaction;
            const findCachedByUrl = (url) => {
                if (!url)
                    return null;
                for (const [, cached] of itemCache) {
                    if (cached.item.url === url)
                        return cached.item;
                }
                return null;
            };
            if (customId.startsWith("save_and_check") || customId.startsWith("save_") || customId.startsWith("fakecheck_") || customId === "fake_check") {
                await interaction.deferReply({ flags: 64 });
                let item = null;
                const parts = customId.split("_");
                const possibleId = parts[parts.length - 1];
                if (possibleId && possibleId !== "check" && possibleId !== "item") {
                    item = getCachedItem(possibleId);
                }
                if (!item) {
                    const embedUrl = interaction.message?.embeds?.[0]?.url;
                    item = findCachedByUrl(embedUrl);
                }
                if (!item) {
                    await interaction.editReply("❌ Item not in cache or expired. Please use a newer deal.");
                    return;
                }
                const priceVal = Number(item.totalPrice ?? item.base_price ?? item.price ?? 0);
                const savedEmbed = new EmbedBuilder()
                    .setColor(0xe91e63)
                    .setTitle(`❤️ Saved Deal: ${item.brand || ""} | ${item.title}`.slice(0, 250))
                    .setURL(item.url)
                    .addFields({ name: "💰 Price", value: `**${priceVal.toFixed(2)} EUR**`, inline: true }, { name: "📐 Size", value: item.size || "—", inline: true }, { name: "✨ Condition", value: item.condition || "—", inline: true }, { name: "👤 Seller", value: item.seller || "—", inline: true })
                    .setFooter({ text: "Your saved deals • Snipebot" })
                    .setTimestamp();
                if (item.imageUrl)
                    savedEmbed.setImage(item.imageUrl);
                const { embed: fakeEmbed, row: fakeRow } = runFakeCheck(item);
                const platformName = item.platform === "vinted" ? "Vinted" : "Kleinanzeigen";
                const linkRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel(`🛒 View on ${platformName}`).setStyle(ButtonStyle.Link).setURL(item.url));
                try {
                    const dm = await user.createDM();
                    await dm.send({
                        content: `❤️ **You saved a deal!**`,
                        embeds: [savedEmbed],
                        components: [linkRow],
                    });
                    await dm.send({
                        content: `🔍 **Fake-check for your saved deal:**`,
                        embeds: [fakeEmbed],
                        components: [fakeRow],
                    });
                    await interaction.editReply("✅ Deal saved & fake-check sent to your DMs!");
                }
                catch {
                    await interaction.editReply({
                        content: "⚠️ Your DMs are disabled. Enable DMs to save deals and receive fake-checks.",
                    });
                }
                return;
            }
            if (customId.startsWith("buy_")) {
                await interaction.deferReply({ flags: 64 });
                let item = null;
                const parts = customId.split("_");
                const possibleId = parts[parts.length - 1];
                if (possibleId)
                    item = getCachedItem(possibleId);
                if (!item) {
                    const embedUrl = interaction.message?.embeds?.[0]?.url;
                    item = findCachedByUrl(embedUrl);
                }
                if (!item) {
                    await interaction.editReply("❌ Item not in cache or expired. Please use a newer deal.");
                    return;
                }
                const platformName = item.platform === "vinted" ? "Vinted" : "Kleinanzeigen";
                const buyRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel(`🛒 Zu ${platformName}`).setStyle(ButtonStyle.Link).setURL(item.url));
                await interaction.editReply({
                    content: `🛒 **${item.brand || ""} | ${item.title}**`.slice(0, 2000),
                    components: [buyRow],
                });
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
                    startAllBrandWorkers(client);
                    await cmd.editReply(`✅ Deal search started! ${BRAND_CHANNELS.length} brand workers running in parallel — triggering an immediate search now...`);
                    await runImmediateSearchAllBrands(client);
                    await cmd.followUp("✅ First search completed!");
                }
                else if (sub === "stop") {
                    watchConfig.active = false;
                    workersRunning = false;
                    await cmd.reply("⏹️ Deal search stopped. All brand workers will wind down after their current cycle.");
                }
                else if (sub === "status") {
                    const trackedMessages = [...postedMessages.values()].reduce((sum, list) => sum + list.length, 0);
                    await cmd.reply(`📊 **Status**\n` +
                        `• Active: ${watchConfig.active ? "✅ Yes" : "❌ No"}\n` +
                        `• Workers: ${workersRunning ? `✅ ${BRAND_CHANNELS.length} running in parallel` : "❌ Not running"}\n` +
                        `• Brands: ${watchConfig.brands.join(", ")}\n` +
                        `• Max Price: ${watchConfig.maxPrice ? `${watchConfig.maxPrice} EUR` : "no limit"}\n` +
                        `• Items in cache: ${seenItemIds.size} (${itemCache.size} in memory)\n` +
                        `• Auto-purge: messages older than 1h deleted automatically (${trackedMessages} tracked, pending purge)`);
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
                    await runImmediateSearchAllBrands(client);
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
