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
}));

vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn(),
    addBulk: vi.fn(),
  })),
}));

vi.mock("../src/clients/redis.js", () => ({
  default: {
    get: mocks.redisGet,
    set: mocks.redisSet,
  },
  ioredis: {},
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
    mocks.itemFindOne.mockReset();
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
});
