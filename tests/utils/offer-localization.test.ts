import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  collection: vi.fn(),
  find: vi.fn(),
  toArray: vi.fn(),
}));

vi.mock("../../src/db/index.js", () => ({
  db: {
    db: {
      collection: mocks.collection,
    },
  },
}));

import {
  getLocalizedCacheTtlSeconds,
  InvalidLocaleError,
  localizeOffers,
  parseLocale,
} from "../../src/utils/offer-localization.js";

const offer = {
  id: "offer-1",
  namespace: "ns",
  title: "Canonical title",
  description: "Canonical description",
  longDescription: "Canonical long description",
  price: {
    price: {
      discountPrice: 999,
    },
  },
  countriesWhitelist: ["US"],
};

describe("offer localization", () => {
  beforeEach(() => {
    mocks.collection.mockReset();
    mocks.find.mockReset();
    mocks.toArray.mockReset();
    mocks.collection.mockReturnValue({
      find: mocks.find,
    });
    mocks.find.mockReturnValue({
      toArray: mocks.toArray,
    });
  });

  it("defaults missing and blank locale values to en-US", () => {
    expect(parseLocale()).toBe("en-US");
    expect(parseLocale("")).toBe("en-US");
    expect(parseLocale("   ")).toBe("en-US");
  });

  it("rejects invalid locale values", () => {
    expect(() => parseLocale("en_US")).toThrow(InvalidLocaleError);
    expect(() => parseLocale("not-a-locale")).toThrow(InvalidLocaleError);
  });

  it("marks canonical offers without querying localizations", async () => {
    const [localized] = await localizeOffers([offer], "en-US");

    expect(localized).toMatchObject({
      title: "Canonical title",
      locale: "en-US",
      localeStatus: "canonical",
    });
    expect(localized).not.toHaveProperty("canonicalLocale");
    expect(mocks.collection).not.toHaveBeenCalled();
  });

  it("overlays localized fields while preserving operational fields", async () => {
    mocks.toArray.mockResolvedValue([
      {
        entityType: "offer",
        entityId: "ns:offer-1",
        locale: "es-ES",
        source: "graphql.catalogOffer",
        fetchedAt: new Date("2026-07-01T08:41:42.413Z"),
        sourceUpdatedAt: new Date("2026-06-16T07:53:22.886Z"),
        data: {
          title: "Titulo localizado",
          price: {
            price: {
              discountPrice: 1,
            },
          },
          countriesWhitelist: ["ES"],
        },
      },
    ]);

    const [localized] = await localizeOffers([offer], "es-ES");

    expect(localized).toMatchObject({
      title: "Titulo localizado",
      description: "Canonical description",
      price: {
        price: {
          discountPrice: 999,
        },
      },
      countriesWhitelist: ["US"],
      locale: "es-ES",
      localeStatus: "localized",
      canonicalLocale: "en-US",
      localization: {
        source: "graphql.catalogOffer",
        fetchedAt: new Date("2026-07-01T08:41:42.413Z"),
        sourceUpdatedAt: new Date("2026-06-16T07:53:22.886Z"),
      },
    });
  });

  it("keeps canonical fields when a localization is missing", async () => {
    mocks.toArray.mockResolvedValue([]);

    const [localized] = await localizeOffers([offer], "fr-FR");

    expect(localized).toMatchObject({
      title: "Canonical title",
      locale: "fr-FR",
      localeStatus: "fallback",
      canonicalLocale: "en-US",
    });
    expect(localized).not.toHaveProperty("localization");
  });

  it("fetches localizations for offers in one batch", async () => {
    mocks.toArray.mockResolvedValue([
      {
        entityType: "offer",
        entityId: "ns:offer-2",
        locale: "es-ES",
        source: "graphql.catalogOffer",
        fetchedAt: new Date("2026-07-01T08:41:42.413Z"),
        data: {
          title: "Segundo",
        },
      },
    ]);

    const result = await localizeOffers(
      [
        offer,
        {
          ...offer,
          id: "offer-2",
          title: "Second",
        },
      ],
      "es-ES",
    );

    expect(mocks.collection).toHaveBeenCalledWith("egs_localizations");
    expect(mocks.find).toHaveBeenCalledWith({
      entityType: "offer",
      entityId: {
        $in: ["ns:offer-1", "ns:offer-2"],
      },
      locale: "es-ES",
    });
    expect(result.map((item) => item.localeStatus)).toEqual([
      "fallback",
      "localized",
    ]);
  });

  it("caps fallback cache TTLs", () => {
    expect(
      getLocalizedCacheTtlSeconds(
        {
          elements: [
            {
              localeStatus: "fallback",
            },
          ],
        },
        3600,
      ),
    ).toBe(60);
    expect(
      getLocalizedCacheTtlSeconds(
        {
          elements: [
            {
              localeStatus: "localized",
            },
          ],
        },
        3600,
      ),
    ).toBe(3600);
  });
});
