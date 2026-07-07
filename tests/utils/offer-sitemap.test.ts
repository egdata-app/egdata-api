import { describe, expect, it } from "vitest";
import {
  getOfferSitemapEntries,
  getOfferSitemapUrls,
  OFFER_SITEMAP_FILE_SIZE_SAFE_PAGE_LIMIT,
  OFFER_SITEMAP_LOCALES,
  OFFER_SITEMAP_PAGE_LIMIT,
  OFFER_SITEMAP_SECTIONS,
  OFFER_SITEMAP_URLS_PER_OFFER,
  SITEMAP_URL_LIMIT,
} from "../../src/utils/offer-sitemap.js";

describe("offer sitemap URL generation", () => {
  it("builds canonical offer entries", () => {
    const urls = getOfferSitemapUrls("offer-1");

    expect(urls).toContain("https://egdata.app/offers/offer-1");
    expect(urls).not.toContain("https://egdata.app/es-ES/offers/offer-1");
    expect(urls).toHaveLength(OFFER_SITEMAP_SECTIONS.length + 1);
  });

  it("adds hreflang alternates for every localized URL", () => {
    const [entry] = getOfferSitemapEntries("offer-1");

    expect(entry).toMatchObject({
      loc: "https://egdata.app/offers/offer-1",
    });
    expect(entry?.alternates).toContainEqual({
      hreflang: "x-default",
      href: "https://egdata.app/offers/offer-1",
    });
    expect(entry?.alternates).toContainEqual({
      hreflang: "es-ES",
      href: "https://egdata.app/es-ES/offers/offer-1",
    });
    expect(entry?.alternates).toHaveLength(OFFER_SITEMAP_LOCALES.length + 1);
  });

  it("keeps each generated sitemap page below the URL limit", () => {
    expect(
      OFFER_SITEMAP_PAGE_LIMIT * OFFER_SITEMAP_URLS_PER_OFFER,
    ).toBeLessThanOrEqual(SITEMAP_URL_LIMIT);
  });

  it("caps offer sitemap pages to a small file-size-safe offer count", () => {
    expect(OFFER_SITEMAP_PAGE_LIMIT).toBeLessThanOrEqual(
      OFFER_SITEMAP_FILE_SIZE_SAFE_PAGE_LIMIT,
    );
    expect(OFFER_SITEMAP_FILE_SIZE_SAFE_PAGE_LIMIT).toBe(500);
  });
});
