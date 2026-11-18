import { BSON, BSONSymbol, Decimal128, ObjectId, Long } from "mongodb";
import { it } from "vitest";
import { recordMongoReads } from "../rust/oracles/read-models.js";
import { assertOracle, fixtureValue } from "../rust/oracles/record.js";
import offerDetails from "../src/v1/routes/offer-details.js";

it("records all offer relationship reads against the canonical handler", async () => {
  const { record, cases } = recordMongoReads(offerDetails);
  const offer = (
    id: string,
    namespace: string,
    extra: Record<string, unknown> = {},
  ) => ({
    _id: `doc-${id}`,
    id,
    namespace,
    title: `Title ${id}`,
    description: `Description ${id}`,
    offerType: "BASE_GAME",
    keyImages: [],
    tags: [],
    items: [],
    customAttributes: [],
    categories: [],
    ...extra,
  });
  const price = (offerId: string, region = "US", discountPrice = 500) => ({
    _id: `price-${offerId}`,
    offerId,
    region,
    namespace: `ns-${offerId}`,
    updatedAt: new Date("2026-11-10T00:00:00.000Z"),
    price: {
      currencyCode: "USD",
      originalPrice: 1000,
      discountPrice,
      discount: 50,
      basePayoutPrice: 1000,
      basePayoutCurrencyCode: "USD",
      payoutCurrencyExchangeRate: 1,
    },
  });

  const source = offer("relation-source", "ns-source", {
    categories: ["collections"],
    customAttributes: [
      {
        key: "com.epicgames.app.collectionOfferIds.slot1",
        value: "collection-member",
      },
    ],
    tags: [{ id: "genre-rpg" }],
  });
  const member = offer("collection-member", "ns-member", {
    title: "Collection Member",
  });
  const related = offer("related-offer", "ns-source");
  const relatedNoPrice = offer("related-no-price", "ns-source");
  const suggestion = offer("suggested-offer", "ns-suggested", {
    offerType: "BASE_GAME",
    tags: [{ id: "genre-rpg" }],
    lastModifiedDate: new Date("2026-11-12T00:00:00.000Z"),
  });

  await record(
    "offer-related",
    "/v1/offers/relation-source/related?country=US",
    200,
    {
      "offers.one": source,
      "offers.many": [related, relatedNoPrice],
      "pricev2.many": [price("related-offer")],
    },
  );
  await record(
    "offer-related-localized",
    "/v1/offers/relation-source/related?country=US&locale=fr-FR",
    200,
    {
      "offers.one": source,
      "offers.many": [related, relatedNoPrice],
      "pricev2.many": [price("related-offer")],
      "egs_localizations.many": [
        {
          _id: "localization-related",
          entityType: "offer",
          entityId: "ns-source:related-offer",
          locale: "fr-FR",
          source: "oracle-fixture",
          fetchedAt: new Date("2026-11-10T00:00:00.000Z"),
          data: { title: "Titre localisé" },
        },
      ],
    },
  );
  await record(
    "offer-suggestions",
    "/v1/offers/relation-source/suggestions?country=US",
    200,
    {
      "offers.one": source,
      "tags.many": [
        {
          _id: "tag-rpg",
          id: "genre-rpg",
          groupName: "genre",
          name: "Role Playing",
        },
      ],
      "offers.many": [suggestion],
      "pricev2.many": [price("suggested-offer")],
    },
  );
  await record(
    "offer-collection",
    "/v1/offers/relation-source/collection?country=US",
    200,
    {
      "offers.one": source,
      "offers.many": [member],
      "pricev2.many": [price("collection-member")],
    },
  );
  await record(
    "offer-collection-not-member",
    "/v1/offers/relation-source/collection?country=US",
    404,
    { "offers.one": offer("relation-source", "ns-source") },
  );
  await record(
    "offer-collection-entry",
    "/v1/offers/relation-source/collections/collection-1",
    200,
    {
      "offers.one": source,
      "game_positions.one": {
        _id: "position-1",
        collectionId: "collection-1",
        offerId: "relation-source",
        position: 2,
      },
      "collections_v2.one": {
        _id: "collection-1",
        name: "Featured Collection",
      },
    },
  );

  const bundleOffer = offer("bundle-source", "ns-bundle", {
    offerType: "BUNDLE",
  });
  const bundledA = offer("bundle-game-a", "ns-a");
  const bundledB = offer("bundle-game-b", "ns-b");
  await record(
    "offer-bundle",
    "/v1/offers/bundle-source/bundle?country=US",
    200,
    {
      "offers.one": bundleOffer,
      "bundles.one": {
        _id: "bundle-source",
        offers: ["bundle-game-a", "bundle-game-b"],
      },
      "pricev2.one": price("bundle-source", "US", 3000),
      "offers.many": [bundledA, bundledB],
      "pricev2.many": [
        price("bundle-game-a", "US", 400),
        price("bundle-game-b", "US", 600),
      ],
    },
  );
  await record(
    "offer-bundle-invalid-type",
    "/v1/offers/relation-source/bundle?country=US",
    404,
    { "offers.one": source },
  );
  await record(
    "offer-in-bundle",
    "/v1/offers/bundle-game-a/in-bundle?country=US",
    200,
    {
      "offers.one": bundledA,
      "bundles.many": [
        { _id: "bundle-source", offers: ["bundle-game-a", "bundle-game-b"] },
      ],
      "offers.many": [bundleOffer],
      "pricev2.many": [price("bundle-source", "US", 3000)],
    },
  );

  const prepurchase = offer("prepurchase-game", "ns-release", {
    prePurchase: true,
  });
  const regular = offer("regular-game", "ns-release", { prePurchase: false });
  await record(
    "offer-has-prepurchase",
    "/v1/offers/regular-game/has-prepurchase?country=US",
    200,
    {
      __sequence: { "offers.one": [regular, prepurchase] },
      "pricev2.one": price("prepurchase-game"),
    },
  );
  await record(
    "offer-has-regular",
    "/v1/offers/prepurchase-game/has-regular?country=US",
    200,
    {
      __sequence: { "offers.one": [prepurchase, regular] },
      "pricev2.one": price("regular-game"),
    },
  );

  const entry = "collections/collection-1";
  const listHit = {
    offers: [{ id: "warm" }],
    localization: { localeStatus: "fallback" },
  };
  for (const [relation, hit] of Object.entries({
    related: listHit,
    suggestions: listHit,
    collection: listHit,
    [entry]: { position: 0, name: null },
    bundle: {
      ...listHit,
      bundlePrice: null,
      totalPrice: { currencyCode: "EUR" },
    },
    "in-bundle": listHit,
    "has-prepurchase": { hasPrepurchase: false, offer: null },
    "has-regular": { isPrepurchase: true, offer: { id: "warm" } },
  })) {
    const path = `/v1/offers/relation-source/${relation}`;
    await record(`${relation}-missing-source`, path, 404);
    await record(`${relation}-source-read-error`, path, 500, {
      "offers.one": "FAIL",
    });
    await record(
      `${relation}-cached`,
      `${path}?country=es&locale=es-ES`,
      200,
      {},
      hit,
    );
    await record(
      `${relation}-invalid-offer`,
      `/v1/offers/%20/${relation}`,
      400,
    );
    if (relation !== entry) {
      await record(`${relation}-unknown-query`, `${path}?unexpected=1`, 400);
      await record(`${relation}-bad-region`, `${path}?country=abc`, 400);
      await record(
        `${relation}-unsupported-locale`,
        `${path}?locale=invalid-locale`,
        400,
      );
    }
  }

  const base = "/v1/offers/relation-source/";
  const seeds = {
    related: { "offers.one": source, "offers.many": [related] },
    suggestions: { "offers.one": source, "offers.many": [suggestion] },
    collection: { "offers.one": source, "offers.many": [member] },
    bundle: {
      "offers.one": bundleOffer,
      "bundles.one": { offers: ["a"] },
      "offers.many": [offer("a", "na")],
    },
    "in-bundle": {
      "offers.one": source,
      "bundles.many": [{ _id: "bundle-source" }],
      "offers.many": [bundleOffer],
    },
    "has-prepurchase": { __sequence: { "offers.one": [regular, prepurchase] } },
    "has-regular": { __sequence: { "offers.one": [prepurchase, regular] } },
  };
  for (const [relation, seed] of Object.entries(seeds)) {
    const path = `${base}${relation}?country=DE&locale=de-DE`;
    const single = relation.startsWith("has-");
    await record(`${relation}-translation-failure`, path, 500, {
      ...structuredClone(seed),
      "egs_localizations.many": "FAIL",
    });
    await record(`${relation}-price-failure`, path, 500, {
      ...structuredClone(seed),
      [single ? "pricev2.one" : "pricev2.many"]: "FAIL",
    });
    await record(`${relation}-cache-offline`, path, 200, seed, undefined, true);
    if (!single) {
      await record(`${relation}-member-read-failure`, path, 500, {
        ...seed,
        "offers.many": "FAIL",
      });
      await record(
        `${relation}-missing-cached-list`,
        path,
        500,
        {},
        { localization: {} },
      );
    }
  }
  for (const relation of [
    "related",
    "suggestions",
    "collection",
    "in-bundle",
  ]) {
    await record(
      `${relation}-no-members`,
      `${base}${relation}?locale=de-DE`,
      200,
      { "offers.one": source },
    );
  }
  await record("suggestions-null-tag-ids", `${base}suggestions`, 200, {
    "offers.one": {
      ...source,
      tags: [{ id: null }, {}, { id: 17 }, { id: "rpg" }],
    },
    "tags.many": [
      { groupName: "feature", id: 17 },
      { groupName: "genre", id: 23 },
      { groupName: "genre", id: "rpg" },
      { groupName: "genre" },
    ],
  });
  await record("suggestions-invalid-tag", `${base}suggestions`, 500, {
    "offers.one": { ...source, tags: [null] },
  });
  await record("suggestions-tags-unavailable", `${base}suggestions`, 500, {
    "offers.one": source,
    "tags.many": "FAIL",
  });
  await record(
    "collection-attributes-no-member-keys",
    `${base}collection`,
    404,
    {
      "offers.one": {
        ...source,
        customAttributes: [null, { key: "other", value: "not-a-member" }],
      },
    },
  );
  await record("collection-string-coercion", `${base}collection`, 200, {
    "offers.one": {
      ...source,
      customAttributes: [
        null,
        37,
        false,
        undefined,
        [1, "x"],
        {},
        "member",
      ].map((value, i) => ({
        key: `com.epicgames.app.collectionOfferIds.${i}`,
        value,
      })),
    },
  });
  await record("collection-entry-invalid-id", `${base}collections/%20`, 400);
  for (const [name, position, collection, status] of [
    ["missing-position", null, { name: "c" }, 404],
    ["missing-collection", {}, null, 404],
    ["unnamed", { position: 1 }, {}, 200],
    ["position-failure", "FAIL", {}, 500],
    ["collection-failure", {}, "FAIL", 500],
  ] as const) {
    await record(
      `collection-entry-${name}`,
      `${base}${entry}?ignored=yes`,
      status,
      {
        "offers.one": source,
        "game_positions.one": position,
        "collections_v2.one": collection,
      },
    );
  }
  await record("bundle-missing", `${base}bundle`, 404, {
    "offers.one": bundleOffer,
  });
  await record("bundle-read-failure", `${base}bundle`, 500, {
    "offers.one": bundleOffer,
    "bundles.one": "FAIL",
  });
  await record("bundle-empty-legacy-shape", `${base}bundle`, 200, {
    "offers.one": { ...bundleOffer, offerType: "Bundle" },
    "bundles.one": { offers: null },
  });
  await record("bundle-price-unavailable", `${base}bundle`, 500, {
    ...seeds.bundle,
    "pricev2.one": "FAIL",
  });
  await record("bundle-partially-priced", `${base}bundle?country=JP`, 200, {
    "offers.one": bundleOffer,
    "bundles.one": { offers: [301, "b", "c", "d"] },
    "offers.many": [
      offer("301", "na"),
      offer("b", "nb"),
      offer("c", "nc"),
      offer("d", "nd"),
    ],
    "pricev2.many": [
      {
        offerId: "301",
        price: {
          discount: "12",
          originalPrice: "42",
          discountPrice: 1,
          currencyCode: "JPY",
        },
      },
      {
        offerId: "b",
        price: {
          discount: 3,
          originalPrice: true,
          discountPrice: null,
          currencyCode: null,
        },
      },
      { offerId: "c", price: null },
    ],
  });
  await record("in-bundle-index-failure", `${base}in-bundle`, 500, {
    "offers.one": source,
    "bundles.many": "FAIL",
  });
  await record(
    "in-bundle-index-order-and-stale-members",
    `${base}in-bundle`,
    200,
    {
      "offers.one": source,
      "bundles.many": [
        { _id: "b" },
        { _id: 22 },
        { _id: "gone" },
        { _id: "b" },
      ],
      "offers.many": [offer("22", "a"), offer("b", "b")],
    },
  );
  for (const [relation, origin] of [
    ["has-prepurchase", regular],
    ["has-regular", prepurchase],
  ] as const) {
    await record(`${relation}-absent-counterpart`, `${base}${relation}`, 200, {
      __sequence: { "offers.one": [origin, null] },
    });
    await record(`${relation}-counterpart-failure`, `${base}${relation}`, 500, {
      __sequence: { "offers.one": [origin, "FAIL"] },
    });
    await record(`${relation}-numeric-counterpart`, `${base}${relation}`, 200, {
      __sequence: { "offers.one": [origin, { ...regular, id: 99 }] },
    });
  }
  await record("has-regular-non-prepurchase", `${base}has-regular`, 200, {
    "offers.one": regular,
  });
  await record("has-regular-non-base-offer", `${base}has-regular`, 200, {
    "offers.one": { ...prepurchase, offerType: "DLC" },
  });
  await record(
    "bundle-cache-missing-prices",
    `${base}bundle`,
    200,
    {},
    { offers: [] },
  );
  await record(
    "related-null-cached-list",
    `${base}related`,
    500,
    {},
    { offers: null },
  );
  await record(
    "suggestions-scalar-cache",
    `${base}suggestions`,
    500,
    {},
    "legacy",
  );
  for (const relation of ["has-regular", "has-prepurchase"]) {
    await record(
      `${relation}-sparse-cache`,
      `${base}${relation}`,
      200,
      {},
      { offer: false },
    );
  }
  for (const [relation, origin, counterpart] of [
    ["has-regular", prepurchase, regular],
    ["has-prepurchase", regular, prepurchase],
  ] as const) {
    await record(
      `${relation}-translated-edition`,
      `${base}${relation}?country=ES&locale=es-ES`,
      200,
      {
        __sequence: { "offers.one": [origin, counterpart] },
        "egs_localizations.many": [
          {
            entityType: "offer",
            entityId: `${counterpart.namespace}:${counterpart.id}`,
            locale: "es-ES",
            source: "catalog",
            fetchedAt: new Date("2026-10-01T00:00:00Z"),
            data: { title: "Edición localizada" },
          },
        ],
        "pricev2.one": price(counterpart.id, "EURO"),
      },
    );
  }

  const typedId = Decimal128.fromString("24.00");
  const objectKey = new ObjectId("507f1f77bcf86cd799439011");
  const typedRow = {
    ...bundledA,
    id: typedId,
    _id: Long.fromString("9007199254740999"),
    namespace: objectKey,
    title: "Historical member",
  };
  const typedPrice = {
    ...price("24.00", "EURO"),
    offerId: typedId,
    price: {
      currencyCode: "EUR",
      originalPrice: Decimal128.fromString("410.5"),
      discountPrice: Decimal128.fromString("349.8"),
      discount: false,
      basePayoutPrice: Long.fromString("9007199254740999"),
      payoutCurrencyExchangeRate: 1,
    },
  };
  const translated = {
    entityType: "offer",
    entityId: `${member.namespace}:${member.id}`,
    locale: "fr-FR",
    source: "fixture",
    data: { title: "Membre traduit" },
  };
  const regional = "?country=FR&locale=fr-FR";
  const sourceByRelation = {
    related: { "offers.one": { ...source, namespace: objectKey } },
    suggestions: { "offers.one": source, "tags.many": [] },
    collection: {
      "offers.one": {
        ...source,
        customAttributes: [
          { key: "com.epicgames.app.collectionOfferIds.slot1", value: typedId },
        ],
      },
    },
    "in-bundle": {
      "offers.one": source,
      "bundles.many": [{ _id: member.id }, { _id: typedId }, { _id: typedId }],
    },
    bundle: {
      "offers.one": bundleOffer,
      "bundles.one": { offers: [typedId, member.id] },
      "pricev2.one": { ...typedPrice, offerId: "bundle-source" },
    },
  };
  for (const [relation, seed] of Object.entries(sourceByRelation)) {
    const list = {
      ...seed,
      "offers.many": [typedRow, member],
      "pricev2.many": [typedPrice, price(member.id, "EURO")],
      "egs_localizations.many": [translated],
    };
    await record(
      `${relation}-stored-identifiers-prices-and-localization`,
      `${base}${relation}${regional}`,
      200,
      list,
    );
    await record(
      `${relation}-malformed-stored-attributes`,
      `${base}${relation}${regional}`,
      500,
      { ...list, "offers.many": [{ ...typedRow, customAttributes: [null] }] },
    );
    await record(
      `${relation}-noncoercible-price-key`,
      `${base}${relation}${regional}`,
      500,
      { ...list, "pricev2.many": [{ offerId: { toString: "owned" } }] },
    );
    for (const [name, offers] of [
      ["string", "A🎮"],
      ["object", { length: "cached" }],
      ["missing-length", false],
    ] as const) {
      await record(
        `${relation}-cache-${name}-length`,
        `${base}${relation}`,
        200,
        {},
        { offers, localization: { localeStatus: "cached" } },
      );
    }
  }
  for (const [relation, origin] of [
    ["has-prepurchase", regular],
    ["has-regular", prepurchase],
  ] as const) {
    const seed = {
      __sequence: {
        "offers.one": [{ ...origin, namespace: objectKey }, typedRow],
      },
      "pricev2.one": typedPrice,
    };
    await record(
      `${relation}-historical-bson-edition`,
      `${base}${relation}${regional}`,
      200,
      seed,
    );
    await record(
      `${relation}-historical-malformed-edition`,
      `${base}${relation}${regional}`,
      500,
      {
        ...seed,
        __sequence: {
          "offers.one": [origin, { ...typedRow, customAttributes: [null] }],
        },
      },
    );
  }

  await record("in-bundle-noncoercible-bundle-id", `${base}in-bundle`, 500, {
    "offers.one": source,
    "bundles.many": [{ _id: { toString: 1 } }],
  });
  await record("bundle-noncoercible-member-id", `${base}bundle`, 500, {
    "offers.one": bundleOffer,
    "bundles.one": { offers: [{ toString: 1 }] },
  });
  await record("collection-noncoercible-member-id", `${base}collection`, 500, {
    "offers.one": {
      ...source,
      customAttributes: [
        {
          key: "com.epicgames.app.collectionOfferIds.foo",
          value: { toString: 1 },
        },
      ],
    },
  });
  await record(
    "related-noncoercible-id-before-pricing",
    `${base}related`,
    500,
    { "offers.one": source, "offers.many": [{ id: { toString: 1 } }] },
  );
  await record(
    "related-noncoercible-document-id-after-localization",
    `${base}related${regional}`,
    500,
    {
      "offers.one": source,
      "offers.many": [{ ...member, _id: { toString: 1 } }],
      "egs_localizations.many": [translated],
    },
  );
  await record("bundle-noncoercible-stored-amount", `${base}bundle`, 500, {
    "offers.one": bundleOffer,
    "bundles.one": { offers: [member.id] },
    "offers.many": [member],
    "pricev2.many": [
      { offerId: member.id, price: { originalPrice: { toString: 1 } } },
    ],
  });

  for (const relation of [
    "related",
    "suggestions",
    "collection",
    "bundle",
    "in-bundle",
    "has-prepurchase",
    "has-regular",
  ]) {
    await record(
      `${relation}-cache-indexed-localization`,
      `${base}${relation}`,
      200,
      {},
      { offers: [], localization: ["previous"] },
    );
  }

  for (const [relation, origin] of [
    ["has-prepurchase", regular],
    ["has-regular", prepurchase],
  ] as const) {
    await record(
      `${relation}-uncastable-edition-id`,
      `${base}${relation}`,
      500,
      { __sequence: { "offers.one": [origin, { id: { toString: 1 } }] } },
    );
    await record(
      `${relation}-invalid-price-currency`,
      `${base}${relation}`,
      500,
      {
        __sequence: { "offers.one": [origin, member] },
        "pricev2.one": { offerId: member.id, price: { currencyCode: 7 } },
      },
    );
  }
  await record("bundle-invalid-main-currency", `${base}bundle`, 500, {
    "offers.one": bundleOffer,
    "bundles.one": { offers: [] },
    "pricev2.one": { price: { currencyCode: 3 } },
  });
  await record(
    "bundle-uncastable-stored-offer-id",
    `${base}bundle${regional}`,
    500,
    {
      "offers.one": bundleOffer,
      "bundles.one": { offers: [member.id] },
      "offers.many": [member, { id: { toString: 1 } }],
    },
  );
  await record(
    "in-bundle-uncastable-stored-offer-id",
    `${base}in-bundle`,
    500,
    {
      "offers.one": source,
      "bundles.many": [{ _id: member.id }],
      "offers.many": [{ id: { toString: 1 } }],
    },
  );
  // Give the Node handler the driver's decoded values, preserving the stored
  // wire types in Rust's replay of the same Mongo result.
  const storedPrices = [
    {
      offerId: member.id,
      price: {
        discountPrice: Long.fromNumber(125),
        basePayoutPrice: Long.fromNumber(100),
      },
    },
  ];
  const decoded = BSON.deserialize(BSON.serialize({ rows: storedPrices })).rows;
  await record(
    "bundle-promoted-native-int64-minor-units",
    `${base}bundle`,
    200,
    {
      "offers.one": bundleOffer,
      "bundles.one": { offers: [member.id] },
      "offers.many": [member, member],
      "pricev2.many": decoded,
    },
  );
  type Trace = {
    trace: Array<{
      call: { collection?: string; method: string };
      result?: unknown;
    }>;
  };
  const replaceRead = (collection: string, result: unknown) => {
    const { trace } = cases.at(-1) as Trace;
    trace.find(
      ({ call }) => call.collection === collection && call.method === "many",
    )!.result = fixtureValue(result, true);
  };
  replaceRead("pricev2", storedPrices);
  const symbolMembers = [
    {
      ...member,
      id: new BSONSymbol(member.id),
      namespace: new BSONSymbol(member.namespace),
    },
  ];
  const decodedMembers = BSON.deserialize(
    BSON.serialize({ rows: symbolMembers }),
  ).rows;
  await record(
    "related-native-symbol-localization",
    `${base}related${regional}`,
    200,
    {
      "offers.one": source,
      "offers.many": decodedMembers,
      "egs_localizations.many": [translated],
    },
  );
  replaceRead("offers", symbolMembers);
  for (const [relation, rawSource, extra] of [
    [
      "collection",
      {
        ...source,
        categories: [new BSONSymbol("collections")],
        customAttributes: [
          {
            key: new BSONSymbol("com.epicgames.app.collectionOfferIds.member"),
            value: member.id,
          },
        ],
      },
      { "offers.many": [member] },
    ],
    [
      "bundle",
      { ...bundleOffer, offerType: new BSONSymbol("BUNDLE") },
      { "bundles.one": { offers: [member.id] }, "offers.many": [member] },
    ],
    [
      "has-regular",
      { ...prepurchase, offerType: new BSONSymbol("BASE_GAME") },
      {},
    ],
  ] as const) {
    const decodedSource = BSON.deserialize(BSON.serialize(rawSource));
    await record(
      `${relation}-native-wire-source-symbols`,
      `${base}${relation}`,
      200,
      { ...extra, __sequence: { "offers.one": [decodedSource, regular] } },
    );
    const { trace } = cases.at(-1) as Trace;
    trace.find(
      ({ call }) => call.collection === "offers" && call.method === "one",
    )!.result = fixtureValue(rawSource, true);
  }
  assertOracle("offer-relations-http-node", cases);
});
