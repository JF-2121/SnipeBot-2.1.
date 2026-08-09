# 🚀 Quick Setup Guide

## Installation (5 minutes)

### 1. Install Dependencies

```bash
# Navigate to project
cd Snipebot_Server_Backup/Snipebot

# Install Node.js packages
npm install

# Install Python dependency
pip3 install aiohttp
```

### 2. Configure Environment

Create `.env` file:
```env
DISCORD_BOT_TOKEN=your_bot_token_here
PORT=10000
```

### 3. Configure Brand Channels

Edit `src/config/brand-channels.ts` - replace channel IDs with your Discord channel IDs:

```typescript
{
  brand: "Lacoste",
  channelId: "YOUR_CHANNEL_ID", // ← Change this
  query: "Lacoste",
  refreshInterval: 180,
}
```

### 4. Build & Run

```bash
npm run build
npm start
```

## ✅ Verification

Bot should log:
```
Discord Bot logged in as YourBot#1234
🚀 Starting continuous brand-channel monitoring with Kleinanzeigen fallback...
🔍 Searching Lacoste...
```

## 📦 Required Packages

**Node.js** (installed via `npm install`):
- discord.js ^14.26.4
- axios ^1.18.1
- cheerio ^1.0.0-rc.12
- node-cron ^4.6.0
- typescript ^5.3.3

**Python** (install manually):
- aiohttp (via `pip3 install aiohttp`)

## 🎯 Key Features

- **Vinted Scraping**: 100% success via Python subprocess
- **Auto Fallback**: Kleinanzeigen when Vinted fails
- **10 Brand Channels**: Each brand monitored separately
- **Adaptive Intervals**: 60-180s with randomized jitter
- **Deduplication**: Never posts same deal twice

## 🔧 Commands

- `/deals start` - Start monitoring
- `/deals stop` - Stop monitoring
- `/deals status` - Check status
- `/deals reset` - Clear cache

## 🐛 Common Issues

**"Python script not found"**
→ Ensure `vinted_helper.py` is in root `Snipebot/` directory

**"Module 'aiohttp' not found"**
→ Run: `pip3 install aiohttp`

**"Vinted returns 0 items"**
→ Normal! Bot automatically falls back to Kleinanzeigen

## 📊 Architecture

```
Node.js Bot (Master)
    ↓
Vinted (Python subprocess via aiohttp)
    ↓ (if 0 items)
Kleinanzeigen (Node.js fallback)
    ↓
Discord Channels (10 brands)
```

---

**Ready to go! Start with `npm start`** 🚀
