import { Binary, BSON, Decimal128, Long, ObjectId, UUID } from "mongodb";
import { it } from "vitest";
import { recordMongoReads } from "../rust/oracles/read-models.js";
import { assertOracle } from "../rust/oracles/record.js";
import offerDetails from "../src/v1/routes/offer-details.js";

it("records offer insight Mongo reads and responses from the Node handlers", async () => {
  const { record, cases } = recordMongoReads(offerDetails);
  const offer = {
    _id: "offer-doc",
    id: "insight-game",
    title: "Insight Game",
    namespace: "sandbox-insight",
    offerType: "BASE_GAME",
    items: [{ id: "item-1" }, { id: "item-2" }],
    tags: [
      { id: 1203, name: "Multiplayer" },
      { id: 1264, name: "Co-op" },
      { id: "19847", name: "Achievements" },
      { id: 777, name: "Numeric RPG" },
    ],
    countriesWhitelist: [],
    countriesBlacklist: [],
    customAttributes: [],
  };
  const requirement = {
    namespace: "sandbox-insight",
    offerId: "insight-game",
    platform: "windows",
    offerType: "BASE_GAME",
    source: {
      sourceType: "product_page",
      observedAt: new Date("2026-11-01T00:00:00.000Z"),
      rawRows: [{ key: "OS" }],
    },
    processing: { sourceGeneration: 3, state: "normalized" },
    requirements: { minimum: { os: "Windows 10" }, recommended: null },
  };
  const insightPrice = {
    _id: "price-1",
    offerId: "insight-game",
    region: "US",
    updatedAt: new Date("2026-11-16T00:00:00.000Z"),
    price: {
      currencyCode: "USD",
      originalPrice: 1999,
      discountPrice: 999,
      discount: 50,
      basePayoutPrice: 0,
      payoutCurrencyExchangeRate: 1,
    },
  };

  await record(
    "offer-insights-achievements-populated",
    "/v1/offers/insight-game/achievements",
    200,
    {
      "offers.one": {
        _id: "offer-doc",
        namespace: "sandbox-insight",
        offerType: "BASE_GAME",
      },
      "achievementsets.many": [
        {
          _id: "set-1",
          sandboxId: "sandbox-insight",
          isBase: true,
          achievements: [{ name: "A1", xp: 10 }],
        },
      ],
    },
  );
  await record(
    "offer-insights-achievements-missing",
    "/v1/offers/missing/achievements",
    404,
  );
  await record(
    "offer-insights-giveaways-populated",
    "/v1/offers/insight-game/giveaways",
    200,
    {
      "offers.one": { _id: "offer-doc", id: "insight-game" },
      "freegames.many": [
        {
          _id: "giveaway-1",
          id: "insight-game",
          startDate: new Date("2026-11-16T00:00:00.000Z"),
          endDate: new Date("2026-11-20T00:00:00.000Z"),
        },
      ],
    },
  );
  await record(
    "offer-insights-ratings-populated",
    "/v1/offers/insight-game/ratings",
    200,
    {
      "offers.one": { _id: "offer-doc", namespace: "sandbox-insight" },
      "sandboxes.one": { _id: "sandbox-insight", parent: "product-1" },
      "products.one": { _id: "product-1", slug: "insight-game" },
      "ratings.one": { _id: "insight-game", score: 4.5, count: 120 },
    },
  );
  await record(
    "offer-insights-tops-populated",
    "/v1/offers/insight-game/tops",
    200,
    {
      "offers.one": { _id: "offer-doc", id: "insight-game" },
      "game_positions.many": [
        { offerId: "insight-game", collectionId: 20, position: 3 },
        { offerId: "insight-game", collectionId: 21, position: null },
        { offerId: "insight-game", collectionId: null, position: 1 },
      ],
    },
  );
  await record(
    "offer-insights-polls-populated",
    "/v1/offers/insight-game/polls",
    200,
    {
      "offers.one": { _id: "offer-doc", namespace: "sandbox-insight" },
      "sandboxes.one": { _id: "sandbox-insight", parent: "product-1" },
      "ratings_polls.one": {
        _id: "sandbox-insight",
        results: [{ option: "yes", votes: 4 }],
      },
    },
  );
  await record(
    "offer-insights-hltb-populated",
    "/v1/offers/insight-game/hltb",
    200,
    {
      "offers.one": { _id: "offer-doc", id: "insight-game" },
      "hltbs.one": {
        _id: "insight-game",
        hltbId: "game-1",
        gameplayMain: 8.5,
        gameplayMainExtra: 11,
      },
    },
  );
  await record(
    "offer-insights-igdb-populated",
    "/v1/offers/insight-game/igdb",
    200,
    {
      "offers.one": { _id: "offer-doc", id: "insight-game" },
      "igdb.one": { _id: "igdb-1", offerId: "insight-game", rating: 82 },
    },
  );
  await record(
    "offer-insights-overview-populated",
    "/v1/offers/insight-game/overview?country=US",
    200,
    {
      "offers.one": offer,
      "pricev2.one": insightPrice,
      "media.one": {
        _id: "media-1",
        offerId: "insight-game",
        videos: [{ url: "https://video.test/trailer" }],
      },
      "igdb.one": { _id: "igdb-1", offerId: "insight-game", rating: 82 },
      "offersubitems.many": [],
      "sandboxes.one": {
        _id: "sandbox-insight",
        ageGatings: { ESRB: { rating: "T" } },
      },
      "freegames.many": [
        {
          _id: "giveaway-1",
          id: "insight-game",
          startDate: new Date("2026-11-16T00:00:00.000Z"),
        },
      ],
      "tags.many": [
        { id: 777, groupName: "genre", status: "ACTIVE" },
        { id: "genre-rpg", groupName: "genre", status: "ACTIVE" },
      ],
      "items.many": [
        {
          _id: "item-doc",
          id: "item-1",
          customAttributes: [
            { key: "ThirdPartyManagedApp", type: "STRING", value: "true" },
          ],
        },
        {
          _id: "item-doc-2",
          id: "item-2",
          customAttributes: [
            { key: "MonitorPresense", type: "STRING", value: "true" },
          ],
        },
      ],
      "assets.many": [
        { _id: "asset-1", itemId: "item-1", artifactId: "app-1" },
      ],
      "builds.aggregate": [
        {
          doc: {
            _id: "build-1",
            appName: "app-1",
            createdAt: new Date("2026-11-15T00:00:00.000Z"),
            technologies: [{ section: "engine", technology: "Unreal" }],
          },
        },
      ],
      "ratings_polls.one": { _id: "sandbox-insight", results: [] },
    },
  );
  await record(
    "offer-insights-requirements-populated",
    "/v1/offers/insight-game/requirements",
    200,
    {
      "offers.one": { _id: "offer-doc", namespace: "sandbox-insight" },
      __sequence: { "offer_requirements.one": [requirement, null] },
    },
  );
  await record(
    "offer-insights-requirements-inherited",
    "/v1/offers/dlc-game/requirements",
    200,
    {
      "offers.one": { _id: "offer-doc", namespace: "sandbox-dlc" },
      __sequence: {
        "offer_requirements.one": [
          {
            namespace: "sandbox-dlc",
            offerId: "dlc-game",
            platform: "windows",
            offerType: "DLC",
            source: {
              sourceType: "confirmed_absent",
              observedAt: new Date("2026-11-02T00:00:00.000Z"),
              rawRows: [],
            },
            processing: { sourceGeneration: 4, state: "pending" },
            parent: {
              parentNamespace: "sandbox-base",
              parentOfferId: "base-game",
              relationshipType: "DLC",
              resolvedInheritance: true,
            },
            requirements: { minimum: null, recommended: null },
          },
          null,
          {
            namespace: "sandbox-base",
            offerId: "base-game",
            platform: "windows",
            offerType: "BASE_GAME",
            source: {
              sourceType: "product_page",
              observedAt: new Date("2026-10-31T00:00:00.000Z"),
              rawRows: [{ key: "OS" }],
            },
            processing: { sourceGeneration: 2, state: "normalized" },
            requirements: { minimum: { os: "Windows 10" }, recommended: null },
          },
        ],
      },
    },
  );
  await record(
    "offer-insights-requirements-missing",
    "/v1/offers/insight-game/requirements",
    404,
    {
      "offers.one": { _id: "offer-doc", namespace: "sandbox-insight" },
    },
  );
  await record(
    "offer-insights-igdb-missing",
    "/v1/offers/insight-game/igdb",
    404,
    {
      "offers.one": { _id: "offer-doc", id: "insight-game" },
    },
  );
  await record(
    "offer-insights-ratings-product-missing",
    "/v1/offers/insight-game/ratings",
    404,
    {
      "offers.one": { _id: "offer-doc", namespace: "sandbox-insight" },
      "sandboxes.one": { _id: "sandbox-insight", parent: "product-1" },
    },
  );
  const base = "/v1/offers/insight-game/";
  const blank = { "offers.one": offer };
  const ratings = {
    ...blank,
    "sandboxes.one": { parent: "store-product" },
    "products.one": { slug: "store-slug" },
  };
  for (const [route, hit] of Object.entries({
    achievements: [],
    giveaways: [],
    ratings: { score: 0 },
    tops: { featured: 4 },
    polls: { options: [] },
    hltb: { hltbId: "37" },
    igdb: { rating: 4 },
    requirements: { windows: {}, macos: null },
    overview: {
      data: { offer: { title: "Cached" } },
      localization: { localeStatus: "fallback", canonicalLocale: "en-US" },
    },
  })) {
    await record(`insight-${route}-cache`, base + route, 200, {}, hit);
    await record(`insight-${route}-invalid-id`, `/v1/offers/%20/${route}`, 400);
    await record(`insight-${route}-missing-source`, base + route, 404);
    await record(`insight-${route}-source-error`, base + route, 500, {
      "offers.one": "FAIL",
    });
  }
  for (const [route, seed, reads] of [
    ["achievements", blank, ["achievementsets.many"]],
    ["giveaways", blank, ["freegames.many"]],
    ["tops", blank, ["game_positions.many"]],
    ["ratings", ratings, ["sandboxes.one", "products.one", "ratings.one"]],
    ["polls", ratings, ["sandboxes.one", "ratings_polls.one"]],
    ["igdb", blank, ["igdb.one"]],
    ["hltb", blank, ["hltbs.one"]],
  ] as const) {
    for (const read of reads) {
      await record(`insight-${route}-error-${read}`, base + route, 500, {
        ...seed,
        [read]: "FAIL",
      });
    }
  }
  await record("insight-ratings-no-sandbox", `${base}ratings`, 404, blank);
  await record("insight-ratings-no-rating", `${base}ratings`, 404, ratings);
  await record("insight-polls-no-sandbox", `${base}polls`, 404, blank);
  await record("insight-polls-empty", `${base}polls?unrelated=1`, 200, ratings);
  await record("insight-achievements-empty", `${base}achievements`, 200, {
    "offers.one": { ...offer, offerType: "DLC" },
  });
  await record(
    "insight-giveaways-cache-offline",
    `${base}giveaways`,
    200,
    blank,
    undefined,
    true,
  );
  for (const [name, value] of Object.entries({
    empty: "",
    false: false,
    zero: 0,
    sentinel: "00000",
    absent: null,
  })) {
    await record(`insight-hltb-${name}`, `${base}hltb`, 404, {
      ...blank,
      "hltbs.one": { hltbId: value },
    });
  }
  await record("insight-tops-string-keys", `${base}tops`, 200, {
    ...blank,
    "game_positions.many": [
      { collectionId: "featured", position: 7 },
      { collectionId: 32, position: 14 },
      { collectionId: 2, position: 9 },
      { collectionId: "featured", position: 0 },
      { collectionId: [3, "a"], position: 2 },
      { collectionId: {}, position: null },
      { collectionId: false },
      { position: 1 },
      { collectionId: "__proto__", position: 3 },
    ],
  });
  const historical = BSON.deserialize(
    BSON.serialize({
      title: "Stored fields",
      _id: new ObjectId("64b000000000000000001234"),
      unknown: Long.MAX_VALUE,
      decimal: Decimal128.fromString("17.0150"),
      __v: 7,
      hash: new Binary(Buffer.from([0, 128, 255])),
      uuid: new UUID("00112233-4455-4677-8899-aabbccddeeff"),
      nested: { id: 42, updatedAt: new Date("2020-01-02T00:00:00Z"), count: 0 },
    }),
  );
  for (const [route, slot] of [
    ["achievements", "achievementsets.many"],
    ["giveaways", "freegames.many"],
    ["ratings", "ratings.one"],
    ["igdb", "igdb.one"],
    ["polls", "ratings_polls.one"],
  ] as const) {
    await record(`insight-${route}-historic-bson`, base + route, 200, {
      ...ratings,
      [slot]: slot.endsWith(".many") ? [historical] : historical,
    });
  }
  await record("insight-overview-historic-bson", `${base}overview`, 200, {
    ...blank,
    "media.one": historical,
    "igdb.one": historical,
    "freegames.many": [historical],
    "ratings_polls.one": historical,
  });
  const fullOverview = {
    ...blank,
    "items.many": [{ id: "i" }],
    "assets.many": [{ artifactId: "a" }],
  };
  for (const read of [
    "pricev2.one",
    "media.one",
    "igdb.one",
    "offersubitems.many",
    "sandboxes.one",
    "freegames.many",
    "tags.many",
    "items.many",
    "assets.many",
    "builds.aggregate",
    "ratings_polls.one",
    "egs_localizations.many",
  ]) {
    await record(
      `insight-overview-error-${read}`,
      `${base}overview?country=ES&locale=es-ES`,
      500,
      { ...fullOverview, [read]: "FAIL" },
    );
  }
  await record(
    "insight-overview-empty",
    `${base}overview`,
    200,
    blank,
    undefined,
    true,
  );
  await record(
    "insight-overview-country-error",
    `${base}overview?country=zzzz`,
    400,
  );
  await record("insight-overview-query-error", `${base}overview?extra=1`, 400);
  await record("insight-overview-dedupe", `${base}overview?country=DE`, 200, {
    ...fullOverview,
    "sandboxes.one": { ageGatings: { USK: false } },
    "offersubitems.many": [{ subItems: [{ id: 73 }, {}, { id: null }] }],
    "assets.many": [{ artifactId: 28 }, { artifactId: "app" }, {}],
    "builds.aggregate": [
      { doc: null },
      {
        doc: {
          technologies: [
            null,
            false,
            0,
            "",
            {},
            { technology: null },
            { technology: 1, name: "first" },
            { technology: "1" },
            { technology: "A" },
          ],
        },
      },
      {
        doc: {
          technologies: [
            { technology: 1, name: "second" },
            { technology: "A" },
            { technology: "B" },
          ],
        },
      },
    ],
  });
  for (const [name, field, value] of [
    ["missing-subitems", "offersubitems.many", [{}]],
    ["null-subitem", "offersubitems.many", [{ subItems: [null] }]],
    ["null-item", "offers.one", { ...offer, items: [null] }],
    ["null-tag", "offers.one", { ...offer, tags: [null] }],
  ] as const) {
    await record(`insight-overview-${name}`, `${base}overview`, 500, {
      ...blank,
      [field]: value,
    });
  }
  const dlc = {
    ...requirement,
    offerType: "DLC",
    source: {
      ...requirement.source,
      sourceType: "confirmed_absent",
      rawRows: [],
    },
    parent: {
      parentNamespace: "base-ns",
      parentOfferId: "base",
      resolvedInheritance: true,
      relationshipType: "DLC",
    },
    requirements: { minimum: null, recommended: null },
  };
  for (const [name, sequence, status] of [
    ["windows-error", ["FAIL", null], 500],
    ["macos-error", [null, "FAIL"], 500],
    ["parent-error", [dlc, null, "FAIL"], 500],
    ["missing-parent", [dlc, null, null], 200],
    [
      "stale-child",
      [{ ...dlc, processing: { sourceGeneration: 4, state: "stale" } }, null],
      200,
    ],
    ["sparse-processing", [{ ...requirement, processing: null }, null], 500],
    ["sparse-source", [{ ...requirement, source: null }, null], 500],
    [
      "historic-shape",
      [
        {
          ...requirement,
          offerType: "ADD_ON",
          processing: { state: "legacy" },
          source: { observedAt: "not-a-date" },
          requirements: {
            recommended: null,
            minimum: { cpu: "old" },
            note: "observed",
          },
        },
        null,
      ],
      200,
    ],
    [
      "preserve-field-order",
      [
        {
          ...requirement,
          requirements: {
            recommended: { ram: "8G", os: "macOS" },
            minimum: { z: 1, a: 2 },
            extra: 4,
          },
        },
        null,
      ],
      200,
    ],
    ["rejected-parent", [dlc, null, requirement], 200],
    [
      "inherits-stale",
      [
        dlc,
        null,
        {
          ...requirement,
          offerId: "base",
          namespace: "base-ns",
          processing: { state: "stale" },
          requirements: {
            recommended: null,
            minimum: { gpu: "old" },
            source: "legacy",
          },
        },
      ],
      200,
    ],
  ] as const) {
    await record(
      `insight-requirements-${name}`,
      `${base}requirements`,
      status,
      { ...blank, __sequence: { "offer_requirements.one": sequence } },
    );
  }
  const historicalNamespace = new ObjectId("64b000000000000000001237");
  const historicalProduct = new ObjectId("64b000000000000000001238");
  const typedSource = {
    "offers.one": { namespace: historicalNamespace, offerType: "DLC" },
  };
  await record(
    "insight-ratings-typed-mongo-relationships",
    `${base}ratings`,
    200,
    {
      ...typedSource,
      "sandboxes.one": { parent: historicalProduct },
      "products.one": { slug: 77 },
      "ratings.one": { score: 2 },
    },
  );
  await record("insight-polls-typed-namespace", `${base}polls`, 200, {
    ...typedSource,
    "sandboxes.one": {},
  });
  await record(
    "insight-achievements-typed-namespace",
    `${base}achievements`,
    200,
    typedSource,
  );
  for (const [name, mutation] of [
    ["no-processing", { processing: null }],
    ["no-source", { source: null }],
    ["no-requirements", { requirements: null }],
  ] as const) {
    await record(
      `insight-requirements-parent-${name}`,
      `${base}requirements`,
      500,
      {
        ...blank,
        __sequence: {
          "offer_requirements.one": [
            dlc,
            null,
            {
              ...requirement,
              namespace: "base-ns",
              offerId: "base",
              ...mutation,
            },
          ],
        },
      },
    );
  }
  await record(
    "insight-requirements-invalid-empty-source",
    `${base}requirements`,
    500,
    {
      ...blank,
      __sequence: {
        "offer_requirements.one": [
          { ...dlc, source: { ...dlc.source, rawRows: null } },
          null,
          null,
        ],
      },
    },
  );
  await record(
    "insight-overview-cache-without-locale",
    `${base}overview?country=CA`,
    200,
    {},
    { data: { offer: {} } },
  );
  await record(
    "insight-overview-age-region-missing",
    `${base}overview?country=US`,
    200,
    { ...blank, "sandboxes.one": { ageGatings: { PEGI: {} } } },
  );
  await record(
    "insight-requirements-typed-namespace",
    `${base}requirements`,
    404,
    typedSource,
  );
  const featureDecimal = Decimal128.fromString("1264");
  for (const [label, tags, itemAttributes, status] of [
    [
      "numeric-duplicates",
      [
        { id: "19847" },
        { id: 1264 },
        { id: "1264" },
        { id: [19847] },
        { id: 1203 },
      ],
      [],
      200,
    ],
    [
      "decimal-only",
      [{ id: featureDecimal }, { id: Decimal128.fromString("19847") }],
      [],
      200,
    ],
    ["decimal-array", [{ id: [featureDecimal] }, { id: "19847" }], [], 200],
    ["no-tag-array", { id: "1264" }, [], 200],
    ["sparse-tags", [{}, 42, { id: null }, { id: "1264" }], [], 200],
    ["null-tag", [null, { id: "1264" }], [], 500],
    [
      "key-overrides",
      [],
      [{ ThirdPartyManagedApp: { key: "isUplay", value: "v" } }],
      200,
    ],
    [
      "truthy-object-attributes",
      [],
      [{ ThirdPartyManagedApp: "managed", MonitorPresense: true }],
      200,
    ],
    [
      "last-attribute-wins",
      [],
      [
        [{ key: "isUplay", value: "yes" }],
        { isUplay: false, partnerType: null },
      ],
      200,
    ],
    [
      "native-truth",
      [],
      [{ ThirdPartyManagedApp: Infinity, MonitorPresense: NaN }],
      200,
    ],
    ["null-attribute-entry", [], [[null]], 500],
  ] as const) {
    await record(
      "v1-overview-historical-" + label,
      "/v1/offers/insight-game/overview",
      status,
      {
        "offers.one": { ...offer, tags },
        "offersubitems.many": [],
        "items.many": itemAttributes.map((customAttributes, index) => ({
          id: "feature-item-" + index,
          customAttributes,
        })),
      },
    );
  }
  assertOracle("offer-insights-http-node", cases);
});
