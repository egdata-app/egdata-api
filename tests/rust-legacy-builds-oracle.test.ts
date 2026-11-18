import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { expect, it, vi } from "vitest";
import { assertOracle, captureResponse } from "../rust/oracles/record.js";
import { historicalComparisons } from "../rust/oracles/compare-manifests.js";
import { apiCors } from "../src/middlewares/cors.js";
import { edgeCacheHeaders } from "../src/middlewares/edge-cache.js";
import { responseEtag } from "../src/middlewares/response-etag.js";
import { routeTemplate } from "../src/middlewares/route-template.js";

const recorder = vi.hoisted(() => ({
  trace: [] as unknown[],
  scenario: "",
  cache: new Map<string, string>(),
  steps: new Map<string, unknown[]>(),
}));
type Row = Record<string, any>;
const oldId = "640000000000000000000011";
const newId = "640000000000000000000022";
const absentId = "640000000000000000000099";
const date = new Date("2025-03-07T01:02:03.000Z");
const oldBuild = {
  _id: new ObjectId(oldId),
  appName: "game",
  labelName: "Live-Windows",
  hash: "hashA",
  manifestStatus: "verified",
  manifestId: "snapA",
  buildVersion: "old",
  createdAt: date,
  updatedAt: date,
  downloadSizeBytes: 100,
  technologies: [{ section: "engine", technology: "A" }],
};
const newBuild = {
  ...oldBuild,
  _id: new ObjectId(newId),
  hash: "hashB",
  manifestId: "snapB",
  buildVersion: "new",
  previousObservedBuildId: oldBuild._id,
  downloadSizeBytes: 110,
  technologies: [{ section: "engine", technology: "B" }],
};
const item = {
  _id: new ObjectId("640000000000000000000055"),
  id: "item-1",
  title: "Game",
  namespace: "game-ns",
  releaseInfo: [{ appId: "game" }],
  entitlementType: "EXECUTABLE",
};
const filesA = [
  { fileName: "a.bin", fileHash: "h1", fileSize: 8 },
  { fileName: "b.bin", fileHash: "h2", fileSize: 10 },
];
const filesB = [
  { fileName: "a.bin", fileHash: "h3", fileSize: 5 },
  { fileName: "c.bin", fileHash: "h4", fileSize: 7 },
];

function typed(value: any, mongoQuery = false): any {
  if (value === undefined && mongoQuery) return null;
  if (value instanceof ObjectId) return { $oid: value.toHexString() };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value instanceof RegExp)
    return {
      $regularExpression: { pattern: value.source, options: value.flags },
    };
  if (Array.isArray(value))
    return value.map((entry) => typed(entry, mongoQuery));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined || mongoQuery)
        .map(([key, v]) => [key, typed(v, mongoQuery || key === "query")]),
    );
  return value;
}
function record(
  call: { method: string; collection?: string; [key: string]: unknown },
  result: any,
) {
  const steps = recorder.steps.get(
    call.collection ? call.collection + "." + call.method : call.method,
  );
  if (steps?.length) {
    const next = steps.shift();
    if (next === "FAIL") {
      recorder.trace.push({ call: typed(call), error: true });
      throw new Error("Fixture service unavailable");
    }
    result = next;
  }
  recorder.trace.push({ call: typed(call), result: typed(result) });
  return result;
}
function selectOne(name: string, q: Row) {
  if (name === "assets" && recorder.scenario === "sparse-detail")
    return { downloadSizeBytes: "unknown", installedSizeBytes: 150 };
  if (name === "assets")
    return { artifactId: "game", platform: "Windows", installedSizeBytes: 125 };
  if (name !== "builds" || String(q._id) === absentId) return null;
  if (q.createdAt) return oldBuild;
  if (String(q._id) === oldId) return oldBuild;
  if (recorder.scenario === "sparse-detail")
    return {
      _id: newBuild._id,
      appName: "game",
      platform: "Windows",
      technologies: [{ technology: "Engine", metadata: { version: 3 } }],
    };
  if (recorder.scenario === "incompatible")
    return { ...newBuild, appName: "another" };
  if (recorder.scenario === "unavailable")
    return { ...newBuild, manifestStatus: "processing" };
  if (recorder.scenario === "legacy-history")
    return { ...newBuild, previousObservedBuildId: undefined };
  return newBuild;
}
function selectMany(name: string, q: Row) {
  if (name === "items") {
    if (q.releaseInfo?.$elemMatch?.appId?.$eq === "unknown") return [];
    return [item];
  }
  if (name === "files") return q.manifestId?.$eq === "snapA" ? filesA : filesB;
  if (name === "builds") return [newBuild, oldBuild];
  if (name === "assets")
    return [{ itemId: "item-1", artifactId: "game", platform: "Windows" }];
  if (name === "offers") return [{ id: "base-game", offerType: "BASE_GAME" }];
  return [];
}
vi.mock("../src/db/index.js", () => ({
  db: {
    db: {
      collection: (collection: string) => ({
        findOne: async (query: Row = {}, options: Row = {}) =>
          record(
            { method: "one", collection, query, options },
            selectOne(collection, query),
          ),
        find: (query: Row = {}, options: Row = {}) => {
          const opts = { ...options };
          const execute = (method: string) =>
            record(
              { method, collection, query, options: opts },
              selectMany(collection, query),
            );
          const cursor = {
            sort: (sort: unknown) => {
              opts.sort = sort;
              return cursor;
            },
            skip: (skip: number) => {
              opts.skip = skip;
              return cursor;
            },
            limit: (limit: number) => {
              opts.limit = limit;
              return cursor;
            },
            toArray: async () => execute("many"),
            [Symbol.asyncIterator]: async function* () {
              yield* execute("stream");
            },
          };
          return cursor;
        },
        countDocuments: async (query: Row) =>
          record({ method: "count", collection, query, options: {} }, 7),
        aggregate: (query: Row[]) => ({
          toArray: async () =>
            record(
              { method: "aggregate", collection, query, options: {} },
              query.some((s) => s.$facet)
                ? [
                    {
                      nodes: [
                        {
                          type: "directory",
                          name: "art",
                          fileCount: 2,
                          totalSize: 7,
                        },
                        {
                          type: "file",
                          name: "demo.bin",
                          file: { fileName: "assets/demo.bin", fileSize: 2 },
                        },
                      ],
                      total: [{ count: 4 }],
                    },
                  ]
                : [{ _id: "lang", files: 4, size: 110 }],
            ),
        }),
      }),
    },
  },
}));
vi.mock("../src/clients/response-cache.js", () => ({
  default: {
    get: async (key: string) => {
      if (recorder.scenario.startsWith("legacy-build-raw-cache-")) {
        record({ method: "get", key }, { rawCache: "{" });
        return "{";
      }
      if (recorder.scenario === "list-cache-down") {
        recorder.trace.push({ call: { method: "get", key }, error: true });
        throw new Error("cache offline");
      }
      const value = recorder.cache.get(key);
      record({ method: "get", key }, value ? JSON.parse(value) : null);
      return value;
    },
    set: async (key: string, value: string, _mode: string, ttl: number) => {
      if (recorder.scenario === "list-cache-down") {
        recorder.trace.push({
          call: { method: "set", key, payload: JSON.parse(value), ttl },
          error: true,
        });
        throw new Error("cache offline");
      }
      record({ method: "set", key, payload: JSON.parse(value), ttl }, null);
      recorder.cache.set(key, value);
    },
  },
}));

it("records the legacy builds and launcher-resolution HTTP handlers against their native Mongo and Redis boundaries", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-17T00:00:00Z"));
  const builds = (await import("../src/routes/builds.js")).default;
  const launcher = (await import("../src/routes/build-launcher-records.js"))
    .default;
  const app = new Hono();
  app.use("*", apiCors(), responseEtag, routeTemplate, edgeCacheHeaders);
  app.route("/builds", builds);
  app.route("/builds", launcher);
  const cases: unknown[] = [];
  const basePath = "/builds/" + newId;
  async function check(
    name: string,
    path: string,
    status: number,
    rawBody?: string,
    steps: Record<string, readonly unknown[]> = {},
  ) {
    recorder.scenario = name;
    recorder.trace = [];
    recorder.steps = new Map(
      Object.entries(steps).map(([key, values]) => [key, [...values]]),
    );
    const request =
      rawBody === undefined
        ? { method: "GET", path }
        : {
            method: "POST",
            path,
            rawBody,
            headers: { "content-type": "text/plain" },
          };
    const response = await captureResponse(
      await app.request(path, {
        method: request.method,
        headers: request.headers,
        body: rawBody,
      }),
    );
    expect(response.status, name).toBe(status);
    cases.push({ name, request, trace: recorder.trace, response });
  }
  await check(
    "list",
    "/builds?limit=2&page=3&sortBy=updatedAt&sortDir=asc",
    200,
  );
  await check(
    "list-cache",
    "/builds?limit=2&page=3&sortBy=updatedAt&sortDir=asc",
    200,
  );
  await check("invalid-page", "/builds?limit=2&page=100001", 400);
  await check("invalid-sort", "/builds?sortDir=other", 400);
  await check("invalid-sort-field", "/builds?sortBy=other", 400);
  await check("detail", basePath, 200);
  await check("sparse-detail", basePath, 200);
  await check("list-cache-down", "/builds?limit=1", 200);
  await check("missing", "/builds/" + absentId, 404);
  await check("invalid", "/builds/not-an-id", 400);
  await check(
    "files",
    basePath +
      "/files?sort=fileSize&dir=desc&page=3&limit=2&q=a.b&extension=.p%2B%2B,bin",
    200,
  );
  await check("invalid-files", basePath + "/files?sort=x", 400);
  await check(
    "history",
    basePath + "/history?scope=platform&page=2&limit=2",
    200,
  );
  await check("legacy-history", basePath + "/history", 200);
  await check("invalid-history", basePath + "/history?scope=x", 400);
  await check("items", basePath + "/items?page=2&limit=2", 200);
  await check("invalid-items", basePath + "/items?limit=0", 400);
  await check("tree", basePath + "/tree?path=assets/&page=2&limit=2", 200);
  await check(
    "tree-cache",
    basePath + "/tree?path=assets/&page=2&limit=2",
    200,
  );
  await check("invalid-tree", basePath + "/tree?path=../", 400);
  await check("install-options", basePath + "/install-options", 200);
  const compare = basePath + "/compare/" + oldId;
  const page = compare + "?page=2&limit=1&extension=.BIN";
  await check("comparison", page, 200);
  await check("comparison-cache", page, 200);
  await check("incompatible", compare, 400);
  await check("unavailable", compare, 409);
  await check(
    "missing-compare",
    "/builds/" + absentId + "/compare/" + oldId,
    404,
  );
  await check("invalid-filter", compare + "?status=x", 400);
  const resolve = "/builds/resolve-launcher-records";
  await check("invalid-launcher", resolve, 400, "{");
  const candidates = ["game", "unknown"].map((buildAppName, i) => ({
    requestId: "id" + i,
    buildAppName,
    buildVersion: "",
    platform: "Windows",
  }));
  await check("launcher", resolve, 200, JSON.stringify({ candidates }));
  for (const suffix of [
    "/files",
    "/history",
    "/items",
    "/tree",
    "/install-options",
  ]) {
    await check("bad-id-" + suffix, "/builds/missing" + suffix, 400);
    await check("not-found-" + suffix, "/builds/" + absentId + suffix, 404);
    await check("lookup-failure-" + suffix, basePath + suffix, 500, undefined, {
      "builds.one": ["FAIL"],
    });
  }
  for (const [name, path, steps] of [
    ["detail-lookup", basePath, { "builds.one": ["FAIL"] }],
    ["detail-asset", basePath, { "assets.one": ["FAIL"] }],
    [
      "detail-malformed",
      basePath,
      { "builds.one": [{ _id: newBuild._id, appName: "game" }] },
    ],
    ["list-builds", "/builds?limit=4", { "builds.many": ["FAIL"] }],
    ["list-items", "/builds?limit=4", { "items.many": ["FAIL"] }],
    [
      "list-summary",
      "/builds?limit=4",
      { "builds.many": [[{ appName: "no-id" }]] },
    ],
    ["files-page", basePath + "/files", { "files.many": ["FAIL"] }],
    ["files-count", basePath + "/files", { "files.count": ["FAIL"] }],
    ["items-page", basePath + "/items", { "items.many": ["FAIL"] }],
    ["items-count", basePath + "/items", { "items.count": ["FAIL"] }],
    ["history-page", basePath + "/history", { "builds.many": ["FAIL"] }],
    ["history-count", basePath + "/history", { "builds.count": ["FAIL"] }],
    [
      "history-observed",
      basePath + "/history",
      { "builds.one": [newBuild, "FAIL"] },
    ],
    [
      "history-earlier",
      basePath + "/history",
      { "builds.one": [newBuild, null, "FAIL"] },
    ],
    [
      "history-summary",
      basePath + "/history",
      { "builds.many": [[{ platform: "Windows" }]] },
    ],
    [
      "tree-read",
      basePath + "/tree?path=failed",
      { "files.aggregate": ["FAIL"] },
    ],
    [
      "install-read",
      basePath + "/install-options",
      { "files.aggregate": ["FAIL"] },
    ],
  ] as const)
    await check("failure-" + name, path, 500, undefined, steps);
  const snapshots = [
    {
      ...newBuild,
      manifestStatus: "old-importer",
      manifestId: 5,
      previousObservedBuildId: "archived-identifier",
      updatedAt: "imported",
    },
    {
      ...newBuild,
      manifestStatus: null,
      sourceManifestHash: "prior-source",
      technologies: "unknown",
    },
    {
      ...newBuild,
      manifestId: "",
      hash: "",
      sourceManifestHash: null,
      manifestFileCount: "historical",
    },
    {
      _id: newBuild._id,
      platform: "Windows",
      appName: "game",
      labelName: "Live-Windows",
    },
  ];
  for (const [i, row] of snapshots.entries()) {
    for (const suffix of ["/files", "/tree", "/install-options", "/items"]) {
      const steps: Record<string, unknown[]> = { "builds.one": [row] };
      if (suffix === "/tree") {
        recorder.cache.clear();
        steps["files.aggregate"] = [[]];
      }
      await check(
        "snapshot-" + i + suffix,
        basePath + suffix,
        200,
        undefined,
        steps,
      );
    }
  }
  await check(
    "history-unverified-observed",
    basePath + "/history",
    200,
    undefined,
    {
      "builds.one": [
        snapshots[0],
        { ...oldBuild, manifestStatus: "unknown" },
        { _id: "archived-id" },
      ],
      "builds.many": [snapshots.slice(0, 3)],
    },
  );
  await check(
    "history-observed-wrong-platform",
    basePath + "/history",
    200,
    undefined,
    { "builds.one": [newBuild, { ...oldBuild, platform: "Mac" }, null] },
  );
  await check(
    "history-older-missing-id",
    basePath + "/history",
    500,
    undefined,
    { "builds.one": [newBuild, null, {}] },
  );
  await check(
    "install-historical-tags",
    basePath + "/install-options",
    200,
    undefined,
    {
      "files.aggregate": [
        [
          { _id: 7, files: 2 },
          { _id: false, size: 4 },
          { _id: ["audio", 1], files: 1, size: 9 },
          { files: 3, size: null },
        ],
      ],
    },
  );
  await check(
    "files-js-whitespace",
    basePath + "/files?extension=%EF%BB%BF.bin%EF%BB%BF&q=%EF%BB%BFfoo",
    200,
  );
  await check("bad-dir", basePath + "/files?dir=sideways", 400);
  await check("files-name-sort", basePath + "/files?sort=fileName", 200);
  await check("tree-js-types", basePath + "/tree?path=old", 200, undefined, {
    "files.aggregate": [
      [
        {
          nodes: [
            { type: "file", name: 7 },
            { type: "file", name: null },
            { type: "file" },
          ],
          total: [{ count: "3" }],
        },
      ],
    ],
  });
  await check("tree-js-root-types", basePath + "/tree", 200, undefined, {
    "files.aggregate": [
      [
        {
          nodes: [{ type: "file", name: 7 }, { type: "file" }],
          total: [{ count: 2 }],
        },
      ],
    ],
  });
  await check(
    "launcher-db-failure",
    resolve,
    500,
    JSON.stringify({ candidates }),
    { "items.many": ["FAIL"] },
  );
  await check(
    "launcher-whitespace",
    resolve,
    200,
    JSON.stringify({
      candidates: [{ ...candidates[0], requestId: "\uFEFFid\uFEFF" }],
    }),
  );
  await check("legacy-build-raw-cache-list", "/builds?limit=3", 500);
  await check(
    "legacy-build-raw-cache-tree",
    basePath + "/tree?path=cache",
    500,
  );
  for (const route of [
    "/builds",
    basePath + "/files",
    basePath + "/history",
    basePath + "/tree",
  ])
    await check("bad-page-" + route, route + "?page=0", 400);
  await check("bad-detail-summary", basePath, 500, undefined, {
    "builds.one": [{ ...newBuild, _id: null }],
  });
  await check("history-missing-label", basePath + "/history", 500, undefined, {
    "builds.one": [{ _id: newBuild._id }],
  });
  await check(
    "history-nonstring-platform",
    basePath + "/history?scope=platform",
    500,
    undefined,
    { "builds.one": [{ ...newBuild, platform: 17 }] },
  );
  await check(
    "history-observed-bad-label",
    basePath + "/history",
    500,
    undefined,
    { "builds.one": [newBuild, { ...oldBuild, labelName: null }] },
  );
  await check(
    "history-observed-bad-id",
    basePath + "/history",
    500,
    undefined,
    { "builds.one": [newBuild, { ...oldBuild, _id: null }] },
  );
  await check(
    "history-empty-observed-id",
    basePath + "/history",
    200,
    undefined,
    { "builds.one": [newBuild, { ...oldBuild, _id: "" }, { _id: 7 }] },
  );
  await check(
    "history-without-created",
    basePath + "/history",
    200,
    undefined,
    {
      "builds.one": [
        { ...newBuild, createdAt: null, previousObservedBuildId: null },
        null,
      ],
    },
  );
  for (const [label, facet] of [
    ["null-node", { nodes: [null], total: [] }],
    ["object-nodes", { nodes: {}, total: [] }],
    ["no-total", { nodes: [] }],
  ] as const) {
    await check(
      "tree-error-" + label,
      basePath + "/tree?path=" + label,
      500,
      undefined,
      { "files.aggregate": [[facet]] },
    );
  }
  await check("comparison-invalid-platform", compare, 500, undefined, {
    "builds.one": [{ ...newBuild, labelName: null }, oldBuild],
  });
  for (const { name, base, target, legacy } of historicalComparisons) {
    recorder.cache.clear();
    await check("compare-history-" + name, compare, legacy, undefined, {
      "builds.one": [
        { ...newBuild, ...target },
        { ...oldBuild, ...base },
      ],
    });
  }
  for (const [name, path] of [
    ["target-id", "/builds/invalid/compare/" + oldId],
    ["base-id", basePath + "/compare/invalid"],
    ["bad-page", compare + "?page=0"],
    ["bad-direction", compare + "?dir=other"],
    ["long-search", compare + "?q=" + "x".repeat(201)],
    [
      "many-extensions",
      compare +
        "?extension=" +
        Array.from({ length: 21 }, (_, i) => "e" + i).join(","),
    ],
  ]) {
    await check("compare-" + name, path, 400);
  }
  for (const [name, target, base] of [
    ["target-lookup-failed", "FAIL", oldBuild],
    ["base-lookup-failed", newBuild, "FAIL"],
    ["invalid-parent-platform", newBuild, { ...oldBuild, labelName: null }],
    ["target-summary-no-id", { ...newBuild, _id: null }, oldBuild],
    ["base-summary-no-id", newBuild, { ...oldBuild, _id: null }],
    [
      "base-technologies-not-iterable",
      newBuild,
      { ...oldBuild, technologies: "old" },
    ],
  ] as const) {
    recorder.cache.clear();
    await check("compare-" + name, compare, 500, undefined, {
      "builds.one": [target, base],
    });
  }
  recorder.cache.clear();
  await check("compare-file-stream-failure", compare, 500, undefined, {
    "files.stream": ["FAIL"],
  });
  await check("legacy-build-raw-cache-compare", compare, 500);
  await check(
    "compare-descending-no-updated",
    compare + "?dir=desc&status=unchanged",
    200,
    undefined,
    { "builds.one": [{ ...newBuild, updatedAt: null }, oldBuild] },
  );
  await check(
    "compare-js-whitespace",
    compare + "?q=%EF%BB%BFa%EF%BB%BF&extension=%EF%BB%BF.bin",
    200,
  );
  const historicalStream = () => ({
    platform: ["Windows"],
    labelName: ["live"],
  });
  await check(
    "historical-stream-reference-identity",
    basePath + "/history",
    200,
    undefined,
    {
      "builds.one": [
        { ...newBuild, ...historicalStream() },
        { ...oldBuild, ...historicalStream() },
        null,
      ],
      "builds.many": [[{ ...oldBuild, ...historicalStream() }]],
    },
  );
  await check(
    "tree-primitive-nodes",
    basePath + "/tree?path=historical",
    200,
    undefined,
    {
      "files.aggregate": [
        [{ nodes: [false, 12, "old", ["value"]], total: [{ count: 4 }] }],
      ],
    },
  );
  assertOracle("legacy-builds-http-node", cases);
  vi.useRealTimers();
});
