import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type RateLimitModule = typeof import("../src/middlewares/rate-limit.js");

describe("interactive search rate limit", () => {
  let rateLimit: RateLimitModule;
  let app: Hono;

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("RATE_LIMIT_ENABLED", "true");
    vi.stubEnv("RATE_LIMIT_SEARCH_PER_MINUTE", "2");
    vi.stubEnv("JWT_SECRET", "");
    vi.stubEnv("REDISHOST", "127.0.0.1");
    vi.stubEnv("REDISPORT", "1");
    vi.resetModules();

    rateLimit = await import("../src/middlewares/rate-limit.js");
    app = new Hono();
    app.use("/search/v2/search", rateLimit.searchRateLimit);
    app.post("/search/v2/search", (c) => c.json({ ok: true }));
  });

  afterAll(() => {
    rateLimit.disconnectRateLimitStore();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("allows more interactive searches than the heavy-route quota", async () => {
    const headers = {
      "x-forwarded-for": "203.0.113.20",
      "user-agent": "vitest-search-limit",
    };

    const first = await app.request("/search/v2/search", {
      method: "POST",
      headers,
    });
    const second = await app.request("/search/v2/search", {
      method: "POST",
      headers,
    });
    const third = await app.request("/search/v2/search", {
      method: "POST",
      headers,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(third.headers.get("Retry-After")).toBeTruthy();
  });
});
