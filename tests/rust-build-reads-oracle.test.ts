import { encodeCursor, type CursorSortTuple } from "../src/v1/cursor.js";
import { Hono } from "hono";
import { BSON, Decimal128, Double, Long, ObjectId } from "mongodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertOracle, captureResponse, fixtureValue } from "../rust/oracles/record.js";
import { historicalComparisons } from "../rust/oracles/compare-manifests.js";
import { responseEtag } from "../src/middlewares/response-etag.js";
import { ProblemError, problemResponse } from "../src/v1/errors.js";
import { v1CachePolicy, v1Context } from "../src/v1/request-context.js";

const state = vi.hoisted(() => ({
  input: {} as Record<string, any>,
  writes: new Map<string, string>(),
  filters: [] as unknown[],
  cacheExpirations: [] as Array<{ key: string; ttl: number }>,
}));
const query = (rows: unknown[], streamSide?: string) => {
  const cursor = {
    sort: vi.fn(() => cursor),
    limit: vi.fn(() => cursor),
    toArray: vi.fn(async () => rows),
    [Symbol.asyncIterator]: async function* () {
      if (state.input.failStage === "read-file-stream")
        throw new Error("private cursor failure");
      for (let index = 0; index <= rows.length; index++) {
        if (
          streamSide &&
          state.input.failStage === `${streamSide}-next-${index}`
        )
          throw new Error("private stream failure");
        if (index < rows.length) yield rows[index];
      }
    },
  };
  return cursor;
};

vi.mock("../src/db/index.js", () => ({
  db: {
    db: {
      collection: (name: string) => ({
        countDocuments: async (filter: Record<string, unknown>) => {
          state.filters.push(filter);
          if (state.input.failStage === "count") throw new Error("private count failure");
          return state.input.total ?? (name === "files" ? (state.input.fileRows?.length ?? 0) : filter.appName ? (state.input.historyRows?.length ?? 0) : (state.input.listRows?.length ?? 0) + (state.input.nullRows?.length ?? 0));
        },
        findOne: async (filter: Record<string, any>) => {
          if (state.input.databaseError && name === state.input.errorCollection)
            throw new Error("private build database error");
          if (name !== "builds") return null;
          if (
            (state.input.failStage === "previous" && filter.createdAt) ||
            (state.input.failStage === "observed" &&
              filter.manifestStatus &&
              !filter.createdAt)
          )
            throw new Error("private history error");
          if (filter.createdAt) return state.input.earlier ?? null;
          if (filter.manifestStatus) return state.input.observed ?? null;
          if (state.input.missingBuild) return null;
          if (
            state.input.baseSnapshot &&
            String(filter._id) === String(state.input.baseSnapshot._id)
          )
            return state.input.baseSnapshot;
          return state.input.build ?? null;
        },
        find: (
          filter: Record<string, any>,
          options?: { projection?: Record<string, number> },
        ) => {
          if (state.input.databaseError && name === state.input.errorCollection)
            return {
              sort() {
                return this;
              },
              limit() {
                return this;
              },
              toArray: async () => {
                throw new Error("private snapshot database error");
              },
            };
          if (name === "builds") {
            if (state.input.failStage === "history-page")
              return {
                sort() {
                  return this;
                },
                limit() {
                  return this;
                },
                toArray: async () => {
                  throw new Error("private listing error");
                },
              };
            if (filter.manifestId || filter._id?.$ne) return query([]);
            if (filter.createdAt?.$ne === null)
              return query(state.input.listRows ?? []);
            if (
              filter.createdAt === null &&
              state.input.failStage === "null-phase"
            )
              throw new Error("private null page failure");
            if (
              filter.createdAt === null ||
              filter.updatedAt === null ||
              filter.firstSeenAt === null
            )
              return query(state.input.nullRows ?? []);
            if (
              filter.appName ||
              filter.$and?.some(
                (clause: Record<string, unknown>) => clause.appName,
              )
            )
              return query(state.input.historyRows ?? []);
            if (!filter.appName) return query(state.input.listRows ?? []);
            return query(state.input.historyRows ?? []);
          }
          if (name === "files") {
            state.filters.push(filter);
            if (
              state.input.failStage === "target-open" &&
              filter.manifestId?.$eq === state.input.build?.manifestId
            )
              throw new Error("private target snapshot failure");
            const rows =
              state.input.baseSnapshot &&
              filter.manifestId?.$eq === state.input.baseSnapshot.manifestId
                ? state.input.baseFiles
                : state.input.fileRows;
            if (
              options?.projection?.fileHash === 1 &&
              options.projection._id === 0
            ) {
              const projection = options.projection;
              return query(
                (rows ?? []).map((row: Record<string, unknown>) =>
                  Object.fromEntries(
                    Object.entries(row).filter(
                      ([key]) => projection[key] === 1,
                    ),
                  ),
                ),
                filter.manifestId?.$eq === state.input.baseSnapshot?.manifestId
                  ? "base"
                  : "target",
              );
            }
            return query(rows ?? []);
          }
          return query([]);
        },
        aggregate: (pipeline: Array<Record<string, unknown>>) => {
          if (pipeline.at(-1)?.$count === "total") {
            state.filters.push(pipeline);
            return {toArray: async () => [{total:state.input.total ?? state.input.treeRows?.length ?? 0}]};
          }
          if (name === "files") state.filters.push(pipeline[0]?.$match);
          if (state.input.databaseError && name === state.input.errorCollection)
            return {
              toArray: async () => {
                throw new Error("private snapshot database error");
              },
            };
          return {
            toArray: async () =>
              (pipeline.some(stage => stage.$unwind === "$installTags") ? state.input.installOptionRows : state.input.treeRows) ?? [],
          };
        },
      }),
    },
  },
}));
vi.mock("../src/models/index.js", () => ({
  Asset: {
    findOne: () => ({
      lean: async () => {
        if (state.input.errorCollection === "assets")
          throw new Error("private asset failure");
        return state.input.asset ?? null;
      },
    }),
    find: async () => state.input.assets ?? [],
  },
  Offer: { find: async () => state.input.launcherOffers ?? [] },
  Item: {
    countDocuments: async (filter:Record<string,unknown>) => {
      state.filters.push(filter);
      if (state.input.failStage === "count") throw new Error("private count failure");
      return state.input.total ?? state.input.itemRows?.length ?? 0;
    },
    find: (filter: Record<string, any>) => {
      state.filters.push(filter);
      if (state.input.errorCollection === "items")
        return Object.assign([], {
          lean: async () => {
            throw new Error("private item failure");
          },
        });
      const rows =
        typeof filter["releaseInfo.appId"] === "string"
          ? (state.input.itemRows ?? [])
          : (state.input.items ?? []);
      return Object.assign([...rows], { lean: async () => rows });
    },
  },
}));
vi.mock("../src/clients/response-cache.js", () => ({
  default: {
    get: async (key: string) => state.input.cached?.[key] ?? null,
    set: async (key: string, value: string, mode: string, ttl: number) => {
      expect(mode).toBe("EX");
      state.cacheExpirations.push({ key, ttl });
      state.writes.set(key, value);
      return "OK";
    },
  },
}));

import builds from "../src/v1/routes/builds.js";

const app = new Hono();
app.use("*", v1Context());
app.use("*", responseEtag);
app.use("*", v1CachePolicy());
app.route("/v1", builds);
app.onError((error, c) =>
  problemResponse(
    c,
    error instanceof ProblemError
      ? error
      : new ProblemError({
          status: 500,
          code: "INTERNAL_ERROR",
          detail:
            "The API could not complete the request. Retry later and include the request ID when contacting support.",
        }),
  ),
);

const headers = {
  "x-egdata-key-id": "key_oracle",
  "x-egdata-key-tier": "free",
  "x-request-id": "req_node_oracle",
};
const id = "507f1f77bcf86cd799439011";
const baseBuild = () => ({
  _id: new ObjectId(id),
  appName: "TestApp",
  buildVersion: "1.0.0",
  labelName: "Test-Windows",
  platform: "Windows",
  hash: "source-hash",
  sourceManifestHash: "source-hash",
  manifestId: "manifest-current",
  manifestStatus: "verified",
  manifestParserVersion: "1",
  manifestFileCount: 2,
  manifestFileBytes: 17,
  firstSeenAt: new Date("2026-10-02T00:00:00.000Z"),
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
  updatedAt: new Date("2026-10-03T00:00:00.000Z"),
});
const historyRow = (rowId: string, firstSeenAt: string, createdAt: string) => ({
  _id: new ObjectId(rowId),
  appName: "TestApp",
  buildVersion: rowId.endsWith("12") ? "0.9.0" : "1.0.0",
  labelName: "Test-Windows",
  platform: "Windows",
  hash: `hash-${rowId.slice(-2)}`,
  manifestId: `manifest-${rowId.slice(-2)}`,
  manifestStatus: "verified",
  firstSeenAt: new Date(firstSeenAt),
  createdAt: new Date(createdAt),
});
const fileRow = (name: string, depth: number, size: number) => ({
  _id: new ObjectId(
    name === "alpha.txt"
      ? "507f1f77bcf86cd799439021"
      : "507f1f77bcf86cd799439022",
  ),
  manifestId: "manifest-current",
  appName: "TestApp",
  buildVersion: "1.0.0",
  appLabel: "Test-Windows",
  fileName: name,
  fileHash: `hash-${name}`,
  fileSize: size,
  mimeType: "application/octet-stream",
  depth,
  installTags: ["base"],
});

describe("registered build history and snapshot Node oracle", () => {
  afterEach(() => {
    vi.useRealTimers();
    state.input = {};
  });

  it("records first, final, invalid-cursor, missing, and database-error reads", async () => {
    process.env.V1_CURSOR_SECRET =
      "test-cursor-secret-that-is-at-least-32-chars";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-17T00:00:00.000Z"));
    const cases: any[] = [];
    const record = async (
      name: string,
      path: string,
      input: Record<string, unknown>,
    ) => {
      state.input = input.nativeFiles
        ? {
            ...input,
            ...BSON.deserialize(
              BSON.serialize({
                fileRows: input.fileRows,
                baseFiles: input.baseFiles,
              }),
            ),
          }
        : input;
      state.writes.clear();
      state.cacheExpirations = [];
      state.filters = [];
      const method = (input.method as string | undefined) ?? "GET";
      const body = input.body;
      const request = { method, path, ...(body ? { body } : {}) };
      const response = await captureResponse(
        await app.request(path, {
          headers: body
            ? { ...headers, "content-type": "application/json" }
            : headers,
          ...(body ? { method, body: JSON.stringify(body) } : {}),
        }),
      );
      cases.push({
        name,
        request,
        input: input.nativeFiles
          ? {
              ...input,
              fileRows: fixtureValue(input.fileRows),
              baseFiles: fixtureValue(input.baseFiles),
            }
          : input,
        response,
        cacheWrites: state.cacheExpirations,
        ...(input.traceFilters ? { filters: state.filters } : {}),
      });
      return response;
    };

    const linkedBuild = { ...baseBuild(), manifestFileBytes: 4_294_967_297 };
    const linkedItem = {
      _id: new ObjectId("507f1f77bcf86cd799439031"),
      id: "test-app-item",
      namespace: "TestApp",
      title: "Test App Catalog Entry",
      itemType: "APP",
      entitlementType: "EXECUTABLE",
      keyImages: [],
      categories: [],
      releaseInfo: [{ appId: "TestApp" }],
      linkedOffers: [],
      builds: [],
      customAttributes: [],
    };
    await record("build-list-linked-item", "/v1/builds?limit=10", {
      listRows: [linkedBuild],
      items: [linkedItem],
    });

    const datedBuild = {
      ...baseBuild(),
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    };
    const nullDateBuild = {
      ...baseBuild(),
      _id: new ObjectId("507f1f77bcf86cd799439032"),
    };
    delete (nullDateBuild as Record<string, unknown>).createdAt;
    const ascendingPath = "/v1/builds?limit=1&sortBy=createdAt&sortDir=asc";
    const ascendingFirst = await record(
      "build-list-ascending-date-first",
      ascendingPath,
      {
        listRows: [datedBuild],
        nullRows: [nullDateBuild],
        items: [],
      },
    );
    const ascendingCursor = ascendingFirst.body.meta.pagination
      .nextCursor as string;
    await record(
      "build-list-ascending-date-null-continuation",
      `${ascendingPath}&cursor=${encodeURIComponent(ascendingCursor)}`,
      { listRows: [], nullRows: [nullDateBuild], items: [] },
    );

    const detailBuild = {
      ...baseBuild(),
      downloadSizeBytes: undefined,
      installedSizeBytes: undefined,
    };
    await record("build-detail-asset-fallback", `/v1/builds/${id}`, {
      build: detailBuild,
      asset: { downloadSizeBytes: 8_589_934_594, installedSizeBytes: 12_345 },
    });
    await record("build-detail-missing", `/v1/builds/${id}`, {
      missingBuild: true,
    });

    const itemRow = (itemId: string, suffix: string) => ({
      _id: new ObjectId(`507f1f77bcf86cd7994390${suffix}`),
      id: itemId,
      namespace: "TestApp",
      title: `Build Item ${itemId}`,
      description: null,
      longDescription: null,
      itemType: "APP",
      creationDate: null,
      lastModifiedDate: null,
      releaseDate: null,
      keyImages: [],
      categories: [],
      developer: null,
      entitlementName: null,
      entitlementType: "EXECUTABLE",
      status: null,
      url: null,
      linkedOffers: [],
      builds: [],
      customAttributes: [],
      releaseInfo: [{ appId: "TestApp" }],
    });
    const buildItems = [itemRow("item-a", "41"), itemRow("item-b", "42")];
    const itemsPath = `/v1/builds/${id}/items?limit=1`;
    const itemsFirst = await record("build-items-first-page", itemsPath, {
      build: baseBuild(),
      itemRows: buildItems,
    });
    const itemsCursor = itemsFirst.body.meta.pagination.nextCursor as string;
    await record(
      "build-items-final-page-node-cursor",
      `${itemsPath}&cursor=${encodeURIComponent(itemsCursor)}`,
      { build: baseBuild(), itemRows: [buildItems[1]] },
    );

    await record(
      "build-install-options-populated",
      `/v1/builds/${id}/install-options`,
      {
        build: baseBuild(),
        installOptionRows: [
          { _id: "base", files: 2, size: 4096 },
          { _id: "optional", files: 1, size: 100 },
        ],
      },
    );
    await record(
      "build-compare-populated",
      `/v1/builds/${id}/compare/${id}?limit=10`,
      {
        build: baseBuild(),
        fileRows: [fileRow("shared.txt", 0, 32)],
      },
    );
    const baseSnapshot = {
      ...baseBuild(),
      _id: new ObjectId("507f1f77bcf86cd799439012"),
      manifestId: "manifest-earlier",
      buildVersion: "0.9",
    };
    const comparePath = `/v1/builds/${id}/compare/${baseSnapshot._id}?limit=1`;
    const comparison = {
      build: baseBuild(),
      baseSnapshot,
      baseFiles: [fileRow("before.txt", 0, 40), fileRow("modified.txt", 0, 10)],
      fileRows: [
        fileRow("after.txt", 0, 20),
        { ...fileRow("modified.txt", 0, 12), fileHash: "changed" },
      ],
    };
    const firstComparison = await record(
      "build-compare-changes",
      comparePath,
      comparison,
    );
    expect(firstComparison.body.data.changes[0].status).toBe("added");
    const cached = Object.fromEntries(state.writes);
    expect(Object.keys(cached)).toHaveLength(1);
    const nextComparison = firstComparison.body.meta.pagination.nextCursor;
    expect(nextComparison).toBeTypeOf("string");
    await record(
      "build-compare-continuation",
      `${comparePath}&cursor=${encodeURIComponent(nextComparison)}`,
      comparison,
    );
    await record("build-compare-cached", comparePath, {
      build: comparison.build,
      baseSnapshot,
      cached,
    });
    await record(
      "launcher-records-invalid-body",
      "/v1/builds/resolve-launcher-records",
      {
        method: "POST",
        body: {},
      },
    );

    const launcherItem = {
      id: "launcher-item",
      namespace: "launcher-ns",
      title: "Launcher Game",
      itemType: "APP",
      entitlementType: "EXECUTABLE",
      categories: [],
      customAttributes: [],
    };
    const launcherAsset = {
      itemId: "launcher-item",
      artifactId: "LauncherApp",
      platform: "Windows",
    };
    const launcherOffer = {
      id: "launcher-offer",
      offerType: "BASE_GAME",
      items: [{ id: "launcher-item" }],
      customAttributes: [],
    };
    await record(
      "launcher-records-resolved",
      "/v1/builds/resolve-launcher-records",
      {
        method: "POST",
        body: {
          candidates: [
            {
              requestId: "request-1",
              buildAppName: "LauncherApp",
              buildVersion: "1.0",
              platform: "Windows",
              catalogHint: {
                artifactId: "LauncherApp",
                catalogItemId: "launcher-item",
                catalogNamespace: "launcher-ns",
              },
            },
          ],
        },
        items: [launcherItem],
        assets: [launcherAsset],
        launcherOffers: [launcherOffer],
      },
    );

    const launcherBody = {
      candidates: [
        {
          requestId: "fixture",
          buildAppName: "LauncherApp",
          buildVersion: "1.0",
          platform: "Windows",
        },
      ],
    };
    const defaultLauncherRows = {
      items: [launcherItem], assets: [launcherAsset], launcherOffers: [launcherOffer],
    };
    for (const [label, overrides] of [
      [
        "object-display-name",
        { items: [{ ...launcherItem, title: { en: "Game" } }] },
      ],
      [
        "composite-display-name",
        { items: [{ ...launcherItem, title: ["Demo", null, 7] }] },
      ],
      ["numeric-display-name", { items: [{ ...launcherItem, title: 1e-7 }] }],
      [
        "array-identity",
        {
          items: [{ ...launcherItem, namespace: ["store", 42] }],
          assets: [{ ...launcherAsset, artifactId: ["old", 2] }],
        },
      ],
      [
        "historical-offer-ids",
        {
          launcherOffers: [
            { ...launcherOffer, id: null, _id: 42 },
            { ...launcherOffer, id: "42" },
            { ...launcherOffer, id: "", offerType: "DLC" },
          ],
        },
      ],
      [
        "missing-windows-asset",
        { assets: [{ ...launcherAsset, platform: "Mac" }] },
      ],
      [
        "addon-without-base",
        {
          items: [{ ...launcherItem, categories: [{ path: "games/addon" }] }],
          launcherOffers: [],
        },
      ],
      [
        "addon-with-ambiguous-base",
        {
          items: [{ ...launcherItem, categories: ["DLC"] }],
          launcherOffers: [launcherOffer, { ...launcherOffer, id: "second" }],
        },
      ],
      [
        "missing-catalog-namespace",
        { items: [{ ...launcherItem, namespace: null }] },
      ],
      [
        "ineligible-item",
        {
          items: [{ ...launcherItem, entitlementType: "DURABLE" }],
          launcherOffers: [],
        },
      ],
    ] as const) {
      const response = await record(
        "launcher-" + label,
        "/v1/builds/resolve-launcher-records",
        {
          method: "POST",
          body: launcherBody,
          ...defaultLauncherRows,
          ...overrides,
        },
      );
      expect(response.status).toBe(200);
      const result = response.body.data.results[0];
      if (label === "array-identity")
        expect(result.record.artifactId).toBe("old,2");
      if (label === "object-display-name")
        expect(result.record.displayName).toBe("[object Object]");
    }
    const historyBuild = baseBuild();
    const historyRows = [
      historyRow(
        "507f1f77bcf86cd799439011",
        "2026-10-02T00:00:00.000Z",
        "2026-10-01T00:00:00.000Z",
      ),
      historyRow(
        "507f1f77bcf86cd799439012",
        "2026-10-01T00:00:00.000Z",
        "2026-09-30T00:00:00.000Z",
      ),
    ];
    const historyFirst = await record(
      "history-first-page",
      `/v1/builds/${id}/history?limit=1`,
      { build: historyBuild, historyRows },
    );
    const historyCursor = historyFirst.body.meta.pagination
      .nextCursor as string;
    await record(
      "history-final-page-node-cursor",
      `/v1/builds/${id}/history?limit=1&cursor=${encodeURIComponent(historyCursor)}`,
      { build: historyBuild, historyRows: [historyRows[1]] },
    );
    await record(
      "history-invalid-cursor",
      `/v1/builds/${id}/history?limit=1&cursor=bad`,
      { build: historyBuild },
    );
    await record("history-missing-build", `/v1/builds/${id}/history`, {
      missingBuild: true,
    });

    const filesBuild = baseBuild();
    const fileRows = [fileRow("alpha.txt", 0, 7), fileRow("beta.txt", 0, 10)];
    const filesFirst = await record(
      "files-first-page",
      `/v1/builds/${id}/files?limit=1`,
      { build: filesBuild, fileRows },
    );
    const filesCursor = filesFirst.body.meta.pagination.nextCursor as string;
    await record(
      "files-final-page-node-cursor",
      `/v1/builds/${id}/files?limit=1&cursor=${encodeURIComponent(filesCursor)}`,
      { build: filesBuild, fileRows: [fileRows[1]] },
    );
    await record(
      "files-invalid-cursor",
      `/v1/builds/${id}/files?limit=1&cursor=bad`,
      { build: filesBuild },
    );
    await record("files-database-error", `/v1/builds/${id}/files?limit=1`, {
      build: filesBuild,
      databaseError: true,
      errorCollection: "files",
    });

    const treeBuild = baseBuild();
    const treeRows = [
      { type: "directory", name: "Engine", fileCount: 1, totalSize: 10 },
      {
        type: "file",
        name: "README.txt",
        file: {
          fileName: "README.txt",
          fileSize: 7,
          mimeType: "text/plain",
          depth: 0,
        },
      },
    ];
    const treeFirst = await record(
      "tree-first-page",
      `/v1/builds/${id}/tree?limit=1`,
      { build: treeBuild, treeRows },
    );
    const treeCursor = treeFirst.body.meta.pagination.nextCursor as string;
    await record(
      "tree-final-page-node-cursor",
      `/v1/builds/${id}/tree?limit=1&cursor=${encodeURIComponent(treeCursor)}`,
      { build: treeBuild, treeRows: [treeRows[1]] },
    );
    await record(
      "tree-invalid-cursor",
      `/v1/builds/${id}/tree?limit=1&cursor=bad`,
      { build: treeBuild, treeRows: [] },
    );

    const manyExtensions = Array.from({ length: 21 }, (_, i) => `ext${i}`).join(
      ",",
    );
    const snapshotPath = `/v1/builds/${id}`;
    for (const [suffix, queryString] of [
      ["", "sortBy=hash&sortDir=up&debug=1"],
      ["/history", "scope=channel&debug=1"],
      [
        "/files",
        "sort=hash&dir=down&q=" +
          "x".repeat(201) +
          "&extension=" +
          "y".repeat(501) +
          "&debug=1",
      ],
      ["/files", "extension=" + manyExtensions],
      ["/files", "q=" + "x".repeat(201)],
      ["/tree", "path=" + "x".repeat(501)],
      ["/tree", "path=../unavailable"],
      ["/items", "wrong=1"],
      ["/install-options", "unexpected=1"],
      ["/detail", "unexpected=1"],
      ["/compare/" + id, "dir=up&status=" + "m".repeat(501) + "&unexpected=1"],
      ["/compare/" + id, "extension=" + manyExtensions],
      ["/compare/" + id, "status=invalid"],
    ]) {
      const route =
        suffix === ""
          ? "/v1/builds"
          : snapshotPath + (suffix === "/detail" ? "" : suffix);
      await record(
        "reject-" + suffix + "-" + cases.length,
        route + "?" + queryString,
        { build: historyBuild },
      );
    }
    for (const suffix of [
      "",
      "/history",
      "/files",
      "/tree",
      "/items",
      "/compare/" + id,
    ]) {
      await record(
        "invalid-limit-" + suffix,
        (suffix ? snapshotPath + suffix : "/v1/builds") + "?limit=zero",
        { build: historyBuild },
      );
    }
    for (const suffix of ["/items", "/install-options", "/files", "/tree"]) {
      await record(
        "missing-" + suffix,
        snapshotPath +
          suffix +
          (suffix === "/tree"
            ? "?path=../bad"
            : suffix === "/files"
              ? "?cursor=bad"
              : ""),
        { missingBuild: true },
      );
    }
    const warmCases: Array<[string, string, Record<string, unknown>]> = [
      [
        "list",
        "/v1/builds?sortBy=firstSeenAt&limit=2",
        { listRows: [historyBuild] },
      ],
      ["detail", snapshotPath, { build: historyBuild }],
      [
        "history",
        snapshotPath + "/history?scope=platform",
        { build: historyBuild, historyRows, earlier: baseSnapshot },
      ],
      [
        "files",
        snapshotPath + "/files?sort=fileName&dir=desc&q=alp&extension=.TXT,txt",
        { build: historyBuild, fileRows: fileRows.slice(0, 1) },
      ],
      [
        "tree",
        snapshotPath + "/tree?path=Engine",
        { build: historyBuild, treeRows },
      ],
      [
        "items",
        snapshotPath + "/items",
        { build: historyBuild, itemRows: buildItems },
      ],
      [
        "install-options",
        snapshotPath + "/install-options",
        {
          build: historyBuild,
          installOptionRows: [{ _id: "core", files: 3, size: 144 }],
        },
      ],
    ];
    for (const [name, path, input] of warmCases) {
      const pageable = ["list", "history", "files", "tree", "items"].includes(name);
      const cold = await record(name + "-cold", path, { ...input, total: 41 });
      expect(cold.status).toBe(200);
      const cached = Object.fromEntries(state.writes);
      const totals = Object.entries(cached).filter(([key]) => key.includes(".total:"));
      expect(Object.keys(cached)).toHaveLength(pageable ? 2 : 1);
      expect(totals).toHaveLength(pageable ? 1 : 0);
      if (pageable) {
        expect(cold.body.meta.pagination.total).toBe(41);
        const warmTotal = await record(name + "-warm-total", path, {
          ...input, failStage: "count", cached: Object.fromEntries(totals),
        });
        expect(warmTotal.body.meta.pagination.total).toBe(41);
        expect(state.writes.has(totals[0][0])).toBe(false);
      }
      await record(name + "-warm", path, { build: historyBuild, cached });
    }
    const failedTotal = await record("list-count-outage", "/v1/builds", { failStage: "count" });
    expect(failedTotal.status).toBe(500);
    await record("history-observed", snapshotPath + "/history", {
      build: { ...historyBuild, previousObservedBuildId: baseSnapshot._id },
      observed: baseSnapshot,
      historyRows,
    });
    await record("history-observed-wrong-platform", snapshotPath + "/history", {
      build: { ...historyBuild, previousObservedBuildId: baseSnapshot._id },
      observed: { ...baseSnapshot, platform: "Mac" },
      earlier: historyBuild,
      historyRows,
    });
    await record("compare-wrong-platform", comparePath, {
      ...comparison,
      baseSnapshot: { ...baseSnapshot, platform: "Mac" },
    });
    await record("compare-unavailable", comparePath, {
      ...comparison,
      baseSnapshot: {
        ...baseSnapshot,
        manifestStatus: "unavailable",
        manifestId: undefined,
      },
    });
    await record("compare-both-missing", comparePath, { missingBuild: true });
    await record(
      "compare-descending-filter",
      comparePath + "&dir=desc&extension=txt&status=added,modified&q=ied",
      {
        ...comparison,
        fileRows: [...comparison.fileRows].reverse(),
        baseFiles: [...comparison.baseFiles].reverse(),
      },
    );
    for (const [name, path, errorCollection] of [
      ["list", "/v1/builds", "builds"],
      ["detail", snapshotPath, "builds"],
      ["tree", snapshotPath + "/tree", "files"],
      ["install-options", snapshotPath + "/install-options", "files"],
      ["history", snapshotPath + "/history", "builds"],
    ])
      await record("backend-failure-" + name, path, {
        build: historyBuild,
        databaseError: true,
        errorCollection,
      });
    const legacy = {
      _id: "legacy:record-1",
      labelName: "Old-Windows",
      createdAt: null,
    };
    const sparse = {
      _id: "legacy:record-2",
      platform: "Mac",
      manifestStatus: "pending",
    };
    const nullPhase = await record("list-sparse-null-phase", ascendingPath, {
      nullRows: [legacy, sparse],
    });
    expect(nullPhase.status).toBe(200);
    await record(
      "list-sparse-null-continuation",
      ascendingPath + "&cursor=" + nullPhase.body.meta.pagination.nextCursor,
      { nullRows: [sparse] },
    );
    for (const sort of ["updatedAt", "firstSeenAt"]) {
      await record("list-sort-" + sort, "/v1/builds?limit=1&sortBy=" + sort, {
        listRows: [historyBuild, baseSnapshot],
      });
    }
    const sparseHistory = await record(
      "history-sparse-string-ids",
      snapshotPath + "/history?limit=1",
      { build: historyBuild, historyRows: [legacy, sparse] },
    );
    await record(
      "history-sparse-continuation",
      snapshotPath +
        "/history?limit=1&cursor=" +
        sparseHistory.body.meta.pagination.nextCursor,
      { build: historyBuild, historyRows: [sparse] },
    );
    await record("detail-sparse", snapshotPath, {
      build: { _id: historyBuild._id, labelName: "Live-Mac" },
      asset: { downloadSizeBytes: 1.5, installedSizeBytes: "unknown" },
    });
    await record("install-numeric-storage", snapshotPath + "/install-options", {
      build: historyBuild,
      installOptionRows: [
        { _id: "tiny", files: 1, size: 2.5 },
        { _id: 9, files: 2, size: 4294967297 },
      ],
    });
    await record(
      "files-numeric-sparse",
      snapshotPath + "/files?sort=fileSize&limit=1",
      {
        build: historyBuild,
        fileRows: [{ fileSize: 1.5, fileName: "" }, fileRows[1]],
      },
    );
    await record("files-missing-sort-value", snapshotPath + "/files?limit=1", {
      build: historyBuild,
      fileRows: [{ fileName: "orphan" }, fileRows[1]],
    });
    await record(
      "files-by-name",
      snapshotPath + "/files?sort=fileName&limit=1",
      { build: historyBuild, fileRows },
    );
    await record("compare-stream-error", comparePath, {
      ...comparison,
      databaseError: true,
      errorCollection: "files",
    });
    for (const [name, path, collection] of [
      ["list", "/v1/builds", "items"],
      ["items", snapshotPath + "/items", "items"],
      ["asset", snapshotPath, "assets"],
    ]) {
      await record("downstream-failure-" + name, path, {
        build: historyBuild,
        listRows: [historyBuild],
        databaseError: true,
        errorCollection: collection,
      });
    }
    await record("build-id-invalid", "/v1/builds/invalid-hex", {});
    const continued = (cursor: string, last: CursorSortTuple) =>
      encodeCursor(
        JSON.parse(Buffer.from(cursor.split(".")[0], "base64url").toString()),
        last,
      );
    const alternateCursors: Array<
      [string, string, string, CursorSortTuple, Record<string, unknown>]
    > = [
      ["list-epoch", ascendingPath, ascendingCursor, [0, id], {}],
      [
        "history-empty",
        snapshotPath + "/history?limit=1",
        historyCursor,
        [],
        { build: historyBuild },
      ],
      [
        "files-short",
        snapshotPath + "/files?limit=1",
        filesCursor,
        [],
        { build: historyBuild },
      ],
      ["items-empty", itemsPath, itemsCursor, [], { build: historyBuild }],
      ["items-number", itemsPath, itemsCursor, [12], { build: historyBuild }],
      [
        "tree-sparse",
        snapshotPath + "/tree?limit=1",
        treeCursor,
        ["file"],
        { build: historyBuild },
      ],
      ["compare-no-path", comparePath, nextComparison, [null], comparison],
    ];
    for (const [name, path, token, last, input] of alternateCursors) {
      await record(
        "node-cursor-" + name,
        path + "&cursor=" + continued(token, last),
        input,
      );
    }
    await record("items-malformed-cursor", itemsPath + "&cursor=bad", {
      build: historyBuild,
    });
    await record(
      "compare-malformed-cursor",
      comparePath + "&cursor=bad",
      comparison,
    );
    const corrupt = { _id: historyBuild._id };
    await record("invalid-build-summary-list", "/v1/builds", {
      listRows: [corrupt],
    });
    await record("invalid-build-summary-detail", snapshotPath, {
      build: corrupt,
    });
    await record("invalid-build-summary-history", snapshotPath + "/history", {
      build: historyBuild,
      historyRows: [corrupt],
    });
    await record("invalid-history-source", snapshotPath + "/history", {
      build: corrupt,
    });
    await record("history-page-lookup-failed", snapshotPath + "/history", {
      build: historyBuild,
      failStage: "history-page",
    });
    await record("previous-lookup-failed", snapshotPath + "/history", {
      build: historyBuild,
      failStage: "previous",
    });
    await record("observed-lookup-failed", snapshotPath + "/history", {
      build: { ...historyBuild, previousObservedBuildId: baseSnapshot._id },
      failStage: "observed",
    });
    await record("observed-missing-manifest", snapshotPath + "/history", {
      build: { ...historyBuild, previousObservedBuildId: baseSnapshot._id },
      observed: { ...baseSnapshot, manifestId: null },
      earlier: baseSnapshot,
    });
    await record("observed-pending-manifest", snapshotPath + "/history", {
      build: { ...historyBuild, previousObservedBuildId: baseSnapshot._id },
      observed: { ...baseSnapshot, manifestStatus: "processing" },
    });
    await record("tree-sparse-group", snapshotPath + "/tree?limit=1", {
      build: historyBuild,
      treeRows: [{ type: null }, treeRows[1]],
    });
    await record("stream-source-error", comparePath, {
      ...comparison,
      failStage: "read-file-stream",
    });
    await record("stream-corrupt-source", comparePath, {
      ...comparison,
      baseFiles: [{ fileName: 42, fileSize: 1 }],
      fileRows: [fileRows[0]],
    });
    const cross = {
      ...comparison,
      baseSnapshot: {
        ...baseSnapshot,
        labelName: "Dev-Windows",
        manifestStatus: "legacy_unverified",
      },
      baseFiles: [fileRow("base.dat", 0, 33)],
      fileRows: [],
    };
    await record("compare-cross-stream-legacy", comparePath, cross);
    await record(
      "filtered-extension-excluded",
      comparePath + "&extension=sys",
      comparison,
    );
    const descending = await record(
      "compare-descending-first",
      comparePath + "&dir=desc",
      {
        ...comparison,
        baseFiles: comparison.baseFiles.toReversed(),
        fileRows: comparison.fileRows.toReversed(),
      },
    );
    await record(
      "compare-descending-next",
      comparePath +
        "&dir=desc&cursor=" +
        descending.body.meta.pagination.nextCursor,
      {
        ...comparison,
        baseFiles: comparison.baseFiles.toReversed(),
        fileRows: comparison.fileRows.toReversed(),
      },
    );
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("V1_CURSOR_SECRET", "");
    vi.stubEnv("V1_CURSOR_DEV_SECRET", "");
    try {
      for (const [name, path, input] of [
        [
          "list",
          "/v1/builds?limit=1",
          { listRows: [historyBuild, baseSnapshot] },
        ],
        [
          "history",
          snapshotPath + "/history?limit=1",
          { build: historyBuild, historyRows },
        ],
        [
          "files",
          snapshotPath + "/files?limit=1",
          { build: historyBuild, fileRows },
        ],
        [
          "tree",
          snapshotPath + "/tree?limit=1",
          { build: historyBuild, treeRows },
        ],
        ["compare", comparePath, comparison],
        ["items", itemsPath, { build: historyBuild, itemRows: buildItems }],
      ] as const) {
        const unavailable = await record(
          "cursor-service-unconfigured-" + name,
          path,
          { ...input, noCursorSecret: true },
        );
        expect(unavailable.status).toBe(503);
      }
      const beforePagination=await record("compare-corrupt-data-before-cursor-secret",comparePath,{
        ...comparison,build:{...comparison.build,technologies:[null]},noCursorSecret:true});
      expect(beforePagination.status).toBe(500);
    } finally {
      vi.unstubAllEnvs();
    }
    const sparseItems = await record("items-empty-id-cursor", itemsPath, {
      build: historyBuild,
      itemRows: [{ ...buildItems[0], id: "" }, buildItems[1]],
    });
    await record(
      "items-empty-id-continuation",
      itemsPath + "&cursor=" + sparseItems.body.meta.pagination.nextCursor,
      { build: historyBuild, itemRows: [buildItems[1]] },
    );
    await record(
      "list-null-id-continuation",
      ascendingPath + "&cursor=" + continued(ascendingCursor, [null, null]),
      { nullRows: [nullDateBuild] },
    );
    await record("list-null-page-read-error", ascendingPath, {
      listRows: [historyBuild],
      failStage: "null-phase",
    });
    await record(
      "nested-invalid-build-id",
      "/v1/builds/bad-identifier/tree",
      {},
    );
    await record("history-legacy-comparable", snapshotPath + "/history", {
      build: historyBuild,
      earlier: legacy,
      historyRows: [{ ...baseSnapshot, manifestStatus: "legacy_unverified" }],
    });
    await record("install-sparse-group", snapshotPath + "/install-options", {
      build: historyBuild,
      installOptionRows: [{ size: 10 }, { _id: null, files: 1 }],
    });
    const streams = {
      ...comparison,
      build: {
        ...historyBuild,
        downloadSizeBytes: 200,
        installedSizeBytes: 90,
      },
      baseSnapshot: {
        ...baseSnapshot,
        downloadSizeBytes: 100,
        installedSizeBytes: 85,
      },
    };
    const same = fileRow("/a.dat", 0, 12),
      last = fileRow("zz.dat", 0, 7);
    await record(
      "removed-trailing-file",
      comparePath + "&status=modified,removed,unchanged",
      {
        ...streams,
        baseFiles: [same, last],
        fileRows: [{ ...same, fileHash: "new" }],
      },
    );
    await record("added-leading-file", comparePath, {
      ...streams,
      baseFiles: [last],
      fileRows: [same, last],
    });
    const failures: Array<[string, unknown[], unknown[]]> = [
      ["target-next-0", [same], [same]],
      ["target-next-1", [], [same]],
      ["base-next-1", [same], []],
      ["base-next-1", [same], [same]],
      ["target-next-1", [same], [same]],
      ["base-next-1", [same], [last]],
      ["target-next-1", [last], [same]],
    ];
    for (const [stage, baseFiles, targetFiles] of failures)
      await record("cursor-interruption-" + cases.length, comparePath, {
        ...streams,
        baseFiles,
        fileRows: targetFiles,
        failStage: stage,
      });
    await record("target-snapshot-open-failure", comparePath, {
      ...comparison,
      failStage: "target-open",
    });
    const unicodeQuery = new URLSearchParams({ extension: "\ue000,😀" });
    await record(
      "unicode-extension-cache-and-tags",
      comparePath + "&" + unicodeQuery,
      {
        ...comparison,
        baseFiles: [
          { ...fileRow("old.😀", 0, 10), installTags: ["\ue000", "😀"] },
        ],
        fileRows: [
          { ...fileRow("new.😀", 0, 11), installTags: ["\ue001", "😁"] },
        ],
      },
    );
    for(const {name,base,target,v1} of historicalComparisons){
      const response=await record("compare-history-"+name,comparePath,{...comparison,
        baseSnapshot:{...baseSnapshot,...base},build:{...comparison.build,...target}});
      expect(response.status,name).toBe(v1);
    }
    for (const [name, historical] of Object.entries({
      sparse: {
        _id: historyBuild._id,
        appName: "TestApp",
        sourceManifestHash: 7,
      },
      typed: {
        ...historyBuild,
        appName: 17,
        manifestStatus: { state: "old" },
        manifestId: { value: "manifest" },
        technologies: "historical",
      },
    })) {
      for (const suffix of ["/files", "/tree", "/items", "/install-options"]) {
        const response = await record(
          "stored-build-" + name + suffix,
          snapshotPath + suffix,
          {
            build: historical,
            traceFilters: true,
            fileRows,
            itemRows: [linkedItem],
            items: [linkedItem],
            treeRows: [],
            installOptionRows: [{ _id: "tag", files: 7, size: 15 }],
          },
        );
        expect(response.status).toBe(200);
      }
    }
    const sparseFile = { fileName: "sparse.bin", fileSize: 12 };
    for (const [name, baseFile, targetFile] of [
      [
        "null optional metadata",
        {
          ...sparseFile,
          fileHash: "same",
          mimeType: null,
          installTags: null,
          symlinkTarget: null,
          fileMetaFlags: null,
        },
        { ...sparseFile, fileHash: "same" },
      ],
      ["missing hashes", sparseFile, { ...sparseFile, mimeType: ["legacy"] }],
      [
        "typed hash and flags",
        { ...sparseFile, fileHash: { h: "1" }, fileMetaFlags: false },
        { ...sparseFile, fileHash: { h: "1" }, fileMetaFlags: 0 },
      ],
      [
        "missing and null sizes",
        { fileName: "sparse.bin" },
        { fileName: "sparse.bin", fileSize: null },
      ],
      [
        "iterable string tags",
        { ...sparseFile, installTags: "ab" },
        { ...sparseFile, installTags: ["b", "c"] },
      ],
    ] as const) {
      const response = await record("snapshot file " + name, comparePath, {
        ...comparison,
        baseFiles: [baseFile],
        fileRows: [targetFile],
      });
      expect(response.status).toBe(200);
    }
    for (const [name, baseFile, targetFile, status] of [
      [
        "fractional sizes",
        { ...sparseFile, fileSize: 1.25 },
        { ...sparseFile, fileSize: 2.5 },
        200,
      ],
      [
        "string sizes",
        { ...sparseFile, fileSize: "12" },
        { ...sparseFile, fileSize: "19" },
        200,
      ],
      [
        "boolean size",
        { ...sparseFile, fileSize: true },
        { ...sparseFile, fileSize: 2 },
        200,
      ],
      [
        "empty size object",
        { ...sparseFile, fileSize: {} },
        { ...sparseFile, fileSize: "invalid" },
        200,
      ],
      [
        "uncoercible size",
        { ...sparseFile, fileSize: { toString: null } },
        sparseFile,
        500,
      ],
      [
        "primitive tags",
        { ...sparseFile, installTags: [1, "1", false, null] },
        { ...sparseFile, installTags: ["1", true, null] },
        200,
      ],
      [
        "object tags",
        { ...sparseFile, installTags: [{}, {}] },
        { ...sparseFile, installTags: [{}] },
        200,
      ],
      [
        "non iterable tags",
        { ...sparseFile, installTags: 42 },
        sparseFile,
        500,
      ],
      ["missing left path", {}, sparseFile, 500],
      ["missing right path", sparseFile, {}, 500],
    ] as const) {
      const response = await record("snapshot coercion " + name, comparePath, {
        ...comparison,
        baseFiles: [baseFile],
        fileRows: [targetFile],
      });
      expect(response.status, name).toBe(status);
    }
    for (const [name, baseRows, targetRows] of [
      [
        "native sizes",
        [
          { fileName: "a", fileSize: Decimal128.fromString("12.75") },
          { fileName: "b", fileSize: new Double(2.5) },
          { fileName: "c", fileSize: "9" },
        ],
        [
          { fileName: "a", fileSize: Long.fromString("9007199254740997") },
          { fileName: "b", fileSize: [null, 5] },
        ],
      ],
      [
        "NaN values",
        [
          {
            ...sparseFile,
            fileHash: new Double(NaN),
            installTags: [new Double(NaN)],
          },
        ],
        [
          {
            ...sparseFile,
            fileHash: new Double(NaN),
            installTags: [new Double(NaN)],
          },
        ],
      ],
      [
        "native tag identity",
        [{ ...sparseFile, installTags: [baseSnapshot._id, "same"] }],
        [{ ...sparseFile, installTags: [baseSnapshot._id, "same"] }],
      ],
      [
        "uncoercible sorted tags",
        [{ ...sparseFile, installTags: [{ toString: 4 }, "sort"] }],
        [{ ...sparseFile, installTags: [{ toString: null }, "sort"] }],
      ],
    ] as const) {
      const response = await record("snapshot BSON " + name, comparePath, {
        ...comparison,
        nativeFiles: true,
        baseFiles: baseRows,
        fileRows: targetRows,
      });
      expect(response.status).toBe(
        name === "uncoercible sorted tags" ? 500 : 200,
      );
    }
    const invalidTags = {
      ...sparseFile,
      installTags: [{ toString: null }, "x"],
    };
    for (const [name, baseFiles, fileRows, status] of [
      [
        "nullish metadata fallback",
        [{ ...sparseFile, symlinkTarget: null, fileMetaFlags: 0 }],
        [{ ...sparseFile, symlinkTarget: "", fileMetaFlags: null }],
        200,
      ],
      ["unsortable target tag set", [sparseFile], [invalidTags], 500],
      ["unsortable added tags", [], [invalidTags], 500],
      ["unsortable removed tags", [invalidTags], [], 500],
    ] as const) {
      const response = await record(`snapshot ${name}`, comparePath, {
        ...comparison,
        baseFiles,
        fileRows,
      });
      expect(response.status).toBe(status);
    }
    // Five pageable warm cases add a cached-total read; list adds a count-outage case.
    expect(cases).toHaveLength(180 + historicalComparisons.length + 6);

    await assertOracle("build-reads-http-node", cases);
  });
});
