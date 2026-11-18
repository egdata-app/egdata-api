import { ObjectId } from "mongodb";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  collection: vi.fn(),
  assetFindOne: vi.fn(),
  itemFind: vi.fn(),
  itemFindOne: vi.fn(),
  itemCount: vi.fn(),
  namespaceFindOne: vi.fn(),
  reads: [] as unknown[],
}));

vi.mock("../src/db/index.js", () => ({
  db: { db: { collection: mocks.collection } },
}));
vi.mock("../src/models/index.js", () => ({
  Asset: { findOne: mocks.assetFindOne },
  Item: {
    find: mocks.itemFind,
    findOne: mocks.itemFindOne,
    countDocuments: mocks.itemCount,
  },
  Build: {},
  Namespace: { findOne: mocks.namespaceFindOne },
}));
vi.mock("../src/utils/projection.js", () => ({
  buildProjection: () => ({ title: 1, id: 1, _id: 1 }),
}));

import buildResolvers from "../src/graphql/resolvers/build.js";
import changelogResolvers from "../src/graphql/resolvers/changelog.js";
import itemResolvers from "../src/graphql/resolvers/item.js";
import sandboxResolvers from "../src/graphql/resolvers/sandbox.js";

type Resolver = (...args: any[]) => Promise<any>;
const query = (collection: string) =>
  (buildResolvers as any).Query[collection] as Resolver;

describe("GraphQL resolver Node oracle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.collection.mockImplementation((name: string) => ({
      findOne: vi.fn(async (filter: unknown) => {
        mocks.reads.push({ collection: name, filter, projection: null });
        if (name === "builds") {
          expect(filter).toEqual({ _id: expect.any(ObjectId) });
          return { _id: new ObjectId("64b000000000000000000001"), appName: "app-1" };
        }
        return null;
      }),
    }));
    mocks.itemFindOne.mockReturnValue({ lean: async () => ({ id: "item-1", title: "Example" }) });
    mocks.itemFind.mockReturnValue({ lean: async () => [{ id: "item-1", title: "Example" }] });
    mocks.itemCount.mockResolvedValue(1);
    mocks.namespaceFindOne.mockReturnValue({ lean: async () => null });
    mocks.assetFindOne.mockReturnValue({ lean: async () => ({ downloadSizeBytes: 1234 }) });
  });

  it("loads build by Mongo ObjectId and resolves its linked items", async () => {
    const id = "64b000000000000000000001";
    const build = await query("build")({}, { id }, {}, {});
    expect(build.appName).toBe("app-1");
    const linked = await (buildResolvers as any).Build.items(build, {}, {}, {});
    expect(linked).toEqual([{ id: "item-1", title: "Example" }]);
    expect(mocks.itemFind).toHaveBeenCalledWith({ "releaseInfo.appId": "app-1" });
  });

  it("returns the stored changelog document when present", async () => {
    const row = { _id: new ObjectId("64b000000000000000000002"), metadata: { contextId: "app-1" } };
    mocks.collection.mockImplementation((name: string) => ({
      findOne: async () => {
        expect(name).toBe("changelogs_v2");
        return row;
      },
    }));
    const findOne = (changelogResolvers as any).Query.changelog as Resolver;
    expect(await findOne({}, { id: row._id.toHexString() }, {}, {})).toEqual(row);
  });

  it("uses item selection projection and returns the canonical connection shape", async () => {
    const findOne = (itemResolvers as any).Query.item as Resolver;
    const item = await findOne({}, { id: "item-1" }, {}, { selections: [] });
    expect(item).toEqual({ id: "item-1", title: "Example" });
    expect(mocks.itemFindOne).toHaveBeenCalledWith(
      { id: { $eq: "item-1" } },
      expect.objectContaining({ id: 1, _id: 1 }),
    );

    const items = await (itemResolvers as any).Query.items({}, { limit: 1, page: 1 }, {}, {});
    expect(items).toEqual({ elements: [{ id: "item-1", title: "Example" }], total: 1, page: 1, limit: 1 });
    expect(mocks.itemCount).toHaveBeenCalledWith();
  });

  it("captures and replays Node build, changelog, and item resolver behavior", async () => {
    mocks.reads = [];
    const buildInput = { parent: {}, args: { id: "64b000000000000000000001" } };
    const buildExpected = await (buildResolvers as any).Query.build(buildInput.parent, buildInput.args, {}, {});
    const buildRead = mocks.reads.pop() as any;
    const changelogId = "64b000000000000000000002";
    const changelogRow = { _id: new ObjectId(changelogId), metadata: { contextId: "item-1" } };
    mocks.collection.mockImplementation((name: string) => ({
      findOne: async (filter: unknown) => {
        mocks.reads.push({ collection: name, filter, projection: null });
        return changelogRow;
      },
    }));
    const changelogExpected = await (changelogResolvers as any).Query.changelog({}, { id: changelogId }, {}, {});
    const changelogRead = mocks.reads.pop() as any;
    const itemInput = { parent: {}, args: { id: "item-1", __selectedFields: ["id", "title"] } };
    const itemExpected = await (itemResolvers as any).Query.item(itemInput.parent, itemInput.args, {}, {});
    const [itemFilter, itemProjection] = mocks.itemFindOne.mock.calls.at(-1) ?? [];
    const sandboxInput = { parent: {}, args: { id: "namespace-1" } };
    const sandboxExpected = await (sandboxResolvers as any).Query.sandbox(sandboxInput.parent, sandboxInput.args, {}, {});
    const [sandboxFilter] = mocks.namespaceFindOne.mock.calls.at(-1) ?? [];
    const normalize = (value: unknown) => JSON.parse(JSON.stringify(value));
    const cases = [
      { ...buildInput, parentType: "Query", field: "build", reads: [normalize(buildRead)], expected: normalize(buildExpected) },
      { parent: {}, args: { id: changelogId }, parentType: "Query", field: "changelog", reads: [normalize(changelogRead)], expected: normalize(changelogExpected) },
      { ...itemInput, parentType: "Query", field: "item", reads: [{ collection: "items", filter: normalize(itemFilter), projection: normalize(itemProjection) }], expected: normalize(itemExpected) },
      { ...sandboxInput, parentType: "Query", field: "sandbox", reads: [{ collection: "namespaces", filter: normalize(sandboxFilter), projection: null }], expected: normalize(sandboxExpected) },
    ];
    const fixturePath = fileURLToPath(new URL("../rust/oracles/graphql-resolvers-node.json", import.meta.url));
    if (process.env.RUST_ORACLE_WRITE === "1") {
      writeFileSync(fixturePath, `${JSON.stringify({ cases }, null, 2)}\n`);
    } else {
      const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
      expect(cases).toEqual(fixture.cases);
    }
  });

  it("reads changelogs from the v2 collection and returns null for missing documents", async () => {
    const findOne = (changelogResolvers as any).Query.changelog as Resolver;
    mocks.collection.mockImplementation((name: string) => ({
      findOne: async (filter: Record<string, unknown>) => {
        expect(name).toBe("changelogs_v2");
        expect(filter._id).toEqual(new ObjectId("64b000000000000000000002"));
        return null;
      },
    }));
    expect(await findOne({}, { id: "64b000000000000000000002" }, {}, {})).toBeNull();
  });
});
