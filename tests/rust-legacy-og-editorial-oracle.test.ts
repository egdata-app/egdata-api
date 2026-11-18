import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createReadRecorder } from "../rust/oracles/legacy-catalog-record.js";
import { assertOracle } from "../rust/oracles/record.js";
import { apiCors } from "../src/middlewares/cors.js";
import { edgeCacheHeaders } from "../src/middlewares/edge-cache.js";
import { responseEtag } from "../src/middlewares/response-etag.js";
import { routeTemplate } from "../src/middlewares/route-template.js";

const recorder = createReadRecorder();
const rendered: { current: unknown } = { current: null };

function encodeRegexps(value: unknown): unknown {
  if (value instanceof RegExp) {
    return { $regularExpression: { pattern: value.source, options: value.flags } };
  }
  if (Array.isArray(value)) {
    return value.map(encodeRegexps);
  }
  if (value !== null && typeof value === "object" && !(value instanceof Date) && !(value instanceof ObjectId)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, encodeRegexps(v)]),
    );
  }
  return value;
}

function wrappedCollection(name: string) {
  const base = recorder.collection(name);
  return {
    ...base,
    findOne: (q?: unknown, options?: unknown) => base.findOne(encodeRegexps(q), options),
    find: (q?: unknown, options?: Record<string, unknown>) => {
      const cursor = base.find(encodeRegexps(q), options) as ReturnType<typeof base.find> & {
        next?: () => Promise<unknown>;
      };
      cursor.next = async () => {
        const rows = await cursor.toArray();
        if (!Array.isArray(rows)) throw new Error("Expected recorded cursor rows");
        return rows[0] ?? null;
      };
      return cursor;
    },
    countDocuments: (q?: unknown) => base.countDocuments(encodeRegexps(q)),
    aggregate: (pipeline: unknown[], options?: unknown) =>
      base.aggregate(encodeRegexps(pipeline) as unknown[], options),
  };
}

vi.mock("../src/db/index.js", () => ({
  db: { db: { collection: (name: string) => wrappedCollection(name) } },
}));
vi.mock("../src/clients/response-cache.js", () => ({
  default: {
    get: (...args: Parameters<typeof recorder.cache.get>) =>
      recorder.cache.get(...args),
    set: (...args: Parameters<typeof recorder.cache.set>) =>
      recorder.cache.set(...args),
  },
}));
vi.mock("../src/utils/offer-og.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/offer-og.js")>()),
  renderOfferOg: vi.fn(
    async (card: unknown, format: "png" | "webp", cover?: Uint8Array) => {
      rendered.current = { kind: "offer", card, format, coverLength: cover?.length ?? 0 };
      return format === "png"
        ? Uint8Array.from([137, 80, 78, 71])
        : Uint8Array.from([82, 73, 70, 70]);
    },
  ),
}));
vi.mock("../src/utils/database-og.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/database-og.js")>()),
  fetchOgCover: vi.fn(async () => undefined),
  renderDatabaseOg: vi.fn(
    async (card: unknown, format: "png" | "webp", cover?: Uint8Array) => {
      rendered.current = { kind: "sandbox", card, format, coverLength: cover?.length ?? 0 };
      return format === "png"
        ? Uint8Array.from([137, 80, 78, 71])
        : Uint8Array.from([82, 73, 70, 70]);
    },
  ),
}));
vi.mock("satori", () => ({
  default: vi.fn(async (element: unknown) => {
    rendered.current = { kind: "game-awards", element: JSON.stringify(element) };
    return "<svg></svg>";
  }),
}));
vi.mock("@resvg/resvg-js", () => ({
  Resvg: class {
    render() {
      return {
        asPng: () => Buffer.from([137, 80, 78, 71]),
      };
    }
  },
}));

describe("legacy OG and editorial HTTP Node oracle", () => {
  afterAll(() => {
    vi.useRealTimers();
  });

  it("records legacy OG image and editorial route responses, reads and cache behavior", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-17T00:00:00Z"));

    const app = new Hono();
    app.use("*", apiCors(), responseEtag, routeTemplate, edgeCacheHeaders);
    app.route(
      "/offers/:id",
      (await import("../src/routes/offers/og.js")).default,
    );
    app.route(
      "/sandboxes/:sandboxId",
      (await import("../src/routes/sandbox-og.js")).default,
    );
    app.route(
      "/promotions",
      (await import("../src/routes/promotions.js")).default,
    );
    app.route(
      "/collections",
      (await import("../src/routes/collections.js")).default,
    );
    app.route(
      "/game-awards",
      (await import("../src/routes/game-awards.js")).default,
    );

    type Read = Parameters<typeof recorder.record>[4][number];
    const cases: unknown[] = [];
    const faultCases = new Set([
      "offer-og-png-versioned-cookie", "sandbox-og-executable-fallback",
      "promotions-list", "promotion-detail-price-expand-fr", "promotion-cover",
      "collection-current-expand-fr", "collection-week-expand-fr", "game-awards-expand-fr",
    ]);

    const record = async (
      name: string,
      path: string,
      status: number,
      reads: Read[] = [],
      cacheHit: unknown = null,
      headers?: Record<string, string>,
      captureRendered = false,
    ) => {
      rendered.current = null;
      const entry = await recorder.record(
        app,
        name,
        { method: "GET", path, headers },
        status,
        reads,
        cacheHit,
        ["vary"],
      );
      cases.push({
        ...entry,
        ...(captureRendered && rendered.current ? { renderer: rendered.current } : {}),
      });
      if (faultCases.has(name)) {
        for (let index = 0; index < entry.trace.length; index++) {
          const { call } = entry.trace[index] as { call: { collection?: string } };
          const toleratesFailure = name === "collection-current-expand-fr" &&
            (call.collection === "offers" || call.collection === "pricev2");
          cases.push(await recorder.record(
            app, `${name}-dependency-failure-${index}`, { method: "GET", path, headers },
            toleratesFailure ? 200 : 500, reads, cacheHit, ["vary"], index,
          ));
        }
      }
    };

    const offerA = {
      _id: "mongo-offer-a",
      id: "offer-a",
      namespace: "ns-a",
      title: "Parity Offer",
      offerType: "BASE_GAME",
      publisherDisplayName: "Parity Studio",
      lastModifiedDate: new Date("2026-09-15T00:00:00Z"),
      releaseDate: new Date("2026-10-10T00:00:00Z"),
      keyImages: [{ type: "DieselGameBoxTall", url: "https://cdn.test/cover.png" }],
      items: [{ id: "item-direct" }],
      seller: { name: "Seller A" },
      customAttributes: [{ key: "k", value: "v" }],
    };
    const offerFree = {
      id: "offer-free",
      namespace: "ns-a",
      title: "Blacklisted Offer",
      countriesBlacklist: ["US"],
      updatedAt: new Date("2026-09-01T00:00:00Z"),
      viewableDate: new Date("2026-09-02T00:00:00Z"),
      seller: { name: "Seller Free" },
      items: [],
    };
    const offerZero = {
      id: "offer-zero",
      namespace: "ns-a",
      title: "Free Game",
      offerType: "ADD_ON",
      items: [],
    };
    const priceEs = {
      offerId: "offer-a",
      region: "ES",
      price: { currencyCode: "EUR", discountPrice: 1999 },
    };
    const priceUs = {
      offerId: "offer-a",
      region: "US",
      price: { currencyCode: "USD", discountPrice: 2499 },
    };
    const priceZero = {
      offerId: "offer-zero",
      region: "US",
      price: { currencyCode: "USD", discountPrice: 0 },
    };
    const subItemDoc = { _id: "offer-a", subItems: [{ id: "item-sub" }] };
    const assetDirect = {
      itemId: "item-direct",
      artifactId: "art-direct",
      platform: "Windows",
      downloadSizeBytes: 5_000_000_000,
    };
    const assetSub = {
      itemId: "item-sub",
      artifactId: "art-sub",
      platform: "Mac",
      downloadSizeBytes: 9_000_000_000,
      updatedAt: new Date("2026-09-05T00:00:00Z"),
    };
    const buildDoc = {
      _id: new ObjectId("65ba00000000000000000001"),
      appName: "art-direct",
      buildVersion: "v1",
      labelName: "Live-Windows",
      hash: "hash-1",
      downloadSizeBytes: 3_250_000_000,
    };

    // 1. Offers OG
    await record(
      "offer-og-png-versioned-cookie",
      "/offers/offer-a/og?v=1",
      200,
      [
        ["offers", "one", offerA],
        ["pricev2", "one", priceEs],
        ["offersubitems", "many", [subItemDoc]],
        ["items", "many", [{ id: "item-direct" }, { id: "item-sub" }]],
        ["assets", "many", [assetDirect, assetSub]],
        ["builds", "many", [buildDoc]],
      ],
      null,
      { cookie: "EGDATA_COUNTRY=ES" },
      true,
    );
    await record(
      "offer-og-webp-country-query",
      "/offers/offer-a/og.webp?country=US",
      200,
      [
        ["offers", "one", offerA],
        ["pricev2", "one", priceUs],
        ["offersubitems", "many", []],
        ["items", "many", [{ id: "item-sub" }]],
        ["assets", "many", [assetSub]],
        ["builds", "many", []],
      ],
      null,
      undefined,
      true,
    );
    await record(
      "offer-og-blacklisted",
      "/offers/offer-free/og?country=US",
      200,
      [
        ["offers", "one", offerFree],
        ["offersubitems", "many", []],
        ["items", "many", []],
        ["assets", "many", []],
      ],
      null,
      undefined,
      true,
    );
    await record(
      "offer-og-zero-price",
      "/offers/offer-zero/og",
      200,
      [
        ["offers", "one", offerZero],
        ["pricev2", "one", priceZero],
        ["offersubitems", "many", []],
        ["items", "many", []],
        ["assets", "many", []],
      ],
      null,
      undefined,
      true,
    );
    for (const [name, amount, currency, status] of [
      ["invalid-paid-currency", 100, "?", 500],
      ["numeric-paid-currency", 100, 42, 500],
      ["free-with-invalid-currency", 0, "?", 200],
      ["historic-currency", 1250, "IQD", 200],
    ] as const) {
      await record(`offer-og-${name}`, "/offers/offer-zero/og", status, [
        ["offers", "one", offerZero],
        ["pricev2", "one", { price: { discountPrice: amount, currencyCode: currency } }],
        ["offersubitems", "many", []],
        ["items", "many", []],
        ["assets", "many", []],
      ], null, undefined, status === 200);
    }
    await record("offer-og-country-missing", "/offers/offer-a/og?country=ZZ", 404);
    for (const [name, direct, sub] of [
      ["null-direct-item", [null], []],
      ["non-array-direct-items", "old", []],
      ["null-subitem", [], [{ subItems: [null] }]],
      ["missing-subitems", [], [{}]],
    ] as const) {
      await record(`offer-og-${name}`, "/offers/offer-zero/og", 500, [
        ["offers", "one", { ...offerZero, items: direct }],
        ["pricev2", "one", null],
        ["offersubitems", "many", sub],
      ]);
    }
    const mixedAssets = [
      { itemId: 7, artifactId: "z" }, { itemId: 7, artifactId: "a" },
      { itemId: 7, artifactId: "z" }, { itemId: 7 }, { itemId: 7, artifactId: null },
      { itemId: 7, artifactId: 5 }, { itemId: "other", artifactId: "excluded" },
    ];
    for (const [name, builds, status] of [
      ["mixed-artifact-ids", [], 200],
      ["missing-build-label", [{ _id: "build", appName: "a" }], 500],
      ["missing-build-id", [{ appName: "a", platform: "Windows" }], 500],
    ] as const) {
      await record(`offer-og-${name}`, "/offers/offer-zero/og", status, [
        ["offers", "one", { ...offerZero, items: [{ id: 7 }, {}, { id: null }] }],
        ["pricev2", "one", null],
        ["offersubitems", "many", [{ subItems: [{ id: "other" }, {}] }]],
        ["items", "many", [{ id: 7 }, { id: "other" }, {}]],
        ["assets", "many", mixedAssets],
        ["builds", "many", builds],
      ], null, undefined, status === 200);
    }
    await record("offer-og-missing", "/offers/missing/og.webp", 404, [
      ["offers", "one", null],
    ]);

    // 2. Sandboxes OG
    const sandboxA = {
      _id: "ns-a",
      title: "Sandbox A",
      updated: new Date("2026-09-12T00:00:00Z"),
    };
    const sandboxExec = {
      _id: "ns-exec",
      displayName: "Display Sandbox",
      updatedAt: new Date("2026-08-01T00:00:00Z"),
    };
    const sandboxItems = [
      {
        id: "it-1",
        releaseInfo: [
          { appId: "art-direct", platform: ["Windows"] },
          { appId: "art-virtual", platform: ["Mac", "Linux"] },
        ],
      },
    ];
    await record(
      "sandbox-og-png-versioned",
      "/sandboxes/ns-a/og?v=1",
      200,
      [
        ["sandboxes", "one", sandboxA],
        ["offers", "count", 1234],
        ["items", "many", sandboxItems],
        ["assets", "many", [{ artifactId: "art-direct" }]],
        ["offers", "one", offerA],
      ],
      null,
      undefined,
      true,
    );
    await record(
      "sandbox-og-webp-prepurchase",
      "/sandboxes/ns-a/og.webp",
      200,
      [
        ["sandboxes", "one", sandboxA],
        ["offers", "count", 2],
        ["items", "many", []],
        ["assets", "many", []],
        ["offers", "one", null],
        ["offers", "one", offerFree],
      ],
      null,
      undefined,
      true,
    );
    await record(
      "sandbox-og-executable-fallback",
      "/sandboxes/ns-exec/og",
      200,
      [
        ["sandboxes", "one", sandboxExec],
        ["offers", "count", 0],
        ["items", "many", []],
        ["assets", "many", []],
        ["offers", "one", null],
        ["offers", "one", null],
        ["items", "one", { title: "Exec Item", publisherDisplayName: "Exec Pub" }],
      ],
      null,
      undefined,
      true,
    );
    await record("sandbox-og-missing", "/sandboxes/missing/og", 404, [
      ["sandboxes", "one", null],
    ]);

    // 3. Promotions
    const eventDoc = { id: "ev-1", name: "Winter Sale", groupName: "event", status: "ACTIVE", referenceCount: 5 };
    const frLoc = {
      entityId: "ns-a:offer-a",
      entityType: "offer",
      locale: "fr",
      source: "editor",
      fetchedAt: new Date("2026-11-01T00:00:00Z"),
      data: { title: "Offre Parite" },
    };
    await record("promotions-list", "/promotions", 200, [
      ["tags", "many", [eventDoc]],
    ]);
    await record("promotion-detail-card", "/promotions/ev-1?limit=5&page=1", 200, [
      ["tags", "one", eventDoc],
      ["offers", "aggregate", [offerA]],
      ["pricev2", "many", [priceUs]],
      ["offers", "count", 1],
    ]);
    await record(
      "promotion-detail-price-expand-fr",
      "/promotions/ev-1?sortBy=price&sortDir=asc&q=Parity&expand=true&locale=fr",
      200,
      [
        ["tags", "one", eventDoc],
        ["pricev2", "aggregate", [{ ...offerA, price: priceUs }]],
        ["egs_localizations", "many", [frLoc]],
        ["offers", "count", 1],
      ],
    );
    await record(
      "promotion-detail-cache-hit",
      "/promotions/ev-1",
      200,
      [],
      { elements: [], title: "Cached", start: 0, page: 1, count: 0 },
    );
    await record("promotion-detail-bad-country", "/promotions/ev-1?country=ZZ", 404);
    await record("promotion-detail-bad-locale", "/promotions/ev-1?locale=bad%20tag", 400);
    await record("promotion-detail-missing", "/promotions/missing", 404, [
      ["tags", "one", null],
    ]);
    await record("promotion-cover", "/promotions/ev-1/cover?locale=fr", 200, [
      ["offers", "many", [{ id: "offer-a", namespace: "ns-a" }]],
      ["offers", "one", offerA],
      ["egs_localizations", "many", [frLoc]],
    ]);
    await record(
      "promotion-cover-cache-hit",
      "/promotions/ev-1/cover",
      200,
      [],
      { id: "offer-a", title: "Cached Cover" },
    );
    await record("promotion-cover-missing", "/promotions/ev-1/cover", 404, [
      ["offers", "many", []],
      ["offers", "one", null],
    ]);
    const historicalNamespace = new ObjectId("0123456789abcdef01234567");
    await record("promotion-cover-typed-namespaces", "/promotions/ev-1/cover", 200, [
      ["offers", "many", [{ namespace: historicalNamespace }, { namespace: historicalNamespace.toHexString() }, {}, { namespace: null }]],
      ["offers", "one", { ...offerA, namespace: historicalNamespace }],
    ]);
    const malformedOffer = { ...offerA, customAttributes: [null] };
    await record("promotion-detail-malformed-card", "/promotions/ev-1", 500, [
      ["tags", "one", eventDoc], ["offers", "aggregate", [malformedOffer]], ["pricev2", "many", []],
    ]);

    // 4. Collections
    const collectionDoc = {
      _id: "top-sellers",
      name: "Top Sellers",
      updatedAt: new Date("2026-11-10T00:00:00Z"),
    };
    const gamePos = {
      offerId: "offer-a",
      position: 1,
      previous: 3,
      positions: [
        { position: 2, date: new Date("2025-07-29T00:00:00Z") },
        { position: 1, date: new Date("2025-07-31T00:00:00Z") },
      ],
    };
    for (const week of [false, true]) {
      await record(`collection-malformed-card-${week}`, `/collections/top-sellers${week ? "/2025W31" : ""}`, 500, [
        ["collections_v2", "one", collectionDoc],
        ...(week ? [] : [["game_positions", "count", 1] as Read]),
        ["game_positions", "many", [gamePos]], ["offers", "many", [malformedOffer]], ["pricev2", "many", [priceUs]],
      ]);
    }
    await record("collection-current-card", "/collections/top-sellers", 200, [
      ["collections_v2", "one", collectionDoc],
      ["game_positions", "count", 1],
      ["game_positions", "many", [gamePos]],
      ["offers", "many", [offerA]],
      ["pricev2", "many", [priceUs]],
    ]);
    await record(
      "collection-current-expand-fr",
      "/collections/top-sellers?expand=1&locale=fr",
      200,
      [
        ["collections_v2", "one", collectionDoc],
        ["game_positions", "count", 1],
        ["game_positions", "many", [gamePos]],
        ["offers", "many", [offerA]],
        ["pricev2", "many", [priceUs]],
        ["egs_localizations", "many", [frLoc]],
      ],
    );
    await record(
      "collection-current-cache-hit",
      "/collections/top-sellers",
      200,
      [],
      { elements: [], page: 1, limit: 10, title: "Cached", total: 0, updatedAt: "2026-11-10T00:00:00.000Z" },
    );
    await record("collection-current-missing", "/collections/missing", 404, [
      ["collections_v2", "one", null],
    ]);
    await record("collection-current-bad-country", "/collections/top-sellers?country=ZZ", 404);
    await record(
      "collection-week-card",
      "/collections/top-sellers/2025W31",
      200,
      [
        ["collections_v2", "one", collectionDoc],
        ["game_positions", "many", [gamePos, { offerId: "missing-offer", position: 2, positions: [{ position: 2, date: new Date("2025-07-30T00:00:00Z") }] }]],
        ["offers", "many", [offerA]],
        ["pricev2", "many", [priceUs]],
      ],
    );
    await record(
      "collection-week-expand-fr",
      "/collections/top-sellers/2025W31?expand=true&locale=fr",
      200,
      [
        ["collections_v2", "one", collectionDoc],
        ["game_positions", "many", [gamePos]],
        ["offers", "many", [offerA]],
        ["pricev2", "many", [priceUs]],
        ["egs_localizations", "many", [frLoc]],
      ],
    );
    await record(
      "collection-week-missing",
      "/collections/missing/2025W31",
      404,
      [["collections_v2", "one", null]],
    );
    await record(
      "collection-week-invalid",
      "/collections/top-sellers/not-a-week",
      500,
    );

    // 5. Game Awards
    const modulePopulated = {
      _id: "mod-1",
      eventSlug: "the-game-awards",
      title: "  Game of the Year  ",
      offers: [{ id: "offer-a", namespace: "ns-a" }],
    };
    const moduleEmpty = {
      _id: "mod-2",
      eventSlug: "the-game-awards",
      title: "Empty",
      offers: [],
    };
    await record("game-awards-card", "/game-awards", 200, [
      ["storefront-modules", "many", [modulePopulated, moduleEmpty]],
      ["offers", "many", [offerA]],
      ["pricev2", "many", [priceUs]],
    ]);
    await record(
      "game-awards-expand-fr",
      "/game-awards?expand=true&locale=fr&country=ES",
      200,
      [
        ["storefront-modules", "many", [modulePopulated]],
        ["offers", "many", [offerA]],
        ["pricev2", "many", [priceEs]],
        ["egs_localizations", "many", [frLoc]],
      ],
    );
    for (const [name, offers] of [
      ["missing", undefined], ["null", null], ["object", {}], ["null-member", [null]],
    ] as const) {
      await record(`game-awards-${name}-references`, "/game-awards", 500, [
        ["storefront-modules", "many", [{ title: "Historic", offers }]],
      ]);
    }
    for (const title of [null, 42]) {
      await record(`game-awards-invalid-title-${title}`, "/game-awards", 500, [
        ["storefront-modules", "many", [{ title, offers: [{ id: "offer-a" }] }]],
        ["offers", "many", [offerA]], ["pricev2", "many", []],
      ]);
    }
    for (const first of [true, false]) {
      const bad = { ...modulePopulated, title: null };
      await record(`game-awards-failed-sibling-${first}`, "/game-awards?locale=fr", 500, [
        ["storefront-modules", "many", first ? [bad, modulePopulated] : [modulePopulated, bad]],
        ["offers", "many", [offerA]], ["pricev2", "many", []], ["egs_localizations", "many", [frLoc]],
      ]);
    }
    for (const expand of [false, true]) {
      for (const [kind, customAttributes] of [
        ["null-entry", [null]], ["falsy", false],
        ["odd-keys", [{ key: 7, value: false }, { key: "__proto__", value: true }, { key: "absent-value" }]],
      ] as const) {
        await record(`game-awards-${kind}-attributes-${expand}`, `/game-awards?expand=${expand}`,
          !expand && kind === "null-entry" ? 500 : 200, [
            ["storefront-modules", "many", [modulePopulated]],
            ["offers", "many", [{ ...offerA, customAttributes }]], ["pricev2", "many", []],
          ]);
      }
      await record(`game-awards-localization-order-${expand}`, `/game-awards?locale=fr&expand=${expand}`, 200, [
        ["storefront-modules", "many", [modulePopulated, { title: "Unmatched", offers: [{ id: "missing" }] }]],
        ["offers", "many", [offerA]], ["pricev2", "many", []], ["egs_localizations", "many", [frLoc]],
      ]);
      const references = [{ id: 7 }, { id: "7" }, { id: null }, {}, { id: "" }, { id: 7 }, { id: { key: 1 } }];
      const offerDocs = [
        { ...offerA, id: 7, title: "First number" }, { ...offerA, id: null, title: "Null" },
        { ...offerA, id: undefined, title: "Absent" }, { ...offerA, id: "", title: "Empty" },
        { ...offerA, id: "7", title: "Text" }, { ...offerA, id: 7, title: "Last number" },
        { ...offerA, id: { key: 1 }, title: "Object" },
      ];
      const priceDocs = [
        { ...priceUs, offerId: 7 }, { ...priceZero, offerId: 7 },
        { ...priceUs, offerId: null }, { ...priceEs, offerId: undefined },
      ];
      await record(`game-awards-typed-joins-${expand}`, `/game-awards?expand=${expand}`, 200, [
        ["storefront-modules", "many", [{ title: "\uFEFF Game \uFEFF", offers: references }]],
        ["offers", "many", offerDocs], ["pricev2", "many", priceDocs],
      ]);
    }
    await record("game-awards-bad-country", "/game-awards?country=ZZ", 404);
    await record("game-awards-og", "/game-awards/og", 200, [], null, undefined, true);
    await record(
      "game-awards-og-versioned",
      "/game-awards/og?v=2",
      200,
      [],
      null,
      undefined,
      true,
    );

    assertOracle("legacy-og-editorial-http-node", cases);
  });
});
