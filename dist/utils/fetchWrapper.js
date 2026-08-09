import axios from "axios";
import { logger } from "../lib/logger.js";
export async function fetchWithRetry(url, options = {}) {
    const maxRetries = options.maxRetries ?? 3;
    const baseDelay = options.retryDelay ?? 1000;
    const config = {
        ...options,
        timeout: options.timeout ?? 12000,
        validateStatus: () => true,
    };
    if (process.env.PROXY_URL) {
        const proxyUrl = new URL(process.env.PROXY_URL);
        config.proxy = {
            host: proxyUrl.hostname,
            port: parseInt(proxyUrl.port || "80"),
            protocol: proxyUrl.protocol.replace(":", ""),
        };
    }
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios.get(url, config);
            if (response.status === 200) {
                return response;
            }
            if (attempt < maxRetries) {
                const delay = baseDelay * Math.pow(2, attempt);
                logger.warn(`Retry ${attempt + 1}/${maxRetries} after ${delay}ms (Status: ${response.status})`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        catch (error) {
            if (attempt < maxRetries) {
                const delay = baseDelay * Math.pow(2, attempt);
                logger.warn(`Retry ${attempt + 1}/${maxRetries} after ${delay}ms (Error: ${String(error)})`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
            else {
                throw error;
            }
        }
    }
    throw new Error(`Failed after ${maxRetries} retries`);
}
