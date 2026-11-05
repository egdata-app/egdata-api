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
  it("returns the full offer document for list endpoints", () => {
    const card = toOfferCard(baseOffer);

    expect(card).toMatchObject({
      _id: "mongo-id",
      id: "offer-id",
      namespace: "sandbox-id",
      title: "Example Game",
      description: "short",
      longDescription: baseOffer.longDescription,
      offerType: "BASE_GAME",
      productSlug: "example-game",
      urlSlug: "example-game",
      seller: { id: "seller-id", name: "Example Seller" },
      tags: [{ id: "tag", name: "Tag" }],
      items: [{ id: "item" }],
      categories: ["category"],
      offerMappings: [{ pageSlug: "slug" }],
    });
    expect(card.customAttributes).toEqual({
      key: { type: "STRING", value: "value" },
    });
    expect(card.keyImages).toHaveLength(5);
  });

  it("attaches the supplied price and defaults to null", () => {
    const price = { offerId: "offer-id", price: { discountPrice: 1000 } };

    expect(toOfferCard(baseOffer, price).price).toBe(price);
    expect(toOfferCard(baseOffer).price).toBeNull();
  });
});
