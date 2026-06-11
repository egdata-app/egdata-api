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
    const filter = mocks.buildsFindOne.mock.calls[0][0];
    expect(filter.$or[0]._id.toString()).toBe(buildId.toString());
    expect(filter.$or[1]._id.$eq).toBe(buildId.toString());
  });

  it("returns null when safe context enrichment fails", async () => {
    mocks.assetFindOne.mockRejectedValue(new Error("lookup timed out"));

    const context = await resolveChangelogContextSafely("asset", "artifact-1");

    expect(context).toBeNull();
  });
});
