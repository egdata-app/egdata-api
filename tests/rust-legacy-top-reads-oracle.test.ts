import {
  BSON,
  Binary,
  Decimal128,
  Double,
  Long,
  MongoClient,
  ObjectId,
  Timestamp,
} from "mongodb";
import { afterAll, expect, it, vi } from "vitest";
import { assertOracle, captureResponse } from "../rust/oracles/record.js";

// Use the installed native driver's default BSON options, as the production
// client does. In particular it writes an undefined predicate value as null.
const bsonOptions = new MongoClient("mongodb://127.0.0.1:27017")
  .db("oracle")
  .collection("fixture").bsonOptions;

type DriverReply = [string, string, unknown, "promoteBson"?];
type CacheLookup = Record<string, unknown> | unknown;

const io = vi.hoisted(() => ({
  trace: [] as unknown[],
  replies: [] as DriverReply[],
  cache: null as CacheLookup,
  cacheByKey: false,
  rawCache: undefined as string | undefined,
  failAt: -1,
  deferAt: -1,
  holdUntilResponseAt: -1,
  releaseRead: undefined as (() => void) | undefined,
  unexpected: "",
}));

function bsonJson(value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value))
    return { $numberDouble: String(value) };
  if (
    value instanceof Double ||
    value instanceof Timestamp ||
    value instanceof Binary ||
    value instanceof Long ||
    value instanceof Decimal128
  )
    return BSON.EJSON.serialize(value, { relaxed: false });
  if (value instanceof ObjectId) return { $oid: value.toHexString() };
  if (value instanceof RegExp) {
    return {
      $regularExpression: { pattern: value.source, options: value.flags },
    };
  }
  if (value instanceof Date) {
    const { date } = BSON.deserialize(BSON.serialize({ date: value }));
    return { $date: date.toISOString() };
  }
  if (Array.isArray(value)) return value.map(bsonJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, bsonJson(v)]),
    );
  }
  return value;
}

function read(
  collection: string,
  method: string,
  query: unknown = {},
  options: unknown = {},
) {
  const next = io.replies.shift();
  if (!next || next[0] !== collection || next[1] !== method) {
    io.unexpected = `Unexpected ${collection}.${method}, expected ${next?.slice(0, 2)}`;
    throw new Error(io.unexpected);
  }
  // Negative limits set singleBatch on the wire. Keep the high-level driver
  // options too when the native numeric command is needed by the Rust port.
  const effectiveOptions = { ...(options as Record<string, unknown>) };
  const skip = effectiveOptions.skip;
  const limit = effectiveOptions.limit;
  const rawFind =
    method === "many" &&
    typeof limit === "number" &&
    (!Number.isSafeInteger(limit) ||
      (typeof skip === "number" && (!Number.isSafeInteger(skip) || skip < 0)));
  const rawOptions = rawFind ? { nodeOptions: bsonJson(options) } : {};
  if (rawFind && limit < 0) {
    effectiveOptions.limit = -limit;
    effectiveOptions.singleBatch = true;
  }
  const call = {
    collection,
    method,
    query: bsonJson(
      BSON.deserialize(BSON.serialize({ query }, bsonOptions)).query,
    ),
    options: bsonJson(effectiveOptions),
  };
  if (next[2] instanceof Error || io.failAt === io.trace.length) {
    io.trace.push({ call, ...rawOptions, error: true });
    throw next[2] instanceof Error ? next[2] : new Error("fixture read failed");
  }
  io.trace.push({ call, ...rawOptions, result: bsonJson(next[2]) });
  return next[3] === "promoteBson"
    ? BSON.deserialize(BSON.serialize({ rows: next[2] })).rows
    : next[2];
}

vi.mock("../src/db/index.js", () => ({
  db: {
    db: {
      command: async () => ({ ok: 1 }),
      collection: (name: string) => ({
        findOne: async (
          q: unknown = {},
          options: Record<string, unknown> = {},
        ) => read(name, "one", q, options),
        find: (q: unknown = {}, options: Record<string, unknown> = {}) => {
          const actual = { ...options };
          delete actual.lean;
          const cursor = {
            sort(value: unknown) {
              actual.sort = value;
              return cursor;
            },
            limit(value: number) {
              actual.limit = value;
              return cursor;
            },
            skip(value: number) {
              actual.skip = value;
              return cursor;
            },
            collation(value: unknown) {
              actual.collation = value;
              return cursor;
            },
            toArray: async () => {
              const index = io.trace.length;
              const result = read(name, "many", q, actual);
              if (index === io.holdUntilResponseAt) {
                Object.assign(io.trace[index] as object, {
                  releaseAfterResponse: true,
                });
                await new Promise<void>((resolve) => {
                  io.releaseRead = resolve;
                });
              }
              if (index === io.deferAt) {
                Object.assign(io.trace[index] as object, {
                  yieldBeforeReturn: true,
                });
                await new Promise<void>((resolve) => setImmediate(resolve));
              }
              return result;
            },
          };
          return cursor;
        },
        countDocuments: async (q: unknown = {}, options: unknown = {}) =>
          read(name, "count", q, options),
        aggregate: (q: unknown[], options: unknown = {}) => {
          const stages = [...q];
          const cursor = {
            limit(value: number) {
              stages.push({ $limit: value });
              return cursor;
            },
            toArray: async () => read(name, "aggregate", stages, options),
          };
          return cursor;
        },
      }),
    },
  },
}));
vi.mock("../src/clients/opensearch.js", () => ({
  opensearch: { search: async () => ({ body: {} }) },
}));
vi.mock("../src/clients/redis.js", () => ({
  default: { get: async () => null, ping: async () => "PONG" },
}));
vi.mock("../src/clients/response-cache.js", () => ({
  default: {
    get: async (key: string) => {
      if (io.trace.length === io.failAt) {
        io.trace.push({ call: { method: "get", key }, error: true });
        throw new Error("fixture cache read failed");
      }
      if (io.rawCache !== undefined) {
        io.trace.push({ call: { method: "get", key }, rawResult: io.rawCache });
        return io.rawCache;
      }
      const value = io.cacheByKey
        ? ((io.cache as Record<string, unknown>)[key] ?? null)
        : io.cache;
      io.trace.push({ call: { method: "get", key }, result: value });
      return value === null ? null : JSON.stringify(value);
    },
    set: async (key: string, value: string, _mode: string, ttl: number) => {
      if (io.trace.length === io.failAt) {
        io.trace.push({
          call: { method: "set", key, payload: JSON.parse(value), ttl },
          error: true,
        });
        throw new Error("fixture cache write failed");
      }
      io.trace.push({
        call: { method: "set", key, payload: JSON.parse(value), ttl },
        result: null,
      });
      return "OK";
    },
  },
  disconnectResponseCache: () => {},
}));

it("records legacy top-level reads and /offers/:id/overview from the full Node app", async () => {
  const { app } = await import("../src/index.js");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-17T00:00:00Z"));
  // The production helper reads the featured carousel from one upstream URL.
  // These replies exercise its real extraction and the route's two Redis entries.
  const slides = [
    { offer: { namespace: "ns-a", id: "offer-a" } },
    { offer: { namespace: "ns-b", id: "offer-b" } },
  ];
  vi.stubGlobal("fetch", async (input: string | URL) => {
    expect(String(input)).toBe(
      "https://store-site-backend-static-ipv4.ak.epicgames.com/storefrontLayout?locale=en-US&country=ES&start=0&count=9",
    );
    const call = { method: "featuredGames" };
    if (io.trace.length === io.failAt) {
      io.trace.push({ call, error: true });
      throw new Error("fixture storefront unavailable");
    }
    io.trace.push({ call, result: slides.map((s) => s.offer) });
    return Response.json({
      data: {
        Storefront: {
          storefrontModulesPaginated: {
            modules: [
              { id: "another", slides: [] },
              { id: "new-carousel-definitive", slides },
            ],
          },
        },
      },
    });
  });
  const cases: unknown[] = [];

  const get = async (
    name: string,
    path: string,
    status: number,
    reads: DriverReply[] = [],
    cache: unknown = null,
    options: {
      headers?: Record<string, string>;
      cacheByKey?: boolean;
      deferAt?: number;
      holdUntilResponseAt?: number;
      rawCache?: string;
    } = {},
  ) => {
    const run = async (failAt: number) => {
      io.failAt = failAt;
      io.deferAt = options.deferAt ?? -1;
      io.holdUntilResponseAt = options.holdUntilResponseAt ?? -1;
      io.releaseRead = undefined;
      io.unexpected = "";
      io.trace = [];
      io.replies = [...reads];
      io.cache = cache;
      io.rawCache = options.rawCache;
      io.cacheByKey = options.cacheByKey ?? false;
      const response = await app.request(path, {
        method: "GET",
        headers: options.headers,
      });
      if (options.holdUntilResponseAt !== undefined) {
        expect(
          io.replies.length,
          "the sibling price read must wait for its offer read",
        ).toBe(1);
        expect(io.releaseRead).toBeTypeOf("function");
        (io.releaseRead as unknown as () => void)();
        await vi.waitFor(() => expect(io.replies).toHaveLength(0));
      }
      expect(io.unexpected, name).toBe("");
      if (failAt < 0) {
        expect(response.status, name).toBe(status);
        expect(io.replies.length, `${name} unconsumed reads`).toBe(0);
      } else {
        expect(io.trace[failAt], name).toHaveProperty("error", true);
      }
      cases.push({
        name: failAt < 0 ? name : `${name}-failure-${failAt + 1}`,
        request: {
          method: "GET",
          path,
          ...(options.headers ? { headers: options.headers } : {}),
        },
        additionalHeaders: {
          "server-timing": response.headers.get("server-timing"),
          "x-cache": response.headers.get("x-cache"),
        },
        ...(options.holdUntilResponseAt !== undefined
          ? { releaseReadAfterResponse: true }
          : {}),
        trace: [...io.trace],
        response: await captureResponse(response),
      });
      return io.trace.length;
    };
    const calls = await run(-1);
    if (
      [
        "featured-expanded-fallback",
        "featured-cold-carousel",
        "latest-games-expanded-localized",
        "autocomplete-populated",
        "sales-expanded-fallback",
        "active-sales-inactive-expanded",
        "changelist-detail-found",
        "changelist-populated",
        "overview-populated",
      ].includes(name)
    ) {
      for (let index = 0; index < calls; index++) await run(index);
    }
  };

  const offerA = {
    _id: "mongo-a",
    id: "offer-a",
    namespace: "ns-a",
    title: "Alpha Game",
    description: "Alpha description",
    offerType: "BASE_GAME",
    creationDate: new Date("2026-10-01T00:00:00.000Z"),
    lastModifiedDate: new Date("2026-10-02T00:00:00.000Z"),
    keyImages: [{ type: "Thumbnail", url: "https://cdn/a.png" }],
    items: [{ id: "item-a" }],
    tags: [
      { id: "genre-1", name: "Action" },
      { id: "1264", name: "Co-op" },
      { id: "19847", name: "Achievements" },
    ],
    customAttributes: [{ key: "developerName", type: "STRING", value: "DevA" }],
    extraField: "expanded-only",
  };
  const offerB = {
    id: "offer-b",
    namespace: "ns-b",
    title: "Beta DLC",
    offerType: "DLC",
    lastModifiedDate: new Date("2026-10-03T00:00:00.000Z"),
    items: [],
    tags: [],
  };
  const priceA = {
    offerId: "offer-a",
    region: "US",
    price: {
      currencyCode: "USD",
      discount: 250,
      originalPrice: 1999,
      discountPrice: 1749,
    },
    appliedRules: { endDate: new Date("2026-12-01T00:00:00.000Z") },
  };
  const priceFree = {
    offerId: "offer-b",
    region: "US",
    price: {
      currencyCode: "USD",
      discount: 0,
      originalPrice: 0,
      discountPrice: 0,
    },
  };
  const priceFull = {
    offerId: "offer-b",
    region: "US",
    price: {
      currencyCode: "USD",
      discount: 0,
      originalPrice: 999,
      discountPrice: 999,
    },
  };
  const localizationEs = {
    entityType: "offer",
    entityId: "ns-a:offer-a",
    locale: "es-ES",
    source: "graphql.catalogOffer",
    data: { title: "Juego Alfa", description: "Descripcion Alfa" },
    fetchedAt: new Date("2026-10-05T00:00:00.000Z"),
  };

  // 1. GET /featured
  await get("featured-bad-locale", "/featured?locale=bad%20tag", 400);
  await get("featured-response-hit", "/featured", 200, [], [{ id: "cached" }]);
  await get(
    "featured-card",
    "/featured",
    200,
    [["offers", "many", [offerA, offerB]]],
    { "featured:v0.1": [{ id: "offer-a", namespace: "ns-a" }] },
    { cacheByKey: true },
  );
  await get(
    "featured-expanded-fallback",
    "/featured?expand=full&locale=es-ES",
    200,
    [
      ["offers", "many", [offerA]],
      ["egs_localizations", "many", []],
    ],
    { "featured:v0.1": [{ id: "offer-a", namespace: "ns-a" }] },
    { cacheByKey: true },
  );

  // 2. GET /latest-games
  await get("latest-games-bad-locale", "/latest-games?locale=bad%20tag", 400);
  await get("latest-games-bad-country", "/latest-games?country=ZZ", 404);
  await get("latest-games-hit", "/latest-games", 200, [], [{ id: "cached" }]);
  await get(
    "latest-games-card-cookie",
    "/latest-games",
    200,
    [
      ["offers", "many", [offerA, offerB]],
      ["pricev2", "many", [priceA]],
    ],
    null,
    { headers: { cookie: "EGDATA_COUNTRY=ES" } },
  );
  await get(
    "latest-games-expanded-localized",
    "/latest-games?expand=1&locale=es-es",
    200,
    [
      ["offers", "many", [offerA]],
      ["pricev2", "many", [priceA]],
      ["egs_localizations", "many", [localizationEs]],
    ],
  );

  // 3. GET /autocomplete
  await get("autocomplete-bad-locale", "/autocomplete?locale=bad%20tag", 400);
  await get("autocomplete-empty-query", "/autocomplete?query=", 200);
  await get("autocomplete-missing-query", "/autocomplete", 200);
  await get("autocomplete-hit", "/autocomplete?query=game", 200, [], {
    elements: [{ id: "cached" }],
    total: 1,
  });
  await get(
    "autocomplete-populated",
    "/autocomplete?query=epic+game&limit=5",
    200,
    [
      ["offers", "many", [offerA]],
      ["offers", "count", 1],
    ],
  );
  await get(
    "autocomplete-empty-results-capped",
    "/autocomplete?query=none&limit=50",
    200,
    [
      ["offers", "many", []],
      ["offers", "count", 0],
    ],
  );

  // 4. GET /sales
  await get("sales-bad-locale", "/sales?locale=bad%20tag", 400);
  await get("sales-bad-country", "/sales?country=ZZ", 404);
  await get("sales-hit", "/sales", 200, [], {
    elements: [{ id: "cached" }],
    page: 1,
    limit: 10,
    total: 1,
  });
  await get("sales-card-capped", "/sales?page=2&limit=50", 200, [
    [
      "pricev2",
      "aggregate",
      [
        { ...priceA, price: priceA, offer: offerA },
        { ...priceA, offer: null },
      ],
    ],
    ["pricev2", "count", 12],
  ]);
  await get("sales-expanded-fallback", "/sales?expand=true&locale=es-ES", 200, [
    ["pricev2", "aggregate", [{ ...priceA, price: priceA, offer: offerA }]],
    ["pricev2", "count", 1],
    ["egs_localizations", "many", []],
  ]);

  // 5. GET /active-sales
  await get("active-sales-bad-locale", "/active-sales?locale=bad%20tag", 400);
  await get("active-sales-bad-country", "/active-sales?country=ZZ", 404);
  await get("active-sales-hit", "/active-sales", 200, [], [{ id: "cached" }]);
  await get("active-sales-29899", "/active-sales", 200, [
    ["tags", "many", [{ id: "29899", name: "Always Active Sale" }]],
    ["offers", "many", [offerA]],
    ["pricev2", "many", []],
  ]);
  for (const [label, discount, originalPrice] of [
    ["string-discount", "12", 100],
    ["boolean-discount", true, 100],
    ["string-zero-original", 0, "0"],
  ]) {
    await get(`active-sales-${label}`, "/active-sales", 200, [
      ["tags", "many", [{ id: "sale", name: "Deals" }]],
      ["offers", "many", [offerA]],
      ["pricev2", "many", [{ ...priceA, price: { discount, originalPrice } }]],
    ]);
  }
  await get("active-sales-sparse-tag", "/active-sales", 200, [
    ["tags", "many", [{ id: "sale-no-name" }]],
    ["offers", "many", []],
    ["pricev2", "many", []],
  ]);
  await get("sales-falsy-offers", "/sales", 200, [
    ["pricev2", "aggregate", [false, null, 0, ""].map((offer) => ({ offer }))],
    ["pricev2", "count", 4],
  ]);
  await get("active-sales-top3-active", "/active-sales", 200, [
    ["tags", "many", [{ id: "100", name: "Spring Sale" }]],
    ["offers", "many", [offerA, offerB, offerA, offerB]],
    ["pricev2", "many", [priceA, priceFree]],
  ]);
  await get(
    "active-sales-inactive-expanded",
    "/active-sales?expand=full&locale=es-ES",
    200,
    [
      ["tags", "many", [{ id: "101", name: "Winter Deals" }]],
      ["offers", "many", [offerB]],
      ["pricev2", "many", [priceFull]],
      ["egs_localizations", "many", []],
    ],
  );

  // 6. GET /changelist
  await get("changelist-hit", "/changelist", 200, [], [{ _id: "cached" }]);
  const oid = new ObjectId("507f1f77bcf86cd799439011");
  await get("changelist-populated", "/changelist?page=2&limit=100", 200, [
    [
      "changelogs_v2",
      "many",
      [
        {
          _id: oid,
          timestamp: new Date("2026-10-03T00:00:00.000Z"),
          metadata: { contextType: "offer", contextId: "offer-a" },
        },
        {
          _id: "chg-item",
          metadata: { contextType: "item", contextId: "item-a" },
        },
        {
          _id: "chg-asset",
          metadata: { contextType: "asset", contextId: "app-a" },
        },
        {
          _id: "chg-build-oid",
          metadata: {
            contextType: "build",
            contextId: "507f1f77bcf86cd799439022",
          },
        },
        {
          _id: "chg-build-str",
          metadata: { contextType: "build", contextId: "build-str" },
        },
        {
          _id: "chg-unknown",
          metadata: { contextType: "other", contextId: "x" },
        },
        { _id: "chg-no-meta" },
        {
          _id: "chg-ctx-err",
          metadata: { contextType: "offer", contextId: "broken" },
        },
      ],
    ],
    ["offers", "one", { id: "offer-a", title: "Alpha Game" }],
    ["items", "one", { id: "item-a", title: "Item A" }],
    ["assets", "one", { id: "asset-a", artifactId: "app-a" }],
    ["builds", "one", { _id: "507f1f77bcf86cd799439022", appName: "app-a" }],
    ["builds", "one", { _id: "build-str", appName: "app-b" }],
    ["offers", "one", new Error("context read failed")],
  ]);

  // 7. GET /changelist/{id}
  await get(
    "changelist-detail-hit",
    "/changelist/507f1f77bcf86cd799439011",
    200,
    [],
    {
      _id: "507f1f77bcf86cd799439011",
    },
  );
  await get(
    "changelist-detail-missing-oid",
    "/changelist/507f1f77bcf86cd799439099",
    404,
    [["changelogs_v2", "one", null]],
  );
  await get("changelist-detail-missing-str", "/changelist/not-an-oid", 404, [
    ["changelogs_v2", "one", null],
  ]);
  await get(
    "changelist-detail-found",
    "/changelist/507f1f77bcf86cd799439011",
    200,
    [
      [
        "changelogs_v2",
        "one",
        {
          _id: oid,
          timestamp: new Date("2026-10-03T00:00:00.000Z"),
          metadata: { contextType: "offer", contextId: "offer-a" },
        },
      ],
      ["offers", "one", { id: "offer-a", title: "Alpha Game" }],
    ],
  );

  // 8. GET /offers/{id}/overview
  await get(
    "overview-bad-locale",
    "/offers/offer-a/overview?locale=bad%20tag",
    400,
  );
  await get("overview-bad-country", "/offers/offer-a/overview?country=ZZ", 404);
  await get("overview-hit", "/offers/offer-a/overview", 200, [], {
    offer: { id: "cached" },
  });
  await get("overview-missing", "/offers/missing/overview", 404, [
    ["offers", "one", null],
  ]);
  await get("overview-populated", "/offers/offer-a/overview", 200, [
    ["offers", "one", offerA],
    ["pricev2", "one", priceA],
    ["media", "one", { _id: "offer-a", images: [] }],
    ["igdb", "one", { offerId: "offer-a", name: "Alpha" }],
    [
      "offersubitems",
      "many",
      [{ _id: "offer-a", subItems: [{ id: "item-sub" }] }],
    ],
    [
      "sandboxes",
      "one",
      {
        _id: "ns-a",
        id: "ns-a",
        ageGatings: { ESRB: { ageControl: 17 }, PEGI: { ageControl: 18 } },
      },
    ],
    [
      "freegames",
      "many",
      [{ id: "offer-a", startDate: new Date("2026-01-01T00:00:00Z") }],
    ],
    ["tags", "many", [{ id: "genre-1", name: "Action", groupName: "genre" }]],
    [
      "items",
      "many",
      [
        {
          id: "item-a",
          customAttributes: [
            { key: "ThirdPartyManagedApp", type: "STRING", value: "Origin" },
            { key: "PresenceId", type: "STRING", value: "p1" },
          ],
        },
      ],
    ],
    ["ratings_polls", "one", { _id: "ns-a", averageRating: 4.5 }],
    ["assets", "many", [{ artifactId: "app-a", itemId: "item-a" }]],
    [
      "builds",
      "aggregate",
      [
        {
          _id: "app-a",
          doc: {
            technologies: [
              { technology: "UE5", section: "Engine" },
              { technology: "UE5", section: "Dup" },
              null,
              { technology: "Denuvo", section: "DRM" },
            ],
          },
        },
      ],
    ],
  ]);
  await get(
    "overview-settled-failures-fallback",
    "/offers/offer-b/overview?country=ES&locale=es-ES",
    200,
    [
      ["offers", "one", offerB],
      ["pricev2", "one", new Error("price down")],
      ["media", "one", new Error("media down")],
      ["igdb", "one", new Error("igdb down")],
      ["offersubitems", "many", new Error("subitems down")],
      [
        "sandboxes",
        "one",
        { _id: "ns-b", ageGatings: { ESRB: { ageControl: 13 } } },
      ],
      ["freegames", "many", new Error("freegames down")],
      ["tags", "many", new Error("tags down")],
      ["items", "many", []],
      ["ratings_polls", "one", null],
      ["assets", "many", []],
      ["builds", "aggregate", []],
      ["egs_localizations", "many", []],
    ],
  );

  const id = new ObjectId("507f1f77bcf86cd799439088");
  const localizedOffer = {
    ...offerA,
    id: id.toHexString(),
    title: "String id",
  };
  const typedOffers = [
    { ...offerA, id, title: "ObjectId" },
    localizedOffer,
    { ...offerA, id: 7, title: "Number" },
    { ...offerA, id: "7", title: "String number" },
    { namespace: "ns-a", title: "Absent" },
    { id: null, namespace: "ns-a", title: "Null" },
  ];
  const typedPrices = [
    { offerId: new ObjectId(id.toHexString()), price: { discount: 3 } },
    { offerId: id.toHexString(), price: { discount: 11 } },
    { offerId: id.toHexString(), price: { discount: 99 } },
    { offerId: 7, price: { discount: 7 } },
    { offerId: "7", price: { discount: 17 } },
    { price: { discount: 100 } },
    { offerId: null, price: { discount: 1 } },
  ];
  const translated = {
    ...localizationEs,
    entityId: `ns-a:${id}`,
    data: { title: "Translated string id" },
  };
  for (const expand of ["", "&expand=full"]) {
    await get(
      `latest-games-typed-${expand ? "full" : "card"}`,
      `/latest-games?locale=es-ES${expand}`,
      200,
      [
        ["offers", "many", typedOffers],
        ["pricev2", "many", typedPrices],
        ["egs_localizations", "many", [translated]],
      ],
    );
    await get(
      `active-sales-typed-${expand ? "full" : "card"}`,
      `/active-sales?locale=es-ES${expand}`,
      200,
      [
        ["tags", "many", [{ id, name: "Typed sale" }]],
        ["offers", "many", typedOffers],
        ["pricev2", "many", typedPrices],
        ["egs_localizations", "many", [translated]],
      ],
    );
  }
  const featuredCache = { "featured:v0.1": [{ id: "offer-a" }] };
  const attrs = [
    { key: 12, value: "numeric" },
    { key: "absent" },
    { key: "__proto__", value: "hidden" },
  ];
  for (const [label, attributes, status] of [
    ["historical", attrs, 200],
    ["null-entry", [null], 500],
    ["falsy", false, 200],
    ["object", { title: { value: "v" } }, 200],
  ] as const) {
    const row = { ...offerA, customAttributes: attributes };
    for (const expand of ["", "?expand=%EF%BB%BFfull%EF%BB%BF"]) {
      await get(
        `featured-attributes-${label}-${expand ? "full" : "card"}`,
        `/featured${expand}`,
        status,
        [["offers", "many", [row]]],
        featuredCache,
        { cacheByKey: true },
      );
    }
    await get(
      `autocomplete-attributes-${label}`,
      "/autocomplete?query=%EF%BB%BFone%EF%BB%BF%20%20two&limit=2",
      status,
      [
        ["offers", "many", [row]],
        ...(status === 200 ? [["offers", "count", 1] as DriverReply] : []),
      ],
    );
  }
  await get(
    "featured-corrupt-index-member",
    "/featured",
    500,
    [],
    { "featured:v0.1": [null] },
    { cacheByKey: true },
  );
  await get(
    "featured-corrupt-index-shape",
    "/featured",
    500,
    [],
    { "featured:v0.1": "wrong" },
    { cacheByKey: true },
  );
  await get("active-sales-missing-tag-id", "/active-sales", 200, [
    ["tags", "many", [{ name: "missing-id" }]],
    ["offers", "many", []],
    ["pricev2", "many", []],
  ]);
  for (const [label, full] of [
    ["card", false],
    ["full", true],
  ] as const) {
    const rows = [
      { offer: typedOffers[0], price: "object-price" },
      { offer: typedOffers[1], price: "first-string" },
      { offer: typedOffers[1], price: "last-string" },
      { offer: typedOffers[2], price: "first-number" },
      { offer: typedOffers[2], price: "last-number" },
      { offer: { ...offerB, price: "obsolete" } },
      { offer: "ab" },
      { offer: [1, 2] },
      { offer: 4 },
      { offer: false },
    ];
    await get(
      `sales-mixed-projections-${label}`,
      `/sales${full ? "?expand=full" : ""}`,
      200,
      [
        ["pricev2", "aggregate", rows],
        ["pricev2", "count", rows.length],
      ],
    );
    await get(
      `sales-null-attribute-${label}`,
      `/sales${full ? "?expand=true" : ""}`,
      full ? 200 : 500,
      [
        [
          "pricev2",
          "aggregate",
          [{ offer: { ...offerA, customAttributes: [null] } }],
        ],
        ["pricev2", "count", 1],
      ],
    );
  }
  const changes = [
    { metadata: { contextType: "offer", contextId: id } },
    { metadata: { contextType: "item", contextId: 11 } },
    { metadata: { contextType: "asset", contextId: ["old"] } },
    { metadata: { contextType: "build", contextId: id } },
    { metadata: { contextType: "offer", contextId: 0 } },
    { metadata: ["old", "metadata"] },
    { metadata: "old" },
  ];
  await get("changelist-native-contexts", "/changelist", 200, [
    ["changelogs_v2", "many", changes],
    ["offers", "one", { id, title: "Native" }],
    ["items", "one", { id: 11 }],
    ["assets", "one", null],
    ["builds", "one", { _id: id }],
  ]);
  await get("changelist-detail-native-context", "/changelist/legacy", 200, [
    ["changelogs_v2", "one", changes[1]],
    ["items", "one", new Error("independent read failed")],
  ]);

  const overview = async (
    label: string,
    status: number,
    fields: Record<string, unknown>,
    input: {
      subs?: unknown[];
      sandbox?: unknown;
      items?: unknown[];
      assets?: unknown[];
      builds?: unknown[];
      stop?: "refs" | "features" | "builds";
      genres?: unknown[];
      localized?: unknown[] | Error;
    } = {},
  ) => {
    const reads: DriverReply[] = [
      ["offers", "one", { ...offerA, ...fields }],
      ["pricev2", "one", null],
      ["media", "one", null],
      ["igdb", "one", null],
      ["offersubitems", "many", input.subs ?? []],
      ["sandboxes", "one", input.sandbox ?? null],
      ["freegames", "many", []],
      ["tags", "many", input.genres ?? []],
    ];
    if (input.stop !== "refs") {
      reads.push(["items", "many", input.items ?? []]);
      if (input.stop !== "features")
        reads.push(
          ["ratings_polls", "one", null],
          ["assets", "many", input.assets ?? []],
          ["builds", "aggregate", input.builds ?? []],
        );
    }
    if (input.localized !== undefined)
      reads.push(["egs_localizations", "many", input.localized]);
    await get(
      `overview-historical-${label}`,
      "/offers/offer-a/overview" +
        (input.localized !== undefined ? "?locale=es-ES" : ""),
      status,
      reads,
    );
  };
  await overview(
    "typed-joins",
    200,
    { namespace: id, items: [{ id }, { id: 7 }, {}] },
    {
      subs: [{ subItems: [{ id }, {}] }],
      sandbox: { id },
      items: [{ id }, { id: 8 }, {}],
      assets: [{ artifactId: id }, { artifactId: 4 }, {}],
      builds: [
        { doc: { buildVersion: "pre-technologies" } },
        { doc: { technologies: "legacy" } },
        { doc: { technologies: { technology: "EOS" } } },
        {
          doc: {
            technologies: [
              { technology: "EOS" },
              { technology: ["same"] },
              { technology: ["same"] },
              { technology: {} },
              { technology: {} },
              { technology: 7 },
              { technology: 7 },
              false,
              null,
            ],
          },
        },
      ],
    },
  );
  await overview(
    "missing-links",
    200,
    { namespace: undefined },
    { sandbox: {} },
  );
  await overview(
    "native-genre-identity",
    200,
    {
      tags: [
        { id, name: "ObjectId" },
        { id: id.toString(), name: "String" },
        { id: 7, name: "Numeric" },
        { name: "missing" },
      ],
    },
    { genres: [{ id: new ObjectId(id.toString()) }, { id: 7 }, {}] },
  );
  await overview("null-reference", 500, { items: [null] }, { stop: "refs" });
  await overview(
    "null-subitem",
    500,
    {},
    { subs: [{ subItems: [null] }], stop: "refs" },
  );
  await overview(
    "null-feature-attribute",
    500,
    {},
    { items: [{ customAttributes: [null] }], stop: "features" },
  );
  await overview("null-tag", 500, { tags: [null] }, { stop: "features" });
  await overview(
    "null-rating-root",
    500,
    {},
    { sandbox: { ageGatings: null }, stop: "features" },
  );
  await overview("null-build", 500, {}, { builds: [{ doc: null }] });
  await overview("missing-build", 500, {}, { builds: [{}] });
  await overview("numeric-attributes", 200, { customAttributes: attrs });
  for (const [label, value] of [
    ["false", false],
    ["zero", 0],
    ["empty", ""],
    ["null", null],
  ] as const) {
    await overview("falsy-attributes-" + label, 200, {
      customAttributes: value,
    });
  }
  await overview(
    "localized-provenance",
    200,
    { title: undefined },
    { localized: [{ ...localizationEs, sourceUpdatedAt: false }] },
  );
  await overview(
    "localization-unavailable",
    500,
    {},
    { localized: new Error("fixture translations unavailable") },
  );

  await overview("null-attribute", 500, { customAttributes: [null] });

  await get(
    "active-sales-completion-order",
    "/active-sales",
    200,
    [
      ["tags", "many", [{ id: "slow" }, { id: "fast" }]],
      ["offers", "many", [{ id: "slow-offer" }]],
      ["offers", "many", [{ id: "fast-offer" }]],
      ["pricev2", "many", [{ offerId: "fast-offer", price: { discount: 12 } }]],
      ["pricev2", "many", [{ offerId: "slow-offer", price: { discount: 0 } }]],
    ],
    null,
    { deferAt: 2 },
  );

  const native = <T>(value: T) =>
    BSON.deserialize(BSON.serialize({ value })).value;
  const decimal = native(Decimal128.fromString("3.25"));
  const largeLong = native(Long.fromString("9007199254741099"));
  for (const [label, discount, originalPrice] of [
    ["positive-decimal", decimal, 100],
    ["negative-decimal", native(Decimal128.fromString("-9.5")), 100],
    ["positive-long", largeLong, 100],
    ["single-value-array", [decimal], 100],
    ["positive-infinity", Infinity, 100],
    ["nan-discount", NaN, 100],
    ["zero-decimal", 0, native(Decimal128.fromString("0"))],
    ["zero-primitive", 0, native(Long.ZERO)],
  ] as const) {
    await get("active-sales-discount-" + label, "/active-sales", 200, [
      ["tags", "many", [{ id: "test-sale", name: "Sale" }]],
      ["offers", "many", [offerA]],
      ["pricev2", "many", [{ ...priceA, price: { discount, originalPrice } }]],
    ]);
  }
  for (const [label, tags, itemAttributes] of [
    ["numeric-feature", [{ id: 1264 }, { id: 19847 }], []],
    [
      "numeric-shadows-string",
      [
        { id: "1264" },
        { id: 1264 },
        { id: "19847" },
        { id: native(Decimal128.fromString("19847")) },
      ],
      [],
    ],
    [
      "string-shadows-native",
      [{ id: 1264 }, { id: "1264" }, { id: ["19847"] }, { id: "19847" }],
      [],
    ],
    [
      "launcher-object-keys",
      [],
      [{ ThirdPartyManagedApp: { key: "isUplay", value: "v" } }],
    ],
    [
      "launcher-truthy",
      [],
      [{ ThirdPartyManagedApp: "managed", MonitorPresense: true }],
    ],
    [
      "launcher-shadowed",
      [],
      [
        [{ key: "isUplay", value: "yes" }],
        { isUplay: false, partnerType: null },
      ],
    ],
  ] as const) {
    await overview(
      "derived-features-" + label,
      200,
      { tags },
      {
        items: itemAttributes.map((customAttributes) => ({ customAttributes })),
      },
    );
  }
  await overview(
    "native-truth-and-equality",
    200,
    { tags: [{ id: NaN, name: "not a number" }] },
    {
      genres: [{ id: NaN }],
      sandbox: { ageGatings: { ESRB: Infinity } },
      builds: [
        {
          doc: {
            technologies: [
              { technology: NaN, n: 1 },
              { technology: NaN, n: 2 },
              Infinity,
            ],
          },
        },
      ],
    },
  );
  await overview(
    "wrong-items-container",
    500,
    { items: "not a list" },
    { stop: "refs" },
  );
  await overview(
    "wrong-tags-container",
    500,
    { tags: {} },
    { stop: "features" },
  );
  for (const [label, metadata] of [
    ["date", new Date("2026-01-01Z")],
    ["oid", native(id)],
    ["decimal", decimal],
    ["long", largeLong],
    ["binary", native(new Binary(Buffer.from([12, 14])))],
    ["timestamp", native(new Timestamp({ t: 4, i: 8 }))],
  ] as const) {
    await get(
      "changelist-native-metadata-" + label,
      "/changelist/native",
      200,
      [["changelogs_v2", "one", { _id: "native", metadata }]],
    );
  }
  for (const [label, path, raw, status] of [
    ["latest-null", "/latest-games", "null", 200],
    ["sales-legacy-array", "/sales", "[false,0]", 200],
    ["autocomplete-corrupt", "/autocomplete?query=abc", "{invalid", 500],
    ["overview-corrupt", "/offers/offer-a/overview", "[", 500],
  ] as const)
    await get("top-raw-cache-" + label, path, status, [], null, {
      rawCache: raw,
    });
  await get("featured-cold-carousel", "/featured", 200, [
    ["offers", "many", [offerA, offerB]],
  ]);
  await get("active-sales-sibling-after-read-failure", "/active-sales", 500, [
    ["tags", "many", [{ id: "bad" }, { id: "good" }]],
    ["offers", "many", new Error("fixture sale unavailable")],
    ["offers", "many", [offerB]],
    ["pricev2", "many", [priceFree]],
  ]);
  await get("changelist-invalid-limit", "/changelist?limit=no-number", 200, [
    ["changelogs_v2", "many", [{ id: "sample" }]],
  ]);
  await get("changelist-invalid-page", "/changelist?page=no-number", 200, [
    ["changelogs_v2", "many", []],
  ]);
  await get(
    "changelist-invalid-limit-outage",
    "/changelist?limit=no-number",
    500,
    [["changelogs_v2", "many", new Error("fixture collection unavailable")]],
  );
  await get(
    "autocomplete-invalid-limit",
    "/autocomplete?query=game&limit=no-number",
    200,
    [
      ["offers", "many", [offerA]],
      ["offers", "count", 1],
    ],
  );
  await get(
    "autocomplete-invalid-limit-outage",
    "/autocomplete?query=game&limit=no-number",
    500,
    [["offers", "many", new Error("fixture collection unavailable")]],
  );
  await get("sales-invalid-limit", "/sales?limit=no-number", 500, [
    ["pricev2", "aggregate", new Error("invalid aggregation limit")],
  ]);
  await get("sales-invalid-page", "/sales?page=no-number", 500, [
    ["pricev2", "aggregate", new Error("invalid aggregation skip")],
  ]);
  await get(
    "active-sales-error-before-stalled-sibling",
    "/active-sales",
    500,
    [
      ["tags", "many", [{ id: "bad" }, { id: "slow" }]],
      ["offers", "many", new Error("fixture sale unavailable")],
      ["offers", "many", [offerB]],
      ["pricev2", "many", [priceFree]],
    ],
    null,
    { holdUntilResponseAt: 3 },
  );
  await get("active-sales-missing-price-object", "/active-sales", 500, [
    ["tags", "many", [{ id: "bad" }]],
    ["offers", "many", [offerA]],
    ["pricev2", "many", [{ offerId: offerA.id }]],
  ]);
  for (const rating of [false, "", 0]) {
    await overview(
      "falsy-rating-" + typeof rating,
      200,
      {},
      { sandbox: { ageGatings: { ESRB: rating } } },
    );
  }
  await overview(
    "sparse-technologies",
    200,
    { customAttributes: { k: { type: "STRING", value: "v" } } },
    {
      builds: [
        { doc: { technologies: [false, "", 0, { technology: "EOS" }] } },
      ],
    },
  );
  await get("changelist-empty-context", "/changelist", 200, [
    [
      "changelogs_v2",
      "many",
      [
        { metadata: { contextType: "" } },
        { metadata: { contextType: "offer" } },
      ],
    ],
  ]);
  await get("changelist-negative-skip", "/changelist?page=2&limit=-1", 500, [
    ["changelogs_v2", "many", new Error("negative skip")],
  ]);
  await get("changelist-negative-limit", "/changelist?limit=-1", 200, [
    ["changelogs_v2", "many", []],
  ]);
  await get("sales-huge-page", "/sales?page=900000000000000000001", 500, [
    ["pricev2", "aggregate", new Error("skip out of range")],
  ]);
  await get(
    "sales-huge-limit",
    "/sales?limit=99999999999999999999999999",
    200,
    [
      ["pricev2", "aggregate", []],
      ["pricev2", "count", 0],
    ],
  );
  for (const [label, zero] of [
    ["int64", Long.ZERO],
    ["double", new Double(-0)],
  ] as const) {
    await get("active-sales-original-zero-" + label, "/active-sales", 200, [
      ["tags", "many", [{ id: "sale" }]],
      ["offers", "many", [offerA]],
      [
        "pricev2",
        "many",
        [{ ...priceA, price: { discount: 0, originalPrice: zero } }],
        "promoteBson",
      ],
    ]);
  }
  await get(
    "autocomplete-large-negative-limit",
    "/autocomplete?query=game&limit=-999999999999999999999999999",
    200,
    [
      ["offers", "many", []],
      ["offers", "count", 0],
    ],
  );
  await get(
    "changelist-overflow-page",
    "/changelist?page=900000000000000000001",
    200,
    [["changelogs_v2", "many", []]],
  );
  await get(
    "changelist-valid-negative-zero-skip",
    "/changelist?page=1&limit=-2",
    200,
    [["changelogs_v2", "many", []]],
  );
  await get(
    "sales-no-numeric-prefix-cache-hit",
    "/sales?limit=invalid",
    200,
    [],
    { cached: "NaN key" },
  );
  assertOracle("legacy-top-reads-http-node", cases);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  const { server } = await import("../src/graphql/index.js");
  await server.stop();
});
