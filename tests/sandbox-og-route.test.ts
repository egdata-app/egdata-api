import { Hono } from "hono";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OgRoute from "../src/routes/sandbox-og.js";

const mocks = vi.hoisted(() => ({
  sandbox: vi.fn(),
  collection: vi.fn(),
  offers: vi.fn(),
  identity: vi.fn(),
  itemIdentity: vi.fn(),
  items: vi.fn(),
  assets: vi.fn(),
  render: vi.fn(),
}));
vi.mock("../src/models/index.js", () => ({
  Offer: {
    countDocuments: (...args: unknown[]) => mocks.offers(...args),
    findOne: (...args: unknown[]) => ({ lean: () => mocks.identity(...args) }),
  },
  Item: {
    find: (...args: unknown[]) => ({ lean: () => mocks.items(...args) }),
    findOne: (...args: unknown[]) => ({
      lean: () => mocks.itemIdentity(...args),
    }),
  },
  Asset: {
    find: (...args: unknown[]) => ({ lean: () => mocks.assets(...args) }),
  },
}));
vi.mock("../src/db/index.js", () => ({
  db: { db: { collection: (...args: unknown[]) => mocks.collection(...args) } },
}));
vi.mock("../src/utils/database-og.js", async () => ({
  ...(await vi.importActual("../src/utils/database-og.js")),
  renderDatabaseOg: (...args: unknown[]) => mocks.render(...args),
}));
const app = new Hono().route("/sandboxes/:sandboxId", OgRoute);
const baseGame = {
  title: "Example game",
  publisherDisplayName: "Publisher",
  keyImages: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.collection.mockReturnValue({ findOne: mocks.sandbox });
  mocks.sandbox.mockResolvedValue({
    _id: "sandbox",
    displayName: "Live",
    updated: "2026-09-24T23:00:00Z",
  });
  mocks.offers.mockResolvedValue(5);
  mocks.identity.mockResolvedValue(baseGame);
  mocks.items.mockResolvedValue([
    { releaseInfo: [{ appId: "stored", platform: ["Windows"] }] },
    { releaseInfo: [{ appId: "virtual", platform: ["Windows", "Mac"] }] },
    {},
  ]);
  mocks.assets.mockResolvedValue([{ artifactId: "stored" }]);
  mocks.itemIdentity.mockResolvedValue(null);
  mocks.render.mockResolvedValue(Buffer.from("rendered-image"));
});

describe("sandbox OG routes", () => {
  it.each([
    ["og", "png"],
    ["og.webp", "webp"],
  ])("serves %s with sandbox totals and update date", async (path, format) => {
    const response = await app.request(`/sandboxes/sandbox/${path}?v=123`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(`image/${format}`);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(mocks.sandbox).toHaveBeenCalledWith({ _id: { $eq: "sandbox" } });
    expect(mocks.offers).toHaveBeenCalledWith({ namespace: "sandbox" });
    expect(mocks.render).toHaveBeenCalledWith(
      {
        title: "Example game",
        subtitle: "Sandbox · Publisher",
        metrics: [
          { label: "OFFERS", value: "5", detail: "Store entries" },
          { label: "ITEMS", value: "3", detail: "Catalog items" },
          { label: "ASSETS", value: "3", detail: "Distribution records" },
        ],
        footer: { label: "Last update", value: "24 Sept 2026" },
      },
      format,
      undefined,
    );
    expect(mocks.identity).toHaveBeenCalledTimes(1);
    expect(mocks.identity).toHaveBeenCalledWith(
      {
        namespace: { $eq: "sandbox" },
        offerType: "BASE_GAME",
        prePurchase: { $ne: true },
        isCodeRedemptionOnly: false,
      },
      undefined,
      { sort: { creationDate: 1, id: 1 } },
    );
    expect(mocks.itemIdentity).not.toHaveBeenCalled();
  });

  it.each([
    "og",
    "og.webp",
  ])("returns 404 for unknown sandboxes on %s before querying counts", async (path) => {
    mocks.sandbox.mockResolvedValue(null);
    const response = await app.request(`/sandboxes/missing/${path}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "Sandbox not found" });
    expect(mocks.offers).not.toHaveBeenCalled();
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it("falls back to preorder identity before executable items", async () => {
    mocks.identity
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...baseGame, title: "Preorder" });
    await app.request("/sandboxes/sandbox/og");
    expect(mocks.identity.mock.calls[1][0]).toEqual({
      namespace: { $eq: "sandbox" },
      offerType: "BASE_GAME",
      prePurchase: true,
    });
    expect(mocks.render.mock.calls[0][0].title).toBe("Preorder");
    expect(mocks.itemIdentity).not.toHaveBeenCalled();
  });

  it("uses executable items and the seller when no base-game offer exists", async () => {
    mocks.identity.mockResolvedValue(null);
    mocks.itemIdentity.mockResolvedValue({
      title: "Executable",
      seller: { name: "Seller" },
      keyImages: [],
    });
    await app.request("/sandboxes/sandbox/og");
    expect(mocks.itemIdentity.mock.calls[0][0]).toEqual({
      namespace: { $eq: "sandbox" },
      entitlementType: "EXECUTABLE",
      "releaseInfo.0": { $exists: true },
    });
    expect(mocks.render.mock.calls[0][0]).toMatchObject({
      title: "Executable",
      subtitle: "Sandbox · Seller",
    });
  });

  it("renders empty sandboxes with explicit zero counts and missing dates", async () => {
    mocks.identity.mockResolvedValue(null);
    mocks.sandbox.mockResolvedValue({ _id: "sandbox", displayName: "Live" });
    mocks.offers.mockResolvedValue(0);
    mocks.items.mockResolvedValue([]);
    mocks.assets.mockResolvedValue([]);
    await app.request("/sandboxes/sandbox/og");
    const card = mocks.render.mock.calls[0][0];
    expect(card).toMatchObject({
      title: "Live",
      subtitle: "Sandbox",
      footer: { value: "Not available" },
    });
    expect(
      card.metrics.map((metric: { value: string }) => metric.value),
    ).toEqual(["0", "0", "0"]);
  });

  it.each([
    "png",
    "webp",
  ] as const)("returns decodable 1200 by 630 %s bytes through HTTP", async (format) => {
    const actual = await vi.importActual<
      typeof import("../src/utils/database-og.js")
    >("../src/utils/database-og.js");
    mocks.render.mockImplementationOnce(actual.renderDatabaseOg);
    const response = await app.request(
      `/sandboxes/sandbox/${format === "png" ? "og" : "og.webp"}`,
    );
    expect(response.status).toBe(200);
    expect(
      await sharp(Buffer.from(await response.arrayBuffer())).metadata(),
    ).toMatchObject({ format, width: 1200, height: 630 });
  });
});
