import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { BSON, BSONSymbol, Decimal128, Double, Long, ObjectId } from "mongodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertOracle,
  captureResponse,
  fixtureValue,
} from "../rust/oracles/record.js";
import { responseEtag } from "../src/middlewares/response-etag.js";
import { ProblemError, problemResponse } from "../src/v1/errors.js";
import type { V1Variables } from "../src/v1/request-context.js";
import { v1CachePolicy, v1Context } from "../src/v1/request-context.js";
import OgRoute from "../src/v1/routes/og.js";

const mocks = vi.hoisted(() => ({
  collection: vi.fn(),
  offerFindOne: vi.fn(),
  offerCount: vi.fn(),
  itemFind: vi.fn(),
  itemFindOne: vi.fn(),
  assetFind: vi.fn(),
  priceFindOne: vi.fn(),
  cover: vi.fn(),
  renderOfferOg: vi.fn(),
  renderDatabaseOg: vi.fn(),
}));
vi.mock("../src/db/index.js", () => ({
  db: { db: { collection: mocks.collection } },
}));
vi.mock("../src/clients/response-cache.js", () => ({
  default: { get: async () => null, set: async () => "OK" },
}));
vi.mock("../src/models/index.js", () => ({
  Offer: { findOne: mocks.offerFindOne, countDocuments: mocks.offerCount },
  Item: { find: mocks.itemFind, findOne: mocks.itemFindOne },
  Asset: { find: mocks.assetFind },
  PriceEngine: { findOne: mocks.priceFindOne },
}));
vi.mock("../src/utils/offer-og.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/offer-og.js")>()),
  renderOfferOg: mocks.renderOfferOg,
}));
vi.mock("../src/utils/database-og.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/database-og.js")>()),
  fetchOgCover: mocks.cover,
  renderDatabaseOg: mocks.renderDatabaseOg,
}));

const query = (rows: unknown[]) => ({ lean: vi.fn(async () => rows) });
const app = new Hono<{ Variables: V1Variables }>();
app.use("*", async (c, next) => {
  c.set("requestId", "req_node_oracle");
  await next();
});
app.route("/v1", OgRoute);
app.onError((error, c) => {
  if (error instanceof ProblemError) return problemResponse(c, error);
  throw error;
});
const offer = {
  _id: "mongo-offer-a",
  id: "offer-a",
  namespace: "ns-a",
  title: "Parity Game",
  offerType: "BASE_GAME",
  publisherDisplayName: "Parity Studio",
  lastModifiedDate: new Date("2026-10-01T00:00:00Z"),
  releaseDate: new Date("2026-10-10T00:00:00Z"),
  keyImages: [],
  items: [],
  seller: { name: "Seller" },
};
const sandbox = {
  _id: "sandbox-a",
  title: "Parity Sandbox",
  updated: new Date("2026-10-02T00:00:00Z"),
};
type MongoFilter = { id?: string; _id?: { $eq?: string } };
const bytes = {
  png: Uint8Array.from([137, 80, 78, 71]),
  webp: Uint8Array.from([82, 73, 70, 70]),
};

describe("registered OpenGraph Node HTTP oracle", () => {
  afterEach(() => vi.clearAllMocks());
  it("records all seven registered OpenGraph operations", async () => {
    const rendered: Record<string, unknown> = {};
    mocks.collection.mockImplementation((name: string) => ({
      findOne: async (filter: MongoFilter) =>
        name === "sandboxes" && filter._id?.$eq === "sandbox-a"
          ? sandbox
          : null,
      find: () => ({
        sort() {
          return this;
        },
        limit() {
          return this;
        },
        next: async () => null,
        toArray: async () => [],
      }),
    }));
    mocks.offerFindOne.mockImplementation((filter: MongoFilter) => ({
      lean: async () => (filter.id === "offer-a" ? offer : null),
    }));
    mocks.offerCount.mockResolvedValue(0);
    mocks.itemFind.mockReturnValue(query([]));
    mocks.itemFindOne.mockReturnValue({ lean: async () => null });
    mocks.assetFind.mockReturnValue(query([]));
    mocks.priceFindOne.mockReturnValue({ lean: async () => null });
    mocks.renderOfferOg.mockImplementation(
      async (card: unknown, format: "png" | "webp", cover?: Uint8Array) => {
        rendered[`offer-${format}`] = { card, coverLength: cover?.length ?? 0 };
        return bytes[format];
      },
    );
    mocks.renderDatabaseOg.mockImplementation(
      async (card: unknown, format: "png" | "webp", cover?: Uint8Array) => {
        rendered[`sandbox-${format}`] = {
          card,
          coverLength: cover?.length ?? 0,
        };
        return bytes[format];
      },
    );
    const cases: Array<{
      name: string;
      request: { method: string; path: string };
      input: { source: unknown; renderer?: unknown };
      response: Awaited<ReturnType<typeof captureResponse>>;
    }> = [];
    const add = async (
      name: string,
      path: string,
      input: unknown,
      captureRender?: string,
    ) => {
      const response = await captureResponse(await app.request(`/v1${path}`));
      cases.push({
        name,
        request: { method: "GET", path: `/v1${path}` },
        input: {
          source: input,
          ...(captureRender ? { renderer: rendered[captureRender] } : {}),
        },
        response,
      });
    };
    await add(
      "offer-og-png-success",
      "/offers/offer-a/og?country=US",
      { offer, price: null, subItems: [], items: [], assets: [], build: null },
      "offer-png",
    );
    await add(
      "offer-og-webp-success",
      "/offers/offer-a/og.webp?country=US",
      { offer, price: null, subItems: [], items: [], assets: [], build: null },
      "offer-webp",
    );
    await add("offer-og-missing", "/offers/missing/og", { offer: null });
    await add(
      "sandbox-og-png-success",
      "/sandboxes/sandbox-a/og",
      { sandbox, offers: 0, items: [], assets: [], identity: null },
      "sandbox-png",
    );
    await add(
      "sandbox-og-webp-success",
      "/sandboxes/sandbox-a/og.webp",
      { sandbox, offers: 0, items: [], assets: [], identity: null },
      "sandbox-webp",
    );
    await add("sandbox-og-missing", "/sandboxes/missing/og", { sandbox: null });
    await add("free-games-og-redirect", "/free-games/og?country=ES", {});
    await add("game-awards-og-redirect", "/game-awards/og", {});
    await add(
      "collections-og-redirect-escaped-slug",
      "/collections/top%20sellers/2025-W01/og?v=2",
      {},
    );
    assertOracle("og-http-node", cases);
    expect(cases.map((entry) => entry.response.status)).toEqual([
      200, 200, 404, 200, 200, 404, 302, 302, 302,
    ]);
  });
});

it("records OG GET, HEAD, conditional images, failures and escaped redirects through v1 middleware", async () => {
  type Row = Record<string, unknown>;
  type Seed = {
    offer?: Row;
    sandbox?: Row;
    price?: Row;
    subItems?: Row[];
    items?: Row[];
    assets?: Row[];
    builds?: Row[];
    failure?: string;
  };
  let seed: Seed = {};
  const from = <T>(group: string, value: T): T => {
    if (seed.failure === group) throw Error("test dependency unavailable");
    return value;
  };
  mocks.collection.mockImplementation((name: string) => ({
    findOne: async () => from(name, seed.sandbox ?? null),
    find: () => ({
      sort() {
        return this;
      },
      limit() {
        return this;
      },
      next: async () => from(name, seed.builds?.[0] ?? null),
      toArray: async () => from(name, seed.subItems ?? []),
    }),
  }));
  mocks.offerFindOne.mockImplementation((filter: Record<string, unknown>) => ({
    lean: async () =>
      from(
        filter.prePurchase === true && seed.failure === "prepurchase"
          ? "prepurchase"
          : "offers",
        filter.id ||
          (filter.prePurchase === true) === (seed.offer?.prePurchase === true)
          ? (seed.offer ?? null)
          : null,
      ),
  }));
  mocks.offerCount.mockImplementation(async () =>
    from("offers", seed.offer ? 1 : 0),
  );
  mocks.itemFind.mockImplementation(() => ({
    lean: async () => from("items", seed.items ?? []),
  }));
  mocks.itemFindOne.mockImplementation(() => ({
    lean: async () =>
      from(
        seed.failure === "identity" ? "identity" : "items",
        seed.items?.find((r) => r.entitlementType === "EXECUTABLE") ?? null,
      ),
  }));
  mocks.priceFindOne.mockImplementation(() => ({
    lean: async () => from("pricev2", seed.price ?? null),
  }));
  mocks.assetFind.mockImplementation(() => ({
    lean: async () => from("assets", seed.assets ?? []),
  }));
  let cover: unknown;
  mocks.cover.mockImplementation(async (url: unknown) => {
    cover = url ? String(url) : null;
  });
  const { databaseOgTree } = await vi.importActual<
    typeof import("../src/utils/database-og.js")
  >("../src/utils/database-og.js");
  const { offerOgTree } = await vi.importActual<
    typeof import("../src/utils/offer-og.js")
  >("../src/utils/offer-og.js");
  const { Renderer } = await import("@takumi-rs/core");
  let card: unknown;
  const image = (kind: string, format: "png" | "webp") =>
    from(
      "render",
      readFileSync(
        new URL(
          `../rust/crates/egdata-api/tests/fixtures/og-rust-${kind}.${format}`,
          import.meta.url,
        ),
      ),
    );
  mocks.renderOfferOg.mockImplementation(
    async (data: Parameters<typeof offerOgTree>[0], format: "png" | "webp") => {
      const tree = offerOgTree(data, false);
      if (typeof data.title !== "string")
        await new Renderer().render(tree, { format, width: 1200, height: 630 });
      card = data;
      return image("offer", format);
    },
  );
  mocks.renderDatabaseOg.mockImplementation(
    async (
      data: Parameters<typeof databaseOgTree>[0],
      format: "png" | "webp",
    ) => {
      const tree = databaseOgTree(data, false);
      if (typeof data.title !== "string")
        await new Renderer().render(tree, { format, width: 1200, height: 630 });
      card = data;
      return image("sandbox", format);
    },
  );
  const full = new Hono<{ Variables: V1Variables }>();
  full.use("*", v1Context(), responseEtag, v1CachePolicy());
  full.route("/v1", OgRoute);
  full.onError((e, c) =>
    problemResponse(
      c,
      e instanceof ProblemError
        ? e
        : new ProblemError({
            status: 500,
            code: "INTERNAL_ERROR",
            detail:
              "The API could not complete the request. Retry later and include the request ID when contacting support.",
          }),
    ),
  );
  const cases: unknown[] = [];
  const run = async (
    name: string,
    path: string,
    source: Seed = {},
    method = "GET",
    headers: Record<string, string> = {},
  ) => {
    // Distinct reads materialize independent BSON values, including ObjectIds and native numeric types.
    seed = BSON.deserialize(BSON.serialize(source)) as Seed;
    card = undefined;
    cover = null;
    const req = { method, path: `/v1${path}`, headers };
    const response = await captureResponse(
      await full.request(req.path, {
        method,
        headers: {
          "x-egdata-key-id": "key_oracle",
          "x-egdata-key-tier": "free",
          "x-request-id": "req_node_oracle",
          ...headers,
        },
      }),
    );
    cases.push({
      name,
      request: req,
      source: fixtureValue(source),
      card,
      cover,
      response,
    });
    return response;
  };
  for (const [kind, prefix, source] of [
    ["offer", "/offers/offer-a", { offer }],
    ["sandbox", "/sandboxes/sandbox-a", { sandbox }],
  ] as const) {
    for (const ext of ["", ".webp"]) {
      const path = `${prefix}/og${ext}`;
      const fresh = await run(`${kind + ext}-get`, path, source);
      expect(fresh.body.byteLength).toBeGreaterThan(1000);
      const etag = fresh.headers.etag;
      expect(etag).toBeTruthy();
      await run(`${kind + ext}-head`, path, source, "HEAD");
      await run(`${kind + ext}-conditional`, path, source, "GET", {
        "if-none-match": etag,
      });
      await run(`${kind + ext}-conditional-head`, path, source, "HEAD", {
        "if-none-match": etag,
      });
      await run(`${kind + ext}-stale`, path, source, "GET", {
        "if-none-match": '"different"',
      });
      await run(`${kind + ext}-render-error`, path, {
        ...source,
        failure: "render",
      });
      await run(`${kind + ext}-missing`, path);
    }
  }
  const path = "/offers/offer-a/og";
  const item = { id: "item" },
    asset = {
      itemId: "item",
      artifactId: "app",
      platform: "Windows",
      downloadSizeBytes: 500,
    },
    build = { _id: "b", appName: "app", labelName: "Live-Windows" };
  const related = {
    offer: { ...offer, items: [item] },
    items: [item],
    subItems: [{ subItems: [{ id: "part" }] }],
    assets: [asset],
    builds: [build],
  };
  await run(
    "offer-unknown-and-repeated-country",
    `${path}?extra=x&country=JP&country=bad`,
    related,
  );
  await run("offer-without-country", `${path}?q=x`, related);
  await run("offer-invalid-country", `${path}?country=ZZZ`, related);
  await run("offer-excluded-price", path, {
    ...related,
    offer: { ...offer, countriesBlacklist: ["US"] },
    failure: "pricev2",
  });
  await run("offer-card-all-fields", path, {
    ...related,
    offer: {
      ...related.offer,
      title: "Games & More",
      lastModifiedDate: "2025-12-31T05:00:00Z",
    },
    price: { price: { discountPrice: 1234, currencyCode: "EUR" } },
  });
  await run("sandbox-prepurchase-fallback", "/sandboxes/sandbox-a/og", {
    sandbox,
    offer: { ...offer, prePurchase: true },
  });
  await run("sandbox-item-identity", "/sandboxes/sandbox-a/og", {
    sandbox,
    items: [
      {
        entitlementType: "EXECUTABLE",
        title: "Item title",
        releaseInfo: [{ appId: "App", platform: ["Windows", "Mac"] }],
      },
    ],
  });
  for (const [label, more] of Object.entries({
    badSubItemDoc: { subItems: [{}] },
    nullSubItem: { subItems: [{ subItems: [null] }] },
    missingSubItemID: { subItems: [{ subItems: [{}] }] },
    missingLabel: { builds: [{ _id: "b", appName: "app" }] },
    untitledType: {
      offer: { ...offer, offerType: "", publisherDisplayName: "" },
    },
    unmatchedPlatform: { builds: [{ ...build, labelName: "Live-Linux" }] },
  })) {
    await run(`offer-${label}`, path, { ...related, ...more });
  }
  await run("sandbox-failed-prepurchase", "/sandboxes/sandbox-a/og", {
    sandbox,
    failure: "prepurchase",
  });
  await run("sandbox-failed-item", "/sandboxes/sandbox-a/og.webp", {
    sandbox,
    failure: "identity",
  });
  await run("sandbox-display-name", "/sandboxes/sandbox-a/og", {
    sandbox: { _id: "sandbox-a", displayName: "Display name" },
    items: [{ releaseInfo: [{}, { appId: "known", platform: ["Mac"] }] }],
    assets: [{ artifactId: "known" }],
  });
  await run("sandbox-seller-name", "/sandboxes/sandbox-a/og", {
    sandbox,
    offer: { ...offer, publisherDisplayName: null },
  });
  await run("offer-build-lacks-id", path, {
    ...related,
    builds: [{ appName: "app", labelName: "Live-Windows" }],
  });
  await run("offer-build-supplies-platform", path, {
    ...related,
    builds: [{ _id: "build", appName: "app", platform: "Windows" }],
  });
  await run("offer-invalid-currency", path, {
    ...related,
    price: { price: { discountPrice: 100, currencyCode: "?" } },
  });
  await run("offer-empty-platform", path, {
    ...related,
    builds: [{ ...build, platform: "" }],
  });
  for (const [name, platform] of [
    ["number", 7],
    ["false", false],
    ["array", []],
  ] as const) {
    await run(`offer-historical-platform-${name}`, path, {
      ...related,
      assets: [{ ...asset, artifactId: 10, platform }],
      // The separate Mongo reads give each document its own nested objects.
      builds: [{ ...build, appName: 10, platform: structuredClone(platform) }],
    });
  }
  await run("offer-historical-currency", path, {
    ...related,
    price: { price: { discountPrice: 1250, currencyCode: "IQD" } },
  });
  for (const failure of [
    "offers",
    "pricev2",
    "offersubitems",
    "items",
    "assets",
    "builds",
  ]) {
    await run(`offer-failure-${failure}`, path, { ...related, failure });
  }
  for (const failure of ["sandboxes", "items", "assets", "offers"]) {
    await run(`sandbox-failure-${failure}`, "/sandboxes/sandbox-a/og.webp", {
      sandbox,
      failure,
    });
  }
  for (const redirect of [
    "/collections/a%2Fb!()*%27/2025%20W4/og?x=1&x=2",
    "/game-awards/og?x=%2F&emoji=%F0%9F%8E%AE",
    "/free-games/og?",
  ]) {
    await run(`redirect-${redirect}`, redirect);
    await run(`redirect-head-${redirect}`, redirect, {}, "HEAD");
  }
  const sandboxPath = "/sandboxes/sandbox-a/og.webp";
  const placeholder = "http://127.0.0.1:9/fixture-cover";
  for (const [label, keyImages] of Object.entries({
    empty: [],
    null: null,
    scalar: "broken",
    object: {},
    badEntry: [null],
    missingUrl: [{ type: "Featured" }, { url: placeholder }],
    noType: [{ url: placeholder }],
    first: [
      { type: "old", url: placeholder },
      { type: "old", url: `${placeholder}/second` },
    ],
    firstWins: [
      { type: "DieselGameBoxTall", url: `${placeholder}/first` },
      null,
    ],
    nullBefore: [null, { type: "DieselGameBoxTall", url: placeholder }],
    arrayUrl: [{ type: "DieselGameBoxTall", url: [placeholder] }],
    blank: [{ type: "Featured", url: "" }],
  })) {
    await run(`offer image ${label}`, path, { offer: { ...offer, keyImages } });
    await run(`sandbox image ${label}`, sandboxPath, {
      sandbox,
      offer: { ...offer, keyImages },
    });
  }
  for (const [label, fields] of Object.entries({
    boolType: { offerType: false },
    numeric: { offerType: 7, publisherDisplayName: 22 },
    unicode: { offerType: "ÉDITION_Ç" },
    list: { offerType: ["GAME", "PACK"], publisherDisplayName: ["A", "B"] },
    falsePublisher: { publisherDisplayName: false },
    objectPublisher: { publisherDisplayName: { name: "Ignored" } },
    numericTitle: { title: 55 },
    arrayTitle: { title: ["A"] },
    typedFallback: { publisherDisplayName: null, seller: { name: 7 } },
    brokenWhitelist: { countriesWhitelist: ["US", 7] },
    scalarBlacklist: { countriesBlacklist: "US" },
  })) {
    await run(`offer fields ${label}`, path, {
      offer: { ...offer, ...fields },
    });
    await run(`sandbox fields ${label}`, sandboxPath, {
      sandbox,
      offer: { ...offer, ...fields },
    });
  }
  const objectId = new ObjectId("507f1f77bcf86cd799439011");
  for (const [label, fields] of Object.entries({
    decimal: {
      discountPrice: Decimal128.fromString("349.8"),
      currencyCode: "USD",
    },
    smallLong: { discountPrice: Long.fromNumber(350), currencyCode: "JPY" },
    bigLong: {
      discountPrice: Long.fromString("9007199254740999"),
      currencyCode: "USD",
    },
    fractional: { discountPrice: new Double(349.8), currencyCode: "USD" },
    string: { discountPrice: "349.8", currencyCode: "EUR" },
    exponent: { discountPrice: new Double(1.25e22), currencyCode: "usd" },
    invalidZero: { discountPrice: 0, currencyCode: 123 },
    typedCurrency: { currencyCode: Decimal128.fromString("2.5") },
    arrayCurrency: { currencyCode: ["eur"], discountPrice: 150 },
  }))
    await run(`stored money ${label}`, path, {
      offer,
      price: { price: fields },
    });
  for (const [label, releases, assets] of [
    ["numeric", [{ appId: 7, platform: ["x", "y"] }], [{ artifactId: "7" }]],
    [
      "numeric-known",
      [{ appId: 7, platform: ["x", "y"] }],
      [{ artifactId: 7 }],
    ],
    [
      "oid-virtual",
      [{ appId: objectId, platform: ["x", "y"] }],
      [{ artifactId: objectId }],
    ],
    ["string-platform", [{ appId: "virtual", platform: "🎮win" }], []],
    ["no-length", [{ appId: "virtual", platform: 4 }], []],
    ["length-number", [{ appId: "virtual", platform: { length: 3 } }], []],
    ["length-string", [{ appId: "virtual", platform: { length: "3" } }], []],
    ["bad-release", [null], []],
    ["map-not-array", { one: 1 }, []],
  ] as const)
    await run(`sandbox assets ${label}`, sandboxPath, {
      sandbox,
      items: [{ releaseInfo: releases }],
      assets: [...assets],
    });
  for (const [label, length] of Object.entries({
    fractional: 1234.5679,
    negative: -4321.11,
    infinite: Infinity,
    negativeInfinity: -Infinity,
    nan: NaN,
  }))
    await run(`sandbox numeric length ${label}`, sandboxPath, {
      sandbox,
      items: [
        {
          releaseInfo: [
            { appId: "virtual", platform: { length: new Double(length) } },
          ],
        },
      ],
    });
  for (const sandboxId of ["ns/space", "ns+extra", "部署"]) {
    await run(
      `escaped namespace ${sandboxId}`,
      `/sandboxes/${encodeURIComponent(sandboxId)}/og.webp`,
      {
        sandbox: { _id: sandboxId, displayName: `Fallback ${sandboxId}` },
        items: [{ id: 7, releaseInfo: [] }],
        assets: [{ artifactId: 7 }],
      },
    );
  }
  for (const title of [55, false, ["x"]])
    await run(`typed namespace title ${JSON.stringify(title)}`, sandboxPath, {
      sandbox: { ...sandbox, title, displayName: "Fallback" },
    });
  await run("offer string date and primitive image", path, {
    offer: {
      ...offer,
      lastModifiedDate: "2025-05-03",
      releaseDate: new BSONSymbol("2026-07-11"),
      keyImages: [7],
    },
  });
  await run("sandbox legacy boolean count", sandboxPath, {
    sandbox,
    items: [
      {},
      { releaseInfo: [{ appId: "untracked", platform: { length: true } }] },
    ],
  });
  for (const items of [null, [{ id: objectId }], [null], "invalid"]) {
    await run(`stored direct offer items ${JSON.stringify(items)}`, path, {
      offer: { ...offer, items },
    });
  }
  await run("asset selection across boolean and native timestamps", path, {
    ...related,
    builds: [],
    assets: [
      { ...asset, updatedAt: true, downloadSizeBytes: 1000000000 },
      {
        ...asset,
        updatedAt: new Date("2025-05-01"),
        downloadSizeBytes: 2000000000,
      },
    ],
  });
  await run("NaN asset platform never matches build", path, {
    ...related,
    assets: [{ ...asset, platform: new Double(NaN) }],
    builds: [{ ...build, platform: new Double(NaN) }],
  });
  await run("offer artifact object identity", path, {
    ...related,
    assets: [{ ...asset, artifactId: objectId }],
    builds: [{ ...build, appName: objectId }],
  });
  await run("offer artifact string identity", path, {
    ...related,
    assets: [{ ...asset, artifactId: objectId.toHexString() }],
    builds: [{ ...build, appName: objectId }],
  });
  await run("offer platform object identity", path, {
    ...related,
    assets: [{ ...asset, platform: objectId }],
    builds: [{ ...build, platform: objectId }],
  });
  for (const raw of [
    "/free-games/og?text='quoted'&v=1+2",
    "/collections/a%252Fb/w%3Fx/og?x=%25%2f",
    "/game-awards/og?abc=%ff&&x",
  ])
    await run(`redirect query ${raw}`, raw);
  assertOracle("og-http-cache-node", cases);
});
