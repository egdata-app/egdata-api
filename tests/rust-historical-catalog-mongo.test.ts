import { readFile } from "node:fs/promises";
import { BSON, type Document, MongoClient, ObjectId } from "mongodb";
import { expect, it } from "vitest";
import { assertOracle } from "../rust/oracles/record.js";
import {
  type CatalogHydrationIdentifier,
  type CatalogHydrationRequest,
  sha256Hex,
  stableJson,
} from "../src/catalog/hydration.js";
import {
  ensureCatalogHydrationIndexes,
  MongoCatalogHydrationResolver,
} from "../src/catalog/resolver.js";

const mongo = process.env.EGDATA_TEST_MONGO;
const historical = async (collection: string): Promise<Document[]> =>
  JSON.parse(
    await readFile(
      new URL(`./fixtures/egdata.${collection}.SeaQA.json`, import.meta.url),
      "utf8",
    ),
  );
const symbol = (text: string) => ({ $symbol: text });
const namespace = "Legacy";
const item = (id: string) => ({ type: "item" as const, namespace, id });
const asset = (artifactId: string) => ({
  type: "asset" as const,
  namespace,
  artifactId,
  platform: "Windows",
});
const app = (appId: string) => ({
  type: "release-app" as const,
  namespace,
  appId,
  platform: "Windows",
});
const tables = {
  items: [
    { namespace, id: "owner", title: "Original" },
    {
      namespace,
      id: "owner",
      title: "Revised",
      linkedOffers: [symbol("linked"), null],
      releaseInfo: [{ appId: "shared", platform: ["Windows"] }],
    },
    {
      namespace,
      id: symbol("symbol-id"),
      title: "Legacy symbol",
      linkedOffers: [symbol("linked")],
    },
    {
      namespace,
      id: "linked-alone",
      title: "Linked only",
      linkedOffers: [symbol("linked")],
    },
    { namespace, id: "sibling", title: "Sibling" },
    { namespace: "Other", id: "sibling", title: "Other namespace" },
    { id: "sibling", title: "Namespace missing" },
    { namespace, id: "scoped", title: "Only this namespace is referenced" },
    { namespace: "Other", id: "scoped", title: "Exclude from the owner graph" },
    {
      namespace,
      id: "bad",
      title: { $numberInt: "4" },
      releaseInfo: [{ appId: "bad", platform: ["Windows"] }],
    },
    { namespace, id: "bad-refs", title: "Bad references" },
    { namespace, id: "empty-observation", title: "Empty observation" },
  ],
  offers: [
    {
      namespace,
      id: "direct",
      title: "Initial offer",
      items: [
        { id: "owner" },
        { id: "sibling" },
        { id: "scoped", namespace },
        null,
        { id: 2 },
      ],
    },
    {
      namespace,
      id: "direct",
      title: "Updated direct offer",
      items: [
        { id: "owner" },
        { id: "sibling" },
        { id: "scoped", namespace },
        null,
        { id: 2 },
      ],
    },
    { namespace, id: symbol("linked"), title: "Offer with symbol ID" },
    {
      namespace: "Other",
      id: "linked",
      title: "Related ID belongs to another namespace",
    },
    { namespace, id: "broken", title: 17, items: [{ id: "bad-refs" }] },
    {
      namespace,
      id: "",
      title: "Unusable record",
      items: [{ id: "empty-observation" }],
    },
  ],
  assets: [
    {
      namespace,
      artifactId: "symbol-parent",
      platform: "Windows",
      itemId: symbol("symbol-id"),
    },
    { namespace, artifactId: "orphan", platform: "Windows", itemId: 17 },
    {
      namespace,
      artifactId: "duplicate",
      platform: "Windows",
      itemId: "owner",
      downloadSizeBytes: { $numberLong: "9007199254740993" },
    },
    {
      namespace,
      artifactId: "duplicate",
      platform: "Windows",
      itemId: "owner",
      installedSizeBytes: { $numberDecimal: "23.1" },
    },
  ],
  offersubitems: [
    {
      _id: "direct",
      namespace,
      subItems: [null, { id: "owner" }, { id: "sibling", namespace: "" }],
    },
    { offerId: "", namespace, subItems: [{ id: "empty-observation" }] },
    { offerId: "direct", namespace, subItems: "invalid historic relation" },
  ],
};
async function disposableMongo() {
  if (!mongo) throw new Error("Disposable MongoDB URI is required");
  const client = new MongoClient(mongo, {
    tls: true,
    authMechanism: "MONGODB-X509",
    authSource: "$external",
    tlsCAFile: process.env.EGDATA_TEST_MONGO_CA,
    tlsCertificateKeyFile: process.env.EGDATA_TEST_MONGO_CERT,
    monitorCommands: true,
  });
  await client.connect();
  return client;
}
it.skipIf(!mongo)(
  "checks historical exports and malformed catalog relationships against MongoDB",
  async () => {
    const client = await disposableMongo();
    const db = client.db(`catalog_fixture_${new ObjectId().toHexString()}`);
    const trace: unknown[] = [];
    client.on("commandStarted", ({ command }) => {
      if (command.find)
        trace.push({
          collection: command.find,
          filter: command.filter,
          limit: command.limit,
        });
    });
    try {
      const items = await historical("items");
      for (const [collection, rows] of Object.entries({
        items,
        offers: await historical("offers"),
      })) {
        await db
          .collection(collection)
          .insertMany(
            rows.map((r) => BSON.EJSON.deserialize(r, { relaxed: false })),
          );
      }
      for (const [collection, rows] of Object.entries(tables)) {
        await db
          .collection(collection)
          .insertMany(
            rows.map((r) => BSON.EJSON.deserialize(r, { relaxed: false })),
          );
      }
      await ensureCatalogHydrationIndexes(db);
      const resolver = new MongoCatalogHydrationResolver(db);
      const cases: unknown[] = [];
      const resolve = async (
        identifier: CatalogHydrationIdentifier,
        delta: Partial<
          Pick<CatalogHydrationRequest, "knownRoots" | "knownRecords">
        > = {},
      ) => {
        const request: CatalogHydrationRequest = {
          schemaVersion: 2,
          identifiers: [identifier],
          knownRoots: [],
          knownRecords: [],
          ...delta,
        };
        trace.length = 0;
        const { hydratedAt, ...result } = await resolver.resolve(
          identifier,
          request,
        );
        expect(new Date(hydratedAt).toISOString()).toBe(hydratedAt);
        cases.push({
          identifier,
          ...delta,
          status: result.status,
          rootDigest: sha256Hex(stableJson(result)),
          queryDigest: sha256Hex(stableJson(trace)),
        });
        return result;
      };
      for (const row of items) {
        await resolve({ type: "item", namespace: row.namespace, id: row.id });
      }
      const appIdentifiers = new Map<string, CatalogHydrationIdentifier>();
      for (const row of items) {
        for (const rel of row.releaseInfo ?? []) {
          if (typeof rel.appId !== "string" || !Array.isArray(rel.platform))
            continue;
          for (const platform of rel.platform) {
            const id = {
              type: "release-app" as const,
              namespace: row.namespace,
              appId: rel.appId,
              platform,
            };
            appIdentifiers.set(stableJson(id), id);
          }
        }
      }
      for (const identifier of appIdentifiers.values())
        await resolve(identifier);
      for (const identifier of [
        item("owner"),
        item("symbol-id"),
        item("linked-alone"),
        item("sibling"),
        asset("symbol-parent"),
        asset("orphan"),
        asset("duplicate"),
        app("shared"),
        app("bad"),
        item("bad-refs"),
        item("empty-observation"),
      ])
        await resolve(identifier);
      const first = await resolve({
        type: "item",
        id: items[0].id,
        namespace: items[0].namespace,
      });
      if (first.status !== "resolved")
        throw new Error("Historical owner should resolve");
      await resolve(first.identifier, {
        knownRoots: [{ rootKey: first.rootKey, graphHash: first.graphHash }],
      });
      await resolve(first.identifier, {
        knownRecords: first.records
          .filter((_, i) => i % 2 === 0)
          .map(({ recordKey, sha256 }) => ({ recordKey, sha256 })),
      });
      assertOracle("catalog-historical-mongo-node", [{ tables, cases }]);
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  },
  60000,
);

it.skipIf(!mongo)(
  "discards the initial asset batch if MongoDB fails a later getMore",
  async () => {
    const client = await disposableMongo();
    const db = client.db(`catalog_fixture_${new ObjectId().toHexString()}`);
    const batches: string[] = [];
    client.on("commandStarted", ({ command }) => {
      if (command.find === "assets") batches.push("find");
      if (command.getMore && command.collection === "assets")
        batches.push("getMore");
    });
    try {
      await db
        .collection("items")
        .insertOne({ id: "page", namespace, title: "Paged assets" });
      await db.collection("raw_assets").insertMany(
        Array.from({ length: 130 }, (_, i) => ({
          namespace,
          itemId: "page",
          artifactId: `artifact-${i}`,
          platform: "Windows",
          sizeParts: i === 129 ? 0 : 1,
        })),
      );
      await db.createCollection("assets", {
        viewOn: "raw_assets",
        pipeline: [
          { $addFields: { downloadSizeBytes: { $divide: [2, "$sizeParts"] } } },
        ],
      });
      const identifier = item("page");
      const { hydratedAt, ...result } = await new MongoCatalogHydrationResolver(
        db,
      ).resolve(identifier, {
        schemaVersion: 2,
        identifiers: [identifier],
        knownRoots: [],
        knownRecords: [],
      });
      expect(result.status).toBe("error");
      expect(batches).toEqual(["find", "getMore"]);
      expect(new Date(hydratedAt).toISOString()).toBe(hydratedAt);
      assertOracle("catalog-asset-cursor-failure-node", [{ result, batches }]);
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  },
);
