import { it, vi } from "vitest";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { createReadRecorder } from "../rust/oracles/legacy-catalog-record.js";
import { assertOracle } from "../rust/oracles/record.js";
import { apiCors } from "../src/middlewares/cors.js";
import { responseEtag } from "../src/middlewares/response-etag.js";
import { routeTemplate } from "../src/middlewares/route-template.js";
import { edgeCacheHeaders } from "../src/middlewares/edge-cache.js";

const recorder = createReadRecorder();
vi.mock("../src/clients/job-api.js", () => recorder.jobs);
vi.mock("../src/db/index.js", () => ({
  db: { db: { collection: (name: string) => recorder.collection(name) } },
}));
vi.mock("../src/clients/response-cache.js", () => ({
  default: {
    get: (...args: Parameters<typeof recorder.cache.get>) =>
      recorder.cache.get(...args),
    set: (...args: Parameters<typeof recorder.cache.set>) =>
      recorder.cache.set(...args),
  },
}));

it("executes the legacy catalog routers and records native Mongo and cache calls", async () => {
  const app = new Hono();
  app.use("*", apiCors(), responseEtag, routeTemplate, edgeCacheHeaders);
  app.route("/items", (await import("../src/routes/items.js")).default);
  app.route("/sellers", (await import("../src/routes/sellers.js")).default);
  app.route("/assets", (await import("../src/routes/assets.js")).default);
  app.route(
    "/franchises",
    (await import("../src/routes/franchises.js")).default,
  );
  const cases = [];
  type Inputs = Parameters<typeof recorder.record>;
  const get = async (
    name: string,
    path: string,
    status: number,
    reads: Inputs[4] = [],
    hit: unknown = null,
    headers?: Record<string, string>,
  ) => {
    cases.push(
      await recorder.record(
        app,
        name,
        { method: "GET", path, headers },
        status,
        reads,
        hit,
      ),
    );
  };
  const post = async (
    name: string,
    path: string,
    status: number,
    body: unknown,
    reads: Inputs[4],
  ) => {
    cases.push(
      await recorder.record(
        app,
        name,
        {
          method: "POST",
          path,
          body,
          headers: { "content-type": "application/json" },
        },
        status,
        reads,
      ),
    );
  };
  const id = new ObjectId("65ba00000000000000000001");
  const item = {
    id: "i",
    title: "Item",
    customAttributes: [
      { key: "Z", value: "1" },
      { key: "A", type: "BOOL", value: false },
    ],
    releaseInfo: [{ appId: "app" }],
  };
  const asset = {
    artifactId: "app",
    itemId: "i",
    platform: "Windows",
    downloadSizeBytes: 0,
    installedSizeBytes: 224,
  };
  const offer = {
    _id: id,
    id: "o",
    namespace: "n",
    title: "Main",
    offerType: "BASE_GAME",
    items: [{ id: "i" }],
  };
  const date = new Date("2026-11-17T20:02:01.000Z");
  const build = {
    _id: id,
    appName: "app",
    buildVersion: "test",
    labelName: "Live-Windows",
    hash: "sha",
    updatedAt: date,
  };
  const price = { offerId: "o", region: "US", price: 1 };
  await get("asset", "/assets/app", 200, [["assets", "one", asset]]);
  await get("asset-missing", "/assets/missing", 404, [["assets", "one", null]]);
  await get("list-items", "/items?page=2&limit=12junk", 200, [
    ["items", "many", [item]],
    ["items", "count", 123],
  ]);
  await get("item", "/items/i", 200, [["items", "one", item]]);
  await get("item-missing", "/items/i", 404, [["items", "one", null]]);
  await get("item-assets", "/items/i/assets", 200, [
    ["assets", "many", [asset]],
  ]);
  await get("item-builds", "/items/i/builds", 200, [
    ["items", "one", item],
    ["builds", "many", [build]],
    ["assets", "one", asset],
  ]);
  await get("item-builds-missing", "/items/i/builds", 404, [
    ["items", "one", null],
  ]);
  await get("item-offer", "/items/i/offer", 200, [
    ["offersubitems", "many", [{ _id: "o" }]],
    ["offers", "many", [offer]],
  ]);
  await get("item-offer-hit", "/items/i/offer", 200, [], { title: "cached" });
  await get("item-offer-missing", "/items/i/offer", 404, [
    ["offersubitems", "many", []],
    ["offers", "many", []],
  ]);
  await get("item-changelog", "/items/i/changelog?page=2&limit=2", 200, [
    ["items", "one", item],
    ["assets", "many", [asset]],
    ["builds", "many", [build]],
    [
      "changelogs_v2",
      "aggregate",
      [{ _id: id, document: item, timestamp: date }],
    ],
  ]);
  await get(
    "item-changelog-hit",
    "/items/i/changelog",
    200,
    [],
    [{ _id: "cached" }],
  );
  await get("item-changelog-missing", "/items/i/changelog", 404, [
    ["items", "one", null],
  ]);
  await get("sitemap-index", "/items/sitemap.xml", 200, [
    ["items", "count", 1300],
  ]);
  await get("sitemap-page", "/items/sitemap.xml?page=2", 200, [
    ["items", "many", [{ id: "i", lastModifiedDate: date }]],
  ]);
  await post("bulk", "/items/bulk", 200, { items: ["i", null, 1] }, [
    ["items", "many", [item]],
  ]);
  await post(
    "bulk-empty",
    "/items/bulk/offers",
    200,
    { items: [false, "  "] },
    [],
  );
  await post(
    "bulk-linked-offers",
    "/items/bulk/offers",
    200,
    { items: [" i ", "missing", "i"] },
    [
      ["offers", "many", [{ ...offer, id: "secondary", offerType: "DLC" }]],
      ["offersubitems", "many", [{ _id: "o", subItems: [{ id: "i" }] }]],
      ["offers", "many", [offer]],
    ],
  );
  await get("sellers", "/sellers", 200, [
    [
      "offers",
      "distinct",
      [
        { name: "Z", id: "z" },
        { name: "A", id: "a" },
      ],
    ],
  ]);
  await get("seller-invalid-country", "/sellers/s?country=unknown", 404);
  await get("seller-invalid-locale", "/sellers/s?locale=%3F", 400);
  await get("seller-offers-hit", "/sellers/s?offerType=DLC", 200, [], [offer], {
    cookie: "EGDATA_COUNTRY=ES",
  });
  await get("seller-offers", "/sellers/s?page=2&ignoredSandboxes=n1,n2", 200, [
    ["offers", "many", [offer, { id: "o2", title: "unpriced" }]],
    ["pricev2", "many", [price, { ...price, price: 2 }]],
  ]);
  await get("seller-cover", "/sellers/s/cover", 200, [
    ["game_positions", "many", [{ offerId: "o" }]],
    ["offers", "many", [offer]],
    ["pricev2", "many", [price]],
  ]);
  await get("seller-cover-fallback", "/sellers/s/cover", 200, [
    ["game_positions", "many", []],
    ["offers", "many", []],
    ["offers", "many", []],
    ["pricev2", "many", []],
  ]);
  await get("seller-stats", "/sellers/s/stats", 200, [
    ["sellers", "one", { _id: "s", name: "Seller" }],
    ["offers", "count", 40],
    ["items", "count", 52],
    ["offers", "aggregate", [{ count: 8 }]],
    ["freegames", "aggregate", [{ count: 1 }]],
    ["mobile-freebies", "aggregate", [{ count: 2 }]],
  ]);
  await get("seller-stats-missing", "/sellers/s/stats", 404, [
    ["sellers", "one", null],
  ]);
  await get("franchise-missing", "/franchises/series", 404, [
    ["franchises", "one", null],
  ]);
  await get("franchise-empty", "/franchises/series", 200, [
    ["franchises", "one", { _id: "series", offers: [] }],
  ]);
  await get("franchise-populated", "/franchises/series?expand=full", 200, [
    [
      "franchises",
      "one",
      { _id: "series", name: "Series", offers: ["o"], lastUpdated: date },
    ],
    ["offers", "many", [offer]],
    ["offers", "many", [{ namespace: "n" }]],
    ["pricev2", "many", [price, { ...price, price: 3 }]],
    ["achievementsets", "many", [{ achievements: [{ xp: 10 }, { xp: 5 }] }]],
    [
      "igdbs",
      "many",
      [
        { igdbId: 10, timeToBeat: { normally: 12 } },
        { igdbId: 10, timeToBeat: { normally: 100 } },
      ],
    ],
  ]);
  await get("franchise-hit", "/franchises/series?expand=1", 200, [], {
    elements: [],
  });
  cases.push(
    await recorder.record(
      app,
      "item-regen",
      { method: "PUT", path: "/items/regen/i" },
      200,
      [],
    ),
  );
  await post(
    "item-bulk-regen",
    "/items/bulk-regen",
    200,
    { items: ["a", "b", "a"] },
    [],
  );
  await post("item-bulk-regen-invalid", "/items/bulk-regen", 500, {}, []);
  const nativeId = new ObjectId("507f1f77bcf86cd799439091");
  const typedIds = [nativeId, nativeId.toString(), 7, "7", null];
  const typedOffers = [
    { id: nativeId, namespace: "ns", title: "ObjectId" },
    { id: nativeId.toString(), namespace: "ns" },
    { id: 7, namespace: "ns", title: "Number" },
    { id: "7", namespace: "ns", title: "String" },
    { namespace: "ns" },
  ];
  const typedPrices = [
    { offerId: new ObjectId(nativeId.toString()), q: "object" },
    { offerId: nativeId.toString(), q: "first" },
    { offerId: nativeId.toString(), q: "last" },
    { offerId: 7, q: "number" },
    { offerId: "7", q: "string" },
    { q: "missing" },
  ];
  const reads: Inputs[4] = [
    ["franchises", "one", { _id: nativeId, offers: typedIds }],
    ["offers", "many", typedOffers],
    [
      "offers",
      "many",
      [
        nativeId,
        new ObjectId(nativeId.toString()),
        7,
        7,
        "7",
        false,
        null,
        "",
        "ns",
      ].map((namespace) => ({ namespace })),
    ],
    ["pricev2", "many", typedPrices],
    [
      "egs_localizations",
      "many",
      [
        {
          entityType: "offer",
          entityId: `ns:${nativeId}`,
          locale: "es-ES",
          source: "fixture",
          data: { title: "Traducido", description: "Descripcion" },
        },
      ],
    ],
    [
      "achievementsets",
      "many",
      [
        { achievements: [{ xp: 10 }, { xp: "2" }, { xp: [4, 5] }] },
        { achievements: [{ xp: true }, { xp: false }] },
      ],
    ],
    [
      "igdbs",
      "many",
      [
        { igdbId: nativeId, timeToBeat: { hastily: 9, normally: "5" } },
        {
          igdbId: new ObjectId(nativeId.toString()),
          timeToBeat: { hastily: true, normally: [3] },
        },
        { igdbId: 7, timeToBeat: 0 },
        { igdbId: 7, timeToBeat: { hastily: "3", completely: 9 } },
        { igdbId: 7, timeToBeat: { hastily: 999 } },
        { igdbId: "7", timeToBeat: { hastily: { old: true } } },
        { igdbId: 0, timeToBeat: { normally: 999 } },
      ],
    ],
  ];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-17T00:00:00Z"));
  try {
    for (const expand of ["", "&expand=%EF%BB%BFfull%EF%BB%BF"]) {
      cases.push(
        await recorder.record(
          app,
          "franchise-historical-typed-" + (expand ? "full" : "card"),
          {
            method: "GET",
            path: `/franchises/${nativeId}?locale=es-ES${expand}`,
          },
          200,
          reads,
          null,
          ["server-timing"],
        ),
      );
    }
    for (let stage = 0; stage < 9; stage++) {
      cases.push(
        await recorder.record(
          app,
          `franchise-historical-service-failure-${stage}`,
          { method: "GET", path: `/franchises/${nativeId}?locale=es-ES` },
          500,
          reads,
          null,
          ["server-timing"],
          stage,
        ),
      );
    }
    const pre: Inputs[4] = [
      ["franchises", "one", { _id: "f", offers: [7] }],
      [
        "offers",
        "many",
        [{ id: 7, customAttributes: [{ key: 4, value: "v" }] }],
      ],
      [
        "offers",
        "many",
        [{ namespace: 7 }, { namespace: "7" }, { namespace: "7" }],
      ],
      ["pricev2", "many", []],
    ];
    await get("franchise-historical-namespace-count", "/franchises/f", 200, [
      ...pre,
      ["achievementsets", "many", [{}]],
      ["igdbs", "many", []],
    ]);
    for (const value of [[null], "legacy"]) {
      await get(
        "franchise-historical-malformed-achievements-" +
          (Array.isArray(value) ? "null" : "string"),
        "/franchises/f",
        500,
        [...pre, ["achievementsets", "many", [{ achievements: value }]]],
      );
    }
    await get(
      "franchise-historical-malformed-attribute",
      "/franchises/f",
      500,
      [
        pre[0],
        ["offers", "many", [{ id: 7, customAttributes: [null] }]],
        pre[2],
        pre[3],
      ],
    );
    for (const [label, offers] of [
      ["string", "abcdef"],
      ["object", { length: 2 }],
      ["number", 4],
    ] as const) {
      await get(
        "franchise-historical-malformed-membership-" + label,
        "/franchises/f",
        500,
        [
          ["franchises", "one", { _id: "f", offers }],
          [
            "offers",
            "many",
            new Error("Mongo rejects a non-array $in predicate"),
          ],
        ],
      );
    }
    for (const empty of [false, null, [], { length: 0 }]) {
      await get(
        "franchise-historical-empty-" + JSON.stringify(empty),
        "/franchises/f",
        200,
        [["franchises", "one", { _id: "f", offers: empty }]],
      );
    }
  } finally {
    vi.useRealTimers();
  }
  assertOracle("legacy-catalog-http-node", cases);
});
