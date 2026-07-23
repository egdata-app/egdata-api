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
    mocks.itemFindOne.mockReset();
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
});
