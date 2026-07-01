import type { Context } from "hono";
import { db } from "../db/index.js";

export const CANONICAL_LOCALE = "en-US";
export const FALLBACK_CACHE_TTL_SECONDS = 60;

const localePattern = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

const localizedOfferFields = [
  "title",
  "description",
  "longDescription",
  "developerDisplayName",
  "publisherDisplayName",
  "seller",
  "tags",
  "offerMappings",
  "productSlug",
  "urlSlug",
  "url",
] as const;

type LocalizedOfferField = (typeof localizedOfferFields)[number];
type LocaleStatus = "canonical" | "localized" | "fallback";
type AnyOffer = Record<string, any>;

type EgsLocalization = {
  _id?: string;
  entityType: string;
  entityId: string;
  namespace?: string;
  locale: string;
  source: string;
  data?: unknown;
  fetchedAt: Date;
  sourceUpdatedAt?: Date;
  matchesCanonical?: boolean;
};

type LocalizationMetadata = {
  source: string;
  fetchedAt: Date;
  sourceUpdatedAt?: Date;
};

export type LocalizedOfferMetadata = {
  locale: string;
  localeStatus: LocaleStatus;
  canonicalLocale?: typeof CANONICAL_LOCALE;
  localization?: LocalizationMetadata;
};

export class InvalidLocaleError extends Error {
  constructor(locale: string) {
    super(`Invalid locale parameter: ${locale}`);
    this.name = "InvalidLocaleError";
  }
}

const isRecord = (value: unknown): value is Record<string, any> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const isInvalidLocaleError = (
  value: unknown,
): value is InvalidLocaleError => value instanceof InvalidLocaleError;

type LocaleRequestResult =
  | {
      locale: string;
      errorResponse?: never;
    }
  | {
      locale?: never;
      errorResponse: Response;
    };

export const parseLocale = (value?: string | null) => {
  const requestedLocale = value?.trim();

  if (!requestedLocale) {
    return CANONICAL_LOCALE;
  }

  if (!localePattern.test(requestedLocale)) {
    throw new InvalidLocaleError(requestedLocale);
  }

  try {
    const [canonicalLocale] = Intl.getCanonicalLocales(requestedLocale);
    return canonicalLocale ?? requestedLocale;
  } catch {
    throw new InvalidLocaleError(requestedLocale);
  }
};

export const getLocaleOrErrorResponse = (c: Context): LocaleRequestResult => {
  try {
    return {
      locale: parseLocale(c.req.query("locale")),
    };
  } catch (error) {
    if (isInvalidLocaleError(error)) {
      return {
        errorResponse: c.json(
          {
            message: error.message,
          },
          400,
        ),
      };
    }

    throw error;
  }
};

export const getOfferLocalizationEntityId = (offer: AnyOffer) => {
  const { id, namespace } = offer;

  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof namespace !== "string" ||
    namespace.length === 0
  ) {
    return null;
  }

  return `${namespace}:${id}`;
};

const fetchOfferLocalizations = async (
  offers: readonly AnyOffer[],
  locale: string,
) => {
  if (locale === CANONICAL_LOCALE || offers.length === 0) {
    return new Map<string, EgsLocalization>();
  }

  const entityIds = Array.from(
    new Set(
      offers
        .map((offer) => getOfferLocalizationEntityId(offer))
        .filter((entityId): entityId is string => Boolean(entityId)),
    ),
  );

  if (entityIds.length === 0) {
    return new Map<string, EgsLocalization>();
  }

  const localizations = await db.db
    .collection<EgsLocalization>("egs_localizations")
    .find({
      entityType: "offer",
      entityId: {
        $in: entityIds,
      },
      locale,
    })
    .toArray();

  return new Map(
    localizations.map((localization) => [localization.entityId, localization]),
  );
};

export const applyOfferLocalization = <T extends AnyOffer>(
  canonicalOffer: T,
  localization: EgsLocalization | undefined,
  locale: string,
): T & LocalizedOfferMetadata => {
  const result: AnyOffer = {
    ...canonicalOffer,
  };

  if (locale === CANONICAL_LOCALE) {
    return {
      ...result,
      locale,
      localeStatus: "canonical",
    } as T & LocalizedOfferMetadata;
  }

  if (!localization) {
    return {
      ...result,
      locale,
      localeStatus: "fallback",
      canonicalLocale: CANONICAL_LOCALE,
    } as T & LocalizedOfferMetadata;
  }

  const localizedData = isRecord(localization.data) ? localization.data : {};

  for (const field of localizedOfferFields) {
    if (
      Object.hasOwn(canonicalOffer, field) &&
      localizedData[field as LocalizedOfferField] !== undefined
    ) {
      result[field] = localizedData[field as LocalizedOfferField];
    }
  }

  return {
    ...result,
    locale,
    localeStatus: "localized",
    canonicalLocale: CANONICAL_LOCALE,
    localization: {
      source: localization.source,
      fetchedAt: localization.fetchedAt,
      ...(localization.sourceUpdatedAt
        ? { sourceUpdatedAt: localization.sourceUpdatedAt }
        : {}),
    },
  } as T & LocalizedOfferMetadata;
};

export const localizeOffers = async <T extends AnyOffer>(
  offers: readonly T[],
  locale: string,
) => {
  const localizationByEntityId = await fetchOfferLocalizations(offers, locale);

  return offers.map((offer) => {
    const entityId = getOfferLocalizationEntityId(offer);
    return applyOfferLocalization(
      offer,
      entityId ? localizationByEntityId.get(entityId) : undefined,
      locale,
    );
  });
};

export const localizeOffer = async <T extends AnyOffer>(
  offer: T,
  locale: string,
) => {
  const [localizedOffer] = await localizeOffers([offer], locale);
  return localizedOffer;
};

export const localizeNullableOffer = async <T extends AnyOffer>(
  offer: T | null | undefined,
  locale: string,
) => {
  if (!offer) {
    return offer;
  }

  return localizeOffer(offer, locale);
};

export const localeCacheSegment = (locale: string) => `locale:${locale}`;

export const hasLocalizationFallback = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some((item) => hasLocalizationFallback(item));
  }

  if (!isRecord(value)) {
    return false;
  }

  if (value.localeStatus === "fallback") {
    return true;
  }

  return Object.values(value).some((item) => hasLocalizationFallback(item));
};

export const getLocalizedCacheTtlSeconds = (
  value: unknown,
  defaultTtlSeconds: number,
) => {
  if (!hasLocalizationFallback(value)) {
    return defaultTtlSeconds;
  }

  return Math.min(defaultTtlSeconds, FALLBACK_CACHE_TTL_SECONDS);
};
