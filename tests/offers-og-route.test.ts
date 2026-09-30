import { Hono } from "hono";
import { ObjectId } from "mongodb";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OgRoute from "../src/routes/offers/og.js";

const mocks = vi.hoisted(() => ({
  offer: vi.fn(),
  price: vi.fn(),
  items: vi.fn(),
  assets: vi.fn(),
  subItems: vi.fn(),
  collection: vi.fn(),
  find: vi.fn(),
  sort: vi.fn(),
  limit: vi.fn(),
  next: vi.fn(),
  render: vi.fn(),
}));
vi.mock("../src/models/index.js", () => ({
  Offer: {
    findOne: (...args: unknown[]) => ({ lean: () => mocks.offer(...args) }),
  },
  PriceEngine: {
    findOne: (...args: unknown[]) => ({ lean: () => mocks.price(...args) }),
  },
  Item: {
    find: (...args: unknown[]) => ({ lean: () => mocks.items(...args) }),
  },
  Asset: {
    find: (...args: unknown[]) => ({ lean: () => mocks.assets(...args) }),
  },
}));
vi.mock("../src/db/index.js", () => ({
  db: { db: { collection: (...args: unknown[]) => mocks.collection(...args) } },
}));
vi.mock("../src/utils/get-offer-sub-items.js", () => ({
  getOfferSubItems: (...args: unknown[]) => mocks.subItems(...args),
}));
vi.mock("../src/utils/offer-og.js", async () => ({
  ...(await vi.importActual("../src/utils/offer-og.js")),
  renderOfferOg: (...args: unknown[]) => mocks.render(...args),
}));
const app = new Hono().route("/offers/:id", OgRoute);
const offer = {
  id: "offer",
  title: "Example game",
  offerType: "BASE_GAME",
  publisherDisplayName: "Publisher",
  lastModifiedDate: "2026-09-24T14:02:45Z",
  releaseDate: "2026-08-26",
  keyImages: [],
  items: [{ id: "main" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.offer.mockResolvedValue({ ...offer });
  mocks.price.mockResolvedValue({
    price: { discountPrice: 3999, currencyCode: "USD" },
  });
  mocks.items.mockResolvedValue([{ id: "main" }]);
  mocks.assets.mockResolvedValue([]);
  mocks.subItems.mockResolvedValue([]);
  mocks.render.mockResolvedValue(Buffer.from("rendered-image"));
  mocks.collection.mockReturnValue({ find: mocks.find });
  mocks.find.mockReturnValue({ sort: mocks.sort });
  mocks.sort.mockReturnValue({ limit: mocks.limit });
  mocks.limit.mockReturnValue({ next: mocks.next });
  mocks.next.mockResolvedValue(null);
});

describe("offer OG routes", () => {
  it("returns decodable WebP bytes through the HTTP route", async () => {
    const actual = await vi.importActual<
      typeof import("../src/utils/offer-og.js")
    >("../src/utils/offer-og.js");
    mocks.render.mockImplementationOnce(actual.renderOfferOg);
    const response = await app.request("/offers/offer/og.webp?country=US");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(
      await sharp(Buffer.from(await response.arrayBuffer())).metadata(),
    ).toMatchObject({
      format: "webp",
      width: 1200,
      height: 630,
    });
  });
  it.each([
    ["og", "png"],
    ["og.webp", "webp"],
  ])("serves %s with the correct encoder and content type", async (path, format) => {
    const response = await app.request(`/offers/offer/${path}?v=123`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(`image/${format}`);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(mocks.render).toHaveBeenCalledWith(
      expect.objectContaining({
        price: "$39.99",
        priceDetail: "USD · US",
        lastUpdate: "24 Sept 2026",
        assetSize: "Not available",
      }),
      format,
      undefined,
    );
  });

  it("returns existing 404 errors before rendering", async () => {
    const country = await app.request("/offers/offer/og.webp?country=UNKNOWN");
    expect(country.status).toBe(404);
    expect(await country.json()).toEqual({ message: "Country not found" });
    expect(mocks.offer).not.toHaveBeenCalled();
    mocks.offer.mockResolvedValue(null);
    const missing = await app.request("/offers/missing/og.webp");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ message: "Offer not found" });
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it("prefers explicit country over the cookie and respects country restrictions", async () => {
    mocks.offer.mockResolvedValue({ ...offer, countriesBlacklist: ["US"] });
    await app.request("/offers/offer/og.webp?country=US", {
      headers: { Cookie: "EGDATA_COUNTRY=GB" },
    });
    expect(mocks.price).not.toHaveBeenCalled();
    expect(mocks.render.mock.calls[0][0]).toMatchObject({
      price: "Unavailable",
      priceDetail: "USD · US",
    });
  });

  it("uses the cookie country, formats free prices, and keeps missing dates explicit", async () => {
    mocks.offer.mockResolvedValue({
      ...offer,
      releaseDate: null,
      lastModifiedDate: null,
    });
    mocks.price.mockResolvedValue({
      price: { discountPrice: 0, currencyCode: "GBP" },
    });
    await app.request("/offers/offer/og", {
      headers: { Cookie: "EGDATA_COUNTRY=GB" },
    });
    expect(mocks.render.mock.calls[0][0]).toMatchObject({
      price: "Free",
      priceDetail: "GBP · GB",
      lastUpdate: "Not available",
      releaseDate: "Not available",
    });
  });

  it("uses the latest direct-item build, not related DLC or catalog polling time", async () => {
    mocks.assets.mockResolvedValue([
      {
        itemId: "main",
        artifactId: "game",
        platform: "Windows",
        downloadSizeBytes: 9e9,
      },
      {
        itemId: "dlc",
        artifactId: "dlc",
        platform: "Windows",
        downloadSizeBytes: 20e9,
      },
    ]);
    mocks.next.mockResolvedValue({
      _id: new ObjectId(),
      appName: "game",
      buildVersion: "v1",
      labelName: "Live-Windows",
      hash: "hash",
      downloadSizeBytes: 3.25e9,
      createdAt: new Date("2026-09-28"),
    });
    await app.request("/offers/offer/og.webp");
    expect(mocks.find).toHaveBeenCalledWith({ appName: { $in: ["game"] } });
    expect(mocks.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
    expect(mocks.limit).toHaveBeenCalledWith(1);
    expect(mocks.render.mock.calls[0][0]).toMatchObject({
      assetSize: "3.25 GB",
      assetDetail: "Windows download",
      lastUpdate: "24 Sept 2026",
    });
  });
});
