import { Hono } from "hono";
import { z } from "zod";
import { Offer, PriceEngine, Tags } from "../../models/index.js";
import {
  localizeOffer,
  localizeOffers,
} from "../../utils/offer-localization.js";
import { orderOffersObject } from "../../utils/order-offers-object.js";
import { cached, v1CacheKey } from "../cache.js";
import { decodeCursor, encodeCursor } from "../cursor.js";
import {
  badRequest,
  notFound,
  ProblemError,
  problemResponse,
} from "../errors.js";
import {
  type MongoSortField,
  mongoKeysetFilter,
  mongoSortSpec,
  pageMeta,
  parseLimit,
  parsePagination,
  trimPage,
} from "../pagination.js";
import {
  canonicalLocale,
  parseStrictQuery,
  regionalParams,
  requireIdParam,
} from "../query.js";
import type { V1Variables } from "../request-context.js";
import { jsonSuccess } from "../response.js";
import { serializeOffer, serializeValue } from "../serialization.js";

type AnyRecord = Record<string, any>;

const app = new Hono<{ Variables: V1Variables }>();

const PROMOTION_SORT_FIELDS = [
  "releaseDate",
  "lastModifiedDate",
  "effectiveDate",
  "creationDate",
  "viewableDate",
  "pcReleaseDate",
  "upcoming",
  "price",
] as const;

const DATE_SORT_FIELDS = new Set<string>([
  "releaseDate",
  "lastModifiedDate",
  "effectiveDate",
  "creationDate",
  "viewableDate",
  "pcReleaseDate",
]);

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const titleFilter = (q: string | null): AnyRecord =>
  q ? { title: { $regex: escapeRegex(q), $options: "i" } } : {};

const sortValueFromOffer = (
  offer: AnyRecord,
  field: string,
): string | number | null => {
  const value = offer[field];
  if (field === "upcoming") {
    return typeof value === "boolean" ? (value ? 1 : 0) : null;
  }
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toISOString();
  }
  if (typeof value === "number") return value;
  return String(value);
};

const filterValueFromCursor = (
  value: string | number | null,
  field: string,
): string | number | boolean | Date | null => {
  if (value === null) return null;
  if (field === "upcoming") {
    return typeof value === "number" ? value !== 0 : Boolean(value);
  }
  if (DATE_SORT_FIELDS.has(field) && typeof value === "string") {
    return new Date(value);
  }
  return value;
};

const promotionOffersShape = {
  q: z.string().max(200).optional(),
  sortBy: z.enum(PROMOTION_SORT_FIELDS).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
  country: z.string().optional(),
  locale: z.string().optional(),
  limit: z.string().optional(),
  cursor: z.string().optional(),
};

app.get("/promotions", async (c) => {
  const query = parseStrictQuery(c, { limit: z.string().optional() });
  const limit = parseLimit(query.limit, 100);

  const data = await cached(
    v1CacheKey("promotions.list", { limit }),
    5 * 60,
    async () => {
      const events = await Tags.find(
        { groupName: "event", status: "ACTIVE" },
        undefined,
        { sort: { referenceCount: -1 }, limit },
      ).lean();
      return events.map((event) => serializeValue(event));
    },
  );

  return jsonSuccess(c, data, { count: data.length, limit });
});

app.get("/promotions/:id", async (c) => {
  const id = requireIdParam(c, "id");
  const query = parseStrictQuery(c, promotionOffersShape);
  const { country, region, locale } = regionalParams(query);
  const { limit, cursor } = parsePagination(query, 50);

  const q = query.q?.trim() || null;
  if (q && q.length > 200) {
    throw badRequest(
      "INVALID_QUERY",
      "The `q` parameter must be at most 200 characters.",
    );
  }
  const sortBy = query.sortBy ?? "lastModifiedDate";
  const sortDir = query.sortDir ?? "desc";
  const ascending = sortDir === "asc";
  const direction = ascending ? 1 : -1;

  const event = await Tags.findOne({ id }).lean();
  if (!event) {
    throw notFound("PROMOTION_NOT_FOUND", "No promotion exists with this ID.");
  }

  const ordering =
    sortBy === "price"
      ? `price:${sortDir},id:asc`
      : `${sortBy}:${sortDir},id:asc`;
  const binding = {
    operation: "promotions.offers",
    filters: { id, q },
    ordering,
    country,
    locale,
    limit,
  };

  const page = await cached(
    v1CacheKey("promotions.offers", {
      id,
      region,
      locale,
      limit,
      cursor,
      q,
      sortBy,
      sortDir,
    }),
    60,
    async () => {
      const last = cursor ? decodeCursor(cursor, binding) : null;

      let rows: AnyRecord[];
      let hasMore: boolean;

      if (sortBy === "price") {
        const pipeline: AnyRecord[] = [
          {
            $match: {
              tags: { $elemMatch: { id } },
              ...titleFilter(q),
            },
          },
          {
            $lookup: {
              from: "pricev2",
              let: { offerId: "$id" },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ["$offerId", "$$offerId"] },
                        { $eq: ["$region", region] },
                      ],
                    },
                  },
                },
                { $sort: { updatedAt: -1 } },
                { $limit: 1 },
              ],
              as: "priceDoc",
            },
          },
          { $unwind: "$priceDoc" },
          {
            $addFields: {
              _priceSort: { $ifNull: ["$priceDoc.price.discountPrice", null] },
            },
          },
          {
            $addFields: {
              _priceNull: {
                $cond: [{ $eq: ["$_priceSort", null] }, 1, 0],
              },
            },
          },
        ];

        if (last) {
          const priceValue = last[0] ?? null;
          const lastId = String(last[1] ?? "");
          pipeline.push({
            $match: mongoKeysetFilter(
              [
                { field: "_priceNull", direction: 1, nulls: "last" },
                { field: "_priceSort", direction, nulls: "last" },
                { field: "id", direction: 1, nulls: "last" },
              ],
              [priceValue === null ? 1 : 0, priceValue, lastId],
            ),
          });
        }

        pipeline.push(
          {
            $sort: {
              _priceNull: 1,
              _priceSort: direction,
              id: 1,
            },
          },
          { $limit: limit + 1 },
        );

        const fetched = await Offer.aggregate<AnyRecord>(pipeline).exec();
        const trimmed = trimPage(fetched, limit);
        rows = trimmed.items;
        hasMore = trimmed.hasMore;
      } else {
        const sort: MongoSortField[] = [
          {
            field: sortBy,
            direction,
            nulls: ascending ? "first" : "last",
          },
          { field: "id", direction: 1, nulls: "last" },
        ];

        const filter: AnyRecord = {
          tags: { $elemMatch: { id } },
          ...titleFilter(q),
        };
        if (last) {
          const tuple = [
            filterValueFromCursor(last[0] ?? null, sortBy),
            last[1] ?? null,
          ] as unknown as Array<string | number | null>;
          Object.assign(filter, mongoKeysetFilter(sort, tuple));
        }

        const fetched = await Offer.find(filter, undefined, {
          limit: limit + 1,
          sort: mongoSortSpec(sort),
        }).lean();
        const trimmed = trimPage(fetched as AnyRecord[], limit);
        rows = trimmed.items;
        hasMore = trimmed.hasMore;
      }

      const offerIds = rows.map((row) => String(row.id ?? ""));
      const prices = await PriceEngine.find({
        offerId: { $in: offerIds },
        region,
      }).lean();
      const priceByOfferId = new Map(
        prices.map((price) => [String(price.offerId), price]),
      );

      const localized = await localizeOffers(
        rows.map((row) => ({
          ...orderOffersObject(row),
          price:
            sortBy === "price"
              ? (row.priceDoc ?? priceByOfferId.get(String(row.id)) ?? null)
              : (priceByOfferId.get(String(row.id)) ?? null),
        })),
        locale,
      );
      const data = localized.map((offer) =>
        serializeOffer(offer, { price: offer.price }),
      );

      const lastRow = rows.at(-1);
      const nextCursor = (() => {
        if (!hasMore || !lastRow) return null;
        if (sortBy === "price") {
          return encodeCursor(binding, [
            lastRow._priceSort ?? null,
            String(lastRow.id),
          ]);
        }
        return encodeCursor(binding, [
          sortValueFromOffer(lastRow, sortBy),
          String(lastRow.id),
        ]);
      })();

      return {
        data,
        pagination: pageMeta(limit, hasMore, nextCursor),
        title: String(event.name ?? ""),
        start: cursor ? null : 0,
      };
    },
  );

  return jsonSuccess(c, page.data, {
    country,
    region,
    locale,
    title: page.title,
    start: page.start,
    pagination: page.pagination,
  });
});

app.get("/promotions/:id/cover", async (c) => {
  const id = requireIdParam(c, "id");
  const query = parseStrictQuery(c, { locale: z.string().optional() });
  const locale = canonicalLocale(query.locale);

  const data = await cached(
    v1CacheKey("promotions.cover", { id, locale }),
    60 * 60,
    async () => {
      const tagged = await Offer.find(
        { tags: { $elemMatch: { id } } },
        { namespace: 1 },
      ).lean();
      const namespaces = tagged
        .map((offer) => offer.namespace)
        .filter(
          (namespace): namespace is string => typeof namespace === "string",
        );

      const baseGame = await Offer.findOne({
        namespace: { $in: namespaces },
        offerType: "BASE_GAME",
      }).lean();
      if (!baseGame) return null;

      const localized = await localizeOffer(
        orderOffersObject(baseGame),
        locale,
      );
      return serializeOffer(localized);
    },
  );

  if (!data) {
    throw notFound(
      "PROMOTION_COVER_NOT_FOUND",
      "The promotion has no base-game offer to use as a cover.",
    );
  }

  return jsonSuccess(c, data, { locale });
});

app.onError((error, c) => {
  if (error instanceof ProblemError) return problemResponse(c, error);
  throw error;
});

export default app;
