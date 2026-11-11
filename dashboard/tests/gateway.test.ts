import { describe, expect, it, vi } from "vitest";
import {
  generateApiKeySecret,
  sha256Hex,
  signHmacToken,
  verifyHmacToken,
} from "../worker/crypto";
import {
  evaluateKeyPermissions,
  ipMatchesRule,
  isValidIpOrCidr,
  originMatchesPattern,
  pathMatchesPattern,
} from "../worker/permissions";
import { handleEdgeApiProxy } from "../worker/proxy";
import type { CachedKeyMetadata, DashboardEnv } from "../worker/types";

const baseKeyMeta: CachedKeyMetadata = {
  keyId: "key_test_1",
  projectId: "prj_test_1",
  ownerEpicId: "epic_user_1",
  name: "Test Key",
  tier: "free",
  active: true,
  scopes: ["offers:read", "search:read"],
  allowedIps: [],
  allowedOrigins: [],
  allowedPaths: [],
  allowedMethods: ["GET", "HEAD"],
  customRpm: null,
  expiresAt: null,
};

describe("IP/CIDR, Origin, Path, and Scope permission rules", () => {
  it("validates IPv4 and IPv6 addresses and CIDR ranges", () => {
    expect(isValidIpOrCidr("203.0.113.42")).toBe(true);
    expect(isValidIpOrCidr("203.0.113.0/24")).toBe(true);
    expect(isValidIpOrCidr("2001:db8::/32")).toBe(true);
    expect(isValidIpOrCidr("999.0.0.1")).toBe(false);
    expect(isValidIpOrCidr("203.0.113.0/33")).toBe(false);
  });

  it("matches client IPs against IPv4 and IPv6 CIDR blocks", () => {
    expect(ipMatchesRule("203.0.113.199", "203.0.113.0/24")).toBe(true);
    expect(ipMatchesRule("203.0.114.1", "203.0.113.0/24")).toBe(false);
    expect(ipMatchesRule("2001:db8:0:1::5", "2001:db8::/32")).toBe(true);
    expect(ipMatchesRule("2001:db9::1", "2001:db8::/32")).toBe(false);
  });

  it("matches exact and wildcard subdomain origins", () => {
    expect(
      originMatchesPattern("https://egdata.app", "https://egdata.app"),
    ).toBe(true);
    expect(
      originMatchesPattern("https://sub.myapp.dev", "https://*.myapp.dev"),
    ).toBe(true);
    expect(
      originMatchesPattern("http://sub.myapp.dev", "https://*.myapp.dev"),
    ).toBe(false);
    expect(
      originMatchesPattern("https://evilmyapp.dev", "https://*.myapp.dev"),
    ).toBe(false);
  });

  it("matches exact and glob endpoint paths", () => {
    expect(pathMatchesPattern("/offers/123", "/offers/*")).toBe(true);
    expect(pathMatchesPattern("/offers", "/offers/*")).toBe(true);
    expect(pathMatchesPattern("/items/123", "/offers/*")).toBe(false);
  });

  it("enforces IP, Origin, Method, and Scope policies accurately", () => {
    const restricted: CachedKeyMetadata = {
      ...baseKeyMeta,
      allowedIps: ["198.51.100.0/24"],
      allowedOrigins: ["https://*.example.com"],
      allowedPaths: ["/offers/*"],
      scopes: ["offers:read"],
    };

    expect(
      evaluateKeyPermissions(restricted, {
        method: "GET",
        pathname: "/offers/top-sellers",
        clientIp: "198.51.100.12",
        origin: "https://app.example.com",
      }).allowed,
    ).toBe(true);

    expect(
      evaluateKeyPermissions(restricted, {
        method: "GET",
        pathname: "/offers/top-sellers",
        clientIp: "203.0.113.5",
        origin: "https://app.example.com",
      }).reason,
    ).toBe("ip_denied");

    expect(
      evaluateKeyPermissions(restricted, {
        method: "GET",
        pathname: "/offers/top-sellers",
        clientIp: "198.51.100.12",
        origin: "https://attacker.dev",
      }).reason,
    ).toBe("origin_denied");

    expect(
      evaluateKeyPermissions(restricted, {
        method: "POST",
        pathname: "/offers/top-sellers",
        clientIp: "198.51.100.12",
        origin: "https://app.example.com",
      }).reason,
    ).toBe("method_denied");

    expect(
      evaluateKeyPermissions(
        { ...restricted, allowedPaths: [] },
        {
          method: "GET",
          pathname: "/items/abc",
          clientIp: "198.51.100.12",
          origin: "https://app.example.com",
        },
      ).reason,
    ).toBe("scope_denied");
  });
});

describe("HMAC session tokens and API key proxy cache preservation", () => {
  it("signs and verifies HMAC tokens and rejects tampered tokens", async () => {
    const token = await signHmacToken(
      { sub: "epic_123", exp: Date.now() + 60_000 },
      "secret-key-123456",
    );
    const verified = await verifyHmacToken<{ sub: string }>(
      token,
      "secret-key-123456",
    );
    expect(verified?.sub).toBe("epic_123");

    const tampered = await verifyHmacToken(`${token}x`, "secret-key-123456");
    expect(tampered).toBeNull();
  });

  it("rejects missing keys at edge and strips X-API-Key before upstream fetch so Cloudflare Cache is shared", async () => {
    const { rawKey } = generateApiKeySecret();
    const keyHash = await sha256Hex(rawKey);
    const kvMap = new Map<string, string>([
      [`apikey:${keyHash}`, JSON.stringify(baseKeyMeta)],
    ]);

    const seenUpstreamHeaders: Headers[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        seenUpstreamHeaders.push(new Headers(init?.headers));
        return new Response(JSON.stringify({ ok: true, url: String(input) }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "CF-Cache-Status": "HIT",
            "X-Route-Template": "/offers/{id}",
            ETag: '"abc123"',
          },
        });
      },
    ) as typeof fetch;

    try {
      const mockEnv = {
        API_KEYS_KV: {
          get: vi.fn(async (k: string) => {
            const raw = kvMap.get(k);
            return raw ? JSON.parse(raw) : null;
          }),
          put: vi.fn(),
          delete: vi.fn(),
        } as unknown as KVNamespace,
        DB: {
          prepare: () => ({
            bind: () => ({ run: async () => ({}), first: async () => null }),
          }),
        } as unknown as D1Database,
        ANALYTICS: {
          writeDataPoint: vi.fn(),
        } as unknown as AnalyticsEngineDataset,
        RATE_LIMITER_FREE: {
          limit: vi.fn(async () => ({ success: true })),
        } as unknown as RateLimit,
        RATE_LIMITER_PRO: {
          limit: vi.fn(async () => ({ success: true })),
        } as unknown as RateLimit,
        RATE_LIMITER_ENTERPRISE: {
          limit: vi.fn(async () => ({ success: true })),
        } as unknown as RateLimit,
        EMAIL: { send: vi.fn() } as unknown as SendEmail,
        ASSETS: { fetch: vi.fn() } as unknown as Fetcher,
        UPSTREAM_API_ORIGIN: "https://origin-api.egdata.app",
        ORIGIN_AUTH_TOKEN: "test-origin-token",
        API_PROXY_HOST: "api.egdata.app",
        DASHBOARD_ORIGIN: "https://developers.egdata.app",
        ADMIN_EMAIL: "admin@egdata.app",
        EMAIL_FROM_ADDRESS: "noreply@egdata.app",
        EMAIL_FROM_NAME: "egdata Developer Portal",
        REQUIRE_API_KEY: "true",
        RATE_LIMIT_ENVIRONMENT: "test",
        USAGE_TRACKING_ENABLED: "false",
        USAGE_TRACKING_STARTED_AT: "",
        ENDPOINT_USAGE_QUEUE: { sendBatch: vi.fn() } as unknown as Queue,
        ALLOW_FIRST_PARTY_ORIGINS: "https://egdata.app",
        API_KEY_RATE_LIMITER: {
          idFromName: vi.fn((name: string) => name),
          get: vi.fn(() => ({
            admit: vi.fn(async () => ({
              allowed: true,
              windowStart: Date.now(),
              resetAt: Date.now() + 60_000,
              retryAfter: 60,
              exhaustedPolicy: null,
              policies: [],
            })),
          })),
        } as unknown as DashboardEnv["API_KEY_RATE_LIMITER"],
      } satisfies DashboardEnv;

      const ctx = {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext;

      // 1. Unauthenticated request without first-party origin -> 401 at edge (no upstream fetch!)
      const unauthRes = await handleEdgeApiProxy(
        new Request("https://api.egdata.app/offers/12345"),
        mockEnv,
        ctx,
      );
      expect(unauthRes.status).toBe(401);
      expect(unauthRes.headers.get("Cache-Control")).toContain("no-store");
      expect(seenUpstreamHeaders.length).toBe(0);

      // 2. Authenticated request -> forwards upstream WITHOUT x-api-key header, preserving ETag
      const validRes = await handleEdgeApiProxy(
        new Request("https://api.egdata.app/offers/12345", {
          headers: {
            "X-API-Key": rawKey,
            "If-None-Match": '"abc123"',
          },
        }),
        mockEnv,
        ctx,
      );
      expect(validRes.status).toBe(200);
      expect(validRes.headers.get("ETag")).toBe('"abc123"');
      expect(validRes.headers.get("X-Egdata-Key-Tier")).toBe("free");
      expect(seenUpstreamHeaders.length).toBe(1);
      expect(seenUpstreamHeaders[0].has("x-api-key")).toBe(false);
      expect(seenUpstreamHeaders[0].get("if-none-match")).toBe('"abc123"');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
