import { afterEach, describe, expect, it, vi } from "vitest";
import { UNATTRIBUTED_LEGACY_ID } from "../worker/analytics-types";
import worker from "../worker/index";
import type { CachedKeyMetadata, DashboardEnv } from "../worker/types";
import { quotaNamespace } from "./fixtures/quota";

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
function environment(overrides: Partial<DashboardEnv> = {}) {
  const writeDataPoint = vi.fn();
  const env = {
    UPSTREAM_API_ORIGIN: "https://origin-api.egdata.app",
    API_PROXY_HOST: "api.egdata.app",
    ORIGIN_AUTH_TOKEN: "test-origin-token",
    REQUIRE_API_KEY: "false",
    ALLOW_FIRST_PARTY_ORIGINS: "https://egdata.app",
    ANALYTICS: { writeDataPoint },
    API_KEYS_KV: { get: vi.fn(async () => null) },
    DB: {
      prepare: () => ({
        bind: () => ({ first: async () => null, run: async () => ({}) }),
      }),
    },
    RATE_LIMITER_FREE: { limit: vi.fn(async () => ({ success: true })) },
    ASSETS: { fetch: vi.fn(async () => new Response("dashboard")) },
    ...overrides,
  } as unknown as DashboardEnv;
  return { env, writeDataPoint };
}
afterEach(() => vi.unstubAllGlobals());

describe("legacy gateway telemetry", () => {
  it.each([
    ["/offers/0123456789abcdef01234567?country=ES", "GET", "false", ""],
    ["/offers/0123456789abcdef01234567", "HEAD", "false", ""],
    ["/graphql", "POST", "false", ""],
    ["/free-games", "GET", "true", "https://egdata.app"],
    ["/offers/123", "OPTIONS", "true", "https://example.com"],
    ["/health", "GET", "true", ""],
    ["/ping", "GET", "true", ""],
    ["/robots.txt", "GET", "true", ""],
    ["/open-api.json", "GET", "true", ""],
    ["/ui", "GET", "true", ""],
    ["/auth/callback?code=secret", "GET", "true", ""],
    ["/items-sitemap.xml", "GET", "true", ""],
  ])("records bypassed %s %s exactly once", async (path, method, requireKey, origin) => {
    const { env, writeDataPoint } = environment({
      REQUIRE_API_KEY: requireKey,
    });
    const response = new Response(null, {
      headers: { ETag: '"unchanged"', "CF-Cache-Status": "HIT" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    const result = await worker.fetch(
      new Request(`https://api.egdata.app${path}`, {
        method,
        headers: {
          ...(origin ? { origin } : {}),
          "cf-connecting-ip": "192.0.2.4",
          "user-agent": "Legacy client",
          "x-egdata-key-project": "spoofed-project",
        },
      }),
      env,
      ctx,
    );
    expect(result).toBe(response);
    expect(result.headers.get("etag")).toBe('"unchanged"');
    expect(writeDataPoint).toHaveBeenCalledOnce();
    const point = writeDataPoint.mock.calls[0][0];
    expect(point.indexes).toEqual([UNATTRIBUTED_LEGACY_ID]);
    expect(point.blobs).toEqual([
      UNATTRIBUTED_LEGACY_ID,
      UNATTRIBUTED_LEGACY_ID,
      path.split("?")[0].replace("0123456789abcdef01234567", "{id}"),
      method,
      "200",
      "HIT",
      "ok",
      origin ? "(present)" : "(direct)",
      "",
      "other",
      "XX",
      "privacy-v1",
    ]);
    expect(point.doubles).toEqual([1, expect.any(Number), 0, 1, 0]);
    expect(env.API_KEYS_KV.get).not.toHaveBeenCalled();
    expect(env.RATE_LIMITER_FREE.limit).not.toHaveBeenCalled();
  });

  it("uses origin route templates, strips the local proxy prefix, and preserves conditional responses", async () => {
    const { env, writeDataPoint } = environment();
    const response = new Response(null, {
      status: 304,
      headers: { "X-Route-Template": "/offers/{id}", ETag: '"etag"' },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    expect(
      await worker.fetch(
        new Request("http://localhost:4002/proxy/offers/slug?secret=omitted"),
        env,
        ctx,
      ),
    ).toBe(response);
    expect(writeDataPoint).toHaveBeenCalledOnce();
    expect(writeDataPoint.mock.calls[0][0].blobs.slice(2, 7)).toEqual([
      "/offers/{id}",
      "GET",
      "304",
      "REVALIDATED",
      "ok",
    ]);
  });

  it.each([
    false,
    true,
  ])("records missing or invalid key denials (key supplied: %s)", async (hasKey) => {
    const { env, writeDataPoint } = environment({ REQUIRE_API_KEY: "true" });
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const response = await worker.fetch(
      new Request("https://api.egdata.app/offers/123", {
        headers: hasKey ? { "x-api-key": "egk_invalid-legacy-analytics" } : {},
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
    expect(writeDataPoint).toHaveBeenCalledOnce();
    const point = writeDataPoint.mock.calls[0][0];
    expect(point.indexes).toEqual([UNATTRIBUTED_LEGACY_ID]);
    expect(point.blobs.slice(4, 7)).toEqual([
      "401",
      "EDGE_BLOCK",
      hasKey ? "invalid_api_key" : "missing_api_key",
    ]);
  });

  it.each([
    404, 429, 500, 502, 503,
  ])("records upstream HTTP %s and connection/configuration errors", async (status) => {
    const { env, writeDataPoint } = environment(
      status === 503 ? { ORIGIN_AUTH_TOKEN: "" } : {},
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (status === 502) throw new Error("connection failed");
        return new Response("upstream error", { status });
      }),
    );
    const response = await worker.fetch(
      new Request("https://api.egdata.app/offers/123"),
      env,
      ctx,
    );
    expect(response.status).toBe(status);
    expect(writeDataPoint).toHaveBeenCalledOnce();
    const point = writeDataPoint.mock.calls[0][0];
    expect(point.blobs[4]).toBe(String(status));
    expect(point.doubles.slice(2)).toEqual([status === 429 ? 1 : 0, 0, 1]);
  });

  it.each([
    "allowed",
    "policy",
    "quota",
  ])("retains verified-key attribution without double counting: %s", async (outcome) => {
    const meta: CachedKeyMetadata = {
      keyId: "key_legacy_analytics",
      projectId: "prj_legacy_analytics",
      ownerEpicId: "alice",
      name: "Legacy key",
      tier: "free",
      active: true,
      scopes: ["offers:read"],
      allowedIps: [],
      allowedOrigins: [],
      allowedPaths: [],
      allowedMethods: outcome === "policy" ? ["POST"] : ["GET"],
      customRpm: 1,
      expiresAt: null,
    };
    const namespace = quotaNamespace();
    if (outcome === "quota") {
      await namespace.get(`account:production:${meta.ownerEpicId}`).admit({
        keyId: meta.keyId,
        projectId: meta.projectId,
        ownerEpicId: meta.ownerEpicId,
        policies: [{ name: "global", limit: 1 }],
      });
    }
    const { env, writeDataPoint } = environment({
      API_KEYS_KV: {
        get: vi.fn(async () => ({
          ...meta,
          cacheExpiresAt: Date.now() + 60_000,
        })),
      } as unknown as KVNamespace,
      API_KEY_RATE_LIMITER:
        namespace as unknown as DashboardEnv["API_KEY_RATE_LIMITER"],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok")),
    );
    const response = await worker.fetch(
      new Request("https://api.egdata.app/offers/123", {
        headers: { "x-api-key": `egk_legacy_analytics_${outcome}` },
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(
      outcome === "policy" ? 403 : outcome === "quota" ? 429 : 200,
    );
    expect(writeDataPoint).toHaveBeenCalledOnce();
    expect(writeDataPoint.mock.calls[0][0].indexes).toEqual(["alice"]);
    expect(writeDataPoint.mock.calls[0][0].blobs.slice(0, 2)).toEqual([
      meta.keyId,
      meta.projectId,
    ]);
  });

  it("does not record dashboard assets as legacy API hits and tolerates unavailable analytics", async () => {
    const { env, writeDataPoint } = environment();
    await worker.fetch(
      new Request("https://devs.egdata.app/analytics"),
      env,
      ctx,
    );
    expect(writeDataPoint).not.toHaveBeenCalled();
    writeDataPoint.mockImplementation(() => {
      throw new Error("analytics unavailable");
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok")),
    );
    const response = await worker.fetch(
      new Request("https://api.egdata.app/free-games"),
      env,
      ctx,
    );
    expect(await response.text()).toBe("ok");
  });
});
