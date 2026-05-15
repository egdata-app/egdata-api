import { describe, expect, it } from "vitest";
import { orderOffersObject } from "../../src/utils/order-offers-object.js";

// Minimal stand-in — the real OfferType pulls from external schema packages;
// the function only reads the listed fields, so we pass an `as any` cast.
const baseOffer = {
  _id: "abc",
  id: "offer-1",
  namespace: "ns",
  title: "T",
  description: "D",
  offerType: "BASE_GAME",
  effectiveDate: "2024-01-01",
  creationDate: "2024-01-01",
  lastModifiedDate: "2024-01-01",
  isCodeRedemptionOnly: false,
  keyImages: [],
  currentPrice: null,
  seller: { id: "s", name: "Seller" },
  productSlug: "slug",
  urlSlug: "slug",
  url: null,
  tags: [],
  items: [],
  categories: [],
  developerDisplayName: "Dev",
  publisherDisplayName: "Pub",
  prePurchase: false,
  releaseDate: "2024-01-01",
  pcReleaseDate: "2024-01-01",
  viewableDate: "2024-01-01",
  countriesBlacklist: [],
  countriesWhitelist: [],
  refundType: "NO_REFUND",
};

describe("orderOffersObject", () => {
  it("emits keys in the documented order regardless of input order", () => {
    // biome-ignore lint/suspicious/noExplicitAny: see comment above
    const result = orderOffersObject(baseOffer as any);
    expect(Object.keys(result)).toEqual([
      "_id",
      "id",
      "namespace",
      "title",
      "description",
      "offerType",
      "effectiveDate",
      "creationDate",
      "lastModifiedDate",
      "isCodeRedemptionOnly",
      "keyImages",
      "currentPrice",
      "seller",
      "productSlug",
      "urlSlug",
      "url",
      "tags",
      "items",
      "customAttributes",
      "categories",
      "developerDisplayName",
      "publisherDisplayName",
      "prePurchase",
      "releaseDate",
      "pcReleaseDate",
      "viewableDate",
      "countriesBlacklist",
      "countriesWhitelist",
      "refundType",
    ]);
  });

  it("passes customAttributes through attributesToObject when present", () => {
    const result = orderOffersObject({
      ...baseOffer,
      customAttributes: [
        { key: "FeatureA", type: "STRING", value: "yes" },
        { key: "FeatureB", type: "BOOLEAN", value: "true" },
      ],
      // biome-ignore lint/suspicious/noExplicitAny: see comment above
    } as any);
    expect(result.customAttributes).toEqual({
      FeatureA: { type: "STRING", value: "yes" },
      FeatureB: { type: "BOOLEAN", value: "true" },
    });
  });

  it("leaves customAttributes undefined when absent", () => {
    // biome-ignore lint/suspicious/noExplicitAny: see comment above
    const result = orderOffersObject(baseOffer as any);
    expect(result.customAttributes).toBeUndefined();
  });
});
