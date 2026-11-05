import { Hono } from "hono";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

type RateLimitModule = typeof import("../src/middlewares/rate-limit.js");

const LIST_LIMIT = 5;

let ipCounter = 0;

function uniqueIp() {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

function headersFor(ip: string) {
  return {
    "x-forwarded-for": ip,
    "user-agent": "vitest-offers-list-limit",
  };
}

describe("GET /offers rate limit", () => {
  let rateLimit: RateLimitModule;
  let app: Hono;

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("RATE_LIMIT_ENABLED", "true");
    vi.stubEnv("JWT_SECRET", "");
    // Point at a closed port so the store exercises its fail-open fallback.
    vi.stubEnv("REDISHOST", "127.0.0.1");
    vi.stubEnv("REDISPORT", "1");
    vi.resetModules();

    rateLimit = await import("../src/middlewares/rate-limit.js");

    app = new Hono();
    app.get("/offers", rateLimit.offersListRateLimit, (c) =>
      c.json({ elements: [] }),
    );
    app.get("/offers/:id", (c) => c.json({ id: c.req.param("id") }));
  });

  afterAll(() => {
    rateLimit.disconnectRateLimitStore();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it(`allows ${LIST_LIMIT} requests per client and rejects the next one`, async () => {
    const headers = headersFor(uniqueIp());

    for (let index = 0; index < LIST_LIMIT; index += 1) {
      const response = await app.request("/offers", { headers });
      expect(response.status).toBe(200);
    }

    const blocked = await app.request("/offers", { headers });
    expect(blocked.status).toBe(429);
  });

  it("counts distinct query strings against the same client bucket", async () => {
    const headers = headersFor(uniqueIp());
    const queryStrings = [
      "?page=1",
      "?page=2&limit=50",
      "?country=IQ&locale=ar",
      "?cachebuster=8f14e45f",
      "?page=3&expand=true&sort=relevance&utm_source=scraper",
    ];

    for (const query of queryStrings) {
      const response = await app.request(`/offers${query}`, { headers });
      expect(response.status).toBe(200);
    }

    // Sixth request, brand new query string: the bucket is per client, not per URL.
    const blocked = await app.request("/offers?totally=new=params&t=123", {
      headers,
    });
    expect(blocked.status).toBe(429);
  });

  it("counts encoded variants of the list path against the same bucket", async () => {
    const headers = headersFor(uniqueIp());

    // `/%6Fffers` is decoded to `/offers` by the router, so it must run the
    // limiter attached to the handler instead of slipping past a path prefix.
    const paths = ["/offers", "/%6Fffers", "/offers", "/%6Fffers", "/offers"];

    for (const path of paths) {
      const response = await app.request(path, { headers });
      expect(response.status).toBe(200);
    }

    const blocked = await app.request("/%6Fffers", { headers });
    expect(blocked.status).toBe(429);
  });

  it("does not throttle offer detail routes", async () => {
    const headers = headersFor(uniqueIp());

    for (let index = 0; index < LIST_LIMIT + 5; index += 1) {
      const response = await app.request(`/offers/offer-${index}`, { headers });
      expect(response.status).toBe(200);
    }
  });

  it("keeps a separate bucket per client identity", async () => {
    const firstClient = headersFor("203.0.113.10");
    const secondClient = headersFor("203.0.113.11");

    for (let index = 0; index < LIST_LIMIT; index += 1) {
      expect(
        (await app.request("/offers", { headers: firstClient })).status,
      ).toBe(200);
    }
    expect(
      (await app.request("/offers", { headers: firstClient })).status,
    ).toBe(429);

    const otherClient = await app.request("/offers", { headers: secondClient });
    expect(otherClient.status).toBe(200);
  });

  it("returns a structured 429 with Retry-After", async () => {
    const headers = headersFor(uniqueIp());

    for (let index = 0; index < LIST_LIMIT; index += 1) {
      await app.request("/offers", { headers });
    }

    const blocked = await app.request("/offers", { headers });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toMatch(/^\d+$/);

    const body = (await blocked.json()) as {
      error: { code: string; message: string; retryAfter: number };
    };
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.message).toContain("5 requests per minute");
    expect(body.error.retryAfter).toBeGreaterThan(0);
  });

  it("resets the bucket after the window elapses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const headers = headersFor(uniqueIp());

    for (let index = 0; index < LIST_LIMIT; index += 1) {
      expect((await app.request("/offers", { headers })).status).toBe(200);
    }
    expect((await app.request("/offers", { headers })).status).toBe(429);

    vi.advanceTimersByTime(61_000);

    expect((await app.request("/offers", { headers })).status).toBe(200);
  });
});
