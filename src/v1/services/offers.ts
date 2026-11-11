import type { Filter } from "mongodb";
import {
  Offer,
  PriceEngine,
  type PriceEngineType,
} from "../../models/index.js";
import {
  getLocalizedCacheTtlSeconds,
  localizeOffer,
  localizeOffers,
} from "../../utils/offer-localization.js";
import { orderOffersObject } from "../../utils/order-offers-object.js";
import { cached, v1CacheKey } from "../cache.js";
import { decodeCursor, encodeCursor } from "../cursor.js";
import {
  type MongoSortField,
  mongoKeysetFilter,
  mongoSortSpec,
  trimPage,
} from "../pagination.js";
import {
  localizationMeta,
  type SerializedOffer,
  serializeOffer,
  serializePrice,
} from "../serialization.js";

type AnyRecord = Record<string, any>;

export const OFFER_LIST_ORDERING = "lastModifiedDate:desc,id:asc";
const OFFER_LIST_SORT: MongoSortField[] = [
  { field: "lastModifiedDate", direction: -1, nulls: "last" },
  { field: "id", direction: 1, nulls: "last" },
];

const offerFilterFromCursor = (
  last: Array<string | number | null>,
): Filter<Record<string, any>> => {
  const tuple = last.map((value, index) =>
    index === 0 && typeof value === "string" ? new Date(value) : value,
  ) as Array<string | number | Date | null>;
  return mongoKeysetFilter(
    OFFER_LIST_SORT,
    tuple as Array<string | number | null>,
  );
};

const offerCursorTuple = (offer: AnyRecord): Array<string | number | null> => [
  offer.lastModifiedDate
    ? new Date(offer.lastModifiedDate).toISOString()
    : null,
  offer.id ?? null,
];

export type OfferListResult = {
  offers: SerializedOffer[];
  pagination: {
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
  localization: Record<string, unknown>;
  cacheTtl: number;
};

export async function listOffers(options: {
  country: string;
  region: string;
  locale: string;
  limit: number;
  cursor: string | null;
  filters?: Record<string, unknown>;
}): Promise<OfferListResult> {
  const { country, region, locale, limit, cursor } = options;
  const cursorBinding = {
    operation: "offers.list",
    filters: options.filters ?? {},
    ordering: OFFER_LIST_ORDERING,
    country,
    locale,
    limit,
  };

  return cached(
    v1CacheKey("offers.list", {
      region,
      locale,
      limit,
      cursor,
      filters: options.filters ?? {},
    }),
    cursor ? 60 : 60,
    async () => {
      const last = cursor ? decodeCursor(cursor, cursorBinding) : null;

      const filter: Filter<Record<string, any>> = last
        ? offerFilterFromCursor(last)
        : {};
      const rows = await Offer.find(filter, undefined, {
        limit: limit + 1,
        sort: mongoSortSpec(OFFER_LIST_SORT),
      }).lean();

      const { items, hasMore } = trimPage(rows as AnyRecord[], limit);
      const prices = await PriceEngine.find({
        offerId: { $in: items.map((offer) => offer.id) },
        region,
      }).lean();
      const priceByOfferId = new Map(
        (prices as PriceEngineType[]).map((price) => [price.offerId, price]),
      );

      const ordered = items.map((offer) =>
        orderOffersObject(offer as AnyRecord),
      );
      const localized = (await localizeOffers(
        ordered.map((offer) => ({
          ...offer,
          price: priceByOfferId.get(offer.id as string) ?? null,
        })),
        locale,
      )) as AnyRecord[];

      const offers = localized.map((offer) =>
        serializeOffer(offer, { price: offer.price }),
      );

      return {
        offers,
        pagination: {
          limit,
          hasMore,
          nextCursor:
            hasMore && items.length > 0
              ? encodeCursor(cursorBinding, offerCursorTuple(items.at(-1)!))
              : null,
        },
        localization: localizationMeta(localized[0]),
        cacheTtl: getLocalizedCacheTtlSeconds(localized, 60),
      };
    },
  );
}

export async function getOffer(options: {
  id: string;
  country: string;
  region: string;
  locale: string;
}): Promise<{
  offer: SerializedOffer;
  localization: Record<string, unknown>;
  cacheTtl: number;
} | null> {
  const { id, country, region, locale } = options;
  const result = await cached(
    v1CacheKey("offers.detail", { id, country, region, locale }),
    60,
    async () => {
      const offer = (await Offer.findOne({ id }).lean()) as AnyRecord | null;
      if (!offer) return null;
      const price = offerCountryEligible(offer, country)
        ? await PriceEngine.findOne({ offerId: id, region }, undefined, {
            sort: { updatedAt: -1 },
          }).lean()
        : null;
      const localized = (await localizeOffer(
        orderOffersObject(offer),
        locale,
      )) as AnyRecord;
      return {
        offer: serializeOffer(localized, { price }),
        localization: localizationMeta(localized),
        cacheTtl: getLocalizedCacheTtlSeconds(localized, 60),
      };
    },
  );
  return result;
}

export async function currentPrice(
  id: string,
  region: string,
): Promise<AnyRecord | null> {
  const price = await PriceEngine.findOne({ offerId: id, region }, undefined, {
    sort: { updatedAt: -1 },
  }).lean();
  return serializePrice(price);
}

export const offerCountryEligible = (offer: AnyRecord, country: string) => {
  const whitelist = offer.countriesWhitelist as string[] | undefined;
  const blacklist = offer.countriesBlacklist as string[] | undefined;
  if (Array.isArray(whitelist) && whitelist.length > 0) {
    return whitelist.includes(country);
  }
  if (Array.isArray(blacklist) && blacklist.includes(country)) return false;
  return true;
};
