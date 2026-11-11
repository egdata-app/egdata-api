import { Hono } from "hono";
import {
  AchievementSet,
  Franchise,
  Igdb,
  Offer,
  PriceEngine,
} from "../../models/index.js";
import { localizeOffers } from "../../utils/offer-localization.js";
import { orderOffersObject } from "../../utils/order-offers-object.js";
import { cached, v1CacheKey } from "../cache.js";
import { type CursorSortTuple, decodeCursor, encodeCursor } from "../cursor.js";
import { notFound, ProblemError, problemResponse } from "../errors.js";
import {
  type MongoSortField,
  mongoKeysetFilter,
  mongoSortSpec,
  type PageMeta,
  pageMeta,
  parsePagination,
  trimPage,
} from "../pagination.js";
import {
  parseStrictQuery,
  querySchema,
  regionalParams,
  requireIdParam,
} from "../query.js";
import type { V1Variables } from "../request-context.js";
import { jsonSuccess } from "../response.js";
import {
  isoOrNull,
  type SerializedOffer,
  serializeOffer,
  stringId,
} from "../serialization.js";

// biome-ignore lint/suspicious/noExplicitAny: MongoDB documents are untyped at the driver boundary.
type AnyRecord = Record<string, any>;

const app = new Hono<{ Variables: V1Variables }>();

const FRANCHISE_OFFER_ORDERING = "releaseDate:desc,id:asc";
const FRANCHISE_CACHE_TTL_SECONDS = 60 * 60;
const FRANCHISE_OFFER_SORT: MongoSortField[] = [
  { field: "releaseDate", direction: -1, nulls: "last" },
  { field: "id", direction: 1, nulls: "last" },
];

type FranchiseStats = {
  totalTimeHastily: number;
  totalTimeNormally: number;
  totalTimeCompletely: number;
  totalAchievements: number;
  totalXp: number;
  gamesCount: number;
};

type FranchiseData = {
  id: string | null;
  name: unknown;
  lastUpdated: string | null;
  elements: SerializedOffer[];
  stats: FranchiseStats;
};

type FranchisePayload = {
  data: FranchiseData;
  pagination: PageMeta;
};

const emptyStats = (): FranchiseStats => ({
  totalTimeHastily: 0,
  totalTimeNormally: 0,
  totalTimeCompletely: 0,
  totalAchievements: 0,
  totalXp: 0,
  gamesCount: 0,
});

const offerFilterFromCursor = (last: CursorSortTuple) => {
  const tuple = last.map((value, index) => {
    if (index !== 0 || typeof value !== "string") return value;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed;
  });

  // Cursors carry JSON scalars, while MongoDB compares `releaseDate` against a
  // Date instance. The helper accepts scalar tuples, so widen the comparison.
  return mongoKeysetFilter(
    FRANCHISE_OFFER_SORT,
    tuple as unknown as Array<string | number | null>,
  );
};

const cursorTuple = (offer: AnyRecord): CursorSortTuple => [
  isoOrNull(offer.releaseDate),
  offer.id ?? null,
];

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

async function loadFranchisePage(options: {
  slug: string;
  country: string;
  region: string;
  locale: string;
  limit: number;
  cursor: string | null;
}): Promise<FranchisePayload> {
  const { slug, country, region, locale, limit, cursor } = options;

  const binding = {
    operation: "franchises.detail",
    filters: { slug },
    ordering: FRANCHISE_OFFER_ORDERING,
    country,
    locale,
    limit,
  };

  const franchise = (await Franchise.findById(slug).lean()) as AnyRecord | null;
  if (!franchise) {
    throw notFound(
      "FRANCHISE_NOT_FOUND",
      `No franchise with slug '${slug}' exists.`,
    );
  }

  const offerIds = stringList(franchise.offers);
  const base: Pick<FranchiseData, "id" | "name" | "lastUpdated"> = {
    id: stringId(franchise._id ?? franchise.id),
    name: franchise.name ?? null,
    lastUpdated: isoOrNull(franchise.lastUpdated),
  };

  if (offerIds.length === 0) {
    return {
      data: { ...base, elements: [], stats: emptyStats() },
      pagination: pageMeta(limit, false, null),
    };
  }

  const last = cursor ? decodeCursor(cursor, binding) : null;
  const filter = last
    ? { $and: [{ id: { $in: offerIds } }, offerFilterFromCursor(last)] }
    : { id: { $in: offerIds } };

  const rows = (await Offer.find(filter, undefined, {
    limit: limit + 1,
    sort: mongoSortSpec(FRANCHISE_OFFER_SORT),
  }).lean()) as AnyRecord[];
  const { items, hasMore } = trimPage(rows, limit);

  const [prices, allOffersBasic] = await Promise.all([
    PriceEngine.find({
      offerId: { $in: items.map((offer) => offer.id) },
      region,
    }).lean(),
    Offer.find({ id: { $in: offerIds } }, { id: 1, namespace: 1 }).lean(),
  ]);

  const priceByOfferId = new Map<string, AnyRecord>(
    (prices as AnyRecord[]).map((price) => [String(price.offerId), price]),
  );

  const localized = (await localizeOffers(
    items.map((offer) => ({
      ...orderOffersObject(offer),
      price: priceByOfferId.get(String(offer.id)) ?? null,
    })),
    locale,
  )) as AnyRecord[];
  const elements = localized.map((offer) =>
    serializeOffer(offer, { price: offer.price }),
  );

  // Stats cover every offer in the franchise, not just the current page.
  const namespaces = Array.from(
    new Set(
      (allOffersBasic as AnyRecord[])
        .map((offer) => offer.namespace)
        .filter(
          (namespace): namespace is string =>
            typeof namespace === "string" && namespace.length > 0,
        ),
    ),
  );

  const [achievementSets, igdbEntries] = (await Promise.all([
    AchievementSet.find({
      sandboxId: { $in: namespaces },
      isBase: true,
    }).lean(),
    Igdb.find({ offerId: { $in: offerIds } }).lean(),
  ])) as [AnyRecord[], AnyRecord[]];

  const totalAchievements = achievementSets.reduce(
    (total, set) =>
      total + (Array.isArray(set.achievements) ? set.achievements.length : 0),
    0,
  );
  const totalXp = achievementSets.reduce(
    (total, set) =>
      total +
      (Array.isArray(set.achievements)
        ? set.achievements.reduce(
            (sum: number, achievement: AnyRecord) =>
              sum + (Number(achievement.xp) || 0),
            0,
          )
        : 0),
    0,
  );

  let totalTimeHastily = 0;
  let totalTimeNormally = 0;
  let totalTimeCompletely = 0;
  const uniqueIgdbIds = new Set<unknown>();

  for (const igdb of igdbEntries) {
    if (igdb.igdbId && !uniqueIgdbIds.has(igdb.igdbId) && igdb.timeToBeat) {
      uniqueIgdbIds.add(igdb.igdbId);
      totalTimeHastily += Number(igdb.timeToBeat.hastily) || 0;
      totalTimeNormally += Number(igdb.timeToBeat.normally) || 0;
      totalTimeCompletely += Number(igdb.timeToBeat.completely) || 0;
    }
  }

  const stats: FranchiseStats = {
    totalTimeHastily,
    totalTimeNormally,
    totalTimeCompletely,
    totalAchievements,
    totalXp,
    gamesCount: uniqueIgdbIds.size || namespaces.length,
  };

  const lastItem = items[items.length - 1];

  return {
    data: { ...base, elements, stats },
    pagination: pageMeta(
      limit,
      hasMore,
      hasMore && lastItem ? encodeCursor(binding, cursorTuple(lastItem)) : null,
    ),
  };
}

app.get("/franchises/:slug", async (c) => {
  const query = parseStrictQuery(c, {
    ...querySchema.pagination,
    ...querySchema.regional,
  });
  const { country, region, locale } = regionalParams(query);
  const { limit, cursor } = parsePagination(query);
  const slug = requireIdParam(c, "slug");

  const payload = await cached<FranchisePayload>(
    v1CacheKey("franchises.detail", {
      slug,
      country,
      region,
      locale,
      limit,
      cursor,
    }),
    FRANCHISE_CACHE_TTL_SECONDS,
    () =>
      loadFranchisePage({
        slug,
        country,
        region,
        locale,
        limit,
        cursor,
      }),
  );

  return jsonSuccess(c, payload.data, { pagination: payload.pagination });
});

app.onError((error, c) => {
  if (error instanceof ProblemError) return problemResponse(c, error);
  throw error;
});

export default app;
