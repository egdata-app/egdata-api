import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveChangelogContext,
  resolveChangelogContextSafely,
} from "../src/utils/changelog-context.js";

const mocks = vi.hoisted(() => {
  const buildsFindOne = vi.fn();

  return {
    assetFindOne: vi.fn(),
    buildsFindOne,
    collection: vi.fn(() => ({ findOne: buildsFindOne })),
    itemFindOne: vi.fn(),
    offerFindOne: vi.fn(),
  };
});

vi.mock("../src/models/index.js", () => ({
  Asset: {
    findOne: mocks.assetFindOne,
  },
  Item: {
    findOne: mocks.itemFindOne,
  },
  Offer: {
    findOne: mocks.offerFindOne,
  },
}));

vi.mock("../src/db/index.js", () => ({
  db: {
    db: {
      collection: mocks.collection,
    },
  },
}));

describe("changelog context resolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves offer context", async () => {
    const offer = {
      id: "offer-1",
      title: "Offer One",
      namespace: "sandbox-1",
    };
    mocks.offerFindOne.mockResolvedValue({
      toObject: () => offer,
    });

    const context = await resolveChangelogContext("offer", "offer-1");

    expect(context).toEqual(offer);
    expect(mocks.offerFindOne).toHaveBeenCalledWith(
      { id: { $eq: "offer-1" } },
      {
        id: 1,
        title: 1,
        keyImages: 1,
        offerType: 1,
        namespace: 1,
      },
    );
  });

  it("resolves item context", async () => {
    const item = {
      id: "item-1",
      title: "Item One",
      namespace: "sandbox-1",
    };
    mocks.itemFindOne.mockResolvedValue({
      toObject: () => item,
    });

    const context = await resolveChangelogContext("item", "item-1");

    expect(context).toEqual(item);
    expect(mocks.itemFindOne).toHaveBeenCalledWith(
      { id: { $eq: "item-1" } },
      {
        id: 1,
        title: 1,
        keyImages: 1,
        namespace: 1,
      },
    );
  });

  it("resolves asset context by artifactId or id", async () => {
    const asset = {
      artifactId: "artifact-1",
      id: "asset-1",
      namespace: "sandbox-1",
    };
    mocks.assetFindOne.mockResolvedValue({
      toObject: () => asset,
    });

    const context = await resolveChangelogContext("asset", "artifact-1");

    expect(context).toEqual(asset);
    expect(mocks.assetFindOne).toHaveBeenCalledWith(
      {
        $or: [
          { artifactId: { $eq: "artifact-1" } },
          { id: { $eq: "artifact-1" } },
        ],
      },
      {
        id: 1,
        artifactId: 1,
        namespace: 1,
      },
    );
  });

  it("resolves build context by ObjectId string", async () => {
    const buildId = new ObjectId();
    const build = {
      _id: buildId,
      appName: "test-build",
    };
    mocks.buildsFindOne.mockResolvedValue(build);

    const context = await resolveChangelogContext("build", buildId.toString());

    expect(context).toEqual(build);
    expect(mocks.collection).toHaveBeenCalledWith("builds");
    const [filter, options] = mocks.buildsFindOne.mock.calls[0];
    const filters = filter.$or.map((entry: Record<string, unknown>) => {
      const id = entry._id as ObjectId | { $eq: string };
      return id instanceof ObjectId ? id.toString() : id.$eq;
    });
    expect(filters).toEqual(
      expect.arrayContaining([buildId.toString(), buildId.toString()]),
    );
    expect(options).toEqual({
      projection: {
        _id: 1,
        appName: 1,
        buildVersion: 1,
      },
    });
  });

  it("resolves build context by non-ObjectId string", async () => {
    const build = {
      _id: "legacy-build-id",
      appName: "test-build",
      buildVersion: "1.0.0",
    };
    mocks.buildsFindOne.mockResolvedValue(build);

    const context = await resolveChangelogContext("build", "legacy-build-id");

    expect(context).toEqual(build);
    expect(mocks.buildsFindOne).toHaveBeenCalledWith(
      { _id: { $eq: "legacy-build-id" } },
      {
        projection: {
          _id: 1,
          appName: 1,
          buildVersion: 1,
        },
      },
    );
  });

  it("returns null for missing args and unknown context types", async () => {
    await expect(resolveChangelogContext()).resolves.toBeNull();
    await expect(
      resolveChangelogContext("offer", null as unknown as string),
    ).resolves.toBeNull();
    await expect(
      resolveChangelogContext("unknown", "context-1"),
    ).resolves.toBeNull();

    expect(mocks.offerFindOne).not.toHaveBeenCalled();
    expect(mocks.itemFindOne).not.toHaveBeenCalled();
    expect(mocks.assetFindOne).not.toHaveBeenCalled();
    expect(mocks.buildsFindOne).not.toHaveBeenCalled();
  });

  it("returns null when safe context enrichment fails", async () => {
    mocks.assetFindOne.mockRejectedValue(new Error("lookup timed out"));

    const context = await resolveChangelogContextSafely("asset", "artifact-1");

    expect(context).toBeNull();
  });
});
