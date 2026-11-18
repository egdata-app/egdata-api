import { Binary, Decimal128, Long, ObjectId, UUID } from "mongodb";
import { expect, it, vi } from "vitest";
import { recordMongoReads } from "../rust/oracles/read-models.js";
import { assertOracle } from "../rust/oracles/record.js";
import routes from "../src/v1/routes/free-games.js";
import { loadSeaQaOffers } from "./fixtures/seaqa.js";

vi.mock("../src/models/index.js", async () => {
  const { db } = await import("../src/db/index.js");
  const model = (name: string) => ({
    countDocuments: (filter: Record<string, unknown>) => db.db.collection(name).countDocuments(filter),
    find: (filter: Record<string, unknown>, _: unknown, opts = {}) => ({
      lean: () => db.db.collection(name).find(filter, opts).toArray(),
    }),
    findOne: (filter: Record<string, unknown>, _: unknown, opts = {}) => ({
      lean: () => db.db.collection(name).findOne(filter, opts),
    }),
  });
  return {
    FreeGames: model("freegames"),
    Offer: model("offers"),
    Item: model("items"),
    PriceEngine: model("pricev2"),
  };
});

it("records promotion boundaries, data failures, regional prices, and cache behavior", async () => {
  const { record, cases } = recordMongoReads(routes);
  const path = "/v1/free-games";
  const at = new Date("2026-11-17T00:00:00.000Z");
  const offer = {
    id: "demo",
    namespace: "ns",
    title: "Demo",
    items: [{ id: "direct" }, null, { id: 2 }],
    countriesBlacklist: ["XX", 12],
  };
  const mobile = { offerId: "demo", startDate: at, endDate: at };
  const game = {
    id: "demo",
    endDate: at,
    startDate: new Date(at.valueOf() + 1),
  };
  for (const route of [
    "",
    "/mobile",
    "/history",
    "/stats",
    "/sellers",
    "/search",
  ]) {
    await record(
      "v1 free games unknown " + route,
      path + route + "?unknown=1",
      route === "/sellers" ? 200 : 400,
    );
    if (route !== "/sellers")
      await record(
        "v1 free games country " + route,
        path + route + "?country=ZZ",
        400,
      );
  }
  for (const route of ["", "/mobile", "/history", "/stats", "/sellers"]) {
    await record("v1 free games empty " + route, path + route, 200);
    await record(
      "v1 free games redis unavailable " + route,
      path + route,
      200,
      {},
      undefined,
      true,
    );
  }
  for (const [name, route, seed] of [
    ["current-desktop", "", { "freegames.many": "FAIL" }],
    ["current-mobile", "", { "mobile-freebies.many": "FAIL" }],
    ["mobile-source", "/mobile", { "mobile-freebies.many": "FAIL" }],
    ["history-games", "/history", { "freegames.many": "FAIL" }],
    ["history-count", "/history", { "freegames.count": "FAIL" }],
    [
      "history-offers",
      "/history",
      { freegames: [game], "offers.many": "FAIL" },
    ],
    [
      "history-prices",
      "/history",
      { freegames: [game], "pricev2.many": "FAIL" },
    ],
    ["stats-games", "/stats", { "freegames.many": "FAIL" }],
    ["stats-offers", "/stats", { freegames: [game], "offers.many": "FAIL" }],
    ["stats-prices", "/stats", { freegames: [game], "pricev2.many": "FAIL" }],
    ["sellers", "/sellers", { "freegames.aggregate": "FAIL" }],
  ] as const)
    await record("v1 free games outage " + name, path + route, 500, seed);
  const mobileSeed = {
    "mobile-freebies.many": [mobile],
    "offers.one": offer,
    "pricev2.one": {
      offerId: "demo",
      region: "US",
      price: { originalPrice: 0 },
    },
    offersubitems: [{ subItems: [{ id: "nested" }, { id: 8 }] }, {}],
    items: [{ id: "nested", __v: 2 }],
  };
  const archivedId = Decimal128.fromString("24.00");
  const oid = new ObjectId("507f1f77bcf86cd799439011");
  for (const [kind, id] of [
    ["decimal", archivedId],
    ["object-id", oid],
  ] as const) {
    const result = await record(
      "free game with native " + kind + " keys",
      path + "/mobile?locale=fr",
      200,
      {
        ...mobileSeed,
        "offers.one": { ...offer, id, items: [{ id: oid }, { id: "direct" }] },
        "pricev2.one": {
          offerId: id,
          price: {
            currencyCode: "USD",
            discountPrice: Decimal128.fromString("349.8"),
          },
        },
        offersubitems: [{ subItems: [{ id: oid }, { id: "nested" }] }],
        items: [{ id: archivedId, lastModifiedDate: "2026-01-02", __v: 2 }],
      },
    );
    expect(result.data[0].id).toBe(String(id));
    expect(result.data[0].price.price.discountPrice).toBe(350);
    expect(result.data[0].items[0].id).toBe("24.00");
  }
  await record(
    "free game with malformed stored currency",
    path + "/mobile",
    500,
    {
      ...mobileSeed,
      "pricev2.one": { offerId: "demo", currencyCode: 17 },
    },
  );
  await record(
    "v1 free games mobile boundary",
    path + "/mobile",
    200,
    mobileSeed,
  );
  await record("v1 free games mobile no offer", path + "/mobile", 200, {
    "mobile-freebies.many": [mobile],
  });
  await record(
    "v1 free games mobile missing identifiers",
    path + "/mobile",
    200,
    { "mobile-freebies.many": [{}, { offerId: "" }, { offerId: 123 }] },
  );
  for (const field of [
    "offers.one",
    "pricev2.one",
    "offersubitems.many",
    "items.many",
    "egs_localizations.many",
  ]) {
    await record(
      "v1 free games mobile failure " + field,
      path + "/mobile?locale=fr",
      500,
      { ...mobileSeed, [field]: "FAIL" },
    );
  }
  await record("v1 free games current boundary", path, 200, {
    __sequence: { "freegames.many": [[game], [game]] },
  });
  await record("v1 free games current mobile no history", path, 200, {
    "mobile-freebies.many": [mobile],
  });
  await record("v1 free games current missing identifiers", path, 200, {
    __sequence: { "freegames.many": [[{}, { id: 123, platform: 123 }], []] },
  });
  await record("v1 free games history sparse ids", path + "/history", 200, {
    freegames: [{ id: 14 }, {}],
  });
  const h = await record(
    "v1 free games null history cursor",
    path + "/history?limit=1",
    200,
    { freegames: [{}, game] },
  );
  await record(
    "v1 free games null history continuation",
    path +
      "/history?limit=1&cursor=" +
      encodeURIComponent(h.meta.pagination.nextCursor),
    200,
  );
  for (const v of ["?limit=99", "?cursor=broken"])
    await record("v1 free games paging " + v, path + "/history" + v, 400);
  await record("v1 free games numeric stats", path + "/stats", 200, {
    freegames: [game, game, { id: 2 }, {}],
    offers: [
      { seller: {} },
      { seller: { id: null } },
      { seller: { id: 2 } },
      { seller: { id: "2" } },
    ],
    pricev2: [
      {
        price: {
          currencyCode: 18,
          originalPrice: [3],
          discountPrice: true,
          discount: "0x10",
          basePayoutPrice: "no",
          payoutCurrencyExchangeRate: null,
        },
      },
      {
        price: {
          originalPrice: " 2 ",
          discountPrice: [],
          discount: { x: 2 },
          basePayoutPrice: "Infinity",
        },
      },
      { price: null },
      {},
    ],
  });
  await record(
    "v1 free games batch localization",
    path + "/history?locale=de",
    200,
    {
      freegames: [{ id: "a" }, { id: "b" }, { id: "a" }],
      offers: [
        { id: "a", namespace: "ns", title: "A" },
        { id: "b", namespace: "ns", title: "B" },
      ],
      egs_localizations: [{ entityId: "ns:a", data: { title: "Deutsch" } }],
    },
  );
  for (const [label, endDate, status] of [
    ["date-only", "2026-10-02", 200],
    ["epoch-ms", 1700000000000, 200],
    ["boolean", true, 200],
    ["invalid", "unavailable", 500],
  ] as const) {
    await record(
      "v1 free games " + label + " date cursor",
      path + "/history?limit=1",
      status,
      { freegames: [{ id: 41, endDate }, game] },
    );
  }
  const [catalogOffer] = await loadSeaQaOffers();
  const pastGame = { id: catalogOffer.id, endDate: new Date("2023-08-03") };
  await record(
    "v1 archived repeat giveaway chooses last offer and price",
    path + "/history",
    200,
    {
      freegames: [pastGame, { ...pastGame, endDate: new Date("2022-05-26") }],
      offers: [{ ...catalogOffer, title: "earlier duplicate" }, catalogOffer],
      pricev2: [
        { offerId: catalogOffer.id, price: { originalPrice: 500 } },
        { offerId: catalogOffer.id, price: { originalPrice: 600 } },
      ],
    },
  );
  await record(
    "v1 history distinguishes absent null and empty enrichment ids",
    path + "/history",
    200,
    {
      freegames: [{ id: null }, {}, { id: "undefined" }, { id: "null" }],
      offers: [
        { id: "", title: "empty" },
        { title: "missing" },
        { id: null, title: "null" },
      ],
      pricev2: [
        { offerId: "", price: { originalPrice: 20 } },
        { price: { originalPrice: 30 } },
        { offerId: null, price: { originalPrice: 40 } },
      ],
    },
  );
  for (const subItems of ["unmigrated", [null], { id: "nested" }]) {
    await record(
      "v1 mobile invalid subitem record " + JSON.stringify(subItems),
      path + "/mobile",
      500,
      {
        ...mobileSeed,
        offersubitems: [{ subItems }],
      },
    );
  }
  await record("v1 mobile numeric offer item lookup", path + "/mobile", 200, {
    ...mobileSeed,
    "offers.one": { ...offer, id: 15 },
  });
  for (const countriesBlacklist of ["DE", "", null]) {
    await record(
      "v1 mobile stored country blacklist " +
        JSON.stringify(countriesBlacklist),
      path + "/mobile",
      200,
      { ...mobileSeed, "offers.one": { ...offer, countriesBlacklist } },
    );
  }
  await record("v1 current invalid stored offer attributes", path, 500, {
    __sequence: { "freegames.many": [[game], [game]] },
    "offers.one": { ...offer, customAttributes: [null] },
  });
  await record(
    "v1 mobile invalid stored offer attributes",
    path + "/mobile",
    500,
    {
      ...mobileSeed,
      "offers.one": { ...offer, customAttributes: [null] },
    },
  );
  await record(
    "v1 history invalid stored offer attributes",
    path + "/history",
    500,
    {
      freegames: [game],
      offers: [{ ...offer, customAttributes: [null] }],
    },
  );
  for (const [name, fail] of [
    ["desktop", "freegames.many"],
    ["mobile", "mobile-freebies.one"],
  ]) {
    await record("v1 current historical read outage " + name, path, 500, {
      ...(name === "desktop"
        ? { __sequence: { "freegames.many": [[game], "FAIL"] } }
        : { "mobile-freebies.many": [mobile], [fail]: "FAIL" }),
      "offers.one": offer,
    });
  }
  const cachedOffer = { id: "cached", title: "Cached offer" };
  for (const [name, route, hit] of [
    ["current", "", [cachedOffer]],
    ["mobile", "/mobile", [cachedOffer]],
    ["stats", "/stats", { totalGiveaways: 42 }],
    [
      "history",
      "/history",
      {
        data: [cachedOffer],
        pagination: { limit: 20, hasMore: false, nextCursor: null },
      },
    ],
    [
      "search",
      "/search",
      {
        data: [cachedOffer],
        pagination: { limit: 20, hasMore: false, nextCursor: null },
        result: { total: 1 },
      },
    ],
  ] as const) {
    await record("v1 free games cache hit " + name, path + route, 200, {}, hit);
  }
  for (const [name, route, hit] of [
    ["current cached object without length", "", { games: [cachedOffer] }],
    ["mobile cached scalar", "/mobile", "🎮"],
    ["sellers cached explicit count", "/sellers", { length: null }],
    ["history page before pagination", "/history", { data: [cachedOffer] }],
    ["history cached list", "/history", [cachedOffer]],
    ["search page with explicit null", "/search", { data: null, result: null }],
  ] as const) {
    await record("v1 free games " + name, path + route, 200, {}, hit);
  }
  await record(
    "v1 history localization outage",
    path + "/history?locale=fr",
    500,
    {
      freegames: [game],
      offers: [offer],
      "egs_localizations.many": "FAIL",
    },
  );
  await record(
    "v1 search rejects unreadable cursor",
    path + "/search?cursor=invalid",
    400,
  );
  await record(
    "v1 search rejects invalid page size",
    path + "/search?limit=900",
    400,
  );
  const storedId = Decimal128.fromString("728.50");
  const largeId = Long.fromString("9007199254741153");
  const uuid = new UUID("de305d54-75b4-431b-adb2-eb6b9e546014");
  const typedMetadata = {
    id: storedId,
    _id: largeId,
    amount: Decimal128.fromString("4.2"),
    bytes: new Binary(Buffer.from("wire")),
    uuid,
  };
  const desktopStored = {
    id: storedId,
    endDate: at,
    platform: 19,
    source: typedMetadata,
  };
  const mobileStored = {
    offerId: uuid,
    startDate: at,
    endDate: at,
    source: typedMetadata,
  };
  await record("v1 current native desktop giveaway and history", path, 200, {
    __sequence: {
      "freegames.many": [
        [desktopStored],
        [{ id: largeId, source: typedMetadata }],
      ],
    },
    "offers.one": null,
    "pricev2.one": null,
  });
  await record("v1 current native mobile giveaway and history", path, 200, {
    "mobile-freebies.many": [mobileStored],
    "mobile-freebies.one": { offerId: storedId, source: typedMetadata },
  });
  await record("v1 mobile native source", path + "/mobile", 200, {
    "mobile-freebies.many": [mobileStored],
    "offers.one": { id: uuid.toString(), namespace: "ns" },
  });
  await record(
    "v1 history native joins and duplicate keys",
    path + "/history?locale=fr",
    200,
    {
      freegames: [
        desktopStored,
        { id: largeId, data: typedMetadata },
        { id: new Binary(Buffer.from("binary-id")) },
        { id: uuid },
      ],
      offers: [
        { id: "728.50", title: "shadowed" },
        {
          id: storedId,
          namespace: "ns",
          _id: largeId,
          title: "decimal winner",
        },
        { id: largeId, namespace: "ns", title: "large number" },
        { id: uuid, namespace: "ns", title: "uuid" },
      ],
      pricev2: [
        { offerId: "728.50", price: { originalPrice: 1 } },
        {
          offerId: storedId,
          price: { originalPrice: Decimal128.fromString("47.50") },
        },
        { offerId: largeId, price: { discountPrice: largeId } },
      ],
    },
  );
  await record("v1 history native cursor", path + "/history?limit=1", 200, {
    freegames: [desktopStored, game],
  });
  for (const [suffix, coll, field] of [
    ["", "freegames.many", "id"],
    ["/mobile", "mobile-freebies.many", "offerId"],
    ["/history", "freegames.many", "id"],
  ]) {
    await record(
      "v1 giveaway invalid id coercion " + coll + suffix,
      path + suffix,
      500,
      {
        [coll]: [
          { [field]: "starts-first" },
          { [field]: { toString: "saved string" } },
        ],
      },
    );
  }
  for (const [label, rows] of [
    ["offer", { offers: [{ id: { toString: false } }] }],
    ["price", { pricev2: [{ offerId: { toString: false } }] }],
  ] as const) {
    await record(
      "v1 history invalid mapped key " + label,
      path + "/history",
      500,
      { freegames: [game], ...rows },
    );
  }
  for (const [label, failing] of [
    ["offer", "offers.one"],
    ["price", "pricev2.one"],
  ]) {
    await record("v1 giveaway concurrent " + label, path, 500, {
      "freegames.many": [{ id: "first" }],
      "mobile-freebies.many": [{ offerId: "second" }],
      __sequence: { [failing]: ["FAIL", null] },
      "mobile-freebies.one": { offerId: "second" },
    });
  }
  await record("v1 giveaway concurrent mobile ordered", path + "/mobile", 200, {
    "mobile-freebies.many": [{ offerId: "a" }, { offerId: "b" }],
    __sequence: {
      "offers.one": [
        { id: "a", title: "A" },
        { id: "b", title: "B" },
      ],
    },
  });
  await record("v1 giveaway concurrent stalled mobile offer", path, 500, {
    "freegames.many": [{ id: "first" }],
    "mobile-freebies.many": [{ offerId: "second" }],
    __sequence: { "offers.one": ["FAIL", null] },
    __holdUntilResponse: {
      collection: "offers",
      method: "one",
      query: { id: "second" },
      remaining: 1,
    },
  });
  await record("v1 giveaway concurrent stalled price", path + "/mobile", 500, {
    "mobile-freebies.many": [{ offerId: "first" }],
    "offers.one": "FAIL",
    __holdUntilResponse: { collection: "pricev2", method: "one", remaining: 0 },
  });
  await record("v1 giveaway concurrent stalled desktop source", path, 500, {
    "mobile-freebies.many": "FAIL",
    __holdUntilResponse: {
      collection: "freegames",
      method: "many",
      remaining: 0,
    },
  });
  await record(
    "v1 giveaway concurrent stalled history offers",
    path + "/history",
    500,
    {
      freegames: [game],
      "pricev2.many": "FAIL",
      __holdUntilResponse: {
        collection: "offers",
        method: "many",
        remaining: 0,
      },
    },
  );
  assertOracle("free-games-edges-http-node", cases);
});
