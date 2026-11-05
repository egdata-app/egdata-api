import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAntiAbuse } from "../src/middleware/anti-abuse.js";
import { AbuseScorer } from "../src/services/abuse-scorer.js";
import { PowSessionService } from "../src/services/pow-session.js";

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

  it("retains baseline limits in enforce mode when transport is untrusted and no session exists", async () => {
    const protectedApp = new Hono();
    const scorer = new AbuseScorer();
    const enqueue = vi.spyOn(scorer, "enqueue");
    const anti = createAntiAbuse({
      mode: "enforce",
      scorer,
      sessions: new PowSessionService(
        "test-only-secret-with-at-least-32-bytes",
      ),
      edgeSecret: "trusted-secret",
    });
    protectedApp.use("*", anti.middleware);
    protectedApp.use("*", rateLimit.generalRateLimit);
    protectedApp.use("*", rateLimit.offersListRateLimit);
    protectedApp.get("/offers", (c) => c.json({ elements: [] }));
    const request = () =>
      protectedApp.request("/offers", {
        headers: {
          "cf-connecting-ip": "203.0.113.77",
          "x-egdata-edge-secret": "forged",
          "x-egdata-tls-version": "TLSv1.3",
        },
      });
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);
    const limited = await request();
    expect(limited.status).toBe(429);
    expect((await limited.json()).error.code).toBe("RATE_LIMITED");
    expect(enqueue.mock.calls.every(([keys]) => keys.length === 0)).toBe(true);
    scorer.close();
  });
});
