import { describe, expect, it } from "vitest";
import { toOfferCard } from "../../src/utils/offer-card.js";

const baseOffer = {
  _id: "mongo-id",
  id: "offer-id",
  namespace: "sandbox-id",
  title: "Example Game",
  description: "short",
  longDescription: "very long description".repeat(100),
  offerType: "BASE_GAME",
  productSlug: "example-game",
  urlSlug: "example-game",
  seller: { id: "seller-id", name: "Example Seller" },
  developerDisplayName: "Example Dev",
  publisherDisplayName: "Example Pub",
  releaseDate: new Date("2020-01-01T00:00:00.000Z"),
  effectiveDate: new Date("2020-01-01T00:00:00.000Z"),
  lastModifiedDate: new Date("2024-01-01T00:00:00.000Z"),
  prePurchase: false,
  keyImages: [
    { type: "OfferImageTall", url: "https://img/1", md5: "1" },
    { type: "Thumbnail", url: "https://img/2", md5: "2" },
    { type: "DieselGameBoxTall", url: "https://img/3", md5: "3" },
    { type: "OfferImageWide", url: "https://img/4", md5: "4" },
    { type: "Featured", url: "https://img/5", md5: "5" },
  ],
  tags: [{ id: "tag", name: "Tag" }],
  items: [{ id: "item" }],
  customAttributes: [{ key: "key", value: "value" }],
  categories: ["category"],
  offerMappings: [{ pageSlug: "slug" }],
};

describe("toOfferCard", () => {
  it("keeps card fields and drops the heavy detail fields", () => {
    const card = toOfferCard(baseOffer);

    expect(card).toMatchObject({
      id: "offer-id",
      namespace: "sandbox-id",
      title: "Example Game",
      offerType: "BASE_GAME",
      productSlug: "example-game",
      urlSlug: "example-game",
      seller: { id: "seller-id", name: "Example Seller" },
    });
    expect(card).not.toHaveProperty("description");
    expect(card).not.toHaveProperty("longDescription");
    expect(card).not.toHaveProperty("tags");
    expect(card).not.toHaveProperty("items");
    expect(card).not.toHaveProperty("customAttributes");
    expect(card).not.toHaveProperty("offerMappings");
    expect(card).not.toHaveProperty("categories");
  });

  it("limits key images to four unique urls", () => {
    const card = toOfferCard(baseOffer);

    expect(card.keyImages).toHaveLength(4);
    expect(new Set(card.keyImages.map((image) => image.url)).size).toBe(4);
  });

  it("attaches the supplied price and defaults to null", () => {
    const price = { offerId: "offer-id", price: { discountPrice: 1000 } };

    expect(toOfferCard(baseOffer, price).price).toBe(price);
    expect(toOfferCard(baseOffer).price).toBeNull();
  });
});
