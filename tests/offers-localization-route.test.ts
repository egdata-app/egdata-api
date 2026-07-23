import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import OffersRoute from "../src/routes/offers/index.js";

const mocks = vi.hoisted(() => ({
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  collection: vi.fn(),
  localizationFind: vi.fn(),
  localizationToArray: vi.fn(),
  offerFind: vi.fn(),
  offerFindOne: vi.fn(),
  offerFindOneLean: vi.fn(),
  offerCountDocuments: vi.fn(),
  priceFind: vi.fn(),
  submitJobApiBatch: vi.fn(),
  submitJobApiRequest: vi.fn(),
}));

vi.mock("../src/clients/job-api.js", () => ({
  submitJobApiBatch: mocks.submitJobApiBatch,
  submitJobApiRequest: mocks.submitJobApiRequest,
}));

vi.mock("consola", () => ({
  default: {
    info: vi.fn(),
  },
}));

vi.mock("../src/routes/auth.js", () => ({
  epic: async (_c: unknown, next: () => Promise<void>) => next(),
  epicInfo: async (_c: unknown, next: () => Promise<void>) => next(),
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

vi.mock("../src/models/index.js", () => {
  const model = () => ({
    aggregate: vi.fn(),
    countDocuments: vi.fn(),
    find: vi.fn(),
    findOne: vi.fn(),
  });

  return {
    AchievementSet: model(),
    Asset: model(),
    Bundles: model(),
    Changelog: model(),
    Collection: model(),
    Franchise: model(),
    FreeGames: model(),
    GamePosition: model(),
    Hltb: model(),
    Item: model(),
    Mappings: model(),
    Media: model(),
    Offer: {
      ...model(),
      find: mocks.offerFind,
      findOne: mocks.offerFindOne,
      countDocuments: mocks.offerCountDocuments,
    },
    OfferCountryPricingScore: model(),
    PriceEngine: {
      ...model(),
      find: mocks.priceFind,
    },
    PriceEngineHistorical: model(),
    Ratings: model(),
    Review: model(),
    Sandbox: model(),
    TagModel: model(),
    Tags: model(),
  };
});

const offer = {
  _id: "mongo-offer-1",
  id: "offer-1",
  namespace: "ns",
  title: "Canonical title",
  description: "Canonical description",
  longDescription: "Canonical long description",
  offerType: "BASE_GAME",
  effectiveDate: "2026-01-01T00:00:00.000Z",
  creationDate: "2026-01-01T00:00:00.000Z",
  lastModifiedDate: "2026-01-02T00:00:00.000Z",
  keyImages: [],
  seller: {
    id: "seller",
    name: "Canonical seller",
  },
  productSlug: "canonical-product",
  offerMappings: [],
  urlSlug: "canonical-url-slug",
  url: "/canonical-url",
  tags: [],
  items: [],
  customAttributes: [],
  developerDisplayName: "Canonical developer",
  publisherDisplayName: "Canonical publisher",
  countriesWhitelist: ["US"],
};

describe("offers route localization", () => {
  let app: Hono;

  beforeAll(() => {
    app = new Hono().route("/offers", OffersRoute);
  });

  beforeEach(() => {
    mocks.submitJobApiBatch.mockReset().mockResolvedValue([]);
    mocks.submitJobApiRequest.mockReset().mockResolvedValue(undefined);
    mocks.redisGet.mockReset().mockResolvedValue(null);
    mocks.redisSet.mockReset().mockResolvedValue("OK");
    mocks.collection.mockReset().mockReturnValue({
      find: mocks.localizationFind,
    });
    mocks.localizationFind.mockReset().mockReturnValue({
      toArray: mocks.localizationToArray,
    });
    mocks.localizationToArray.mockReset().mockResolvedValue([]);
    mocks.offerFind.mockReset().mockResolvedValue([offer]);
    mocks.offerFindOne.mockReset().mockReturnValue({
      lean: mocks.offerFindOneLean,
    });
    mocks.offerFindOneLean.mockReset().mockResolvedValue(offer);
    mocks.offerCountDocuments.mockReset().mockResolvedValue(1);
    mocks.priceFind.mockReset().mockResolvedValue([
      {
        offerId: "offer-1",
        region: "US",
        price: {
          originalPrice: 999,
          discountPrice: 999,
        },
      },
    ]);
  });

  it("preserves the Discord slug regen contract and decodes its path value", async () => {
    const res = await app.request("/offers/regen/product%2Fhome", {
      method: "PUT",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "Offer regen requested" });
    expect(mocks.submitJobApiRequest).toHaveBeenCalledWith("offer-regen", {
      slug: "product/home",
    });
  });

  it("preserves the Discord ID regen contract at the backend ID boundary", async () => {
    const id = "i".repeat(160);
    const res = await app.request(`/offers/regen-by-id/${id}`, {
      method: "PUT",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "Offer regen requested" });
    expect(mocks.submitJobApiRequest).toHaveBeenCalledWith("offer-regen", {
      id,
    });
  });

  it("preserves bulk offer request and response shapes, including duplicates", async () => {
    const res = await app.request("/offers/bulk-regen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        offers: ["duplicate", "duplicate", "offer-2"],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "Offer regen requested" });
    expect(mocks.submitJobApiBatch).toHaveBeenCalledWith("offer-regen", [
      { id: "duplicate" },
      { id: "duplicate" },
      { id: "offer-2" },
    ]);
  });

  it("does not return the Discord success contract when submission fails", async () => {
    mocks.submitJobApiRequest.mockRejectedValueOnce(
      new Error("submission not accepted"),
    );

    const res = await app.request("/offers/regen-by-id/offer-1", {
      method: "PUT",
    });

    expect(res.status).toBe(500);
  });

  it("does not expose regen handlers under the old method", async () => {
    const res = await app.request("/offers/regen-by-id/offer-1", {
      method: "POST",
    });

    expect(res.status).toBe(404);
    expect(mocks.submitJobApiRequest).not.toHaveBeenCalled();
  });

  it("overlays localized fields and metadata on GET /offers/{id}", async () => {
    const fetchedAt = new Date("2026-07-01T08:41:42.413Z");
    mocks.localizationToArray.mockResolvedValue([
      {
        entityType: "offer",
        entityId: "ns:offer-1",
        locale: "es-ES",
        source: "graphql.catalogOffer",
        fetchedAt,
        data: {
          title: "Titulo localizado",
          description: "Descripcion localizada",
          countriesWhitelist: ["ES"],
        },
      },
    ]);

    const res = await app.request("/offers/offer-1?locale=es-ES");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id: "offer-1",
      namespace: "ns",
      title: "Titulo localizado",
      description: "Descripcion localizada",
      countriesWhitelist: ["US"],
      locale: "es-ES",
      localeStatus: "localized",
      canonicalLocale: "en-US",
      localization: {
        source: "graphql.catalogOffer",
      },
    });
    expect(mocks.redisGet).toHaveBeenCalledWith(
      "offer:offer-1:locale:es-ES:v0.1",
    );
    expect(mocks.redisSet).toHaveBeenCalledWith(
      "offer:offer-1:locale:es-ES:v0.1",
      expect.any(String),
      "EX",
      60,
    );
  });

  it("adds fallback metadata and locale-aware cache keys on GET /offers", async () => {
    const res = await app.request("/offers?country=US&locale=fr-FR");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.elements).toHaveLength(1);
    expect(body.elements[0]).toMatchObject({
      id: "offer-1",
      title: "Canonical title",
      locale: "fr-FR",
      localeStatus: "fallback",
      canonicalLocale: "en-US",
      price: {
        offerId: "offer-1",
      },
    });
    expect(mocks.localizationFind).toHaveBeenCalledWith({
      entityType: "offer",
      entityId: {
        $in: ["ns:offer-1"],
      },
      locale: "fr-FR",
    });
    expect(mocks.redisGet).toHaveBeenCalledWith("offers:US:1:10:locale:fr-FR");
    expect(mocks.redisSet).toHaveBeenCalledWith(
      "offers:US:1:10:locale:fr-FR",
      expect.any(String),
      "EX",
      60,
    );
  });
});
