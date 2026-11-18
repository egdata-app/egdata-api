import { readFileSync } from "node:fs";
import { Decimal128, Long, ObjectId } from "mongodb";
import { it, vi } from "vitest";
import { recordMongoReads } from "../rust/oracles/read-models.js";
import { assertOracle } from "../rust/oracles/record.js";
import { encodeCursor } from "../src/v1/cursor.js";
import sandboxes from "../src/v1/routes/sandboxes.js";
import sellers from "../src/v1/routes/sellers.js";

const offer = {
  id: "offer",
  namespace: "ns",
  title: "Title",
  seller: { id: "sid", name: "Seller" },
  lastModifiedDate: new Date("2026-11-01Z"),
};
const item = {
  id: "item",
  namespace: "ns",
  title: "Item",
  releaseInfo: [{ appId: "App", platform: ["Windows", "Mac"] }],
};
const sid = "/v1/sellers/sid";
const ns = "/v1/sandboxes/ns";
const sandbox = { _id: "ns", name: "Sandbox" };
const found = { "sandboxes.one": sandbox };

it("records seller validation, pagination, cover, stats and failure paths", async () => {
  const { record, cases } = recordMongoReads(sellers);
  for (const route of ["/v1/sellers", sid, `${sid}/cover`, `${sid}/stats`])
    await record(`unknown-${route}`, `${route}?extra=x`, 400);
  for (const suffix of ["", "/cover", "/stats"])
    await record(`blank-id-${suffix}`, `/v1/sellers/%20${suffix}`, 400);
  for (const suffix of ["", "/cover"])
    await record(
      `invalid-country-${suffix}`,
      `${sid + suffix}?country=xyz`,
      400,
    );
  await record("seller-invalid-limit", `${sid}?limit=0&country=xyz`, 400);
  await record(
    "seller-oversize",
    `${sid}?offerType=${"x".repeat(65)}&limit=0&extra=x`,
    400,
  );
  await record(
    "seller-oversize-utf16",
    `${sid}?offerType=${encodeURIComponent("🎮".repeat(33))}`,
    400,
  );
  const directory = [
    { id: "x", name: "A" },
    { id: "b", name: "A" },
    { id: "b", name: "Duplicate" },
    { name: "Orphan" },
    null,
  ];
  await record("directory-tie", "/v1/sellers", 200, {
    "offers.distinct": directory,
  });
  const page = `${sid}?limit=1&offerType=BASE_GAME&ignoredSandboxes=second,first`;
  const first = await record("seller-first", page, 200, {
    offers: [offer, { ...offer, id: "two" }],
    pricev2: [{ offerId: "offer", price: { originalPrice: 100 } }],
  });
  await record(
    "seller-second",
    `${page}&cursor=${encodeURIComponent(first.meta.pagination.nextCursor)}`,
    200,
  );
  const tuple = encodeCursor(
    {
      operation: "sellers.offers",
      filters: { offerType: null, ignoredSandboxes: [] },
      ordering: "lastModifiedDate:desc,id:asc",
      country: "US",
      locale: "en-US",
      limit: 20,
    },
    [null],
  );
  await record("seller-short-tuple", `${sid}?cursor=${tuple}`, 400);
  await record("seller-malformed-token", `${sid}?cursor=wrong`, 400);
  await record("cover-fallback", `${sid}/cover`, 200, {
    __sequence: { "offers.many": [[], [offer]] },
    pricev2: [{ offerId: "offer", price: { originalPrice: 100 } }],
  });
  await record("cover-position", `${sid}/cover`, 200, {
    game_positions: [{ offerId: "offer" }],
    offers: [offer],
  });
  await record("cover-empty", `${sid}/cover`, 200);
  await record("seller-stats-all", `${sid}/stats`, 200, {
    sellers: { _id: "sid", name: "Seller" },
    "offers.count": 9,
    "items.count": 7,
    "offers.aggregate": [{ count: 3 }],
    freegames: [{ count: 2 }],
    "mobile-freebies": [{ count: 1 }],
  });
  await record("seller-stats-missing", `${sid}/stats`, 404);
  await record("directory-historical-names", "/v1/sellers", 200, {
    "offers.distinct": [
      { id: "z", name: 2 },
      { id: "a", name: ["Zulu"] },
      { id: "b", name: true },
      { id: "c", name: null },
      { id: "d", name: "Alpha" },
      { id: "e", name: { en: "Delta" } },
    ],
  });
  const historicalIds = [
    { id: 7 },
    { id: "7" },
    { id: null },
    {},
    { id: "" },
    { id: false },
    { id: new ObjectId("64f000000000000000000005") },
  ];
  const historicalPrices = historicalIds.map(({ id }, index) => ({
    ...(id === undefined
      ? {}
      : {
          offerId: id instanceof ObjectId ? new ObjectId(id.toHexString()) : id,
        }),
    currencyCode: "USD",
    price: { discountPrice: index + 1, originalPrice: index + 100 },
  }));
  historicalPrices.push({
    offerId: 7,
    currencyCode: "EUR",
    price: { discountPrice: 0, originalPrice: 1 },
  });
  for (const suffix of ["", "/cover"]) {
    await record(`historical-ids${suffix}`, sid + suffix, 200, {
      game_positions: historicalIds.map(({ id }) =>
        id === undefined ? {} : { offerId: id },
      ),
      offers: (suffix ? historicalIds.slice(-5) : historicalIds).map((row) => ({
        namespace: "ns",
        title: "Offer",
        ...row,
      })),
      pricev2: historicalPrices,
    });
    await record(`historical-attributes${suffix}`, sid + suffix, 200, {
      offers: [
        {
          ...offer,
          customAttributes: [
            { key: 5, type: 42, value: "numeric key" },
            { key: "missing-value" },
            { key: "defaults", type: false, value: null },
          ],
        },
      ],
    });
    await record(`null-attribute-entry${suffix}`, sid + suffix, 500, {
      offers: [{ ...offer, customAttributes: [null] }],
    });
  }
  const historicalPage = await record(
    "seller-object-id-first",
    `${sid}?limit=1`,
    200,
    {
      offers: [historicalIds.at(-1), offer],
    },
  );
  await record("historical-localization-keys", `${sid}?locale=fr`, 200, {
    offers: [
      { ...offer, id: 7 },
      { ...offer, id: "7" },
      { ...offer, id: new ObjectId("64f000000000000000000005") },
      { ...offer, id: "real" },
      { ...offer, id: "empty-namespace", namespace: "" },
      {
        ...offer,
        id: "native-namespace",
        namespace: new ObjectId("64f000000000000000000006"),
      },
      { ...offer, id: "" },
    ],
    egs_localizations: [
      {
        entityId: "ns:7",
        data: { title: "Sept" },
        source: "fixture",
        fetchedAt: new Date("2026-01-01Z"),
      },
    ],
  });
  await record(
    "seller-object-id-next",
    `${sid}?limit=1&cursor=${historicalPage.meta.pagination.nextCursor}`,
    200,
  );
  for (const [name, games, desktop, mobile] of [
    ["signed", -2, "-3.5", 1.25],
    ["numeric-string", "0x10", [2], true],
    ["non-finite-string", "Infinity", {}, "unavailable"],
    ["missing", null, [], false],
    [
      "bson",
      Decimal128.fromString("6.25"),
      new Date(17),
      Decimal128.fromString("Infinity"),
    ],
    [
      "long",
      Long.fromString("9007199254740993"),
      Long.fromNumber(4),
      Long.fromNumber(5),
    ],
  ] as const) {
    await record(`stats-${name}`, `${sid}/stats`, 200, {
      sellers: { id: "sid" },
      "offers.aggregate": [{ count: games }],
      freegames: [{ count: desktop }],
      "mobile-freebies": [{ count: mobile }],
    });
  }
  for (const empty of [false, 0, ""]) {
    await record(
      `stats-cached-miss-${typeof empty}`,
      `${sid}/stats`,
      404,
      {},
      empty,
    );
  }
  await record(
    "list-cached-partial",
    "/v1/sellers",
    200,
    {},
    { sellers: [{ id: "x" }] },
  );
  await record("list-cached-missing-rows", "/v1/sellers", 500, {}, {});
  await record(
    "list-cached-string-total",
    "/v1/sellers",
    200,
    {},
    { sellers: [], total: "2" },
  );
  await record(
    "list-cached-utf16",
    "/v1/sellers",
    200,
    {},
    { sellers: "🎮", total: 3 },
  );
  await record(
    "list-cached-object",
    "/v1/sellers",
    200,
    {},
    { sellers: {}, total: 3 },
  );
  await record(
    "list-cached-object-length",
    "/v1/sellers",
    200,
    {},
    { sellers: { length: "2" }, total: "12" },
  );
  await record(
    "offers-cached-partial",
    sid,
    200,
    {},
    { localization: { canonicalLocale: "en-US" } },
  );
  await record(
    "list-cached-array-length",
    "/v1/sellers",
    200,
    {},
    { sellers: { length: ["2"] }, total: ["12"] },
  );
  await record(
    "list-cached-invalid-length",
    "/v1/sellers",
    200,
    {},
    { sellers: { length: "unavailable" }, total: 1 },
  );
  await record(
    "offers-cached-null",
    sid,
    200,
    {},
    { offers: null, pagination: null },
  );
  await record("cover-cached-missing-rows", `${sid}/cover`, 500, {}, {});
  await record(
    "cover-cache-hit",
    `${sid}/cover`,
    200,
    {},
    { offers: [], localization: { locale: "fr" } },
  );
  await record("cover-cached-object", `${sid}/cover`, 200, {}, { offers: {} });
  await record("stats-cache-hit", `${sid}/stats`, 200, {}, { offers: 12 });
  // Reuse the original Node response examples, recording every service call for Rust.
  for (const filename of ["catalog-http-node", "seller-reads-http-node"]) {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          `../rust/crates/egdata-api/tests/fixtures/${filename}.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      name: string;
      request: { path: string };
      response: { status: number };
      input: Record<string, unknown> & { cachePayload?: string };
    }[];
    for (const sample of fixture.filter((sample) =>
      sample.name.startsWith("seller-"),
    )) {
      const { input, request } = sample;
      const seed = request.path.endsWith("/cover")
        ? {
            game_positions: input.topSellerPositions,
            __sequence: {
              "offers.many": [input.topSellerOffers, input.fallbackOffers],
            },
          }
        : request.path.endsWith("/stats")
          ? {
              sellers: input.seller,
              "offers.count": input.offers,
              "items.count": input.items,
              "offers.aggregate": [{ count: input.games }],
              freegames: [{ count: input.freegames }],
              "mobile-freebies": [{ count: input.mobileFreegames }],
            }
          : {
              "offers.distinct": input.databaseFailure
                ? "FAIL"
                : (input.sellers ?? []),
              offers: input.offers ?? [],
              pricev2: input.prices ?? [],
            };
      await record(
        `original-${sample.name}`,
        request.path,
        sample.response.status,
        seed,
        input.cachePayload && JSON.parse(input.cachePayload),
      );
    }
  }
  for (const [label, path, seed] of [
    ["seller-list", "/v1/sellers", { "offers.distinct": "FAIL" }],
    ["seller-find", sid, { offers: "FAIL" }],
    ["seller-prices", sid, { offers: [offer], pricev2: "FAIL" }],
    [
      "seller-localize",
      `${sid}?locale=fr`,
      { offers: [offer], egs_localizations: "FAIL" },
    ],
    ["cover-positions", `${sid}/cover`, { game_positions: "FAIL" }],
    ["cover-offers", `${sid}/cover`, { offers: "FAIL" }],
    [
      "cover-fallback",
      `${sid}/cover`,
      { __sequence: { "offers.many": [[], "FAIL"] } },
    ],
    ["cover-prices", `${sid}/cover`, { offers: [offer], pricev2: "FAIL" }],
    [
      "cover-localize",
      `${sid}/cover?locale=fr`,
      { offers: [offer], egs_localizations: "FAIL" },
    ],
    ["stats-find", `${sid}/stats`, { sellers: "FAIL" }],
    [
      "stats-free",
      `${sid}/stats`,
      { sellers: { _id: "sid" }, freegames: "FAIL" },
    ],
    [
      "stats-mobile",
      `${sid}/stats`,
      { sellers: { _id: "sid" }, "mobile-freebies": "FAIL" },
    ],
  ] as const)
    await record(`failure-${label}`, path, 500, seed);
  for (const failure of ["offers.count", "items.count", "offers.aggregate"]) {
    await record(`stats-failure-${failure}`, `${sid}/stats`, 500, {
      sellers: { _id: "sid" },
      [failure]: "FAIL",
    });
  }
  const extraTuple = encodeCursor(
    {
      operation: "sellers.offers",
      filters: { offerType: null, ignoredSandboxes: [] },
      ordering: "lastModifiedDate:desc,id:asc",
      country: "US",
      locale: "en-US",
      limit: 20,
    },
    [null, "id", "extra"],
  );
  await record("seller-long-tuple", `${sid}?cursor=${extraTuple}`, 400);
  vi.stubEnv("V1_CURSOR_SECRET", "");
  vi.stubEnv("V1_CURSOR_DEV_SECRET", "");
  vi.stubEnv("NODE_ENV", "production");
  await record("seller-unconfigured", `${sid}?limit=1`, 503, {
    offers: [offer, offer],
  });
  Object.assign(cases.at(-1) as object, { cursorSecret: false });
  assertOracle("seller-edge-http-node", cases);
});

it("records sandbox filters, context hydration, BSON cursors and negative reads", async () => {
  const { record, cases } = recordMongoReads(sandboxes);
  const paths = [
    "",
    "/items",
    "/offers",
    "/assets",
    "/base-game",
    "/achievements",
    "/changelog",
    "/builds",
    "/stats",
  ];
  for (const path of paths) {
    await record(`unknown-${path}`, `${ns + path}?bad=1`, 400);
    await record(`blank-${path}`, `/v1/sandboxes/%20${path}?bad=x`, 400);
    await record(`missing-${path}`, ns + path, 404);
  }
  await record("unknown-list", "/v1/sandboxes?bad=1", 400);
  await record("bad-offer-locale", `${ns}/offers?locale=_`, 400);
  await record("bad-base-country", `${ns}/base-game?country=xyz`, 400);
  await record(
    "max-title-items",
    `${ns}/items?status=${"a".repeat(501)}&title=${"b".repeat(201)}&extra=x`,
    400,
  );
  await record(
    "max-offer-list",
    `${ns}/offers?offerType=${"a".repeat(501)}&title=${"b".repeat(201)}`,
    400,
  );
  const objectId = new ObjectId("615f1f77bcf86cd799439011");
  const secondId = new ObjectId("615f1f77bcf86cd799439012");
  const change = {
    _id: objectId,
    timestamp: new Date("2026-11-03Z"),
    metadata: { contextType: "offer", contextId: offer.id },
  };
  const build = {
    _id: objectId,
    appName: "App",
    buildVersion: "1",
    labelName: "Live-Windows",
    updatedAt: new Date("2026-11-03Z"),
  };
  for (const [path, seed] of [
    ["items", { items: [item, { ...item, id: "two" }] }],
    ["offers", { offers: [offer, { ...offer, id: "two" }] }],
    ["assets", { items: [item] }],
    ["builds", { items: [item], builds: [build, { ...build, _id: secondId }] }],
    [
      "changelog",
      {
        items: [item],
        offers: [{ ...offer, items: [{ id: item.id }] }],
        assets: [{ artifactId: "artifact" }],
        builds: [build],
        changelogs_v2: [change, { ...change, _id: secondId }],
        "offers.one": offer,
      },
    ],
  ] as const) {
    const page = `${ns}/${path}?limit=1`;
    const first = await record(`page-${path}`, page, 200, {
      ...seed,
      ...found,
    });
    const cursor = first.meta.pagination.nextCursor;
    if (!cursor) throw Error(`Missing next cursor in ${path}`);
    await record(
      `continue-${path}`,
      `${page}&cursor=${encodeURIComponent(cursor)}`,
      200,
      { ...found, items: [item] },
    );
  }
  const first = await record("ns-first", "/v1/sandboxes?limit=1", 200, {
    "namespaces.many": [sandbox, { _id: "two" }],
  });
  await record(
    "ns-second",
    `/v1/sandboxes?limit=1&cursor=${first.meta.pagination.nextCursor}`,
    200,
  );
  for (const [kind, id] of [
    ["item", "item"],
    ["asset", "artifact"],
    ["build", objectId.toHexString()],
    ["build", "legacy"],
    ["other", "id"],
    ["", null],
  ]) {
    await record(`context-${kind}-${id}`, `${ns}/changelog`, 200, {
      ...found,
      "items.one": item,
      "assets.one": { artifactId: "artifact" },
      "builds.one": build,
      changelogs_v2: [
        { ...change, metadata: { contextType: kind, contextId: id } },
      ],
    });
  }
  await record("builds-missing-label", `${ns}/builds`, 500, {
    ...found,
    items: [item],
    builds: [{ _id: objectId, appName: "App" }],
  });
  await record("builds-absent-app", `${ns}/builds`, 200, found);
  await record("base-fallback-offer", `${ns}/base-game`, 200, {
    ...found,
    __sequence: { "offers.one": [null, offer] },
  });
  await record("base-executable-item", `${ns}/base-game`, 200, {
    ...found,
    items: item,
  });
  await record("base-missing", `${ns}/base-game`, 404, found);
  await record("namespace-detail", ns, 200, { "namespaces.one": sandbox });
  await record("namespace-exists-by-fallback", `${ns}/items`, 200, {
    "namespaces.one": sandbox,
    items: [item],
  });
  for (const path of ["/items", "/offers", "/assets", "/builds", "/changelog"])
    await record(
      `invalid-cursor${path}`,
      `${ns + path}?cursor=wrong`,
      400,
      found,
    );
  await record(
    "filtered-items",
    `${ns}/items?platforms=Mac,Windows&status=LIVE&entitlementType=GAME&title=a%5Bb`,
    200,
    { ...found, items: [item] },
  );
  await record(
    "filtered-offers",
    `${ns}/offers?offerType=BASE_GAME&title=a%5Bb`,
    200,
    { ...found, offers: [offer] },
  );
  await record("filtered-builds", `${ns}/builds?platform=Windows`, 200, {
    ...found,
    items: [item],
    builds: [build],
  });
  await record("populated-achievementsets", `${ns}/achievements`, 200, {
    ...found,
    achievementsets: [{ id: "set", achievements: [{ id: "ach" }] }],
  });
  await record("sandbox-stats", `${ns}/stats`, 200, {
    ...found,
    "offers.count": 2,
    items: [item],
    achievementsets: [{ achievements: [{}] }, {}],
    assets: [{ artifactId: "App" }],
  });
  for (const [suffix, failed, seed] of [
    ["", "namespaces.one", {}],
    ["", "sandboxes.one", {}],
    ["/items", "items.many", found],
    ["/offers", "offers.many", found],
    ["/offers", "pricev2.many", { ...found, offers: [offer] }],
    [
      "/offers?locale=fr",
      "egs_localizations.many",
      { ...found, offers: [offer] },
    ],
    ["/assets", "items.many", found],
    ["/assets", "assets.many", found],
    ["/base-game", "offers.one", found],
    ["/base-game", "pricev2.one", { ...found, "offers.one": offer }],
    ["/base-game", "items.one", found],
    [
      "/base-game?locale=fr",
      "egs_localizations.many",
      { ...found, "offers.one": offer },
    ],
    ["/builds", "items.many", found],
    ["/builds", "builds.many", found],
    ["/changelog", "changelogs_v2.aggregate", found],
    ["/changelog", "items.many", found],
    ["/changelog", "offers.many", found],
    ["/changelog", "assets.many", { ...found, items: [item] }],
    ["/changelog", "builds.many", { ...found, items: [item] }],
    ["/achievements", "achievementsets.many", found],
    ["/stats", "offers.count", found],
    ["/stats", "items.many", found],
    ["/stats", "achievementsets.many", found],
    ["/stats", "assets.many", found],
  ] as const) {
    await record(`sandbox-failure-${suffix}-${failed}`, ns + suffix, 500, {
      ...seed,
      [failed]: "FAIL",
    });
  }
  await record("blank-detail", "/v1/sandboxes/%20", 400);
  for (const route of [
    "/v1/sandboxes",
    `${ns}/items`,
    `${ns}/assets`,
    `${ns}/changelog`,
    `${ns}/builds`,
  ]) {
    await record(`${route}-limit`, `${route}?limit=0`, 400);
  }
  await record("ns-list-failure", "/v1/sandboxes", 500, { namespaces: "FAIL" });
  await record("ns-invalid-token", "/v1/sandboxes?cursor=no", 400);
  await record("require-ns-failure", `${ns}/items`, 500, {
    "sandboxes.one": "FAIL",
  });
  await record("base-second-read-failure", `${ns}/base-game`, 500, {
    ...found,
    __sequence: { "offers.one": [null, "FAIL"] },
  });
  await record("stats-build-count-failed", `${ns}/stats`, 500, {
    ...found,
    "builds.count": "FAIL",
  });
  await record("stats-sparse-release", `${ns}/stats`, 200, {
    ...found,
    items: [{ releaseInfo: [null, {}] }],
  });
  await record("changelog-missing-meta", `${ns}/changelog`, 200, {
    ...found,
    changelogs_v2: [{ _id: objectId }],
  });
  for (const [route, ordering, filters, tuple] of [
    ["list", "_id:asc", {}, []],
    [
      "items",
      "lastModifiedDate:desc,id:asc",
      {
        sandboxId: "ns",
        entitlementType: null,
        status: null,
        platforms: null,
        title: null,
      },
      [1794873600000],
    ],
    [
      "builds",
      "updatedAt:desc,_id:desc",
      { sandboxId: "ns", platforms: null },
      ["invalid-date", "legacy", "extra"],
    ],
    ["changelog", "timestamp:desc,_id:desc", { sandboxId: "ns" }, [null, 4]],
  ] as const) {
    const token = encodeCursor(
      {
        operation: `sandboxes.${route}`,
        filters,
        ordering,
        country: "",
        locale: "",
        limit: 20,
      },
      [...tuple],
    );
    await record(
      `sandbox-scalar-${route}`,
      `${route === "list" ? "/v1/sandboxes" : `${ns}/${route}`}?cursor=${token}`,
      200,
      found,
    );
  }
  await record("numeric-base-offer-id", `${ns}/base-game`, 200, {
    ...found,
    offers: { ...offer, id: 42 },
  });
  vi.stubEnv("V1_CURSOR_SECRET", "");
  vi.stubEnv("V1_CURSOR_DEV_SECRET", "");
  vi.stubEnv("NODE_ENV", "production");
  for (const [route, seed] of [
    ["/v1/sandboxes", { namespaces: [sandbox, sandbox] }],
    [`${ns}/items`, { ...found, items: [item, item] }],
    [`${ns}/assets`, { ...found, items: [item] }],
    [`${ns}/changelog`, { ...found, changelogs_v2: [change, change] }],
    [`${ns}/builds`, { ...found, builds: [build, build] }],
  ] as const) {
    await record(`${route}-cursor-unconfigured`, `${route}?limit=1`, 503, seed);
    Object.assign(cases.at(-1) as object, { cursorSecret: false });
  }
  assertOracle("sandbox-edge-http-node", cases);
});
