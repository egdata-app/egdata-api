import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import ItemsRoute from "../src/routes/items.js";
import {
  loadSeaQaItems,
  SEA_QA_SMOKE_ITEM_ID,
  type SeaQaAttribute,
  type SeaQaItem,
} from "./fixtures/seaqa.js";

const mocks = vi.hoisted(() => ({
  assetFind: vi.fn(),
  itemFind: vi.fn(),
  itemFindOne: vi.fn(),
  itemCountDocuments: vi.fn(),
  offerFind: vi.fn(),
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  collection: vi.fn(),
  submitJobApiBatch: vi.fn(),
  submitJobApiRequest: vi.fn(),
}));

const fakeCursor = (documents: unknown[]) => {
  const cursor = {
    sort: vi.fn(),
    skip: vi.fn(),
    limit: vi.fn(),
    toArray: vi.fn().mockResolvedValue(documents),
  };
  cursor.sort.mockReturnValue(cursor);
  cursor.skip.mockReturnValue(cursor);
  cursor.limit.mockReturnValue(cursor);
  return cursor;
};

vi.mock("../src/clients/job-api.js", () => ({
  submitJobApiBatch: mocks.submitJobApiBatch,
  submitJobApiRequest: mocks.submitJobApiRequest,
}));

vi.mock("../src/clients/redis.js", () => ({
  default: {
    get: mocks.redisGet,
    set: mocks.redisSet,
  },
}));

vi.mock("../src/db/index.js", () => ({
  db: {
    db: {
      collection: mocks.collection,
    },
  },
}));

vi.mock("../src/models/index.js", () => ({
  Asset: {
    find: mocks.assetFind,
  },
  Item: {
    find: mocks.itemFind,
    findOne: mocks.itemFindOne,
    countDocuments: mocks.itemCountDocuments,
  },
  Offer: {
    find: mocks.offerFind,
  },
}));

describe("items route with SeaQA fixtures", () => {
  let app: Hono;
  let items: SeaQaItem[];

  beforeAll(async () => {
    items = await loadSeaQaItems();
    app = new Hono().route("/items", ItemsRoute);
  });

  beforeEach(() => {
    mocks.itemFind.mockReset();
    mocks.itemFindOne.mockReset();
    mocks.itemCountDocuments.mockReset();
    mocks.assetFind.mockReset();
    mocks.collection.mockReset();
    mocks.submitJobApiBatch.mockReset().mockResolvedValue([]);
    mocks.submitJobApiRequest.mockReset().mockResolvedValue(undefined);
  });

  it("preserves the item regen route contract", async () => {
    const res = await app.request("/items/regen/item-1", { method: "PUT" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "Item regen requested" });
    expect(mocks.submitJobApiRequest).toHaveBeenCalledWith("item-regen", {
      id: "item-1",
    });
  });

  it("submits every bulk item, including duplicates, before returning success", async () => {
    const res = await app.request("/items/bulk-regen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: ["duplicate", "duplicate", "item-2"] }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "Item regen requested" });
    expect(mocks.submitJobApiBatch).toHaveBeenCalledWith("item-regen", [
      { id: "duplicate" },
      { id: "duplicate" },
      { id: "item-2" },
    ]);
  });

  it("does not report bulk success when a Temporal submission fails", async () => {
    mocks.submitJobApiBatch.mockRejectedValueOnce(
      new Error("submission not accepted"),
    );

    const res = await app.request("/items/bulk-regen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: ["item-1", "item-2"] }),
    });

    expect(res.status).toBe(500);
  });

  it("maps item customAttributes from the fixture through /items/:id", async () => {
    const item = items.find(
      (fixture) =>
        Array.isArray(fixture.customAttributes) &&
        fixture.customAttributes.some(
          (attribute: SeaQaAttribute) => attribute.key === "CanRunOffline",
        ),
    );
    if (!item) {
      throw new Error("Missing SeaQA item fixture with custom attributes");
    }

    mocks.itemFindOne.mockResolvedValue({
      ...item,
      toObject: () => item,
    });

    const res = await app.request(`/items/${item.id}`);

    expect(res.status).toBe(200);
    expect(mocks.itemFindOne).toHaveBeenCalledWith({
      $or: [{ _id: { $eq: item.id } }, { id: { $eq: item.id } }],
    });

    const body = await res.json();
    expect(body).toMatchObject({
      id: item.id,
      namespace: "SeaQA",
      customAttributes: {
        CanRunOffline: {
          type: "STRING",
          value: "true",
        },
        FolderName: {
          type: "STRING",
          value: "test",
        },
      },
    });
  });

  it("returns the stable SeaQA smoke item by ID", async () => {
    const item = items.find((fixture) => fixture.id === SEA_QA_SMOKE_ITEM_ID);
    if (!item) {
      throw new Error("Missing stable SeaQA smoke item fixture");
    }

    mocks.itemFindOne.mockResolvedValue({
      ...item,
      toObject: () => item,
    });

    const res = await app.request(`/items/${SEA_QA_SMOKE_ITEM_ID}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: SEA_QA_SMOKE_ITEM_ID,
      namespace: "SeaQA",
      title: "SmokeTest Item For Any Offer",
    });
  });

  it("caps and projects the items list with shared-cache headers", async () => {
    mocks.itemFind.mockResolvedValue([{ id: "item-1", title: "Compact" }]);
    mocks.itemCountDocuments.mockResolvedValue(120);

    const res = await app.request("/items?limit=500&page=2");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      elements: [{ id: "item-1", title: "Compact" }],
      page: 2,
      limit: 50,
      total: 120,
    });
    expect(mocks.itemFind).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        _id: 0,
        id: 1,
        title: 1,
        keyImages: 1,
        releaseInfo: 1,
        lastModifiedDate: 1,
      }),
      {
        limit: 50,
        skip: 50,
        sort: { lastModifiedDate: -1 },
      },
    );
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=60, s-maxage=300",
    );
    expect(res.headers.get("cdn-cache-control")).toBe("public, max-age=300");
  });

  it("paginates item builds, caps the page size, and reports the total", async () => {
    mocks.itemFindOne.mockResolvedValue({
      id: "item-1",
      releaseInfo: [{ appId: "app-1" }, { appId: "app-1" }, {}],
    });
    const cursor = fakeCursor([
      {
        _id: { toString: () => "build-1" },
        appName: "app-1",
        buildVersion: "1.0",
        labelName: "app-1-Windows",
        hash: "hash-1",
      },
    ]);
    const buildsCollection = {
      find: vi.fn().mockReturnValue(cursor),
      countDocuments: vi.fn().mockResolvedValue(42),
    };
    mocks.collection.mockReturnValue(buildsCollection);
    mocks.assetFind.mockResolvedValue([
      {
        artifactId: "app-1",
        platform: "Windows",
        downloadSizeBytes: 100,
        installedSizeBytes: 200,
      },
    ]);

    const res = await app.request("/items/item-1/builds?limit=1000&page=2");

    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("42");
    expect(buildsCollection.find).toHaveBeenCalledWith({
      appName: { $in: ["app-1"] },
    });
    expect(cursor.sort).toHaveBeenCalledWith({
      firstSeenAt: -1,
      createdAt: -1,
      _id: -1,
    });
    expect(cursor.skip).toHaveBeenCalledWith(100);
    expect(cursor.limit).toHaveBeenCalledWith(100);
    expect(mocks.assetFind).toHaveBeenCalledTimes(1);
    await expect(res.json()).resolves.toMatchObject([
      {
        id: "build-1",
        appName: "app-1",
        downloadSizeBytes: 100,
        installedSizeBytes: 200,
      },
    ]);
  });

  it("projects changelog lookups to the fields they actually expose", async () => {
    mocks.itemFindOne.mockResolvedValue({ id: "item-1" });
    mocks.assetFind.mockResolvedValue([]);

    type PipelineStage = Record<string, unknown> & {
      $lookup?: { pipeline: PipelineStage[] };
    };

    let capturedPipeline: PipelineStage[] = [];
    mocks.collection.mockImplementation((name: string) => {
      if (name === "builds") {
        return { find: () => fakeCursor([]) };
      }
      if (name === "changelogs_v2") {
        return {
          aggregate: (pipeline: PipelineStage[]) => {
            capturedPipeline = pipeline;
            return { toArray: async () => [] };
          },
        };
      }
      throw new Error(`Unexpected collection: ${name}`);
    });

    const res = await app.request("/items/item-1/changelog?limit=5&page=1");

    expect(res.status).toBe(200);
    const lookupPipelines = capturedPipeline
      .map((stage) => stage.$lookup?.pipeline)
      .filter((pipeline): pipeline is PipelineStage[] => Boolean(pipeline));
    expect(lookupPipelines).toHaveLength(3);
    expect(lookupPipelines[0]).toContainEqual({
      $project: { _id: 1, id: 1, title: 1, namespace: 1 },
    });
    expect(lookupPipelines[1]).toContainEqual({
      $project: { _id: 1, artifactId: 1, itemId: 1, platform: 1 },
    });
    expect(lookupPipelines[2]).toContainEqual({
      $project: {
        _id: 1,
        appName: 1,
        buildVersion: 1,
        labelName: 1,
        platform: 1,
      },
    });
  });
});
