import { Hono } from "hono";
import { BSON, type Db, type Document } from "mongodb";
import { expect, it, vi } from "vitest";
import { assertOracle, captureResponse } from "../rust/oracles/record.js";
import {
  type CatalogHydrationIdentifier,
  type CatalogHydrationRequest,
  catalogHydrationRootKey,
} from "../src/catalog/hydration.js";
import { ProblemError, problemResponse } from "../src/v1/errors.js";
import { v1CachePolicy, v1Context } from "../src/v1/request-context.js";
import hydrate from "../src/v1/routes/catalog-hydrate.js";

const calls: unknown[] = [];

it("checks catalog record hashes and incremental hydration against the Mongo resolver", async () => {
  const { MongoCatalogHydrationResolver } = await vi.importActual<
    typeof import("../src/catalog/resolver.js")
  >("../src/catalog/resolver.js");
  const item = {
    namespace: "store",
    id: "item",
    title: "Example",
    creationDate: "2024-02-03",
    entitlementStartDate: 1706922000123.75,
    entitlementEndDate: "invalid",
  };
  const assets = [
    {
      namespace: "store",
      itemId: "item",
      platform: "Windows",
      artifactId: "game",
      downloadSizeBytes: 16167389303,
      installedSizeBytes: 17100000000,
    },
  ];
  const tables = { items: [item], assets };
  type Tables = Record<string, Document[]>;
  type Scenario = {
    tables: Tables;
    generatedPlatforms?: number;
    extendedJson?: boolean;
    failRead?: number;
  };
  const identifier = { type: "item", namespace: "store", id: "item" } as const;
  const request: CatalogHydrationRequest = {
    schemaVersion: 2,
    identifiers: [identifier],
    knownRecords: [],
    knownRoots: [],
  };
  const cases: unknown[] = [];
  const resolve = async (
    input: CatalogHydrationRequest,
    scenario: Scenario = { tables },
  ) => {
    const rows = { ...scenario.tables };
    if (scenario.extendedJson) {
      for (const [collection, docs] of Object.entries(rows)) {
        rows[collection] = docs.map((row) =>
          BSON.deserialize(
            BSON.serialize(BSON.EJSON.deserialize(row, { relaxed: false })),
          ),
        );
      }
    }
    const { generatedPlatforms } = scenario;
    if (generatedPlatforms !== undefined) {
      rows.items = rows.items.map((row) => ({
        ...row,
        releaseInfo: [
          {
            appId: "app",
            platform: Array.from({ length: generatedPlatforms }, (_, i) =>
              String(i),
            ),
          },
        ],
      }));
    }
    let reads = 0;
    const read = (name: string): Document[] => {
      if (++reads === scenario.failRead)
        throw new Error("fixture read failure");
      return rows[name] ?? [];
    };
    const db = {
      collection(name: string) {
        return {
          findOne: async () => read(name)[0] ?? null,
          find: () => ({
            limit: (limit: number) => ({
              toArray: async () => read(name).slice(0, limit),
            }),
          }),
        };
      },
    };
    const resolver = new MongoCatalogHydrationResolver(db as unknown as Db);
    const { hydratedAt, ...result } = await resolver.resolve(
      input.identifiers[0],
      input,
    );
    expect(new Date(hydratedAt).toISOString()).toBe(hydratedAt);
    cases.push({ ...scenario, request: input, result });
    return result;
  };
  const first = await resolve(request);
  if (first.status !== "resolved")
    throw new Error("Expected a populated hydration graph");
  expect(first.records.some((row) => row.record.type === "asset")).toBe(true);
  expect(
    (
      await resolve({
        ...request,
        knownRoots: [{ rootKey: first.rootKey, graphHash: first.graphHash }],
      })
    ).status,
  ).toBe("unchanged");
  await resolve({
    ...request,
    knownRecords: first.records.map(({ recordKey, sha256 }) => ({
      recordKey,
      sha256,
    })),
  });
  const known = { rootKey: first.rootKey, graphHash: first.graphHash };
  const stale = { ...known, graphHash: "0".repeat(64) };
  expect(
    (await resolve({ ...request, knownRoots: [stale, known] })).status,
  ).toBe("resolved");
  expect(
    (await resolve({ ...request, knownRoots: [known, stale] })).status,
  ).toBe("unchanged");
  const owner = {
    ...item,
    useCount: 2.5,
    linkedOffers: ["official"],
    categories: ["\uE000", "🎮", "Z", "🎮", { path: "" }, { path: "𝄞" }],
    eulaIds: ["\uE000", "🎮", "A"],
    releaseInfo: [
      { id: "early", appId: "game", platform: ["Windows"] },
      { id: "winner", appId: "game", platform: ["Windows", "Linux"] },
    ],
  };
  const offer = {
    namespace: "store",
    id: "official",
    title: "Offer",
    offerType: "BASE_GAME",
    items: [{ id: "item", namespace: "store" }],
    tags: [{ id: "é" }, { id: "e\u0301" }],
    prePurchase: false,
  };
  const connected = {
    items: [{ ...owner, title: "Old item" }, owner],
    offers: [{ ...offer, title: "Old offer" }, offer],
    assets: [assets[0], { ...assets[0], downloadSizeBytes: 2.25 }],
    offersubitems: [{ offerId: "official", subItems: [{ id: "item" }] }],
  };
  const graph = await resolve(request, { tables: connected });
  if (graph.status !== "resolved") throw new Error("Expected joined graph");
  expect(graph.records.map(({ record }) => record.type)).toEqual([
    "asset",
    "item",
    "offer-item",
    "offer",
    "release-app",
    "release-app",
  ]);
  const edge = graph.records.find(({ record }) => record.type === "offer-item");
  if (!edge) throw new Error("Expected the offer-item edge");
  expect(edge.record).toMatchObject({
    sources: ["direct", "subitem", "linked"],
    isPrimary: true,
  });
  const canonicalItem = graph.records.find(
    ({ record }) => record.type === "item",
  );
  if (!canonicalItem) throw new Error("Expected the owner item");
  expect(canonicalItem.record).toMatchObject({
    title: "Example",
    categories: ["Z", "𝄞", "🎮", "\uE000"],
  });
  const delta = await resolve(
    {
      ...request,
      knownRecords: [
        { recordKey: edge.recordKey, sha256: edge.sha256 },
        { recordKey: edge.recordKey, sha256: stale.graphHash },
        { recordKey: canonicalItem.recordKey, sha256: canonicalItem.sha256 },
      ],
    },
    { tables: connected },
  );
  if (delta.status !== "resolved")
    throw new Error("Expected incremental graph");
  expect(delta.records.map(({ recordKey }) => recordKey)).toContain(
    edge.recordKey,
  );
  expect(delta.records.map(({ recordKey }) => recordKey)).not.toContain(
    canonicalItem.recordKey,
  );
  for (const alternate of [
    {
      type: "asset",
      namespace: "store",
      artifactId: "game",
      platform: "Windows",
    },
    {
      type: "release-app",
      namespace: "store",
      appId: "game",
      platform: "Windows",
    },
  ] as const) {
    const root = await resolve(
      { ...request, identifiers: [alternate] },
      { tables: connected },
    );
    if (root.status !== "resolved") throw new Error("Expected alternate root");
    expect(root.graphHash).toBe(graph.graphHash);
  }
  expect((await resolve(request, { tables: {} })).status).toBe("not-found");
  const assetRequest: CatalogHydrationRequest = {
    ...request,
    identifiers: [
      {
        type: "asset",
        namespace: "store",
        artifactId: "game",
        platform: "Windows",
      },
    ],
  };
  const failureTables = {
    ...tables,
    offers: [
      {
        namespace: "store",
        id: "offer",
        title: "Offer",
        items: [{ id: "item" }],
      },
    ],
  };
  // Asset ownership, offer and subitem lookups, sibling and linked items, then final assets.
  for (let failRead = 1; failRead <= 9; failRead++) {
    expect(
      (await resolve(assetRequest, { tables: failureTables, failRead })).status,
    ).toBe("error");
  }
  expect(
    (await resolve(request, { tables: { items: [{ ...item, title: "" }] } }))
      .status,
  ).toBe("error");
  expect(
    (
      await resolve(request, {
        tables: {
          items: [item],
          assets: [{ itemId: "item", namespace: "store", platform: "Windows" }],
        },
      })
    ).status,
  ).toBe("error");
  expect(
    (
      await resolve(request, {
        tables: { items: [item] },
        generatedPlatforms: 500,
      })
    ).status,
  ).toBe("error");
  const invalidOwner = await resolve(
    {
      ...request,
      identifiers: [
        {
          type: "release-app",
          namespace: "store",
          appId: "game",
          platform: "Windows",
        },
      ],
    },
    {
      tables: {
        items: [
          {
            ...item,
            id: "",
            releaseInfo: [{ appId: "game", platform: ["Windows"] }],
          },
        ],
      },
    },
  );
  expect(invalidOwner.status).toBe("error");
  const bsonGraph = await resolve(request, {
    extendedJson: true,
    tables: {
      items: [
        {
          ...item,
          useCount: { $numberLong: "9007199254740993" },
          developer: { $oid: "507f1f77bcf86cd799439011" },
          description: { $date: "2024-01-02T00:00:00Z" },
          creationDate: { $date: "2024-03-04T00:00:00Z" },
          eulaIds: [{ $symbol: "driver-promotes-symbol" }],
        },
      ],
      assets: [
        {
          ...assets[0],
          downloadSizeBytes: { $numberLong: "9007199254740992" },
          installedSizeBytes: { $numberDecimal: "1432.12" },
        },
        {
          ...assets[0],
          artifactId: "huge-double",
          installedSizeBytes: { $numberInt: "37" },
          downloadSizeBytes: { $numberDouble: "18446744073709551616" },
        },
      ],
    },
  });
  if (bsonGraph.status !== "resolved")
    throw new Error("Expected a native BSON graph");
  const bsonItem = bsonGraph.records.find(
    ({ record }) => record.type === "item",
  )?.record;
  expect(bsonItem).toMatchObject({
    creationDate: "2024-03-04T00:00:00.000Z",
    eulaIds: ["driver-promotes-symbol"],
  });
  for (const key of ["useCount", "developer", "description"])
    expect(bsonItem).not.toHaveProperty(key);
  assertOracle("hydration-mongo-node", cases);
});
vi.mock("../src/db/index.js", () => ({ db: { db: {} } }));
vi.mock("../src/catalog/resolver.js", () => ({
  MongoCatalogHydrationResolver: class {
    async resolve(
      identifier: CatalogHydrationIdentifier,
      request: CatalogHydrationRequest,
    ) {
      calls.push({
        identifier,
        knownRoots: request.knownRoots,
        knownRecords: request.knownRecords,
      });
      const base = {
        schemaVersion: 2,
        rootKey: catalogHydrationRootKey(identifier),
        identifier,
        hydratedAt: new Date().toISOString(),
      };
      if (identifier.type === "item" && identifier.id === "fail")
        throw new Error("fixture resolver failure");
      if (identifier.type === "item" && identifier.id === "large")
        return { ...base, data: "x".repeat(2 * 1024 * 1024) };
      const known = request.knownRoots.find(
        (root) => root.rootKey === base.rootKey,
      );
      return known
        ? { ...base, status: "unchanged", graphHash: known.graphHash }
        : { ...base, status: "not-found" };
    }
  },
}));

it("compares catalog hydration stream framing, resolver inputs and request errors with Node", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-17T12:00:00Z"));
  try {
    let app = new Hono();
    app.use("*", v1Context());
    // v1/router.ts bypasses responseEtag for catalog hydration.
    app.use("*", v1CachePolicy());
    app.route("/v1", hydrate);
    app.onError((error, c) => {
      if (!(error instanceof ProblemError)) throw error;
      return problemResponse(c, error);
    });
    let path = "/v1/catalog/hydrate";
    const cases: unknown[] = [];
    const item = (id: string) => ({ type: "item", namespace: "N", id });
    const payload = {
      schemaVersion: 2,
      identifiers: [
        item("fail"),
        {
          type: "asset",
          namespace: "N",
          artifactId: "José",
          platform: "Win32",
        },
        item("large"),
        { type: "release-app", namespace: "N", appId: "XA", platform: "Mac" },
      ],
      knownRoots: [
        { rootKey: "release-app:n:xa:mac", graphHash: "b".repeat(64) },
      ],
      knownRecords: [{ recordKey: "item:n:test", sha256: "a".repeat(64) }],
    };
    async function record(
      name: string,
      raw: string,
      headers: Record<string, string>,
    ) {
      calls.length = 0;
      const request = { method: "POST", path, raw, headers };
      const response = await captureResponse(
        await app.request(path, {
          method: "POST",
          body: Buffer.from(raw),
          headers: {
            ...headers,
            "x-egdata-key-id": "key_oracle",
            "x-egdata-key-tier": "free",
            "x-request-id": "req_node_oracle",
          },
        }),
      );
      cases.push({ name, request, calls: [...calls], response });
    }
    const json = { "content-type": "application/json" };
    await record("mixed-stream", JSON.stringify(payload), {
      "content-type": "application/vnd.egdata+json; charset=utf-8",
    });
    await record(
      "normalized-duplicate",
      JSON.stringify({ ...payload, identifiers: [item("É"), item(" é ")] }),
      json,
    );
    await record("missing-arrays", '{"schemaVersion":2}', json);
    for (const [name, id] of [
      ["bom-only", "\uFEFF"],
      ["unicode-nel", "\u0085"],
    ]) {
      await record(
        name,
        JSON.stringify({ ...payload, identifiers: [item(id)] }),
        json,
      );
    }
    await record(
      "bom-duplicate",
      JSON.stringify({
        ...payload,
        identifiers: [item("key"), item("\uFEFFKEY")],
      }),
      json,
    );
    await record("invalid-json", "{", json);
    await record("declared-oversize", "{}", {
      ...json,
      "content-length": "262145",
    });
    await record("missing-content-type", "{}", {});
    await record("wrong-content-type", "{}", { "content-type": "text/plain" });
    assertOracle("hydration-http-node", cases);
    const { default: legacy } = await import(
      "../src/routes/catalog-hydrate.js"
    );
    app = new Hono();
    app.route("/catalog", legacy);
    path = "/catalog/hydrate";
    cases.length = 0;
    await record(
      "legacy mixed stream without content type",
      JSON.stringify(payload),
      {},
    );
    expect((cases[0] as { response: { status: number } }).response.status).toBe(
      200,
    );
    assertOracle("legacy-hydration-http-node", cases);
  } finally {
    vi.useRealTimers();
  }
});
