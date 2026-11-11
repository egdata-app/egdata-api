import { type Context, Hono } from "hono";
import { z } from "zod";
import { opensearch } from "../../clients/opensearch.js";
import { db } from "../../db/index.js";
import { FreeGames, Item, Offer, PriceEngine } from "../../models/index.js";
import {
  localizeOffer,
  localizeOffers,
} from "../../utils/offer-localization.js";
import { orderOffersObject } from "../../utils/order-offers-object.js";
import { cached, v1CacheKey } from "../cache.js";
import { type CursorSortTuple, decodeCursor, encodeCursor } from "../cursor.js";
import {
  ProblemError,
  problemResponse,
  serviceUnavailable,
} from "../errors.js";
import {
  type MongoSortField,
  mongoKeysetFilter,
  mongoSortSpec,
  pageMeta,
  parsePagination,
  trimPage,
} from "../pagination.js";
import { parseStrictQuery, regionalParams } from "../query.js";
import type { V1Variables } from "../request-context.js";
import { jsonSuccess } from "../response.js";
import {
  serializeOffer,
  serializePrice,
  serializeValue,
} from "../serialization.js";

type AnyRecord = Record<string, any>;

const app = new Hono<{ Variables: V1Variables }>();

const REGIONAL_SHAPE = {
  country: z.string().optional(),
  locale: z.string().optional(),
};

const OFFER_TYPES = [
  "IN_GAME_PURCHASE",
  "BASE_GAME",
  "EXPERIENCE",
  "UNLOCKABLE",
  "ADD_ON",
  "Bundle",
  "CONSUMABLE",
  "WALLET",
  "OTHERS",
  "DEMO",
  "DLC",
  "VIRTUAL_CURRENCY",
  "BUNDLE",
  "DIGITAL_EXTRA",
  "EDITION",
] as const;

const SEARCH_SORT_FIELDS = [
  "giveawayDate",
  "releaseDate",
  "lastModifiedDate",
  "effectiveDate",
  "creationDate",
  "viewableDate",
  "pcReleaseDate",
  "upcoming",
  "price",
  "giveaway.endDate",
  "price.price.discountPrice",
] as const;

const SEARCH_INDEX = "egdata.offers";

type GiveawayKind = "desktop" | "mobile";

type GiveawaySource = {
  record: AnyRecord;
  offerId: string;
  kind: GiveawayKind;
};

const mobileFreebies = () => db.db.collection<AnyRecord>("mobile-freebies");

const normalizeCountriesBlacklist = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.filter(
      (country): country is string => typeof country === "string",
    );
  }
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
};

function normalizeGiveaway(
  raw: unknown,
  offerId: string,
  historical?: unknown,
): AnyRecord {
  const serialized = serializeValue(raw);
  const record =
    serialized && typeof serialized === "object" && !Array.isArray(serialized)
      ? (serialized as AnyRecord)
      : {};

  return {
    ...record,
    offerId: typeof record.offerId === "string" ? record.offerId : offerId,
    platform: typeof record.platform === "string" ? record.platform : null,
    ...(historical !== undefined
      ? { historical: serializeValue(historical) }
      : {}),
  };
}

async function fetchOfferItems(offer: AnyRecord): Promise<AnyRecord[]> {
  const itemsSpecified = Array.isArray(offer.items)
    ? offer.items
        .map((item) => (item && typeof item === "object" ? item.id : undefined))
        .filter((id): id is string => typeof id === "string")
    : [];

  const subItems = await db.db
    .collection<{ _id: string; subItems?: Array<{ id?: string }> }>(
      "offersubitems",
    )
    .find({ _id: offer.id }, { projection: { subItems: 1 } })
    .toArray();
  const subItemIds = subItems.flatMap((entry) =>
    (entry.subItems ?? [])
      .map((item) => item.id)
      .filter((id): id is string => typeof id === "string"),
  );

  return Item.find({
    $or: [
      { id: { $in: [...itemsSpecified, ...subItemIds] } },
      { linkedOffers: offer.id },
    ],
  }).lean();
}

async function enrichGiveaway(
  source: GiveawaySource,
  region: string,
  locale: string,
  options: { includeHistorical?: boolean; dropMissingOffer?: boolean } = {},
): Promise<AnyRecord | null> {
  const [offer, price] = await Promise.all([
    Offer.findOne({ id: source.offerId }).lean(),
    PriceEngine.findOne({ offerId: source.offerId, region }, undefined, {
      sort: { updatedAt: -1 },
    }).lean(),
  ]);

  let historical: unknown;
  if (options.includeHistorical) {
    historical =
      source.kind === "desktop"
        ? await FreeGames.find({ id: source.offerId }).lean()
        : await mobileFreebies().findOne({ offerId: source.offerId });
  }

  const giveaway = normalizeGiveaway(
    source.record,
    source.offerId,
    options.includeHistorical ? (historical ?? null) : undefined,
  );

  if (!offer) {
    return options.dropMissingOffer ? null : { giveaway };
  }

  const items = await fetchOfferItems(offer);
  const ordered = {
    ...orderOffersObject(offer),
    countriesBlacklist: normalizeCountriesBlacklist(offer.countriesBlacklist),
  };
  const localized = await localizeOffer(ordered, locale);

  return {
    ...serializeOffer(localized, { price }),
    items: items.map((item) => serializeValue(item)),
    giveaway,
    price: serializePrice(price),
  };
}

const collectCsv = (c: Context, name: string): string[] => {
  const values = c.req.queries(name) ?? [];
  return Array.from(
    new Set(
      values
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ).sort();
};

function mappedSearchSortField(sortBy: string, region: string): string {
  switch (sortBy) {
    case "giveawayDate":
    case "giveaway.endDate":
      return "freeEntries.endDate";
    case "price":
    case "price.price.discountPrice":
      return `prices.${region}.price.discountPrice`;
    default:
      return sortBy;
  }
}

function readNested(source: AnyRecord, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as AnyRecord)[segment];
  }
  return current;
}

function toCursorValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? 1 : 0;
  return String(value);
}

function cursorTupleForHit(
  hit: { _source?: AnyRecord; sort?: unknown },
  sortField: string,
): CursorSortTuple {
  if (Array.isArray(hit.sort) && hit.sort.length > 0) {
    return hit.sort.map(toCursorValue);
  }
  const source = hit._source ?? {};
  const id = source.id;
  return [
    toCursorValue(readNested(source, sortField)),
    id === null || id === undefined ? null : String(id),
  ];
}

app.get("/free-games", async (c) => {
  const query = parseStrictQuery(c, REGIONAL_SHAPE);
  const { country, region, locale } = regionalParams(query);

  const data = await cached(
    v1CacheKey("free-games.current", { region, locale }),
    60,
    async () => {
      const now = new Date();
      const [desktopRows, mobileRows] = await Promise.all([
        FreeGames.find({ endDate: { $gte: now } }, undefined, {
          sort: { endDate: 1 },
        }).lean(),
        mobileFreebies()
          .find({ endDate: { $gte: now } }, { sort: { endDate: 1 } })
          .toArray(),
      ]);

      const sources: GiveawaySource[] = [
        ...desktopRows.map((record) => ({
          record: record as AnyRecord,
          offerId: String(record.id ?? ""),
          kind: "desktop" as const,
        })),
        ...mobileRows.map((record) => ({
          record,
          offerId: String(record.offerId ?? ""),
          kind: "mobile" as const,
        })),
      ].filter((source) => source.offerId.length > 0);

      const enriched = await Promise.all(
        sources.map((source) =>
          enrichGiveaway(source, region, locale, { includeHistorical: true }),
        ),
      );
      return enriched.filter((entry): entry is AnyRecord => entry !== null);
    },
  );

  return jsonSuccess(c, data, { country, region, locale, count: data.length });
});

app.get("/free-games/history", async (c) => {
  const query = parseStrictQuery(c, {
    ...REGIONAL_SHAPE,
    limit: z.string().optional(),
    cursor: z.string().optional(),
  });
  const { country, region, locale } = regionalParams(query);
  const { limit, cursor } = parsePagination(query, 25);

  const sort: MongoSortField[] = [
    { field: "endDate", direction: -1, nulls: "last" },
    { field: "id", direction: -1, nulls: "last" },
  ];
  const binding = {
    operation: "freeGames.history",
    filters: {},
    ordering: "endDate:desc,id:desc",
    country,
    locale,
    limit,
  };

  const page = await cached(
    v1CacheKey("free-games.history", { region, locale, limit, cursor }),
    60,
    async () => {
      const last = cursor ? decodeCursor(cursor, binding) : null;
      const filter: AnyRecord = {};
      if (last) {
        // `mongoKeysetFilter` compares against BSON values, so the encoded ISO
        // date must be restored to a Date before the query is built.
        const tuple = [
          last[0] === null ? null : new Date(String(last[0])),
          last[1] ?? null,
        ] as unknown as Array<string | number | null>;
        Object.assign(filter, mongoKeysetFilter(sort, tuple));
      }

      const rows = await FreeGames.find(filter, undefined, {
        limit: limit + 1,
        sort: mongoSortSpec(sort),
      }).lean();
      const { items, hasMore } = trimPage(rows as AnyRecord[], limit);
      const offerIds = items.map((row) => String(row.id ?? ""));

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

      const rowsWithOffers = items
        .map((row) => {
          const offerId = String(row.id ?? "");
          return {
            row,
            offer: offerById.get(offerId) ?? null,
            price: priceByOfferId.get(offerId) ?? null,
          };
        })
        .filter((entry) => entry.offer !== null);

      const localized = await localizeOffers(
        rowsWithOffers.map((entry) => ({
          ...orderOffersObject(entry.offer as AnyRecord),
          price: entry.price,
        })),
        locale,
      );
      const localizedById = new Map(
        localized.map((offer) => [String(offer.id), offer]),
      );

      const data = items.map((row) => {
        const giveaway = normalizeGiveaway(row, String(row.id ?? ""));
        const offer = offerById.get(String(row.id ?? ""));
        if (!offer) return { giveaway };
        const localizedOffer = localizedById.get(String(offer.id));
        return localizedOffer
          ? {
              ...serializeOffer(localizedOffer, {
                price: priceByOfferId.get(String(offer.id)) ?? null,
              }),
              giveaway,
            }
          : { giveaway };
      });

      const lastRow = items.at(-1);
      return {
        data,
        pagination: pageMeta(
          limit,
          hasMore,
          hasMore && lastRow
            ? encodeCursor(binding, [
                lastRow.endDate
                  ? new Date(lastRow.endDate).toISOString()
                  : null,
                lastRow.id === null || lastRow.id === undefined
                  ? null
                  : String(lastRow.id),
              ])
            : null,
        ),
      };
    },
  );

  return jsonSuccess(c, page.data, {
    country,
    region,
    locale,
    pagination: page.pagination,
  });
});

app.get("/free-games/search", async (c) => {
  const query = parseStrictQuery(c, {
    title: z.string().max(200).optional(),
    offerType: z.enum(OFFER_TYPES).optional(),
    tags: z.string().optional(),
    categories: z.string().optional(),
    sortBy: z.enum(SEARCH_SORT_FIELDS).optional(),
    sortDir: z.enum(["asc", "desc"]).optional(),
    ...REGIONAL_SHAPE,
    limit: z.string().optional(),
    cursor: z.string().optional(),
  });
  const { country, region, locale } = regionalParams(query);
  const { limit, cursor } = parsePagination(query, 50);

  const title = query.title?.trim() || null;
  const tags = collectCsv(c, "tags");
  const categories = collectCsv(c, "categories");
  const sortBy = query.sortBy ?? "lastModifiedDate";
  const sortDir = query.sortDir ?? "desc";
  const sortField = mappedSearchSortField(sortBy, region);

  const binding = {
    operation: "freeGames.search",
    filters: {
      title,
      offerType: query.offerType ?? null,
      tags,
      categories,
    },
    ordering: `${sortField}:${sortDir},id.keyword:asc`,
    country,
    locale,
    limit,
  };

  const page = await cached(
    v1CacheKey("free-games.search", {
      region,
      locale,
      limit,
      cursor,
      title,
      offerType: query.offerType ?? null,
      tags,
      categories,
      sortBy,
      sortDir,
    }),
    60,
    async () => {
      const last = cursor ? decodeCursor(cursor, binding) : null;

      const must: AnyRecord[] = [];
      const filter: AnyRecord[] = [{ exists: { field: "freeEntries" } }];

      if (title) {
        must.push({
          multi_match: {
            query: title,
            fields: ["title^3", "description", "id"],
          },
        });
      }
      if (query.offerType) {
        filter.push({ term: { "offerType.keyword": query.offerType } });
      }
      if (tags.length > 0) {
        filter.push({
          terms_set: {
            "tags.id.keyword": {
              terms: tags,
              minimum_should_match_script: { source: String(tags.length) },
            },
          },
        });
      }
      if (categories.length > 0) {
        filter.push({ terms: { "categories.keyword": categories } });
      }

      const sort: Array<
        Record<string, { order: "asc" | "desc"; missing: "_last" }>
      > = [
        { [sortField]: { order: sortDir, missing: "_last" } },
        { "id.keyword": { order: "asc", missing: "_last" } },
      ];

      const searchAfter = last?.map((value) => value ?? undefined);

      const response = await Promise.resolve()
        .then(() =>
          opensearch.search({
            index: SEARCH_INDEX,
            body: {
              size: limit + 1,
              query: { bool: { must, filter } },
              sort,
              ...(searchAfter ? { search_after: searchAfter } : {}),
            },
          }),
        )
        .catch(() => {
          throw serviceUnavailable(
            "SEARCH_UNAVAILABLE",
            "The free-game search index is temporarily unavailable.",
          );
        });

      const responseHits = response.body.hits.hits as unknown as Array<{
        _source?: AnyRecord;
        sort?: unknown;
      }>;
      const { items: hits, hasMore } = trimPage(responseHits, limit);

      const offerIds = hits.map((hit) => String(hit._source?.id ?? ""));
      const prices = await PriceEngine.find({
        offerId: { $in: offerIds },
        region,
      }).lean();
      const priceByOfferId = new Map(
        prices.map((price) => [String(price.offerId), price]),
      );

      const localized = await localizeOffers(
        hits.map((hit) => {
          const source = hit._source ?? {};
          return {
            ...orderOffersObject(source),
            price: priceByOfferId.get(String(source.id)) ?? null,
          };
        }),
        locale,
      );
      const data = localized.map((offer) =>
        serializeOffer(offer, { price: offer.price }),
      );

      const total = response.body.hits.total;
      const totalValue =
        typeof total === "number" ? total : (total?.value ?? null);
      const totalRelation =
        typeof total === "number" ? "eq" : (total?.relation ?? null);

      const lastHit = hits.at(-1);
      return {
        data,
        pagination: pageMeta(
          limit,
          hasMore,
          hasMore && lastHit
            ? encodeCursor(binding, cursorTupleForHit(lastHit, sortField))
            : null,
        ),
        result: {
          total: totalValue,
          totalRelation,
          timedOut: Boolean(response.body.timed_out),
          tookMs: Number(response.body.took ?? 0),
        },
      };
    },
  );

  return jsonSuccess(c, page.data, {
    country,
    region,
    locale,
    pagination: page.pagination,
    result: page.result,
  });
});

app.get("/free-games/stats", async (c) => {
  const query = parseStrictQuery(c, REGIONAL_SHAPE);
  const { country, region, locale } = regionalParams(query);

  const data = await cached(
    v1CacheKey("free-games.stats", { region }),
    60 * 60,
    async () => {
      const giveaways = await FreeGames.find({}, undefined, {
        sort: { endDate: -1 },
      }).lean();
      const offerIds = giveaways
        .map((giveaway) => String(giveaway.id ?? ""))
        .filter(Boolean);

      const [offers, prices] = await Promise.all([
        Offer.find({ id: { $in: offerIds } }).lean(),
        PriceEngine.find({ offerId: { $in: offerIds }, region }).lean(),
      ]);

      const repetitions = new Map<string, number>();
      for (const giveaway of giveaways) {
        const id = String(giveaway.id ?? "");
        if (!id) continue;
        repetitions.set(id, (repetitions.get(id) ?? 0) + 1);
      }

      const sellers = new Set<string>();
      for (const offer of offers) {
        const sellerId = offer.seller?.id;
        if (sellerId !== null && sellerId !== undefined) {
          sellers.add(String(sellerId));
        }
      }

      const numberOrZero = (value: unknown): number => {
        const parsed = typeof value === "number" ? value : Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
      };

      const priced = prices.filter(
        (price) => price.price && typeof price.price === "object",
      );
      const totals = priced.reduce(
        (acc, price) => ({
          originalPrice:
            acc.originalPrice + numberOrZero(price.price.originalPrice),
          discountPrice:
            acc.discountPrice + numberOrZero(price.price.discountPrice),
          discount: acc.discount + numberOrZero(price.price.discount),
          basePayoutPrice:
            acc.basePayoutPrice + numberOrZero(price.price.basePayoutPrice),
        }),
        {
          originalPrice: 0,
          discountPrice: 0,
          discount: 0,
          basePayoutPrice: 0,
        },
      );
      const firstPrice = priced[0]?.price ?? null;
      const exchangeRate =
        firstPrice === null
          ? Number.NaN
          : Number(firstPrice.payoutCurrencyExchangeRate);

      return {
        totalValue: {
          currencyCode:
            typeof firstPrice?.currencyCode === "string"
              ? firstPrice.currencyCode
              : null,
          ...totals,
          basePayoutCurrencyCode:
            typeof firstPrice?.basePayoutCurrencyCode === "string"
              ? firstPrice.basePayoutCurrencyCode
              : null,
          payoutCurrencyExchangeRate: Number.isFinite(exchangeRate)
            ? exchangeRate
            : null,
        },
        totalOffers: offers.length,
        totalGiveaways: giveaways.length,
        repeated: Array.from(repetitions.values()).filter((count) => count > 1)
          .length,
        sellers: sellers.size,
      };
    },
  );

  return jsonSuccess(c, data, { country, region, locale });
});

app.get("/free-games/mobile", async (c) => {
  const query = parseStrictQuery(c, REGIONAL_SHAPE);
  const { country, region, locale } = regionalParams(query);

  const data = await cached(
    v1CacheKey("free-games.mobile", { region, locale }),
    60,
    async () => {
      const now = new Date();
      const records = await mobileFreebies()
        .find({
          startDate: { $lte: now },
          endDate: { $gte: now },
        })
        .toArray();

      const sources: GiveawaySource[] = records
        .map((record) => ({
          record,
          offerId: String(record.offerId ?? ""),
          kind: "mobile" as const,
        }))
        .filter((source) => source.offerId.length > 0);

      const enriched = await Promise.all(
        sources.map((source) =>
          enrichGiveaway(source, region, locale, { dropMissingOffer: true }),
        ),
      );
      return enriched.filter((entry): entry is AnyRecord => entry !== null);
    },
  );

  return jsonSuccess(c, data, { country, region, locale, count: data.length });
});

app.get("/free-games/sellers", async (c) => {
  const data = await cached(
    v1CacheKey("free-games.sellers", {}),
    60 * 60,
    async () => {
      const rows = await db.db
        .collection("freegames")
        .aggregate<AnyRecord>(
          [
            {
              $group: {
                _id: "$id",
                doc: { $first: "$$ROOT" },
              },
            },
            { $replaceRoot: { newRoot: "$doc" } },
            {
              $lookup: {
                from: "offers",
                localField: "id",
                foreignField: "id",
                as: "offer",
              },
            },
            { $unwind: "$offer" },
            {
              $group: {
                _id: {
                  sellerId: "$offer.seller.id",
                  sellerName: "$offer.seller.name",
                },
                totalSingleGames: { $sum: 1 },
              },
            },
            {
              $project: {
                _id: 0,
                sellerId: "$_id.sellerId",
                sellerName: "$_id.sellerName",
                totalSingleGames: 1,
              },
            },
            { $sort: { totalSingleGames: -1 } },
          ],
          { maxTimeMS: 60_000, allowDiskUse: true },
        )
        .toArray();
      return rows.map((row) => serializeValue(row));
    },
  );

  return jsonSuccess(c, data, { count: data.length });
});

app.onError((error, c) => {
  if (error instanceof ProblemError) return problemResponse(c, error);
  throw error;
});

export default app;
