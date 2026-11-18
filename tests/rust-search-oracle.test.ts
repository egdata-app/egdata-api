import { Hono } from "hono";
import { BSON } from "mongodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertOracle, captureResponse } from "../rust/oracles/record.js";
import { encodeCursor } from "../src/v1/cursor.js";
import { ProblemError, problemResponse } from "../src/v1/errors.js";
import type { V1Variables } from "../src/v1/request-context.js";
import MultiSearchRoute from "../src/v1/routes/multisearch.js";
import SearchRoute from "../src/v1/routes/search.js";
import { responseEtag } from "../src/middlewares/response-etag.js";

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  findOffers: vi.fn(),
  findSellers: vi.fn(),
  aggregate: vi.fn(),
  findTags: vi.fn(),
  findChangelog: vi.fn(),
  cacheGet: vi.fn(),
  savedQueryGet: vi.fn(),
  cacheSet: vi.fn(),
  vectorSearch: vi.fn(),
  localized: vi.fn(),
}));
vi.mock("../src/db/index.js", () => ({
  db: {
    db: {
      collection: () => ({
        find: (query: unknown) => ({ toArray: () => mocks.localized(query) }),
      }),
    },
  },
}));

vi.mock("../src/clients/opensearch.js", () => ({
  opensearch: { search: mocks.search },
}));
vi.mock("../src/clients/response-cache.js", () => ({
  default: { get: mocks.cacheGet, set: mocks.cacheSet },
}));
vi.mock("../src/clients/redis.js", () => ({
  default: { get: mocks.savedQueryGet, set: mocks.cacheSet },
}));
vi.mock("../src/clients/vectorize.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/clients/vectorize.js")>()),
  queryOffersWithNaturalLanguage: mocks.vectorSearch,
}));
vi.mock("../src/models/index.js", () => ({
  Offer: { find: mocks.findOffers, aggregate: mocks.aggregate },
  Seller: { find: mocks.findSellers },
  Changelog: { find: mocks.findChangelog },
  TagModel: { find: mocks.findTags },
}));

const app = new Hono<{ Variables: V1Variables }>();
let useResponseEtag = false;
app.use("*", (c, next) => (useResponseEtag ? responseEtag(c, next) : next()));
app.use("*", async (c, next) => {
  c.set("requestId", "req_node_oracle");
  await next();
});
app.route("/v1", SearchRoute);
app.route("/v1", MultiSearchRoute);
app.onError((error, c) =>
  problemResponse(
    c,
    error instanceof ProblemError
      ? error
      : new ProblemError({
          status: 500,
          code: "INTERNAL_ERROR",
          detail:
            "The API could not complete the request. Retry later and include the request ID when contacting support.",
        }),
  ),
);

describe("Rust search HTTP Node oracle", () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    mocks.search.mockReset();
    mocks.findOffers.mockReset();
    mocks.findSellers.mockReset();
    mocks.aggregate.mockReset();
    mocks.findTags.mockReset();
    mocks.findChangelog.mockReset();
    mocks.cacheGet.mockReset().mockResolvedValue(null);
    mocks.savedQueryGet.mockReset().mockResolvedValue(null);
    mocks.cacheSet.mockReset().mockResolvedValue("OK");
    mocks.vectorSearch.mockReset();
    mocks.localized.mockReset().mockResolvedValue([]);
  });

  it("records canonical search and multisearch handler responses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-17T00:00:00.000Z"));
    const cases = [] as Array<Record<string, unknown>>;
    const record = async (
      name: string,
      method: string,
      path: string,
      body?: unknown,
      input: unknown = {},
      options: { contentType?: string | null; rawBody?: string } = {},
    ) => {
      const searchCallsBefore = mocks.search.mock.calls.length;
      const localizationsBefore = mocks.localized.mock.calls.length;
      const cacheWritesBefore = mocks.cacheSet.mock.calls.length;
      const cacheReadsBefore = mocks.cacheGet.mock.calls.length;
      const savedReadsBefore = mocks.savedQueryGet.mock.calls.length;
      const aggregateCallsBefore = mocks.aggregate.mock.calls.length;
      const tagsCallsBefore = mocks.findTags.mock.calls.length;
      const changelogCallsBefore = mocks.findChangelog.mock.calls.length;
      const offerCallsBefore = mocks.findOffers.mock.calls.length;
      const sellerCallsBefore = mocks.findSellers.mock.calls.length;
      const contentType = Object.hasOwn(options, "contentType")
        ? options.contentType
        : body === undefined && options.rawBody === undefined
          ? undefined
          : "application/json";
      const request = {
        method,
        path,
        ...(body === undefined ? {} : { body }),
        ...(options.rawBody === undefined ? {} : { rawBody: options.rawBody }),
        ...(contentType === undefined ? {} : { contentType }),
      };
      const conditional = (input as { ifNoneMatch?: string }).ifNoneMatch;
      useResponseEtag =
        (input as { captureEtag?: boolean }).captureEtag === true;
      const response = await app.request(path, {
        method,
        headers: {
          "x-request-id": "req_node_oracle",
          ...(conditional ? { "if-none-match": conditional } : {}),
          ...(contentType === undefined || contentType === null
            ? {}
            : { "content-type": contentType }),
        },
        ...(options.rawBody !== undefined
          ? {
              body:
                contentType === null
                  ? new TextEncoder().encode(options.rawBody)
                  : options.rawBody,
            }
          : body === undefined
            ? {}
            : { body: JSON.stringify(body) }),
      });
      const actualInput = { ...(input as Record<string, unknown>) };
      if (mocks.localized.mock.calls.length > localizationsBefore)
        actualInput.localizationFilter = mocks.localized.mock.calls.at(-1)?.[0];
      if (mocks.search.mock.calls.length > searchCallsBefore) {
        actualInput.opensearchRequest = mocks.search.mock.calls.at(-1)?.[0];
        actualInput.opensearchCalled = true;
      } else actualInput.opensearchCalled = false;
      if (mocks.cacheSet.mock.calls.length > cacheWritesBefore) {
        const write = mocks.cacheSet.mock.calls.at(-1);
        actualInput.cacheWriteKey = write?.[0];
        actualInput.cacheWriteValue = write?.[1];
        actualInput.cacheWriteTtl = write?.[3];
      }
      if (mocks.cacheGet.mock.calls.length > cacheReadsBefore)
        actualInput.cacheReadKeys = mocks.cacheGet.mock.calls
          .slice(cacheReadsBefore)
          .map((call) => call[0]);
      if (mocks.savedQueryGet.mock.calls.length > savedReadsBefore)
        actualInput.savedQueryReadKeys = mocks.savedQueryGet.mock.calls
          .slice(savedReadsBefore)
          .map((call) => call[0]);
      if (mocks.aggregate.mock.calls.length > aggregateCallsBefore)
        actualInput.aggregatePipeline = JSON.parse(
          JSON.stringify(mocks.aggregate.mock.calls.at(-1)?.[0], (_, v) =>
            v instanceof RegExp
              ? { $regularExpression: { pattern: v.source, options: v.flags } }
              : v,
          ),
        );
      actualInput.aggregateCalled =
        mocks.aggregate.mock.calls.length > aggregateCallsBefore;
      if (mocks.findTags.mock.calls.length > tagsCallsBefore)
        actualInput.tagsFindQuery = mocks.findTags.mock.calls.at(-1)?.[0];
      if (mocks.findChangelog.mock.calls.length > changelogCallsBefore) {
        const [filter, ...options] = mocks.findChangelog.mock.calls.at(-1)!;
        actualInput.changelogFindArgs = [
          BSON.deserialize(BSON.serialize(filter, { ignoreUndefined: false })),
          ...options,
        ];
      }
      if (mocks.findOffers.mock.calls.length > offerCallsBefore)
        actualInput.offerFindFilter = mocks.findOffers.mock.calls.at(-1)?.[0];
      if (mocks.findSellers.mock.calls.length > sellerCallsBefore)
        actualInput.sellerFindFilter = mocks.findSellers.mock.calls.at(-1)?.[0];
      cases.push({
        name,
        request,
        input: actualInput,
        response: await captureResponse(response),
      });
    };

    mocks.vectorSearch.mockResolvedValue([]);
    await record(
      "natural_language_empty_success",
      "POST",
      "/v1/search/natural-language?locale=de-de",
      { query: "  role playing  ", topK: 2 },
      { vectorMatches: [] },
    );
    await record(
      "natural_language_invalid_body",
      "POST",
      "/v1/search/natural-language",
      { query: "rpg", extra: true },
    );

    const vectorMatches = [
      { id: "vector-hit", score: 0.91, metadata: { id: "offer-a" } },
    ];
    const offers = [
      {
        _id: "offer-a",
        id: "offer-a",
        title: "Localized Game",
        offerType: "BASE_GAME",
        customAttributes: [],
      },
    ];
    mocks.vectorSearch.mockResolvedValue(vectorMatches);
    mocks.findOffers.mockReturnValue({ lean: vi.fn(async () => offers) });
    await record(
      "natural_language_ranked_fallback_locale",
      "POST",
      "/v1/search/natural-language?locale=de-DE",
      { query: "role playing" },
      { vectorMatches, mongoRows: offers },
    );

    mocks.search.mockResolvedValue({
      body: {
        took: 4,
        timed_out: false,
        hits: {
          hits: [
            {
              _source: {
                id: "item-a",
                title: "Item A",
                entitlementType: "DURABLE",
                customAttributes: [{ key: "rarity", value: "rare" }],
              },
              sort: ["2026-01-02T00:00:00Z", "item-a"],
            },
          ],
        },
      },
    });
    const itemResponse = {
      took: 4,
      timed_out: false,
      hits: {
        hits: [
          {
            _source: {
              id: "item-a",
              title: "Item A",
              entitlementType: "DURABLE",
              customAttributes: [{ key: "rarity", value: "rare" }],
            },
            sort: ["2026-01-02T00:00:00Z", "item-a"],
          },
        ],
      },
    };
    mocks.search.mockResolvedValue({ body: itemResponse });
    await record(
      "multisearch_items_serialized_success",
      "GET",
      "/v1/multisearch/items?query=item&limit=1",
      undefined,
      { opensearchResponse: itemResponse },
    );
    await record(
      "multisearch_items_rejects_unknown_query",
      "GET",
      "/v1/multisearch/items?query=item&unexpected=1",
    );

    const sellerResponse = {
      took: 6,
      timed_out: true,
      aggregations: {
        sellers: {
          buckets: [
            { key: "seller-a" },
            { key: "seller-b" },
            { key: "missing" },
          ],
        },
      },
    };
    const sellers = [
      {
        _id: "seller-b",
        name: "Seller B",
        slug: "seller-b",
        externalId: "external-b",
      },
      {
        _id: "seller-a",
        name: "Seller A",
        slug: "seller-a",
        externalId: "external-a",
      },
    ];
    mocks.search.mockResolvedValue({ body: sellerResponse });
    mocks.findSellers.mockReturnValue({ lean: vi.fn(async () => sellers) });
    await record(
      "multisearch_sellers_aggregated_success",
      "GET",
      "/v1/multisearch/sellers?query=seller&limit=5",
      undefined,
      { opensearchResponse: sellerResponse, mongoRows: sellers },
    );
    const sellerWritePayload = (cases.at(-1)?.input as Record<string, unknown>)
      .cacheWriteValue as string;
    mocks.cacheGet.mockReset().mockResolvedValue(sellerWritePayload);
    await record(
      "multisearch_sellers_cache_hit_from_prior_write",
      "GET",
      "/v1/multisearch/sellers?query=seller&limit=5",
      undefined,
      { cachePayload: sellerWritePayload },
    );
    mocks.cacheGet.mockReset().mockResolvedValue(null);

    mocks.search.mockResolvedValue({
      body: { took: 0, aggregations: { sellers: { buckets: [] } } },
    });
    mocks.findSellers.mockReturnValue({ lean: vi.fn(async () => []) });
    await record(
      "multisearch_sellers_default_limit",
      "GET",
      "/v1/multisearch/sellers",
      undefined,
      {
        opensearchResponse: {
          took: 0,
          aggregations: { sellers: { buckets: [] } },
        },
        mongoRows: [],
      },
    );
    await record(
      "multisearch_sellers_parseint_limit",
      "GET",
      "/v1/multisearch/sellers?limit=7tail",
      undefined,
      {
        opensearchResponse: {
          took: 0,
          aggregations: { sellers: { buckets: [] } },
        },
        mongoRows: [],
      },
    );
    await record(
      "multisearch_sellers_zero_limit_defaults",
      "GET",
      "/v1/multisearch/sellers?limit=0",
      undefined,
      {
        opensearchResponse: {
          took: 0,
          aggregations: { sellers: { buckets: [] } },
        },
        mongoRows: [],
      },
    );
    await record(
      "multisearch_sellers_huge_limit_caps",
      "GET",
      `/v1/multisearch/sellers?limit=${"9".repeat(100)}`,
      undefined,
      {
        opensearchResponse: {
          took: 0,
          aggregations: { sellers: { buckets: [] } },
        },
        mongoRows: [],
      },
    );
    await record(
      "multisearch_sellers_negative_huge_limit",
      "GET",
      `/v1/multisearch/sellers?limit=-${"9".repeat(400)}`,
      undefined,
      {
        opensearchResponse: {
          took: 0,
          aggregations: { sellers: { buckets: [] } },
        },
        mongoRows: [],
      },
    );
    await record(
      "multisearch_sellers_bom_limit_whitespace",
      "GET",
      "/v1/multisearch/sellers?limit=%EF%BB%BF7",
      undefined,
      {
        opensearchResponse: {
          took: 0,
          aggregations: { sellers: { buckets: [] } },
        },
        mongoRows: [],
      },
    );
    await record(
      "multisearch_sellers_nel_limit_whitespace",
      "GET",
      "/v1/multisearch/sellers?limit=%C2%857",
      undefined,
      {
        opensearchResponse: {
          took: 0,
          aggregations: { sellers: { buckets: [] } },
        },
        mongoRows: [],
      },
    );
    await record(
      "multisearch_sellers_empty_query_match_all",
      "GET",
      "/v1/multisearch/sellers?query=",
      undefined,
      {
        opensearchResponse: {
          took: 0,
          aggregations: { sellers: { buckets: [] } },
        },
        mongoRows: [],
      },
    );
    await record(
      "multisearch_sellers_rejects_long_query",
      "GET",
      `/v1/multisearch/sellers?query=${"x".repeat(301)}`,
    );

    const sellerCache = JSON.stringify({
      hits: [
        {
          id: "cached-seller",
          name: "Cached Seller",
          slug: "cached-seller",
          externalId: "c",
        },
      ],
      result: { tookMs: 11, timedOut: false },
    });
    mocks.cacheGet.mockResolvedValue(sellerCache);
    await record(
      "multisearch_sellers_cache_hit",
      "GET",
      "/v1/multisearch/sellers?query=cached",
      undefined,
      { cachePayload: sellerCache },
    );
    mocks.cacheGet.mockResolvedValue("not json");
    mocks.search.mockResolvedValue({
      body: { took: 2, aggregations: { sellers: { buckets: [] } } },
    });
    mocks.findSellers.mockReturnValue({ lean: vi.fn(async () => []) });
    await record(
      "multisearch_sellers_malformed_cache",
      "GET",
      "/v1/multisearch/sellers?query=malformed",
      undefined,
      {
        cachePayload: "not json",
        opensearchResponse: {
          took: 2,
          aggregations: { sellers: { buckets: [] } },
        },
        mongoRows: [],
      },
    );
    mocks.cacheGet.mockRejectedValue(new Error("cache unavailable"));
    await record(
      "multisearch_sellers_cache_read_failure",
      "GET",
      "/v1/multisearch/sellers?query=read-failure",
      undefined,
      {
        cacheReadFailure: true,
        opensearchResponse: {
          took: 2,
          aggregations: { sellers: { buckets: [] } },
        },
        mongoRows: [],
      },
    );
    mocks.cacheGet.mockResolvedValue(null);
    mocks.cacheSet.mockRejectedValue(new Error("cache unavailable"));
    await record(
      "multisearch_sellers_cache_write_failure",
      "GET",
      "/v1/multisearch/sellers?query=write-failure",
      undefined,
      {
        cacheWriteFailure: true,
        opensearchResponse: {
          took: 2,
          aggregations: { sellers: { buckets: [] } },
        },
        mongoRows: [],
      },
    );
    mocks.cacheSet.mockResolvedValue("OK");
    mocks.search.mockRejectedValue(new Error("opensearch unavailable"));
    await record(
      "multisearch_sellers_service_unavailable",
      "GET",
      "/v1/multisearch/sellers?query=error",
      undefined,
      { opensearchError: "unavailable" },
    );
    mocks.search.mockResolvedValue({
      body: {
        took: 2,
        aggregations: { sellers: { buckets: [{ key: "seller-x" }] } },
      },
    });
    mocks.findSellers.mockReturnValue({
      lean: vi.fn(async () => {
        throw new Error("mongo unavailable");
      }),
    });
    await record(
      "multisearch_sellers_database_error",
      "GET",
      "/v1/multisearch/sellers?query=db-error",
      undefined,
      {
        opensearchResponse: {
          took: 2,
          aggregations: { sellers: { buckets: [{ key: "seller-x" }] } },
        },
        mongoError: "unavailable",
      },
    );
    mocks.search.mockRejectedValue(new Error("opensearch unavailable"));
    await record(
      "multisearch_items_service_unavailable",
      "GET",
      "/v1/multisearch/items?query=error",
      undefined,
      { opensearchError: "unavailable" },
    );

    await record("search_redirect_canonicalizes_filter", "POST", "/v1/search", {
      title: "  test game ",
      tags: ["b", "a", "a"],
      technologies: ["x,y"],
      limit: 5,
      country: "de",
      locale: "de-de",
    });
    await record(
      "search_redirect_rejects_unknown_field",
      "POST",
      "/v1/search",
      { title: "test", extra: true },
    );
    await record("search_redirect_rejects_price_range", "POST", "/v1/search", {
      price: { min: 5, max: 2 },
    });
    await record("search_redirect_rejects_sort", "POST", "/v1/search", {
      sortBy: "not-a-sort",
    });
    await record("search_redirect_rejects_limit", "POST", "/v1/search", {
      limit: 101,
    });
    await record(
      "search_redirect_rejects_non_object",
      "POST",
      "/v1/search",
      [],
    );
    await record("search_redirect_rejects_null_country", "POST", "/v1/search", {
      country: null,
    });
    await record(
      "search_redirect_rejects_unknown_price_key",
      "POST",
      "/v1/search",
      { price: { min: 1, maximum: 2 } },
    );
    await record(
      "search_redirect_rejects_fractional_price",
      "POST",
      "/v1/search",
      { price: { min: 1.5 } },
    );
    await record(
      "search_redirect_rejects_fractional_limit",
      "POST",
      "/v1/search",
      { limit: 2.5 },
    );
    await record(
      "search_redirect_rejects_utf16_overlength",
      "POST",
      "/v1/search",
      { title: "😀".repeat(251) },
    );
    await record("search_redirect_valid_boundary", "POST", "/v1/search", {
      title: "😀".repeat(250),
      price: { min: 0, max: Number.MAX_SAFE_INTEGER },
      limit: 100,
      sortBy: "",
      onSale: false,
    });
    await record(
      "search_redirect_missing_content_type",
      "POST",
      "/v1/search",
      undefined,
      {},
      { rawBody: "{}", contentType: null },
    );
    await record(
      "search_redirect_wrong_content_type",
      "POST",
      "/v1/search",
      undefined,
      {},
      { rawBody: "{}", contentType: "text/plain" },
    );
    await record(
      "search_redirect_malformed_json",
      "POST",
      "/v1/search",
      undefined,
      {},
      { rawBody: "{", contentType: "application/json" },
    );

    const cachedFilter = JSON.stringify({
      title: "Game",
      tags: ["tag-a"],
      __v: 2,
    });
    mocks.savedQueryGet.mockResolvedValue(cachedFilter);
    await record(
      "cached_search_get_success",
      "GET",
      "/v1/search/saved-query",
      undefined,
      { savedQueryEntries: { "saved-query": cachedFilter } },
    );
    mocks.savedQueryGet.mockResolvedValue(null);
    await record(
      "cached_search_get_not_found",
      "GET",
      "/v1/search/missing-query",
    );
    mocks.savedQueryGet.mockResolvedValue("not-json");
    await record(
      "cached_search_get_malformed",
      "GET",
      "/v1/search/bad-query",
      undefined,
      { savedQueryEntries: { "bad-query": "not-json" } },
    );
    await record(
      "cached_search_get_rejects_query",
      "GET",
      "/v1/search/saved-query?unexpected=1",
    );

    const countFilter = JSON.stringify({ title: "Stored", tags: ["tag-a"] });
    const countResult = JSON.stringify({
      total: 4,
      tagCounts: [],
      offerTypeCounts: [],
      developer: [],
      publisher: [],
      priceRange: { minPrice: 10, maxPrice: 40, currency: "USD" },
    });
    mocks.savedQueryGet.mockReset().mockResolvedValueOnce(countFilter);
    mocks.cacheGet.mockReset().mockResolvedValueOnce(countResult);
    await record(
      "cached_search_count_cache_hit",
      "GET",
      "/v1/search/count-query/count",
      undefined,
      {
        savedQueryEntries: { "count-query": countFilter },
        cacheEntries: {
          'v1:search.query-count:id="count-query":region="US"': countResult,
        },
      },
    );
    mocks.savedQueryGet.mockReset().mockResolvedValue(null);
    await record(
      "cached_search_count_not_found",
      "GET",
      "/v1/search/missing-count/count",
    );
    await record(
      "cached_search_count_invalid_country_precedes_lookup",
      "GET",
      "/v1/search/missing-count/count?country=ZZ",
    );

    const waveCountFilter = JSON.stringify({
      offerType: "BASE_GAME",
      tags: ["tag-a"],
      categories: ["cat-a"],
      seller: "seller-a",
      developerDisplayName: "Dev A",
      publisherDisplayName: "Pub A",
      refundType: "SELF_REFUNDABLE",
      isCodeRedemptionOnly: false,
      price: { min: 2, max: 20 },
      onSale: true,
    });
    const waveCountRow = {
      total: [{ total: 3 }],
      tagCounts: [{ _id: "tag-a", count: 3 }],
      offerTypeCounts: [{ _id: "BASE_GAME", count: 3 }],
      developer: [{ _id: "Dev A", count: 2 }],
      publisher: [{ _id: "Pub A", count: 1 }],
      priceRange: [{ _id: null, minPrice: 2, maxPrice: 12, currency: "EUR" }],
    };
    mocks.savedQueryGet.mockReset().mockResolvedValue(waveCountFilter);
    mocks.cacheGet.mockReset().mockResolvedValue(null);
    mocks.aggregate.mockReturnValue({
      exec: vi.fn(async () => [waveCountRow]),
    });
    await record(
      "cached_search_count_uncached_eu_facets",
      "GET",
      "/v1/search/wave-count/count?country=DE",
      undefined,
      {
        savedQueryEntries: { "wave-count": waveCountFilter },
        mongoAggregateRows: [waveCountRow],
      },
    );
    const waveCountCacheWrite = (cases.at(-1)?.input as Record<string, unknown>)
      .cacheWriteValue as string;
    mocks.aggregate.mockClear();
    mocks.cacheGet.mockReset().mockResolvedValue(waveCountCacheWrite);
    await record(
      "cached_search_count_repeat_cache_hit",
      "GET",
      "/v1/search/wave-count/count?country=DE",
      undefined,
      {
        savedQueryEntries: { "wave-count": waveCountFilter },
        cacheHitFromPriorWrite: waveCountCacheWrite,
      },
    );

    const itemHit = (id: string, sortId: string, outerId = `outer-${id}`) => ({
      _id: outerId,
      _source: {
        _id: `source-${id}`,
        id,
        title: id,
        entitlementType: "DURABLE",
        createdAt: "2026-01-03T00:00:00Z",
        __v: 1,
        customAttributes: [],
      },
      sort: [`2026-01-0${sortId === "first" ? 2 : 1}T00:00:00Z`, sortId],
    });
    mocks.cacheGet.mockResolvedValue(null);
    mocks.search.mockResolvedValue({
      body: {
        took: 8,
        timed_out: false,
        hits: {
          hits: [
            itemHit("page-first", "first", "different-hit-id"),
            itemHit("page-second", "second"),
          ],
        },
      },
    });
    await record(
      "multisearch_items_first_page_cursor",
      "GET",
      "/v1/multisearch/items?query=paginated&limit=1",
      undefined,
      {
        opensearchResponse: {
          took: 8,
          timed_out: false,
          hits: {
            hits: [
              itemHit("page-first", "first", "different-hit-id"),
              itemHit("page-second", "second"),
            ],
          },
        },
      },
    );
    const itemCursor = (
      cases.at(-1)?.response as {
        body: { meta: { pagination: { nextCursor: string } } };
      }
    ).body.meta.pagination.nextCursor;
    const itemPageCachePayload = (
      cases.at(-1)?.input as Record<string, unknown>
    ).cacheWriteValue as string;
    mocks.search.mockReset();
    mocks.cacheGet.mockReset().mockResolvedValue(itemPageCachePayload);
    await record(
      "multisearch_items_cache_hit_from_prior_write",
      "GET",
      "/v1/multisearch/items?query=paginated&limit=1",
      undefined,
      { cachePayload: itemPageCachePayload },
    );
    mocks.cacheGet.mockReset().mockResolvedValue(null);
    const continuationResponse = {
      took: 3,
      timed_out: false,
      hits: { hits: [itemHit("page-second", "second")] },
    };
    mocks.search.mockResolvedValue({ body: continuationResponse });
    await record(
      "multisearch_items_cursor_continuation",
      "GET",
      `/v1/multisearch/items?query=paginated&limit=1&cursor=${encodeURIComponent(itemCursor)}`,
      undefined,
      { opensearchResponse: continuationResponse },
    );
    await record(
      "multisearch_items_cursor_filter_mismatch",
      "GET",
      `/v1/multisearch/items?query=other&limit=1&cursor=${encodeURIComponent(itemCursor)}`,
    );

    const itemCache = JSON.stringify({
      hits: [
        {
          _id: "source-cached",
          id: "cached-item",
          title: "Cached Item",
          entitlementType: "DURABLE",
          customAttributes: {},
        },
      ],
      pagination: { limit: 1, hasMore: false, nextCursor: null },
      result: { tookMs: 5, timedOut: false },
    });
    mocks.cacheGet.mockResolvedValue(itemCache);
    await record(
      "multisearch_items_cache_hit",
      "GET",
      "/v1/multisearch/items?query=cached&limit=1",
      undefined,
      { cachePayload: itemCache },
    );
    mocks.cacheGet.mockResolvedValue("malformed");
    mocks.search.mockResolvedValue({
      body: { took: 1, timed_out: false, hits: { hits: [] } },
    });
    await record(
      "multisearch_items_malformed_cache",
      "GET",
      "/v1/multisearch/items?query=malformed&limit=1",
      undefined,
      {
        cachePayload: "malformed",
        opensearchResponse: { took: 1, timed_out: false, hits: { hits: [] } },
      },
    );
    mocks.cacheGet.mockRejectedValue(new Error("cache read failed"));
    await record(
      "multisearch_items_cache_read_failure",
      "GET",
      "/v1/multisearch/items?query=read-failure&limit=1",
      undefined,
      {
        cacheReadFailure: true,
        opensearchResponse: { took: 1, timed_out: false, hits: { hits: [] } },
      },
    );
    mocks.cacheGet.mockResolvedValue(null);
    mocks.cacheSet.mockRejectedValue(new Error("cache write failed"));
    await record(
      "multisearch_items_cache_write_failure",
      "GET",
      "/v1/multisearch/items?query=write-failure&limit=1",
      undefined,
      {
        cacheWriteFailure: true,
        opensearchResponse: { took: 1, timed_out: false, hits: { hits: [] } },
      },
    );
    mocks.cacheSet.mockResolvedValue("OK");
    await record(
      "multisearch_items_empty_query_type",
      "GET",
      "/v1/multisearch/items?query=&type=&limit=1",
      undefined,
      { opensearchResponse: { took: 1, timed_out: false, hits: { hits: [] } } },
    );
    await record(
      "multisearch_items_rejects_long_query",
      "GET",
      `/v1/multisearch/items?query=${"x".repeat(501)}`,
    );
    await record(
      "multisearch_items_rejects_long_type",
      "GET",
      `/v1/multisearch/items?type=${"x".repeat(101)}`,
    );

    const { VectorizeConfigurationError, CloudflareVectorizeError } =
      await import("../src/clients/vectorize.js");
    mocks.vectorSearch
      .mockReset()
      .mockRejectedValue(new VectorizeConfigurationError("not configured"));
    await record(
      "natural_language_unavailable",
      "POST",
      "/v1/search/natural-language",
      { query: "rpg" },
      { vectorError: "configuration" },
    );
    mocks.vectorSearch
      .mockReset()
      .mockRejectedValue(
        new CloudflareVectorizeError("upstream unavailable", 503),
      );
    await record(
      "natural_language_upstream_error",
      "POST",
      "/v1/search/natural-language",
      { query: "rpg" },
      { vectorError: "upstream" },
    );
    mocks.vectorSearch
      .mockReset()
      .mockRejectedValue(new Error("unexpected vector error"));
    await record(
      "natural_language_unexpected_error",
      "POST",
      "/v1/search/natural-language",
      { query: "rpg" },
      { vectorError: "generic" },
    );
    const tagRows = [
      { _id: "tag-a", id: "tag-a", name: "Action", status: "ACTIVE", __v: 1 },
      { _id: "tag-b", id: "tag-b", name: "Puzzle", status: "ACTIVE", __v: 1 },
    ];
    mocks.findTags.mockReturnValue({ lean: vi.fn(async () => tagRows) });
    await record("search_tags_populated", "GET", "/v1/search/tags", undefined, {
      mongoRows: tagRows,
    });
    mocks.findTags.mockReturnValue({ lean: vi.fn(async () => []) });
    await record("search_tags_empty", "GET", "/v1/search/tags", undefined, {
      mongoRows: [],
    });
    mocks.aggregate.mockReturnValue({
      exec: vi.fn(async () => [
        { _id: "BASE_GAME", count: 12 },
        { _id: null, count: 4 },
        { _id: "DLC", count: 3 },
      ]),
    });
    await record(
      "search_offer_types_populated",
      "GET",
      "/v1/search/offer-types",
      undefined,
      {
        mongoAggregateRows: [
          { _id: "BASE_GAME", count: 12 },
          { _id: null, count: 4 },
          { _id: "DLC", count: 3 },
        ],
      },
    );
    mocks.aggregate.mockReturnValue({ exec: vi.fn(async () => []) });
    await record(
      "search_offer_types_empty",
      "GET",
      "/v1/search/offer-types",
      undefined,
      { mongoAggregateRows: [] },
    );

    const developerRows = [
      { _id: "Studio A", count: 5 },
      { _id: "Studio B", count: 2 },
    ];
    mocks.aggregate.mockReturnValue({ exec: vi.fn(async () => developerRows) });
    await record(
      "search_developers_populated",
      "GET",
      "/v1/search/developers?query=Studio&limit=2",
      undefined,
      { mongoAggregateRows: developerRows },
    );
    mocks.aggregate.mockReturnValue({ exec: vi.fn(async () => []) });
    await record(
      "search_developers_default",
      "GET",
      "/v1/search/developers",
      undefined,
      { mongoAggregateRows: [] },
    );
    await record(
      "search_developers_parseint_limit",
      "GET",
      "/v1/search/developers?limit=7tail",
      undefined,
      { mongoAggregateRows: [] },
    );
    await record(
      "search_developers_zero_limit_defaults",
      "GET",
      "/v1/search/developers?limit=0",
      undefined,
      { mongoAggregateRows: [] },
    );
    const publisherRows = [{ _id: "Publisher", count: 7 }];
    mocks.aggregate.mockReturnValue({ exec: vi.fn(async () => publisherRows) });
    await record(
      "search_publishers_populated",
      "GET",
      "/v1/search/publishers?limit=1",
      undefined,
      { mongoAggregateRows: publisherRows },
    );
    mocks.aggregate.mockReturnValue({
      exec: vi.fn(async () => [
        { _id: "Publisher B", count: 4 },
        { _id: "Publisher A", count: 4 },
      ]),
    });
    await record(
      "search_publishers_tied_counts",
      "GET",
      "/v1/search/publishers?query=Publisher&limit=2",
      undefined,
      {
        mongoAggregateRows: [
          { _id: "Publisher B", count: 4 },
          { _id: "Publisher A", count: 4 },
        ],
      },
    );

    const changelogRows = [
      {
        _id: "000000000000000000000002",
        timestamp: "2026-11-16T10:00:00.000Z",
        metadata: { contextType: "file", contextId: "offer-a" },
        message: "Second",
      },
      {
        _id: "000000000000000000000001",
        timestamp: "2026-11-15T10:00:00.000Z",
        metadata: { contextType: "achievements", contextId: "offer-b" },
        message: "First",
      },
    ];
    mocks.findChangelog.mockReturnValue({
      lean: vi.fn(async () => changelogRows),
    });
    await record(
      "search_changelog_mongo_populated",
      "GET",
      "/v1/search/changelog?type=file&id=offer-a&limit=2",
      undefined,
      { mongoRows: changelogRows },
    );
    mocks.findChangelog.mockReturnValue({ lean: vi.fn(async () => []) });
    await record(
      "search_changelog_mongo_empty",
      "GET",
      "/v1/search/changelog",
      undefined,
      { mongoRows: [] },
    );
    const changelogSearchResponse = {
      took: 4,
      timed_out: false,
      hits: {
        hits: [
          {
            _id: "change-1",
            _source: { message: "Fixed" },
            sort: ["2026-11-16T00:00:00Z", "offer-a", "file"],
          },
        ],
      },
    };
    mocks.search.mockResolvedValue({ body: changelogSearchResponse });
    await record(
      "search_changelog_text_search",
      "GET",
      "/v1/search/changelog?query=fix&limit=1",
      undefined,
      { opensearchResponse: changelogSearchResponse },
    );
    await record(
      "search_changelog_rejects_long_query",
      "GET",
      `/v1/search/changelog?query=${"x".repeat(501)}`,
    );
    mocks.search.mockRejectedValue(new Error("OpenSearch unavailable"));
    await record(
      "search_changelog_service_unavailable",
      "GET",
      "/v1/search/changelog?query=fail",
      undefined,
      { opensearchError: "unavailable" },
    );
    const offersResponse = {
      took: 5,
      timed_out: false,
      hits: {
        total: { value: 1 },
        hits: [
          {
            _id: "offer-a",
            _source: {
              id: "offer-a",
              title: "Game",
              offerType: "BASE_GAME",
              customAttributes: [],
            },
            sort: ["2026-11-16T00:00:00Z", "offer-a"],
          },
        ],
      },
      aggregations: {},
    };
    mocks.search.mockResolvedValue({ body: offersResponse });
    await record(
      "search_offers_get",
      "GET",
      "/v1/search?title=game&limit=1&country=DE&locale=de-DE",
      undefined,
      { opensearchResponse: offersResponse },
    );
    mocks.search.mockResolvedValue({
      body: { took: 0, timed_out: false, hits: { hits: [] }, aggregations: {} },
    });
    await record(
      "search_offers_empty",
      "GET",
      "/v1/search?facets=none",
      undefined,
      {
        opensearchResponse: {
          took: 0,
          timed_out: false,
          hits: { hits: [] },
          aggregations: {},
        },
      },
    );
    await record(
      "search_offers_rejects_unknown_parameter",
      "GET",
      "/v1/search?unexpected=1",
    );
    mocks.search.mockRejectedValue(new Error("OpenSearch unavailable"));
    await record(
      "search_offers_service_unavailable",
      "GET",
      "/v1/search?title=unavailable",
      undefined,
      { opensearchError: "unavailable" },
    );
    const offerPageHit = (id: string, day: string) => ({
      _id: `outer-${id}`,
      _source: {
        id,
        title: `Page ${id}`,
        offerType: "BASE_GAME",
        customAttributes: [],
        lastModifiedDate: `2026-11-${day}T00:00:00.000Z`,
      },
      sort: [`2026-11-${day}T00:00:00.000Z`, id],
    });
    const offerPageOne = {
      took: 6,
      timed_out: false,
      hits: {
        hits: [
          offerPageHit("offer-page-one", "16"),
          offerPageHit("offer-page-two", "15"),
        ],
      },
      aggregations: {},
    };
    mocks.cacheGet.mockResolvedValue(null);
    mocks.search.mockResolvedValue({ body: offerPageOne });
    await record(
      "search_offers_first_page_cursor",
      "GET",
      "/v1/search?title=page&limit=1&facets=none",
      undefined,
      { opensearchResponse: offerPageOne },
    );
    const offerCursor = (
      cases.at(-1)?.response as {
        body: { meta: { pagination: { nextCursor: string } } };
      }
    ).body.meta.pagination.nextCursor;
    const offerCachePayload = (cases.at(-1)?.input as Record<string, unknown>)
      .cacheWriteValue as string;
    mocks.search.mockResolvedValue({
      body: {
        took: 2,
        timed_out: false,
        hits: { hits: [offerPageHit("offer-page-two", "15")] },
        aggregations: {},
      },
    });
    await record(
      "search_offers_cursor_continuation",
      "GET",
      `/v1/search?title=page&limit=1&facets=none&cursor=${encodeURIComponent(offerCursor)}`,
      undefined,
      {
        opensearchResponse: {
          took: 2,
          timed_out: false,
          hits: { hits: [offerPageHit("offer-page-two", "15")] },
          aggregations: {},
        },
      },
    );
    mocks.search.mockReset();
    mocks.cacheGet.mockResolvedValue(offerCachePayload);
    await record(
      "search_offers_cache_hit",
      "GET",
      "/v1/search?title=page&limit=1&facets=none",
      undefined,
      { cachePayload: offerCachePayload },
    );
    const multisearchOffersResponse = {
      took: 3,
      timed_out: false,
      hits: {
        hits: [
          {
            _id: "offer-b",
            _source: {
              id: "offer-b",
              title: "Other Game",
              offerType: "DLC",
              customAttributes: [],
            },
            sort: ["2026-11-15T00:00:00Z", "offer-b"],
          },
        ],
      },
    };
    mocks.search.mockResolvedValue({ body: multisearchOffersResponse });
    mocks.cacheGet.mockResolvedValue(null);
    await record(
      "multisearch_offers_get",
      "GET",
      "/v1/multisearch/offers?query=game&limit=1&country=DE",
      undefined,
      { opensearchResponse: multisearchOffersResponse },
    );
    mocks.search.mockResolvedValue({
      body: { took: 0, timed_out: false, hits: { hits: [] } },
    });
    await record(
      "multisearch_offers_empty",
      "GET",
      "/v1/multisearch/offers?query=missing",
      undefined,
      { opensearchResponse: { took: 0, timed_out: false, hits: { hits: [] } } },
    );
    await record(
      "multisearch_offers_rejects_long_query",
      "GET",
      `/v1/multisearch/offers?query=${"x".repeat(501)}`,
    );
    mocks.search.mockRejectedValue(new Error("OpenSearch unavailable"));
    await record(
      "multisearch_offers_service_unavailable",
      "GET",
      "/v1/multisearch/offers?query=unavailable",
      undefined,
      { opensearchError: "unavailable" },
    );
    const noHits = { took: 1, hits: { hits: [] } };
    const hit = { opensearchResponse: noHits };
    mocks.search.mockResolvedValue({ body: noHits });
    const filters =
      "offerType=DLC&seller=shop&tags=b,%20a,b&categories=hot,%20new&customAttributes=pass&developerDisplayName=Dev&publisherDisplayName=Pub&refundType=SELF&isCodeRedemptionOnly=1&pastGiveaways=1&excludeBlockchain=TRUE&priceMin=10&priceMax=20";
    for (const [name, path] of [
      [
        "search_all_filters",
        `/v1/search?title=game&${filters}&technologies=x,y&isLowestPrice=true&isLowestPriceEver=1&sortBy=discountPercent&country=DE&facets=minimal`,
      ],
      ["search_empty_sale_filter", "/v1/search?onSale=&isLowestPrice=TRUE"],
      ["search_empty_sort", "/v1/search?sortBy=&sortDir=asc&title=space"],
      [
        "search_release_ascending",
        "/v1/search?sortBy=releaseDate&sortDir=asc&facets=none",
      ],
      [
        "search_utf16_and_invalid_options",
        "/v1/search?title=" +
          encodeURIComponent("😀".repeat(251)) +
          "&sortDir=bad&facets=other&extra=1",
      ],
      ["search_bad_sort_precedes_boolean", "/v1/search?sortBy=wrong&onSale=no"],
      ["search_bad_boolean", "/v1/search?onSale=maybe"],
      [
        "multi_all_filters",
        `/v1/multisearch/offers?query=%20game%20&${filters}&isLowestPrice=1&onSale=1&sortBy=priceAsc&country=DE`,
      ],
      [
        "multi_url_slug",
        "/v1/multisearch/offers?query=" +
          encodeURIComponent(
            "https://store.epicgames.com/en-US/p/game-title?utm=local",
          ),
      ],
      ["multi_default_sort", "/v1/multisearch/offers?query=%20%20&offerType="],
      ["multi_upcoming", "/v1/multisearch/offers?sortBy=upcoming&sortDir=asc"],
      [
        "multi_generic_sort",
        "/v1/multisearch/offers?sortBy=priceUpdatedAt&query=a",
      ],
      [
        "multi_invalid_boolean",
        "/v1/multisearch/offers?excludeBlockchain=maybe",
      ],
      ["multi_invalid_price", "/v1/multisearch/offers?priceMin=-1"],
      [
        "multi_invalid_sort",
        "/v1/multisearch/offers?sortDir=sideways&country=ZZ",
      ],
    ])
      await record(name, "GET", path, undefined, hit);
    const multiPath =
      "/v1/multisearch/offers?query=game&tags=z,a&country=DE&locale=de-DE&limit=1";
    mocks.search.mockResolvedValue({ body: offerPageOne });
    await record("multi_offers_first_cursor", "GET", multiPath, undefined, {
      opensearchResponse: offerPageOne,
    });
    const multiCursor = (cases.at(-1)?.response as any).body.meta.pagination
      .nextCursor;
    const multiCache = (cases.at(-1)?.input as any).cacheWriteValue;
    mocks.search.mockResolvedValue({ body: noHits });
    await record(
      "multi_offers_cursor_equivalent_filters",
      "GET",
      multiPath.replace("z,a", "a,z,a") +
        "&cursor=" +
        encodeURIComponent(multiCursor),
      undefined,
      hit,
    );
    await record(
      "multi_offers_cursor_changed_locale",
      "GET",
      multiPath.replace("de-DE", "fr") +
        "&cursor=" +
        encodeURIComponent(multiCursor),
      undefined,
      hit,
    );
    mocks.cacheGet.mockResolvedValueOnce(multiCache);
    await record("multi_offers_cached_page", "GET", multiPath, undefined, {
      cachePayload: multiCache,
    });
    const missingSort = {
      hits: { hits: [{ _source: { id: "a" } }, { _source: { id: "b" } }] },
    };
    mocks.search.mockResolvedValue({ body: missingSort });
    await record(
      "search_hits_without_sort",
      "GET",
      "/v1/search?limit=1&facets=none",
      undefined,
      { opensearchResponse: missingSort },
    );
    const saved = JSON.stringify({
      title: "a.*(tag)-b",
      tags: [],
      categories: [],
      customAttributes: ["ignored"],
      excludeBlockchain: true,
      pastGiveaways: true,
      price: { min: 0, max: 10 },
    });
    mocks.savedQueryGet.mockResolvedValue(saved);
    mocks.aggregate.mockReturnValue({ exec: async () => [] });
    await record(
      "saved_count_literal_title_and_empty_lists",
      "GET",
      "/v1/search/legacy/count",
      undefined,
      { savedQueryEntries: { legacy: saved }, mongoAggregateRows: [] },
    );
    mocks.savedQueryGet.mockRejectedValue(new Error("saved query unavailable"));
    await record("saved_read_outage", "GET", "/v1/search/legacy", undefined, {
      savedQueryReadFailure: true,
    });
    await record(
      "saved_count_read_outage",
      "GET",
      "/v1/search/legacy/count",
      undefined,
      { savedQueryReadFailure: true },
    );
    const hitPaths = [
      ["search", "/v1/search?title=fixture"],
      ["offers", "/v1/multisearch/offers?query=fixture"],
      ["items", "/v1/multisearch/items?query=fixture&type=game"],
      ["changelog", "/v1/search/changelog?query=fixture"],
    ];
    for (const [operation, path] of hitPaths) {
      const partial = {
        took: null,
        timed_out: true,
        hits: {
          hits: [{ _id: "known", _source: null }, { _source: { __v: 1 } }],
        },
        aggregations: null,
        _shards: { total: 2, successful: 1, failed: 1 },
      };
      for (const [shape, reply] of Object.entries({
        partial,
        missing_hits: {},
        missing_rows: { hits: {} },
        malformed_rows: { hits: { hits: {} } },
      })) {
        mocks.search.mockResolvedValueOnce({ body: reply });
        await record(
          "opensearch_" + operation + "_" + shape,
          "GET",
          path,
          undefined,
          {
            opensearchResponse: reply,
          },
        );
      }
    }
    for (const [label, reply] of Object.entries({
      missing_aggregations: { took: null, timed_out: true },
      malformed_buckets: { aggregations: { sellers: { buckets: {} } } },
    })) {
      mocks.search.mockResolvedValueOnce({ body: reply });
      await record(
        "opensearch_sellers_" + label,
        "GET",
        "/v1/multisearch/sellers",
        undefined,
        { opensearchResponse: reply },
      );
    }
    for (const sort of [
      "upcoming",
      "giveawayDate",
      "price&sortDir=asc",
      "price&sortDir=desc",
    ]) {
      mocks.search.mockResolvedValueOnce({ body: noHits });
      await record(
        "offer_order_" + sort,
        "GET",
        "/v1/search?sortBy=" + sort,
        undefined,
        hit,
      );
    }
    await record(
      "offer_price_bounds",
      "GET",
      "/v1/search?priceMin=5&priceMax=2",
    );
    await record(
      "developer_long_query",
      "GET",
      "/v1/search/developers?query=" + "z".repeat(201),
    );
    for (const [key, value] of Object.entries({
      malformed_tags: { tags: "one" },
      wrong_tag_type: { tags: [3] },
      blank_tag: { tags: [" "] },
      bad_price: { price: [] },
      bad_boolean: { onSale: "yes" },
      redirect_options: {
        tags: [],
        sortBy: "giveawayDate",
        sortDir: "asc",
        facets: "minimal",
      },
    }))
      await record("search_post_" + key, "POST", "/v1/search", value);
    for (const [label, value] of Object.entries({
      empty_query: { query: " " },
      numeric_query: { query: 3 },
      top_k_zero: { query: "one", topK: 0 },
      long_query: { query: "q".repeat(501) },
      array_body: [],
    }))
      await record(
        "natural_language_" + label,
        "POST",
        "/v1/search/natural-language",
        value,
      );
    const scorePage = {
      hits: {
        hits: [
          { _id: "one", _source: { id: "one" }, sort: [3.5, null, "one"] },
          { _id: "two", _source: { id: "two" }, sort: [2.0, null, "two"] },
        ],
      },
      took: 3,
      timed_out: false,
    };
    for (const [operation, path] of [
      ["search", "/v1/search?title=space&limit=1"],
      ["changelog", "/v1/search/changelog?query=space&limit=1"],
    ]) {
      mocks.search.mockResolvedValueOnce({ body: scorePage });
      await record("numeric_cursor_" + operation, "GET", path, undefined, {
        opensearchResponse: scorePage,
      });
      const response = cases.at(-1)?.response as {
        body: { meta: { pagination: { nextCursor: string } } };
      };
      const cursor = response.body.meta.pagination.nextCursor;
      expect(cursor).toEqual(expect.any(String));
      mocks.search.mockResolvedValueOnce({ body: noHits });
      await record(
        "numeric_continuation_" + operation,
        "GET",
        path + "&cursor=" + encodeURIComponent(cursor),
        undefined,
        hit,
      );
    }
    const vectorId = "64f000000000000000000002";
    const mixedMatches = [
      { id: vectorId, score: 0.98, metadata: {} },
      { id: "missing", score: 0.8, metadata: { id: "no-offer" } },
    ];
    mocks.vectorSearch.mockResolvedValueOnce(mixedMatches);
    const vectorOffers = [
      { id: "catalog-id", _id: vectorId, title: "Fixture" },
    ];
    mocks.findOffers.mockReturnValueOnce({ lean: async () => vectorOffers });
    await record(
      "natural_language_mixed_ids",
      "POST",
      "/v1/search/natural-language",
      { query: "space" },
      { vectorMatches: mixedMatches, mongoRows: vectorOffers },
    );
    for (const [label, limit] of [
      ["negative", "-15"],
      ["invalid", "n/a"],
    ]) {
      mocks.aggregate.mockReturnValueOnce({ exec: async () => [] });
      await record(
        "facet_limit_" + label,
        "GET",
        "/v1/search/publishers?limit=" + limit,
        undefined,
        { mongoAggregateRows: [] },
      );
    }
    for (const [name, path, upstreamStatus] of [
      ["search", "/v1/search", 403],
      ["offers", "/v1/multisearch/offers", 429],
      ["items", "/v1/multisearch/items", 403],
      ["sellers", "/v1/multisearch/sellers", 429],
      ["changelog", "/v1/search/changelog?query=fixture", 403],
    ] as const) {
      mocks.search.mockRejectedValueOnce(
        Object.assign(new Error("OpenSearch request rejected"), {
          meta: { statusCode: upstreamStatus },
        }),
      );
      await record("opensearch_rejected_" + name, "GET", path, undefined, {
        opensearchError: upstreamStatus,
      });
    }
    for (const path of ["offer-types", "publishers", "developers"]) {
      mocks.aggregate.mockReturnValueOnce({
        exec: async () => {
          throw new Error("MongoDB unavailable");
        },
      });
      await record(
        "mongo_aggregate_outage_" + path,
        "GET",
        "/v1/search/" + path,
        undefined,
        { mongoAggregateError: true },
      );
    }
    const multiline = JSON.stringify({ title: "L1\nL2\rL3\u2028L4\u2029L5" });
    mocks.savedQueryGet.mockResolvedValueOnce(multiline);
    mocks.aggregate.mockReturnValueOnce({ exec: async () => [] });
    await record(
      "saved_count_literal_multiline",
      "GET",
      "/v1/search/multiline/count",
      undefined,
      { savedQueryEntries: { multiline }, mongoAggregateRows: [] },
    );
    for (const [name, path] of [
      [
        "items",
        "/v1/multisearch/items?query=" +
          "q".repeat(501) +
          "&type=" +
          "x".repeat(101) +
          "&other=1",
      ],
      [
        "publishers",
        "/v1/search/publishers?query=" + "q".repeat(201) + "&other=1",
      ],
      [
        "sellers",
        "/v1/multisearch/sellers?query=" + "q".repeat(301) + "&other=1",
      ],
    ])
      await record("combined_validation_" + name, "GET", path);
    mocks.aggregate.mockReturnValueOnce({ exec: async () => [] });
    await record(
      "facet_literal_publisher_query",
      "GET",
      "/v1/search/publishers?query=" + encodeURIComponent("A-B #3: [a]+?"),
      undefined,
      { mongoAggregateRows: [] },
    );
    mocks.findTags.mockReturnValueOnce({
      lean: async () => {
        throw new Error("tags unavailable");
      },
    });
    await record("mongo_tags_outage", "GET", "/v1/search/tags", undefined, {
      mongoError: "unavailable",
    });
    mocks.savedQueryGet.mockResolvedValueOnce("null");
    await record(
      "saved_count_null_payload",
      "GET",
      "/v1/search/legacy/count",
      undefined,
      { savedQueryEntries: { legacy: "null" } },
    );
    await record(
      "natural_json_malformed",
      "POST",
      "/v1/search/natural-language",
      undefined,
      {},
      { rawBody: "{" },
    );
    await record(
      "natural_missing_content_type",
      "POST",
      "/v1/search/natural-language",
      undefined,
      {},
      { rawBody: '{"query":"fixture"}', contentType: null },
    );
    for (const [name, body] of [
      ["fractional", { query: "fixture", topK: 1.5 }],
      ["string", { query: "fixture", topK: "10" }],
      ["bom", { query: "\uFEFF" }],
    ] as const)
      await record(
        "natural_invalid_" + name,
        "POST",
        "/v1/search/natural-language",
        body,
      );
    for (const [name, path, reply] of [
      [
        "missing_hit",
        "/v1/search/changelog?query=test",
        { hits: { hits: [null] } },
      ],
      [
        "missing_bucket",
        "/v1/multisearch/sellers",
        { aggregations: { sellers: { buckets: [null] } } },
      ],
    ] as const) {
      mocks.search.mockResolvedValueOnce({ body: reply });
      await record("opensearch_" + name, "GET", path, undefined, {
        opensearchResponse: reply,
      });
    }
    for (const [name, timestamp] of [
      ["iso", "2026-01-10T16:00:00+02:00"],
      ["epoch", 1768053600000],
      ["missing", null],
      ["date_only", "2026-01-10"],
      ["boolean", true],
      ["invalid", "unparseable"],
      ["object", {}],
    ] as const) {
      const rows = [
        { _id: "custom-row", timestamp },
        { _id: "next-row", timestamp: null },
      ];
      mocks.findChangelog.mockReturnValueOnce({ lean: async () => rows });
      const path = "/v1/search/changelog?limit=1&type=offer";
      await record("recent_changelog_" + name, "GET", path, undefined, {
        mongoRows: rows,
      });
      if (name === "invalid" || name === "object") continue;
      const previous = cases.at(-1)?.response as {
        body: { meta: { pagination: { nextCursor: string } } };
      };
      mocks.findChangelog.mockReturnValueOnce({ lean: async () => [] });
      await record(
        "recent_changelog_after_" + name,
        "GET",
        path +
          "&cursor=" +
          encodeURIComponent(previous.body.meta.pagination.nextCursor),
        undefined,
        { mongoRows: [] },
      );
    }
    for (const [name, path] of [
      ["field", "/v1/search?sortBy=viewableDate"],
      ["upcoming_asc", "/v1/search?sortBy=upcoming&sortDir=asc"],
      [
        "multi_upcoming_desc",
        "/v1/multisearch/offers?sortBy=upcoming&sortDir=desc",
      ],
    ]) {
      mocks.search.mockResolvedValueOnce({ body: noHits });
      await record("sort_" + name, "GET", path, undefined, hit);
    }
    await record("redirect_invalid_sort_direction", "POST", "/v1/search", {
      sortDir: "forward",
    });
    const fractional = JSON.stringify({ price: { min: 1.25, max: 9.75 } });
    mocks.savedQueryGet.mockResolvedValueOnce(fractional);
    mocks.aggregate.mockReturnValueOnce({ exec: async () => [] });
    await record(
      "saved_count_fractional_prices",
      "GET",
      "/v1/search/fractional/count",
      undefined,
      { savedQueryEntries: { fractional }, mongoAggregateRows: [] },
    );
    const integerCursor = encodeCursor(
      {
        operation: "search.changelog",
        filters: { query: null, type: null, id: null },
        ordering: "timestamp:desc,_id:asc",
        country: "US",
        locale: "en-US",
        limit: 1,
      },
      [1000, 3],
    );
    mocks.findChangelog.mockReturnValueOnce({ lean: async () => [] });
    await record(
      "recent_changelog_numeric_keyset",
      "GET",
      "/v1/search/changelog?limit=1&cursor=" +
        encodeURIComponent(integerCursor),
      undefined,
      { mongoRows: [] },
    );
    mocks.cacheGet.mockResolvedValue(null);
    for (const [name, path] of [
      ["types-unknown", "/v1/search/offer-types?other=1"],
      ["country", "/v1/search?country=ZZ"],
      ["limit", "/v1/search?limit=0"],
      ["min", "/v1/search?priceMin=1.5"],
      ["max", "/v1/search?priceMax=-1"],
      ["search-cursor", "/v1/search?cursor=wrong"],
      ["count-query", "/v1/search/demo/count?extra=1"],
      ["changelog-locale", "/v1/search/changelog?locale=x/y"],
      ["changelog-limit", "/v1/search/changelog?limit=0"],
      ["recent-cursor", "/v1/search/changelog?cursor=wrong"],
      ["text-cursor", "/v1/search/changelog?query=q&cursor=wrong"],
      ["multiple-country", "/v1/multisearch/offers?country=ZZ"],
      ["multiple-limit", "/v1/multisearch/offers?limit=0"],
      ["multiple-cursor", "/v1/multisearch/offers?query=q&cursor=bad"],
      ["items-limit", "/v1/multisearch/items?limit=0"],
    ]) {
      if (name === "types-unknown")
        mocks.aggregate.mockReturnValueOnce({ exec: async () => [] });
      await record(
        "wave-validation-" + name,
        "GET",
        path,
        undefined,
        name === "types-unknown" ? { mongoAggregateRows: [] } : {},
      );
    }
    for (const query of ["?other=x", "?locale=x/y"])
      await record(
        "wave-natural-query-" + query,
        "POST",
        "/v1/search/natural-language" + query,
        { query: "q" },
      );
    for (const [name, path] of [
      ["discount", "/v1/search?sortBy=discount"],
      ["priceUpdatedAt", "/v1/search?sortBy=priceUpdatedAt"],
      ["priceAsc", "/v1/search?sortBy=priceAsc"],
      ["priceDesc", "/v1/search?sortBy=priceDesc"],
      ["releaseDesc", "/v1/search?sortBy=releaseDate&sortDir=desc"],
      ["multiDiscount", "/v1/multisearch/offers?sortBy=discount"],
      ["multiGiveaway", "/v1/multisearch/offers?sortBy=giveawayDate"],
      ["multiPriceDesc", "/v1/multisearch/offers?sortBy=priceDesc"],
      ["zero-range", "/v1/multisearch/offers?priceMin=0"],
      ["seller-cache", "/v1/multisearch/sellers?query=empty"],
    ]) {
      mocks.search.mockResolvedValue({ body: noHits });
      await record("wave-sort-" + name, "GET", path, undefined, {
        opensearchResponse: noHits,
      });
    }
    for (const [name, path] of [
      ["search", "/v1/search?sortBy=upcoming&limit=1"],
      ["items", "/v1/multisearch/items?query=hi&limit=1"],
      ["offers", "/v1/multisearch/offers?query=hi&limit=1"],
      ["changelog", "/v1/search/changelog?query=hi&limit=1"],
    ]) {
      const sort = [
        true,
        null,
        1e-7,
        1e21,
        3.25,
        "text",
        { b: 1, a: 2 },
        [2, 1],
      ];
      const reply = {
        hits: {
          total: { value: 2, relation: "eq" },
          hits: [
            { _source: { id: "a", title: "A" }, sort },
            { _source: { id: "b" } },
          ],
        },
        took: 0.125,
        timed_out: 0,
      };
      mocks.search.mockResolvedValueOnce({ body: reply });
      await record("wave-native-sort-" + name, "GET", path, undefined, {
        opensearchResponse: reply,
      });
      const response = cases.at(-1)!.response as {
        body: { meta: { pagination: { nextCursor: string } } };
      };
      const token = response.body.meta.pagination.nextCursor;
      expect(
        JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString())
          .last,
      ).toEqual(sort);
      mocks.search.mockResolvedValueOnce({ body: noHits });
      await record(
        "wave-native-after-" + name,
        "GET",
        path + "&cursor=" + encodeURIComponent(token),
        undefined,
        { opensearchResponse: noHits },
      );
    }
    for (const [name, mock] of [
      ["missing-tag-type", mocks.aggregate],
      ["missing-publisher-name", mocks.aggregate],
    ] as const) {
      const rows = [{}, { _id: null }, { _id: "OK" }];
      mock.mockReturnValueOnce({ exec: async () => rows });
      await record(
        "wave-" + name,
        "GET",
        "/v1/search/" +
          (name === "missing-tag-type" ? "offer-types" : "publishers"),
        undefined,
        { mongoAggregateRows: rows },
      );
    }
    mocks.savedQueryGet.mockResolvedValueOnce("{}");
    mocks.aggregate.mockReturnValueOnce({
      exec: async () => {
        throw new Error("storage unavailable");
      },
    });
    await record(
      "wave-saved-count-mongo-outage",
      "GET",
      "/v1/search/demo/count",
      undefined,
      { savedQueryEntries: { demo: "{}" }, mongoAggregateError: true },
    );
    mocks.vectorSearch.mockResolvedValueOnce(vectorMatches);
    mocks.findOffers.mockReturnValueOnce({
      lean: async () => {
        throw new Error("storage unavailable");
      },
    });
    await record(
      "wave-natural-mongo-outage",
      "POST",
      "/v1/search/natural-language",
      { query: "space" },
      { vectorMatches, mongoError: "unavailable" },
    );
    mocks.findChangelog.mockReturnValueOnce({
      lean: async () => {
        throw new Error("storage unavailable");
      },
    });
    await record(
      "wave-changelog-mongo-outage",
      "GET",
      "/v1/search/changelog",
      undefined,
      { mongoError: "unavailable" },
    );
    const recentBase = {
      operation: "search.changelog",
      filters: { query: null, type: null, id: null },
      ordering: "timestamp:desc,_id:asc",
      country: "US",
      locale: "en-US",
      limit: 1,
    };
    for (const [label, last] of [
      ["partial", [null]],
      ["date-only", ["2026-11-01", null]],
      ["invalid-date", ["unparseable", null]],
      ["complex", [true, { a: 2 }]],
      ["array", [["old"], null]],
    ] as const) {
      const cursor = encodeCursor(recentBase, [...last] as Parameters<
        typeof encodeCursor
      >[1]);
      mocks.findChangelog.mockReturnValue({ lean: async () => [] });
      await record(
        "wave-recent-" + label,
        "GET",
        "/v1/search/changelog?limit=1&cursor=" + encodeURIComponent(cursor),
        undefined,
        { mongoRows: [] },
      );
    }
    const unkeyed = [
      {
        timestamp: new Date("2026-11-01T00:00:00.000Z"),
        metadata: { contextType: "offer" },
      },
      { timestamp: null },
    ];
    mocks.findChangelog.mockReturnValueOnce({ lean: async () => unkeyed });
    await record(
      "wave-recent-absent-mongo-id",
      "GET",
      "/v1/search/changelog?limit=1",
      undefined,
      { mongoRows: unkeyed },
    );
    const incompleteCache = JSON.stringify({ other: true });
    mocks.cacheGet.mockResolvedValueOnce(incompleteCache);
    await record(
      "wave-recent-incomplete-cache",
      "GET",
      "/v1/search/changelog",
      undefined,
      { cachePayload: incompleteCache },
    );
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("V1_CURSOR_SECRET", "");
    vi.stubEnv("V1_CURSOR_DEV_SECRET", "");
    try {
      const reply = {
        hits: {
          hits: [
            { _source: { id: "a" }, sort: [1, "a"] },
            { _source: { id: "b" } },
          ],
        },
      };
      for (const [label, path] of [
        ["offers", "/v1/search?limit=1"],
        ["multi", "/v1/multisearch/offers?limit=1"],
        ["items", "/v1/multisearch/items?limit=1"],
        ["changelog", "/v1/search/changelog?query=q&limit=1"],
      ]) {
        mocks.search.mockResolvedValueOnce({ body: reply });
        await record("wave-unsigned-" + label, "GET", path, undefined, {
          cursorSecret: false,
          opensearchResponse: reply,
        });
      }
      mocks.findChangelog.mockReturnValueOnce({ lean: async () => unkeyed });
      await record(
        "wave-unsigned-recent",
        "GET",
        "/v1/search/changelog?limit=1",
        undefined,
        { cursorSecret: false, mongoRows: unkeyed },
      );
    } finally {
      vi.unstubAllEnvs();
    }
    for (const [label, path] of [
      ["offers", "/v1/search"],
      ["multiple", "/v1/multisearch/offers"],
      ["items", "/v1/multisearch/items"],
      ["sellers", "/v1/multisearch/sellers"],
      ["recent", "/v1/search/changelog"],
    ]) {
      for (const [shape, data] of [
        ["missing", {}],
        ["null", { hits: null, offers: null, pagination: null, result: null }],
      ] as const) {
        const raw = JSON.stringify(data);
        mocks.cacheGet.mockResolvedValueOnce(raw);
        await record(
          "wave-partial-cache-" + label + shape,
          "GET",
          path,
          undefined,
          { cachePayload: raw, captureEtag: true },
        );
      }
    }
    const precise = {
      hits: {
        total: { value: 1, relation: "eq" },
        hits: [{ _source: { id: "test", "8": 1, "4": 2 }, sort: [1e-7] }],
      },
      took: 0.0000001,
      timed_out: false,
    };
    mocks.search.mockResolvedValueOnce({ body: precise });
    await record(
      "wave-precision-etag",
      "GET",
      "/v1/multisearch/items?limit=1",
      undefined,
      { opensearchResponse: precise, captureEtag: true },
    );
    const etag = (cases.at(-1)!.response as { headers: { etag: string } })
      .headers.etag;
    expect(etag).toBeTruthy();
    mocks.search.mockResolvedValueOnce({ body: precise });
    await record(
      "wave-conditional-etag",
      "GET",
      "/v1/multisearch/items?limit=1",
      undefined,
      { opensearchResponse: precise, captureEtag: true, ifNoneMatch: etag },
    );
    const localizedOffer = {
      id: "offer-a",
      namespace: "ns",
      title: "Main",
      offerType: "BASE_GAME",
    };
    const localizedBody = {
      hits: { hits: [{ _source: localizedOffer }] },
      took: 7,
    };
    for (const [label, method, path] of [
      ["search", "GET", "/v1/search?locale=de&onSale=false"],
      ["multiple", "GET", "/v1/multisearch/offers?locale=de"],
      ["natural", "POST", "/v1/search/natural-language?locale=de"],
    ] as const) {
      for (const failed of [false, true]) {
        const localizationRows = [
          { entityId: "ns:offer-a", data: { title: "Deutsch" } },
        ];
        if (failed)
          mocks.localized.mockRejectedValueOnce(
            new Error("MongoDB localization unavailable"),
          );
        else mocks.localized.mockResolvedValueOnce(localizationRows);
        const input = {
          failLocalization: failed,
          localizationRows,
          captureEtag: true,
        };
        if (method === "POST") {
          mocks.vectorSearch.mockResolvedValueOnce(vectorMatches);
          mocks.findOffers.mockReturnValueOnce({
            lean: async () => [localizedOffer],
          });
          await record(
            "wave-localized-" + label + failed,
            method,
            path,
            { query: "game" },
            { ...input, vectorMatches, mongoRows: [localizedOffer] },
          );
        } else {
          mocks.search.mockResolvedValueOnce({ body: localizedBody });
          await record(
            "wave-localized-" + label + failed,
            method,
            path,
            undefined,
            { ...input, opensearchResponse: localizedBody },
          );
        }
      }
    }
    await record("wave-redirect-none", "POST", "/v1/search", {
      facets: "none",
    });
    await record("wave-redirect-country", "POST", "/v1/search", {
      country: "ZZ",
    });
    const emptyBoolean = JSON.stringify({ isCodeRedemptionOnly: null });
    mocks.savedQueryGet.mockResolvedValueOnce(emptyBoolean);
    mocks.aggregate.mockReturnValueOnce({ exec: async () => [] });
    await record(
      "wave-saved-explicit-null",
      "GET",
      "/v1/search/demo/count",
      undefined,
      { savedQueryEntries: { demo: emptyBoolean }, mongoAggregateRows: [] },
    );
    for (const [name, filter] of [
      ["stored-number-string", { price: { min: "2.25", max: null } }],
      ["stored-boolean", { isCodeRedemptionOnly: "legacy-value" }],
    ]) {
      const raw = JSON.stringify(filter);
      mocks.savedQueryGet.mockResolvedValueOnce(raw);
      mocks.aggregate.mockReturnValueOnce({ exec: async () => [] });
      await record("wave-" + name, "GET", "/v1/search/demo/count", undefined, {
        savedQueryEntries: { demo: raw },
        mongoAggregateRows: [],
      });
    }
    const nonfinitePath =
      "/v1/multisearch/sellers?query=odd&limit=-" + "9".repeat(420);
    const noSellers = {
      hits: { hits: [] },
      aggregations: { sellers: { buckets: [] } },
    };
    mocks.search.mockResolvedValueOnce({ body: noSellers });
    await record(
      "wave-negative-nonfinite-limit",
      "GET",
      nonfinitePath,
      undefined,
      { opensearchResponse: noSellers },
    );
    for (const hits of ["🎮", 3]) {
      const cachePayload = JSON.stringify({ hits });
      mocks.cacheGet.mockResolvedValueOnce(cachePayload);
      await record(
        "wave-seller-cache-length-" + typeof hits,
        "GET",
        "/v1/multisearch/sellers",
        undefined,
        { cachePayload, captureEtag: true },
      );
    }
    const malformedBase = "https://example.test/line\nwrap";
    const storedFields = {
      id: { $oid: "plain identifier" },
      title: "Archive",
      creationDate: { $date: 123 },
      description: { label: { $oid: "ordinary field" }, edition: { $date: "spring" } },
      customAttributes: [{ key: "label", value: { $oid: "literal attribute" } }],
    };
    const storedPrice = {
      region: "US", currencyCode: "USD", offerId: storedFields.id,
      price: { discountPrice: "19.5", metadata: { $date: "spring" } },
      updatedAt: { $date: 123 },
    };
    for (const [operation, path] of hitPaths) {
      for (const [label, source] of Object.entries({
        fields: { ...storedFields, prices: { US: storedPrice } },
        array: ["catalog", { id: { $oid: "plain" } }],
        text: "old",
        malformedAttributes: { id: "archive", customAttributes: [null] },
      })) {
        const reply = { hits: { hits: [{ _id: "hit", _source: source }] }, aggregations: {
          label: { $oid: "literal facet" }, entry: { id: storedFields.id },
        } };
        mocks.search.mockResolvedValueOnce({ body: reply });
        await record("json-search-" + operation + "-" + label, "GET", path, undefined, {
          opensearchResponse: reply, captureEtag: true,
        });
      }
    }
    for (const [label, price] of Object.entries({
      primitive: 42, entries: ["US"], invalidCurrency: { currencyCode: true },
      primary: { ...storedPrice, price: { discountPrice: {}, currencyCode: "JPY" } },
    })) {
      const reply = { hits: { hits: [{ _source: { id: "archive", prices: { US: price } } }] } };
      mocks.search.mockResolvedValueOnce({ body: reply });
      await record("json-search-price-" + label, "GET", "/v1/search?title=fixture", undefined, {
        opensearchResponse: reply, captureEtag: true,
      });
    }
    const storedQuery = JSON.stringify(storedFields);
    mocks.savedQueryGet.mockResolvedValueOnce(storedQuery);
    await record("saved-plain-json-fields", "GET", "/v1/search/archive", undefined, {
      savedQueryEntries: { archive: storedQuery }, captureEtag: true,
    });
    for (const [label, mongoRows] of Object.entries({
      matchedInvalid: [{ id: "offer-a", customAttributes: [null] }],
      unmatchedInvalid: [{ id: "other", customAttributes: [null] }, ...offers],
      repeatedId: [...offers, { id: "offer-a", title: "Later record" }],
    })) {
      mocks.vectorSearch.mockResolvedValueOnce(vectorMatches);
      mocks.findOffers.mockReturnValueOnce({ lean: async () => mongoRows });
      await record("natural-ranked-attributes-" + label, "POST", "/v1/search/natural-language",
        { query: "fixture" }, { vectorMatches, mongoRows, captureEtag: true });
    }
    vi.stubEnv("V1_PUBLIC_BASE_URL", malformedBase);
    try {
      await record(
        "wave-redirect-misconfigured-origin",
        "POST",
        "/v1/search",
        { title: "game" },
        { publicBase: malformedBase },
      );
    } finally {
      vi.unstubAllEnvs();
    }
    assertOracle("search-http-node", cases);
    vi.useRealTimers();
  });
});
