import { describe, expect, it } from "vitest";
import {
  getOfferSitemapUrls,
  OFFER_SITEMAP_LOCALES,
  OFFER_SITEMAP_PAGE_LIMIT,
  OFFER_SITEMAP_SECTIONS,
  OFFER_SITEMAP_URLS_PER_OFFER,
  SITEMAP_URL_LIMIT,
} from "../../src/utils/offer-sitemap.js";

describe("offer sitemap URL generation", () => {
  it("builds base and locale-prefixed offer section URLs", () => {
    const urls = getOfferSitemapUrls("offer-1");

    expect(urls).toContain("https://egdata.app/offers/offer-1");
    expect(urls).toContain("https://egdata.app/offers/offer-1/media");
    expect(urls).toContain("https://egdata.app/es-ES/offers/offer-1");
    expect(urls).toContain("https://egdata.app/es-ES/offers/offer-1/media");
    expect(urls).toHaveLength(
      (OFFER_SITEMAP_SECTIONS.length + 1) * (OFFER_SITEMAP_LOCALES.length + 1),
    );
  });

  it("keeps each generated sitemap page below the URL limit", () => {
    expect(
      OFFER_SITEMAP_PAGE_LIMIT * OFFER_SITEMAP_URLS_PER_OFFER,
    ).toBeLessThanOrEqual(SITEMAP_URL_LIMIT);
  });
});
