import { it, vi } from "vitest";
import { recordMongoReads } from "../rust/oracles/read-models.js";
import { assertOracle } from "../rust/oracles/record.js";
import offers from "../src/v1/routes/offers.js";
import { encodeCursor } from "../src/v1/cursor.js";

it("records bulk lookup and regional discovery responses and reads", async () => {
  const { record, cases } = recordMongoReads(offers);
  const bulk = (
    name: string,
    operation: "slugs" | "exists",
    rawBody: string,
    status: number,
    rows: unknown = [],
    contentType = "application/json",
  ) =>
    record(
      name,
      "/v1/offers/" + operation,
      status,
      { "offers.many": rows },
      undefined,
      false,
      { rawBody, contentType },
    );
  const candidates = [
    {
      id: 17,
      namespace: "ns",
      productSlug: "first/home",
      offerMappings: "not-inspected",
    },
    { urlSlug: "second", id: null },
    {
      offerMappings: [{ pageSlug: "third/home" }],
      id: { historical: true },
      namespace: 7,
    },
    {
      customAttributes: [
        { key: "label", value: "other" },
        { key: "com.epicgames.app.productSlug", value: "fourth" },
      ],
    },
    { customAttributes: [{ key: "slug", value: "fifth/home" }], id: [1, 2] },
    { productSlug: "first", id: "later" },
  ];
  await bulk(
    "slugs-four-lookups",
    "slugs",
    JSON.stringify({ slugs: ["first", "first"] }),
    200,
    candidates,
  );
  await bulk(
    "slugs-historical",
    "slugs",
    JSON.stringify({
      slugs: ["second", "third", "fourth", "fifth", "missing", "second"],
    }),
    200,
    candidates.slice(1),
  );
  for (const [label, value] of Object.entries({
    "malformed-mappings": { offerMappings: {} },
    "null-mapping": { offerMappings: [null] },
    "malformed-attributes": { customAttributes: false },
    "null-attribute": { customAttributes: [null] },
  }))
    await bulk("slugs-" + label, "slugs", '{"slugs":["missing"]}', 500, [
      value,
    ]);
  await bulk("slugs-missing-optional", "slugs", '{"slugs":["later"]}', 200, [
    { offerMappings: null, customAttributes: null },
    { id: "ok", urlSlug: "later" },
  ]);
  await bulk(
    "exists-historical",
    "exists",
    JSON.stringify({
      offers: ["undefined", "null", "17", "[object Object]", "1,2", "17"],
    }),
    200,
    [{}, { id: null }, { id: 17 }, { id: {} }, { id: [1, 2] }],
  );
  await bulk(
    "exists-shadowed-number",
    "exists",
    '{"offers":1e400,"offers":[]}',
    200,
  );
  for (const action of ["exists", "slugs"] as const) {
    const key = action === "slugs" ? "slugs" : "offers";
    for (const [label, raw, status] of [
      [
        "bom",
        "\ufeff" + JSON.stringify({ [key]: ["\ufeff edged \ufeff"] }),
        200,
      ],
      ["nel", JSON.stringify({ [key]: ["\u0085"] }), 200],
      [
        "length",
        JSON.stringify({ [key]: ["𐐀".repeat(action === "slugs" ? 151 : 51)] }),
        400,
      ],
      ["blank", JSON.stringify({ [key]: ["\ufeff"] }), 400],
      ["overflow-number", '{"' + key + '":[1e400]}', 400],
      ["extra", JSON.stringify({ [key]: ["entry"], extra: null }), 400],
      ["array-root", "[]", 400],
      ["bad-json", "{", 400],
    ] as const)
      await bulk(action + "-" + label, action, raw, status);
    await bulk(
      action + "-query-failure",
      action,
      JSON.stringify({ [key]: ["entry"] }),
      500,
      "FAIL",
    );
    await bulk(action + "-wrong-media", action, "{}", 415, [], "text/plain");
  }
  const a = {
    id: "a",
    namespace: "ns",
    title: "Title",
    offerType: "BASE_GAME",
    keyImages: [],
    customAttributes: [],
    tags: [],
  };
  const translated = {
    entityType: "offer",
    entityId: "ns:a",
    locale: "fr-FR",
    source: "fixture",
    fetchedAt: new Date("2026-10-03T00:00:00Z"),
    data: { title: "Titre" },
  };
  const get = (
    name: string,
    path: string,
    status: number,
    seed: Record<string, unknown> = {},
    hit?: unknown,
    offline = false,
  ) => record(name, "/v1/offers" + path, status, seed, hit, offline);
  for (const [name, path, seed] of [
    ["list-offer", "", { "offers.many": "FAIL" }],
    ["list-price", "", "price"],
    [
      "list-translation",
      "?locale=fr-FR",
      { "offers.many": [a], "egs_localizations.many": "FAIL" },
    ],
    ["detail-offer", "/a", { "offers.one": "FAIL" }],
    ["detail-price", "/a", { "offers.one": a, "pricev2.one": "FAIL" }],
    [
      "detail-translation",
      "/a?locale=fr-FR",
      { "offers.one": a, "egs_localizations.many": "FAIL" },
    ],
    ["events-tags", "/events", { "tags.many": "FAIL" }],
    ["event-tag", "/events/e", { "tags.one": "FAIL" }],
    [
      "event-aggregate",
      "/events/e",
      { "tags.one": { id: "e" }, "offers.aggregate": "FAIL" },
    ],
    [
      "event-translation",
      "/events/e?locale=fr-FR",
      {
        "tags.one": { id: "e" },
        "offers.aggregate": [a],
        "egs_localizations.many": "FAIL",
      },
    ],
    ["genre-tags", "/genres", { "tags.many": "FAIL" }],
    [
      "genre-offers",
      "/genres",
      { "tags.many": [{ id: "g" }], "offers.many": "FAIL" },
    ],
    [
      "genre-translation",
      "/genres?locale=fr-FR",
      {
        "tags.many": [{ id: "g" }],
        "offers.many": [a],
        "egs_localizations.many": "FAIL",
      },
    ],
    ["rank-positions", "/top-sellers", { "game_positions.many": "FAIL" }],
    [
      "rank-offers",
      "/top-wishlisted",
      {
        "game_positions.many": [{ offerId: "a", position: 2 }],
        "offers.many": "FAIL",
      },
    ],
    [
      "rank-translation",
      "/top-sellers?locale=fr-FR",
      {
        "game_positions.many": [{ offerId: "a", position: 2 }],
        "offers.many": [a],
        "egs_localizations.many": "FAIL",
      },
    ],
    [
      "featured-positions",
      "/featured-discounts",
      { "game_positions.many": "FAIL" },
    ],
    ["achievements-offers", "/latest-achievements", { "offers.many": "FAIL" }],
  ] as const)
    await get(
      name,
      path,
      500,
      seed === "price" ? { "offers.many": [a], "pricev2.many": "FAIL" } : seed,
    );
  for (const [label, url] of [
    ["list", "?locale=fr-FR"],
    ["detail", "/a?locale=fr-FR"],
  ]) {
    const seed = {
      "offers.one": a,
      "offers.many": [a],
      "egs_localizations.many": [translated],
    };
    await get(label + "-redis-outage", url, 200, seed, undefined, true);
    await get(label + "-translation-fallback", url, 200, {
      "offers.one": a,
      "offers.many": [a],
    });
  }
  await get("detail-blacklist", "/a", 200, {
    "offers.one": { ...a, countriesBlacklist: ["US"] },
  });
  await get("detail-whitelist", "/a", 200, {
    "offers.one": {
      ...a,
      countriesWhitelist: ["US"],
      countriesBlacklist: ["US"],
    },
  });
  await get("detail-cached-false", "/a", 404, {}, false);
  await get(
    "detail-cached-sparse",
    "/a",
    200,
    {},
    { localization: { source: "legacy" } },
  );
  await get("detail-cached-null-offer", "/a", 200, {}, { offer: null });
  await get(
    "list-cached-missing-localization",
    "",
    500,
    {},
    { offers: [], pagination: {} },
  );
  await get(
    "list-cached-omitted",
    "",
    200,
    {},
    { localization: { locale: "fr-FR" } },
  );
  await get(
    "event-cached-omitted",
    "/events/e",
    200,
    { "tags.one": { id: "e" } },
    {},
  );
  await get("event-numeric-name", "/events/e", 200, {
    "tags.one": { id: "e", name: 27 },
  });
  for (const name of ["top-sellers", "upcoming", "latest-released"])
    await get(name + "-cached-omitted", "/" + name, 200, {}, {});
  for (const name of ["featured-discounts", "latest-achievements"])
    await get(name + "-cached-object", "/" + name, 200, {}, {});
  for (const name of ["events/e", "top-wishlisted"]) {
    await get(
      name.replace("/", "-") + "-invalid-limit",
      "/" + name + "?limit=bad",
      400,
    );
    await get(
      name.replace("/", "-") + "-invalid-cursor",
      "/" + name + "?cursor=bad",
      400,
      { "tags.one": { id: "e" } },
    );
  }
  const position = { offerId: "a", position: 1 };
  const amount = {
    offerId: "a",
    region: "US",
    price: {
      discount: 35,
      originalPrice: 100,
      discountPrice: 65,
      currencyCode: "USD",
    },
  };
  for (const [label, dependency] of [
    ["offers", "offers.many"],
    ["prices", "pricev2.many"],
    ["translation", "egs_localizations.many"],
  ]) {
    await get(
      "featured-fail-" + label,
      "/featured-discounts?locale=fr-FR",
      500,
      {
        "game_positions.many": [position],
        "offers.many": [a],
        "pricev2.many": [amount],
        [dependency]: "FAIL",
      },
    );
  }
  const at = new Date("2026-10-01T00:00:00Z");
  const timed = [a, { ...a, id: "b" }].map((row) => ({
    ...row,
    releaseDate: at,
    lastModifiedDate: at,
  }));
  const badAttributes = { ...a, customAttributes: [null] };
  for (const [label, path, input] of [
    ["list", "", { "offers.many": [badAttributes] }],
    ["detail", "/a", { "offers.one": badAttributes }],
    [
      "ranked",
      "/top-wishlisted",
      { "game_positions.many": [position], "offers.many": [badAttributes] },
    ],
    [
      "event",
      "/events/e",
      { "tags.one": { id: "e" }, "offers.aggregate": [badAttributes] },
    ],
  ] as const)
    await get(label + "-bad-attributes", path, 500, input);
  await get("detail-old-attributes", "/a", 200, {
    "offers.one": {
      ...a,
      customAttributes: [
        { key: 17, type: false },
        { key: "__proto__", value: "reserved" },
        { key: false },
        { key: "flag", value: 0, type: "BOOL" },
      ],
    },
  });
  for (const [label, date, status] of [
    ["bad-date", "unknown", 500],
    ["extended-year", 8640000000000000, 200],
    ["epoch-zero", 0, 200],
  ] as const) {
    await get("list-cursor-" + label, "?limit=1", status, {
      "offers.many": [{ ...a, lastModifiedDate: date }, a],
    });
  }
  await get("list-invalid-date-last-page", "?limit=1", 200, {
    "offers.many": [{ ...a, lastModifiedDate: "unknown" }],
  });
  for (const [label, path, input] of [
    ["list", "", { "offers.many": timed }],
    ["upcoming", "/upcoming", { "offers.many": timed }],
    ["released", "/latest-released", { "offers.many": timed }],
    [
      "ranked",
      "/top-wishlisted",
      {
        "game_positions.many": [position, { offerId: "b", position: 2 }],
        "offers.many": [a],
      },
    ],
    [
      "event-priced",
      "/events/e",
      {
        "tags.one": { id: "e" },
        "offers.aggregate": [{ ...a, sortDiscount: 35, price: amount }, a],
      },
    ],
    [
      "event-null-price",
      "/events/e",
      { "tags.one": { id: "e" }, "offers.aggregate": [a, a] },
    ],
  ] as const) {
    const first = (await get(
      label + "-page-one",
      path + "?limit=1",
      200,
      input,
    )) as { meta: { pagination: { nextCursor: string } } };
    await get(
      label + "-page-two",
      path +
        "?limit=1&cursor=" +
        encodeURIComponent(first.meta.pagination.nextCursor),
      200,
      { "tags.one": { id: "e" } },
    );
  }
  const batch = Array.from({ length: 22 }, (_, i) => ({
    ...a,
    id: "batch-" + i,
  }));
  const achievement = {
    sandboxId: a.namespace,
    isBase: true,
    totalAchievements: 2,
  };
  await get("achievements-cutoff", "/latest-achievements", 200, {
    __sequence: { "offers.many": [batch.slice(0, 15), batch.slice(15)] },
    "achievementsets.many": [achievement],
    "pricev2.many": [{ ...amount, offerId: "batch-0" }],
  });
  await get(
    "achievements-translation-failure",
    "/latest-achievements?locale=fr-FR",
    500,
    {
      "offers.many": [a],
      "achievementsets.many": [achievement],
      "egs_localizations.many": "FAIL",
    },
  );
  await get("achievements-price-outage", "/latest-achievements", 200, {
    "offers.many": [a],
    "achievementsets.many": [achievement],
    "pricev2.many": "FAIL",
  });
  for (const name of ["featured-discounts", "latest-achievements"]) {
    await get(name + "-cached-length", "/" + name, 200, {}, { length: 17 });
    await get(name + "-cached-text", "/" + name, 200, {}, "ab𐐀");
  }
  for (const [operation, path, filters, ordering] of [
    ["offers.list", "", {}, "lastModifiedDate:desc,id:asc"],
    [
      "offers.top-sellers",
      "/top-sellers",
      { collectionId: "top-sellers" },
      "position:asc,offerId:asc",
    ],
  ] as const) {
    const cursor = encodeCursor(
      {
        operation,
        filters,
        ordering,
        country: "US",
        locale: "en-US",
        limit: 1,
      },
      ["a"],
    );
    await get(
      operation + "-invalid-tuple",
      path + "?limit=1&cursor=" + encodeURIComponent(cursor),
      400,
    );
  }
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("V1_CURSOR_SECRET", "");
  vi.stubEnv("V1_CURSOR_DEV_SECRET", "");
  for (const [label, path, input] of [
    ["list", "", { "offers.many": timed }],
    ["top", "/top-wishlisted", { "game_positions.many": [position, position] }],
    [
      "event",
      "/events/e",
      { "tags.one": { id: "e" }, "offers.aggregate": timed },
    ],
  ] as const) {
    await get(label + "-cursor-not-configured", path + "?limit=1", 503, input);
    Object.assign(cases[cases.length - 1] as object, { cursorSecret: false });
  }
  assertOracle("offer-discovery-edges-http-node", cases);
});
