/**
 * Proxy Bridge Configuration
 * 
 * This configuration enables routing Vinted requests through a proxy server
 * to avoid rate limiting and blocking issues.
 */

/**
 * Base URL for the proxy bridge server
 * Default: http://192.168.178.XX:3000
 * 
 * Update the IP address to match your MacBook's local network IP
 */
export const PROXY_BRIDGE_URL = process.env.PROXY_BRIDGE_URL || 'http://192.168.178.24:3000';

/**
 * User-Agent pool for rotation
 * All are Chrome on macOS to maintain consistency while avoiding pattern detection
 */
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

/**
 * Get a random User-Agent from the pool
 */
export function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * Consistent User-Agent to be used for all Vinted requests
 * This ensures stability and reduces the chance of being blocked
 */
export const VINTED_USER_AGENT = getRandomUserAgent();

/**
 * Retry configuration for proxy bridge failures
 */
export const PROXY_RETRY_CONFIG = {
  /** Delay in milliseconds before retrying after a proxy failure (30 seconds) */
  retryDelay: 30000,
  /** Maximum number of retry attempts */
  maxRetries: 3,
};

/**
 * Anti-Block Configuration
 */
export const ANTI_BLOCK_CONFIG = {
  /** Jitter percentage (±15%) to add randomness to delays */
  jitterPercent: 0.15,
  
  /** Rate limit pause duration when 429 is detected (10 minutes) */
  rateLimitPauseDuration: 10 * 60 * 1000,
  
  /** Minimum delay between requests (in milliseconds) */
  minRequestDelay: 1000,
  
  /** Maximum delay between requests (in milliseconds) */
  maxRequestDelay: 3000,
};

/**
 * Add jitter to a delay value
 * @param baseDelay Base delay in milliseconds
 * @param jitterPercent Jitter percentage (default: ±15%)
 * @returns Randomized delay with jitter applied
 */
export function addJitter(baseDelay: number, jitterPercent: number = ANTI_BLOCK_CONFIG.jitterPercent): number {
  const min = baseDelay * (1 - jitterPercent);
  const max = baseDelay * (1 + jitterPercent);
  return Math.floor(Math.random() * (max - min + 1) + min);
}

/**
 * Get a random delay between min and max with jitter
 * @returns Random delay in milliseconds
 */
export function getRandomDelay(): number {
  const baseDelay = Math.floor(
    Math.random() * (ANTI_BLOCK_CONFIG.maxRequestDelay - ANTI_BLOCK_CONFIG.minRequestDelay + 1) +
    ANTI_BLOCK_CONFIG.minRequestDelay
  );
  return addJitter(baseDelay);
}

/**
 * Sleep for a specified duration with jitter
 * @param baseMs Base duration in milliseconds
 */
export async function sleepWithJitter(baseMs: number): Promise<void> {
  const delayMs = addJitter(baseMs);
  return new Promise(resolve => setTimeout(resolve, delayMs));
}