import { expect, it, vi } from "vitest";
import { BSON, BSONSymbol, Decimal128, ObjectId, Long } from "mongodb";
import { recordMongoReads } from "../rust/oracles/read-models.js";
import { assertOracle, fixtureValue } from "../rust/oracles/record.js";
import { Offer } from "../src/models/index.js";
import collections from "../src/v1/routes/collections.js";
import promotions from "../src/v1/routes/promotions.js";

it("records invalid outgoing cursor dates as the BSON driver sends them", () => {
  const filter = { $or: [{ releaseDate: { $gt: new Date("invalid") } }] };
  const wire = BSON.deserialize(BSON.serialize(filter));
  expect(wire.$or[0].releaseDate.$gt.getTime()).toBe(0);
  expect(fixtureValue(filter, "query")).toEqual(fixtureValue(wire));
  expect(() => fixtureValue(filter, true)).toThrow(RangeError);
});

it("rejects a promotion cursor with a BSON date outside the JavaScript Date range", async () => {
  const wire = BSON.serialize({ lastModifiedDate: new Date(0) });
  new DataView(wire.buffer, wire.byteOffset, wire.byteLength).setBigInt64(
    wire.byteLength - 9,
    8_640_000_000_000_001n,
    true,
  );
  const row = { id: "boundary", ...BSON.deserialize(wire) };
  const { record } = recordMongoReads(promotions);
  const find = Offer.find.bind(Offer);
  const spy = vi.spyOn(Offer, "find").mockImplementation((...args) => {
    const query = find(...args);
    vi.spyOn(query, "lean").mockResolvedValue([row, row]);
    return query;
  });
  try {
    const body = await record(
      "out-of-range promotion cursor",
      "/v1/promotions/event?limit=1",
      500,
      { tags: { id: "event" } },
    );
    expect(body.code).toBe("INTERNAL_ERROR");
  } finally {
    spy.mockRestore();
  }
});

it("records collection and promotion responses, Mongo reads and Redis cache behavior", async () => {
  const { cases, record } = recordMongoReads(collections, promotions);
  const game = {
    id: "game-a",
    namespace: "ns-a",
    title: "Game A",
    lastModifiedDate: "2026-01-02T03:04:05.000Z",
    upcoming: false,
  };
  const price = {
    offerId: "game-a",
    region: "US",
    price: { discountPrice: 399, currencyCode: "USD" },
  };
  const event = { id: "event", name: "Winter sale", referenceCount: 3 };
  const collection = {
    _id: "ranked",
    name: "Ranked",
    updatedAt: "2026-02-02T00:00:00.000Z",
  };
  const position = {
    offerId: "game-a",
    position: 1,
    previous: 4,
    positions: [{ position: 1, date: "2021-01-02T00:00:00.000Z" }],
  };
  const localization = {
    entityId: "ns-a:game-a",
    entityType: "offer",
    locale: "fr",
    source: "editor",
    data: { title: "Jeu A" },
  };
  const collectionRows = {
    collections_v2: collection,
    game_positions: [
      position,
      { offerId: "missing", position: 2 },
      { offerId: "game-z", position: 3 },
    ],
    offers: [game],
    pricev2: [price],
    egs_localizations: [localization],
  };
  const offerRows = {
    tags: event,
    offers: [game, { id: "game-b" }],
    pricev2: [price],
  };
  const ranked = "/v1/collections/ranked";
  for (const [name, path] of [
    ["current", ranked],
    ["week", ranked + "/2020W53"],
  ]) {
    const page = path + "?locale=fr&limit=2";
    const body = await record(name + "-page", page, 200, collectionRows);
    expect(body.data).toHaveLength(1);
    expect(body.meta.pagination.nextCursor).toEqual(expect.any(String));
    await record(
      name + "-continue",
      page + "&cursor=" + body.meta.pagination.nextCursor,
      200,
      { collections_v2: collection },
    );
  }
  await record("week-extended-end-year", ranked + "/9999W52", 200, {
    collections_v2: collection,
  });
  await record("week-invalid-format", ranked + "/2020-53", 400);
  await record("week-does-not-exist", ranked + "/2021W53", 400);
  await record("week-reserved-year", ranked + "/0099W01", 400);
  await record("collection-missing", ranked, 404);
  await record("collection-store-error", ranked, 500, {
    collections_v2: "FAIL",
  });
  await record(
    "collection-cache-hit",
    ranked,
    200,
    { collections_v2: collection },
    {
      title: "Cached",
      updatedAt: null,
      data: [],
      pagination: { limit: 100, hasMore: false, nextCursor: null },
    },
  );
  await record("promotion-list", "/v1/promotions?limit=2", 200, {
    tags: [event],
  });
  await record("promotion-list-cached", "/v1/promotions", 200, {}, [event]);
  await record(
    "promotion-list-cache-unavailable",
    "/v1/promotions",
    200,
    { tags: [event] },
    undefined,
    true,
  );
  const page = "/v1/promotions/event";
  await record("promotion-missing", page, 404);
  await record("promotion-cover", page + "/cover?locale=fr", 200, {
    "offers.many": [{ namespace: "ns-a" }, { namespace: null }],
    "offers.one": game,
    egs_localizations: [localization],
  });
  await record("promotion-cover-missing", page + "/cover", 404);
  for (const [name, query, rows] of [
    ["date", "q=%5Bfoo%5D.*&sortDir=asc", offerRows],
    ["upcoming", "sortBy=upcoming", offerRows],
    [
      "price",
      "sortBy=price&sortDir=asc",
      {
        ...offerRows,
        offers: [
          {
            ...game,
            priceDoc: { ...price, price: { discountPrice: 222 } },
            _priceSort: 222,
          },
          { id: "game-b" },
        ],
      },
    ],
    [
      "price-null",
      "sortBy=price",
      {
        ...offerRows,
        offers: [{ ...game, _priceSort: null }, { id: "game-b" }],
      },
    ],
  ] as const) {
    const path = page + "?limit=1&" + query;
    const body = await record("promotion-" + name, path, 200, rows);
    expect(body.meta.pagination.nextCursor).toEqual(expect.any(String));
    await record(
      "promotion-" + name + "-continue",
      path + "&cursor=" + body.meta.pagination.nextCursor,
      200,
      { tags: event },
    );
  }
  await record(
    "promotion-invalid-query",
    page + "?sortBy=x&sortDir=y&bad=1&q=" + "a".repeat(201),
    400,
  );
  await record("promotion-invalid-region", page + "?country=XYZ", 400);
  await record("promotion-invalid-cursor", page + "?cursor=bad", 400, {
    tags: event,
  });
  const oid = new ObjectId("507f1f77bcf86cd799439011");
  for (const [name, hit] of Object.entries({
    string: "🎮ok",
    missing: {},
    own: { length: "7" },
    false: false,
  })) {
    await record(
      "promotion-list-cache-" + name,
      "/v1/promotions",
      200,
      {},
      hit,
    );
  }
  for (const [name, hit] of Object.entries({
    empty: {},
    missingData: { title: null, start: 3 },
    missingMeta: { data: [], pagination: null },
    scalar: "history",
    defined: { data: null, title: 42 },
  })) {
    await record(
      "promotion-page-cache-" + name,
      page,
      200,
      { tags: event },
      hit,
    );
  }
  for (const [i, hit] of [false, 0, ""].entries())
    await record("promotion-falsey-cover-" + i, page + "/cover", 404, {}, hit);
  await record("promotion-cover-native-namespaces", page + "/cover", 200, {
    "offers.many": [
      { namespace: oid },
      { namespace: "literal" },
      { namespace: 17 },
      { namespace: null },
    ],
    "offers.one": game,
  });
  for (const [name, attributes, status] of [
    ["null", null, 200],
    ["sparse", [{}, { key: 7, type: 2, value: 4 }], 200],
    ["malformed", [null], 500],
    ["map", { platform: "pc" }, 200],
  ] as const) {
    const offer = { ...game, customAttributes: attributes };
    await record(
      "promotion-cover-attributes-" + name,
      page + "/cover",
      status,
      { "offers.one": offer },
    );
    await record("promotion-offers-attributes-" + name, page, status, {
      tags: event,
      offers: [offer],
      pricev2: [price],
    });
  }
  for (const [name, sortBy, value, identifier, eventName] of [
    ["number-date", "lastModifiedDate", 42, 17, ["Event", "2026"]],
    [
      "native-date",
      "releaseDate",
      new Date("2025-07-01T00:00:00Z"),
      oid,
      { name: "historical" },
    ],
    ["date-string", "effectiveDate", "2026-02-03", null, false],
    ["absent-id", "creationDate", null, undefined, 5],
    ["boolean-date", "viewableDate", true, "target", 17],
    ["object-sort", "pcReleaseDate", { v: 4 }, "object", "test"],
    ["upcoming-number", "upcoming", 1, 22, "event"],
    ["upcoming-yes", "upcoming", true, "yes", "event"],
    ["decimal-price", "price", Decimal128.fromString("349.8"), 42, "event"],
    ["raw-array-price", "price", [1, 2], "price", "event"],
    ["boolean-price", "price", true, "bool", "event"],
    [
      "long-price",
      "price",
      Long.fromString("9007199254740997"),
      "long",
      "event",
    ],
  ] as const) {
    const offer = {
      ...game,
      id: identifier,
      [sortBy === "price" ? "_priceSort" : sortBy]: value,
      ...(sortBy === "price"
        ? {
            priceDoc: {
              offerId: identifier,
              price: {
                currencyCode: "USD",
                discountPrice: Decimal128.fromString("349.8"),
              },
            },
          }
        : {}),
    };
    if (identifier === undefined) delete (offer as Record<string, unknown>).id;
    const route = page + "?sortBy=" + sortBy + "&limit=1";
    const rows = {
      tags: { ...event, name: eventName },
      offers: [offer, game],
      pricev2: [
        {
          offerId: identifier,
          region: "US",
          price: { discountPrice: 999, currencyCode: "USD" },
        },
      ],
    };
    const body = await record("promotion-native-" + name, route, 200, rows);
    await record(
      "promotion-next-" + name,
      route + "&cursor=" + body.meta.pagination.nextCursor,
      200,
      { tags: event },
    );
  }
  for (const [name, seed] of Object.entries({
    list: { tags: "FAIL" },
    tag: { tags: "FAIL" },
    offers: { tags: event, offers: "FAIL" },
    prices: { tags: event, offers: [game], pricev2: "FAIL" },
    cover: { "offers.one": "FAIL" },
    localized: { tags: event, offers: [game], egs_localizations: "FAIL" },
  })) {
    await record(
      "promotion-error-" + name,
      name === "list"
        ? "/v1/promotions"
        : name === "cover"
          ? page + "/cover"
          : page + "?locale=fr",
      500,
      seed,
    );
  }
  for (const [name, path] of [
    ["list-query", "/v1/promotions?extra=1"],
    ["list-limit", "/v1/promotions?limit=0"],
    ["empty-id", "/v1/promotions/%20"],
    ["detail-limit", page + "?limit=0"],
    ["empty-cover-id", "/v1/promotions/%20/cover"],
    ["cover-query", page + "/cover?q=1"],
    ["cover-locale", page + "/cover?locale=%3F%3F"],
  ])
    await record("promotion-invalid-" + name, path, 400);
  await record("promotion-cover-tagged-outage", page + "/cover", 500, {
    "offers.many": "FAIL",
  });
  await record("promotion-aggregate-outage", page + "?sortBy=price", 500, {
    tags: event,
    "offers.aggregate": "FAIL",
  });
  for (const [name, row] of [
    ["array-key", { ...game, id: ["game", null, 3] }],
    ["plain-string", { ...game, lastModifiedDate: "unknown" }],
    ["fractional", { ...game, lastModifiedDate: 1.25 }],
  ] as const) {
    const response = await record(
      "promotion-" + name + "-key",
      page + "?limit=1",
      200,
      { tags: event, offers: [row, game] },
    );
    await record(
      "promotion-" + name + "-after",
      page + "?limit=1&cursor=" + response.meta.pagination.nextCursor,
      200,
      { tags: event },
    );
  }
  await record("promotion-price-scalar-source", page + "?sortBy=price", 500, {
    tags: event,
    offers: [{ ...game, priceDoc: "old" }],
  });
  for (const [name, priceDoc] of [
    ["false", false],
    ["array", []],
    ["decimal", Decimal128.fromString("4")],
  ] as const) {
    await record(
      "promotion-price-source-" + name,
      page + "?sortBy=price",
      name === "false" ? 500 : 200,
      { tags: event, offers: [{ ...game, priceDoc }] },
    );
  }
  for (const [name, seed] of Object.entries({
    id: { tags: event, offers: [{ ...game, id: { toString: null } }] },
    priceId: {
      tags: event,
      offers: [game],
      pricev2: [{ offerId: { toString: "bad" } }],
    },
    eventTitle: { tags: { ...event, name: { toString: 4 } }, offers: [game] },
    sort: {
      tags: event,
      offers: [{ ...game, lastModifiedDate: { toString: null } }, game],
    },
    nestedMoney: {
      tags: event,
      offers: [game],
      pricev2: [
        { offerId: game.id, price: { currencyCode: 2, discountPrice: 100 } },
      ],
    },
  })) {
    await record(
      "promotion-storage-error-" + name,
      page + "?limit=1",
      500,
      seed,
    );
  }
  await record("promotion-price-integer-source", page + "?sortBy=price", 500, {
    tags: event,
    offers: [{ ...game, priceDoc: 7 }],
  });
  // Replay the native BSON document as input. The Node driver exposes its safe
  // Long and symbol fields to the handler as a number and a string.
  for (const [name, native] of [
    ["long-date", { ...game, lastModifiedDate: Long.fromNumber(42) }],
    ["symbol-date", { ...game, lastModifiedDate: new BSONSymbol("historic") }],
    ["long-price-primitive", { ...game, priceDoc: Long.fromNumber(42) }],
  ] as const) {
    const stored = [native, game];
    const rows = BSON.deserialize(BSON.serialize({ rows: stored })).rows;
    await record(
      "promotion-native-wire-" + name,
      page + (name === "long-price-primitive" ? "?sortBy=price" : "?limit=1"),
      name === "long-price-primitive" ? 500 : 200,
      { tags: event, offers: rows },
    );
    const trace = (
      cases.at(-1) as {
        trace: Array<{ call: { collection?: string }; result?: unknown }>;
      }
    ).trace;
    const source = trace.find((entry) => entry.call.collection === "offers")!;
    source.result = fixtureValue(stored, true);
  }
  const namespaces = [
    { namespace: new BSONSymbol("wire-ns") },
    { namespace: oid },
  ];
  await record("promotion-native-cover-symbol", page + "/cover", 200, {
    "offers.many": BSON.deserialize(BSON.serialize({ namespaces })).namespaces,
    "offers.one": game,
  });
  const coverTrace = (
    cases.at(-1) as {
      trace: Array<{
        call: { collection?: string; method: string };
        result?: unknown;
      }>;
    }
  ).trace;
  coverTrace.find(
    (entry) =>
      entry.call.collection === "offers" && entry.call.method === "many",
  )!.result = fixtureValue(namespaces, true);
  for (const [name, priceDoc] of [
    ["array-values", [1, "test"]],
    ["object-id", oid],
    ["date", new Date(0)],
  ] as const) {
    await record("promotion-own-price-" + name, page + "?sortBy=price", 200, {
      tags: event,
      offers: [{ ...game, priceDoc }],
    });
  }
  const decimalOffer = {
    ...game,
    _id: Long.fromString("9007199254740999"),
    id: Decimal128.fromString("24.00"),
  };
  await record("promotion-native-decimal-offer", page, 200, {
    tags: event,
    offers: [decimalOffer],
    pricev2: [{ offerId: "24.00", price: { discountPrice: 44 } }],
  });
  await record("promotion-native-decimal-cover", page + "/cover", 200, {
    "offers.one": decimalOffer,
  });
  await record("promotion-bad-mongo-id", page + "/cover", 500, {
    "offers.one": { ...game, _id: { toString: 2 } },
  });
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("V1_CURSOR_DEV_SECRET", "");
  vi.stubEnv("V1_CURSOR_SECRET", "");
  await record("promotion-needs-signature", page + "?limit=1", 503, {
    tags: event,
    offers: [game, game],
  });
  Object.assign(cases.at(-1) as object, { cursorSecret: false });
  assertOracle("collections-promotions-http-node", cases);
});
