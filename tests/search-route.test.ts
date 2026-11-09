import { once } from "node:events";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { compress } from "hono/compress";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { apiCors } from "../src/middlewares/cors.js";
import { edgeCacheHeaders } from "../src/middlewares/edge-cache.js";
import { responseEtag } from "../src/middlewares/response-etag.js";
import { Changelog, Offer } from "../src/models/index.js";
import SearchRoute from "../src/routes/search.js";
import {
  loadSeaQaOffers,
  SEA_QA_SMOKE_OFFER_ID,
  type SeaQaOffer,
} from "./fixtures/seaqa.js";

type OpenSearchRequest = {
  body: {
    from?: number;
    size?: number;
  };
};

const mocks = vi.hoisted(() => ({
  opensearchSearch: vi.fn(),
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  sharedGet: vi.fn(),
  sharedSet: vi.fn(),
  vectorizeSearch: vi.fn(),
}));

const changelogSearchResponse = (
  hits: Array<{ _id: string; _source: Record<string, unknown> }>,
) => ({
  body: {
    took: 5,
    timed_out: false,
    hits: {
      total: { value: hits.length, relation: "eq" },
      hits,
    },
  },
});

const mockChangelogFind = (documents: unknown[]) =>
  vi
    .spyOn(Changelog, "find")
    .mockReturnValue(
      Promise.resolve(documents) as unknown as ReturnType<
        typeof Changelog.find
      >,
    );

vi.mock("../src/clients/opensearch.js", () => ({
  opensearch: {
    search: mocks.opensearchSearch,
  },
}));

vi.mock("../src/clients/redis.js", () => ({
  default: { get: mocks.sharedGet, set: mocks.sharedSet },
}));

vi.mock("../src/clients/response-cache.js", () => ({
  default: {
    get: mocks.redisGet,
    set: mocks.redisSet,
  },
}));

vi.mock("../src/clients/vectorize.js", () => ({
  CloudflareVectorizeError: class CloudflareVectorizeError extends Error {},
  VectorizeConfigurationError: class VectorizeConfigurationError extends Error {},
  queryOffersWithNaturalLanguage: mocks.vectorizeSearch,
}));

// Hono's in-process request helper does not follow redirects like fetch does.
async function requestFollowingRedirect(
  app: Hono,
  ...args: Parameters<Hono["request"]>
) {
  const response = await app.request(...args);
  return response.status === 303
    ? app.request(
        response.headers.get("location") ?? "missing-redirect-location",
      )
    : response;
}

describe("search route with SeaQA fixtures", () => {
  let app: Hono;
  let offers: SeaQaOffer[];
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    offers = await loadSeaQaOffers();
    app = new Hono().route("/search", SearchRoute);
  });

  beforeEach(() => {
    mocks.opensearchSearch.mockReset();
    mocks.redisGet.mockReset();
    mocks.redisSet.mockReset();
    mocks.sharedGet.mockReset().mockResolvedValue(null);
    mocks.sharedSet.mockReset().mockResolvedValue("OK");
    const cache = new Map<string, string>();
    mocks.redisGet.mockImplementation(
      async (key: string) => cache.get(key) ?? null,
    );
    mocks.redisSet.mockImplementation(async (key: string, value: string) => {
      cache.set(key, value);
      return "OK";
    });
    mocks.vectorizeSearch.mockReset();
    consoleLogSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    mocks.opensearchSearch.mockImplementation(
      async (request: OpenSearchRequest) => {
        const from = Number(request.body.from ?? 0);
        const size = Number(request.body.size ?? 10);
        return {
          body: {
            took: 7,
            timed_out: false,
            hits: {
              total: { value: offers.length, relation: "eq" },
              hits: offers.slice(from, from + size).map((offer) => ({
                _source: offer,
              })),
            },
            aggregations: {
              offerType: { buckets: [{ key: "BUNDLE", doc_count: 1 }] },
              tags: { buckets: [] },
              technologies: {
                buckets: [{ key: "Unreal", doc_count: 1 }],
              },
              developer: { buckets: [] },
              publisher: { buckets: [] },
              seller: { buckets: [{ key: "Test", doc_count: offers.length }] },
              price_stats: {
                count: 0,
                min: null,
                max: null,
                avg: null,
                sum: 0,
              },
            },
          },
        };
      },
    );
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("reads saved query definitions from shared Redis without consulting the response cache", async () => {
    const query = { query: "saved catalog search", page: 2, limit: 5 };
    mocks.sharedGet.mockResolvedValue(JSON.stringify(query));

    const response = await requestFollowingRedirect(
      app,
      "/search/saved-query-id",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(query);
    expect(mocks.sharedGet).toHaveBeenCalledWith("q:saved-query-id");
    expect(mocks.redisGet).not.toHaveBeenCalled();
    expect(mocks.redisSet).not.toHaveBeenCalled();
  });

  it("redirects POST to a sanitized, deterministic GET without accessing search or caches", async () => {
    const response = await app.request(
      "/search/v2/search?locale=EN-us&expand=1&tracking=no",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "EGDATA_COUNTRY=FR",
        },
        body: JSON.stringify({
          title: "  A & B?#  ",
          tags: ["RPG", "Action", "RPG"],
          technologies: [" Unreal ", "Unreal"],
          price: { min: 0, max: 2000, ignored: 5 },
          onSale: false,
          page: 0,
          limit: 200,
          facets: "none",
          unknown: "ignored",
        }),
      },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
    expect(response.headers.get("location")).toBe(
      "/search/v2/search?country=FR&expand=true&facets=none&limit=100&onSale=false&priceMax=2000&priceMin=0&tags=Action%2CRPG&technologies=Unreal&title=A+%26+B%3F%23",
    );
    expect(mocks.opensearchSearch).not.toHaveBeenCalled();
    expect(mocks.redisGet).not.toHaveBeenCalled();
    expect(mocks.redisSet).not.toHaveBeenCalled();
    expect(
      (
        await app.request(
          response.headers.get("location") ?? "missing-redirect-location",
        )
      ).status,
    ).toBe(200);
  });

  it("uses identical redirect URLs for equivalent filters and explicit defaults", async () => {
    const locations = [];
    for (const body of [
      { tags: ["b", "a", "b"] },
      {
        tags: ["a", "b"],
        page: 1,
        limit: 10,
        facets: "full",
        sortDir: "desc",
        ignored: true,
      },
    ]) {
      const response = await app.request("/search/v2/search", {
        method: "POST",
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(303);
      locations.push(response.headers.get("location"));
    }
    expect(locations).toEqual([
      "/search/v2/search?country=US&tags=a%2Cb",
      "/search/v2/search?country=US&tags=a%2Cb",
    ]);
  });

  it("preserves literal commas in list filters through the redirect", async () => {
    const response = await requestFollowingRedirect(
      app,
      "/search/v2/search?country=US",
      {
        method: "POST",
        body: JSON.stringify({ technologies: ["Engine, Inc."] }),
      },
    );
    expect(response.status).toBe(200);
    expect(
      mocks.opensearchSearch.mock.calls[0][0].body.query.bool.filter[0]
        .terms_set["lastBuilds.technologies.technology.keyword"].terms,
    ).toEqual(["Engine, Inc."]);
  });

  it.each([
    "null",
    "[]",
    "broken",
    '{"title":{}}',
    '{"tags":"a"}',
    '{"onSale":"false"}',
    '{"limit":1.5}',
    '{"price":{"min":"0"}}',
    '{"sortBy":"prices.private"}',
  ])("rejects malformed POST input before redirecting: %s", async (body) => {
    const response = await app.request("/search/v2/search", {
      method: "POST",
      body,
    });
    expect(response.status).toBe(400);
    expect(response.headers.has("location")).toBe(false);
    expect(mocks.opensearchSearch).not.toHaveBeenCalled();
    expect(mocks.redisGet).not.toHaveBeenCalled();
  });

  it("makes GET pricing independent of cookies when country is absent", async () => {
    await app.request("/search/v2/search", {
      headers: { cookie: "EGDATA_COUNTRY=FR" },
    });
    expect(
      mocks.opensearchSearch.mock.calls[0][0].body.aggregations.price_stats
        .stats.field,
    ).toBe("prices.US.price.discountPrice");
  });

  it("preserves explicit country and normalized locale over cookie values", async () => {
    const response = await app.request(
      "/search/v2/search?country=DE&locale=fr-fr",
      {
        method: "POST",
        headers: { cookie: "EGDATA_COUNTRY=US" },
        body: "{}",
      },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "/search/v2/search?country=DE&locale=fr-FR",
    );
  });

  it.each([
    "page=1.5",
    "limit=NaN",
    "priceMin=Infinity",
    "onSale=maybe",
    "sortBy=privateField",
    "sortDir=other",
  ])("rejects invalid GET filters: %s", async (query) => {
    const response = await app.request(`/search/v2/search?${query}`);
    expect(response.status).toBe(400);
    expect(mocks.opensearchSearch).not.toHaveBeenCalled();
    expect(mocks.redisGet).not.toHaveBeenCalled();
  });

  it("rejects invalid POST locale before redirecting", async () => {
    const response = await app.request("/search/v2/search?locale=bad_locale", {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(400);
    expect(response.headers.has("location")).toBe(false);
  });

  it("follows the 303 over real HTTP with fetch, CORS, compression and conditional GET", async () => {
    const httpApp = new Hono();
    const methods: string[] = [];
    httpApp.use("*", async (c, next) => {
      methods.push(c.req.method);
      if (c.req.method === "GET") expect(await c.req.text()).toBe("");
      await next();
    });
    httpApp.use("*", compress({ threshold: 512 }));
    httpApp.use("*", apiCors());
    httpApp.use("*", responseEtag);
    httpApp.use("*", edgeCacheHeaders);
    httpApp.route("/search", SearchRoute);
    const server = serve({
      fetch: httpApp.fetch,
      hostname: "127.0.0.1",
      port: 0,
    });
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing HTTP port");
      const endpoint = `http://127.0.0.1:${address.port}/search/v2/search`;
      const headers = {
        "Content-Type": "application/json",
        Origin: "https://egdata.app",
        "Accept-Encoding": "gzip",
      };
      const body = JSON.stringify({ title: "A & B + 100%", limit: 2 });
      const manual = await fetch(endpoint, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
      });
      expect(manual.status).toBe(303);
      expect(manual.headers.get("access-control-allow-origin")).toBe(
        "https://egdata.app",
      );
      expect(manual.headers.get("cache-control")).toBe("no-store");
      expect(await manual.text()).toBe("");
      expect(mocks.opensearchSearch).not.toHaveBeenCalled();

      const followed = await fetch(endpoint, { method: "POST", headers, body });
      expect(followed.status).toBe(200);
      expect(followed.redirected).toBe(true);
      expect(methods).toEqual(["POST", "POST", "GET"]);
      expect(new URL(followed.url).searchParams.get("title")).toBe(
        "A & B + 100%",
      );
      expect(followed.headers.get("access-control-allow-origin")).toBe(
        "https://egdata.app",
      );
      expect(followed.headers.get("content-encoding")).toBe("gzip");
      expect(followed.headers.get("cdn-cache-control")).toContain(
        "max-age=300",
      );
      expect(followed.headers.get("vary")).toContain("Origin");
      const fresh = await followed.json();
      expect(fresh.offers).toHaveLength(2);

      const cached = await fetch(followed.url, { headers });
      const etag = cached.headers.get("etag");
      expect(etag).toBeTruthy();
      expect(await cached.json()).toEqual({
        ...fresh,
        meta: { ...fresh.meta, cached: true },
      });
      const conditional = await fetch(followed.url, {
        headers: { ...headers, "If-None-Match": etag ?? "" },
      });
      expect(conditional.status).toBe(304);
      expect(await conditional.text()).toBe("");
      expect(mocks.opensearchSearch).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.each([
    "a,b",
    "a+b",
    "a&b=c#d",
    "%2C",
    "[brackets]",
    "\u65e5\u672c\u8a9e",
    "\ud83c\udfae",
  ])("preserves special characters across POST to GET: %s", async (value) => {
    const response = await requestFollowingRedirect(app, "/search/v2/search", {
      method: "POST",
      body: JSON.stringify({
        title: value,
        technologies: [value],
        seller: value,
      }),
    });
    expect(response.status).toBe(200);
    const query = mocks.opensearchSearch.mock.calls[0][0].body.query.bool;
    expect(query.must[0].bool.should[0].multi_match.query).toBe(value);
    expect(query.filter).toContainEqual({
      term: { "seller.id.keyword": value },
    });
    expect(
      query.filter[0].terms_set["lastBuilds.technologies.technology.keyword"]
        .terms,
    ).toEqual([value]);
  });

  it("maps fixture-backed OpenSearch hits through /search/v2/search", async () => {
    const res = await requestFollowingRedirect(
      app,
      "/search/v2/search?country=FR",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 3 }),
      },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
    );
    expect(res.headers.get("cdn-cache-control")).toBe(
      "public, max-age=300, stale-while-revalidate=3600",
    );
    const body = await res.json();

    expect(body.total).toBe(offers.length);
    expect(body.offers).toHaveLength(3);
    expect(body.offers[0]).toMatchObject({
      id: SEA_QA_SMOKE_OFFER_ID,
      namespace: "SeaQA",
      title: offers[0]?.title,
      price: null,
      locale: "en-US",
      localeStatus: "canonical",
    });
    expect(body.offers[0]).toHaveProperty("description");
    expect(body.offers[0]).toHaveProperty("longDescription");
    expect(body.offers[0]).toHaveProperty("tags");
    expect(body.offers[0]).toHaveProperty("items");
    expect(Array.isArray(body.offers[0]?.keyImages)).toBe(true);
    expect(body.meta).toMatchObject({
      ms: 7,
      timed_out: false,
      cached: false,
    });
    expect(mocks.redisSet).toHaveBeenCalledWith(
      expect.stringMatching(/^search:v2:/),
      expect.any(String),
      "EX",
      3600,
    );
  });

  it("serves repeated searches from Redis without querying or rewriting results", async () => {
    const request = () =>
      requestFollowingRedirect(app, "/search/v2/search?country=US", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 3 }),
      });
    const fresh = await request();
    const freshBody = await fresh.json();
    const cached = await request();

    expect(cached.status).toBe(200);
    expect(cached.headers.get("cache-control")).toBe(
      "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
    );
    expect(cached.headers.get("cdn-cache-control")).toBe(
      "public, max-age=300, stale-while-revalidate=3600",
    );
    await expect(cached.json()).resolves.toEqual({
      ...freshBody,
      meta: { ...freshBody.meta, cached: true },
    });
    expect(mocks.opensearchSearch).toHaveBeenCalledTimes(1);
    expect(mocks.redisSet).toHaveBeenCalledTimes(1);
    expect(mocks.sharedGet).not.toHaveBeenCalled();
    expect(mocks.sharedSet).not.toHaveBeenCalled();
    expect(mocks.redisGet).toHaveBeenNthCalledWith(
      1,
      mocks.redisSet.mock.calls[0]?.[0],
    );
    expect(mocks.redisGet).toHaveBeenNthCalledWith(
      2,
      mocks.redisSet.mock.calls[0]?.[0],
    );
  });

  it("isolates cached pages and page sizes and reuses each exact result", async () => {
    const variants = [
      { page: 1, limit: 1 },
      { page: 2, limit: 1 },
      { page: 1, limit: 2 },
    ];

    for (const cached of [false, true]) {
      for (const { page, limit } of variants) {
        const response = await requestFollowingRedirect(
          app,
          "/search/v2/search?country=US",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ page, limit }),
          },
        );
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toMatchObject({ page, limit, meta: { cached } });
        expect(body.offers.map((offer: { id: string }) => offer.id)).toEqual(
          offers
            .slice((page - 1) * limit, page * limit)
            .map((offer) => offer.id),
        );
      }
    }

    expect(mocks.opensearchSearch).toHaveBeenCalledTimes(variants.length);
    expect(mocks.redisSet).toHaveBeenCalledTimes(variants.length);
  });

  it.each([
    [{}, { page: 1, limit: 10 }],
    [
      { page: 0, limit: 101 },
      { page: 1, limit: 100 },
    ],
  ])("shares a cache entry for equivalent normalized pagination: %j and %j", async (first, second) => {
    for (const body of [first, second]) {
      const response = await requestFollowingRedirect(
        app,
        "/search/v2/search?country=US",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      expect(response.status).toBe(200);
    }
    expect(mocks.opensearchSearch).toHaveBeenCalledTimes(1);
    expect(mocks.redisSet).toHaveBeenCalledTimes(1);
  });

  it("keeps regional response caches separate without explicit price filters", async () => {
    for (const country of ["US", "FR", "US", "FR"]) {
      const response = await requestFollowingRedirect(
        app,
        `/search/v2/search?country=${country}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ limit: 1 }),
        },
      );
      expect(response.status).toBe(200);
    }
    expect(mocks.opensearchSearch).toHaveBeenCalledTimes(2);
    expect(mocks.redisSet).toHaveBeenCalledTimes(2);
  });

  it.each([
    { sortBy: "upcoming", sortDir: "desc", boundary: "gte" },
    { sortBy: "releaseDate", sortDir: "asc", boundary: "gte" },
    { sortBy: "releaseDate", sortDir: "desc", boundary: "lte" },
  ])("reuses time-relative searches as the clock advances: $sortBy $sortDir", async ({
    sortBy,
    sortDir,
    boundary,
  }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
    const request = () =>
      requestFollowingRedirect(app, "/search/v2/search?country=US", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sortBy, sortDir, limit: 1 }),
      });

    expect((await request()).status).toBe(200);
    vi.setSystemTime(new Date("2026-10-23T12:00:01Z"));
    const cached = await request();
    await expect(cached.json()).resolves.toMatchObject({
      meta: { cached: true },
    });
    expect(mocks.opensearchSearch).toHaveBeenCalledTimes(1);
    expect(mocks.redisSet).toHaveBeenCalledTimes(1);
    expect(mocks.opensearchSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          query: {
            bool: {
              must: [],
              filter: [{ range: { releaseDate: { [boundary]: "now" } } }],
            },
          },
        }),
      }),
    );
  });

  it("builds deterministic OpenSearch query clauses for region-specific search", async () => {
    await requestFollowingRedirect(app, "/search/v2/search?country=FR", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        price: { min: 0, max: 2000 },
        sortBy: "price",
        sortDir: "desc",
        limit: 5,
      }),
    });

    expect(mocks.opensearchSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        index: "egdata.offers",
        body: expect.objectContaining({
          from: 0,
          size: 5,
          query: {
            bool: {
              must: [],
              filter: [
                {
                  range: {
                    "prices.EURO.price.discountPrice": {
                      gte: 0,
                      lte: 2000,
                    },
                  },
                },
              ],
            },
          },
          sort: [
            {
              "prices.EURO.price.discountPrice": {
                order: "desc",
              },
            },
          ],
        }),
      }),
    );
  });

  it("filters by every selected technology and returns technology facets", async () => {
    const res = await requestFollowingRedirect(
      app,
      "/search/v2/search?country=US",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          technologies: [" Unreal ", "NVIDIA_DLSS", "Unreal"],
          limit: 10,
        }),
      },
    );

    expect(mocks.opensearchSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        index: "egdata.offers",
        body: expect.objectContaining({
          query: {
            bool: {
              must: [],
              filter: [
                {
                  terms_set: {
                    "lastBuilds.technologies.technology.keyword": {
                      terms: ["NVIDIA_DLSS", "Unreal"],
                      minimum_should_match_script: {
                        source: "2",
                      },
                    },
                  },
                },
              ],
            },
          },
          aggregations: expect.objectContaining({
            technologies: {
              terms: {
                field: "lastBuilds.technologies.technology.keyword",
                size: 10_000,
              },
            },
          }),
        }),
      }),
    );

    const body = await res.json();
    expect(body.aggregations.technologies.buckets).toEqual([
      { key: "Unreal", doc_count: 1 },
    ]);
  });

  it("rejects non-array and empty technology filters", async () => {
    for (const technologies of ["Unreal", [" "]]) {
      const res = await requestFollowingRedirect(
        app,
        "/search/v2/search?country=US",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ technologies }),
        },
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        message:
          "Invalid technologies. Provide an array of non-empty technology names.",
      });
    }

    expect(mocks.opensearchSearch).not.toHaveBeenCalled();
  });

  it("queries paginated historical lows with positive regional prices ordered by price update", async () => {
    mocks.opensearchSearch.mockResolvedValueOnce({
      body: {
        took: 7,
        timed_out: false,
        hits: {
          total: { value: 1, relation: "eq" },
          hits: [
            {
              _source: {
                ...offers[0],
                prices: {
                  US: {
                    offerId: offers[0]?.id,
                    region: "US",
                    updatedAt: "2026-07-17T12:00:00.000Z",
                    price: {
                      currencyCode: "USD",
                      originalPrice: 1999,
                      discountPrice: 999,
                      discount: 50,
                    },
                  },
                },
              },
            },
          ],
        },
        aggregations: {},
      },
    });

    const res = await requestFollowingRedirect(
      app,
      "/search/v2/search?country=US",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          isLowestPriceEver: true,
          price: { min: 1 },
          sortBy: "priceUpdatedAt",
          sortDir: "desc",
          page: 1,
          limit: 25,
        }),
      },
    );

    expect(res.status).toBe(200);
    expect(mocks.opensearchSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        index: "egdata.offers",
        body: expect.objectContaining({
          from: 0,
          size: 25,
          query: {
            bool: {
              must: [],
              filter: [
                {
                  range: {
                    "prices.US.price.discountPrice": { gte: 1 },
                  },
                },
                { term: { isHistoricalLowestEverUS: true } },
                {
                  range: {
                    "prices.US.price.discount": { gt: 0 },
                  },
                },
              ],
            },
          },
          sort: [
            {
              "prices.US.updatedAt": { order: "desc" },
            },
          ],
        }),
      }),
    );

    const body = await res.json();
    expect(body.offers[0]).toMatchObject({
      offerType: offers[0]?.offerType,
      price: {
        region: "US",
        updatedAt: "2026-07-17T12:00:00.000Z",
        price: {
          discountPrice: 999,
        },
      },
    });
  });

  it("falls back unknown countries to the US price region", async () => {
    await requestFollowingRedirect(app, "/search/v2/search?country=ZZ", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 1 }),
    });

    expect(mocks.opensearchSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          aggregations: expect.objectContaining({
            price_stats: {
              stats: { field: "prices.US.price.discountPrice" },
            },
          }),
        }),
      }),
    );
  });

  it("defaults to full facets, including developer, publisher and seller aggregations", async () => {
    const res = await requestFollowingRedirect(
      app,
      "/search/v2/search?country=US",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 2 }),
      },
    );

    expect(res.status).toBe(200);
    const request = mocks.opensearchSearch.mock.calls[0]?.[0];
    expect(request.body.aggregations).toEqual({
      offerType: { terms: { field: "offerType.keyword", size: 100 } },
      technologies: {
        terms: {
          field: "lastBuilds.technologies.technology.keyword",
          size: 10_000,
        },
      },
      price_stats: { stats: { field: "prices.US.price.discountPrice" } },
      tags: { terms: { field: "tags.name.keyword", size: 10_000 } },
      developer: {
        terms: { field: "developerDisplayName.keyword", size: 1000 },
      },
      publisher: {
        terms: { field: "publisherDisplayName.keyword", size: 1000 },
      },
      seller: { terms: { field: "seller.name.keyword", size: 1000 } },
    });

    const body = await res.json();
    expect(Object.keys(body.aggregations).sort()).toEqual(
      [
        "offerType",
        "technologies",
        "price_stats",
        "tags",
        "developer",
        "publisher",
        "seller",
      ].sort(),
    );
  });

  it("returns minimal facets when explicitly requested", async () => {
    const res = await requestFollowingRedirect(
      app,
      "/search/v2/search?country=US",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 2, facets: "minimal" }),
      },
    );

    expect(res.status).toBe(200);
    expect(mocks.opensearchSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          aggregations: {
            offerType: { terms: { field: "offerType.keyword", size: 100 } },
            technologies: {
              terms: {
                field: "lastBuilds.technologies.technology.keyword",
                size: 1000,
              },
            },
            price_stats: {
              stats: { field: "prices.US.price.discountPrice" },
            },
          },
        }),
      }),
    );

    const body = await res.json();
    expect(Object.keys(body.aggregations).sort()).toEqual(
      ["offerType", "technologies", "price_stats"].sort(),
    );
  });

  it("omits the aggregations request and response when facets=none", async () => {
    const res = await requestFollowingRedirect(
      app,
      "/search/v2/search?country=US",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 1, facets: "none" }),
      },
    );

    expect(res.status).toBe(200);
    const request = mocks.opensearchSearch.mock.calls[0]?.[0];
    expect(request.body).not.toHaveProperty("aggregations");
    await expect(res.json()).resolves.toMatchObject({ aggregations: {} });
  });

  it("keeps facet modes in separate response cache entries", async () => {
    for (const facets of ["minimal", "full", "none"]) {
      const res = await requestFollowingRedirect(
        app,
        "/search/v2/search?country=US",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ limit: 1, facets }),
        },
      );
      expect(res.status).toBe(200);
    }

    expect(mocks.opensearchSearch).toHaveBeenCalledTimes(3);
    expect(mocks.redisSet).toHaveBeenCalledTimes(3);
  });

  it("serves the same results through GET and POST /search/v2/search", async () => {
    const getResponse = await requestFollowingRedirect(
      app,
      "/search/v2/search?country=US&limit=2&page=1&sortBy=releaseDate&sortDir=desc",
    );
    const postResponse = await requestFollowingRedirect(
      app,
      "/search/v2/search?country=US",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          limit: 2,
          page: 1,
          sortBy: "releaseDate",
          sortDir: "desc",
        }),
      },
    );

    expect(getResponse.status).toBe(200);
    expect(postResponse.status).toBe(200);
    const getBody = await getResponse.json();
    const postBody = await postResponse.json();

    expect(getBody).toMatchObject({ page: 1, limit: 2 });
    expect(getBody.total).toBe(postBody.total);
    expect(getBody.offers).toEqual(postBody.offers);
    expect(mocks.opensearchSearch).toHaveBeenCalledTimes(1);
    expect(mocks.opensearchSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ from: 0, size: 2 }),
      }),
    );
  });

  it("records traversal once on GET and after following a POST redirect", async () => {
    const recorded = vi.fn();
    const observed = new Hono();
    observed.use("*", async (c, next) => {
      c.set("antiAbuseCatalog", recorded);
      await next();
    });
    observed.route("/search", SearchRoute);
    mocks.redisGet.mockResolvedValue(
      JSON.stringify({ elements: [], page: 2, limit: 50, total: 0, meta: {} }),
    );
    const get = await requestFollowingRedirect(
      observed,
      "/search/v2/search?title=game&page=2&limit=50&tracking=ignored",
    );
    const post = await requestFollowingRedirect(observed, "/search/v2/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "game",
        page: 3,
        limit: 50,
        unknown: "ignored",
      }),
    });
    expect(get.status).toBe(200);
    expect(post.status).toBe(200);
    expect(recorded).toHaveBeenCalledTimes(2);
    expect(recorded.mock.calls[0][0].route).toBe(
      recorded.mock.calls[1][0].route,
    );
    expect(recorded.mock.calls.map(([feature]) => feature.page)).toEqual([
      2, 3,
    ]);
    expect(
      recorded.mock.calls.every(([feature]) => feature.cacheHit === true),
    ).toBe(true);
    expect(recorded.mock.calls[0][0].titleHash).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.opensearchSearch).not.toHaveBeenCalled();
    mocks.redisGet.mockResolvedValueOnce(null);
    await requestFollowingRedirect(
      observed,
      "/search/v2/search?title=other-game&page=1&limit=12",
    );
    expect(recorded.mock.calls[2][0].cacheHit).toBe(false);
    expect(mocks.opensearchSearch).toHaveBeenCalledTimes(1);
  });

  it("maps GET query parameters into the search body", async () => {
    await requestFollowingRedirect(
      app,
      "/search/v2/search?country=FR&tags=Action,RPG&technologies=Unreal,NVIDIA_DLSS&priceMin=0&priceMax=2000&onSale=true&excludeBlockchain=true&limit=5&page=2",
    );

    expect(mocks.opensearchSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          from: 5,
          size: 5,
          query: {
            bool: {
              must: [],
              filter: [
                {
                  terms_set: {
                    "tags.id.keyword": {
                      terms: ["Action", "RPG"],
                      minimum_should_match_script: { source: "2" },
                    },
                  },
                },
                {
                  terms_set: {
                    "lastBuilds.technologies.technology.keyword": {
                      terms: ["NVIDIA_DLSS", "Unreal"],
                      minimum_should_match_script: { source: "2" },
                    },
                  },
                },
                {
                  bool: {
                    must_not: [
                      { term: { "customAttributes.isBlockchainUsed": true } },
                    ],
                  },
                },
                {
                  range: {
                    "prices.EURO.price.discountPrice": { gte: 0, lte: 2000 },
                  },
                },
                {
                  range: { "prices.EURO.price.discount": { gt: 0 } },
                },
              ],
            },
          },
        }),
      }),
    );
  });

  it("returns full offer fields by default and when expand=true", async () => {
    const expanded = await requestFollowingRedirect(
      app,
      "/search/v2/search?country=US&expand=true",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 2 }),
      },
    );

    expect(expanded.status).toBe(200);
    const expandedBody = await expanded.json();
    expect(expandedBody.offers[0]).toMatchObject({
      id: SEA_QA_SMOKE_OFFER_ID,
      description: offers[0]?.description,
      price: null,
    });
    expect(expandedBody.offers[0]).toHaveProperty("longDescription");
    expect(expandedBody.offers[0]).toHaveProperty("tags");
    expect(expandedBody.offers[0]).toHaveProperty("items");
    expect(expandedBody.offers[0]).toHaveProperty("customAttributes");

    const defaultResponse = await requestFollowingRedirect(
      app,
      "/search/v2/search?country=US",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 2 }),
      },
    );
    const defaultBody = await defaultResponse.json();
    expect(defaultBody.offers[0]).toHaveProperty("description");
    expect(defaultBody.offers[0]).toHaveProperty("longDescription");
    expect(defaultBody.offers[0]).toHaveProperty("tags");
    expect(defaultBody.offers[0]).toHaveProperty("items");
    expect(mocks.opensearchSearch).toHaveBeenCalledTimes(2);
    expect(mocks.redisSet).toHaveBeenCalledTimes(2);
  });

  it("retires the legacy search endpoint with 410 without touching backends", async () => {
    const responses = [
      await requestFollowingRedirect(app, "/search"),
      await requestFollowingRedirect(app, "/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 1 }),
      }),
    ];

    for (const res of responses) {
      expect(res.status).toBe(410);
      expect(res.headers.get("cache-control")).toBe("no-store");
      await expect(res.json()).resolves.toEqual({
        error: {
          code: "DEPRECATED",
          message: "Use /search/v2/search instead.",
        },
      });
    }

    expect(mocks.opensearchSearch).not.toHaveBeenCalled();
    expect(mocks.redisGet).not.toHaveBeenCalled();
    expect(mocks.sharedGet).not.toHaveBeenCalled();
  });

  it("hydrates ranked natural-language matches from MongoDB", async () => {
    const vectorId = "2747423799";
    const offer = { ...offers[0], _id: "507f1f77bcf86cd799439011" };
    mocks.vectorizeSearch.mockResolvedValueOnce([
      {
        id: vectorId,
        score: 0.91,
        metadata: { id: offers[0]?.id, title: "Stale title" },
      },
    ]);
    vi.spyOn(Offer, "find").mockReturnValue(
      Promise.resolve([offer]) as unknown as ReturnType<typeof Offer.find>,
    );

    const res = await requestFollowingRedirect(
      app,
      "/search/natural-language",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "  open world adventure  ", topK: 5 }),
      },
    );

    expect(res.status).toBe(200);
    expect(mocks.vectorizeSearch).toHaveBeenCalledWith(
      "open world adventure",
      5,
    );
    expect(Offer.find).toHaveBeenCalledWith({
      id: { $in: [offers[0]?.id] },
    });
    await expect(res.json()).resolves.toMatchObject({
      query: "open world adventure",
      count: 1,
      matches: [
        {
          score: 0.91,
          offer: {
            id: offers[0]?.id,
            title: offers[0]?.title,
            locale: "en-US",
            localeStatus: "canonical",
          },
        },
      ],
    });
  });

  it("rejects invalid natural-language search bodies before querying Cloudflare", async () => {
    const res = await requestFollowingRedirect(
      app,
      "/search/natural-language",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "", topK: 51 }),
      },
    );

    expect(res.status).toBe(400);
    expect(mocks.vectorizeSearch).not.toHaveBeenCalled();
  });

  it("hydrates /search/changelog old and new values from Mongo", async () => {
    const id = "6a2ac641bfc3cf2a0efc8507";
    mocks.opensearchSearch
      .mockResolvedValueOnce(changelogSearchResponse([]))
      .mockResolvedValueOnce(changelogSearchResponse([]))
      .mockResolvedValueOnce(
        changelogSearchResponse([
          {
            _id: id,
            _source: {
              timestamp: "2026-06-11T14:29:00.000Z",
              metadata: {
                contextType: "product-home",
                contextId: "home-page",
                changes: [
                  {
                    changeType: "update",
                    field: "hero",
                    oldValue: null,
                    newValue: null,
                    oldValueRaw: '{"title":"indexed old"}',
                    newValueRaw: '{"title":"indexed new"}',
                  },
                ],
              },
            },
          },
        ]),
      );
    mockChangelogFind([
      {
        _id: id,
        metadata: {
          changes: [
            {
              changeType: "update",
              field: "hero",
              oldValue: { title: "mongo old" },
              newValue: { title: "mongo new" },
            },
          ],
        },
        toObject() {
          return this;
        },
      },
    ]);

    const res = await requestFollowingRedirect(
      app,
      "/search/changelog?query=home&page=1&limit=1",
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    const change = body.hits[0].metadata.changes[0];
    expect(change.oldValue).toEqual({ title: "mongo old" });
    expect(change.newValue).toEqual({ title: "mongo new" });
    expect(change.oldValueRaw).toBe('{"title":"indexed old"}');
    expect(change.newValueRaw).toBe('{"title":"indexed new"}');
  });

  it("reads empty changelog searches from Mongo so the latest changes are not delayed by indexing", async () => {
    const newestChange = {
      _id: "6a5e74230af20ca5b80b9684",
      timestamp: "2026-07-20T19:16:51.316Z",
      metadata: {
        contextType: "unknown",
        contextId: "latest-change",
        changes: [],
      },
      toObject() {
        return {
          _id: this._id,
          timestamp: this.timestamp,
          metadata: this.metadata,
        };
      },
    };
    mockChangelogFind([newestChange]);
    vi.spyOn(Changelog, "countDocuments").mockResolvedValue(1);

    const res = await requestFollowingRedirect(
      app,
      "/search/changelog?query=&page=1&limit=1",
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      hits: [
        {
          _id: newestChange._id,
          timestamp: newestChange.timestamp,
        },
      ],
      estimatedTotalHits: 1,
      query: "",
    });
    expect(Changelog.find).toHaveBeenCalledWith(
      { "metadata.contextType": { $nin: ["file", "achievements"] } },
      undefined,
      { sort: { timestamp: -1 }, skip: 0, limit: 1 },
    );
    expect(mocks.opensearchSearch).not.toHaveBeenCalled();
  });

  it("hydrates /search/changelog values from raw OpenSearch values", async () => {
    const id = "6a2abf73cdd9e513e4910af0";
    mocks.opensearchSearch
      .mockResolvedValueOnce(changelogSearchResponse([]))
      .mockResolvedValueOnce(changelogSearchResponse([]))
      .mockResolvedValueOnce(
        changelogSearchResponse([
          {
            _id: id,
            _source: {
              timestamp: "2026-06-11T14:00:00.000Z",
              metadata: {
                contextType: "product-home",
                contextId: "home-page",
                changes: [
                  {
                    changeType: "update",
                    field: "array",
                    oldValue: null,
                    newValue: null,
                    oldValueRaw: "[1,2]",
                    newValueRaw: '{"ok":true}',
                  },
                  {
                    changeType: "update",
                    field: "string",
                    oldValue: null,
                    newValue: null,
                    oldValueRaw: '"quoted"',
                    newValueRaw: "plain text",
                  },
                  {
                    changeType: "delete",
                    field: "removed",
                    oldValue: null,
                    newValue: null,
                    oldValueRaw: "42",
                    newValueRaw: null,
                  },
                ],
              },
            },
          },
        ]),
      );
    mockChangelogFind([]);

    const res = await requestFollowingRedirect(
      app,
      "/search/changelog?query=home&page=1&limit=1",
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    const [arrayChange, stringChange, deleteChange] =
      body.hits[0].metadata.changes;
    expect(arrayChange.oldValue).toEqual([1, 2]);
    expect(arrayChange.newValue).toEqual({ ok: true });
    expect(stringChange.oldValue).toBe("quoted");
    expect(stringChange.newValue).toBe("plain text");
    expect(deleteChange.oldValue).toBe(42);
    expect(deleteChange.newValue).toBeNull();
    expect(arrayChange.oldValueRaw).toBe("[1,2]");
  });

  it("keeps /search/changelog available when document enrichment fails", async () => {
    const id = "6a2abf73cdd9e513e4910af1";
    mocks.opensearchSearch
      .mockResolvedValueOnce(changelogSearchResponse([]))
      .mockResolvedValueOnce(changelogSearchResponse([]))
      .mockResolvedValueOnce(
        changelogSearchResponse([
          {
            _id: id,
            _source: {
              timestamp: "2026-06-11T14:00:00.000Z",
              metadata: {
                contextType: "offer",
                contextId: "offer-1",
                changes: [],
              },
            },
          },
        ]),
      );
    mockChangelogFind([]);
    vi.spyOn(Offer, "findOne").mockRejectedValue(new Error("lookup timed out"));

    const res = await requestFollowingRedirect(
      app,
      "/search/changelog?query=offer&page=1&limit=1",
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.hits[0].document).toBeNull();
  });
});
