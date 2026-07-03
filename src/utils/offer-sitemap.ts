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
export const OFFER_SITEMAP_PAGE_LIMIT = Math.floor(
  SITEMAP_URL_LIMIT / OFFER_SITEMAP_URLS_PER_OFFER,
);

export const getOfferSitemapUrls = (offerId: string) => {
  const routeSuffixes = [
    "",
    ...OFFER_SITEMAP_SECTIONS.map((section) => `/${section}`),
  ];
  const localePrefixes = [
    "",
    ...OFFER_SITEMAP_LOCALES.map((locale) => `/${locale}`),
  ];

  return localePrefixes.flatMap((localePrefix) =>
    routeSuffixes.map(
      (routeSuffix) =>
        `https://egdata.app${localePrefix}/offers/${offerId}${routeSuffix}`,
    ),
  );
};
