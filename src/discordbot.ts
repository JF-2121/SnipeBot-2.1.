import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  TextChannel,
  Events,
  ActivityType,
  SlashCommandBuilder,
  REST,
  Routes,
  ChatInputCommandInteraction,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  MessageFlags,
} from "discord.js";
import axios from "axios";
import { searchAllPlatforms, startVintedOnlyWindow } from "./scrapers/registry.js";
import { ScrapedItem } from "./scrapers/types.js";
import { CATEGORIES } from "./config/categories.js";
import { 
  BRAND_CHANNELS, 
  getRandomizedInterval,
  getAllBrands 
} from "./config/brand-channels.js";
import { logger } from "./lib/logger.js";
import { vintedScraper } from "./scrapers/vinted.js";
import { kleinanzeigenScraper } from "./scrapers/kleinanzeigen.js";
import { COUNTRY_FLAGS } from "./vinted-scraper.js";

interface DealItem extends ScrapedItem {
  currency: string;
  condition: string;
  seller: string;
  location: string;
  url: string;
  description?: string;
  main_image_url?: string;
  buyerProtectionFee?: number;
  shippingFee?: number;
  feeTotal?: number;
  totalPrice?: number;
  sellerUsername?: string;
  sellerAvatar?: string;
  reviewRating?: number;
}

async function sendDealToMultipleChannels(channels: any[], dealPayload: any): Promise<void> {
  const targets = (channels || []).slice(0, 3);
  await Promise.allSettled(targets.map((channel) => channel.send(dealPayload)));
}

const FALLBACK_CHANNEL_ID = "1483482170583678976";
const DEFAULT_BRANDS = getAllBrands();

interface CachedDealItem {
  item: DealItem;
  timestamp: number;
}

const itemCache = new Map<string, CachedDealItem>();
const MAX_CACHE_SIZE = 2000;
const CACHE_TTL_MS = 3600000; // 1 hour in milliseconds

function cacheItem(item: DealItem) {
  const cached: CachedDealItem = {
    item,
    timestamp: Date.now()
  };
  
  itemCache.set(item.id, cached);
  
  // LRU eviction: Remove oldest entries if cache exceeds size
  if (itemCache.size > MAX_CACHE_SIZE) {
    // Find oldest entry
    let oldestKey: string | null = null;
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

function getCachedItem(itemId: string): DealItem | null {
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
const licenseCache = new Map<string, { valid: boolean; expiry: number }>();

async function isGuildLicensed(guildId: string): Promise<boolean> {
  if (!WHOP_API_KEY || !WHOP_PRODUCT_ID) return true;
  const cached = licenseCache.get(guildId);
  if (cached && Date.now() < cached.expiry) return cached.valid;
  try {
    const res = await axios.get("https://api.whop.com/api/v2/memberships", {
      headers: { Authorization: `Bearer ${WHOP_API_KEY}` },
      params: { product_id: WHOP_PRODUCT_ID, metadata_discord_guild_id: guildId, valid: true },
      timeout: 8000,
    });
    const valid = (res.data?.data?.length ?? 0) > 0;
    licenseCache.set(guildId, { valid, expiry: Date.now() + 10 * 60 * 1000 });
    return valid;
  } catch (err) {
    logger.error("Whop license check failed for Guild " + guildId + ": " + String(err));
    return false;
  }
}

type Gender = "herren" | "damen" | "beide";

const CATEGORY_CHOICES = [
  { name: "Shirts & Polos", value: "shirts" },
  { name: "Hosen & Jeans", value: "pants" },
  { name: "Schuhe", value: "shoes" },
  { name: "Accessoires", value: "accessories" },
];

interface WatchConfig {
  brands: string[];
  maxPrice: number | undefined;
  active: boolean;
  categoryKey: string;
  gender: Gender;
}

const watchConfig: WatchConfig = {
  brands: [...DEFAULT_BRANDS],
  maxPrice: undefined,
  active: true,
  categoryKey: "accessories",
  gender: "beide",
};

const seenItemIds = new Set<string>();
let rateLimitedUntil = 0;
let consecutiveRateLimits = 0;
const postingQueue: Array<{ channel: TextChannel; brand: string; item: DealItem }> = [];
let postingWorkerRunning = false;

function genderLabel(g: Gender): string {
  if (g === "herren") return "Herren";
  if (g === "damen") return "Damen";
  return "Herren & Damen";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runPostingQueueWorker(): Promise<void> {
  if (postingWorkerRunning) return;
  postingWorkerRunning = true;

  while (postingWorkerRunning) {
    const next = postingQueue.shift();

    if (!next) {
      await delay(250);
      continue;
    }

    try {
      cacheItem(next.item);
      const mainEmbed = buildDealEmbed(next.item);
      const images: string[] = (next.item as any).images_array || (next.item as any).photos || [];
      const embeds = [mainEmbed];

      if (images[1]) embeds.push(new EmbedBuilder().setURL(next.item.url).setImage(images[1]));
      if (images[2]) embeds.push(new EmbedBuilder().setURL(next.item.url).setImage(images[2]));

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('save_item').setLabel('Merken').setStyle(ButtonStyle.Secondary).setEmoji('💾'),
        new ButtonBuilder().setCustomId('interested').setLabel('Interessiert').setStyle(ButtonStyle.Primary).setEmoji('⚡'),
        new ButtonBuilder().setCustomId('fake_check').setLabel('Fake Check').setStyle(ButtonStyle.Secondary).setEmoji('🔎'),
      );

      await sendDealToMultipleChannels([next.channel], { embeds, components: [row] });
      logger.info(`📤 ${next.brand}: Posted ${next.item.platform.toUpperCase()} deal - ${((next.item as any).totalPrice ?? next.item.price).toFixed(2)}€`);
    } catch (err) {
      logger.error(`❌ Queue post failed for ${next.brand}: ${String(err)}`);
    }

    await new Promise((res) => setTimeout(res, 5000));
  }
}

function enqueueDeal(channel: TextChannel, brand: string, item: DealItem): void {
  postingQueue.push({ channel, brand, item });
  void runPostingQueueWorker();
}

async function findChannelByName(client: Client, channelName: string): Promise<TextChannel | null> {
  for (const [, guild] of client.guilds.cache) {
    const ch = guild.channels.cache.find((c) => c.name === channelName && c instanceof TextChannel) as TextChannel | undefined;
    if (ch) return ch;
  }
  return null;
}

async function getFallbackChannel(client: Client): Promise<TextChannel | null> {
  try {
    const ch = await client.channels.fetch(FALLBACK_CHANNEL_ID);
    if (ch instanceof TextChannel) return ch;
  } catch { /* ignore */ }
  return null;
}

function runFakeCheck(item: DealItem): { embed: EmbedBuilder; row: ActionRowBuilder<ButtonBuilder> } {
  const warnings: string[] = [];
  const positives: string[] = [];
  let riskScore = 0;

  const knownExpensiveBrands = ["ralph lauren", "lacoste", "carhartt"];
  const isExpensiveBrand = knownExpensiveBrands.some((b) => item.brand.toLowerCase().includes(b));

  if (item.price < 3) { warnings.push("💸 Preis extrem niedrig (unter 3€)"); riskScore += 35; }
  else if (item.price < 8 && isExpensiveBrand) { warnings.push("💸 Preis sehr niedrig für diese Marke"); riskScore += 20; }
  else if (item.price < 5) { warnings.push("💸 Preis sehr niedrig"); riskScore += 15; }
  else { positives.push("💰 Preis im normalen Bereich"); }

  if (!item.condition || item.condition === "—") { warnings.push("❓ Kein Zustand angegeben"); riskScore += 10; }
  else if (item.condition.toLowerCase().includes("neu")) { positives.push("✨ Als 'Neu' eingestuft"); }
  else { positives.push(`✨ Zustand: ${item.condition}`); }

  if (!item.size || item.size === "—") { warnings.push("📐 Keine Größenangabe"); riskScore += 10; }
  else { positives.push(`📐 Größe angegeben: ${item.size}`); }

  if (item.brand && !item.title.toLowerCase().includes(item.brand.toLowerCase())) {
    warnings.push("🏷️ Markenname nicht im Titel"); riskScore += 15;
  } else if (item.brand) {
    positives.push("🏷️ Markenname im Titel bestätigt");
  }

  if (!item.seller || item.seller === "—") { warnings.push("👤 Kein Verkäufername"); riskScore += 10; }
  else { positives.push(`👤 Verkäufer: ${item.seller}`); }

  let verdict: string;
  let color: number;
  if (riskScore >= 45) { verdict = "🔴 HOHES RISIKO — Vorsicht!"; color = 0xff0000; }
  else if (riskScore >= 20) { verdict = "🟡 MITTLERES RISIKO — Genau prüfen"; color = 0xffa500; }
  else { verdict = "🟢 NIEDRIGES RISIKO — Wirkt legitim"; color = 0x00cc66; }

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`🔍 Fake-Check: ${item.brand || "—"} | ${item.title}`.slice(0, 250))
    .setURL(item.url)
    .setDescription(`**${verdict}**\nRisiko-Score: **${riskScore}/100**`)
    .addFields(
      { name: "💰 Preis", value: `${item.price.toFixed(2)} ${item.currency}`, inline: true },
      { name: "🏷️ Marke", value: item.brand || "—", inline: true },
      { name: "📐 Größe", value: item.size || "—", inline: true },
      { name: "✨ Zustand", value: item.condition || "—", inline: true },
      { name: "👤 Verkäufer", value: item.seller || "—", inline: true },
    )
    .setFooter({ text: "Fake-Check • Snipebot" })
    .setTimestamp();

  if (warnings.length > 0) embed.addFields({ name: "⚠️ Warnzeichen", value: warnings.join("\n") });
  if (positives.length > 0) embed.addFields({ name: "✅ Positive Zeichen", value: positives.join("\n") });
  if (item.imageUrl) embed.setThumbnail(item.imageUrl);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel("🔗 Inserat öffnen").setStyle(ButtonStyle.Link).setURL(item.url),
  );

  return { embed, row };
}

function ratingToStars(rating?: number, count?: number): string {
  const r = Math.max(0, Math.min(5, Math.round(rating ?? 0)));
  const stars = r > 0 ? "⭐️".repeat(r) : "";
  const cnt = count ?? 0;
  return stars ? `${stars} (${cnt})` : `(0)`;
}

function buildDealEmbed(item: DealItem): EmbedBuilder {
  const meta = item as DealItem & {
    cleanTitle?: string;
    images_array?: string[];
    sellerUsername?: string;
    sellerAvatar?: string;
    base_price?: number;
    buyerProtectionFee?: number;
    reviewCount?: number;
    reviewRating?: number;
    publishedAt?: string;
    description?: string;
  };

  const images = meta.images_array || (meta as any).photos || [];
  const mainImage = images[0] || meta.main_image_url || item.imageUrl || "https://i.imgur.com/8Km9tLL.png";
  const img2 = images[1];
  const img3 = images[2];

  const safeTitle = meta.cleanTitle || (item as any).cleanTitle || item.title || "—";

  const basePrice = Number(meta.base_price ?? item.price ?? 0);
  const buyerFee = Number(meta.buyerProtectionFee ?? (meta as any).protection_fee ?? 0);
  const totalPrice = Number(meta.totalPrice ?? (item as any).totalPrice ?? (basePrice + buyerFee));

  const reviewsDisplay = ratingToStars(meta.reviewRating, meta.reviewCount);
  const published = meta.publishedAt || (item as any).publishedAt || "Gerade eben";

  const sellerName = (meta.sellerUsername || (item as any).sellerUsername || (item as any).seller || "—").toString();
  const sellerAvatar = (meta.sellerAvatar || (item as any).sellerAvatar || "").toString() || undefined;
  const total = Number(totalPrice || 0);
  const base = Number(basePrice || 0);
  const fee = total > base ? total - base : 0;
  const priceStr = fee > 0 ? `${base.toFixed(2)} € (+ ${fee.toFixed(2)} €)` : `${base.toFixed(2)} €`;
  const mainEmbed = new EmbedBuilder()
    .setColor(0x6EB6FF)
    .setAuthor({ name: sellerName, iconURL: sellerAvatar })
    .setTitle(`${safeTitle} | ${Number(total || base).toFixed(2)} €`.slice(0, 256))
    .setURL(item.url)
    .addFields(
      { name: "🏷️ Brand", value: (meta.brand || item.brand || "—") || "—", inline: true },
      { name: "📏 Size", value: (meta.size || item.size || "—") || "—", inline: true },
      { name: "✨ Condition", value: (meta.condition || item.condition || "—") || "—", inline: true },
      { name: "⏰ Published", value: published || "—", inline: true },
      { name: "🌟 Reviews", value: reviewsDisplay || "—", inline: true },
      { name: "💰 Price", value: priceStr || "—", inline: true },
    )
    .setImage(mainImage)
    .setFooter({ text: `🔗 ${item.brand || "Vinted"}`, iconURL: sellerAvatar })
    .setTimestamp();

  // Return the primary embed; additional embeds (img2/img3) are appended by the caller
  return mainEmbed;
}

function buildDealButtons(item: DealItem): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('save_item').setLabel('Merken').setStyle(ButtonStyle.Secondary).setEmoji('💾'),
    new ButtonBuilder().setCustomId('interested').setLabel('Interessiert').setStyle(ButtonStyle.Primary).setEmoji('⚡'),
    new ButtonBuilder().setCustomId('fake_check').setLabel('Fake Check').setStyle(ButtonStyle.Secondary).setEmoji('🔎'),
  );
  return [row];
}

/**
 * Post deals for a specific brand to its dedicated channel
 * CRITICAL FALLBACK LOGIC: Try Vinted first, if 0 items -> immediately try Kleinanzeigen
 */
async function postDealsForBrand(client: Client, brandConfig: typeof BRAND_CHANNELS[0]) {
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
    
    if (allItems.length > 0) consecutiveRateLimits = 0;

    logger.info(`✅ ${brandConfig.brand}: ${allItems.length} total items`);
    let enqueued = 0;
    for (const item of allItems) {
      if (seenItemIds.has(item.id)) continue;
      seenItemIds.add(item.id);
      const dealItem: DealItem = {
        ...item,
        currency: (item as any).currency || "EUR",
        condition: (item as any).condition || "N/A",
        seller: (item as any).sellerUsername || (item as any).seller || "N/A",
        location: "—",
        url: item.link,
        description: (item as any).description || "",
        main_image_url: (item as any).main_image_url || item.imageUrl,
        buyerProtectionFee: Number((item as any).buyerProtectionFee ?? 0),
        shippingFee: Number((item as any).shippingFee ?? 0),
        feeTotal: Number((item as any).feeTotal ?? 0),
        totalPrice: Number((item as any).totalPrice ?? 0),
        sellerUsername: (item as any).sellerUsername || (item as any).seller || "",
        sellerAvatar: (item as any).sellerAvatar || "",
        reviewRating: Number((item as any).reviewRating ?? 0),
      };
      enqueueDeal(channel, brandConfig.brand, dealItem);
      enqueued += 1;
    }
    logger.info(`📌 ${brandConfig.brand}: Enqueued ${enqueued} new items`);
    
    // Finished processing this brand (no per-brand cooldown here)
  } catch (err) {
    logger.error(`❌ Error searching ${brandConfig.brand}: ${String(err)}`);
  }
}


async function postDeals(client: Client) {
  if (!watchConfig.active) return;

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
    // Short, fixed delay between brands to avoid WAF/anti-bot triggers
    await new Promise(res => setTimeout(res, 2500));
  }
  
  // After all brands have been checked, apply a global adaptive cooldown (60-180s)
  const minSec = 60;
  const maxSec = 180;
  const globalDelaySec = Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec;
  logger.info(`⏱️ Full cycle completed. Next full cycle in ${globalDelaySec}s`);
  await new Promise(res => setTimeout(res, globalDelaySec * 1000));

  logger.info("✅ Deal search cycle completed");
}

const commands = [
  new SlashCommandBuilder()
    .setName("deals")
    .setDescription("Deal-Bot Control")
    .addSubcommand((sub) => sub.setName("start").setDescription("Start deal search"))
    .addSubcommand((sub) => sub.setName("stop").setDescription("Stop deal search"))
    .addSubcommand((sub) => sub.setName("status").setDescription("Show current status"))
    .addSubcommand((sub) =>
      sub.setName("marken").setDescription("Set brands (comma-separated)")
        .addStringOption((o) => o.setName("liste").setDescription("e.g. Nike,Adidas,Lacoste").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName("maxpreis").setDescription("Set max price in EUR")
        .addIntegerOption((o) => o.setName("preis").setDescription("e.g. 50 for max 50 EUR (0 = no limit)").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName("kategorie").setDescription("Search specific category only")
        .addStringOption((o) => o.setName("typ").setDescription("Select category").setRequired(true).addChoices(...CATEGORY_CHOICES)),
    )
    .addSubcommand((sub) => sub.setName("suche").setDescription("Search for deals now"))
    .addSubcommand((sub) => sub.setName("reset").setDescription("Reset cache (shows old deals again)")),

  new SlashCommandBuilder()
    .setName("lizenz")
    .setDescription("Show license status of this server"),
];

let botOwnerId: string | null = null;

export async function startBot() {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) { logger.error("DISCORD_BOT_TOKEN not set."); return; }

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
      if (botOwnerId) logger.info(`Bot owner detected: ${botOwnerId}`);
    } catch (err) {
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
    } catch (err) {
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
        } catch (err) {
          logger.error("Monitoring cycle failed: " + String(err));
        }
        
        // Minimum 1 minute between full cycles
        const minCycleDelay = 60000;
        await new Promise(resolve => setTimeout(resolve, minCycleDelay));
      }
    }
    
    continuousMonitoring().catch((err) => 
      logger.error("Continuous monitoring crashed: " + String(err))
    );
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isButton()) {
      const { customId, user } = interaction as any;

      const findCachedByUrl = (url?: string): DealItem | null => {
        if (!url) return null;
        for (const [, cached] of itemCache) {
          if (cached.item.url === url) return cached.item;
        }
        return null;
      };

      // SAVE (old: save_<id>, new: save_item)
      if (customId.startsWith("save_") || customId === "save_item") {
        await interaction.deferUpdate();
        let item: DealItem | null = null;
        if (customId.startsWith("save_")) {
          const itemId = customId.replace("save_", "");
          item = getCachedItem(itemId);
        } else {
          const embedUrl = interaction.message?.embeds?.[0]?.url;
          item = findCachedByUrl(embedUrl);
        }

        if (!item) {
          await interaction.followUp({ content: "❌ Item not in cache or expired (older than 1 hour). Please use a newer deal.", flags: 64 });
          return;
        }

        const priceVal = Number((item as any).totalPrice ?? (item as any).base_price ?? item.price ?? 0);
        const savedEmbed = new EmbedBuilder()
          .setColor(0xe91e63)
          .setTitle(`❤️ Saved Deal: ${item.brand || ""} | ${item.title}`.slice(0, 250))
          .setURL(item.url)
          .addFields(
            { name: "💰 Price", value: `**${priceVal.toFixed(2)} EUR**`, inline: true },
            { name: "📐 Size", value: item.size || "—", inline: true },
            { name: "✨ Condition", value: item.condition || "—", inline: true },
            { name: "👤 Seller", value: item.seller || "—", inline: true },
          )
          .setFooter({ text: "Your saved deals • Snipebot" })
          .setTimestamp();
        if (item.imageUrl) savedEmbed.setImage(item.imageUrl);

        const platformName = item.platform === "vinted" ? "Vinted" : "Kleinanzeigen";
        const linkRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setLabel(`🛒 View on ${platformName}`).setStyle(ButtonStyle.Link).setURL(item.url),
        );

        try {
          const dm = await user.createDM();
          await dm.send({
            content: `❤️ **You saved a deal!**`,
            embeds: [savedEmbed],
            components: [linkRow],
          });
          await interaction.followUp({ content: "✅ Deal saved to your DMs!", flags: 64 });
        } catch {
          await interaction.followUp({
            content: "⚠️ Your DMs are disabled. Enable DMs to save deals.",
            flags: 64,
          });
        }
        return;
      }

      // INTERESTED
      if (customId.startsWith("interested_") || customId === "interested") {
        await interaction.deferUpdate();
        try {
          await interaction.message.react("👍");
          await interaction.followUp({ content: "👍 Marked as interesting!", flags: 64 });
        } catch {
          await interaction.followUp({ content: "❌ Error reacting.", flags: 64 });
        }
        return;
      }

      // FAKE CHECK
      if (customId.startsWith("fakecheck_") || customId === "fake_check") {
        await interaction.deferReply({ flags: 64 });
        let item: DealItem | null = null;
        if (customId.startsWith("fakecheck_")) {
          const itemId = customId.replace("fakecheck_", "");
          item = getCachedItem(itemId);
        } else {
          const embedUrl = interaction.message?.embeds?.[0]?.url;
          item = findCachedByUrl(embedUrl);
        }

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
        } catch {
          const fakeChannel = await findChannelByName(client, "fake-check");
          if (fakeChannel) {
            await fakeChannel.send({ content: `Fake-check requested by <@${user.id}>:`, embeds: [embed], components: [row] });
            await interaction.editReply(`✅ Fake-check posted in ${fakeChannel} (DMs disabled).`);
          } else {
            await interaction.editReply({ embeds: [embed], components: [row] });
          }
        }
        return;
      }

      return;
    }

    if (!interaction.isChatInputCommand()) return;
    const cmd = interaction as ChatInputCommandInteraction;

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

        } else if (sub === "stop") {
          watchConfig.active = false;
          await cmd.reply("⏹️ Deal search stopped.");

        } else if (sub === "status") {
          await cmd.reply(
            `📊 **Status**\n` +
            `• Active: ${watchConfig.active ? "✅ Yes" : "❌ No"}\n` +
            `• Brands: ${watchConfig.brands.join(", ")}\n` +
            `• Max Price: ${watchConfig.maxPrice ? `${watchConfig.maxPrice} EUR` : "no limit"}\n` +
            `• Items in cache: ${seenItemIds.size} (${itemCache.size} in memory)`,
          );

        } else if (sub === "marken") {
          const liste = cmd.options.getString("liste", true);
          watchConfig.brands = liste.split(",").map((b) => b.trim()).filter(Boolean);
          seenItemIds.clear();
          await cmd.reply(`✅ Brands updated: **${watchConfig.brands.join(", ")}**`);

        } else if (sub === "maxpreis") {
          const preis = cmd.options.getInteger("preis", true);
          watchConfig.maxPrice = preis > 0 ? preis : undefined;
          seenItemIds.clear();
          await cmd.reply(`✅ Max price: ${preis > 0 ? `**${preis} EUR**` : "**no limit**"}`);

        } else if (sub === "kategorie") {
          const typ = cmd.options.getString("typ", true);
          if (!CATEGORIES[typ]) { await cmd.reply("❌ Unknown category."); return; }
          watchConfig.categoryKey = typ;
          seenItemIds.clear();
          await cmd.reply(`✅ Category set: **${CATEGORIES[typ]!.label}** → #${CATEGORIES[typ]!.channelName}`);

        } else if (sub === "suche") {
          await cmd.deferReply();
          await postDeals(client);
          await cmd.editReply("✅ Search completed!");

        } else if (sub === "reset") {
          seenItemIds.clear();
          itemCache.clear();
          await cmd.reply("🗑️ Cache cleared. Next search will treat all items as 'new'.");
        }

      } else if (cmd.commandName === "lizenz") {
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

    } catch (err) {
      logger.error("Error processing slash command: " + String(err));
      try {
        const msg = { content: "❌ Error processing command.", flags: 64 };
        if (cmd.deferred || cmd.replied) await cmd.followUp(msg);
        else await cmd.reply(msg);
      } catch { /* ignore */ }
    }
  });

  client.on(Events.Error, (err) => { logger.error("Discord client error: " + String(err)); });
  client.on(Events.ShardDisconnect, (event, shardId) => { logger.warn(`Shard ${shardId} disconnected (Code: ${event.code})`); });
  client.on(Events.ShardReconnecting, (shardId) => { logger.info(`Shard ${shardId} reconnecting...`); });
  client.on(Events.ShardResume, (shardId) => { logger.info(`Shard ${shardId} resumed successfully`); });

  await client.login(token);
}
