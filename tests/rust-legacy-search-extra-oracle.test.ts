import { BSON, ObjectId } from "mongodb";
import { afterAll, expect, it, vi } from "vitest";
import { assertOracle, captureResponse } from "../rust/oracles/record.js";

type Input = {
  rows?: unknown[];
  collections?: Record<string, unknown[]>;
  counts?: Record<string, number>;
  cache?: unknown;
  savedQuery?: unknown;
  search?: unknown;
  searches?: Record<string, unknown>;
  oneReplies?: unknown[];
  vectorMatches?: unknown[];
  fail?: string;
};

const io = vi.hoisted(() => ({ input: {} as Input, trace: [] as unknown[] }));

function call(callData: Record<string, unknown>, result: unknown) {
  if (
    io.input.fail &&
    io.input.fail === (callData.service ?? callData.collection)
  ) {
    io.trace.push({ call: callData, error: true });
    throw new Error("fixture read failed");
  }
  io.trace.push({ call: callData, result: encoded(result) });
  return result;
}

function encoded(value: unknown): unknown {
  if (value instanceof RegExp) {
    return {
      $regularExpression: { pattern: value.source, options: value.flags },
    };
  }
  if (value instanceof Date) {
    const storedDate: Date = BSON.deserialize(BSON.serialize({ value })).value;
    return { $date: storedDate.toISOString() };
  }
  if (value instanceof ObjectId) {
    return { $oid: value.toHexString() };
  }
  if (Array.isArray(value)) {
    return value.map(encoded);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, encoded(v)]),
    );
  }
  return value;
}

vi.mock("../src/db/index.js", () => ({
  db: {
    db: {
      command: async () => {
        call({ method: "ping", service: "mongo" }, true);
        return { ok: 1 };
      },
      collection: (collection: string) => ({
        find: (query = {}, options: Record<string, unknown> = {}) => ({
          sort(sort: unknown) {
            options.sort = sort;
            return this;
          },
          limit(limit: number) {
            options.limit = limit;
            return this;
          },
          toArray: async () =>
            call(
              {
                collection,
                method: "many",
                query: encoded(query),
                options: encoded(options),
              },
              io.input.collections?.[collection] ?? io.input.rows ?? [],
            ),
        }),
        findOne: async (query = {}, options = {}) =>
          call(
            {
              collection,
              method: "one",
              query: encoded(query),
              options: encoded(options),
            },
            io.input.oneReplies
              ? (io.input.oneReplies.shift() ?? null)
              : ((io.input.collections?.[collection] ?? io.input.rows)?.[0] ??
                  null),
          ),
        insertOne: async (document: unknown) =>
          call(
            {
              collection,
              method: "insert",
              query: encoded(document),
              options: {},
            },
            {},
          ),
        aggregate: (pipeline: unknown[]) => ({
          toArray: async () =>
            call(
              {
                collection,
                method: "aggregate",
                query: encoded(pipeline),
                options: {},
              },
              io.input.collections?.[collection] ?? io.input.rows ?? [],
            ),
        }),
        countDocuments: async (query = {}) =>
          call(
            { collection, method: "count", query: encoded(query), options: {} },
            io.input.counts?.[collection] ?? 0,
          ),
      }),
    },
  },
}));

vi.mock("../src/clients/opensearch.js", () => ({
  opensearch: {
    search: async ({ index, body }: { index: string; body: unknown }) => {
      const responseBody = io.input.searches?.[index] ?? io.input.search ?? {};
      if (io.input.fail === "opensearch" || io.input.fail === index) {
        io.trace.push({
          call: { service: "opensearch", method: "search", index, body },
          error: true,
        });
        throw new Error("opensearch failed");
      }
      io.trace.push({
        call: { service: "opensearch", method: "search", index, body },
        result: encoded(responseBody),
      });
      return { body: responseBody };
    },
  },
}));

vi.mock("../src/clients/redis.js", () => ({
  default: {
    get: async (key: string) => {
      expect(key.startsWith("q:")).toBe(true);
      const hit = call(
        { method: "get", key: key.slice(2) },
        io.input.savedQuery ?? null,
      );
      return hit === null ? null : JSON.stringify(hit);
    },
    ping: async () => {
      call({ method: "ping", service: "redis" }, true);
      return "PONG";
    },
  },
}));

vi.mock("../src/clients/response-cache.js", () => ({
  default: {
    get: async (key: string) => {
      call({ method: "get", key }, io.input.cache ?? null);
      return io.input.cache === undefined
        ? null
        : JSON.stringify(io.input.cache);
    },
    set: async (key: string, value: string, _mode: string, ttl: number) => {
      const callData = {
        method: "set",
        key,
        ...(value === undefined ? {} : { payload: JSON.parse(value) }),
        ttl,
      };
      if (io.input.fail === "cache_set") {
        io.trace.push({ call: callData, error: true });
        throw new Error("cache write failed");
      }
      call(callData, null);
      return "OK";
    },
  },
  disconnectResponseCache: () => {},
}));

vi.mock("../src/clients/vectorize.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/clients/vectorize.js")>();
  return {
    ...actual,
    queryOffersWithNaturalLanguage: async (query: string, topK: number) => {
      const callData = {
        service: "vectorize",
        method: "queryNaturalLanguage",
        query,
        topK,
      };
      if (io.input.fail === "vectorize_config") {
        io.trace.push({ call: callData, error: "config" });
        throw new actual.VectorizeConfigurationError("not configured");
      }
      if (io.input.fail === "vectorize_upstream") {
        io.trace.push({ call: callData, error: "upstream" });
        throw new actual.CloudflareVectorizeError("upstream error", 502);
      }
      if (io.input.fail === "vectorize_other") {
        io.trace.push({ call: callData, error: true });
        throw new Error("vectorize failed");
      }
      return call(callData, io.input.vectorMatches ?? []);
    },
  };
});

it("replays the extra unversioned search routes from the full Node app", async () => {
  const { app } = await import("../src/index.js");
  vi.useFakeTimers({ toFake: ["Date", "performance"] });
  vi.setSystemTime(new Date("2026-11-17T00:00:00Z"));
  const cases: unknown[] = [];
  type RequestCase = {
    method: string;
    path: string;
    headers?: Record<string, string>;
    rawBody?: string;
  };
  const record = async (
    name: string,
    request: RequestCase,
    input: Input = {},
    status = 200,
  ) => {
    io.input = input;
    io.trace = [];
    const response = await app.request(request.path, {
      method: request.method,
      headers: request.headers,
      body: request.rawBody,
    });
    expect(response.status, name).toBe(status);
    cases.push({
      name,
      request,
      trace: io.trace,
      response: await captureResponse(response),
    });
  };
  const get = (path: string, headers?: Record<string, string>) => ({
    method: "GET",
    path,
    headers,
  });
  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = { "content-type": "application/json" },
  ) => ({
    method: "POST",
    path,
    headers,
    rawBody: typeof body === "string" ? body : JSON.stringify(body),
  });

  // 1. GET /search/changelog
  const recentHits = [
    {
      _id: "507f1f77bcf86cd799439001",
      timestamp: "2026-11-17T00:00:00.000Z",
      metadata: { contextType: "offer", contextId: "offer-1" },
    },
    {
      _id: "507f1f77bcf86cd799439002",
      timestamp: "2026-11-16T00:00:00.000Z",
      metadata: { contextType: "item", contextId: "item-1" },
    },
    {
      _id: "507f1f77bcf86cd799439003",
      timestamp: "2026-11-15T00:00:00.000Z",
      metadata: { contextType: "asset", contextId: "asset-1" },
    },
    {
      _id: "507f1f77bcf86cd799439004",
      timestamp: "2026-11-14T00:00:00.000Z",
      metadata: {
        contextType: "build",
        contextId: "507f1f77bcf86cd799439011",
      },
    },
    {
      _id: "507f1f77bcf86cd799439005",
      timestamp: "2026-11-13T00:00:00.000Z",
      metadata: { contextType: "build", contextId: "build-str" },
    },
    {
      _id: "507f1f77bcf86cd799439006",
      timestamp: "2026-11-12T00:00:00.000Z",
      metadata: { contextType: "unknown", contextId: "u-1" },
    },
    {
      _id: "507f1f77bcf86cd799439007",
      timestamp: "2026-11-11T00:00:00.000Z",
      metadata: { contextType: "offer" },
    },
  ];
  await record(
    "legacy changelog recent enriched",
    get("/search/changelog?page=0&limit=100&debug=1"),
    {
      collections: {
        changelogs_v2: recentHits,
        offers: [{ id: "offer-1", title: "Offer One" }],
        items: [{ id: "item-1", title: "Item One" }],
        assets: [{ artifactId: "asset-1", itemId: "item-1" }],
        builds: [
          {
            _id: "507f1f77bcf86cd799439011",
            appName: "AppOne",
            buildVersion: "1.0",
          },
        ],
      },
      counts: { changelogs_v2: 7 },
    },
  );

  await record(
    "legacy changelog recent filtered asset no itemId",
    get("/search/changelog?type=asset&id=asset-empty&page=2&limit=abc"),
    {
      collections: {
        changelogs_v2: [
          {
            _id: "c-asset-empty",
            metadata: { contextType: "asset", contextId: "asset-empty" },
          },
        ],
        assets: [{ artifactId: "asset-empty" }],
      },
      counts: { changelogs_v2: 1 },
    },
  );

  await record(
    "legacy changelog recent doc lookup error swallows to null",
    get("/search/changelog"),
    {
      collections: {
        changelogs_v2: [
          {
            _id: "c-err",
            metadata: { contextType: "offer", contextId: "offer-err" },
          },
        ],
      },
      counts: { changelogs_v2: 1 },
      fail: "offers",
    },
  );

  await record(
    "legacy changelog whitespace query hits opensearch then mongo",
    get("/search/changelog?query=%20%20"),
    {
      searches: {
        "egdata.offers": { hits: { hits: [{ _source: { id: "o1" } }] } },
        "egdata.items": { hits: { hits: [] } },
      },
      collections: { changelogs_v2: [] },
      counts: { changelogs_v2: 0 },
    },
  );

  const relatedIds = Array.from({ length: 12 }, (_, idx) => `ctx-${idx}`);
  await record(
    "legacy changelog opensearch hydrated and debug",
    get("/search/changelog?query=cyber&type=offer&id=offer-1&debug=1"),
    {
      searches: {
        "egdata.offers": {
          hits: {
            hits: [
              ...relatedIds.slice(0, 8).map((id) => ({ _source: { id } })),
              { _source: { id: "" } },
              {},
            ],
          },
        },
        "egdata.items": {
          hits: {
            hits: relatedIds.slice(6).map((id) => ({ _source: { id } })),
          },
        },
        "egdata.changelog": {
          took: 7,
          hits: {
            total: { value: 2 },
            hits: [
              {
                _id: "507f1f77bcf86cd799439021",
                _source: {
                  metadata: {
                    contextType: "offer",
                    contextId: "offer-1",
                    changes: [
                      {
                        field: "title",
                        oldValue: null,
                        oldValueRaw: '{"k":1}',
                        newValue: null,
                        newValueRaw: "plain-text",
                      },
                      {
                        field: "desc",
                        oldValue: "existing",
                        newValue: null,
                        newValueRaw: 42,
                      },
                      {
                        field: "empty",
                        oldValue: null,
                        newValue: null,
                      },
                    ],
                  },
                },
              },
              {
                _id: "chg-str-2",
                _source: {
                  metadata: {
                    contextType: "unknown",
                    contextId: "none",
                  },
                },
              },
            ],
          },
        },
      },
      collections: {
        changelogs_v2: [
          {
            _id: "507f1f77bcf86cd799439021",
            metadata: {
              changes: [{ oldValue: null }, { newValue: "from-mongo" }],
            },
          },
        ],
        offers: [{ id: "offer-1", title: "Offer One" }],
      },
    },
  );

  await record(
    "legacy changelog opensearch hydrate mongo error falls back",
    get("/search/changelog?query=cyber"),
    {
      searches: {
        "egdata.offers": { hits: { hits: [] } },
        "egdata.items": { hits: { hits: [] } },
        "egdata.changelog": {
          took: 4,
          hits: {
            total: 1,
            hits: [
              {
                _id: "chg-no-oid",
                _source: {
                  metadata: {
                    contextType: "unknown",
                    contextId: "x",
                    changes: [
                      {
                        oldValueRaw: "[1,2]",
                        newValue: "ok",
                      },
                    ],
                  },
                },
              },
            ],
          },
        },
      },
      fail: "changelogs_v2",
    },
  );

  await record(
    "legacy changelog opensearch mongo fallback without id",
    get("/search/changelog?query=cyber&debug=1"),
    {
      searches: {
        "egdata.offers": { hits: { hits: [{ _source: { id: "offer-fb" } }] } },
        "egdata.items": { hits: { hits: [] } },
        "egdata.changelog": {
          took: 9,
          hits: { total: 0, hits: [] },
        },
      },
      collections: {
        changelogs_v2: [
          {
            _id: "fb-1",
            metadata: { contextType: "offer", contextId: "offer-fb" },
          },
        ],
        offers: [{ id: "offer-fb", title: "Fallback Offer" }],
      },
      counts: { changelogs_v2: 1 },
    },
  );

  await record(
    "legacy changelog opensearch mongo fallback with id",
    get("/search/changelog?query=cyber&id=forced-id"),
    {
      searches: {
        "egdata.offers": { hits: { hits: [{ _source: { id: "offer-fb" } }] } },
        "egdata.items": { hits: { hits: [] } },
        "egdata.changelog": {
          took: 3,
          hits: { total: { value: 0 }, hits: [] },
        },
      },
      collections: {
        changelogs_v2: [],
      },
      counts: { changelogs_v2: 0 },
    },
  );

  await record(
    "legacy changelog opensearch zero hits no related ids skips fallback",
    get("/search/changelog?query=nothing"),
    {
      searches: {
        "egdata.offers": { hits: { hits: [] } },
        "egdata.items": { hits: { hits: [] } },
        "egdata.changelog": {
          took: 2,
          hits: { total: {}, hits: [] },
        },
      },
    },
  );

  await record(
    "legacy changelog opensearch failure",
    get("/search/changelog?query=boom"),
    { fail: "opensearch" },
    500,
  );

  // 2. POST /search/natural-language
  await record(
    "legacy natural language invalid locale",
    post("/search/natural-language?locale=invalid%20tag", { query: "rpg" }),
    {},
    400,
  );
  await record(
    "legacy natural language malformed json",
    post("/search/natural-language", "{bad"),
    {},
    400,
  );
  await record(
    "legacy natural language blank query",
    post("/search/natural-language", { query: "   " }),
    {},
    400,
  );
  await record(
    "legacy natural language too long query",
    post("/search/natural-language", { query: "a".repeat(501) }),
    {},
    400,
  );
  await record(
    "legacy natural language invalid topK float",
    post("/search/natural-language", { query: "rpg", topK: 1.5 }),
    {},
    400,
  );
  await record(
    "legacy natural language invalid topK range",
    post("/search/natural-language", { query: "rpg", topK: 51 }),
    {},
    400,
  );
  await record(
    "legacy natural language unknown key",
    post("/search/natural-language", { query: "rpg", extra: true }),
    {},
    400,
  );
  await record(
    "legacy natural language empty matches",
    post("/search/natural-language", { query: "  cozy farm  ", topK: 3 }),
    { vectorMatches: [] },
  );
  await record(
    "legacy natural language ranked localized",
    post("/search/natural-language?locale=de-de", { query: "rpg" }),
    {
      vectorMatches: [
        {
          id: "507f1f77bcf86cd799439031",
          score: 0.95,
          metadata: { id: "offer-a" },
        },
        { id: "507f1f77bcf86cd799439032", score: 0.85 },
        { id: "not-an-oid", score: 0.75, metadata: { id: "" } },
      ],
      collections: {
        offers: [
          {
            _id: "507f1f77bcf86cd799439031",
            id: "offer-a",
            namespace: "ns-a",
            title: "Original A",
            customAttributes: [{ key: "k", value: "v" }],
          },
          {
            _id: "507f1f77bcf86cd799439032",
            id: "offer-b",
            namespace: "ns-b",
            title: "Original B",
            customAttributes: null,
          },
        ],
        egs_localizations: [
          {
            entityType: "offer",
            entityId: "ns-a:offer-a",
            locale: "de-DE",
            source: "egs",
            fetchedAt: "2026-11-16T00:00:00.000Z",
            data: { title: "Deutsch A" },
          },
        ],
      },
    },
  );
  await record(
    "legacy natural language vectorize only metadata id",
    post("/search/natural-language", { query: "rpg" }),
    {
      vectorMatches: [{ id: "vec-1", score: 0.5, metadata: { id: "offer-a" } }],
      collections: { offers: [{ _id: "m1", id: "offer-a", title: "A" }] },
    },
  );
  await record(
    "legacy natural language vectorize only object id",
    post("/search/natural-language", { query: "rpg" }),
    {
      vectorMatches: [{ id: "507f1f77bcf86cd799439031", score: 0.5 }],
      collections: {
        offers: [
          { _id: "507f1f77bcf86cd799439031", id: "offer-a", title: "A" },
        ],
      },
    },
  );
  await record(
    "legacy natural language config error",
    post("/search/natural-language", { query: "rpg" }),
    { fail: "vectorize_config" },
    503,
  );
  await record(
    "legacy natural language upstream error",
    post("/search/natural-language", { query: "rpg" }),
    { fail: "vectorize_upstream" },
    502,
  );
  await record(
    "legacy natural language unexpected vectorize error",
    post("/search/natural-language", { query: "rpg" }),
    { fail: "vectorize_other" },
    500,
  );
  await record(
    "legacy natural language mongo error",
    post("/search/natural-language", { query: "rpg" }),
    {
      vectorMatches: [{ id: "vec-1", score: 0.5, metadata: { id: "offer-a" } }],
      fail: "offers",
    },
    500,
  );

  // 3. GET /search/{id}/count
  await record(
    "legacy search count cache hit",
    get("/search/saved-1/count?country=ES"),
    {
      cache: {
        tagCounts: [],
        offerTypeCounts: [],
        total: 42,
        developer: [],
        publisher: [],
        priceRange: { minPrice: 100, maxPrice: 500 },
      },
    },
  );
  await record(
    "legacy search count missing saved query",
    get("/search/missing/count", { cookie: "EGDATA_COUNTRY=ES" }),
    {},
    404,
  );
  await record(
    "legacy search count full filters with tags and cookie country",
    get("/search/saved-full/count", { cookie: "EGDATA_COUNTRY=ES" }),
    {
      savedQuery: {
        title: "Cyber+Punk",
        offerType: "BASE_GAME",
        tags: ["1", "2"],
        customAttributes: ["attr1"],
        categories: ["games"],
        seller: "Epic",
        developerDisplayName: "Dev",
        publisherDisplayName: "Pub",
        refundType: "SELF_REFUNDABLE",
        isCodeRedemptionOnly: false,
        excludeBlockchain: true,
        price: { min: 100, max: 5000 },
        onSale: true,
        pastGiveaways: true,
      },
      collections: {
        offers: [
          {
            tagCounts: [{ _id: "1", count: 3 }],
            offerTypeCounts: [{ _id: "BASE_GAME", count: 3 }],
            total: [{ total: 3 }],
            developer: [{ _id: "Dev", count: 3 }],
            publisher: [{ _id: "Pub", count: 3 }],
            priceRange: [
              { _id: null, minPrice: 100, maxPrice: 500, currency: "EUR" },
            ],
          },
        ],
      },
    },
  );
  await record(
    "legacy search count excludeBlockchain without tags and zero prices",
    get("/search/saved-noblock/count?country=XX"),
    {
      savedQuery: {
        excludeBlockchain: true,
        price: { min: 0, max: 0 },
      },
      collections: { offers: [] },
    },
  );
  await record(
    "legacy search count aggregate error",
    get("/search/saved-err/count"),
    {
      savedQuery: { title: "x" },
      fail: "offers",
    },
    500,
  );
  await record(
    "legacy search count cache write error",
    get("/search/saved-cache-err/count"),
    {
      savedQuery: {},
      collections: { offers: [] },
      fail: "cache_set",
    },
    500,
  );

  assertOracle("legacy-search-extra-http-node", cases);
});

afterAll(async () => {
  vi.useRealTimers();
  const { server } = await import("../src/graphql/index.js");
  await server.stop();
});

vi.mock("../src/clients/ga.js", async (importOriginal) => {
  const ga = await importOriginal<typeof import("../src/clients/ga.js")>();
  return {
    ...ga,
    gaClient: new ga.GaClient({ id: "fixture", secret: "fixture" }),
  };
});

it("records all remaining public root and multisearch handlers in the full Node app", async () => {
  const fetch = globalThis.fetch;
  const mockFetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      if (new URL(String(input)).hostname !== "www.google-analytics.com")
        return fetch(input, init);
      call(
        {
          service: "ga",
          method: "collect",
          body: JSON.parse(String(init?.body)),
        },
        null,
      );
      return new Response(null, { status: 204 });
    });
  const { app } = await import("../src/index.js");
  vi.useFakeTimers({ toFake: ["Date", "performance"] });
  vi.setSystemTime(new Date("2026-11-17T00:00:00Z"));
  const cases: unknown[] = [];
  async function record(
    name: string,
    path: string,
    input: Input = {},
    status = 200,
    rawBody?: string,
    headers?: Record<string, string>,
  ) {
    io.input = input;
    io.trace = [];
    const request = {
      method: rawBody === undefined ? "GET" : "POST",
      path,
      rawBody,
      headers,
    };
    const response = await app.request(path, {
      method: request.method,
      headers,
      body: rawBody,
    });
    expect(response.status, name).toBe(status);
    cases.push({
      name,
      request,
      trace: io.trace,
      response: await captureResponse(response),
    });
  }
  const a = {
    _id: "internal",
    id: "a",
    namespace: "n",
    title: "Demo",
    extra: "preserved",
    customAttributes: [{ key: "k", value: 0 }],
  };
  const items = [
    a,
    { id: "a", other: true },
    { id: "b", customAttributes: {} },
  ];
  await record("root-items", "/items-from-offer/game", { rows: [{ items }] });
  await record("root-items-cache", "/items-from-offer/game", {
    cache: [{ id: "cached" }],
  });
  await record("root-base", "/base-game/n", { oneReplies: [a] });
  await record("root-base-pre", "/base-game/n?locale=es-es", {
    oneReplies: [null, a],
    collections: { egs_localizations: [] },
  });
  await record("root-base-missing", "/base-game/n", {}, 404);
  await record("root-base-internal", "/base-game/SeaQA", {}, 404);
  await record("root-base-locale", "/base-game/epic?locale=nope", {}, 400);
  await record("root-changelog", "/changelog?limit=100&page=2", {
    rows: [{ _id: "id", changes: [] }],
  });
  await record("root-ping-empty", "/ping", {}, 200, "{}");
  await record(
    "root-ping-local",
    "/ping",
    {},
    200,
    JSON.stringify({ location: "http://localhost:5173/hello" }),
  );
  for (const [i, raw] of [
    "bad",
    "null",
    JSON.stringify({ location: 4 }),
    JSON.stringify({ location: "page" }),
  ].entries()) {
    await record("root-ping-invalid-" + i, "/ping", {}, 500, raw);
  }
  const payload = {
    event: "view",
    location: "https://egdata.app/offers/demo",
    userId: "anonymous",
    params: { game: "Demo" },
    session: { id: "session", startedAt: 1000, lastActiveAt: 2000 },
  };
  await record("root-ping-track", "/ping", {}, 200, JSON.stringify(payload));
  await record(
    "root-ping-store-fail",
    "/ping",
    { fail: "events" },
    500,
    JSON.stringify(payload),
  );
  const hit = { _id: "search-id", _source: a };
  const os = {
    took: 5,
    hits: { hits: [hit, { _id: "missing" }], total: { value: 420 } },
  };
  await record("multi-root", "/multisearch");
  await record("multi-offers-default", "/multisearch/offers", { search: os });
  await record(
    "multi-offers-invalid-locale",
    "/multisearch/offers?locale=bad_tag",
    {},
    400,
  );
  await record(
    "multi-offers-filters",
    "/multisearch/offers?query=cool&offerType=DLC&tags=one,,two&categories=games&customAttributes=a,b&seller=s&developerDisplayName=d&publisherDisplayName=p&refundType=x&isCodeRedemptionOnly=true&excludeBlockchain=true&pastGiveaways=true&priceMin=0x10&priceMax=nope&isLowestPrice=true&isLowestPriceEver=true&page=2&limit=10",
    { search: os },
  );
  for (const [i, sort] of [
    "price",
    "priceDesc",
    "priceAsc",
    "discount",
    "discountPercent",
    "upcoming",
    "giveawayDate",
    "releaseDate",
    "custom",
  ].entries()) {
    const dir = i % 2 ? "desc" : "";
    await record(
      "multi-sort-" + sort,
      "/multisearch/offers?query=https://store.epicgames.com/en-US/p/demo&sortBy=" +
        sort +
        "&sortDir=" +
        dir +
        "&onSale=false&isLowestPriceEver=true",
      { search: { hits: { hits: [], total: 4 } } },
      200,
      undefined,
      { cookie: "EGDATA_COUNTRY=ES" },
    );
  }
  await record(
    "multi-offers-localized",
    "/multisearch/offers?locale=es-es&country=unknown&onSale=true",
    { search: os, collections: { egs_localizations: [] } },
  );
  await record("multi-items", "/multisearch/items?query=demo&type=EXECUTABLE", {
    search: os,
  });
  await record("multi-items-empty", "/multisearch/items", {
    search: { hits: { hits: [] } },
  });
  await record(
    "multi-items-error",
    "/multisearch/items",
    { fail: "opensearch" },
    500,
  );
  await record("multi-sellers-empty", "/multisearch/sellers", { search: {} });
  await record("multi-sellers", "/multisearch/sellers?query=dev&limit=101", {
    search: {
      aggregations: {
        sellers: { buckets: [{ key: "s" }, { key: "missing" }, { key: "t" }] },
      },
      took: 17,
    },
    collections: {
      sellers: [
        { _id: "t", name: "T" },
        { _id: "s", name: "S" },
      ],
    },
  });
  for (const [name, data] of Object.entries({
    "ping-sparse": { location: "event", session: { lastActiveAt: null } },
    "ping-no-clock": { location: "event", session: {} },
    "ping-array-clock": {
      location: "event",
      session: { lastActiveAt: ["2025-01-02"] },
    },
    "ping-out-of-range-clock": {
      location: "event",
      session: { lastActiveAt: 9e18 },
    },
    "ping-string-values": {
      location: "event",
      event: 7,
      userId: 92,
      params: "abc",
      session: {
        id: 4,
        startedAt: "0x10",
        lastActiveAt: "2025-01-02T00:00:00Z",
      },
    },
    "ping-array-params": {
      location: "event",
      params: ["one", "two"],
      session: { id: null, startedAt: "0b11", lastActiveAt: true },
    },
    "ping-clock": {
      location: "event",
      session: { id: "s", startedAt: 500, lastActiveAt: 1234.5 },
      params: {
        page_location: "override",
        session_id: "overridden",
        timestamp_millis: "overridden",
      },
    },
  }))
    await record(name, "/ping", {}, 200, JSON.stringify(data));
  await record(
    "ping-utf8-bom",
    "/ping",
    {},
    200,
    "\uFEFF" + JSON.stringify(payload),
  );
  await record(
    "ping-ga-offline",
    "/ping",
    { fail: "ga" },
    200,
    JSON.stringify(payload),
  );
  await record("root-items-sparse", "/items-from-offer/a", {
    rows: [
      {
        items: [
          { id: "a" },
          { id: "b", customAttributes: null },
          { id: 1, customAttributes: false },
          { id: "1", customAttributes: [{ key: 17, type: 5, value: 0 }] },
        ],
      },
    ],
  });
  await record("root-items-flatmap-object", "/items-from-offer/a", {
    rows: [{ items: { id: "singleton" } }, { items: ["abc", false] }],
  });
  await record(
    "root-items-null-entry",
    "/items-from-offer/a",
    { rows: [{ items: [null] }] },
    500,
  );
  await record(
    "root-items-null-attribute",
    "/items-from-offer/a",
    { rows: [{ items: [{ customAttributes: [null] }] }] },
    500,
  );
  for (const stage of ["offers", "cache_set"])
    await record(
      "root-items-failed-" + stage,
      "/items-from-offer/a",
      { fail: stage },
      500,
    );
  await record(
    "root-base-offer-offline",
    "/base-game/n",
    { fail: "offers" },
    500,
  );
  await record(
    "root-base-localization-offline",
    "/base-game/n?locale=fr-FR",
    { oneReplies: [a], fail: "egs_localizations" },
    500,
  );
  await record(
    "root-changelog-store-offline",
    "/changelog?page=1&limit=2",
    { fail: "changelogs_v2" },
    500,
  );
  for (const route of ["items", "offers"]) {
    const path = "/multisearch/" + route;
    await record(route + "-sparse-sources", path, {
      search: {
        hits: {
          hits: [
            { _source: { _id: "stale", title: "A" } },
            { _id: null, _source: null },
            { _source: ["a", "b"] },
            { _source: "xy" },
          ],
          total: { value: 0 },
        },
      },
    });
    await record(
      route + "-null-hit",
      path,
      { search: { hits: { hits: [null] } } },
      500,
    );
    await record(route + "-no-hits-array", path, { search: { hits: {} } }, 500);
    await record(route + "-store-offline", path, { fail: "opensearch" }, 500);
  }
  await record("multi-items-attr-types", "/multisearch/items", {
    search: {
      hits: {
        hits: [
          {
            _source: {
              customAttributes: [
                { key: 4, type: 2, value: 1 },
                { key: 0, value: "unused" },
              ],
            },
          },
          { _source: { customAttributes: false } },
        ],
      },
    },
  });
  await record(
    "multi-items-null-attr",
    "/multisearch/items",
    { search: { hits: { hits: [{ _source: { customAttributes: [null] } }] } } },
    500,
  );
  await record(
    "multi-offers-price-radix",
    "/multisearch/offers?priceMin=0x100000000000000000000&priceMax=0b110&limit=-Infinity&page=0o7",
    { search: { hits: { hits: [] } } },
  );
  await record(
    "multi-offers-blank-fields",
    "/multisearch/offers?priceMin=%20&priceMax=inf&limit=0&page=bad&sortBy=priceAsc&sortDir=&isLowestPrice=true",
    { search: { hits: { hits: [] } } },
  );
  await record(
    "multi-offers-localization-offline",
    "/multisearch/offers?locale=fr",
    { search: os, fail: "egs_localizations" },
    500,
  );
  for (const [name, buckets] of [
    ["invalid-shape", {}],
    ["null-bucket", [null]],
  ] as const) {
    await record(
      "multi-sellers-" + name,
      "/multisearch/sellers",
      { search: { aggregations: { sellers: { buckets } } } },
      500,
    );
  }
  const sellersSearch = {
    aggregations: {
      sellers: {
        buckets: [
          { key: "a" },
          { key: 17 },
          { key: "17" },
          { key: "b" },
          { key: "a" },
        ],
      },
    },
  };
  await record("multi-sellers-id-types", "/multisearch/sellers", {
    search: sellersSearch,
    collections: { sellers: [{ _id: 17 }, { _id: "a" }] },
  });
  await record(
    "multi-sellers-id-missing",
    "/multisearch/sellers",
    { search: sellersSearch, collections: { sellers: [{ id: "a" }] } },
    500,
  );
  await record(
    "multi-sellers-db-offline",
    "/multisearch/sellers",
    { search: sellersSearch, fail: "sellers" },
    500,
  );
  mockFetch.mockRestore();
  const typed = new ObjectId("507f1f77bcf86cd799439031");
  await record("root-items-native-set-identity", "/items-from-offer/game", {
    rows: [
      {
        items: [
          { id: typed, title: "first object" },
          { id: new ObjectId(typed.toString()), title: "second object" },
          { id: typed.toString(), title: "string id" },
          { id: typed.toString(), title: "duplicate string" },
          { id: 7, title: "number" },
          { id: "7", title: "number string" },
          { id: null, title: "null" },
          { title: "undefined" },
          { title: "duplicate undefined" },
        ],
      },
    ],
  });
  for (const [label, attr, status] of [
    ["false", false, 200],
    ["legacy-object", { dev: { value: "studio" } }, 200],
    ["null-entry", [null], 500],
    [
      "numeric-key",
      [
        { key: 12, type: false, value: "t" },
        { key: "missing" },
        { key: "__proto__", value: "hidden" },
      ],
      200,
    ],
  ] as const) {
    await record(
      "root-base-checked-" + label,
      "/base-game/n",
      { oneReplies: [{ id: "a", namespace: "n", customAttributes: attr }] },
      status,
    );
    await record(
      "root-base-fallback-checked-" + label,
      "/base-game/n",
      {
        oneReplies: [null, { id: "a", namespace: "n", customAttributes: attr }],
      },
      status,
    );
  }
  const translation = {
    entityType: "offer",
    entityId: "n:a",
    locale: "es-ES",
    source: "test",
    data: { title: "Titulo", description: "Descripcion" },
  };
  await record("root-base-sparse-translated", "/base-game/n?locale=es-ES", {
    oneReplies: [{ id: "a", namespace: "n" }],
    collections: { egs_localizations: [translation] },
  });
  await record("root-base-native-id", "/base-game/n?locale=es-ES", {
    oneReplies: [{ id: typed, namespace: "n" }],
    collections: {
      egs_localizations: [{ ...translation, entityId: `n:${typed}` }],
    },
  });
  assertOracle("legacy-multisearch-root-http-node", cases);
});
