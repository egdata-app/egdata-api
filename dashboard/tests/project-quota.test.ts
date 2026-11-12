import { afterEach, describe, expect, it, vi } from "vitest";
import { generateApiKeySecret, sha256Hex } from "../worker/crypto";
import { handleEdgeApiProxy } from "../worker/proxy";
import type { CachedKeyMetadata, DashboardEnv } from "../worker/types";
import { handleV1ApiProxy } from "../worker/v1";
import { quotaNamespace } from "./fixtures/quota";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function setup(customRpm = 2) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-12T12:00:10Z"));
  const metadata = new Map<string, CachedKeyMetadata>();
  const env = {
    API_KEY_RATE_LIMITER: quotaNamespace(),
    API_KEYS_KV: {
      get: async (hash: string) => ({
        ...metadata.get(hash),
        cacheExpiresAt: Date.now() + 300_000,
      }),
    },
    DB: { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) },
    ANALYTICS: { writeDataPoint: vi.fn() },
    UPSTREAM_API_ORIGIN: "https://origin-api.egdata.app",
    ORIGIN_AUTH_TOKEN: "test-token",
    RATE_LIMIT_ENVIRONMENT: "test",
    REQUIRE_API_KEY: "true",
  } as unknown as DashboardEnv;
  const upstream = vi.fn(
    async () =>
      new Response('{"ok":true}', {
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", upstream);
  const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
  async function key(projectId = "project-a") {
    const { rawKey } = generateApiKeySecret();
    const meta: CachedKeyMetadata = {
      keyId: crypto.randomUUID(),
      projectId,
      ownerEpicId: "owner",
      name: "Key",
      tier: "free",
      customRpm,
      active: true,
      scopes: ["catalog:read", "offers:read"],
      allowedIps: [],
      allowedOrigins: [],
      allowedPaths: [],
      allowedMethods: ["GET", "HEAD"],
      expiresAt: null,
    };
    metadata.set(`apikey:${await sha256Hex(rawKey)}`, meta);
    return { rawKey, meta };
  }
  const run = (rawKey: string, path = "/v1/countries") =>
    handleEdgeApiProxy(
      new Request(`https://devs.egdata.app${path}`, {
        headers: { "x-api-key": rawKey },
      }),
      env,
      ctx,
    );
  return { env, upstream, ctx, key, run };
}

describe("shared project quota gateways", () => {
  it("shares legacy and v1 allowance across keys, isolates projects, and resets on the UTC minute", async () => {
    const s = await setup();
    const first = await s.key();
    const second = await s.key();
    const other = await s.key("project-b");
    expect(
      (await s.run(first.rawKey, "/countries")).headers.get("RateLimit"),
    ).toContain("r=1");
    expect((await s.run(second.rawKey)).status).toBe(200);
    // A new key has no independent counter, even on the legacy gateway.
    const rotated = await s.key();
    const denied = await s.run(rotated.rawKey, "/countries");
    expect(denied.status).toBe(429);
    expect(denied.headers.get("Retry-After")).toBe("50");
    expect((await s.run(first.rawKey)).status).toBe(429);
    expect((await s.run(other.rawKey)).status).toBe(200);
    expect(s.upstream).toHaveBeenCalledTimes(3);
    vi.setSystemTime(new Date("2026-11-12T12:01:00Z"));
    expect((await s.run(rotated.rawKey)).status).toBe(200);
  });

  it("charges console sessions to the same project counter", async () => {
    const s = await setup(1);
    const { rawKey, meta } = await s.key();
    expect((await s.run(rawKey)).status).toBe(200);
    const response = await handleV1ApiProxy(
      new Request("https://devs.egdata.app/proxy/v1/countries"),
      s.env,
      s.ctx,
      "/v1/countries",
      { ...meta, keyId: `console_${meta.projectId}` },
    );
    expect(response.status).toBe(429);
    expect(s.upstream).toHaveBeenCalledOnce();
  });

  it("shares expensive-operation counters across keys without exhausting unrelated operations", async () => {
    const s = await setup(120);
    const first = await s.key();
    const second = await s.key();
    for (let index = 0; index < 5; index++) {
      expect(
        (await s.run(index % 2 ? first.rawKey : second.rawKey, "/v1/offers"))
          .status,
      ).toBe(200);
    }
    const denied = await s.run(second.rawKey, "/v1/offers");
    expect(denied.status).toBe(429);
    expect(denied.headers.get("X-RateLimit-Policy")).toBe("offers-list");
    expect((await s.run(first.rawKey)).status).toBe(200);
  });

  it.each([
    "/countries",
    "/v1/countries",
  ])("fails closed for unavailable or malformed quota decisions on %s", async (path) => {
    const s = await setup();
    const { rawKey } = await s.key();
    const admit = vi
      .fn()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce(null);
    s.env.API_KEY_RATE_LIMITER = {
      idFromName: (name: string) => name,
      get: () => ({ admit }),
    } as unknown as DashboardEnv["API_KEY_RATE_LIMITER"];
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await s.run(rawKey, path)).status).toBe(503);
    }
    expect(s.upstream).not.toHaveBeenCalled();
  });
});
