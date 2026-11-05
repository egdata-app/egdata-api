import { createHash } from "node:crypto";
import { Redis as IORedis } from "ioredis";
import { consola } from "../utils/logger.js";

const APQ_PREFIX = "egdata:graphql:apq:";
const APQ_TTL_SECONDS = 30 * 24 * 60 * 60;
const MEMORY_MAX_ENTRIES = 2_000;
const REDIS_COMMAND_TIMEOUT_MS = 500;
const REDIS_RETRY_AFTER_MS = 30_000;

const memory = new Map<string, string>();
let redisClient: IORedis | undefined;
let redisUnavailableUntil = 0;

const isRedisAvailable = () => Date.now() >= redisUnavailableUntil;

const markRedisUnavailable = () => {
  redisUnavailableUntil = Date.now() + REDIS_RETRY_AFTER_MS;
};

const getRedisClient = () => {
  if (redisClient) {
    return redisClient;
  }

  redisClient = new IORedis({
    host: process.env.REDISHOST || "127.0.0.1",
    port: Number.parseInt(process.env.REDISPORT || "6379", 10),
    tls: process.env.REDISTLS === "true" ? {} : undefined,
    username: process.env.REDISUSER || undefined,
    password: process.env.REDISPASSWORD || undefined,
    connectTimeout: 1_000,
    commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  redisClient.on("error", (error: Error) => {
    consola.warn(
      "GraphQL persisted-query Redis unavailable; using local fallback",
      error.name,
    );
  });

  return redisClient;
};

const remember = (hash: string, query: string) => {
  memory.delete(hash);
  memory.set(hash, query);
  while (memory.size > MEMORY_MAX_ENTRIES) {
    const oldest = memory.keys().next().value;
    if (!oldest) break;
    memory.delete(oldest);
  }
};

export const persistedQueryKey = (hash: string) => `${APQ_PREFIX}${hash}`;

export const hashQuery = (query: string) =>
  createHash("sha256").update(query).digest("hex");

export const isValidPersistedQueryHash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);

export async function getPersistedQuery(
  hash: string,
): Promise<string | undefined> {
  const local = memory.get(hash);
  if (local) {
    return local;
  }
  if (!isRedisAvailable()) {
    return undefined;
  }

  try {
    const stored = await getRedisClient().get(persistedQueryKey(hash));
    if (stored) {
      remember(hash, stored);
    }
    return stored ?? undefined;
  } catch {
    markRedisUnavailable();
    return undefined;
  }
}

export async function storePersistedQuery(hash: string, query: string) {
  remember(hash, query);
  if (!isRedisAvailable()) {
    return;
  }

  try {
    await getRedisClient().set(
      persistedQueryKey(hash),
      query,
      "EX",
      APQ_TTL_SECONDS,
    );
  } catch {
    markRedisUnavailable();
  }
}

export const disconnectPersistedQueryStore = () => {
  redisClient?.disconnect();
  redisClient = undefined;
};
