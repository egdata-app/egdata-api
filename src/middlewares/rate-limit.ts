import type { Context, Next } from "hono";
import {
  type ClientRateLimitInfo,
  MemoryStore,
  rateLimiter,
  type Store,
} from "hono-rate-limiter";
import { Redis as IORedis } from "ioredis";
import { getAikidoAnonymousIdentity } from "../utils/aikido-rate-limit-group.js";
import { consola } from "../utils/logger.js";

const RATE_LIMIT_PREFIX = "egdata:ratelimit:";
const MINUTE_MS = 60_000;

const INCREMENT_SCRIPT = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("PTTL", KEYS[1])
return {current, ttl}
`;

let redisClient: IORedis | undefined;
let redisUnavailableUntil = 0;

const useRedis = () => Date.now() >= redisUnavailableUntil;

const markRedisUnavailable = () => {
  // Avoid paying the connect/command timeout on every request during an outage.
  redisUnavailableUntil = Date.now() + 30_000;
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
    commandTimeout: 750,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  redisClient.on("error", (error: Error) => {
    consola.warn(
      "Rate limit Redis unavailable; using local fallback",
      error.name,
    );
  });

  return redisClient;
};

export const disconnectRateLimitStore = () => {
  redisClient?.disconnect();
  redisClient = undefined;
};

/**
 * Redis-backed fixed-window store. Each limiter gets its own namespace; without
 * that, all limiters would share one counter per client and the lowest limit in
 * the process would effectively apply to every route.
 */
class RedisRateLimitStore implements Store {
  readonly localKeys = false;
  private readonly fallback = new MemoryStore();

  constructor(
    private readonly windowMs: number,
    private readonly namespace: string,
  ) {}

  /**
   * hono-rate-limiter only calls `init` when the store exposes it. Forward the
   * options so the in-process fallback knows its window; without this it never
   * resets and a Redis outage turns into a permanent block per client.
   */
  init(options: Parameters<MemoryStore["init"]>[0]) {
    this.fallback.init(options);
  }

  private key(key: string) {
    return `${RATE_LIMIT_PREFIX}${this.namespace}:${key}`;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    if (!useRedis()) {
      return this.fallback.increment(key);
    }
    try {
      const result = (await getRedisClient().eval(
        INCREMENT_SCRIPT,
        1,
        this.key(key),
        String(this.windowMs),
      )) as [number, number];
      const [totalHits, ttl] = result;
      return {
        totalHits: Number(totalHits),
        resetTime: ttl > 0 ? new Date(Date.now() + Number(ttl)) : undefined,
      };
    } catch {
      markRedisUnavailable();
      return this.fallback.increment(key);
    }
  }

  async decrement(key: string): Promise<void> {
    if (!useRedis()) {
      await this.fallback.decrement(key);
      return;
    }
    try {
      await getRedisClient().decr(this.key(key));
    } catch {
      markRedisUnavailable();
      await this.fallback.decrement(key);
    }
  }

  async resetKey(key: string): Promise<void> {
    if (!useRedis()) {
      await this.fallback.resetKey(key);
      return;
    }
    try {
      await getRedisClient().del(this.key(key));
    } catch {
      markRedisUnavailable();
      await this.fallback.resetKey(key);
    }
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    if (!useRedis()) {
      return this.fallback.get(key);
    }
    try {
      const client = getRedisClient();
      const [value, ttl] = (await Promise.all([
        client.get(this.key(key)),
        client.pttl(this.key(key)),
      ])) as [string | null, number];
      if (value === null) {
        return undefined;
      }
      return {
        totalHits: Number(value),
        resetTime: ttl > 0 ? new Date(Date.now() + ttl) : undefined,
      };
    } catch {
      markRedisUnavailable();
      return this.fallback.get(key);
    }
  }
}

const isRateLimitEnabled = () => {
  if (process.env.RATE_LIMIT_ENABLED === "false") {
    return false;
  }
  if (process.env.RATE_LIMIT_ENABLED === "true") {
    return true;
  }
  return process.env.NODE_ENV !== "test";
};

const numberFromEnv = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const skipCheapRequests = (c: Context) =>
  c.req.method === "OPTIONS" ||
  c.req.method === "HEAD" ||
  ["/health", "/ping", "/robots.txt"].includes(c.req.path) ||
  c.req.path.endsWith("sitemap.xml");

const clientKey = (c: Context) => {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  const ip =
    c.req.header("cf-connecting-ip") || forwarded || c.req.header("x-real-ip");
  if (ip) {
    return ip;
  }

  return getAikidoAnonymousIdentity(c.req.raw.headers)?.id ?? "unknown";
};

const rateLimitHandler = (message: string) => {
  return (c: Context) => {
    const info = (c.get as never as (key: string) => { resetTime?: Date }).call(
      c,
      "rateLimit",
    );
    const retryAfter = info?.resetTime
      ? Math.max(1, Math.ceil((info.resetTime.getTime() - Date.now()) / 1000))
      : 60;

    c.header("Retry-After", String(retryAfter));
    return c.json(
      {
        error: {
          code: "RATE_LIMITED",
          message,
          retryAfter,
        },
      },
      429,
    );
  };
};

const createLimiter = (
  namespace: string,
  limit: number,
  message: string,
  windowMs = MINUTE_MS,
) => {
  const store = new RedisRateLimitStore(windowMs, namespace);
  const middleware = rateLimiter({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    keyGenerator: clientKey,
    skip: skipCheapRequests,
    handler: rateLimitHandler(message),
    store,
  });

  return async (c: Context, next: Next) => {
    if (!isRateLimitEnabled()) {
      return next();
    }
    return middleware(c, next);
  };
};

/**
 * Baseline anonymous quota. This is intentionally generous: it stops runaway
 * scripts without affecting normal browsing.
 */
export const generalRateLimit = createLimiter(
  "general",
  numberFromEnv("RATE_LIMIT_GENERAL_PER_MINUTE", 1200),
  "Too many requests. Please retry shortly.",
);

/**
 * Cacheable GraphQL GET queries, including Automatic Persisted Queries. These
 * are served by Cloudflare on repeat requests, so the origin limit can be high.
 */
export const graphqlGetRateLimit = createLimiter(
  "graphql-get",
  numberFromEnv("RATE_LIMIT_GRAPHQL_GET_PER_MINUTE", 1200),
  "GraphQL is temporarily rate limited. Please retry shortly.",
);

/**
 * GraphQL POST queries cannot be cached by a CDN and are the main scraping
 * path, so they get a much tighter quota than GET/APQ.
 */
export const graphqlPostRateLimit = createLimiter(
  "graphql-post",
  numberFromEnv("RATE_LIMIT_GRAPHQL_POST_PER_MINUTE", 120),
  "GraphQL POST is temporarily rate limited. Please use GET with persisted queries.",
);

export const graphqlRateLimit = async (c: Context, next: Next) => {
  const limiter =
    c.req.method === "GET" ? graphqlGetRateLimit : graphqlPostRateLimit;
  return limiter(c, next);
};

/**
 * Expensive detail/image routes. Anonymous traffic above this rate is almost
 * always automation in practice.
 */
export const heavyRateLimit = createLimiter(
  "heavy",
  numberFromEnv("RATE_LIMIT_HEAVY_PER_MINUTE", 60),
  "This endpoint is temporarily rate limited. Please retry shortly.",
);

/**
 * Interactive offer search. A single UI page can issue several searches per
 * filter/sort/page interaction, so this needs a materially higher quota than
 * detail/image routes.
 */
export const searchRateLimit = createLimiter(
  "search",
  numberFromEnv("RATE_LIMIT_SEARCH_PER_MINUTE", 300),
  "Search is temporarily rate limited. Please retry shortly.",
);

/**
 * Bulk catalog/launcher resolution endpoints.
 */
export const bulkRateLimit = createLimiter(
  "bulk",
  numberFromEnv("RATE_LIMIT_BULK_PER_MINUTE", 10),
  "Bulk requests are rate limited. Please retry shortly.",
);

/**
 * Public offer list (`GET /offers`). This is the catalogue enumeration route
 * that sustained scrapers page through, while the website itself never calls
 * it. The counter is keyed by client identity (IP), never by the request URL,
 * so adding or rotating query parameters (page, country, cache busters, ...)
 * cannot open a fresh bucket.
 */
const offersListLimit = numberFromEnv("RATE_LIMIT_OFFERS_LIST_PER_MINUTE", 5);

export const offersListRateLimit = createLimiter(
  "offers-list",
  offersListLimit,
  `The offers list is limited to ${offersListLimit} requests per minute. Use /search/v2/search for catalogue queries.`,
);
