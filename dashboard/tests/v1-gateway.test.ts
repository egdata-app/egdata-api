import { describe, expect, it, vi } from "vitest";
import { generateApiKeySecret, sha256Hex } from "../worker/crypto";
import worker from "../worker/index";
import type { CachedKeyMetadata, DashboardEnv } from "../worker/types";
import { handleV1ApiProxy } from "../worker/v1";

const baseKey: CachedKeyMetadata = {
  keyId: "key_v1_test_1",
  projectId: "prj_test_1",
  ownerEpicId: "epic_user_1",
  name: "v1 test key",
  tier: "free",
  active: true,
  scopes: [
    "catalog:read",
    "offers:read",
    "items:read",
    "search:read",
    "stats:read",
    "builds:read",
  ],
  allowedIps: [],
  allowedOrigins: [],
  allowedPaths: [],
  allowedMethods: ["GET", "HEAD", "POST"],
  customRpm: null,
  expiresAt: null,
};

const readJson = async (response: Response): Promise<any> => response.json();

const ctx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

async function setup(
  overrides: Partial<CachedKeyMetadata> = {},
  options: {
    admit?: (request: {
      keyId: string;
      policies: Array<{ name: string; limit: number }>;
    }) => Promise<any>;
    dbDown?: boolean;
  } = {},
) {
  const { rawKey } = generateApiKeySecret();
  const keyHash = await sha256Hex(rawKey);
  const meta = { ...baseKey, ...overrides };
  const admitCalls: Array<{
    keyId: string;
    policies: Array<{ name: string; limit: number }>;
  }> = [];

  const admit = vi.fn(async (request: any) => {
    admitCalls.push(request);
    if (options.dbDown) throw new Error("DO unavailable");
    if (options.admit) return options.admit(request);
    return {
      allowed: true,
      windowStart: Date.now(),
      resetAt: Date.now() + 60_000,
      retryAfter: 60,
      exhaustedPolicy: null,
      policies: request.policies.map((policy: any) => ({
        name: policy.name,
        limit: policy.limit,
        used: 1,
        remaining: policy.limit - 1,
        resetAt: Date.now() + 60_000,
        window: policy.window ?? "minute",
        windowSeconds: policy.window === "month" ? 2_592_000 : 60,
      })),
    };
  });

  const env = {
    API_KEYS_KV: {
      get: vi.fn(async (key: string) => {
        if (key === `apikey:${keyHash}`)
          return { ...meta, cacheExpiresAt: Date.now() + 300_000 };
        return null;
      }),
      put: vi.fn(),
      delete: vi.fn(),
    },
    DB: {
      prepare: () => ({
        bind: () => ({
          run: async () => ({}),
          first: async () => null,
        }),
      }),
    },
    ANALYTICS: { writeDataPoint: vi.fn() },
    API_KEY_RATE_LIMITER: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ admit })),
    },
    UPSTREAM_API_ORIGIN: "https://origin-api.egdata.app",
    API_PROXY_HOST: "api.egdata.app",
    ORIGIN_AUTH_TOKEN: "origin-token",
    RATE_LIMIT_ENVIRONMENT: "test",
    REQUIRE_API_KEY: "false",
    ALLOW_FIRST_PARTY_ORIGINS: "https://egdata.app",
    ASSETS: { fetch: vi.fn() },
    EMAIL: { send: vi.fn() },
  } as unknown as DashboardEnv;

  return { env, rawKey, meta, admit, admitCalls };
}

function mockUpstream(status = 200) {
  return vi.fn(async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    return new Response(
      JSON.stringify({
        ok: true,
        url,
        keyId: headers.get("x-egdata-key-id"),
        requestId: headers.get("x-egdata-request-id"),
        workerToken: headers.get("x-egdata-worker-token"),
        apiKey: headers.get("x-api-key"),
        cookie: headers.get("cookie"),
        authorization: headers.get("authorization"),
      }),
      { status, headers: { "Content-Type": "application/json" } },
    );
  });
}

describe("v1 Worker gateway", () => {
  it("handles immutable upstream headers for public health and the deployed contract", async () => {
    const { env, admit } = await setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.redirect("https://origin-api.egdata.app/v1/health", 302),
      ),
    );
    for (const path of ["/v1/health", "/v1/open-api.json"]) {
      const result = await handleV1ApiProxy(
        new Request(`https://devs.egdata.app/proxy${path}`),
        env,
        ctx,
        path,
      );
      expect(result.status).toBe(302);
      expect(result.headers.get("X-Request-Id")).toMatch(/^req_/);
      expect(result.headers.get("Location")).toBe(
        "https://origin-api.egdata.app/v1/health",
      );
    }
    expect(admit).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it("attaches exact operation usage to the existing admission RPC, including failed responses", async () => {
    const { env, rawKey, admit } = await setup();
    env.USAGE_TRACKING_ENABLED = "true";
    vi.stubGlobal("fetch", mockUpstream(500));
    const response = await handleV1ApiProxy(
      new Request("https://devs.egdata.app/proxy/v1/offers/abc", {
        headers: { "X-API-Key": rawKey },
      }),
      env,
      ctx,
      "/v1/offers/abc",
    );
    expect(response.status).toBe(500);
    expect(admit).toHaveBeenCalledOnce();
    expect(admit).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: { projectId: baseKey.projectId, operationId: "getOffer" },
      }),
    );
    expect(JSON.stringify(admit.mock.calls)).not.toContain(rawKey);
    vi.unstubAllGlobals();
  });
  it("excludes preflights, unknown paths and permission failures from usage admission", async () => {
    const { env, rawKey, admit } = await setup({ scopes: ["items:read"] });
    env.USAGE_TRACKING_ENABLED = "true";
    for (const [path, method] of [
      ["/v1/offers/abc", "OPTIONS"],
      ["/v1/not-registered", "GET"],
      ["/v1/offers/abc", "GET"],
    ]) {
      await handleV1ApiProxy(
        new Request(`https://devs.egdata.app/proxy${path}`, {
          method,
          headers: { "X-API-Key": rawKey },
        }),
        env,
        ctx,
        path,
      );
    }
    expect(admit).not.toHaveBeenCalled();
  });
  it("is exposed at devs.egdata.app/proxy/v1", async () => {
    const { env, rawKey } = await setup();
    const upstream = mockUpstream();
    vi.stubGlobal("fetch", upstream);

    const response = await worker.fetch(
      new Request("https://devs.egdata.app/proxy/v1/countries", {
        headers: { "X-API-Key": rawKey },
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledWith(
      "https://origin-api.egdata.app/v1/countries",
      expect.anything(),
    );
    vi.unstubAllGlobals();
  });

  it("requires an API key for every v1 data operation", async () => {
    const { env, admit } = await setup();
    const res = await handleV1ApiProxy(
      new Request("https://devs.egdata.app/proxy/v1/countries"),
      env,
      ctx,
      "/v1/countries",
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    const body = await readJson(res);
    expect(body.code).toBe("MISSING_API_KEY");
    expect(body.requestId).toMatch(/^req_/);
    expect(admit).not.toHaveBeenCalled();
  });

  it("requires an API key before exposing a method mismatch", async () => {
    const { env, admit } = await setup();
    const anonymous = await handleV1ApiProxy(
      new Request("https://devs.egdata.app/proxy/v1/countries", {
        method: "POST",
      }),
      env,
      ctx,
      "/v1/countries",
    );
    expect(anonymous.status).toBe(401);
    expect(admit).not.toHaveBeenCalled();
  });

  it("authenticates, admits once, and forwards trusted provenance with Worker quota headers", async () => {
    const { env, rawKey, admitCalls, meta } = await setup();
    const upstream = mockUpstream();
    vi.stubGlobal("fetch", upstream);

    const res = await handleV1ApiProxy(
      new Request("https://devs.egdata.app/proxy/v1/countries", {
        headers: {
          "X-API-Key": rawKey,
          Cookie: "EGDATA_COUNTRY=GB",
          "X-Egdata-Key-Id": "key_spoofed",
          "X-Egdata-Key-Tier": "enterprise",
          "X-Egdata-Worker-Token": "spoofed",
        },
      }),
      env,
      ctx,
      "/v1/countries",
    );

    expect(res.status).toBe(200);
    expect(admitCalls).toHaveLength(1);
    expect(admitCalls[0].keyId).toBe(meta.keyId);
    expect(admitCalls[0].policies).toEqual([
      { name: "global", limit: 120, window: "minute" },
      { name: "monthly", limit: 100_000, window: "month" },
    ]);
    expect(env.API_KEY_RATE_LIMITER.idFromName).toHaveBeenCalledWith(
      `account:test:${meta.ownerEpicId}`,
    );
    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe("https://origin-api.egdata.app/v1/countries");
    const sent = new Headers(init?.headers);
    expect(sent.get("x-api-key")).toBeNull();
    expect(sent.get("cookie")).toBeNull();
    expect(sent.get("x-egdata-key-id")).toBe(meta.keyId);
    expect(sent.get("x-egdata-key-tier")).toBe("free");
    expect(sent.get("x-egdata-worker-token")).toBe("origin-token");
    expect(sent.get("x-egdata-request-id")).toMatch(/^req_/);
    expect(res.headers.get("X-Request-Id")).toMatch(/^req_/);
    expect(res.headers.get("RateLimit")).toContain("global;q=120;r=119");
    expect(res.headers.get("RateLimit-Policy")).toContain("global;q=120;w=60");
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(res.headers.get("CDN-Cache-Control")).toBe("no-store");
    vi.unstubAllGlobals();
  });

  it("rejects conflicting credentials and accept Bearer keys", async () => {
    const { env, rawKey } = await setup();
    const conflict = await handleV1ApiProxy(
      new Request("https://devs.egdata.app/proxy/v1/countries", {
        headers: {
          "X-API-Key": rawKey,
          Authorization: "Bearer a-different-key",
        },
      }),
      env,
      ctx,
      "/v1/countries",
    );
    expect(conflict.status).toBe(401);
    expect((await readJson(conflict)).code).toBe("CONFLICTING_CREDENTIALS");

    const upstream = mockUpstream();
    vi.stubGlobal("fetch", upstream);
    const bearered = await handleV1ApiProxy(
      new Request("https://devs.egdata.app/proxy/v1/countries", {
        headers: { Authorization: `Bearer ${rawKey}` },
      }),
      env,
      ctx,
      "/v1/countries",
    );
    expect(bearered.status).toBe(200);
    vi.unstubAllGlobals();
  });

  it("returns 429 Problem Details and never calls the origin when the global quota is exhausted", async () => {
    const { env, rawKey } = await setup(
      {},
      {
        admit: async (request) => ({
          allowed: false,
          windowStart: Date.now(),
          resetAt: Date.now() + 42_000,
          retryAfter: 42,
          exhaustedPolicy: "global",
          policies: request.policies.map((policy: any) => ({
            name: policy.name,
            limit: policy.limit,
            used: policy.limit,
            remaining: 0,
            resetAt: Date.now() + 42_000,
            window: policy.window ?? "minute",
            windowSeconds: policy.window === "month" ? 2_592_000 : 60,
          })),
        }),
      },
    );
    const upstream = mockUpstream();
    vi.stubGlobal("fetch", upstream);

    const res = await handleV1ApiProxy(
      new Request("https://devs.egdata.app/proxy/v1/countries", {
        headers: { "X-API-Key": rawKey },
      }),
      env,
      ctx,
      "/v1/countries",
    );

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(res.headers.get("X-RateLimit-Policy")).toBe("global");
    expect(res.headers.get("RateLimit")).toContain("r=0");
    expect((await readJson(res)).code).toBe("RATE_LIMITED");
    expect(upstream).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("combines the global and expensive-operation policies in one RPC", async () => {
    const { env, rawKey, admitCalls } = await setup();
    vi.stubGlobal("fetch", mockUpstream());
    await handleV1ApiProxy(
      new Request("https://devs.egdata.app/proxy/v1/offers/search-stub", {
        headers: { "X-API-Key": rawKey },
      }),
      env,
      ctx,
      "/v1/offers", // operation listOffers applies the offers-list policy
    );
    expect(admitCalls[0].policies).toEqual([
      { name: "global", limit: 120, window: "minute" },
      { name: "monthly", limit: 100_000, window: "month" },
      { name: "offers-list", limit: 5 },
    ]);
    vi.unstubAllGlobals();
  });

  it("uses customRpm when it is valid", async () => {
    const { env, rawKey, admitCalls } = await setup({ customRpm: 450 });
    vi.stubGlobal("fetch", mockUpstream());
    await handleV1ApiProxy(
      new Request("https://devs.egdata.app/proxy/v1/countries", {
        headers: { "X-API-Key": rawKey },
      }),
      env,
      ctx,
      "/v1/countries",
    );
    expect(admitCalls[0].policies).toEqual([
      { name: "global", limit: 450, window: "minute" },
      { name: "monthly", limit: 100_000, window: "month" },
    ]);
    vi.unstubAllGlobals();
  });

  it("returns retryable 503 without a fallback when the quota RPC fails", async () => {
    const { env, rawKey } = await setup({}, { dbDown: true });
    const upstream = mockUpstream();
    vi.stubGlobal("fetch", upstream);
    const res = await handleV1ApiProxy(
      new Request("https://devs.egdata.app/proxy/v1/countries", {
        headers: { "X-API-Key": rawKey },
      }),
      env,
      ctx,
      "/v1/countries",
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("1");
    expect((await readJson(res)).code).toBe("QUOTA_UNAVAILABLE");
    expect(upstream).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("keeps public metadata and preflights unauthenticated and out of the limiter", async () => {
    const { env, admit } = await setup();
    const upstream = mockUpstream();
    vi.stubGlobal("fetch", upstream);

    const health = await handleV1ApiProxy(
      new Request("https://devs.egdata.app/proxy/v1/health"),
      env,
      ctx,
      "/v1/health",
    );
    expect(health.status).toBe(200);
    expect(admit).not.toHaveBeenCalled();

    const preflight = await handleV1ApiProxy(
      new Request("https://devs.egdata.app/proxy/v1/countries", {
        method: "OPTIONS",
        headers: { Origin: "https://client.example" },
      }),
      env,
      ctx,
      "/v1/countries",
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://client.example",
    );
    expect(admit).not.toHaveBeenCalled();
    expect(upstream).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("evaluates legacy path grants against /v1 and maps scopes explicitly", async () => {
    const { env, rawKey } = await setup({ allowedPaths: ["/offers/*"] });
    const denied = await handleV1ApiProxy(
      new Request("https://devs.egdata.app/proxy/v1/offers", {
        headers: { "X-API-Key": rawKey },
      }),
      env,
      ctx,
      "/v1/offers",
    );
    expect(denied.status).toBe(403);
    expect((await readJson(denied)).code).toBe("PATH_DENIED");
  });

  it("rejects an API key without the operation scope", async () => {
    const { env, rawKey } = await setup({ scopes: ["offers:read"] });
    const res = await handleV1ApiProxy(
      new Request("https://devs.egdata.app/proxy/v1/items", {
        headers: { "X-API-Key": rawKey },
      }),
      env,
      ctx,
      "/v1/items",
    );
    expect(res.status).toBe(403);
    expect((await readJson(res)).code).toBe("SCOPE_DENIED");
  });

  it("rejects encoded path bypasses and unknown v1 paths without quota calls", async () => {
    const { env, rawKey, admit } = await setup();
    const encoded = await handleV1ApiProxy(
      new Request("https://devs.egdata.app/proxy/v1/offers%2F..%2Fadmin"),
      env,
      ctx,
      "/v1/offers%2F..%2Fadmin",
    );
    expect(encoded.status).toBe(400);

    const unknown = await handleV1ApiProxy(
      new Request("https://devs.egdata.app/proxy/v1/not-real", {
        headers: { "X-API-Key": rawKey },
      }),
      env,
      ctx,
      "/v1/not-real",
    );
    expect(unknown.status).toBe(404);
    expect(admit).not.toHaveBeenCalled();
  });
});
