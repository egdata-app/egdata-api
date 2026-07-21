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
  redisSet: vi.fn(),
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
      Promise.resolve(documents) as unknown as ReturnType<typeof Changelog.find>,
    );

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

vi.mock("../src/clients/vectorize.js", () => ({
  CloudflareVectorizeError: class CloudflareVectorizeError extends Error {},
  VectorizeConfigurationError: class VectorizeConfigurationError extends Error {},
  queryOffersWithNaturalLanguage: mocks.vectorizeSearch,
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
      id: SEA_QA_SMOKE_OFFER_ID,
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

    const res = await app.request("/search/v2/search?country=US", {
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
    });

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

    const res = await app.request("/search/natural-language", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "  open world adventure  ", topK: 5 }),
    });

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
    const res = await app.request("/search/natural-language", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "", topK: 51 }),
    });

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

    const res = await app.request("/search/changelog?query=home&page=1&limit=1");
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

    const res = await app.request("/search/changelog?query=&page=1&limit=1");

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

    const res = await app.request("/search/changelog?query=home&page=1&limit=1");
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

    const res = await app.request("/search/changelog?query=offer&page=1&limit=1");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.hits[0].document).toBeNull();
  });
});
