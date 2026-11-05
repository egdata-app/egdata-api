import consola from "consola";
import { Redis as IORedis } from "ioredis";
import sharedRedis from "./redis.js";

interface ResponseCache {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    expiry: "EX",
    seconds: number,
  ): Promise<"OK" | null>;
}

let dedicatedRedis: IORedis | undefined;

// Bumping this prefix invalidates every response cached under the previous
// payload shape. v2 drops the compact-card cache entries written before full
// offer documents were restored.
const RESPONSE_CACHE_PREFIX =
  process.env.RESPONSE_CACHE_PREFIX?.trim() || "response:v2:";

const versionedKey = (key: string) => `${RESPONSE_CACHE_PREFIX}${key}`;

const wrap = (client: {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiry: "EX", seconds: number): Promise<"OK" | null>;
}): ResponseCache => ({
  async get(key) {
    return client.get(versionedKey(key));
  },
  async set(key, value, expiry, seconds) {
    return client.set(versionedKey(key), value, expiry, seconds);
  },
});

function createResponseCache(): ResponseCache {
  const host = process.env.CACHE_REDIS_HOST?.trim();
  if (!host) {
    const configured = [
      "CACHE_REDIS_PORT",
      "CACHE_REDIS_USER",
      "CACHE_REDIS_PASSWORD",
      "CACHE_REDIS_TLS",
    ].some((name) => process.env[name]?.trim());
    if (configured) {
      throw new Error(
        "CACHE_REDIS_HOST is required for a dedicated response cache",
      );
    }
    return wrap(sharedRedis);
  }

  const portValue = process.env.CACHE_REDIS_PORT?.trim() || "6379";
  const port = Number(portValue);
  if (
    !/^\d+$/u.test(portValue) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error("CACHE_REDIS_PORT must be an integer between 1 and 65535");
  }
  const tls = process.env.CACHE_REDIS_TLS?.trim() || "false";
  if (tls !== "true" && tls !== "false") {
    throw new Error("CACHE_REDIS_TLS must be true or false");
  }

  const redis = new IORedis({
    host,
    port,
    username: process.env.CACHE_REDIS_USER || undefined,
    password: process.env.CACHE_REDIS_PASSWORD || undefined,
    tls: tls === "true" ? {} : undefined,
    connectTimeout: 1000,
    commandTimeout: 1500,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  dedicatedRedis = redis;
  redis.on("error", (error: Error) => {
    consola.warn("Response cache connection failed", error.name);
  });

  return wrap({
    async get(key) {
      try {
        return await redis.get(key);
      } catch {
        return null;
      }
    },
    async set(key, value, expiry, seconds) {
      try {
        return await redis.set(key, value, expiry, seconds);
      } catch {
        return null;
      }
    },
  });
}

export function disconnectResponseCache(): void {
  dedicatedRedis?.disconnect();
}

export default createResponseCache();
