import { Hono } from "hono";
import { z } from "zod";
import {
  Collection,
  GamePosition,
  Offer,
  PriceEngine,
} from "../../models/index.js";
import { localizeOffers } from "../../utils/offer-localization.js";
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
  parsePagination,
  trimPage,
} from "../pagination.js";
import { parseStrictQuery, regionalParams, requireIdParam } from "../query.js";
import type { V1Variables } from "../request-context.js";
import { jsonSuccess } from "../response.js";
import { isoOrNull, serializeOffer, serializeValue } from "../serialization.js";

type AnyRecord = Record<string, any>;

const app = new Hono<{ Variables: V1Variables }>();

const WEEK_PATTERN = /^(\d{4})W(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const regionalShape = {
  country: z.string().optional(),
  locale: z.string().optional(),
  limit: z.string().optional(),
  cursor: z.string().optional(),
};

/** ISO week range (UTC); the end bound is exclusive. */
function isoWeekRangeUTC(
  year: number,
  week: number,
): { start: Date; endExclusive: Date } {
  const jan4 = Date.UTC(year, 0, 4);
  const jan4Day = new Date(jan4).getUTCDay();
  const week1Monday = new Date(
    jan4 - (jan4Day === 0 ? 6 : jan4Day - 1) * DAY_MS,
  );
  const start = new Date(week1Monday.getTime() + (week - 1) * 7 * DAY_MS);
  return { start, endExclusive: new Date(start.getTime() + 7 * DAY_MS) };
}

function isoWeekParts(date: Date): { year: number; week: number } {
  const target = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const year = target.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(
    ((target.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7,
  );
  return { year, week };
}

function parseWeek(raw: string): {
  week: string;
  start: Date;
  endExclusive: Date;
} {
  const match = WEEK_PATTERN.exec(raw);
  if (!match) {
    throw badRequest(
      "INVALID_WEEK",
      "The `week` path parameter must use the YYYYWNN format, for example 2025W31.",
    );
  }

  const year = Number(match[1]);
  const week = Number(match[2]);
  const { start, endExclusive } = isoWeekRangeUTC(year, week);
  const actual = isoWeekParts(start);
  if (actual.year !== year || actual.week !== week) {
    throw badRequest(
      "INVALID_WEEK",
      `The week '${raw}' does not exist in the ISO calendar.`,
    );
  }

  return { week: raw, start, endExclusive };
}

app.get("/collections/:slug", async (c) => {
  const slug = requireIdParam(c, "slug");
  const query = parseStrictQuery(c, regionalShape);
  const { country, region, locale } = regionalParams(query);
  const { limit, cursor } = parsePagination(query, 100);

  const collection = await Collection.findOne({ _id: slug }).lean();
  if (!collection) {
    throw notFound(
      "COLLECTION_NOT_FOUND",
      "No collection exists with this slug.",
    );
  }

  const sort: MongoSortField[] = [
    { field: "position", direction: 1, nulls: "last" },
    { field: "offerId", direction: 1, nulls: "last" },
  ];
  const binding = {
    operation: "collections.positions",
    filters: { slug },
    ordering: "position:asc,id:asc",
    country,
    locale,
    limit,
  };

  const page = await cached(
    v1CacheKey("collections.positions", {
      slug,
      region,
      locale,
      limit,
      cursor,
    }),
    60,
    async () => {
      const last = cursor ? decodeCursor(cursor, binding) : null;
      const filter: AnyRecord = {
        collectionId: collection._id,
        position: { $gt: 0 },
      };
      if (last) {
        Object.assign(filter, mongoKeysetFilter(sort, last));
      }

      const positions = await GamePosition.find(filter, undefined, {
        limit: limit + 1,
        sort: mongoSortSpec(sort),
      }).lean();
      const { items, hasMore } = trimPage(positions as AnyRecord[], limit);
      const offerIds = items.map((entry) => String(entry.offerId ?? ""));

      const [offers, prices] = await Promise.all([
        Offer.find({ id: { $in: offerIds } }).lean(),
        PriceEngine.find({ offerId: { $in: offerIds }, region }).lean(),
      ]);
      const offerById = new Map(
        offers.map((offer) => [String(offer.id), offer]),
      );
      const priceByOfferId = new Map(
        prices.map((price) => [String(price.offerId), price]),
      );

      const entries = items
        .map((positionDoc) => {
          const offer = offerById.get(String(positionDoc.offerId ?? ""));
          if (!offer) return null;
          return {
            positionDoc,
            offer,
            price: priceByOfferId.get(String(offer.id)) ?? null,
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

      const localized = await localizeOffers(
        entries.map((entry) => ({
          ...orderOffersObject(entry.offer),
          price: entry.price,
        })),
        locale,
      );

      const data = entries.map((entry, index) => ({
        ...serializeOffer(localized[index], { price: entry.price }),
        position: entry.positionDoc.position ?? null,
        previousPosition: entry.positionDoc.previous ?? null,
        metadata: serializeValue(entry.positionDoc),
      }));

      const lastPosition = items.at(-1);
      return {
        data,
        pagination: pageMeta(
          limit,
          hasMore,
          hasMore && lastPosition
            ? encodeCursor(binding, [
                Number(lastPosition.position),
                String(lastPosition.offerId),
              ])
            : null,
        ),
        title: String(collection.name ?? ""),
        updatedAt: isoOrNull(collection.updatedAt),
      };
    },
  );

  return jsonSuccess(c, page.data, {
    country,
    region,
    locale,
    title: page.title,
    updatedAt: page.updatedAt,
    pagination: page.pagination,
  });
});

app.get("/collections/:slug/:week", async (c) => {
  const slug = requireIdParam(c, "slug");
  const parsedWeek = parseWeek(c.req.param("week")?.trim() ?? "");
  const query = parseStrictQuery(c, regionalShape);
  const { country, region, locale } = regionalParams(query);
  const { limit, cursor } = parsePagination(query, 100);

  const collection = await Collection.findOne({ _id: slug }).lean();
  if (!collection) {
    throw notFound(
      "COLLECTION_NOT_FOUND",
      "No collection exists with this slug.",
    );
  }

  const sort: MongoSortField[] = [
    { field: "position", direction: 1, nulls: "last" },
    { field: "offerId", direction: 1, nulls: "last" },
  ];
  const binding = {
    operation: "collections.week",
    filters: { slug, week: parsedWeek.week },
    ordering: "position:asc,id:asc",
    country,
    locale,
    limit,
  };

  const page = await cached(
    v1CacheKey("collections.week", {
      slug,
      week: parsedWeek.week,
      region,
      locale,
      limit,
      cursor,
    }),
    60,
    async () => {
      const last = cursor ? decodeCursor(cursor, binding) : null;
      const pipeline: AnyRecord[] = [
        { $match: { collectionId: collection._id } },
        { $unwind: "$positions" },
        {
          $match: {
            "positions.date": {
              $gte: parsedWeek.start,
              $lt: parsedWeek.endExclusive,
            },
            "positions.position": { $gt: 0 },
          },
        },
        { $sort: { "positions.date": -1 } },
        {
          $group: {
            _id: "$offerId",
            positions: { $push: "$positions" },
            latest: { $first: "$positions" },
            previous: { $first: "$previous" },
          },
        },
        {
          $project: {
            _id: 0,
            offerId: "$_id",
            positions: 1,
            position: "$latest.position",
            previous: 1,
          },
        },
        { $match: { position: { $gt: 0 } } },
      ];

      if (last) {
        pipeline.push({ $match: mongoKeysetFilter(sort, last) });
      }

      pipeline.push(
        { $sort: { position: 1, offerId: 1 } },
        { $limit: limit + 1 },
      );

      const fetched = await GamePosition.aggregate<AnyRecord>(pipeline).exec();
      const { items, hasMore } = trimPage(fetched, limit);
      const offerIds = items.map((entry) => String(entry.offerId ?? ""));

      const [offers, prices] = await Promise.all([
        Offer.find({ id: { $in: offerIds } }).lean(),
        PriceEngine.find({ offerId: { $in: offerIds }, region }).lean(),
      ]);
      const offerById = new Map(
        offers.map((offer) => [String(offer.id), offer]),
      );
      const priceByOfferId = new Map(
        prices.map((price) => [String(price.offerId), price]),
      );

      const entries = items
        .map((row) => {
          const offer = offerById.get(String(row.offerId ?? ""));
          if (!offer) return null;
          return {
            row,
            offer,
            price: priceByOfferId.get(String(offer.id)) ?? null,
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

      const localized = await localizeOffers(
        entries.map((entry) => ({
          ...orderOffersObject(entry.offer),
          price: entry.price,
        })),
        locale,
      );

      const data = entries.map((entry, index) => ({
        ...serializeOffer(localized[index], { price: entry.price }),
        position: entry.row.position ?? null,
        previousPosition: entry.row.previous ?? null,
        metadata: serializeValue({
          offerId: entry.row.offerId ?? null,
          position: entry.row.position ?? null,
          previous: entry.row.previous ?? null,
          positions: entry.row.positions ?? [],
        }),
      }));

      const lastPosition = items.at(-1);
      return {
        data,
        pagination: pageMeta(
          limit,
          hasMore,
          hasMore && lastPosition
            ? encodeCursor(binding, [
                Number(lastPosition.position),
                String(lastPosition.offerId),
              ])
            : null,
        ),
        title: String(collection.name ?? ""),
        updatedAt: isoOrNull(collection.updatedAt),
        start: parsedWeek.start.toISOString(),
        end: parsedWeek.endExclusive.toISOString(),
      };
    },
  );

  return jsonSuccess(c, page.data, {
    country,
    region,
    locale,
    title: page.title,
    updatedAt: page.updatedAt,
    start: page.start,
    end: page.end,
    pagination: page.pagination,
  });
});

app.onError((error, c) => {
  if (error instanceof ProblemError) return problemResponse(c, error);
  throw error;
});

export default app;
