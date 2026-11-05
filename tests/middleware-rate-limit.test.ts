import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type RateLimitModule = typeof import("../src/middlewares/rate-limit.js");

describe("rate limiting", () => {
  let rateLimit: RateLimitModule;
  let app: Hono;

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("RATE_LIMIT_ENABLED", "true");
    vi.stubEnv("RATE_LIMIT_GENERAL_PER_MINUTE", "2");
    vi.stubEnv("JWT_SECRET", "");
    // Point at a closed port so the store exercises its fail-open fallback.
    vi.stubEnv("REDISHOST", "127.0.0.1");
    vi.stubEnv("REDISPORT", "1");
    vi.resetModules();

    rateLimit = await import("../src/middlewares/rate-limit.js");
    app = new Hono();
    app.use("/*", rateLimit.generalRateLimit);
    app.get("/", (c) => c.text("ok"));
  });

  afterAll(() => {
    rateLimit.disconnectRateLimitStore();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("returns 429 with Retry-After after the anonymous quota", async () => {
    const headers = {
      "x-forwarded-for": "203.0.113.10",
      "user-agent": "vitest-rate-limit",
    };

    const first = await app.request("/", { headers });
    const second = await app.request("/", { headers });
    const third = await app.request("/", { headers });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(third.headers.get("Retry-After")).toBeTruthy();

    const body = (await third.json()) as {
      error?: { code?: string };
    };
    expect(body.error?.code).toBe("RATE_LIMITED");
  });

  it("uses a separate bucket per client identity", async () => {
    const otherClient = {
      "x-forwarded-for": "203.0.113.11",
      "user-agent": "vitest-rate-limit",
    };

    const response = await app.request("/", { headers: otherClient });
    expect(response.status).toBe(200);
  });
});
