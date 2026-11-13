import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocalTelemetry } from "../worker/analytics";
import { generateApiKeySecret, sha256Hex } from "../worker/crypto";
import {
  canonicalSearchParams,
  etagMatches,
  legacyResponseEdgeTtlSeconds,
  v1EdgeCacheTtlSeconds,
} from "../worker/edge-cache";
import { handleEdgeApiProxy } from "../worker/proxy";
import type { CachedKeyMetadata, DashboardEnv } from "../worker/types";
import { handleV1ApiProxy } from "../worker/v1";

interface StoredCacheEntry {
  response: Response;
  expiresAt: number;
}

function createMockCacheStorage() {
  const store = new Map<string, StoredCacheEntry>();

  const defaultCache = {
    match: vi.fn(async (input: RequestInfo | URL) => {
      const req = input instanceof Request ? input : new Request(String(input));
      const entry = store.get(req.url);
      if (!entry) return undefined;
      if (Date.now() >= entry.expiresAt) {
        store.delete(req.url);
        return undefined;
      }
      const etag = entry.response.headers.get("etag");
      const ifNoneMatch = req.headers.get("if-none-match");
      if (ifNoneMatch && etag && etagMatches(ifNoneMatch, etag)) {
        return new Response(null, {
          status: 304,
          headers: entry.response.headers,
        });
      }
      return entry.response.clone();
    }),
    put: vi.fn(async (input: RequestInfo | URL, response: Response) => {
      const req = input instanceof Request ? input : new Request(String(input));
      if (req.method !== "GET") {
        throw new TypeError("cache.put only accepts GET requests");
      }
      if (response.headers.has("set-cookie")) return;
      const vary = response.headers.get("vary");
      if (vary === "*") {
        throw new TypeError("cache.put rejects Vary: *");
      }
      const cc = response.headers.get("cache-control") ?? "";
      if (/\b(?:private|no-store|no-cache)\b/i.test(cc)) return;
      const maxAgeMatch = /\bmax-age=(\d+)/i.exec(cc);
      const maxAge = maxAgeMatch ? Number(maxAgeMatch[1]) : 0;
      if (maxAge <= 0) return;

      // Materialize body to mimic independent streams across cache hits
      const bodyBytes = await response.clone().arrayBuffer();
      store.set(req.url, {
        response: new Response(bodyBytes, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        }),
        expiresAt: Date.now() + maxAge * 1000,
      });
    }),
    delete: vi.fn(async (input: RequestInfo | URL) => {
      const req = input instanceof Request ? input : new Request(String(input));
      return store.delete(req.url);
    }),
  };

  return {
    caches: {
      default: defaultCache,
      open: vi.fn(async () => defaultCache),
    } as unknown as CacheStorage,
    defaultCache,
    store,
  };
}

function createExecutionContext() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: vi.fn((promise: Promise<unknown>) => {
      pending.push(promise);
    }),
    passThroughOnException: vi.fn(),
    flush: async () => {
      await Promise.all(pending.splice(0));
    },
  };
  return ctx as unknown as ExecutionContext & { flush: () => Promise<void> };
}

async function createTestHarness() {
  const keyA = generateApiKeySecret();
  const keyB = generateApiKeySecret();
  const hashA = await sha256Hex(keyA.rawKey);
  const hashB = await sha256Hex(keyB.rawKey);

  const metaA: CachedKeyMetadata = {
    keyId: "key_cache_a",
    projectId: "prj_cache_a",
    ownerEpicId: "epic_owner_a",
    name: "Key A",
    tier: "free",
    active: true,
    scopes: ["catalog:read", "offers:read", "search:read"],
    allowedIps: [],
    allowedOrigins: [],
    allowedPaths: [],
    allowedMethods: ["GET", "HEAD", "POST"],
    customRpm: null,
    expiresAt: null,
  };

  const metaB: CachedKeyMetadata = {
    ...metaA,
    keyId: "key_cache_b",
    projectId: "prj_cache_b",
    ownerEpicId: "epic_owner_b",
    name: "Key B",
    tier: "pro",
  };

  const admitCalls: string[] = [];
  const usedByKey = new Map<string, number>();

  const env = {
    API_KEYS_KV: {
      get: vi.fn(async (k: string) => {
        if (k === `apikey:${hashA}`)
          return { ...metaA, cacheExpiresAt: Date.now() + 300_000 };
        if (k === `apikey:${hashB}`)
          return { ...metaB, cacheExpiresAt: Date.now() + 300_000 };
        return null;
      }),
      put: vi.fn(),
      delete: vi.fn(),
    },
    DB: {
      prepare: () => ({
        bind: () => ({ run: async () => ({}), first: async () => null }),
      }),
    },
    ANALYTICS: { writeDataPoint: vi.fn() },
    RATE_LIMITER_FREE: { limit: vi.fn(async () => ({ success: true })) },
    RATE_LIMITER_PRO: { limit: vi.fn(async () => ({ success: true })) },
    RATE_LIMITER_ENTERPRISE: { limit: vi.fn(async () => ({ success: true })) },
    RATE_LIMITER_DASHBOARD_API: {
      limit: vi.fn(async () => ({ success: true })),
    },
    API_KEY_RATE_LIMITER: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({
        admit: vi.fn(
          async (req: {
            keyId: string;
            policies: Array<{ name: string; limit: number }>;
          }) => {
            admitCalls.push(req.keyId);
            const count = (usedByKey.get(req.keyId) ?? 0) + 1;
            usedByKey.set(req.keyId, count);
            return {
              allowed: true,
              windowStart: Date.now(),
              resetAt: Date.now() + 60_000,
              retryAfter: 60,
              exhaustedPolicy: null,
              policies: req.policies.map((p: any) => ({
                name: p.name,
                limit: p.limit,
                used: count,
                remaining: Math.max(0, p.limit - count),
                resetAt: Date.now() + 60_000,
                window: p.window ?? "minute",
                windowSeconds: p.window === "month" ? 2_592_000 : 60,
              })),
            };
          },
        ),
      })),
    },
    UPSTREAM_API_ORIGIN: "https://origin-api.egdata.app",
    API_PROXY_HOST: "api.egdata.app",
    ORIGIN_AUTH_TOKEN: "origin-secret",
    DASHBOARD_ORIGIN: "https://devs.egdata.app",
    REQUIRE_API_KEY: "true",
    ALLOW_FIRST_PARTY_ORIGINS: "https://egdata.app",
    RATE_LIMIT_ENVIRONMENT: "test",
    ASSETS: { fetch: vi.fn() },
    EMAIL: { send: vi.fn() },
  } as unknown as DashboardEnv;

  return { env, keyA, keyB, metaA, metaB, admitCalls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Worker-level post-auth edge caching", () => {
  it("canonicalizes distinct query keys without reordering repeated values", () => {
    expect(canonicalSearchParams("?locale=en-US&country=US")).toBe(
      canonicalSearchParams("?country=US&locale=en-US"),
    );
    expect(canonicalSearchParams("?sortDir=asc&sortDir=desc")).not.toBe(
      canonicalSearchParams("?sortDir=desc&sortDir=asc"),
    );
  });

  it("does not fall back past an explicit CDN cache directive", () => {
    const response = (headers: Record<string, string>) =>
      new Response("{}", { status: 200, headers });

    expect(
      legacyResponseEdgeTtlSeconds(
        response({
          "Cache-Control": "public, max-age=60",
          "CDN-Cache-Control": "no-store",
        }),
      ),
    ).toBeNull();
    expect(
      legacyResponseEdgeTtlSeconds(
        response({
          "Cache-Control": "public, max-age=60",
          "CDN-Cache-Control": "public, max-age=300",
          "Cloudflare-CDN-Cache-Control": "no-store",
        }),
      ),
    ).toBeNull();
    expect(
      legacyResponseEdgeTtlSeconds(
        response({
          "Cache-Control": "public, max-age=60, s-maxage=300",
        }),
      ),
    ).toBe(300);
  });

  it("assigns tiered edge TTLs to v1 routes", () => {
    expect(v1EdgeCacheTtlSeconds("/v1/countries")).toBe(86_400);
    expect(v1EdgeCacheTtlSeconds("/v1/sitemap.xml")).toBe(3_600);
    expect(v1EdgeCacheTtlSeconds("/v1/offers/abc/og.webp")).toBe(3_600);
    expect(v1EdgeCacheTtlSeconds("/v1/offers/abc/hltb")).toBe(3_600);
    expect(v1EdgeCacheTtlSeconds("/v1/offers/abc/igdb")).toBe(3_600);
    expect(v1EdgeCacheTtlSeconds("/v1/offers/abc/requirements")).toBe(3_600);
    expect(v1EdgeCacheTtlSeconds("/v1/tags")).toBe(900);
    expect(v1EdgeCacheTtlSeconds("/v1/offers/abc/achievements")).toBe(900);
    expect(v1EdgeCacheTtlSeconds("/v1/offers/abc/builds")).toBe(900);
    expect(v1EdgeCacheTtlSeconds("/v1/offers/top-sellers")).toBe(300);
    expect(v1EdgeCacheTtlSeconds("/v1/offers")).toBe(300);
    expect(v1EdgeCacheTtlSeconds("/v1/search")).toBe(300);
    expect(v1EdgeCacheTtlSeconds("/v1/search/natural-language")).toBe(300);
    expect(v1EdgeCacheTtlSeconds("/v1/offers/abc")).toBe(60);
  });

  it("edge-caches POST /v1/search (303) and POST /v1/search/natural-language (200) by canonical body hash", async () => {
    const { caches, defaultCache } = createMockCacheStorage();
    vi.stubGlobal("caches", caches);

    const upstream = vi.fn(async (url: string, init?: RequestInit) => {
      const bodyText = init?.body ? await new Response(init.body).text() : "";
      if (url.endsWith("/v1/search")) {
        return new Response(null, {
          status: 303,
          headers: {
            Location: `https://devs.egdata.app/proxy/v1/search?q=${encodeURIComponent(bodyText)}`,
          },
        });
      }
      return new Response(
        JSON.stringify({ data: [{ query: bodyText }], meta: {} }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", upstream);

    const { env, keyA, keyB } = await createTestHarness();
    const ctx = createExecutionContext();

    // 1. POST /v1/search -> MISS, stores 303
    const s1 = await handleV1ApiProxy(
      new Request("https://api.egdata.app/v1/search", {
        method: "POST",
        headers: {
          "X-API-Key": keyA.rawKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "alan", offerType: "BASE_GAME" }),
      }),
      env,
      ctx,
      "/v1/search",
    );
    await ctx.flush();
    expect(s1.status).toBe(303);
    expect(defaultCache.put).toHaveBeenCalledTimes(1);

    // 2. Identical JSON with reordered keys -> HIT
    const s2 = await handleV1ApiProxy(
      new Request("https://api.egdata.app/v1/search", {
        method: "POST",
        headers: {
          "X-API-Key": keyB.rawKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ offerType: "BASE_GAME", title: "alan" }),
      }),
      env,
      ctx,
      "/v1/search",
    );
    expect(s2.status).toBe(303);
    expect(upstream).toHaveBeenCalledTimes(1);

    // 3. POST /v1/search/natural-language -> MISS then HIT
    const nl1 = await handleV1ApiProxy(
      new Request("https://api.egdata.app/v1/search/natural-language", {
        method: "POST",
        headers: {
          "X-API-Key": keyA.rawKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: "cozy farming game", topK: 5 }),
      }),
      env,
      ctx,
      "/v1/search/natural-language",
    );
    await ctx.flush();
    expect(nl1.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);

    const nl2 = await handleV1ApiProxy(
      new Request("https://api.egdata.app/v1/search/natural-language", {
        method: "POST",
        headers: {
          "X-API-Key": keyB.rawKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ topK: 5, query: "cozy farming game" }),
      }),
      env,
      ctx,
      "/v1/search/natural-language",
    );
    expect(nl2.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);

    const statuses = getLocalTelemetry()
      .slice(-4)
      .map((e) => e.cacheStatus);
    expect(statuses).toEqual(["MISS", "HIT", "MISS", "HIT"]);
  });

  it("bypasses POST cache for non-JSON Content-Type and returns 412 for conditional POST If-None-Match", async () => {
    const { caches, defaultCache } = createMockCacheStorage();
    vi.stubGlobal("caches", caches);

    const upstream = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (headers.get("content-type") !== "application/json") {
        return new Response(
          JSON.stringify({ code: "UNSUPPORTED_MEDIA_TYPE" }),
          {
            status: 415,
            headers: { "Content-Type": "application/problem+json" },
          },
        );
      }
      return new Response(JSON.stringify({ data: [{ ok: true }], meta: {} }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ETag: '"nl-etag-1"',
        },
      });
    });
    vi.stubGlobal("fetch", upstream);

    const { env, keyA, keyB } = await createTestHarness();
    const ctx = createExecutionContext();
    const body = JSON.stringify({ query: "cozy farming game", topK: 5 });

    // 1. Conditional POST on cache miss with matching If-None-Match -> warms cache, returns 412 (not 304)
    const conditionalMiss = await handleV1ApiProxy(
      new Request("https://api.egdata.app/v1/search/natural-language", {
        method: "POST",
        headers: {
          "X-API-Key": keyA.rawKey,
          "Content-Type": "application/json",
          "If-None-Match": '"nl-etag-1"',
        },
        body,
      }),
      env,
      ctx,
      "/v1/search/natural-language",
    );
    await ctx.flush();
    expect(conditionalMiss.status).toBe(412);
    expect(defaultCache.put).toHaveBeenCalledTimes(1);

    // 2. Conditional POST on cache hit with matching If-None-Match -> returns 412 (not 304)
    const conditionalHit = await handleV1ApiProxy(
      new Request("https://api.egdata.app/v1/search/natural-language", {
        method: "POST",
        headers: {
          "X-API-Key": keyB.rawKey,
          "Content-Type": "application/json",
          "If-None-Match": '"nl-etag-1"',
        },
        body,
      }),
      env,
      ctx,
      "/v1/search/natural-language",
    );
    expect(conditionalHit.status).toBe(412);
    expect(upstream).toHaveBeenCalledTimes(1);

    // 3. Non-JSON Content-Type with identical body bytes -> bypasses cache and hits origin (415)
    const nonJson = await handleV1ApiProxy(
      new Request("https://api.egdata.app/v1/search/natural-language", {
        method: "POST",
        headers: {
          "X-API-Key": keyB.rawKey,
          "Content-Type": "text/plain",
        },
        body,
      }),
      env,
      ctx,
      "/v1/search/natural-language",
    );
    expect(nonJson.status).toBe(415);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("caches v1 GET responses across keys after auth & quota admission while keeping per-request headers private", async () => {
    const { caches, defaultCache } = createMockCacheStorage();
    vi.stubGlobal("caches", caches);

    const upstream = vi.fn(async () => {
      return new Response(
        JSON.stringify({ data: { id: "offer_1" }, meta: {} }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "private, no-cache",
            "CDN-Cache-Control": "no-store",
            ETag: '"etag-offer-1"',
            "X-Request-Id": "req_origin_1",
          },
        },
      );
    });
    vi.stubGlobal("fetch", upstream);

    const { env, keyA, keyB, admitCalls } = await createTestHarness();
    const ctx = createExecutionContext();

    // 1. First request (Key A) -> MISS, populates cache
    const res1 = await handleV1ApiProxy(
      new Request(
        "https://api.egdata.app/v1/offers/offer_1?locale=en-US&country=US",
        {
          headers: {
            "X-API-Key": keyA.rawKey,
            Origin: "https://alpha.example",
          },
        },
      ),
      env,
      ctx,
      "/v1/offers/offer_1",
    );
    await ctx.flush();

    expect(res1.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(defaultCache.put).toHaveBeenCalledTimes(1);
    expect(res1.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(res1.headers.get("CDN-Cache-Control")).toBe("no-store");
    expect(res1.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://alpha.example",
    );
    expect(res1.headers.get("X-Egdata-Key-Tier")).toBe("free");

    // 2. Second request (Key B, reordered query params, different Origin) -> HIT without calling origin!
    const res2 = await handleV1ApiProxy(
      new Request(
        "https://api.egdata.app/v1/offers/offer_1?country=US&locale=en-US",
        {
          headers: {
            "X-API-Key": keyB.rawKey,
            Origin: "https://beta.example",
          },
        },
      ),
      env,
      ctx,
      "/v1/offers/offer_1",
    );

    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ data: { id: "offer_1" }, meta: {} });
    // Origin was NOT called a second time
    expect(upstream).toHaveBeenCalledTimes(1);
    // Quota admission STILL ran for both keys
    expect(admitCalls).toEqual(["key_cache_a", "key_cache_b"]);
    // Per-key and per-origin headers were freshly applied, never leaked from Key A
    expect(res2.headers.get("X-Egdata-Key-Tier")).toBe("pro");
    expect(res2.headers.get("RateLimit")).toContain("global;q=1200;r=1199");
    expect(res2.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://beta.example",
    );
    expect(res2.headers.get("X-Request-Id")).not.toBe(
      res1.headers.get("X-Request-Id"),
    );

    // 3. Conditional request with matching ETag -> 304 REVALIDATED from Worker cache!
    const res3 = await handleV1ApiProxy(
      new Request(
        "https://api.egdata.app/v1/offers/offer_1?country=US&locale=en-US",
        {
          headers: {
            "X-API-Key": keyB.rawKey,
            "If-None-Match": 'W/"etag-offer-1"',
          },
        },
      ),
      env,
      ctx,
      "/v1/offers/offer_1",
    );

    expect(res3.status).toBe(304);
    expect(await res3.text()).toBe("");
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(admitCalls).toEqual(["key_cache_a", "key_cache_b", "key_cache_b"]);

    const events = getLocalTelemetry().slice(-3);
    expect(events.map((e) => e.cacheStatus)).toEqual([
      "MISS",
      "HIT",
      "REVALIDATED",
    ]);
  });

  it("bypasses an existing edge entry for Range and If-Range requests", async () => {
    const { caches, defaultCache } = createMockCacheStorage();
    vi.stubGlobal("caches", caches);
    const forwardedRanges: Array<string | null> = [];
    const upstream = vi.fn(async (_url: string, init?: RequestInit) => {
      forwardedRanges.push(new Headers(init?.headers).get("range"));
      return new Response("full representation", {
        status: 200,
        headers: {
          "Content-Type": "text/plain",
          "Cache-Control": "private, no-cache",
          ETag: '"range-test"',
        },
      });
    });
    vi.stubGlobal("fetch", upstream);

    const { env, keyA } = await createTestHarness();
    const ctx = createExecutionContext();
    const url = "https://api.egdata.app/v1/offers/range-test";
    const call = (extra: Record<string, string> = {}) =>
      handleV1ApiProxy(
        new Request(url, { headers: { "X-API-Key": keyA.rawKey, ...extra } }),
        env,
        ctx,
        "/v1/offers/range-test",
      );

    await call();
    await ctx.flush();
    const matchCallsBeforeRange = defaultCache.match.mock.calls.length;
    const ranged = await call({ Range: "bytes=0-3" });
    expect(ranged.status).toBe(200);
    expect(defaultCache.match).toHaveBeenCalledTimes(matchCallsBeforeRange);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(forwardedRanges[1]).toBe("bytes=0-3");

    const matchCallsBeforeIfRange = defaultCache.match.mock.calls.length;
    await call({ "If-Range": '"range-test"' });
    expect(defaultCache.match).toHaveBeenCalledTimes(matchCallsBeforeIfRange);
    expect(upstream).toHaveBeenCalledTimes(3);

    const legacyUpstream = vi.fn(
      async () =>
        new Response("legacy representation", {
          status: 200,
          headers: {
            "Content-Type": "text/plain",
            "CDN-Cache-Control": "public, max-age=60",
          },
        }),
    );
    vi.stubGlobal("fetch", legacyUpstream);
    const legacyUrl = "https://api.egdata.app/offers/range-test";
    const legacyCall = (range?: string) =>
      handleEdgeApiProxy(
        new Request(legacyUrl, {
          headers: {
            "X-API-Key": keyA.rawKey,
            ...(range ? { Range: range } : {}),
          },
        }),
        env,
        ctx,
      );
    await legacyCall();
    await ctx.flush();
    const legacyMatchCallsBeforeRange = defaultCache.match.mock.calls.length;
    await legacyCall("bytes=0-3");
    expect(defaultCache.match).toHaveBeenCalledTimes(
      legacyMatchCallsBeforeRange,
    );
    expect(legacyUpstream).toHaveBeenCalledTimes(2);
  });

  it("never caches POST requests, error statuses, or no-store responses", async () => {
    const { caches, defaultCache } = createMockCacheStorage();
    vi.stubGlobal("caches", caches);

    let call = 0;
    const upstream = vi.fn(async () => {
      call++;
      if (call === 1) {
        return new Response(JSON.stringify({ data: [], meta: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ code: "NOT_FOUND" }), {
        status: 404,
        headers: { "Content-Type": "application/problem+json" },
      });
    });
    vi.stubGlobal("fetch", upstream);

    const { env, keyA } = await createTestHarness();
    const ctx = createExecutionContext();

    // POST /v1/offers/exists -> DYNAMIC, never stored
    await handleV1ApiProxy(
      new Request("https://api.egdata.app/v1/offers/exists", {
        method: "POST",
        headers: {
          "X-API-Key": keyA.rawKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ids: ["abc"] }),
      }),
      env,
      ctx,
      "/v1/offers/exists",
    );

    // 404 GET -> DYNAMIC, never stored
    await handleV1ApiProxy(
      new Request("https://api.egdata.app/v1/offers/missing", {
        headers: { "X-API-Key": keyA.rawKey },
      }),
      env,
      ctx,
      "/v1/offers/missing",
    );
    await ctx.flush();

    expect(defaultCache.put).not.toHaveBeenCalled();
    const statuses = getLocalTelemetry()
      .slice(-2)
      .map((e) => e.cacheStatus);
    expect(statuses).toEqual(["DYNAMIC", "DYNAMIC"]);
  });

  it("caches public legacy GET responses via Cache API while bypassing authenticated or private responses", async () => {
    const { caches, defaultCache } = createMockCacheStorage();
    vi.stubGlobal("caches", caches);

    const upstream = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (headers.has("authorization")) {
        return new Response(JSON.stringify({ user: "me" }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "private, no-store",
          },
        });
      }
      return new Response(JSON.stringify({ url }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=60, s-maxage=300",
          "CDN-Cache-Control": "public, max-age=300",
          "X-Route-Template": "/offers/{id}",
        },
      });
    });
    vi.stubGlobal("fetch", upstream);

    const { env, keyA, keyB } = await createTestHarness();
    const ctx = createExecutionContext();

    // First legacy GET -> MISS
    const first = await handleEdgeApiProxy(
      new Request("https://api.egdata.app/offers/12345?country=US", {
        headers: { "X-API-Key": keyA.rawKey, Origin: "https://one.example" },
      }),
      env,
      ctx,
    );
    await ctx.flush();
    expect(first.status).toBe(200);
    expect(defaultCache.put).toHaveBeenCalledTimes(1);

    // Second legacy GET with another key -> HIT from Worker cache
    const second = await handleEdgeApiProxy(
      new Request("https://api.egdata.app/offers/12345?country=US", {
        headers: { "X-API-Key": keyB.rawKey, Origin: "https://two.example" },
      }),
      env,
      ctx,
    );
    expect(second.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(second.headers.get("X-Egdata-Key-Tier")).toBe("pro");
    expect(second.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://two.example",
    );

    // Request carrying user JWT -> bypasses shared cache (DYNAMIC)
    const userReq = await handleEdgeApiProxy(
      new Request("https://api.egdata.app/offers/12345?country=US", {
        headers: {
          "X-API-Key": keyA.rawKey,
          Authorization: "Bearer user_jwt_token",
        },
      }),
      env,
      ctx,
    );
    expect(userReq.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);

    const legacyEvents = getLocalTelemetry().slice(-3);
    expect(legacyEvents.map((e) => e.cacheStatus)).toEqual([
      "MISS",
      "HIT",
      "DYNAMIC",
    ]);
  });
});
