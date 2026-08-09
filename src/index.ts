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
  
  // Start Discord bot
  try {
    startBot();
  } catch (error) {
    logger.error('Fataler Fehler bei der Bot-Initialisierung:', error);
    process.exit(1);
  }
}

main();