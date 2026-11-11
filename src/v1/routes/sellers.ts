import { Hono } from "hono";
import { z } from "zod";
import { db } from "../../db/index.js";
import {
  GamePosition,
  Item,
  Offer,
  PriceEngine,
  Seller,
} from "../../models/index.js";
import { localizeOffers } from "../../utils/offer-localization.js";
import { orderOffersObject } from "../../utils/order-offers-object.js";
import { cached, v1CacheKey } from "../cache.js";
import { decodeCursor, encodeCursor } from "../cursor.js";
import { notFound, ProblemError, problemResponse } from "../errors.js";
import {
  type MongoSortField,
  mongoKeysetFilter,
  mongoSortSpec,
  pageMeta,
  parsePagination,
  trimPage,
} from "../pagination.js";
import {
  parseCsv,
  parseStrictQuery,
  querySchema,
  regionalParams,
  requireIdParam,
} from "../query.js";
import type { V1Variables } from "../request-context.js";
import { jsonSuccess } from "../response.js";
import {
  isoOrNull,
  localizationMeta,
  serializeOffer,
  serializeSeller,
} from "../serialization.js";

type AnyRecord = Record<string, any>;

const app = new Hono<{ Variables: V1Variables }>();

const SELLER_OFFER_ORDERING = "lastModifiedDate:desc,id:asc";
const SELLER_OFFER_SORT: MongoSortField[] = [
  { field: "lastModifiedDate", direction: -1, nulls: "last" },
  { field: "id", direction: 1, nulls: "last" },
];

const SELLER_LIST_MAX = 5000;
const SELLER_LIST_TTL_SECONDS = 60 * 60;
const SELLER_OFFERS_TTL_SECONDS = 60;
const SELLER_COVER_TTL_SECONDS = 5 * 60;
const SELLER_STATS_TTL_SECONDS = 60 * 60;
const COVER_OFFER_LIMIT = 5;

const sellerOfferCursorTuple = (
  offer: AnyRecord,
): Array<string | number | null> => [
  isoOrNull(offer.lastModifiedDate),
  typeof offer.id === "string" ? offer.id : null,
];

const sellerOfferKeysetFilter = (
  last: Array<string | number | null>,
): Record<string, any> => {
  const tuple: any[] = last.map((value, index) =>
    index === 0 && typeof value === "string" ? new Date(value) : value,
  );
  return mongoKeysetFilter(SELLER_OFFER_SORT, tuple);
};

const countFromAggregate = (rows: AnyRecord[]): number => {
  const value = rows[0]?.count;
  if (typeof value === "number") return value;
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

app.get("/sellers", async (c) => {
  parseStrictQuery(c, {});

  const result = await cached(
    v1CacheKey("sellers.list", {}),
    SELLER_LIST_TTL_SECONDS,
    async () => {
      const distinctSellers = await Offer.distinct("seller");
      const byId = new Map<string, AnyRecord>();

      for (const seller of distinctSellers) {
        const serialized = serializeSeller(seller);
        if (!serialized) continue;
        const id = serialized.id;
        if (typeof id !== "string" || id.length === 0) continue;
        if (!byId.has(id)) byId.set(id, serialized);
      }

      const sellers = Array.from(byId.values()).sort((a, b) => {
        const byName = String(a.name ?? "").localeCompare(String(b.name ?? ""));
        return byName !== 0 ? byName : String(a.id).localeCompare(String(b.id));
      });

      return {
        sellers: sellers.slice(0, SELLER_LIST_MAX),
        total: sellers.length,
      };
    },
  );

  return jsonSuccess(c, result.sellers, {
    count: result.sellers.length,
    total: result.total,
    truncated: result.total > result.sellers.length,
  });
});

app.get("/sellers/:id", async (c) => {
  const query = parseStrictQuery(c, {
    ...querySchema.pagination,
    ...querySchema.regional,
    offerType: z.string().max(64).optional(),
    ignoredSandboxes: z.string().optional(),
  });
  const { limit, cursor } = parsePagination(query);
  const { country, region, locale } = regionalParams(query);
  const id = requireIdParam(c);

  const offerType = (query.offerType ?? "").trim() || undefined;
  const ignoredSandboxes = parseCsv(query.ignoredSandboxes);
  const filters = {
    offerType: offerType ?? null,
    ignoredSandboxes: ignoredSandboxes ?? [],
  };
  const cursorBinding = {
    operation: "sellers.offers",
    filters,
    ordering: SELLER_OFFER_ORDERING,
    country,
    locale,
    limit,
  };

  const result = await cached(
    v1CacheKey("sellers.offers", {
      id,
      region,
      locale,
      limit,
      cursor,
      filters,
    }),
    SELLER_OFFERS_TTL_SECONDS,
    async () => {
      const last = cursor ? decodeCursor(cursor, cursorBinding) : null;

      const baseFilter: Record<string, any> = { "seller.id": id };
      if (offerType) baseFilter.offerType = offerType;
      if (ignoredSandboxes && ignoredSandboxes.length > 0) {
        baseFilter.namespace = { $nin: ignoredSandboxes };
      }
      const filter = last
        ? { $and: [baseFilter, sellerOfferKeysetFilter(last)] }
        : baseFilter;

      const rows = await Offer.find(filter, undefined, {
        limit: limit + 1,
        sort: mongoSortSpec(SELLER_OFFER_SORT),
      }).lean();
      const { items, hasMore } = trimPage(rows, limit);

      const prices =
        items.length === 0
          ? []
          : await PriceEngine.find({
              offerId: { $in: items.map((offer) => offer.id) },
              region,
            }).lean();
      const priceByOfferId = new Map(
        prices.map((price) => [price.offerId, price]),
      );

      const localized = await localizeOffers(
        items.map((offer) => ({
          ...orderOffersObject(offer),
          price: priceByOfferId.get(offer.id) ?? null,
        })),
        locale,
      );
      const offers = localized.map((offer) =>
        serializeOffer(offer, { price: offer.price }),
      );
      const lastOffer = items.at(-1);

      return {
        offers,
        pagination: pageMeta(
          limit,
          hasMore,
          hasMore && lastOffer
            ? encodeCursor(cursorBinding, sellerOfferCursorTuple(lastOffer))
            : null,
        ),
        localization: localizationMeta(localized[0]),
      };
    },
  );

  return jsonSuccess(c, result.offers, {
    country,
    region,
    locale,
    ...result.localization,
    pagination: result.pagination,
  });
});

app.get("/sellers/:id/cover", async (c) => {
  const query = parseStrictQuery(c, querySchema.regional);
  const { country, region, locale } = regionalParams(query);
  const id = requireIdParam(c);

  const result = await cached(
    v1CacheKey("sellers.cover", { id, region, locale }),
    SELLER_COVER_TTL_SECONDS,
    async () => {
      const topSellers = await GamePosition.find({
        collectionId: "top-sellers",
        position: { $gt: 0 },
      }).lean();

      let offers = await Offer.find(
        {
          id: { $in: topSellers.map((entry) => entry.offerId) },
          "seller.id": id,
        },
        undefined,
        { limit: COVER_OFFER_LIMIT, sort: { lastModifiedDate: -1 } },
      ).lean();

      if (offers.length === 0) {
        offers = await Offer.find({ "seller.id": id }, undefined, {
          limit: COVER_OFFER_LIMIT,
          sort: { lastModifiedDate: -1 },
        }).lean();
      }

      const prices =
        offers.length === 0
          ? []
          : await PriceEngine.find({
              offerId: { $in: offers.map((offer) => offer.id) },
              region,
            }).lean();
      const priceByOfferId = new Map(
        prices.map((price) => [price.offerId, price]),
      );

      const localized = await localizeOffers(
        offers.map((offer) => ({
          ...orderOffersObject(offer),
          price: priceByOfferId.get(offer.id) ?? null,
        })),
        locale,
      );

      return {
        offers: localized.map((offer) =>
          serializeOffer(offer, { price: offer.price }),
        ),
        localization: localizationMeta(localized[0]),
      };
    },
  );

  return jsonSuccess(c, result.offers, {
    count: result.offers.length,
    country,
    region,
    locale,
    ...result.localization,
  });
});

app.get("/sellers/:id/stats", async (c) => {
  parseStrictQuery(c, {});
  const id = requireIdParam(c);

  const result = await cached(
    v1CacheKey("sellers.stats", { id }),
    SELLER_STATS_TTL_SECONDS,
    async () => {
      const seller = await Seller.findOne({ _id: id }).lean();
      if (!seller) return null;

      const [offers, items, gamesAgg] = await Promise.all([
        Offer.countDocuments({ "seller.id": id }),
        Item.countDocuments({ developerId: id }),
        Offer.aggregate([
          { $match: { "seller.id": id, offerType: "BASE_GAME" } },
          { $sort: { lastModifiedDate: -1 } },
          { $group: { _id: "$namespace", offer: { $first: "$$ROOT" } } },
          { $replaceRoot: { newRoot: "$offer" } },
          { $count: "count" },
        ]),
      ]);

      const games = countFromAggregate(gamesAgg as AnyRecord[]);

      const freegamesAgg = await db.db
        .collection("freegames")
        .aggregate(
          [
            {
              $lookup: {
                from: "offers",
                localField: "id",
                foreignField: "id",
                as: "offer",
              },
            },
            { $unwind: "$offer" },
            { $match: { "offer.seller.id": id } },
            { $group: { _id: "$id" } },
            { $count: "count" },
          ],
          { allowDiskUse: true },
        )
        .toArray();

      const freegames = countFromAggregate(
        freegamesAgg as unknown as AnyRecord[],
      );

      const mobileAgg = await db.db
        .collection("mobile-freebies")
        .aggregate(
          [
            {
              $lookup: {
                from: "offers",
                localField: "offerId",
                foreignField: "id",
                as: "offer",
              },
            },
            { $unwind: "$offer" },
            { $match: { "offer.seller.id": id } },
            { $group: { _id: "$offerId" } },
            { $count: "count" },
          ],
          { allowDiskUse: true },
        )
        .toArray();

      const mobileFreeGames = countFromAggregate(
        mobileAgg as unknown as AnyRecord[],
      );

      return {
        offers,
        items,
        games,
        freegames: freegames + mobileFreeGames,
        seller: serializeSeller(seller),
      };
    },
  );

  if (!result) {
    throw notFound("SELLER_NOT_FOUND", `No seller matches '${id}'.`);
  }

  return jsonSuccess(c, result);
});

app.onError((error, c) => {
  if (error instanceof ProblemError) return problemResponse(c, error);
  throw error;
});

export default app;
