export const SITEMAP_URL_LIMIT = 50_000;
export const OFFER_SITEMAP_SECTIONS = [
  "price",
  "items",
  "achievements",
  "related",
  "metadata",
  "changelog",
  "media",
] as const;
export const OFFER_SITEMAP_LOCALES = [
  "id",
  "ms",
  "da",
  "de",
  "en-US",
  "es-ES",
  "es-MX",
  "fil",
  "fr",
  "it",
  "hu",
  "nl",
  "no",
  "pl",
  "pt-BR",
  "pt",
  "ro",
  "fi",
  "sv",
  "vi",
  "tr",
  "cs",
  "bg",
  "ru",
  "uk",
  "ar",
  "hi",
  "th",
  "ja",
  "zh-CN",
  "zh-Hant",
  "ko",
] as const;
export const OFFER_SITEMAP_URLS_PER_OFFER =
  (OFFER_SITEMAP_SECTIONS.length + 1) * (OFFER_SITEMAP_LOCALES.length + 1);
const OFFER_SITEMAP_FILE_SIZE_SAFE_PAGE_LIMIT = 40;
export const OFFER_SITEMAP_PAGE_LIMIT = Math.min(
  Math.floor(SITEMAP_URL_LIMIT / OFFER_SITEMAP_URLS_PER_OFFER),
  OFFER_SITEMAP_FILE_SIZE_SAFE_PAGE_LIMIT,
);

export type OfferSitemapAlternate = {
  hreflang: string;
  href: string;
};

export type OfferSitemapEntry = {
  loc: string;
  alternates: OfferSitemapAlternate[];
};

const OFFER_SITEMAP_ROUTE_SUFFIXES = [
  "",
  ...OFFER_SITEMAP_SECTIONS.map((section) => `/${section}`),
];

const getOfferSitemapAlternates = (
  offerId: string,
  routeSuffix: string,
): OfferSitemapAlternate[] => [
  {
    hreflang: "x-default",
    href: `https://egdata.app/offers/${offerId}${routeSuffix}`,
  },
  ...OFFER_SITEMAP_LOCALES.map((locale) => ({
    hreflang: locale,
    href: `https://egdata.app/${locale}/offers/${offerId}${routeSuffix}`,
  })),
];

export const getOfferSitemapEntries = (offerId: string): OfferSitemapEntry[] =>
  OFFER_SITEMAP_ROUTE_SUFFIXES.flatMap((routeSuffix) => {
    const alternates = getOfferSitemapAlternates(offerId, routeSuffix);

    return alternates.map((alternate) => ({
      loc: alternate.href,
      alternates,
    }));
  });

export const getOfferSitemapUrls = (offerId: string) =>
  getOfferSitemapEntries(offerId).map((entry) => entry.loc);
