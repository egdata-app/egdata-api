import { Hono } from "hono";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import SearchRoute from "../src/routes/search.js";
import { loadSeaQaOffers, type SeaQaOffer } from "./fixtures/seaqa.js";

type OpenSearchRequest = {
  body: {
    from?: number;
    size?: number;
  };
};

const mocks = vi.hoisted(() => ({
  opensearchSearch: vi.fn(),
  redisSet: vi.fn(),
}));

vi.mock("../src/clients/opensearch.js", () => ({
  opensearch: {
    search: mocks.opensearchSearch,
  },
}));

vi.mock("../src/clients/redis.js", () => ({
  default: {
    get: vi.fn(),
    set: mocks.redisSet,
  },
}));

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
    mocks.redisSet.mockReset();
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
  });

  it("maps fixture-backed OpenSearch hits through /search/v2/search", async () => {
    const res = await app.request("/search/v2/search?country=FR", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 3 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.total).toBe(offers.length);
    expect(body.offers).toHaveLength(3);
    expect(body.offers[0]).toMatchObject({
      id: offers[0]?.id,
      namespace: "SeaQA",
      customAttributes: {
        grade: {
          type: "STRING",
          value: "9C804681A7",
        },
      },
      price: null,
    });
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

  it("builds deterministic OpenSearch query clauses for region-specific search", async () => {
    await app.request("/search/v2/search?country=FR", {
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

  it("falls back unknown countries to the US price region", async () => {
    await app.request("/search/v2/search?country=ZZ", {
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
});
