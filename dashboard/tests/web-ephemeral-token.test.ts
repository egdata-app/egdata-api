import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../worker/index";
import type { DashboardEnv } from "../worker/types";
import {
  clearWebOwnerEpicIdCache,
  computeIpSubnet,
  handleV1ApiProxy,
  signWebEphemeralToken,
  verifyWebEphemeralToken,
} from "../worker/v1";
import { sqliteD1 } from "./fixtures/sqlite";

const TEST_SECRET = "dev-web-ephemeral-key-secret-at-least-32-bytes";

const ctx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

function createTestEnv(overrides: Partial<DashboardEnv> = {}): DashboardEnv {
  let db: any;
  if ("DB" in overrides) {
    db = overrides.DB;
  } else {
    const fresh = sqliteD1();
    fresh.sqlite.exec("PRAGMA foreign_keys = ON;");
    for (const file of readdirSync("migrations")
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      fresh.sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
    }
    db = fresh.db;
  }
  return {
    DB: db,
    ANALYTICS: { writeDataPoint: vi.fn() },
    API_KEY_RATE_LIMITER: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ admit: vi.fn() })),
    },
    UPSTREAM_API_ORIGIN: "https://origin-api.egdata.app",
    API_PROXY_HOST: "api.egdata.app",
    ORIGIN_AUTH_TOKEN: "test-origin-auth-token-12345",
    RATE_LIMIT_ENVIRONMENT: "test",
    REQUIRE_API_KEY: "false",
    ALLOW_FIRST_PARTY_ORIGINS: "https://egdata.app",
    WEB_EPHEMERAL_KEY_SECRET: TEST_SECRET,
    WEB_OWNER_EPIC_ID: "epic_web_admin",
    WEB_PROJECT_ID: "prj_egdata_web",
    WEB_BROWSER_KEY_ID: "key_egdata_web_browser",
    WEB_SSR_KEY_ID: "key_egdata_web_ssr",
    ...overrides,
  } as unknown as DashboardEnv;
}

describe("Web ephemeral tokens & computeIpSubnet", () => {
  beforeEach(() => {
    clearWebOwnerEpicIdCache();
  });

  afterEach(() => {
    clearWebOwnerEpicIdCache();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("computeIpSubnet", () => {
    it("handles null, empty, or undefined IP", () => {
      expect(computeIpSubnet(null)).toBe("local");
      expect(computeIpSubnet(undefined)).toBe("local");
      expect(computeIpSubnet("")).toBe("local");
      expect(computeIpSubnet("   ")).toBe("local");
    });

    it("extracts IPv4 /24 subnet", () => {
      expect(computeIpSubnet("198.51.100.42")).toBe("198.51.100.0/24");
      expect(computeIpSubnet("10.20.30.40")).toBe("10.20.30.0/24");
      expect(computeIpSubnet("127.0.0.1")).toBe("127.0.0.0/24");
    });

    it("strips ::ffff: prefix from IPv4-mapped IPv6", () => {
      expect(computeIpSubnet("::ffff:198.51.100.42")).toBe("198.51.100.0/24");
    });

    it("extracts IPv6 /48 subnet in lowercase hex without leading zeros", () => {
      expect(computeIpSubnet("2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe(
        "2001:db8:85a3::/48",
      );
      expect(computeIpSubnet("2606:4700:4700::1111")).toBe(
        "2606:4700:4700::/48",
      );
    });

    it("falls back to local for unparseable strings", () => {
      expect(computeIpSubnet("unknown")).toBe("local");
      expect(computeIpSubnet("999.999.999.999")).toBe("local");
    });
  });

  describe("verifyWebEphemeralToken", () => {
    const env = createTestEnv();

    it("verifies a valid ephemeral token with matching IPv4 subnet", async () => {
      const payload = {
        exp: Date.now() + 60_000,
        subnet: "198.51.100.0/24",
      };
      const token = await signWebEphemeralToken(payload, TEST_SECRET);

      const request = new Request("https://api.egdata.app/v1/offers", {
        headers: {
          Origin: "https://egdata.app",
          "Sec-Fetch-Site": "same-site",
        },
      });

      const result = await verifyWebEphemeralToken(
        request,
        token,
        "198.51.100.42",
        env,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.subnet).toBe("198.51.100.0/24");
        expect(result.payload.exp).toBe(payload.exp);
      }
    });

    it("verifies a valid ephemeral token with matching IPv6 subnet", async () => {
      const payload = {
        exp: Date.now() + 60_000,
        subnet: "2001:db8:85a3::/48",
      };
      const token = await signWebEphemeralToken(payload, TEST_SECRET);

      const request = new Request("https://api.egdata.app/v1/offers", {
        headers: {
          Origin: "https://egdata.app",
          "Sec-Fetch-Site": "same-site",
        },
      });

      const result = await verifyWebEphemeralToken(
        request,
        token,
        "2001:0db8:85a3:0000:0000:8a2e:0370:7334",
        env,
      );
      expect(result.ok).toBe(true);
    });

    it("allows localhost origin in local dev with same-origin or same-site", async () => {
      const payload = {
        exp: Date.now() + 60_000,
        subnet: "127.0.0.0/24",
      };
      const token = await signWebEphemeralToken(payload, TEST_SECRET);

      const request = new Request("https://api.egdata.app/v1/offers", {
        headers: {
          Origin: "http://localhost:3000",
          "Sec-Fetch-Site": "same-origin",
        },
      });

      const result = await verifyWebEphemeralToken(
        request,
        token,
        "127.0.0.1",
        env,
      );
      expect(result.ok).toBe(true);
    });

    it("rejects untrusted origin with 403 FORBIDDEN_ORIGIN", async () => {
      const payload = {
        exp: Date.now() + 60_000,
        subnet: "198.51.100.0/24",
      };
      const token = await signWebEphemeralToken(payload, TEST_SECRET);

      const request = new Request("https://api.egdata.app/v1/offers", {
        headers: {
          Origin: "https://evil.example.com",
          "Sec-Fetch-Site": "same-site",
        },
      });

      const result = await verifyWebEphemeralToken(
        request,
        token,
        "198.51.100.42",
        env,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(403);
        expect(result.code).toBe("FORBIDDEN_ORIGIN");
      }
    });

    it("rejects cross-site Sec-Fetch-Site with 403 FORBIDDEN_ORIGIN", async () => {
      const payload = {
        exp: Date.now() + 60_000,
        subnet: "198.51.100.0/24",
      };
      const token = await signWebEphemeralToken(payload, TEST_SECRET);

      const request = new Request("https://api.egdata.app/v1/offers", {
        headers: {
          Origin: "https://egdata.app",
          "Sec-Fetch-Site": "cross-site",
        },
      });

      const result = await verifyWebEphemeralToken(
        request,
        token,
        "198.51.100.42",
        env,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(403);
        expect(result.code).toBe("FORBIDDEN_ORIGIN");
      }
    });

    it("returns 401 EXPIRED_WEB_TOKEN when exp <= now", async () => {
      const payload = {
        exp: Date.now() - 5000,
        subnet: "198.51.100.0/24",
      };
      const token = await signWebEphemeralToken(payload, TEST_SECRET);

      const request = new Request("https://api.egdata.app/v1/offers", {
        headers: {
          Origin: "https://egdata.app",
          "Sec-Fetch-Site": "same-site",
        },
      });

      const result = await verifyWebEphemeralToken(
        request,
        token,
        "198.51.100.42",
        env,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(401);
        expect(result.code).toBe("EXPIRED_WEB_TOKEN");
      }
    });

    it("returns 401 INVALID_WEB_TOKEN when subnet does not match client IP", async () => {
      const payload = {
        exp: Date.now() + 60_000,
        subnet: "198.51.100.0/24",
      };
      const token = await signWebEphemeralToken(payload, TEST_SECRET);

      const request = new Request("https://api.egdata.app/v1/offers", {
        headers: {
          Origin: "https://egdata.app",
          "Sec-Fetch-Site": "same-site",
        },
      });

      const result = await verifyWebEphemeralToken(
        request,
        token,
        "203.0.113.10",
        env,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(401);
        expect(result.code).toBe("INVALID_WEB_TOKEN");
      }
    });

    it("returns 401 INVALID_WEB_TOKEN on tampered signature", async () => {
      const payload = {
        exp: Date.now() + 60_000,
        subnet: "198.51.100.0/24",
      };
      const token =
        (await signWebEphemeralToken(payload, TEST_SECRET)) + "tamper";

      const request = new Request("https://api.egdata.app/v1/offers", {
        headers: {
          Origin: "https://egdata.app",
          "Sec-Fetch-Site": "same-site",
        },
      });

      const result = await verifyWebEphemeralToken(
        request,
        token,
        "198.51.100.42",
        env,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(401);
        expect(result.code).toBe("INVALID_WEB_TOKEN");
      }
    });
  });

  describe("v1 Gateway proxy with egw_ tokens", () => {
    it("serves request, skips DO admission, and passes enterprise tier to upstream", async () => {
      const admit = vi.fn();
      const env = createTestEnv({
        API_KEY_RATE_LIMITER: {
          idFromName: vi.fn(),
          get: vi.fn(() => ({ admit })),
        } as any,
      });

      const payload = {
        exp: Date.now() + 60_000,
        subnet: "198.51.100.0/24",
      };
      const token = await signWebEphemeralToken(payload, TEST_SECRET);

      let forwardedHeaders: Headers | null = null;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: RequestInit) => {
          forwardedHeaders = new Headers(init.headers);
          return new Response(JSON.stringify({ offers: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }),
      );

      const request = new Request("https://api.egdata.app/v1/offers", {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "https://egdata.app",
          "Sec-Fetch-Site": "same-site",
          "cf-connecting-ip": "198.51.100.42",
        },
      });

      const response = await handleV1ApiProxy(request, env, ctx, "/v1/offers");

      expect(response.status).toBe(200);
      expect(admit).not.toHaveBeenCalled();
      expect(response.headers.get("X-Egdata-Key-Tier")).toBe("enterprise");
      expect((forwardedHeaders as Headers | null)?.get("x-egdata-key-id")).toBe(
        "key_egdata_web_browser",
      );
      expect(
        (forwardedHeaders as Headers | null)?.get("x-egdata-key-tier"),
      ).toBe("enterprise");
      expect(
        (forwardedHeaders as Headers | null)?.get("x-egdata-key-project"),
      ).toBe("prj_egdata_web");
    });

    it("enforces per-IP rate limiting at the PoP with RATE_LIMITER_PRO", async () => {
      const limitMock = vi.fn().mockResolvedValue({ success: false });
      const env = createTestEnv({
        RATE_LIMITER_PRO: { limit: limitMock } as any,
      });

      const payload = {
        exp: Date.now() + 60_000,
        subnet: "198.51.100.0/24",
      };
      const token = await signWebEphemeralToken(payload, TEST_SECRET);

      const request = new Request("https://api.egdata.app/v1/offers", {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "https://egdata.app",
          "Sec-Fetch-Site": "same-site",
          "cf-connecting-ip": "198.51.100.42",
        },
      });

      const response = await handleV1ApiProxy(request, env, ctx, "/v1/offers");

      expect(limitMock).toHaveBeenCalledWith({ key: "web:198.51.100.42" });
      expect(response.status).toBe(429);
      const json = (await response.json()) as any;
      expect(json.code).toBe("RATE_LIMITED");
      expect(response.headers.get("Retry-After")).toBe("60");
      expect(response.headers.get("X-Egdata-Key-Tier")).toBe("enterprise");
    });

    it("returns 401 EXPIRED_WEB_TOKEN on expired token in gateway", async () => {
      const env = createTestEnv();
      const payload = {
        exp: Date.now() - 1000,
        subnet: "198.51.100.0/24",
      };
      const token = await signWebEphemeralToken(payload, TEST_SECRET);

      const request = new Request("https://api.egdata.app/v1/offers", {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "https://egdata.app",
          "Sec-Fetch-Site": "same-site",
          "cf-connecting-ip": "198.51.100.42",
        },
      });

      const response = await handleV1ApiProxy(request, env, ctx, "/v1/offers");

      expect(response.status).toBe(401);
      const json = (await response.json()) as any;
      expect(json.code).toBe("EXPIRED_WEB_TOKEN");
    });

    it("rejects valid egw_ token with 403 KEY_DISABLED when registered browser key is inactive", async () => {
      clearWebOwnerEpicIdCache();
      const { db, sqlite } = sqliteD1();
      sqlite.exec("PRAGMA foreign_keys = ON;");
      for (const file of readdirSync("migrations")
        .filter((f) => f.endsWith(".sql"))
        .sort()) {
        sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
      }

      // Seed web owner, project, and browser key
      sqlite
        .prepare(
          "INSERT OR IGNORE INTO users (epic_account_id, display_name) VALUES ('egdata_web_owner', 'EGDATA Web')",
        )
        .run();
      sqlite
        .prepare(
          "INSERT OR IGNORE INTO projects (id, owner_epic_id, name, slug, tier) VALUES ('prj_egdata_web', 'egdata_web_owner', 'egdata.app', 'egdata-web', 'enterprise')",
        )
        .run();
      sqlite
        .prepare(
          `INSERT OR REPLACE INTO api_keys (
            id, project_id, owner_epic_id, name, key_prefix, key_hash, tier, active,
            scopes_json, allowed_ips_json, allowed_origins_json, allowed_paths_json, allowed_methods_json
          ) VALUES (
            'key_egdata_web_browser', 'prj_egdata_web', 'egdata_web_owner', 'Browser Key', 'egw_browser_', 'hash_browser', 'enterprise', 0,
            '[]', '[]', '[]', '[]', '["GET","HEAD","POST"]'
          )`,
        )
        .run();

      const env = createTestEnv({ DB: db });
      const payload = {
        exp: Date.now() + 60_000,
        subnet: "198.51.100.0/24",
      };
      const token = await signWebEphemeralToken(payload, TEST_SECRET);

      const request = new Request("https://api.egdata.app/v1/offers", {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "https://egdata.app",
          "Sec-Fetch-Site": "same-site",
          "cf-connecting-ip": "198.51.100.42",
        },
      });

      const response = await handleV1ApiProxy(request, env, ctx, "/v1/offers");
      expect(response.status).toBe(403);
      const json = (await response.json()) as any;
      expect(json.code).toBe("KEY_DISABLED");
    });

    it("rejects valid egw_ token with 401 INVALID_API_KEY when registered browser key is revoked", async () => {
      clearWebOwnerEpicIdCache();
      const { db, sqlite } = sqliteD1();
      sqlite.exec("PRAGMA foreign_keys = ON;");
      for (const file of readdirSync("migrations")
        .filter((f) => f.endsWith(".sql"))
        .sort()) {
        sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
      }

      // Seed web owner, project, and browser key
      sqlite
        .prepare(
          "INSERT OR IGNORE INTO users (epic_account_id, display_name) VALUES ('egdata_web_owner', 'EGDATA Web')",
        )
        .run();
      sqlite
        .prepare(
          "INSERT OR IGNORE INTO projects (id, owner_epic_id, name, slug, tier) VALUES ('prj_egdata_web', 'egdata_web_owner', 'egdata.app', 'egdata-web', 'enterprise')",
        )
        .run();
      sqlite
        .prepare(
          `INSERT OR REPLACE INTO api_keys (
            id, project_id, owner_epic_id, name, key_prefix, key_hash, tier, active, revoked_at,
            scopes_json, allowed_ips_json, allowed_origins_json, allowed_paths_json, allowed_methods_json
          ) VALUES (
            'key_egdata_web_browser', 'prj_egdata_web', 'egdata_web_owner', 'Browser Key', 'egw_browser_', 'hash_browser', 'enterprise', 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
            '[]', '[]', '[]', '[]', '["GET","HEAD","POST"]'
          )`,
        )
        .run();

      const env = createTestEnv({ DB: db });
      const payload = {
        exp: Date.now() + 60_000,
        subnet: "198.51.100.0/24",
      };
      const token = await signWebEphemeralToken(payload, TEST_SECRET);

      const request = new Request("https://api.egdata.app/v1/offers", {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "https://egdata.app",
          "Sec-Fetch-Site": "same-site",
          "cf-connecting-ip": "198.51.100.42",
        },
      });

      const response = await handleV1ApiProxy(request, env, ctx, "/v1/offers");
      expect(response.status).toBe(401);
      const json = (await response.json()) as any;
      expect(json.code).toBe("INVALID_API_KEY");
    });

    it("fails closed with 503 ACCOUNT_STATUS_UNAVAILABLE when D1 query fails and does not cache active state", async () => {
      clearWebOwnerEpicIdCache();
      const failingDb = {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({
            first: vi.fn().mockRejectedValue(new Error("D1 connection lost")),
          })),
        })),
      } as any;

      const env = createTestEnv({ DB: failingDb });
      const payload = {
        exp: Date.now() + 60_000,
        subnet: "198.51.100.0/24",
      };
      const token = await signWebEphemeralToken(payload, TEST_SECRET);

      const request = new Request("https://api.egdata.app/v1/offers", {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "https://egdata.app",
          "Sec-Fetch-Site": "same-site",
          "cf-connecting-ip": "198.51.100.42",
        },
      });

      const response = await handleV1ApiProxy(request, env, ctx, "/v1/offers");
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("30");
      const json = (await response.json()) as any;
      expect(json.code).toBe("ACCOUNT_STATUS_UNAVAILABLE");

      // Verify that no active state was cached: a subsequent call on a healthy DB with an inactive key still rejects with 403
      const { db, sqlite } = sqliteD1();
      sqlite.exec("PRAGMA foreign_keys = ON;");
      for (const file of readdirSync("migrations")
        .filter((f) => f.endsWith(".sql"))
        .sort()) {
        sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
      }

      sqlite
        .prepare(
          "INSERT OR IGNORE INTO users (epic_account_id, display_name) VALUES ('egdata_web_owner', 'EGDATA Web')",
        )
        .run();
      sqlite
        .prepare(
          "INSERT OR IGNORE INTO projects (id, owner_epic_id, name, slug, tier) VALUES ('prj_egdata_web', 'egdata_web_owner', 'egdata.app', 'egdata-web', 'enterprise')",
        )
        .run();
      sqlite
        .prepare(
          `INSERT OR REPLACE INTO api_keys (
            id, project_id, owner_epic_id, name, key_prefix, key_hash, tier, active,
            scopes_json, allowed_ips_json, allowed_origins_json, allowed_paths_json, allowed_methods_json
          ) VALUES (
            'key_egdata_web_browser', 'prj_egdata_web', 'egdata_web_owner', 'Browser Key', 'egw_browser_', 'hash_browser', 'enterprise', 0,
            '[]', '[]', '[]', '[]', '["GET","HEAD","POST"]'
          )`,
        )
        .run();

      const healthyEnv = createTestEnv({ DB: db });
      const nextResponse = await handleV1ApiProxy(
        request,
        healthyEnv,
        ctx,
        "/v1/offers",
      );
      expect(nextResponse.status).toBe(403);
      const nextJson = (await nextResponse.json()) as any;
      expect(nextJson.code).toBe("KEY_DISABLED");
    });
  });

  describe("Internal telemetry endpoint POST /_internal/telemetry", () => {
    it("rejects unauthorized requests without worker auth token", async () => {
      const env = createTestEnv();
      const request = new Request(
        "https://devs.egdata.app/_internal/telemetry",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer wrong-token",
          },
          body: JSON.stringify({ events: [] }),
        },
      );

      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(401);
    });

    it("accepts valid batch, records telemetry, and persists usage in D1", async () => {
      const { db, sqlite } = sqliteD1();
      sqlite.exec("PRAGMA foreign_keys = ON;");
      for (const file of readdirSync("migrations")
        .filter((f) => f.endsWith(".sql"))
        .sort()) {
        sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
      }

      const env = createTestEnv({ DB: db });

      const nowMs = Date.now();
      const today = new Date(nowMs).toISOString().slice(0, 10);
      const batchEvents = [
        {
          requestId: "req_ssr_test_1",
          keyId: "key_egdata_web_ssr",
          projectId: "prj_egdata_web",
          ownerEpicId: "epic_web_admin",
          tier: "enterprise",
          routeTemplate: "/v1/offers/:id",
          operationId: "getOffer",
          method: "GET",
          statusCode: 200,
          cacheStatus: "SSR_DIRECT",
          limitOutcome: "allowed",
          policyFamily: "ssr",
          errorCode: "",
          country: "US",
          latencyMs: 15,
          upstreamMs: 15,
          responseBytes: 1024,
          timestamp: nowMs,
        },
        {
          requestId: "req_ssr_test_2",
          keyId: "key_egdata_web_ssr",
          projectId: "prj_egdata_web",
          ownerEpicId: "epic_web_admin",
          tier: "enterprise",
          routeTemplate: "/v1/search",
          operationId: "searchCatalog",
          method: "GET",
          statusCode: 200,
          cacheStatus: "SSR_DIRECT",
          limitOutcome: "allowed",
          policyFamily: "ssr",
          errorCode: "",
          country: "ES",
          latencyMs: 25,
          upstreamMs: 25,
          responseBytes: 2048,
          timestamp: nowMs,
        },
      ];

      const request = new Request(
        "https://devs.egdata.app/_internal/telemetry",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.ORIGIN_AUTH_TOKEN}`,
            "x-egdata-worker-token": env.ORIGIN_AUTH_TOKEN!,
          },
          body: JSON.stringify({ events: batchEvents }),
        },
      );

      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(200);
      const json = (await response.json()) as any;
      expect(json.ok).toBe(true);
      expect(json.ingested).toBe(2);

      // Verify that usage was written to usage_daily in D1
      const dailyRows = sqlite
        .prepare(
          "SELECT project_id, key_id, operation_id, usage_date FROM usage_daily WHERE usage_date = ? ORDER BY operation_id ASC",
        )
        .all(today);

      expect(dailyRows).toEqual([
        {
          project_id: "prj_egdata_web",
          key_id: "key_egdata_web_ssr",
          operation_id: "getOffer",
          usage_date: today,
        },
        {
          project_id: "prj_egdata_web",
          key_id: "key_egdata_web_ssr",
          operation_id: "searchCatalog",
          usage_date: today,
        },
      ]);
    });
  });
});
