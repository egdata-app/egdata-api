import { attributesToObject } from "../utils/attributes-to-object.js";
import type { LocalizedOfferMetadata } from "../utils/offer-localization.js";

type AnyRecord = Record<string, any>;

const DATE_FIELDS = new Set([
  "effectiveDate",
  "creationDate",
  "lastModifiedDate",
  "releaseDate",
  "pcReleaseDate",
  "viewableDate",
  "updatedAt",
  "createdAt",
  "fetchedAt",
  "sourceUpdatedAt",
  "timestamp",
  "lastUpdated",
  "startDate",
  "endDate",
  "serverDate",
  "lastUsedAt",
]);

export const toPlain = <T>(value: T): unknown => {
  const candidate = value as unknown as { toObject?: () => unknown };
  if (candidate && typeof candidate.toObject === "function") {
    return candidate.toObject();
  }
  return value;
};

export const isoOrNull = (value: unknown): string | null => {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "$date" in (value as AnyRecord)
  ) {
    return isoOrNull((value as AnyRecord).$date);
  }
  return null;
};

export const stringId = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  return String(value);
};

export const dateValue = (value: unknown): unknown => {
  if (value === null || value === undefined) return null;
  return isoOrNull(value) ?? value;
};

/**
 * Recursively normalizes BSON/Mongoose values without dropping documented
 * fields: ObjectIds become strings, Dates become UTC ISO strings, and
 * undefined values become null.
 */
export function serializeValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return null;
  if (value === undefined) return null;
  if (value === null) return null;
  if (value instanceof Date) return isoOrNull(value);
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    return value.map((entry) => serializeValue(entry, depth + 1));
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    const constructorName = prototype?.constructor?.name;
    if (constructorName === "ObjectId" || constructorName === "ObjectID") {
      return String(value);
    }
    const record = value as AnyRecord;
    const output: AnyRecord = {};
    for (const [key, entry] of Object.entries(record)) {
      if (key === "__v") continue;
      if (key === "_id" || key === "id") {
        output[key] = stringId(entry);
      } else if (DATE_FIELDS.has(key)) {
        output[key] = dateValue(entry);
      } else {
        output[key] = serializeValue(entry, depth + 1);
      }
    }
    return output;
  }
  return value;
}

const OFFER_FIELDS = [
  "_id",
  "id",
  "namespace",
  "title",
  "description",
  "longDescription",
  "offerType",
  "effectiveDate",
  "creationDate",
  "lastModifiedDate",
  "isCodeRedemptionOnly",
  "keyImages",
  "currentPrice",
  "seller",
  "productSlug",
  "offerMappings",
  "urlSlug",
  "url",
  "tags",
  "items",
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
] as const;

function customAttributesValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    try {
      return attributesToObject(value as never);
    } catch {
      return serializeValue(value);
    }
  }
  return value;
}

export type SerializedOffer = AnyRecord & {
  localization?: {
    locale: string;
    localeStatus: string;
    canonicalLocale?: string;
    localization?: Record<string, unknown>;
  };
};

export function serializeOffer(
  rawValue: unknown,
  options: {
    price?: unknown;
    includeLocalization?: boolean;
  } = {},
): SerializedOffer {
  const raw = (toPlain(rawValue) ?? {}) as AnyRecord;
  const output: AnyRecord = {};

  for (const field of OFFER_FIELDS) {
    const value = raw[field];
    if (
      field === "effectiveDate" ||
      field === "creationDate" ||
      field === "lastModifiedDate" ||
      field === "releaseDate" ||
      field === "pcReleaseDate" ||
      field === "viewableDate"
    ) {
      output[field] = dateValue(value);
    } else if (field === "_id" || field === "id") {
      output[field] = stringId(value);
    } else {
      output[field] = serializeValue(value);
    }
  }

  output.customAttributes = customAttributesValue(raw.customAttributes);
  output.price =
    options.price === undefined ? null : serializePrice(options.price);

  if (options.includeLocalization !== false) {
    output.locale = raw.locale ?? null;
    output.localeStatus = raw.localeStatus ?? null;
    if (raw.canonicalLocale) output.canonicalLocale = raw.canonicalLocale;
    if (raw.localization) {
      output.localization = {
        locale: raw.locale,
        localeStatus: raw.localeStatus,
        canonicalLocale: raw.canonicalLocale,
        localization: serializeValue(raw.localization),
      } as never;
    }
  }

  return output;
}

const PRICE_AMOUNT_FIELDS = [
  "originalPrice",
  "discountPrice",
  "price",
  "basePrice",
  "minPrice",
  "maxPrice",
  "amount",
] as const;

const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "UYI",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

const THREE_DECIMAL_CURRENCIES = new Set([
  "BHD",
  "IQD",
  "JOD",
  "KWD",
  "LYD",
  "OMR",
  "TND",
]);

export function currencyPrecision(currencyCode: string | null): number {
  if (!currencyCode) return 2;
  const code = currencyCode.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}

function integerMinorUnit(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed);
}

export function serializePrice(rawValue: unknown): AnyRecord | null {
  if (rawValue === null || rawValue === undefined) return null;
  const raw = (toPlain(rawValue) ?? {}) as AnyRecord;
  const nested = raw.price && typeof raw.price === "object" ? raw.price : null;
  const currencyCode =
    (nested?.currencyCode as string | undefined) ??
    (raw.currencyCode as string | undefined) ??
    null;
  const precision = currencyPrecision(currencyCode);

  const output: AnyRecord = {
    offerId: stringId(raw.offerId),
    region: raw.region ?? null,
    currencyCode,
    precision,
  };

  const source: AnyRecord = nested ? { ...raw, ...nested } : raw;

  for (const field of PRICE_AMOUNT_FIELDS) {
    if (field in source) {
      output[field] = integerMinorUnit(source[field]);
    }
  }

  for (const [key, value] of Object.entries(raw)) {
    if (key === "price" || key === "_id" || key === "__v") continue;
    if (PRICE_AMOUNT_FIELDS.includes(key as never)) continue;
    if (key in output) continue;
    output[key] = serializeValue(value);
  }

  if (nested) {
    output.price = {
      ...Object.fromEntries(
        Object.entries(nested).map(([key, value]) => [
          key,
          PRICE_AMOUNT_FIELDS.includes(key as never)
            ? integerMinorUnit(value)
            : serializeValue(value),
        ]),
      ),
      currencyCode,
      precision,
    };
  }

  output.updatedAt = dateValue(raw.updatedAt);
  return output;
}

const ITEM_FIELDS = [
  "_id",
  "id",
  "namespace",
  "title",
  "description",
  "longDescription",
  "itemType",
  "creationDate",
  "lastModifiedDate",
  "releaseDate",
  "keyImages",
  "categories",
  "developer",
  "entitlementName",
  "entitlementType",
  "status",
  "url",
  "linkedOffers",
  "builds",
] as const;

export function serializeItem(rawValue: unknown): AnyRecord {
  const raw = (toPlain(rawValue) ?? {}) as AnyRecord;
  const output: AnyRecord = {};
  for (const field of ITEM_FIELDS) {
    const value = raw[field];
    if (
      field === "creationDate" ||
      field === "lastModifiedDate" ||
      field === "releaseDate"
    ) {
      output[field] = dateValue(value);
    } else if (field === "_id" || field === "id") {
      output[field] = stringId(value);
    } else {
      output[field] = serializeValue(value);
    }
  }
  output.customAttributes =
    raw.customAttributes === null || raw.customAttributes === undefined
      ? null
      : customAttributesValue(raw.customAttributes);
  return output;
}

export function serializeSeller(rawValue: unknown): AnyRecord | null {
  if (rawValue === null || rawValue === undefined) return null;
  const raw = (toPlain(rawValue) ?? {}) as AnyRecord;
  return {
    id: stringId(raw.id),
    name: raw.name ?? null,
    slug: raw.slug ?? null,
    externalId: raw.externalId ?? null,
  };
}

export function localizationMeta(
  offer: LocalizedOfferMetadata | AnyRecord | null | undefined,
): Record<string, unknown> {
  if (!offer) return {};
  return {
    locale: offer.locale ?? "en-US",
    localeStatus: offer.localeStatus ?? "canonical",
    ...(offer.canonicalLocale
      ? { canonicalLocale: offer.canonicalLocale }
      : {}),
    ...(offer.localization
      ? { localization: serializeValue(offer.localization) }
      : {}),
  };
}
