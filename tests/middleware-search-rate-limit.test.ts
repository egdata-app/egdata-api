import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type RateLimitModule = typeof import("../src/middlewares/rate-limit.js");

describe("interactive search and GraphQL rate limits", () => {
  let rateLimit: RateLimitModule;
  let app: Hono;
  let graphqlApp: Hono;
  let generalApp: Hono;

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("RATE_LIMIT_ENABLED", "true");
    vi.stubEnv("RATE_LIMIT_GENERAL_PER_MINUTE", "2");
    vi.stubEnv("RATE_LIMIT_SEARCH_PER_MINUTE", "2");
    vi.stubEnv("RATE_LIMIT_GRAPHQL_GET_PER_MINUTE", "3");
    vi.stubEnv("RATE_LIMIT_GRAPHQL_POST_PER_MINUTE", "2");
    vi.stubEnv("JWT_SECRET", "");
    vi.stubEnv("REDISHOST", "127.0.0.1");
    vi.stubEnv("REDISPORT", "1");
    vi.resetModules();

    rateLimit = await import("../src/middlewares/rate-limit.js");
    app = new Hono();
    app.use("/search/v2/search", rateLimit.searchRateLimit);
    app.post("/search/v2/search", (c) => c.json({ ok: true }));

    graphqlApp = new Hono();
    graphqlApp.use("/graphql", rateLimit.graphqlRateLimit);
    graphqlApp.get("/graphql", (c) => c.json({ data: {} }));
    graphqlApp.post("/graphql", (c) => c.json({ data: {} }));

    generalApp = new Hono();
    generalApp.use("/*", rateLimit.generalRateLimit);
    generalApp.get("/general", (c) => c.json({ ok: true }));
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

  it("keeps GraphQL POST on a tighter bucket than GET", async () => {
    const headers = {
      "x-forwarded-for": "203.0.113.21",
      "user-agent": "vitest-graphql-limit",
    };

    const first = await graphqlApp.request("/graphql", {
      method: "POST",
      headers,
    });
    const second = await graphqlApp.request("/graphql", {
      method: "POST",
      headers,
    });
    const third = await graphqlApp.request("/graphql", {
      method: "POST",
      headers,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
  });

  it("allows a higher GraphQL GET/APQ quota", async () => {
    const headers = {
      "x-forwarded-for": "203.0.113.22",
      "user-agent": "vitest-graphql-get",
    };

    const results: Response[] = [];
    for (let index = 0; index < 4; index += 1) {
      results.push(
        await graphqlApp.request("/graphql", { method: "GET", headers }),
      );
    }

    expect(results.slice(0, 3).map((response) => response.status)).toEqual([
      200, 200, 200,
    ]);
    expect(results[3].status).toBe(429);
  });

  it("does not share counters between limiters", async () => {
    const headers = {
      "x-forwarded-for": "203.0.113.23",
      "user-agent": "vitest-bucket-isolation",
    };

    const generalFirst = await generalApp.request("/general", { headers });
    const generalSecond = await generalApp.request("/general", { headers });
    const search = await app.request("/search/v2/search", {
      method: "POST",
      headers,
    });

    expect(generalFirst.status).toBe(200);
    expect(generalSecond.status).toBe(200);
    expect(search.status).toBe(200);
  });
});
