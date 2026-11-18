import { Binary, Decimal128, ObjectId } from "mongodb";
import { it } from "vitest";
import { recordMongoReads } from "../rust/oracles/read-models.js";
import { assertOracle } from "../rust/oracles/record.js";
import offerDetails from "../src/v1/routes/offer-details.js";

it("records offer metadata operations against the Node Mongo/cache boundary", async () => {
  const { record, cases } = recordMongoReads(offerDetails);
  const offer = {
    _id: "offer-doc",
    id: "game-a",
    namespace: "ns-a",
    items: [{ id: "item-a" }, { id: "item-b" }],
    tags: [
      { id: 1203, name: "Multiplayer" },
      { id: "genre-action", name: "Action" },
      { id: 123, name: "Numeric Genre" },
    ],
  };
  const item = {
    _id: "item-doc",
    id: "item-a",
    title: "Game Item",
    customAttributes: {
      ThirdPartyManagedApp: { type: "STRING", value: "true" },
    },
  };
  const itemB = {
    _id: "item-doc-b",
    id: "item-b",
    title: "Second Item",
    customAttributes: [
      { key: "MonitorPresense", type: "STRING", value: "true" },
    ],
  };
  const asset = {
    _id: "asset-doc",
    itemId: "item-a",
    artifactId: "artifact-a",
    downloadSizeBytes: 1024,
    installedSizeBytes: 2048,
  };
  const assetB = {
    _id: "asset-doc-b",
    itemId: "item-b",
    artifactId: "artifact-b",
    downloadSizeBytes: 4096,
    installedSizeBytes: 8192,
  };
  const build = {
    _id: new ObjectId("67141fcefb3045682a6fbf19"),
    appName: "artifact-a",
    buildVersion: "1.0",
    labelName: "Live-Windows",
    platform: "Windows",
    hash: "source-hash",
    createdAt: new Date("2026-11-01T00:00:00.000Z"),
    updatedAt: new Date("2026-11-02T00:00:00.000Z"),
    technologies: [{ section: "services", technology: "EOS" }],
  };
  const common = {
    offers: offer,
    "offersubitems.many": [{ _id: "game-a", subItems: [] }],
    items: [item, itemB],
    assets: [asset, assetB],
  };

  await record(
    "offer-metadata-franchises",
    "/v1/offers/game-a/franchises",
    200,
    {
      offers: offer,
      franchises: [
        {
          _id: "franchise-a",
          name: "Shared World",
          offers: ["game-a", "game-b"],
        },
      ],
      "offers.many": [
        { id: "game-a", namespace: "ns-a" },
        { id: "game-b", namespace: "ns-b" },
      ],
    },
  );
  await record(
    "offer-metadata-features",
    "/v1/offers/game-a/features",
    200,
    common,
  );
  await record(
    "offer-metadata-assets",
    "/v1/offers/game-a/assets",
    200,
    common,
  );
  await record("offer-metadata-items", "/v1/offers/game-a/items", 200, common);
  await record("offer-metadata-mappings", "/v1/offers/game-a/mappings", 200, {
    offers: offer,
    mappings: { _id: "game-a", store: { productId: "p-1" } },
  });
  await record("offer-metadata-media", "/v1/offers/game-a/media", 200, {
    offers: offer,
    media: { _id: "game-a", videos: [{ url: "https://example.test/video" }] },
  });
  await record(
    "offer-media-preserves-historical-date-field-types",
    "/v1/offers/game-a/media",
    200,
    {
      offers: offer,
      media: {
        _id: "game-a",
        metadata: {
          updatedAt: { id: 19, __v: 2, fee: Decimal128.fromString("0.25") },
          startDate: new Binary(Buffer.from([0, 127, 255])),
        },
      },
    },
  );
  await record(
    "offer-metadata-age-rating",
    "/v1/offers/game-a/age-rating?country=US&single=true",
    200,
    {
      offers: { ...offer, namespace: "ns-a" },
      sandboxes: {
        _id: "ns-a",
        ageGatings: { ESRB: { rating: "T" }, PEGI: { rating: 12 } },
      },
    },
  );
  await record(
    "offer-metadata-age-rating-generic",
    "/v1/offers/game-a/age-rating?country=AR&single=true",
    200,
    {
      offers: offer,
      sandboxes: {
        _id: "ns-a",
        ageGatings: { Generic: { rating: "Unrated" } },
      },
    },
  );
  await record("offer-metadata-genres", "/v1/offers/game-a/genres", 200, {
    offers: offer,
    tags: [
      {
        id: "genre-action",
        name: "Action",
        groupName: "genre",
        status: "ACTIVE",
      },
      { id: "genre-rpg", name: "RPG", groupName: "genre", status: "ACTIVE" },
      {
        id: "123",
        name: "Numeric Genre",
        groupName: "genre",
        status: "ACTIVE",
      },
    ],
  });
  await record(
    "offer-metadata-technologies",
    "/v1/offers/game-a/technologies",
    200,
    {
      ...common,
      "builds.aggregate": [
        { _id: "artifact-a", doc: build },
        {
          _id: "artifact-b",
          doc: {
            ...build,
            _id: new ObjectId("67141fcefb3045682a6fbf20"),
            appName: "artifact-b",
            technologies: [
              { section: "services", technology: "EOS" },
              { section: "engine", technology: "Unreal Engine" },
            ],
          },
        },
      ],
    },
  );
  await record("offer-metadata-builds", "/v1/offers/game-a/builds", 200, {
    ...common,
    "builds.many": [
      build,
      {
        ...build,
        _id: "legacy-build-id",
        appName: "artifact-b",
        sourceManifestHash: null,
        technologies: null,
      },
      { _id: "sparse", labelName: "Live-Linux", appName: "artifact-a" },
    ],
  });
  await record(
    "offer-metadata-builds-missing-platform-and-label",
    "/v1/offers/game-a/builds",
    500,
    {
      ...common,
      "builds.many": [{ _id: "legacy-build-id", appName: "artifact-a" }],
    },
  );
  await record(
    "offer-metadata-items-cache-hit",
    "/v1/offers/game-a/items",
    200,
    {},
    [{ id: "cached-item", title: "Cached Item" }],
  );
  await record(
    "offer-metadata-offer-read-error",
    "/v1/offers/game-a/features",
    500,
    {
      "offers.one": "FAIL",
    },
  );
  await record(
    "offer-metadata-mappings-missing",
    "/v1/offers/game-a/mappings",
    404,
    {
      offers: offer,
    },
  );
  const routes = [
    "franchises",
    "features",
    "assets",
    "items",
    "mappings",
    "media",
    "age-rating",
    "genres",
    "technologies",
    "builds",
  ];
  const base = "/v1/offers/game-a/";
  for (const route of routes) {
    await record(`metadata-${route}-missing-offer`, base + route, 404);
    await record(`metadata-${route}-offer-unavailable`, base + route, 500, {
      offers: "FAIL",
    });
    await record(`metadata-${route}-warm-cache`, base + route, 200, {}, [
      { title: "cached" },
    ]);
  }
  for (const route of [
    "franchises",
    "assets",
    "items",
    "genres",
    "technologies",
    "builds",
  ]) {
    for (const [label, value] of [
      ["text", "a🎮"],
      ["object", { length: 7 }],
      ["no-length", false],
    ] as const) {
      await record(
        `metadata-${route}-cached-${label}`,
        base + route,
        200,
        {},
        value,
      );
    }
  }
  const dependencies: Record<string, string[]> = {
    franchises: ["franchises.many", "offers.many"],
    features: ["offersubitems.many", "items.many"],
    assets: ["offersubitems.many", "items.many", "assets.many"],
    items: ["offersubitems.many", "items.many"],
    mappings: ["mappings.one"],
    media: ["media.one"],
    "age-rating": ["sandboxes.one"],
    genres: ["tags.many"],
    technologies: [
      "offersubitems.many",
      "items.many",
      "assets.many",
      "builds.aggregate",
    ],
    builds: ["offersubitems.many", "items.many", "assets.many", "builds.many"],
  };
  for (const [route, reads] of Object.entries(dependencies)) {
    for (const read of reads) {
      await record(`metadata-${route}-failed-${read}`, base + route, 500, {
        ...common,
        franchises: [{ offers: ["game-a"] }],
        [read]: "FAIL",
      });
    }
  }
  for (const route of [
    "assets",
    "items",
    "features",
    "builds",
    "technologies",
  ]) {
    await record(`metadata-${route}-missing-subitem-array`, base + route, 500, {
      ...common,
      "offersubitems.many": [{ _id: "game-a" }],
    });
    await record(`metadata-${route}-empty-items`, base + route, 200, {
      offers: {},
    });
  }
  for (const [label, ageGatings] of [
    ["false", false],
    ["empty", ""],
    ["zero", 0],
    ["null", null],
  ] as const) {
    await record(`metadata-age-root-${label}`, base + "age-rating", 404, {
      offers: offer,
      sandboxes: { ageGatings },
    });
  }
  for (const selected of [false, 0, "", null]) {
    await record(
      `metadata-age-selected-${JSON.stringify(selected)}`,
      base + "age-rating?single=true",
      selected === null ? 404 : 200,
      {
        offers: offer,
        sandboxes: { ageGatings: { ESRB: selected } },
      },
    );
  }
  let label: unknown = "display label";
  for (let depth = 0; depth < 10; depth++) label = { next: label };
  const ageGatings = { ESRB: { label } };
  for (const [name, query, namespace] of [
    ["all-ratings", "", new ObjectId("65ba12345678901234567890")],
    ["selected-rating", "?single=true", Decimal128.fromString("19.0")],
  ] as const) {
    await record(
      "metadata-stored-namespace-" + name,
      base + "age-rating" + query,
      200,
      {
        offers: { namespace },
        sandboxes: { ageGatings },
      },
    );
  }
  await record("metadata-age-no-sandbox", base + "age-rating", 404, {
    offers: offer,
  });
  await record(
    "metadata-age-reject-single",
    base + "age-rating?single=sometimes",
    400,
  );
  await record(
    "metadata-age-reject-country",
    base + "age-rating?country=ZZ",
    400,
  );
  await record("metadata-items-null-element", base + "items", 500, {
    offers: { items: [null] },
  });
  await record("metadata-items-null-subitem", base + "items", 500, {
    offers: offer,
    "offersubitems.many": [{ subItems: [null] }],
  });
  await record("metadata-genre-null-tag", base + "genres", 500, {
    offers: { tags: [null] },
  });
  await record(
    "metadata-franchise-distinct-namespaces",
    base + "franchises",
    200,
    {
      offers: offer,
      franchises: [
        { _id: "valid", offers: [1, "game-b"] },
        { _id: "invalid", offers: ["empty", "game-b"] },
      ],
      "offers.many": [
        { id: 1, namespace: 15 },
        { id: "empty", namespace: "" },
        { id: "game-b", namespace: "ns-b" },
      ],
    },
  );
  await record(
    "metadata-technology-historical-values",
    base + "technologies",
    200,
    {
      ...common,
      "builds.aggregate": [
        {
          doc: {
            technologies: [
              null,
              0,
              "",
              false,
              {},
              { technology: null },
              { technology: "EOS" },
              { technology: "EOS" },
            ],
          },
        },
        { doc: { technologies: "legacy" } },
        { doc: null },
      ],
    },
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
    ["null-tag", [null, { id: "1264" }], [], 200],
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
      "v1-features-historical-" + label,
      "/v1/offers/game-a/features",
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
  assertOracle("offer-metadata-http-node", cases);
});
