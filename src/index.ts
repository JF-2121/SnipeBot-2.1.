import { fileURLToPath } from 'url';
import path from 'path';

// Globale Definition für ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
global.__dirname = __dirname; // <-- WICHTIG: Macht es global verfügbar!

// Danach erst dotenv laden
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { startBot } from './discordbot.js';
import { startVintedDaemon, stopVintedDaemon } from './scrapers/vinted.js';
import { logger } from './lib/logger.js';
import http from 'http';
// Lightweight health check server for Render.com + UptimeRobot
function startHealthServer() {
  const port = parseInt(process.env.PORT || '10000', 10);
  
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Bot is alive!');
    } else {
      res.writeHead(405);
      res.end();
    }
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info(`Health server running on port ${port}`);
  });
}

function main() {
  logger.info('Starte Snipebot Anwendung...');

  // Start health server first (non-blocking)
  startHealthServer();

  // Fire-and-forget: the daemon's cookie bootstrap runs while Discord logs in below,
  // instead of delaying the first search after the bot is already ready.
  startVintedDaemon();

  // Start Discord bot
  try {
    startBot();
  } catch (error) {
    logger.error('Fataler Fehler bei der Bot-Initialisierung:', error);
    process.exit(1);
  }
}

// PM2 sends SIGTERM on restart/stop — without this, the Vinted daemon child process would
// be left orphaned on every restart instead of shutting down cleanly with its parent.
function shutdown(signal: string) {
  logger.info(`${signal} empfangen, fahre sauber herunter...`);
  stopVintedDaemon();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main();