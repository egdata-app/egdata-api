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
vi.mock("../src/db/index.js", () => ({
  db: { db: { collection: (name: string) => recorder.collection(name) } },
}));
vi.mock("../src/clients/response-cache.js", () => ({
  default: {
    get: (key: string) => recorder.cache.get(key),
    set: (...args: Parameters<typeof recorder.cache.set>) =>
      recorder.cache.set(...args),
  },
}));
vi.mock("../src/routes/sandbox-og.js", () => ({ default: new Hono() }));

it("executes all sandbox reads against the Node router", async () => {
  const app = new Hono();
  app.use("*", apiCors(), responseEtag, routeTemplate, edgeCacheHeaders);
  app.route("/sandboxes", (await import("../src/routes/sandbox.js")).default);
  type Reads = Parameters<typeof recorder.record>[4];
  const cases: Awaited<ReturnType<typeof recorder.record>>[] = [];
  const get = async (
    name: string,
    path: string,
    reads: Reads = [],
    status = 200,
    hit: unknown = null,
  ) => {
    const request = { method: "GET", path: "/sandboxes" + path };
    const baseline = await recorder.record(
      app,
      name,
      request,
      status,
      reads,
      hit,
    );
    cases.push(baseline);
    // Exercise the expensive fresh-read paths at each service boundary, including
    // promise groups that make independent reads after a sibling has failed.
    if (
      ![
        "sandbox-list-paged",
        "sandbox-detail",
        "sandbox-items-filters",
        "sandbox-localized-expanded",
        "sandbox-asset-filter",
        "sandbox-base-prepurchase",
        "sandbox-base-executable",
        "sandbox-achievements",
        "sandbox-changelog",
        "sandbox-builds",
        "sandbox-stats",
        "sandbox-sitemap-index",
        "sandbox-sitemap-page",
      ].includes(name)
    )
      return;
    const trace = baseline.trace as {
      call: { method: string; collection?: string };
    }[];
    if (trace[0].call.method === "get") {
      cases.push(
        await recorder.record(app, name + " cached", request, 200, [], {
          cached: name,
        }),
      );
    }
    for (const [index, { call }] of trace.entries()) {
      const label = [name, call.collection ?? "cache", call.method, index].join(
        " ",
      );
      cases.push(
        await recorder.record(app, label, request, 500, reads, null, [], index),
      );
    }
  };
  const date = new Date("2026-11-17T03:07:49.123Z");
  const box = { _id: "ns", name: "Sandbox", updated: date };
  const found: Reads[number] = ["sandboxes", "one", box];
  const missing: Reads[number] = ["sandboxes", "one", null];
  const item = {
    id: "it",
    namespace: "ns",
    title: "Title",
    releaseInfo: [
      { appId: "app", platform: ["Windows"] },
      { appId: "app2", platform: ["Mac", "Linux"] },
    ],
  };
  const offer = {
    id: "o",
    namespace: "ns",
    title: "A Game",
    items: [{ id: "it" }],
    offerType: "BASE_GAME",
    extra: "only in full",
  };
  const build = {
    _id: new ObjectId("65ba00000000000000000001"),
    appName: "app",
    labelName: "Live-Windows",
    hash: "abcdef",
    updatedAt: date,
  };
  const asset = {
    artifactId: "app",
    itemId: "it",
    platform: "Windows",
    updatedAt: date,
  };
  const sets = [{ sandboxId: "ns", achievements: [{ id: "a" }, { id: "b" }] }];
  await get("sandbox-list-paged", "?page=2&limit=3", [
    ["namespaces", "many", [box]],
    ["namespaces", "count", 7],
  ]);
  await get("sandbox-list-cache", "", [], 200, { elements: [], count: 0 });
  await get("sandbox-sitemap-index", "/sitemap.xml", [
    ["sandboxes", "count", 1001],
  ]);
  await get("sandbox-sitemap-page", "/sitemap.xml?page=2", [
    ["sandboxes", "many", [box]],
  ]);
  await get("sandbox-detail", "/ns", [found]);
  await get("sandbox-not-found", "/absent", [missing], 404);
  await get(
    "sandbox-items-filters",
    "/ns/items?entitlementType=FULL,DEMO&status=ACTIVE&platforms=Windows,Linux&title=Game&page=2&limit=4",
    [found, ["items", "count", 9], ["items", "many", [item]]],
  );
  await get("sandbox-items-cache", "/ns/items", [], 200, { elements: [item] });
  await get(
    "sandbox-offer-card",
    "/ns/offers?offerType=BASE_GAME,DLC&title=Game",
    [found, ["offers", "count", 1], ["offers", "many", [offer]]],
  );
  await get("sandbox-offer-expanded", "/ns/offers?expand=FuLl", [
    found,
    ["offers", "count", 1],
    ["offers", "many", [offer]],
  ]);
  await get("sandbox-offer-bad-locale", "/ns/offers?locale=es%2Fes", [], 400);
  const localized: Reads = [
    found,
    ["offers", "count", 1],
    ["offers", "many", [offer]],
    [
      "egs_localizations",
      "many",
      [
        {
          entityId: "ns:o",
          entityType: "offer",
          locale: "fr",
          data: { title: "Jeu", description: "Description traduite" },
          source: "egs",
          fetchedAt: new Date("2026-11-17T00:00:00.000Z"),
        },
      ],
    ],
  ];
  await get("sandbox-localized-card", "/ns/offers?locale=fr", localized);
  await get(
    "sandbox-localized-expanded",
    "/ns/offers?locale=fr&expand=1",
    localized,
  );
  await get("sandbox-offer-cache", "/ns/offers?locale=fr", [], 200, {
    elements: [],
  });
  await get("sandbox-asset-filter", "/ns/assets?platform=Windows", [
    found,
    ["items", "many", [item]],
    ["assets", "many", [asset]],
    ["assets", "count", 1],
  ]);
  await get(
    "sandbox-assets-bad-data",
    "/ns/assets",
    [
      found,
      ["items", "many", [{ id: "bad" }]],
      ["assets", "many", []],
      ["assets", "count", 0],
    ],
    500,
  );
  await get("sandbox-base-game", "/ns/base-game?country=US", [
    found,
    ["offers", "one", offer],
    ["pricev2", "one", { offerId: "o", price: 49 }],
  ]);
  await get("sandbox-base-prepurchase", "/ns/base-game", [
    found,
    ["offers", "one", null],
    ["offers", "one", offer],
    ["pricev2", "one", null],
  ]);
  await get("sandbox-base-executable", "/ns/base-game", [
    found,
    ["offers", "one", null],
    ["offers", "one", null],
    ["items", "one", item],
  ]);
  await get(
    "sandbox-base-missing",
    "/ns/base-game",
    [
      found,
      ["offers", "one", null],
      ["offers", "one", null],
      ["items", "one", null],
    ],
    404,
  );
  await get(
    "sandbox-base-country-missing",
    "/ns/base-game?country=XX",
    [],
    404,
  );
  await get("sandbox-achievements", "/ns/achievements", [
    found,
    ["achievementsets", "many", sets],
  ]);
  await get("sandbox-changelog", "/ns/changelog?page=2&limit=4", [
    found,
    ["offers", "many", [offer]],
    ["items", "many", [item]],
    ["assets", "many", [asset]],
    ["builds", "many", [build]],
    ["changelogs_v2", "aggregate", [{ timestamp: date, document: offer }]],
    ["changelogs_v2", "count", 5],
  ]);
  await get("sandbox-changelog-missing", "/ns/changelog", [missing], 404);
  await get(
    "sandbox-builds",
    "/ns/builds?platform=Windows,Mac&page=2&limit=1",
    [
      found,
      ["items", "many", [item]],
      ["builds", "many", [build]],
      ["builds", "count", 2],
    ],
  );
  await get("sandbox-stats", "/ns/stats", [
    found,
    ["offers", "count", 8],
    ["items", "many", [item]],
    ["achievementsets", "many", sets],
    ["assets", "many", [asset]],
    ["builds", "many", [build]],
  ]);
  await get("sandbox-sitemap-missing-id", "/sitemap.xml?page=1", [
    ["sandboxes", "many", [{ updated: date }, { _id: 42, updated: date }]],
  ]);
  await get(
    "sandbox-sitemap-invalid-updated",
    "/sitemap.xml?page=1",
    [["sandboxes", "many", [{ _id: "box" }]]],
    500,
  );
  await get("sandbox-empty-stats", "/ns/stats", [
    found,
    ["offers", "count", 0],
    ["items", "many", []],
    ["achievementsets", "many", [{}]],
    ["assets", "many", []],
    ["builds", "many", []],
  ]);
  await get("sandbox-stats-missing", "/ns/stats", [missing], 404);
  await get(
    "sandbox-changelog-invalid-items",
    "/ns/changelog",
    [found, ["offers", "many", [{}]]],
    500,
  );
  await get(
    "sandbox-changelog-missing-build-id",
    "/ns/changelog",
    [
      found,
      ["offers", "many", [offer]],
      ["items", "many", [item]],
      ["assets", "many", [asset]],
      ["builds", "many", [{}]],
    ],
    500,
  );
  await get(
    "sandbox-builds-invalid-release",
    "/ns/builds",
    [found, ["items", "many", [{}]]],
    500,
  );
  await get("sandbox-negative-asset-slice", "/ns/assets?page=-1&limit=1", [
    found,
    ["items", "many", []],
    [
      "assets",
      "many",
      [
        { ...asset, platform: "Linux", updatedAt: date },
        { ...asset, platform: "Windows", updatedAt: new Date(1) },
        { ...asset, platform: "Mac" },
      ],
    ],
    ["assets", "count", 3],
  ]);
  await get(
    "sandbox-assets-invalid-platform",
    "/ns/assets",
    [
      found,
      ["items", "many", [{ ...item, releaseInfo: [{ appId: "m" }] }]],
      ["assets", "many", []],
      ["assets", "count", 0],
    ],
    500,
  );
  await get("sandbox-assets-page-nan", "/ns/assets?page=abc", [
    found,
    ["items", "many", []],
    ["assets", "many", [asset]],
    ["assets", "count", 1],
  ]);
  await get(
    "sandbox-stats-invalid-releases",
    "/ns/stats",
    [
      found,
      ["offers", "count", 1],
      ["items", "many", [{ ...item, releaseInfo: null }]],
      ["achievementsets", "many", []],
      ["assets", "many", []],
    ],
    500,
  );
  await get(
    "sandbox-changelog-invalid-release",
    "/ns/changelog",
    [
      found,
      ["offers", "many", []],
      ["items", "many", [{ id: "it", releaseInfo: null }]],
      ["assets", "many", []],
    ],
    500,
  );
  await get(
    "sandbox-invalid-build-summary",
    "/ns/builds",
    [
      found,
      ["items", "many", [item]],
      ["builds", "many", [{}]],
      ["builds", "count", 1],
    ],
    500,
  );
  await get(
    "sandbox-base-invalid-locale",
    "/ns/base-game?locale=in%2Fvalid",
    [],
    400,
  );
  await get(
    "sandbox-base-localization-failure",
    "/ns/base-game?locale=fr",
    [
      found,
      ["offers", "one", offer],
      ["pricev2", "one", null],
      ["egs_localizations", "many", new Error("fixture read failed")],
    ],
    500,
  );
  assertOracle("legacy-sandbox-http-node", cases);
});
