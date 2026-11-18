import { expect, it, vi } from "vitest";
import { getProduct } from "../src/utils/get-product.js";

const { connection, collection, findProduct } = vi.hoisted(() => {
  const findProduct = vi.fn().mockResolvedValue({ _id: "product" });
  const collection = vi.fn(() => ({ findOne: findProduct }));
  const connection: { db?: { collection: typeof collection } } = {};
  return { connection, collection, findProduct };
});
vi.mock("../src/db/index.js", () => ({ db: connection }));
vi.mock("../src/models/index.js", () => ({
  Offer: { findOne: async () => ({ namespace: "sandbox" }) },
  Sandbox: { findOne: async () => ({ parent: "product" }) },
}));

it("resolves the product when the database connects after route imports", async () => {
  connection.db = { collection };
  await expect(getProduct("offer")).resolves.toEqual({ _id: "product" });
  expect(collection).toHaveBeenCalledWith("products");
  expect(findProduct).toHaveBeenCalledWith({ _id: { $eq: "product" } });
});
