import { Hono } from "hono";
import { BSON, BSONSymbol, Decimal128, ObjectId } from "mongodb";
import { responseEtag } from "../src/middlewares/response-etag.js";
import { v1CachePolicy, v1Context } from "../src/v1/request-context.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertOracle, captureResponse, fixtureValue } from "../rust/oracles/record.js";
import { ProblemError, problemResponse } from "../src/v1/errors.js";
import { encodeCursor } from "../src/v1/cursor.js";
import type { V1Variables } from "../src/v1/request-context.js";
import ItemsRoute from "../src/v1/routes/items.js";
import SandboxesRoute from "../src/v1/routes/sandboxes.js";

const mocks = vi.hoisted(() => ({
  itemFindOne: vi.fn(),
  itemFind: vi.fn(),
  itemCount: vi.fn(),
  offerFind: vi.fn(),
  offerFindOne: vi.fn(),
  offerCount: vi.fn(),
  priceFindOne: vi.fn(),
  priceFind: vi.fn(),
  assetFind: vi.fn(),
  assetFindOne: vi.fn(),
  buildFind: vi.fn(),
  sandboxFindOne: vi.fn(),
  sandboxFind: vi.fn(),
  namespaceFindOne: vi.fn(),
  namespaceFind: vi.fn(),
  achievementFind: vi.fn(),
  collection: vi.fn(),
  countDocuments: vi.fn(),
  aggregate: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}));
vi.mock("../src/db/index.js", () => ({
  db: { db: { collection: mocks.collection } },
}));
vi.mock("../src/clients/response-cache.js", () => ({
  default: { get: mocks.cacheGet, set: mocks.cacheSet },
}));
vi.mock("../src/models/index.js", () => ({
  Item: {
    findOne: mocks.itemFindOne,
    find: mocks.itemFind,
    countDocuments: mocks.itemCount,
  },
  Offer: {
    find: mocks.offerFind,
    findOne: mocks.offerFindOne,
    countDocuments: mocks.offerCount,
  },
  Asset: { find: mocks.assetFind, findOne: mocks.assetFindOne },
  Build: { find: mocks.buildFind, countDocuments: mocks.countDocuments },
  PriceEngine: { find: mocks.priceFind, findOne: mocks.priceFindOne },
  Sandbox: { findOne: mocks.sandboxFindOne },
  Namespace: {
    findOne: mocks.namespaceFindOne,
    find: mocks.namespaceFind,
    countDocuments: mocks.countDocuments,
  },
  AchievementSet: { find: mocks.achievementFind },
}));

const query = (rows: readonly unknown[]) => ({ lean: vi.fn(async () => rows) });
const appFor = (
  route: Hono<{ Variables: V1Variables }>,
  middleware = false,
) => {
  const app = new Hono<{ Variables: V1Variables }>();
  if (middleware) {
    app.use("*", v1Context());
    app.use("*", responseEtag);
    app.use("*", v1CachePolicy());
  } else
    app.use("*", async (c, next) => {
      c.set("requestId", "req_node_oracle");
      await next();
    });
  app.route("/v1", route);
  app.onError((error, c) => {
    if (error instanceof ProblemError) return problemResponse(c, error);
    return problemResponse(
      c,
      new ProblemError({
        status: 500,
        code: "INTERNAL_ERROR",
        detail:
          "The API could not complete the request. Retry later and include the request ID when contacting support.",
      }),
    );
  });
  return app;
};
const itemApp = appFor(ItemsRoute);
const fullItemApp = appFor(ItemsRoute, true);
const sandboxApp = appFor(SandboxesRoute);
const capture = async (app: ReturnType<typeof appFor>, path: string) =>
  captureResponse(await app.request(path));
const item = (id: string) => ({
  _id: `mongo-${id}`,
  id,
  title: `Item ${id}`,
  namespace: "ns",
  lastModifiedDate: new Date("2026-10-01T00:00:00Z"),
  keyImages: [],
  tags: [],
  items: [],
});
const trace = () => ({
  itemFindOne: mocks.itemFindOne.mock.calls,
  itemFind: mocks.itemFind.mock.calls.map(([filter, ...options]) => [
    BSON.deserialize(BSON.serialize(filter, { ignoreUndefined: false })), ...options,
  ]),
  offerFind: mocks.offerFind.mock.calls,
  assetFind: mocks.assetFind.mock.calls,
  sandboxFindOne: mocks.sandboxFindOne.mock.calls,
  namespaceFindOne: mocks.namespaceFindOne.mock.calls,
  namespaceFind: mocks.namespaceFind.mock.calls,
});

describe("registered catalog reads Node HTTP oracle", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });
  it("records item and sandbox read responses and Mongo query recipes", async () => {
    mocks.cacheGet.mockResolvedValue(null);
    mocks.cacheSet.mockResolvedValue("OK");
    mocks.collection.mockImplementation((name: string) => ({
      find: () => ({
        sort() {
          return this;
        },
        limit() {
          return this;
        },
        toArray: async () => [],
      }),
      aggregate: () => ({ toArray: async () => [] }),
      countDocuments: async () => 0,
    }));
    mocks.offerFind.mockReturnValue(query([]));
    mocks.offerFindOne.mockReturnValue({ lean: async () => null });
    mocks.assetFindOne.mockReturnValue({ lean: async () => null });
    mocks.priceFindOne.mockReturnValue({ lean: async () => null });
    mocks.achievementFind.mockReturnValue(query([]));
    mocks.countDocuments.mockResolvedValue(0);
    mocks.offerCount.mockResolvedValue(0);
    mocks.itemCount.mockResolvedValue(0);
    const cases: {
      name: string;
      request: { method: string; path: string };
      input: Record<string, unknown>;
      response: Awaited<ReturnType<typeof captureResponse>>;
    }[] = [];
    const add = async (
      name: string,
      app: ReturnType<typeof appFor>,
      path: string,
      input: Record<string, unknown>,
      init: RequestInit = {},
    ) => {
      vi.clearAllMocks();
      mocks.itemCount.mockResolvedValue(
        Array.isArray(input.items) ? input.items.length : input.item ? 1 : 0,
      );
      mocks.offerCount.mockResolvedValue(
        Array.isArray(input.offers) ? input.offers.length : input.offer ? 1 : 0,
      );
      mocks.cacheGet.mockResolvedValue(
        Object.hasOwn(input, "cachePayload")
          ? JSON.stringify(input.cachePayload)
          : null,
      );
      mocks.cacheSet.mockResolvedValue("OK");
      const requestInit = input.interruptedBody
        ? {
            ...init,
            duplex: "half",
            body: new ReadableStream({
              start(controller) {
                controller.error(new Error("request body interrupted"));
              },
            }),
          }
        : init;
      const response = await captureResponse(
        await (input.middleware ? fullItemApp : app).request(
          path,
          input.middleware
            ? {
                ...requestInit,
                headers: {
                  "x-egdata-key-id": "key_oracle",
                  "x-egdata-key-tier": "free",
                  "x-request-id": "req_node_oracle",
                  ...Object.fromEntries(new Headers(requestInit.headers)),
                  ...(input.ifNoneMatch
                    ? { "if-none-match": String(input.ifNoneMatch) }
                    : {}),
                },
              }
            : requestInit,
        ),
      );
      cases.push({
        name,
        request: {
          method: init.method ?? "GET",
          path,
          ...(input.rawBody !== undefined
            ? { rawBody: String(input.rawBody) }
            : init.body
              ? { body: JSON.parse(String(init.body)) }
              : {}),
          ...(Object.hasOwn(input, "contentType")
            ? { contentType: input.contentType }
            : {}),
        },
        input: {
          ...input,
          queries: trace(),
          ...(input.captureAssetQueries ? { assetQueries: mocks.assetFindOne.mock.calls.map(([filter]) => filter) } : {}),
          ...(input.capturePriceQueries ? { priceQueries: mocks.priceFindOne.mock.calls.map(([filter, , options]) => ({ filter, sort: options.sort })) } : {}),
          ...(Object.hasOwn(input, "cachePayload")
            ? { cacheKey: mocks.cacheGet.mock.calls[0]?.[0] }
            : {}),
          ...(name.startsWith("item-wave-")
            ? {
                cacheWrite: mocks.cacheSet.mock.calls.length
                  ? [
                      mocks.cacheSet.mock.calls[0][0],
                      JSON.parse(mocks.cacheSet.mock.calls[0][1]),
                      mocks.cacheSet.mock.calls[0][3],
                    ]
                  : null,
              }
            : {}),
        },
        response,
      });
    };

    mocks.itemFindOne.mockImplementation((filter: any) => ({
      lean: async () => {
        const id = filter.$or?.[0]?._id?.$eq ?? filter.id?.$eq;
        if (id === "item-missing") return null;
        return id ? item(id) : null;
      },
    }));
    await add("item-detail-populated", itemApp, "/v1/items/item-a", {
      item: item("item-a"),
    });
    await add("item-detail-missing", itemApp, "/v1/items/item-missing", {
      item: null,
    });
    mocks.assetFind.mockImplementation((filter: { itemId: string }) =>
      query(
        filter.itemId === "item-a"
          ? [
              {
                _id: "asset-a",
                itemId: "item-a",
                artifactId: "app-a",
                platform: "Windows",
                sizeBytes: 16167389303,
              },
            ]
          : [],
      ),
    );
    await add("item-assets-populated", itemApp, "/v1/items/item-a/assets", {
      assets: [
        {
          _id: "asset-a",
          itemId: "item-a",
          artifactId: "app-a",
          platform: "Windows",
          sizeBytes: 16167389303,
        },
      ],
      bsonTypes: { sizeBytes: "double" },
    });
    await add("item-assets-empty", itemApp, "/v1/items/item-empty/assets", {
      assets: [],
    });

    mocks.itemFind.mockReturnValue(query([item("list-item")]));
    await add("items-list-populated", itemApp, "/v1/items?limit=5", {
      items: [item("list-item")],
    });
    mocks.itemFind.mockReturnValue(query([]));
    await add("items-list-empty", itemApp, "/v1/items", { items: [] });
    mocks.itemFind.mockReturnValue(query([item("bulk-item")]));
    await add(
      "items-bulk-populated",
      itemApp,
      "/v1/items/bulk",
      { items: [item("bulk-item")] },
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: ["bulk-item", "missing-item"] }),
      },
    );
    await add("item-builds-empty", itemApp, "/v1/items/build-empty/builds", {
      item: { ...item("build-empty"), releaseInfo: [] },
      builds: [],
    });
    await add(
      "item-changelog-empty",
      itemApp,
      "/v1/items/changelog-empty/changelog",
      { item: item("changelog-empty"), assets: [], builds: [], changelogs: [] },
    );

    mocks.namespaceFind.mockReturnValue(
      query([{ _id: "namespace-a", title: "Namespace A" }]),
    );
    await add("sandboxes-list-populated", sandboxApp, "/v1/sandboxes?limit=5", {
      namespaces: [{ _id: "namespace-a", title: "Namespace A" }],
    });
    mocks.namespaceFind.mockReturnValue(query([]));
    await add("sandboxes-list-empty", sandboxApp, "/v1/sandboxes", {
      namespaces: [],
    });

    mocks.sandboxFindOne.mockImplementation(
      (filter: { _id: { $eq: string } }) => ({
        lean: async () =>
          filter._id?.$eq === "sandbox-a"
            ? { _id: "sandbox-a", name: "Sandbox A", namespace: "namespace-a" }
            : null,
      }),
    );
    mocks.namespaceFindOne.mockImplementation(
      (filter: { _id: { $eq: string } }) => ({
        lean: async () =>
          filter._id?.$eq === "namespace-a" ||
          filter._id?.$eq === "namespace-only"
            ? { _id: filter._id.$eq, title: "Namespace A" }
            : null,
      }),
    );
    await add(
      "sandbox-detail-populated",
      sandboxApp,
      "/v1/sandboxes/sandbox-a",
      {
        sandbox: {
          _id: "sandbox-a",
          name: "Sandbox A",
          namespace: "namespace-a",
        },
      },
    );
    await add(
      "sandbox-detail-namespace-fallback",
      sandboxApp,
      "/v1/sandboxes/namespace-only",
      {
        sandbox: null,
        namespace: { _id: "namespace-only", title: "Namespace A" },
      },
    );
    await add("sandbox-detail-missing", sandboxApp, "/v1/sandboxes/missing", {
      sandbox: null,
      namespace: null,
    });

    mocks.itemFind.mockImplementation((filter: { namespace: string }) =>
      query(filter.namespace === "sandbox-a" ? [item("sandbox-item")] : []),
    );
    await add(
      "sandbox-items-filtered",
      sandboxApp,
      "/v1/sandboxes/sandbox-a/items?entitlementType=EXECUTABLE&platforms=Windows&title=Sandbox",
      { sandbox: { _id: "sandbox-a" }, items: [item("sandbox-item")] },
    );
    mocks.itemFind.mockImplementation(() => query([]));
    await add(
      "sandbox-items-empty",
      sandboxApp,
      "/v1/sandboxes/sandbox-a/items",
      { sandbox: { _id: "sandbox-a" }, items: [] },
    );
    mocks.offerFind.mockReturnValue(query([]));
    await add(
      "sandbox-offers-empty",
      sandboxApp,
      "/v1/sandboxes/sandbox-a/offers?country=US",
      { sandbox: { _id: "sandbox-a" }, offers: [] },
    );
    mocks.itemFind.mockReturnValue(query([]));
    mocks.assetFind.mockReturnValue(query([]));
    await add(
      "sandbox-assets-empty",
      sandboxApp,
      "/v1/sandboxes/sandbox-a/assets",
      { sandbox: { _id: "sandbox-a" }, items: [], assets: [] },
    );
    mocks.achievementFind.mockReturnValue(query([]));
    await add(
      "sandbox-achievements-empty",
      sandboxApp,
      "/v1/sandboxes/sandbox-a/achievements",
      { sandbox: { _id: "sandbox-a" }, achievements: [] },
    );
    mocks.offerFindOne.mockReturnValue({ lean: async () => null });
    mocks.itemFindOne.mockImplementation(() => ({ lean: async () => null }));
    await add(
      "sandbox-base-game-missing",
      sandboxApp,
      "/v1/sandboxes/sandbox-a/base-game?country=US",
      { sandbox: { _id: "sandbox-a" }, offers: [], item: null },
    );
    const executable = {
      ...item("fallback"),
      namespace: "sandbox-a",
      entitlementType: "EXECUTABLE",
      releaseInfo: [{ appId: "app", platform: ["Windows"] }],
    };
    mocks.itemFindOne.mockReturnValue({ lean: async () => executable });
    await add(
      "sandbox-base-game-item",
      sandboxApp,
      "/v1/sandboxes/sandbox-a/base-game?country=DE",
      { sandbox: { _id: "sandbox-a" }, items: [executable] },
    );
    const base = {
      id: "base",
      namespace: "sandbox-a",
      title: "A Base Game",
      offerType: "BASE_GAME",
      customAttributes: [{ key: "Example", value: "yes", type: "STRING" }],
    };
    const price = {
      offerId: "base",
      price: { discountPrice: 299, originalPrice: 399, currencyCode: "EUR" },
    };
    mocks.offerFindOne.mockReturnValue({ lean: async () => base });
    mocks.priceFindOne.mockReturnValue({ lean: async () => price });
    await add(
      "sandbox-base-game-offer",
      sandboxApp,
      "/v1/sandboxes/sandbox-a/base-game?country=DE",
      { sandbox: { _id: "sandbox-a" }, offers: [base], prices: [price] },
    );
    mocks.itemFind.mockReturnValue(query([]));
    await add(
      "sandbox-changelog-empty",
      sandboxApp,
      "/v1/sandboxes/sandbox-a/changelog",
      { sandbox: { _id: "sandbox-a" }, offers: [], items: [], changelogs: [] },
    );
    await add(
      "sandbox-builds-empty",
      sandboxApp,
      "/v1/sandboxes/sandbox-a/builds",
      { sandbox: { _id: "sandbox-a" }, items: [], builds: [] },
    );
    await add(
      "sandbox-stats-empty",
      sandboxApp,
      "/v1/sandboxes/sandbox-a/stats",
      {
        sandbox: { _id: "sandbox-a" },
        offers: 0,
        items: [],
        achievements: [],
        assets: [],
        builds: 0,
      },
    );
    expect(cases.map((entry) => entry.response.status)).toEqual([
      200, 404, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 404, 200,
      200, 200, 200, 200, 404, 200, 200, 200, 200, 200,
    ]);
    const itemCase = async (
      name: string,
      path: string,
      status: number,
      input: Record<string, unknown> = {},
      init: RequestInit = {},
    ) => {
      await add("item-wave-" + name, itemApp, path, input, init);
      expect(cases.at(-1)?.response.status, name).toBe(status);
    };
    for (const [name, path] of [
      ["list-page", "/v1/items?limit=0"],
      ["list-cursor", "/v1/items?cursor=invalid"],
      ["detail-query", "/v1/items/demo?other=1"],
      ["detail-id", "/v1/items/%20"],
      ["assets-query", "/v1/items/demo/assets?other=1"],
      ["builds-query", "/v1/items/demo/builds?other=1"],
      ["assets-id", "/v1/items/%20/assets"],
      ["builds-id", "/v1/items/%20/builds"],
      ["history-id", "/v1/items/%20/changelog"],
      ["offer-id", "/v1/items/%20/offer"],
      ["history-query", "/v1/items/demo/changelog?other=1"],
      ["history-limit", "/v1/items/demo/changelog?limit=0"],
      ["offer-region", "/v1/items/demo/offer?country=???"],
    ])
      await itemCase(name, path, 400);
    const pagination = { limit: 20, hasMore: false, nextCursor: null };
    mocks.itemFind.mockReturnValue(query([item("listed")]));
    await itemCase("list-cache-fill", "/v1/items", 200, {
      items: [item("listed")],
    });
    for (const [name, path, cachePayload] of [
      ["list", "/v1/items", { data: [{ id: "cached" }], pagination }],
      ["detail", "/v1/items/demo", { id: "cached" }],
      ["assets", "/v1/items/demo/assets", [{ id: "cached-asset" }]],
      [
        "history",
        "/v1/items/demo/changelog",
        { data: [{ id: "change" }], pagination },
      ],
    ] as const)
      await itemCase(name + "-cache", path, 200, { cachePayload });
    for (const [name, path] of [["list", "/v1/items"], ["history", "/v1/items/demo/changelog"]] as const) {
      for (const [shape, cachePayload, status] of [
        ["without-page", { data: [] }, 200], ["text-length", { data: "A🎮", pagination: null }, 200],
        ["object-length", { data: { length: "stored" } }, 200], ["no-length", { data: {} }, 200],
        ["missing-data", { meta: {} }, 500], ["null-data", { data: null }, 500],
      ] as const) await itemCase(`${name}-cache-${shape}`, path, status, { cachePayload });
    }
    for (const suffix of ["assets", "builds"]) {
      for (const [name, cachePayload] of [["text", "A🎮"], ["explicit-length", { length: 0 }], ["without-length", false]] as const)
        await itemCase(`${suffix}-cache-${name}`, "/v1/items/demo/" + suffix, 200, { cachePayload });
    }
    for (const [name, cachePayload] of [["false", false], ["zero", 0], ["empty", ""]] as const)
      await itemCase("detail-cache-" + name, "/v1/items/demo", 404, { cachePayload });
    for (const path of ["/v1/items/bulk", "/v1/items/bulk/offers"]) {
      const key = path.endsWith("offers") ? "bulk-offers" : "bulk";
      for (const [name, rawBody, contentType, status] of [
        ["media", '{"items":[]}', "text/plain", 415],
        ["malformed", "{", "application/json", 400],
        ["empty", '{"items":[]}', "application/json", 200],
      ] as const)
        await itemCase(
          key + "-" + name,
          path,
          status,
          { rawBody, contentType },
          {
            method: "POST",
            headers: { "content-type": contentType },
            body: rawBody,
          },
        );
      await itemCase(
        key + "-invalid-query",
        path + "?other=1",
        400,
        {},
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"items":["demo"]}',
        },
      );
      await itemCase(
        key + "-stream-error",
        path,
        400,
        { interruptedBody: true },
        { method: "POST", headers: { "content-type": "application/json" } },
      );
    }
    const failed = () => ({
      lean: async () => {
        throw new Error("fixture read failed");
      },
    });
    mocks.itemFind.mockReturnValue(failed());
    await itemCase("list-db", "/v1/items", 500, { failReads: "items" });
    await itemCase(
      "bulk-db",
      "/v1/items/bulk",
      500,
      { failReads: "items" },
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"items":["demo"]}',
      },
    );
    mocks.assetFind.mockReturnValue(failed());
    await itemCase("asset-db", "/v1/items/demo/assets", 500, {
      failReads: "assets",
    });
    for (const [name, path] of [
      ["detail", "/v1/items/demo"],
      ["builds", "/v1/items/demo/builds"],
      ["history", "/v1/items/demo/changelog"],
    ]) {
      mocks.itemFindOne.mockReturnValue(failed());
      await itemCase(name + "-db", path, 500, { failReads: "items" });
      mocks.itemFindOne.mockReturnValue({ lean: async () => null });
      await itemCase(name + "-missing", path, 404);
    }
    const baseOffers = [
      "CONSUMABLE",
      "ADDON",
      "EDITION",
      "BUNDLE",
      "DLC",
      "Other",
      "ADD_ON",
      "BASE_GAME",
    ].map((offerType, i) => ({
      ...item("offer-" + i),
      offerType,
      items: [{ id: "demo" }, { id: "irrelevant" }],
    }));
    const offers = [
      { ...baseOffers.at(-1)!, id: "presale", prePurchase: true },
      ...baseOffers,
    ];
    const offerPrice = {
      offerId: offers.at(-1)!.id,
      region: "US",
      price: { discountPrice: 699, originalPrice: 999, currencyCode: "USD" },
    };
    mocks.offerFind.mockReturnValue(query(offers));
    mocks.priceFind.mockReturnValue(query([offerPrice]));
    mocks.collection.mockImplementation(() => ({
      find: () => ({ toArray: async () => [] }),
    }));
    await itemCase(
      "bulk-ranked-offer",
      "/v1/items/bulk/offers",
      200,
      { offers, prices: [offerPrice], subItems: [] },
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"items":["demo","missing"]}',
      },
    );
    const numeric = { id: 7, namespace: "historic", offerType: "BASE_GAME", title: "Numeric", items: [{ id: "demo" }] };
    const text = { ...numeric, id: "7", title: "Text", items: [{ id: "second" }] };
    const bulkPath = "/v1/items/bulk/offers";
    const bulkInit = {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: ["demo", "second", "third", "__proto__"] }),
    };
    for (const [name, path, cachePayload, status] of [
      ["bulk-cache-text", "/v1/items/bulk", { data: "A🎮" }, 200],
      ["bulk-cache-missing-data", "/v1/items/bulk", { missing: [] }, 500],
      ["bulk-cache-length-field", "/v1/items/bulk", { data: { length: "stored" }, missing: null }, 200],
      ["bulk-offer-cache-missing-fields", bulkPath, {}, 200],
      ["bulk-offer-cache-typed-fields", bulkPath, { data: null, found: "cached" }, 200],
    ] as const) await itemCase(name, path, status, { cachePayload }, bulkInit);
    for (const [name, directRows, subItems, nestedOffers, prices, status] of [
      ["typed", [numeric, text], [{ _id: 8, subItems: [{ id: "third" }] }], [{ ...numeric, id: 8, title: "Nested" }], [
        { ...offerPrice, offerId: 7 }, { ...offerPrice, offerId: "7", region: "other" }, { ...offerPrice, offerId: 8 },
      ], 200],
      ["duplicate", [numeric, { ...text, id: 7 }], [], [], [], 200],
      ["bad-links", [{ ...numeric, items: {} }], [], [], [], 500],
      ["empty-links", [{ ...numeric, items: null }, { ...text, items: "abc" }], [], [], [], 200],
      ["bad-nested-links", [], [{ _id: 7, subItems: 9 }], [numeric], [], 500],
      ["bad-attributes", [{ ...numeric, customAttributes: [null] }], [], [], [], 500],
      ["bad-price", [numeric], [], [], [{ offerId: 7, price: { currencyCode: 9 } }], 500],
      ["historical-rank", [{ ...numeric, offerType: "other" }, { ...numeric, id: "historic", offerType: ["base_game"] }], [], [], [], 200],
    ] as const) {
      mocks.offerFind.mockImplementation((filter) => query("id" in filter ? [...nestedOffers] : [...directRows]));
      mocks.collection.mockImplementation(() => ({ find: () => ({ toArray: async () => subItems }) }));
      mocks.priceFind.mockReturnValue(query([...prices]));
      await itemCase("bulk-joins-" + name, bulkPath, status, { offers: directRows, subItems, nestedOffers, prices }, bulkInit);
    }
    const historyRows = [
      {
        _id: "row",
        timestamp: "2025-01-01T10:00:00.000Z",
        metadata: { contextType: "build" },
      },
    ];
    const itemDoc = item("demo");
    const assets = [{ artifactId: "artifact" }];
    const builds = [{ _id: "build-string-id", appName: "artifact" }];
    const historyInput: Record<string, unknown> = {
      item: itemDoc,
      assets,
      builds,
      historyRows,
    };
    mocks.itemFindOne.mockReturnValue({ lean: async () => itemDoc });
    mocks.assetFind.mockReturnValue(query(assets));
    mocks.collection.mockImplementation((name: string) => ({
      find: () => ({ toArray: async () => builds }),
      countDocuments: async () => historyRows.length,
      aggregate: (pipeline: unknown[]) => {
        historyInput.pipeline = pipeline;
        return { toArray: async () => historyRows };
      },
    }));
    await itemCase(
      "history-with-linked-builds",
      "/v1/items/demo/changelog",
      200,
      historyInput,
    );
    const itemRelease = { ...itemDoc, releaseInfo: [{ appId: "artifact" }] };
    mocks.itemFindOne.mockReturnValue({ lean: async () => itemRelease });
    for (const [label, rows, failAssets, expectedStatus] of [
      ["historical", [{ _id: 42, appName: "artifact", platform: 7 }, { _id: "second", appName: "other", labelName: "Live-Windows" }], false, 200],
      ["null-id", [{ _id: null, platform: "Windows", appName: "artifact" }], false, 500],
      ["missing-label", [{ _id: 1, appName: "artifact" }, { _id: 2, platform: "Mac", appName: "other" }], false, 500],
      ["parallel-lookup-error", [{ _id: 1, appName: "artifact", platform: "Win" }, { _id: 2, appName: "other", platform: "Mac" }], true, 500],
    ] as const) {
      mocks.collection.mockImplementation(() => ({ find: () => ({ toArray: async () => rows }) }));
      mocks.assetFindOne.mockImplementation(() => failAssets ? failed() : { lean: async () => null });
      await itemCase("build-" + label, "/v1/items/demo/builds", expectedStatus, {
        item: itemRelease, builds: rows, captureAssetQueries: true, ...(failAssets ? { failReads: "assets" } : {}),
      });
    }
    for (const [scenario, names, status] of [
      ["out-of-order", ["delayed", "ready"], 200],
      ["immediate-error", ["never", "reject", "ready"], 500],
      ["deferred-error", ["never", "delayed-reject", "ready"], 500],
    ] as const) {
      const rows = names.map((appName) => ({ _id: appName, appName, platform: "Windows" }));
      mocks.collection.mockImplementation(() => ({find: () => ({toArray: async () => rows})}));
      mocks.assetFindOne.mockImplementation((filter) => ({ lean: async () => {
        const name = filter.artifactId.$eq;
        if (name === "never") return new Promise(() => {});
        if (name.startsWith("delayed")) await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (name.endsWith("reject")) throw new Error("asset lookup failed");
        return null;
      } }));
      await itemCase("build-concurrent-" + scenario, "/v1/items/demo/builds", status, {
        item: itemRelease, builds: rows, captureAssetQueries: true, timedAssets: true,
      });
    }
    mocks.collection.mockImplementation(() => ({
      find: () => ({
        toArray: async () => {
          throw new Error("build read failed");
        },
      }),
    }));
    await itemCase("build-docs-outage", "/v1/items/demo/builds", 500, {
      item: itemRelease,
      failReads: "builds",
    });
    await itemCase("history-build-outage", "/v1/items/demo/changelog", 500, {
      item: itemRelease,
      assets,
      failReads: "builds",
    });
    mocks.collection.mockImplementation(() => ({
      find: () => ({ toArray: async () => builds }),
      aggregate: () => ({
        toArray: async () => {
          throw new Error("history read failed");
        },
      }),
    }));
    await itemCase(
      "history-aggregate-outage",
      "/v1/items/demo/changelog",
      500,
      { item: itemRelease, assets, builds, failReads: "changelogs_v2" },
    );
    mocks.assetFindOne.mockReturnValue(failed());
    await itemCase("build-assets-outage", "/v1/items/demo/builds", 500, {
      item: itemRelease,
      builds,
      failReads: "assets",
    });
    mocks.assetFind.mockReturnValue(failed());
    await itemCase("history-assets-outage", "/v1/items/demo/changelog", 500, {
      item: itemRelease,
      failReads: "assets",
    });
    mocks.offerFind.mockReturnValue(failed());
    await itemCase(
      "bulk-offer-outage",
      "/v1/items/bulk/offers",
      500,
      { failReads: "offers" },
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"items":["demo"]}',
      },
    );
    mocks.offerFind.mockReturnValue(query(offers));
    mocks.collection.mockImplementation(() => ({
      find: () => ({
        toArray: async () => {
          throw new Error("subitems unavailable");
        },
      }),
    }));
    await itemCase(
      "bulk-subitem-outage",
      "/v1/items/bulk/offers",
      500,
      { offers, failReads: "offersubitems" },
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"items":["demo"]}',
      },
    );
    mocks.collection.mockImplementation(() => ({
      find: () => ({ toArray: async () => [] }),
    }));
    mocks.priceFind.mockReturnValue(failed());
    await itemCase(
      "bulk-offer-price-outage",
      "/v1/items/bulk/offers",
      500,
      { offers, subItems: [], failReads: "pricev2" },
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"items":["demo"]}',
      },
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-11-17T00:00:00Z");
    const rows = [item("first"), item("next")];
    mocks.itemFind.mockReturnValue(query(rows));
    await itemCase("list-first", "/v1/items?limit=1", 200, { items: rows });
    const listMeta = cases.at(-1)!.response.body as {
      meta: { pagination: { nextCursor: string } };
    };
    mocks.itemFind.mockReturnValue(query([]));
    await itemCase(
      "list-continued",
      "/v1/items?limit=1&cursor=" +
        encodeURIComponent(listMeta.meta.pagination.nextCursor),
      200,
      { items: [] },
    );
    const storedOid = new BSON.ObjectId("65ba12345678901234567890");
    for (const [label, id, lastModifiedDate] of [
      ["numeric", 19, "2025-03"],
      ["object-id", storedOid, new Date("2025-03-15T02:00:00Z")],
      ["decimal", BSON.Decimal128.fromString("15.00"), "2025"],
      ["empty-string", "", null],
      ["invalid-date", "old", "not a date"],
      ["nonleap-february", "historic", "2025-02-29"],
      ["month-rollover", "historic", "2024-04-31T09:30:00+02:00"],
      ["midnight-at-24", "historic", "2024-01-31T24:00:00Z"],
      ["invalid-day", "historic", "2024-04-32"],
      ["leap-second", "historic", "2025-12-31T23:59:60Z"],
    ] as const) {
      const page = [{ ...item("typed"), id, lastModifiedDate }, item("next")];
      mocks.itemFind.mockReturnValue(query(page));
      await itemCase("list-stored-id-" + label, "/v1/items?limit=1", 200, { items: fixtureValue(page) });
      const first = cases.at(-1)!.response.body as { meta: { pagination: { nextCursor: string } } };
      const continued: Record<string, unknown> = { items: [] };
      mocks.itemFind.mockImplementation((filter) => {
        continued.wireFilter = fixtureValue(BSON.deserialize(BSON.serialize(filter, { ignoreUndefined: false })));
        return query([]);
      });
      await itemCase("list-continue-stored-" + label,
        "/v1/items?limit=1&cursor=" + encodeURIComponent(first.meta.pagination.nextCursor), 200, continued);
    }
    const changes = [...historyRows, { ...historyRows[0], _id: "older" }];
    const firstHistory: Record<string, unknown> = {
      item: itemDoc,
      assets: [],
      historyRows: changes,
    };
    const nextHistory: Record<string, unknown> = {
      item: itemDoc,
      assets: [],
      historyRows: [],
    };
    mocks.itemFindOne.mockReturnValue({ lean: async () => itemDoc });
    mocks.assetFind.mockReturnValue(query([]));
    const historyRead = (input: Record<string, unknown>) => ({
      countDocuments: async () =>
        (input.historyRows as unknown[] | undefined)?.length ?? 0,
      aggregate: (stages: unknown[]) => {
        input.pipeline = stages;
        return { toArray: async () => input.historyRows };
      },
    });
    mocks.collection.mockImplementation(() => historyRead(firstHistory));
    await itemCase(
      "history-first",
      "/v1/items/demo/changelog?limit=1",
      200,
      firstHistory,
    );
    const historyMeta = cases.at(-1)!.response.body as {
      meta: { pagination: { nextCursor: string } };
    };
    mocks.collection.mockImplementation(() => historyRead(nextHistory));
    await itemCase(
      "history-continued",
      "/v1/items/demo/changelog?limit=1&cursor=" +
        encodeURIComponent(historyMeta.meta.pagination.nextCursor),
      200,
      nextHistory,
    );
    for (const [label, id] of [
      ["zero", 0], ["false", false], ["empty", ""], ["number", 17],
      ["object-id", storedOid], ["decimal", BSON.Decimal128.fromString("31.00")],
      ["unpromoted-long", BSON.Long.MAX_VALUE], ["object", { key: "historic" }],
    ] as const) {
      const page = [{ ...historyRows[0], _id: id }, historyRows[0]];
      const input: Record<string, unknown> = { item: itemDoc, assets: [], historyRows: fixtureValue(page) };
      mocks.collection.mockImplementation(() => ({
        countDocuments: async () => page.length,
        aggregate: (stages: unknown[]) => {
          input.pipeline = stages;
          return { toArray: async () => page };
        },
      }));
      await itemCase("history-stored-id-" + label, "/v1/items/demo/changelog?limit=1", 200, input);
    }
    const mixedAssets = [{artifactId: storedOid}, {artifactId: 15}, {artifactId: "live"}];
    const linkedBuilds = [{_id: BSON.Decimal128.fromString("4.00")}, {_id: BSON.Long.MAX_VALUE}];
    const typedContext: Record<string, unknown> = {
      item: itemDoc, assets: fixtureValue(mixedAssets), builds: fixtureValue(linkedBuilds), historyRows: [],
    };
    mocks.assetFind.mockReturnValue(query(mixedAssets));
    mocks.collection.mockImplementation(() => ({
      find: () => ({ toArray: async () => linkedBuilds }),
      countDocuments: async () => 0,
      aggregate: (stages: unknown[]) => {
        typedContext.pipeline = stages;
        return { toArray: async () => [] };
      },
    }));
    await itemCase("history-stored-context", "/v1/items/demo/changelog", 200, typedContext);
    await itemCase("eligible-offer-cache", "/v1/items/demo/offer", 200, {
      cachePayload: {
        status: "ok",
        offer: { id: "cached-game" },
        localization: { locale: "en-US", localeStatus: "canonical" },
      },
    });
    await itemCase("absent-offer-cache", "/v1/items/demo/offer", 404, {
      cachePayload: { status: "offer_not_found" },
    });
    mocks.itemFindOne.mockReturnValue(failed());
    await itemCase("offer-item-db", "/v1/items/demo/offer", 500, {
      failReads: "items",
    });
    mocks.itemFindOne.mockReturnValue({ lean: async () => itemDoc });
    mocks.collection.mockImplementation(() => ({
      find: () => ({
        toArray: async () => {
          throw new Error("subitems unavailable");
        },
      }),
    }));
    await itemCase("offer-subitems-db", "/v1/items/demo/offer", 500, {
      item: itemDoc,
      failReads: "offersubitems",
    });
    const subs = [{ _id: "base" }];
    mocks.collection.mockImplementation(() => ({
      find: () => ({ toArray: async () => subs }),
    }));
    mocks.offerFind.mockReturnValue(failed());
    await itemCase("offer-catalog-db", "/v1/items/demo/offer", 500, {
      item: itemDoc,
      subItems: subs,
      failReads: "offers",
    });
    const baseOffer = { ...item("base"), offerType: "BASE_GAME" };
    const numericOffer = { ...baseOffer, id: 7 };
    for (const [kind, selected, sortedPrice, status] of [
      ["sorted", numericOffer, { offerId: 7, region: "US", price: { discountPrice: "29.9", currencyCode: "EUR" } }, 200],
      ["invalid-currency", baseOffer, { price: { currencyCode: ["EUR"] } }, 500],
      ["invalid-attributes", { ...baseOffer, customAttributes: [null] }, null, 500],
    ] as const) {
      mocks.offerFind.mockReturnValue(query([selected]));
      mocks.priceFindOne.mockReturnValue({ lean: async () => sortedPrice });
      await itemCase("offer-" + kind, "/v1/items/demo/offer", status, {
        item: itemDoc, subItems: subs, offers: [selected], sortedPrice, capturePriceQueries: true,
      });
    }
    mocks.offerFind.mockReturnValue(query([baseOffer]));
    mocks.priceFindOne.mockReturnValue(failed());
    await itemCase("offer-price-db", "/v1/items/demo/offer", 500, {
      item: itemDoc,
      subItems: subs,
      offers: [baseOffer],
      failReads: "pricev2",
    });
    mocks.assetFind.mockReturnValue(query(assets));
    mocks.collection.mockImplementation(() => ({
      find: () => ({ toArray: async () => [{}] }),
    }));
    await itemCase(
      "history-missing-build-id",
      "/v1/items/demo/changelog",
      500,
      { item: itemDoc, assets, builds: [{}] },
    );
    mocks.assetFind.mockReturnValue(query([]));
    await itemCase(
      "history-invalid-cursor",
      "/v1/items/demo/changelog?cursor=bad",
      400,
      { item: itemDoc, assets: [] },
    );
    await itemCase("absent-item-cache", "/v1/items/demo/offer", 404, {
      cachePayload: { status: "item_not_found" },
    });
    await itemCase(
      "bulk-offers-invalid-country",
      "/v1/items/bulk/offers?country=ZZ",
      400,
      {},
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"items":[]}',
      },
    );
    for (const tuple of [
      ["row"],
      ["2026-11-01T00:00:00.000Z", "demo", "extra"],
    ]) {
      const malformedListCursor = encodeCursor(
        {
          operation: "items.list",
          filters: {},
          ordering: "lastModifiedDate:desc,id:asc",
          country: "",
          locale: "",
          limit: 1,
        },
        tuple,
      );
      await itemCase(
        "list-tuple-arity-" + tuple.length,
        "/v1/items?limit=1&cursor=" + encodeURIComponent(malformedListCursor),
        400,
        {},
      );
    }
    for (const [label, tuple] of [
      ["short", ["2026-11-01T00:00:00.000Z"]],
      ["long", ["2026-11-01T00:00:00.000Z", "change", "trailing"]],
      ["invalid-date", ["invalid stored time", "65ba12345678901234567890"]],
      ["date-only-month", ["2024-03", "row"]],
    ] as const) {
      const cursor = encodeCursor(
        {
          operation: "items.changelog",
          filters: { id: "demo" },
          ordering: "timestamp:desc,_id:desc",
          country: "",
          locale: "",
          limit: 1,
        },
        [...tuple],
      );
      const input: Record<string, unknown> = {
        item: itemDoc,
        assets: [],
        historyRows: [],
      };
      mocks.collection.mockImplementation(() => ({
        countDocuments: async () => 0,
        aggregate: (stages: unknown[]) => {
          input.pipeline = BSON.deserialize(
            BSON.serialize({ stages }, { ignoreUndefined: false }),
          ).stages;
          input.wireMatch = fixtureValue((input.pipeline as Array<{ $match: unknown }>)[0].$match);
          return { toArray: async () => [] };
        },
      }));
      await itemCase(
        "history-tuple-" + label,
        "/v1/items/demo/changelog?limit=1&cursor=" + encodeURIComponent(cursor),
        200,
        input,
      );
    }
    mocks.collection.mockImplementation((name: string) => ({
      find: () => ({
        toArray: async () => {
          if (name === "egs_localizations")
            throw new Error("localization unavailable");
          return subs;
        },
      }),
    }));
    mocks.offerFind.mockReturnValue(query([baseOffer]));
    mocks.priceFindOne.mockReturnValue({ lean: async () => null });
    mocks.priceFind.mockReturnValue(query([]));
    await itemCase(
      "offer-locale-outage",
      "/v1/items/demo/offer?locale=de-DE",
      500,
      {
        item: itemDoc,
        subItems: subs,
        offers: [baseOffer],
        failReads: "egs_localizations",
      },
    );
    const linkedOffer = { ...baseOffer, items: [{ id: "demo" }] };
    mocks.offerFind.mockReturnValue(query([linkedOffer]));
    await itemCase(
      "bulk-offer-locale-outage",
      "/v1/items/bulk/offers?locale=de-DE",
      500,
      {
        offers: [linkedOffer],
        subItems: subs,
        prices: [],
        failReads: "egs_localizations",
      },
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"items":["demo"]}',
      },
    );
    const nestedRefs = [{ _id: "nested", subItems: [{ id: "demo" }] }];
    const bulkOfferRequest = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"items":["demo"]}',
    };
    mocks.collection.mockImplementation(() => ({
      find: () => ({ toArray: async () => nestedRefs }),
    }));
    mocks.offerFind.mockImplementation((filter: Record<string, unknown>) =>
      filter["items.id"] ? query([]) : failed(),
    );
    await itemCase(
      "nested-offer-outage",
      "/v1/items/bulk/offers",
      500,
      { offers: [], subItems: nestedRefs, failReads: "nestedOffers" },
      bulkOfferRequest,
    );
    mocks.offerFind.mockReturnValue(query([]));
    await itemCase(
      "nested-offer-absent",
      "/v1/items/bulk/offers",
      200,
      { offers: [], subItems: nestedRefs, nestedOffers: [] },
      bulkOfferRequest,
    );
    const sparseIdPage = [
      {
        title: "Legacy item without an ID",
        lastModifiedDate: "2026-10-01T00:00:00Z",
      },
      item("next"),
    ];
    mocks.itemFind.mockReturnValue(query(sparseIdPage));
    await itemCase("wire-list-missing-id", "/v1/items?limit=1", 200, {
      middleware: true,
      items: fixtureValue(sparseIdPage),
    });
    const regionOffer = (id: unknown, extra: Record<string, unknown> = {}) => ({
      ...offers[0],
      id,
      title: String(id),
      offerType: "BASE_GAME",
      items: [{ id: "demo" }],
      ...extra,
    });
    const oid = new ObjectId("507f1f77bcf86cd799439011");
    const materialize = <T>(rows: T): T =>
      BSON.deserialize(BSON.serialize({ rows })).rows;
    const offerPath = "/v1/items/demo/offer";
    mocks.itemFindOne.mockReturnValue({ lean: async () => itemDoc });
    mocks.collection.mockImplementation(() => ({
      find: () => ({ toArray: async () => subs }),
    }));
    mocks.priceFindOne.mockReturnValue({ lean: async () => null });
    for (const [label, rows, status] of [
      [
        "whitelist-over-blacklist",
        [
          regionOffer("included", {
            countriesWhitelist: [new BSONSymbol("US")],
            countriesBlacklist: ["US"],
          }),
        ],
        200,
      ],
      [
        "whitelist-miss",
        [
          regionOffer("blocked", {
            countriesWhitelist: ["us", 7],
            countriesBlacklist: [],
          }),
        ],
        404,
      ],
      [
        "blacklist-symbol",
        [
          regionOffer("blocked", {
            countriesWhitelist: "US",
            countriesBlacklist: [new BSONSymbol("US")],
          }),
        ],
        404,
      ],
      [
        "multiple-prepurchases",
        [
          regionOffer("one", { prePurchase: true }),
          regionOffer("two", { prePurchase: true }),
        ],
        404,
      ],
      [
        "released-after-prepurchase",
        [
          regionOffer("first", { prePurchase: true }),
          regionOffer("second", { prePurchase: "true" }),
        ],
        200,
      ],
      ["only-prepurchase", [regionOffer("sole", { prePurchase: true })], 200],
    ] as const) {
      mocks.offerFind.mockReturnValue(query(materialize(rows)));
      await itemCase("wire-offer-" + label, offerPath, status, {
        middleware: true,
        item: itemDoc,
        subItems: subs,
        offers: fixtureValue(rows),
      });
    }
    for (const [label, cache] of Object.entries({
      absent: { status: "ok", localization: ["de-DE", 2] },
      null: { status: "ok", offer: null, localization: "abc" },
      empty: {},
    }))
      await itemCase("wire-cache-" + label, offerPath, 200, {
        middleware: true,
        cachePayload: cache,
      });
    const direct = regionOffer(oid);
    const opaqueSub = [{ _id: oid, subItems: [{ id: "second" }] }];
    const priceRows = [
      { offerId: oid, price: { discountPrice: 125 } },
      {
        offerId: "dec",
        price: {
          discountPrice: Decimal128.fromString("349.8"),
          currencyCode: "USD",
        },
      },
    ];
    for (const [label, directs, nested, subreferences, status] of [
      ["object-joins", [direct], [regionOffer(oid)], opaqueSub, 200],
      [
        "symbol-linked-id",
        [regionOffer("dec", { items: [{ id: new BSONSymbol("demo") }] })],
        [],
        [],
        200,
      ],
      [
        "iterable-direct-link",
        [regionOffer("unlinked", { items: "demo" })],
        [],
        [],
        200,
      ],
      [
        "iterable-nested-link",
        [],
        [regionOffer("nested")],
        [{ _id: "nested", subItems: "demo" }],
        200,
      ],
      ["malformed-direct-link", [regionOffer("x", { items: 17 })], [], [], 500],
    ] as const) {
      mocks.offerFind.mockImplementation((filter: Record<string, unknown>) =>
        query(materialize(filter["items.id"] ? directs : nested)),
      );
      mocks.collection.mockImplementation(() => ({
        find: () => ({ toArray: async () => materialize(subreferences) }),
      }));
      mocks.priceFind.mockReturnValue(query(materialize(priceRows)));
      await itemCase(
        "wire-bulk-" + label,
        bulkPath,
        status,
        {
          middleware: true,
          offers: fixtureValue(directs),
          nestedOffers: fixtureValue(nested),
          subItems: fixtureValue(subreferences),
          prices: fixtureValue(priceRows),
        },
        bulkOfferRequest,
      );
    }
    mocks.itemFind.mockReturnValue(
      query(
        materialize([
          { id: new BSONSymbol("demo"), title: "Stored" },
          { title: "Missing" },
          { id: oid },
        ]),
      ),
    );
    await itemCase(
      "wire-bulk-id-types",
      "/v1/items/bulk",
      200,
      {
        middleware: true,
        items: fixtureValue([
          { id: new BSONSymbol("demo"), title: "Stored" },
          { title: "Missing" },
          { id: oid },
        ]),
      },
      bulkOfferRequest,
    );
    await itemCase(
      "wire-bulk-cache-count",
      "/v1/items/bulk",
      200,
      {
        middleware: true,
        cachePayload: { data: { something: 0 }, missing: [] },
      },
      bulkOfferRequest,
    );
    mocks.itemFindOne.mockReturnValue({ lean: async () => itemDoc });
    const itemPath = "/v1/items/demo";
    await itemCase("wire-get", itemPath, 200, {
      middleware: true,
      item: itemDoc,
    });
    const tag = cases.at(-1)!.response.headers.etag;
    for (const [name, header, status] of [
      ["strong", tag, 304],
      ["weak", "W/" + tag, 304],
      ["other", '"different"', 200],
    ] as const) {
      await itemCase("wire-etag-" + name, itemPath, status, {
        middleware: true,
        item: itemDoc,
        ifNoneMatch: header,
      });
    }
    await itemCase(
      "wire-head",
      itemPath,
      200,
      { middleware: true, item: itemDoc },
      { method: "HEAD" },
    );
    for (const [name, apps, status] of [
      ["success", ["first", "second", "third"], 200],
      ["failure", ["first", "reject", "third"], 500],
    ] as const) {
      let starts = 0;
      let resolve!: () => void;
      const gate = new Promise<void>((r) => {
        resolve = r;
      });
      const rows = apps.map((appName) => ({
        _id: appName,
        appName,
        platform: "Windows",
      }));
      const releaseItem = {
        ...itemDoc,
        releaseInfo: [null, 7, { appId: new BSONSymbol("first") }, {}, {}],
      };
      mocks.itemFindOne.mockReturnValue({
        lean: async () => materialize(releaseItem),
      });
      mocks.collection.mockImplementation(() => ({
        find: () => ({ toArray: async () => rows }),
      }));
      mocks.assetFindOne.mockImplementation((filter) => ({
        lean: async () => {
          starts++;
          if (starts === rows.length) resolve();
          await gate;
          if (filter.artifactId.$eq === "reject")
            throw Error("fixture lookup rejected");
          return {
            downloadSizeBytes: filter.artifactId.$eq === "first" ? 11 : 22,
          };
        },
      }));
      await itemCase("wire-inflight-" + name, "/v1/items/demo/builds", status, {
        middleware: true,
        item: fixtureValue(releaseItem),
        builds: rows,
        assetBarrier: rows.length,
        captureAssetQueries: true,
      });
      expect(starts).toBe(rows.length);
    }
    assertOracle("catalog-reads-http-node", cases);
  });
});
