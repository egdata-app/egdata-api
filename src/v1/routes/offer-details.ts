import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { db } from "../../db/index.js";
import {
  AchievementSet,
  Asset,
  Bundles,
  Changelog,
  Collection,
  Franchise,
  FreeGames,
  GamePosition,
  Hltb,
  Item,
  Mappings,
  Media,
  Offer,
  OfferCountryPricingScore,
  PriceEngine,
  PriceEngineHistorical,
  Ratings,
  Review,
  Sandbox,
  Tags,
} from "../../models/index.js";
import { ageRatingsCountries } from "../../utils/age-ratings.js";
import { attributesToObject } from "../../utils/attributes-to-object.js";
import { type BuildDocument, buildSummary } from "../../utils/builds.js";
import { regions } from "../../utils/countries.js";
import { getGameFeatures } from "../../utils/game-features.js";
import { getOfferSubItems } from "../../utils/get-offer-sub-items.js";
import { localizeOffers } from "../../utils/offer-localization.js";
import { resolveOfferRequirements } from "../../utils/offer-requirements.js";
import { orderOffersObject } from "../../utils/order-offers-object.js";
import {
  isPriceCountryEligible,
  isPriceRegionEligible,
  priceAvailabilityKey,
} from "../../utils/price-eligibility.js";
import { toUsdCents } from "../../utils/price-usd.js";
import { cached, v1CacheKey } from "../cache.js";
import { type CursorSortTuple, decodeCursor, encodeCursor } from "../cursor.js";
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
  type PageMeta,
  pageMeta,
  parsePagination,
  trimPage,
} from "../pagination.js";
import {
  canonicalCountry,
  canonicalLocale,
  countryAndRegion,
  parseBoolean,
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
  type SerializedOffer,
  serializeOffer,
  serializePrice,
  serializeValue,
} from "../serialization.js";
import {
  currentPrice,
  getOffer,
  offerCountryEligible,
} from "../services/offers.js";

const app = new Hono<{ Variables: V1Variables }>();

type AnyRecord = Record<string, any>;

const DYNAMIC_TTL_SECONDS = 60;
const SUMMARY_TTL_SECONDS = 300;
const STABLE_TTL_SECONDS = 3600;

const RELATED_OFFER_LIMIT = 25;
const SUGGESTION_LIMIT = 25;
const BUILD_LIMIT = 50;

const OFFER_NOT_FOUND_DETAIL = "No offer exists with this ID.";

const PRICE_HISTORY_SORT: MongoSortField[] = [
  { field: "date", direction: -1, nulls: "last" },
  { field: "_id", direction: -1, nulls: "last" },
];

const CHANGELOG_SORT: MongoSortField[] = [
  { field: "timestamp", direction: -1, nulls: "last" },
  { field: "_id", direction: -1, nulls: "last" },
];

const REVIEW_SORT: MongoSortField[] = [
  { field: "createdAt", direction: -1, nulls: "last" },
  { field: "_id", direction: -1, nulls: "last" },
];

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

const OBJECT_ID_CURSOR_PREFIX = "oid:";

const REGION_CODES = Object.keys(regions);

async function requireOffer(
  id: string,
  projection?: AnyRecord,
): Promise<AnyRecord> {
  const offer = await Offer.findOne({ id: { $eq: id } }, projection).lean();
  if (!offer) {
    throw notFound("OFFER_NOT_FOUND", OFFER_NOT_FOUND_DETAIL);
  }
  return offer as AnyRecord;
}

function parseIsoTimestamp(value: string, parameter: string): Date {
  const trimmed = value.trim();
  const parsed = new Date(trimmed);
  if (!ISO_TIMESTAMP_PATTERN.test(trimmed) || Number.isNaN(parsed.getTime())) {
    throw badRequest(
      "INVALID_TIMESTAMP",
      `The \`${parameter}\` parameter must be an ISO 8601 timestamp such as 2025-01-31T00:00:00Z.`,
    );
  }
  return parsed;
}

function canonicalRegion(raw: string): string {
  const region = raw.trim().toUpperCase();
  if (!REGION_CODES.includes(region)) {
    throw badRequest(
      "INVALID_REGION",
      `Unknown pricing region '${raw}'. Use a region code returned by /v1/regions.`,
    );
  }
  return region;
}

/**
 * Cursors carry JSON scalars while MongoDB compares Date and ObjectId values
 * directly, so the tuple is widened before the keyset helper receives it.
 */
function keysetFilter(
  sort: MongoSortField[],
  last: CursorSortTuple,
): AnyRecord {
  const tuple = last.map((value, index) =>
    index === 0 ? cursorDate(value) : cursorId(value),
  );
  return mongoKeysetFilter(
    sort,
    tuple as unknown as Array<string | number | null>,
  ) as unknown as AnyRecord;
}

function cursorDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function cursorId(value: unknown): string | ObjectId | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return null;
  if (value.startsWith(OBJECT_ID_CURSOR_PREFIX)) {
    const hex = value.slice(OBJECT_ID_CURSOR_PREFIX.length);
    return ObjectId.isValid(hex) ? new ObjectId(hex) : value;
  }
  return value;
}

function encodeCursorId(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof ObjectId) {
    return `${OBJECT_ID_CURSOR_PREFIX}${value.toHexString()}`;
  }
  if (typeof value === "number") return value;
  return String(value);
}

async function loadPrice(
  id: string,
  region: string,
): Promise<AnyRecord | null> {
  return (await PriceEngine.findOne(
    { offerId: { $eq: id }, region: { $eq: region } },
    undefined,
    { sort: { updatedAt: -1 } },
  ).lean()) as AnyRecord | null;
}

async function loadPricesForOffers(
  offerIds: string[],
  region: string,
): Promise<Map<string, AnyRecord>> {
  if (offerIds.length === 0) return new Map();
  const prices = (await PriceEngine.find({
    offerId: { $in: offerIds },
    region,
  }).lean()) as AnyRecord[];
  return new Map(prices.map((price) => [String(price.offerId), price]));
}

/** Mirrors the legacy `basePayoutPrice` meaning: original price in USD cents. */
function normalizeBasePayoutPrice(price: AnyRecord | null | undefined): void {
  if (!price || typeof price.price !== "object" || price.price === null) return;
  price.price.basePayoutPrice = toUsdCents(price.price, "original");
}

type SerializedOfferList = {
  offers: SerializedOffer[];
  localization: Record<string, unknown>;
};

async function serializeOfferList(
  rawOffers: AnyRecord[],
  region: string,
  locale: string,
): Promise<SerializedOfferList> {
  const priceByOfferId = await loadPricesForOffers(
    rawOffers.map((offer) => String(offer.id)),
    region,
  );
  const localized = await localizeOffers(
    rawOffers.map((offer) => ({
      ...orderOffersObject(offer),
      price: priceByOfferId.get(String(offer.id)) ?? null,
    })),
    locale,
  );
  return {
    offers: localized.map((offer: AnyRecord) =>
      serializeOffer(offer, { price: offer.price }),
    ),
    localization: localizationMeta(localized[0]),
  };
}

type OfferSubItemDocument = {
  _id: string;
  subItems: Array<{ id: string }>;
};

async function loadItems(
  id: string,
  offerItems: AnyRecord[],
  subItems: OfferSubItemDocument[],
): Promise<AnyRecord[]> {
  const itemIds = [
    ...offerItems.map((item) => String(item.id)),
    ...subItems.flatMap((entry) => entry.subItems.map((sub) => String(sub.id))),
  ];
  return (await Item.find({
    $or: [{ id: { $in: itemIds } }, { linkedOffers: id }],
  }).lean()) as AnyRecord[];
}

async function loadOfferItems(
  id: string,
  offer: AnyRecord,
): Promise<AnyRecord[]> {
  const subItems = await getOfferSubItems({ _id: id });
  const offerItems = Array.isArray(offer.items) ? offer.items : [];
  return loadItems(id, offerItems, subItems);
}

async function loadAssets(items: AnyRecord[]): Promise<AnyRecord[]> {
  if (items.length === 0) return [];
  return (await Asset.find({
    itemId: { $in: items.map((item) => String(item.id)) },
  }).lean()) as AnyRecord[];
}

async function latestBuilds(assets: AnyRecord[]): Promise<AnyRecord[]> {
  const appNames = assets.map((asset) => String(asset.artifactId));
  if (appNames.length === 0) return [];
  const rows = await db.db
    .collection("builds")
    .aggregate([
      { $match: { appName: { $in: appNames } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: "$appName", doc: { $first: "$$ROOT" } } },
    ])
    .toArray();
  return rows
    .map((row) => row.doc as AnyRecord | undefined)
    .filter((doc): doc is AnyRecord => Boolean(doc));
}

function dedupeTechnologies(builds: AnyRecord[]): AnyRecord[] {
  const technologies: AnyRecord[] = [];
  for (const build of builds) {
    const entries: AnyRecord[] = Array.isArray(build.technologies)
      ? build.technologies
      : [];
    for (const technology of entries) {
      if (!technology) continue;
      if (
        technologies.some((entry) => entry.technology === technology.technology)
      ) {
        continue;
      }
      technologies.push(technology);
    }
  }
  return technologies;
}

function buildFeatures(items: AnyRecord[], offer: AnyRecord) {
  const customAttributes: Record<string, { type: string; value: string }> = {};
  for (const item of items) {
    Object.assign(customAttributes, attributesToObject(item.customAttributes));
  }
  const tags: Record<string, { id: string; name: string }> = {};
  const offerTags: AnyRecord[] = Array.isArray(offer.tags) ? offer.tags : [];
  for (const tag of offerTags) {
    if (tag?.id === undefined || tag?.id === null) continue;
    tags[String(tag.id)] = {
      id: String(tag.id),
      name: String(tag.name ?? ""),
    };
  }
  return getGameFeatures({ attributes: customAttributes, tags });
}

function ageRatingSystemForCountry(country: string): string {
  return (
    Object.entries(ageRatingsCountries).find(([, ratingCountries]) =>
      ratingCountries.includes(country),
    )?.[0] ?? "Generic"
  );
}

async function changelogContextIds(
  id: string,
  offer: AnyRecord,
): Promise<string[]> {
  const items = await loadOfferItems(id, offer);
  const assets = await loadAssets(items);
  return [
    id,
    ...items.map((item) => String(item.id)),
    ...assets.map((asset) => String(asset.artifactId)),
  ];
}

app.get("/offers/:id/franchises", async (c) => {
  const id = requireIdParam(c);

  const data = await cached<unknown[]>(
    v1CacheKey("offer-details.franchises", { id }),
    STABLE_TTL_SECONDS,
    async () => {
      await requireOffer(id, { id: 1 });
      const franchises = (await Franchise.find({
        offers: id,
      }).lean()) as AnyRecord[];
      if (franchises.length === 0) return [];

      const offerIds = Array.from(
        new Set(
          franchises.flatMap((franchise) =>
            Array.isArray(franchise.offers)
              ? franchise.offers.map((offerId: unknown) => String(offerId))
              : [],
          ),
        ),
      );
      const relatedOffers = (await Offer.find(
        { id: { $in: offerIds } },
        { id: 1, namespace: 1 },
      ).lean()) as AnyRecord[];
      const namespaceById = new Map(
        relatedOffers.map((offer) => [String(offer.id), offer.namespace]),
      );

      return franchises
        .filter((franchise) => {
          const namespaces = new Set(
            (Array.isArray(franchise.offers) ? franchise.offers : [])
              .map((offerId: unknown) => namespaceById.get(String(offerId)))
              .filter(Boolean),
          );
          return namespaces.size > 1;
        })
        .map((franchise) => serializeValue(franchise));
    },
  );

  return jsonSuccess(c, data, { count: data.length });
});

app.get("/offers/:id/features", async (c) => {
  const id = requireIdParam(c);

  const data = await cached(
    v1CacheKey("offer-details.features", { id }),
    STABLE_TTL_SECONDS,
    async () => {
      const offer = await requireOffer(id, { items: 1, tags: 1 });
      const items = await loadOfferItems(id, offer);
      return buildFeatures(items, offer);
    },
  );

  return jsonSuccess(c, data);
});

app.get("/offers/:id/assets", async (c) => {
  const id = requireIdParam(c);

  const data = await cached<unknown[]>(
    v1CacheKey("offer-details.assets", { id }),
    STABLE_TTL_SECONDS,
    async () => {
      const offer = await requireOffer(id, { items: 1 });
      const items = await loadOfferItems(id, offer);
      const assets = await loadAssets(items);
      return assets.map((asset) => serializeValue(asset));
    },
  );

  return jsonSuccess(c, data, { count: data.length });
});

app.get("/offers/:id/items", async (c) => {
  const id = requireIdParam(c);

  const data = await cached<unknown[]>(
    v1CacheKey("offer-details.items", { id }),
    STABLE_TTL_SECONDS,
    async () => {
      const offer = await requireOffer(id, { items: 1 });
      const items = await loadOfferItems(id, offer);
      return items.map((item) => serializeValue(item));
    },
  );

  return jsonSuccess(c, data, { count: data.length });
});

app.get("/offers/:id/changelog", async (c) => {
  const id = requireIdParam(c);
  const query = parseStrictQuery(c, {
    ...querySchema.pagination,
    query: z.string().max(200).optional(),
    type: z.string().max(100).optional(),
    field: z.string().max(200).optional(),
  });
  const { limit, cursor } = parsePagination(query, 50);
  const search = query.query?.trim() || null;
  const changeType = query.type?.trim() || null;
  const changeField = query.field?.trim() || null;
  const filters = {
    offerId: id,
    query: search,
    type: changeType,
    field: changeField,
  };
  const binding = {
    operation: "offer-details.changelog",
    filters,
    ordering: "timestamp:desc,_id:desc",
    country: "US",
    locale: "en-US",
    limit,
  };

  const page = await cached<{ elements: unknown[]; pagination: PageMeta }>(
    v1CacheKey("offer-details.changelog", {
      id,
      limit,
      cursor,
      query: search,
      type: changeType,
      field: changeField,
    }),
    DYNAMIC_TTL_SECONDS,
    async () => {
      // Item IDs are needed to include changes for the offer's items and assets.
      const offer = await requireOffer(id, { id: 1, items: 1 });
      const contextIds = await changelogContextIds(id, offer);

      const match: AnyRecord = {
        "metadata.contextId": { $in: contextIds },
      };
      if (search) match.$text = { $search: search };
      if (changeType) match["metadata.changes.changeType"] = changeType;
      if (changeField) match["metadata.changes.field"] = changeField;

      const pipeline: AnyRecord[] = [{ $match: match }];
      if (cursor) {
        pipeline.push({
          $match: keysetFilter(CHANGELOG_SORT, decodeCursor(cursor, binding)),
        });
      }
      pipeline.push(
        { $sort: { timestamp: -1, _id: -1 } },
        { $limit: limit + 1 },
        {
          $lookup: {
            from: "offers",
            let: { contextId: "$metadata.contextId" },
            pipeline: [{ $match: { $expr: { $eq: ["$id", "$$contextId"] } } }],
            as: "offerDoc",
          },
        },
        {
          $lookup: {
            from: "items",
            let: { contextId: "$metadata.contextId" },
            pipeline: [{ $match: { $expr: { $eq: ["$id", "$$contextId"] } } }],
            as: "itemDoc",
          },
        },
        {
          $lookup: {
            from: "assets",
            let: { contextId: "$metadata.contextId" },
            pipeline: [
              { $match: { $expr: { $eq: ["$artifactId", "$$contextId"] } } },
            ],
            as: "assetDoc",
          },
        },
        {
          $addFields: {
            document: {
              $switch: {
                branches: [
                  {
                    case: { $eq: ["$metadata.contextType", "offer"] },
                    // biome-ignore lint/suspicious/noThenProperty: MongoDB $switch branches use a then field.
                    then: { $arrayElemAt: ["$offerDoc", 0] },
                  },
                  {
                    case: { $eq: ["$metadata.contextType", "item"] },
                    // biome-ignore lint/suspicious/noThenProperty: MongoDB $switch branches use a then field.
                    then: { $arrayElemAt: ["$itemDoc", 0] },
                  },
                  {
                    case: { $eq: ["$metadata.contextType", "asset"] },
                    // biome-ignore lint/suspicious/noThenProperty: MongoDB $switch branches use a then field.
                    then: { $arrayElemAt: ["$assetDoc", 0] },
                  },
                ],
                default: null,
              },
            },
          },
        },
        {
          $project: {
            _id: 1,
            metadata: 1,
            timestamp: 1,
            document: 1,
          },
        },
      );

      const rows = (await db.db
        .collection("changelogs_v2")
        .aggregate(pipeline)
        .toArray()) as AnyRecord[];
      const { items, hasMore } = trimPage(rows, limit);
      const lastRow = items.at(-1);

      return {
        elements: items.map((row) => serializeValue(row)),
        pagination: pageMeta(
          limit,
          hasMore,
          hasMore && lastRow
            ? encodeCursor(binding, [
                isoOrNull(lastRow.timestamp),
                encodeCursorId(lastRow._id),
              ])
            : null,
        ),
      };
    },
  );

  return jsonSuccess(c, page.elements, { pagination: page.pagination });
});

app.get("/offers/:id/changelog/stats", async (c) => {
  const id = requireIdParam(c);
  const query = parseStrictQuery(c, {
    from: z.string().min(1),
    to: z.string().min(1),
  });
  const from = parseIsoTimestamp(query.from, "from");
  const to = parseIsoTimestamp(query.to, "to");
  if (from.getTime() > to.getTime()) {
    throw badRequest(
      "INVALID_TIMESTAMP",
      "The `from` timestamp must not be later than `to`.",
    );
  }

  const stats = await cached(
    v1CacheKey("offer-details.changelog-stats", {
      id,
      from: from.toISOString(),
      to: to.toISOString(),
    }),
    DYNAMIC_TTL_SECONDS,
    async () => {
      await requireOffer(id, { id: 1 });
      const changes = (await Changelog.find(
        {
          "metadata.contextId": id,
          timestamp: { $gte: from, $lte: to },
        },
        { timestamp: 1, "metadata.changes": 1 },
        { sort: { timestamp: -1 } },
      ).lean()) as AnyRecord[];

      const dailyChanges: Record<string, number> = {};
      const weekdayChanges: Record<string, number> = {};
      const changeTypes: Record<string, number> = {};
      const changeFields: Record<string, number> = {};

      for (const change of changes) {
        const timestamp = cursorDate(change.timestamp);
        if (timestamp) {
          const day = timestamp.toISOString().slice(0, 10);
          dailyChanges[day] = (dailyChanges[day] ?? 0) + 1;
          const weekday = String(timestamp.getUTCDay());
          weekdayChanges[weekday] = (weekdayChanges[weekday] ?? 0) + 1;
        }

        const entries: AnyRecord[] = Array.isArray(change.metadata?.changes)
          ? change.metadata.changes
          : [];
        for (const entry of entries) {
          if (entry?.changeType !== undefined && entry?.changeType !== null) {
            const type = String(entry.changeType);
            changeTypes[type] = (changeTypes[type] ?? 0) + 1;
          }
          if (entry?.field !== undefined && entry?.field !== null) {
            const field = String(entry.field);
            changeFields[field] = (changeFields[field] ?? 0) + 1;
          }
        }
      }

      return { dailyChanges, weekdayChanges, changeTypes, changeFields };
    },
  );

  return jsonSuccess(c, stats, {
    from: from.toISOString(),
    to: to.toISOString(),
  });
});

app.get("/offers/:id/achievements", async (c) => {
  const id = requireIdParam(c);

  const data = await cached<unknown[]>(
    v1CacheKey("offer-details.achievements", { id }),
    STABLE_TTL_SECONDS,
    async () => {
      const offer = await requireOffer(id, { namespace: 1, offerType: 1 });
      const achievements = (await AchievementSet.find({
        sandboxId: offer.namespace,
        isBase: offer.offerType === "BASE_GAME",
      }).lean()) as AnyRecord[];
      return achievements.map((achievement) => serializeValue(achievement));
    },
  );

  return jsonSuccess(c, data, { count: data.length });
});

app.get("/offers/:id/related", async (c) => {
  const id = requireIdParam(c);
  const query = parseStrictQuery(c, { ...querySchema.regional });
  const { country, region, locale } = regionalParams(query);

  const payload = await cached<SerializedOfferList>(
    v1CacheKey("offer-details.related", { id, region, locale }),
    DYNAMIC_TTL_SECONDS,
    async () => {
      const offer = await requireOffer(id, { id: 1, namespace: 1 });
      const related = (await Offer.find(
        { namespace: offer.namespace, id: { $ne: id } },
        undefined,
        { limit: RELATED_OFFER_LIMIT },
      ).lean()) as AnyRecord[];
      return serializeOfferList(related, region, locale);
    },
  );

  return jsonSuccess(c, payload.offers, {
    country,
    region,
    locale,
    count: payload.offers.length,
    limit: RELATED_OFFER_LIMIT,
    ...payload.localization,
  });
});

app.get("/offers/:id/mappings", async (c) => {
  const id = requireIdParam(c);

  const mappings = await cached(
    v1CacheKey("offer-details.mappings", { id }),
    STABLE_TTL_SECONDS,
    async () => {
      await requireOffer(id, { id: 1 });
      const found = await Mappings.findOne({ _id: id }).lean();
      if (!found) {
        throw notFound(
          "MAPPINGS_NOT_FOUND",
          "No store mappings are stored for this offer.",
        );
      }
      return serializeValue(found);
    },
  );

  return jsonSuccess(c, mappings);
});

app.get("/offers/:id/media", async (c) => {
  const id = requireIdParam(c);

  const media = await cached(
    v1CacheKey("offer-details.media", { id }),
    STABLE_TTL_SECONDS,
    async () => {
      await requireOffer(id, { id: 1 });
      const found = await Media.findOne({ _id: id }).lean();
      if (!found) {
        throw notFound("MEDIA_NOT_FOUND", "No media is stored for this offer.");
      }
      return serializeValue(found);
    },
  );

  return jsonSuccess(c, media);
});

app.get("/offers/:id/suggestions", async (c) => {
  const id = requireIdParam(c);
  const query = parseStrictQuery(c, { ...querySchema.regional });
  const { country, region, locale } = regionalParams(query);

  const payload = await cached<SerializedOfferList>(
    v1CacheKey("offer-details.suggestions", { id, region, locale }),
    DYNAMIC_TTL_SECONDS,
    async () => {
      const offer = await requireOffer(id, { id: 1, namespace: 1, tags: 1 });
      const tagIds = (Array.isArray(offer.tags) ? offer.tags : [])
        .map((tag: AnyRecord) => tag.id)
        .filter((tagId: unknown) => tagId !== undefined && tagId !== null);
      const tagDocuments = (await Tags.find({
        id: { $in: tagIds },
      }).lean()) as AnyRecord[];
      const genreIds = tagDocuments
        .filter((tag) => tag.groupName === "genre")
        .map((tag) => tag.id);
      const suggestions = (await Offer.find(
        {
          tags: { $elemMatch: { id: { $in: genreIds } } },
          id: { $ne: id },
          namespace: { $ne: offer.namespace },
          offerType: { $in: ["BASE_GAME", "DLC"] },
        },
        undefined,
        { limit: SUGGESTION_LIMIT, sort: { lastModifiedDate: -1 } },
      ).lean()) as AnyRecord[];
      return serializeOfferList(suggestions, region, locale);
    },
  );

  return jsonSuccess(c, payload.offers, {
    country,
    region,
    locale,
    count: payload.offers.length,
    limit: SUGGESTION_LIMIT,
    ...payload.localization,
  });
});

app.get("/offers/:id/age-rating", async (c) => {
  const id = requireIdParam(c);
  const query = parseStrictQuery(c, {
    country: z.string().optional(),
    single: z.string().optional(),
  });
  const country = canonicalCountry(query.country);
  const single = parseBoolean(query.single, "single") ?? false;

  const rating = await cached<Record<string, unknown>>(
    v1CacheKey("offer-details.age-rating", { id, country, single }),
    STABLE_TTL_SECONDS,
    async () => {
      const offer = await requireOffer(id, { namespace: 1 });
      const sandbox = (await Sandbox.findOne({
        _id: offer.namespace,
      }).lean()) as AnyRecord | null;
      if (!sandbox) {
        throw notFound(
          "SANDBOX_NOT_FOUND",
          "No sandbox exists for this offer.",
        );
      }
      const ageRatings = sandbox.ageGatings as
        | Record<string, unknown>
        | undefined
        | null;
      if (!ageRatings) {
        throw notFound(
          "AGE_RATING_NOT_FOUND",
          "No age ratings are stored for this offer.",
        );
      }
      if (!single) return serializeValue(ageRatings) as Record<string, unknown>;

      const system = ageRatingSystemForCountry(country);
      const selected = ageRatings[system];
      if (selected === undefined || selected === null) {
        throw notFound(
          "AGE_RATING_NOT_FOUND",
          `No ${system} age rating is stored for this offer.`,
        );
      }
      return serializeValue({ [system]: selected }) as Record<string, unknown>;
    },
  );

  return jsonSuccess(c, rating, { country, single });
});

app.get("/offers/:id/giveaways", async (c) => {
  const id = requireIdParam(c);

  const data = await cached<unknown[]>(
    v1CacheKey("offer-details.giveaways", { id }),
    STABLE_TTL_SECONDS,
    async () => {
      await requireOffer(id, { id: 1 });
      const giveaways = (await FreeGames.find({ id }, undefined, {
        sort: { startDate: -1 },
      }).lean()) as AnyRecord[];
      return giveaways.map((giveaway) => serializeValue(giveaway));
    },
  );

  return jsonSuccess(c, data, { count: data.length });
});

app.get("/offers/:id/ratings", async (c) => {
  const id = requireIdParam(c);

  const ratings = await cached(
    v1CacheKey("offer-details.ratings", { id }),
    STABLE_TTL_SECONDS,
    async () => {
      const offer = await requireOffer(id, { namespace: 1 });
      const sandbox = (await Sandbox.findOne({
        _id: offer.namespace,
      }).lean()) as AnyRecord | null;
      if (!sandbox) {
        throw notFound(
          "SANDBOX_NOT_FOUND",
          "No sandbox exists for this offer.",
        );
      }
      const product = await db.db
        .collection("products")
        .findOne({ _id: sandbox.parent });
      if (!product) {
        throw notFound(
          "PRODUCT_NOT_FOUND",
          "No store product exists for this offer.",
        );
      }
      const found = await Ratings.findOne({ _id: product.slug }).lean();
      if (!found) {
        throw notFound(
          "RATINGS_NOT_FOUND",
          "No player ratings are stored for this product.",
        );
      }
      return serializeValue(found);
    },
  );

  return jsonSuccess(c, ratings);
});

app.get("/offers/:id/tops", async (c) => {
  const id = requireIdParam(c);

  const positions = await cached<Record<string, unknown>>(
    v1CacheKey("offer-details.tops", { id }),
    STABLE_TTL_SECONDS,
    async () => {
      await requireOffer(id, { id: 1 });
      const rows = (await GamePosition.find({
        offerId: id,
      }).lean()) as AnyRecord[];
      const result: Record<string, unknown> = {};
      for (const position of rows) {
        if (
          position.collectionId === undefined ||
          position.collectionId === null
        ) {
          continue;
        }
        result[String(position.collectionId)] = position.position ?? null;
      }
      return result;
    },
  );

  return jsonSuccess(c, positions, { count: Object.keys(positions).length });
});

app.get("/offers/:id/polls", async (c) => {
  const id = requireIdParam(c);

  const poll = await cached(
    v1CacheKey("offer-details.polls", { id }),
    STABLE_TTL_SECONDS,
    async () => {
      const offer = await requireOffer(id, { namespace: 1 });
      const sandbox = (await Sandbox.findOne({
        _id: offer.namespace,
      }).lean()) as AnyRecord | null;
      if (!sandbox) {
        throw notFound(
          "SANDBOX_NOT_FOUND",
          "No sandbox exists for this offer.",
        );
      }
      const found = await db.db
        .collection("ratings_polls")
        .findOne({ _id: offer.namespace });
      return found ? serializeValue(found) : null;
    },
  );

  return jsonSuccess(c, { poll: poll ?? null });
});

app.get("/offers/:id/hltb", async (c) => {
  const id = requireIdParam(c);

  const hltb = await cached(
    v1CacheKey("offer-details.hltb", { id }),
    STABLE_TTL_SECONDS,
    async () => {
      await requireOffer(id, { id: 1 });
      const found = (await Hltb.findOne({
        _id: id,
      }).lean()) as AnyRecord | null;
      if (!found?.hltbId || found.hltbId === "00000") {
        throw notFound(
          "HLTB_NOT_FOUND",
          "No HowLongToBeat data is stored for this offer.",
        );
      }
      return serializeValue(found);
    },
  );

  return jsonSuccess(c, hltb);
});

app.get("/offers/:id/collection", async (c) => {
  const id = requireIdParam(c);
  const query = parseStrictQuery(c, { ...querySchema.regional });
  const { country, region, locale } = regionalParams(query);

  const payload = await cached<SerializedOfferList>(
    v1CacheKey("offer-details.collection", { id, region, locale }),
    DYNAMIC_TTL_SECONDS,
    async () => {
      const offer = await requireOffer(id);
      const categories = Array.isArray(offer.categories)
        ? offer.categories
        : [];
      if (!categories.includes("collections")) {
        throw notFound(
          "COLLECTION_NOT_FOUND",
          "This offer does not belong to a collection.",
        );
      }
      const attributes = Array.isArray(offer.customAttributes)
        ? offer.customAttributes
        : [];
      const collectionOfferIds = attributes
        .filter(
          (attribute: AnyRecord) =>
            typeof attribute?.key === "string" &&
            attribute.key.startsWith("com.epicgames.app.collectionOfferIds."),
        )
        .map((attribute: AnyRecord) => String(attribute.value));
      if (collectionOfferIds.length === 0) {
        throw notFound(
          "COLLECTION_NOT_FOUND",
          "This offer does not belong to a collection.",
        );
      }
      const collectionOffers = (await Offer.find({
        id: { $in: collectionOfferIds },
      }).lean()) as AnyRecord[];
      return serializeOfferList(collectionOffers, region, locale);
    },
  );

  return jsonSuccess(c, payload.offers, {
    country,
    region,
    locale,
    count: payload.offers.length,
    ...payload.localization,
  });
});

app.get("/offers/:id/collections/:collection", async (c) => {
  const id = requireIdParam(c);
  const collection = requireIdParam(c, "collection");

  const data = await cached(
    v1CacheKey("offer-details.collection-entry", { id, collection }),
    STABLE_TTL_SECONDS,
    async () => {
      await requireOffer(id, { id: 1 });
      const [entry, collectionDocument] = await Promise.all([
        GamePosition.findOne({
          collectionId: collection,
          offerId: id,
        }).lean(),
        Collection.findOne({ _id: collection }).lean(),
      ]);
      if (!entry || !collectionDocument) {
        throw notFound(
          "COLLECTION_ENTRY_NOT_FOUND",
          "This offer has no entry in the requested collection.",
        );
      }
      return {
        ...(serializeValue(entry) as AnyRecord),
        name: collectionDocument.name ?? null,
      };
    },
  );

  return jsonSuccess(c, data);
});

app.get("/offers/:id/bundle", async (c) => {
  const id = requireIdParam(c);
  const query = parseStrictQuery(c, { ...querySchema.regional });
  const { country, region, locale } = regionalParams(query);

  const data = await cached(
    v1CacheKey("offer-details.bundle", { id, region, locale }),
    DYNAMIC_TTL_SECONDS,
    async () => {
      const offer = await requireOffer(id);
      if (offer.offerType !== "BUNDLE" && offer.offerType !== "Bundle") {
        throw notFound("BUNDLE_NOT_FOUND", "This offer is not a bundle.");
      }
      const bundle = (await Bundles.findOne({
        _id: id,
      }).lean()) as AnyRecord | null;
      if (!bundle) {
        throw notFound(
          "BUNDLE_NOT_FOUND",
          "No bundle contents are stored for this offer.",
        );
      }
      const bundleOfferIds = Array.isArray(bundle.offers)
        ? bundle.offers.map((offerId: unknown) => String(offerId))
        : [];
      const [mainPrice, bundleOffers, priceByOfferId] = await Promise.all([
        loadPrice(id, region),
        Offer.find({ id: { $in: bundleOfferIds } }).lean() as Promise<
          AnyRecord[]
        >,
        loadPricesForOffers(bundleOfferIds, region),
      ]);
      const localized = await localizeOffers(
        (bundleOffers as AnyRecord[]).map((bundleOffer) => ({
          ...orderOffersObject(bundleOffer),
          price: priceByOfferId.get(String(bundleOffer.id)) ?? null,
        })),
        locale,
      );
      const totalPrice = (bundleOffers as AnyRecord[]).reduce<AnyRecord>(
        (accumulator, bundleOffer) => {
          const price = priceByOfferId.get(String(bundleOffer.id));
          const nested =
            price && typeof price.price === "object" ? price.price : null;
          if (!nested) return accumulator;
          const current = accumulator.price as AnyRecord;
          current.currencyCode = nested.currencyCode ?? current.currencyCode;
          current.discount = (current.discount ?? 0) + (nested.discount ?? 0);
          current.discountPrice =
            (current.discountPrice ?? 0) + (nested.discountPrice ?? 0);
          current.originalPrice =
            (current.originalPrice ?? 0) + (nested.originalPrice ?? 0);
          current.basePayoutCurrencyCode =
            nested.basePayoutCurrencyCode ?? current.basePayoutCurrencyCode;
          current.basePayoutPrice =
            (current.basePayoutPrice ?? 0) + (nested.basePayoutPrice ?? 0);
          current.payoutCurrencyExchangeRate =
            nested.payoutCurrencyExchangeRate ??
            current.payoutCurrencyExchangeRate;
          return accumulator;
        },
        {
          country,
          offerId: id,
          region,
          namespace: mainPrice?.namespace ?? offer.namespace ?? null,
          updatedAt: mainPrice?.updatedAt ?? null,
          appliedRules: [],
          price: {
            discount: 0,
            discountPrice: 0,
            originalPrice: 0,
            basePayoutPrice: 0,
            currencyCode: "USD",
            basePayoutCurrencyCode: "USD",
            payoutCurrencyExchangeRate: 1,
          },
        },
      );

      return {
        offers: localized.map((bundleOffer: AnyRecord) =>
          serializeOffer(bundleOffer, { price: bundleOffer.price }),
        ),
        bundlePrice: serializePrice(mainPrice),
        totalPrice: serializePrice(totalPrice),
        localization: localizationMeta(localized[0]),
      };
    },
  );

  return jsonSuccess(
    c,
    {
      offers: data.offers,
      bundlePrice: data.bundlePrice,
      totalPrice: data.totalPrice,
    },
    {
      country,
      region,
      locale,
      count: data.offers.length,
      ...data.localization,
    },
  );
});

app.get("/offers/:id/in-bundle", async (c) => {
  const id = requireIdParam(c);
  const query = parseStrictQuery(c, { ...querySchema.regional });
  const { country, region, locale } = regionalParams(query);

  const payload = await cached<SerializedOfferList>(
    v1CacheKey("offer-details.in-bundle", { id, region, locale }),
    DYNAMIC_TTL_SECONDS,
    async () => {
      await requireOffer(id, { id: 1 });
      const bundles = (await Bundles.find({
        offers: id,
      }).lean()) as AnyRecord[];
      const bundleIds = bundles.map((bundle) => String(bundle._id));
      if (bundleIds.length === 0) {
        return { offers: [], localization: {} };
      }
      const bundleOffers = (await Offer.find({
        id: { $in: bundleIds },
      }).lean()) as AnyRecord[];
      const offerById = new Map(
        bundleOffers.map((bundleOffer) => [
          String(bundleOffer.id),
          bundleOffer,
        ]),
      );
      const ordered = bundleIds
        .map((bundleId) => offerById.get(bundleId))
        .filter((bundleOffer): bundleOffer is AnyRecord =>
          Boolean(bundleOffer),
        );
      return serializeOfferList(ordered, region, locale);
    },
  );

  return jsonSuccess(c, payload.offers, {
    country,
    region,
    locale,
    count: payload.offers.length,
    ...payload.localization,
  });
});

app.get("/offers/:id/has-prepurchase", async (c) => {
  const id = requireIdParam(c);
  const query = parseStrictQuery(c, { ...querySchema.regional });
  const { country, region, locale } = regionalParams(query);

  const payload = await cached<{
    hasPrepurchase: boolean;
    offer: SerializedOffer | null;
    localization: Record<string, unknown>;
  }>(
    v1CacheKey("offer-details.has-prepurchase", { id, region, locale }),
    DYNAMIC_TTL_SECONDS,
    async () => {
      const offer = await requireOffer(id, { id: 1, namespace: 1 });
      const prepurchase = (await Offer.findOne({
        namespace: offer.namespace,
        offerType: "BASE_GAME",
        prePurchase: true,
        id: { $ne: id },
      }).lean()) as AnyRecord | null;
      if (!prepurchase) {
        return { hasPrepurchase: false, offer: null, localization: {} };
      }
      const price = await loadPrice(String(prepurchase.id), region);
      const [localized] = await localizeOffers(
        [{ ...orderOffersObject(prepurchase), price }],
        locale,
      );
      return {
        hasPrepurchase: true,
        offer: serializeOffer(localized, { price }),
        localization: localizationMeta(localized),
      };
    },
  );

  return jsonSuccess(
    c,
    {
      hasPrepurchase: payload.hasPrepurchase,
      ...(payload.offer ? { offer: payload.offer } : {}),
    },
    { country, region, locale, ...payload.localization },
  );
});

app.get("/offers/:id/has-regular", async (c) => {
  const id = requireIdParam(c);
  const query = parseStrictQuery(c, { ...querySchema.regional });
  const { country, region, locale } = regionalParams(query);

  const payload = await cached<{
    isPrepurchase: boolean;
    offer: SerializedOffer | null;
    localization: Record<string, unknown>;
  }>(
    v1CacheKey("offer-details.has-regular", { id, region, locale }),
    DYNAMIC_TTL_SECONDS,
    async () => {
      const offer = await requireOffer(id, {
        id: 1,
        namespace: 1,
        offerType: 1,
        prePurchase: 1,
      });
      if (offer.offerType !== "BASE_GAME" || offer.prePurchase !== true) {
        return { isPrepurchase: false, offer: null, localization: {} };
      }
      const regular = (await Offer.findOne({
        namespace: offer.namespace,
        offerType: "BASE_GAME",
        prePurchase: { $ne: true },
        id: { $ne: id },
      }).lean()) as AnyRecord | null;
      if (!regular) {
        return { isPrepurchase: false, offer: null, localization: {} };
      }
      const price = await loadPrice(String(regular.id), region);
      const [localized] = await localizeOffers(
        [{ ...orderOffersObject(regular), price }],
        locale,
      );
      return {
        isPrepurchase: true,
        offer: serializeOffer(localized, { price }),
        localization: localizationMeta(localized),
      };
    },
  );

  return jsonSuccess(
    c,
    {
      isPrepurchase: payload.isPrepurchase,
      ...(payload.offer ? { offer: payload.offer } : {}),
    },
    { country, region, locale, ...payload.localization },
  );
});

app.get("/offers/:id/genres", async (c) => {
  const id = requireIdParam(c);

  const data = await cached<unknown[]>(
    v1CacheKey("offer-details.genres", { id }),
    STABLE_TTL_SECONDS,
    async () => {
      const offer = await requireOffer(id, { tags: 1 });
      const genreTags = (await Tags.find({
        groupName: "genre",
        status: "ACTIVE",
      }).lean()) as AnyRecord[];
      const genreIds = new Set(genreTags.map((tag) => String(tag.id)));
      const offerTags: AnyRecord[] = Array.isArray(offer.tags)
        ? offer.tags
        : [];
      return offerTags
        .filter((tag) => genreIds.has(String(tag.id)))
        .map((tag) => serializeValue(tag));
    },
  );

  return jsonSuccess(c, data, { count: data.length });
});

app.get("/offers/:id/technologies", async (c) => {
  const id = requireIdParam(c);

  const data = await cached<unknown[]>(
    v1CacheKey("offer-details.technologies", { id }),
    STABLE_TTL_SECONDS,
    async () => {
      const offer = await requireOffer(id, { items: 1 });
      const items = await loadOfferItems(id, offer);
      const assets = await loadAssets(items);
      const builds = await latestBuilds(assets);
      return dedupeTechnologies(builds).map((technology) =>
        serializeValue(technology),
      );
    },
  );

  return jsonSuccess(c, data, { count: data.length });
});

app.get("/offers/:id/builds", async (c) => {
  const id = requireIdParam(c);

  const data = await cached<unknown[]>(
    v1CacheKey("offer-details.builds", { id }),
    STABLE_TTL_SECONDS,
    async () => {
      const offer = await requireOffer(id, { items: 1 });
      const items = await loadOfferItems(id, offer);
      const assets = await loadAssets(items);
      const appNames = assets.map((asset) => String(asset.artifactId));
      if (appNames.length === 0) return [];
      const builds = await db.db
        .collection<BuildDocument>("builds")
        .find({ appName: { $in: appNames } })
        .sort({ updatedAt: -1 })
        .limit(BUILD_LIMIT)
        .toArray();
      return builds.map((build) => serializeValue(buildSummary(build)));
    },
  );

  return jsonSuccess(c, data, { count: data.length, limit: BUILD_LIMIT });
});

app.get("/offers/:id/igdb", async (c) => {
  const id = requireIdParam(c);

  const igdb = await cached(
    v1CacheKey("offer-details.igdb", { id }),
    STABLE_TTL_SECONDS,
    async () => {
      await requireOffer(id, { id: 1 });
      const found = await db.db.collection("igdb").findOne({ offerId: id });
      if (!found) {
        throw notFound(
          "IGDB_NOT_FOUND",
          "No IGDB data is stored for this offer.",
        );
      }
      return serializeValue(found);
    },
  );

  return jsonSuccess(c, igdb);
});

app.get("/offers/:id/overview", async (c) => {
  const id = requireIdParam(c);
  const query = parseStrictQuery(c, { ...querySchema.regional });
  const { country, region, locale } = regionalParams(query);

  const payload = await cached<{
    data: AnyRecord;
    localization: Record<string, unknown>;
  }>(
    v1CacheKey("offer-details.overview", { id, region, locale }),
    SUMMARY_TTL_SECONDS,
    async () => {
      const detail = await getOffer({ id, country, region, locale });
      if (!detail) {
        throw notFound("OFFER_NOT_FOUND", OFFER_NOT_FOUND_DETAIL);
      }
      const offer = detail.offer as AnyRecord;

      const [media, igdb, subItems, sandbox, giveaways, genreTags] =
        await Promise.all([
          Media.findOne({ _id: id }).lean(),
          db.db.collection("igdb").findOne({ offerId: id }),
          getOfferSubItems({ _id: id }),
          Sandbox.findOne({ _id: offer.namespace }).lean(),
          FreeGames.find({ id }, undefined, {
            sort: { startDate: -1 },
          }).lean(),
          Tags.find({ groupName: "genre", status: "ACTIVE" }).lean(),
        ]);

      const offerItems: AnyRecord[] = Array.isArray(offer.items)
        ? offer.items
        : [];
      const items = await loadItems(id, offerItems, subItems);
      const assets = await loadAssets(items);
      const builds = await latestBuilds(assets);
      const poll = await db.db
        .collection("ratings_polls")
        .findOne({ _id: offer.namespace });

      const sandboxData = sandbox as AnyRecord | null;
      const ageRatings = sandboxData?.ageGatings as
        | Record<string, unknown>
        | undefined
        | null;
      let ageRating: AnyRecord | null = null;
      if (ageRatings) {
        const system = ageRatingSystemForCountry(country);
        const rating = ageRatings[system];
        if (rating !== undefined && rating !== null) {
          ageRating = { [system]: rating };
        }
      }

      const genreIds = new Set(
        (genreTags as AnyRecord[]).map((tag) => String(tag.id)),
      );
      const offerTags: AnyRecord[] = Array.isArray(offer.tags)
        ? offer.tags
        : [];
      const genres = offerTags.filter((tag) => genreIds.has(String(tag.id)));

      return {
        data: {
          offer: detail.offer,
          price: detail.offer.price ?? null,
          media: media ? serializeValue(media) : null,
          igdb: igdb ? serializeValue(igdb) : null,
          features: buildFeatures(items, offer),
          ageRating,
          giveaways: (giveaways as AnyRecord[]).map((giveaway) =>
            serializeValue(giveaway),
          ),
          polls: poll ? serializeValue(poll) : null,
          genres: genres.map((genre) => serializeValue(genre)),
          technologies: dedupeTechnologies(builds).map((technology) =>
            serializeValue(technology),
          ),
        },
        localization: detail.localization,
      };
    },
  );

  return jsonSuccess(c, payload.data, {
    country,
    region,
    locale,
    ...payload.localization,
  });
});

app.get("/offers/:id/price", async (c) => {
  const id = requireIdParam(c);
  const query = parseStrictQuery(c, { ...querySchema.regional });
  const { country, region, locale } = regionalParams(query);

  const payload = await cached<{
    price: AnyRecord;
    localization: Record<string, unknown>;
  }>(
    v1CacheKey("offer-details.price", { id, region, locale }),
    DYNAMIC_TTL_SECONDS,
    async () => {
      const detail = await getOffer({ id, country, region, locale });
      if (!detail) {
        throw notFound("OFFER_NOT_FOUND", OFFER_NOT_FOUND_DETAIL);
      }
      if (!offerCountryEligible(detail.offer, country)) {
        throw notFound(
          "PRICE_NOT_FOUND",
          `No ${country} price is available for this offer.`,
        );
      }
      const price = await currentPrice(id, region);
      if (!price) {
        throw notFound(
          "PRICE_NOT_FOUND",
          `No ${country} price is available for this offer.`,
        );
      }
      if (price.price && typeof price.price === "object") {
        price.price.basePayoutPrice = toUsdCents(price.price, "original");
      }
      return { price, localization: detail.localization };
    },
  );

  return jsonSuccess(c, payload.price, {
    country,
    region,
    locale,
    ...payload.localization,
  });
});

app.get("/offers/:id/price-history", async (c) => {
  const id = requireIdParam(c);
  const query = parseStrictQuery(c, {
    ...querySchema.pagination,
    ...querySchema.regional,
    region: z.string().optional(),
    since: z.string().optional(),
  });
  const locale = canonicalLocale(query.locale);
  const since = query.since ? parseIsoTimestamp(query.since, "since") : null;
  const requestedRegion = query.region?.trim() || null;
  const { limit, cursor } = parsePagination(query, 100);

  if (!requestedRegion && !query.country) {
    const grouped = await cached<Record<string, unknown[]>>(
      v1CacheKey("offer-details.price-history.by-region", {
        id,
        since: since?.toISOString() ?? null,
      }),
      DYNAMIC_TTL_SECONDS,
      async () => {
        await requireOffer(id, { id: 1 });
        const rows = (await PriceEngineHistorical.find(
          {
            offerId: id,
            region: { $in: REGION_CODES },
            ...(since ? { updatedAt: { $gte: since } } : {}),
          },
          undefined,
          { sort: { date: -1 } },
        ).lean()) as AnyRecord[];

        const byRegion: Record<string, unknown[]> = {};
        for (const row of rows) {
          if (!row?.region) continue;
          const regionKey = String(row.region);
          const bucket = byRegion[regionKey];
          if (bucket) {
            bucket.push(serializePrice(row));
          } else {
            byRegion[regionKey] = [serializePrice(row)];
          }
        }
        return byRegion;
      },
    );

    return jsonSuccess(c, grouped, {
      region: null,
      locale,
      grouped: true,
      regions: Object.keys(grouped).length,
      since: since?.toISOString() ?? null,
    });
  }

  const region = requestedRegion
    ? canonicalRegion(requestedRegion)
    : countryAndRegion(query.country).region;
  const filters = {
    offerId: id,
    region,
    since: since?.toISOString() ?? null,
  };
  const binding = {
    operation: "offer-details.price-history",
    filters,
    ordering: "date:desc,_id:desc",
    country: region,
    locale,
    limit,
  };

  const page = await cached<{ elements: unknown[]; pagination: PageMeta }>(
    v1CacheKey("offer-details.price-history", {
      id,
      region,
      locale,
      since: filters.since,
      limit,
      cursor,
    }),
    DYNAMIC_TTL_SECONDS,
    async () => {
      await requireOffer(id, { id: 1 });
      const filter: AnyRecord = { offerId: id, region };
      if (since) filter.updatedAt = { $gte: since };
      if (cursor) {
        Object.assign(
          filter,
          keysetFilter(PRICE_HISTORY_SORT, decodeCursor(cursor, binding)),
        );
      }
      const rows = (await PriceEngineHistorical.find(filter, undefined, {
        limit: limit + 1,
        sort: mongoSortSpec(PRICE_HISTORY_SORT),
      }).lean()) as AnyRecord[];
      const { items, hasMore } = trimPage(rows, limit);
      const lastRow = items.at(-1);

      return {
        elements: items.map((row) => serializePrice(row)),
        pagination: pageMeta(
          limit,
          hasMore,
          hasMore && lastRow
            ? encodeCursor(binding, [
                isoOrNull(lastRow.date),
                encodeCursorId(lastRow._id),
              ])
            : null,
        ),
      };
    },
  );

  return jsonSuccess(c, page.elements, {
    region,
    locale,
    since: filters.since,
    pagination: page.pagination,
  });
});

app.get("/offers/:id/price/fairness", async (c) => {
  const id = requireIdParam(c);
  const query = parseStrictQuery(c, { country: z.string().optional() });
  const country = canonicalCountry(query.country);

  const score = await cached(
    v1CacheKey("offer-details.price-fairness", { id, country }),
    SUMMARY_TTL_SECONDS,
    async () => {
      await requireOffer(id, { id: 1 });
      const found = await OfferCountryPricingScore.findOne({
        offerId: id,
        country,
      }).lean();
      if (!found) {
        throw notFound(
          "PRICE_FAIRNESS_NOT_FOUND",
          `No price fairness score is stored for this offer in ${country}.`,
        );
      }
      return serializeValue(found);
    },
  );

  return jsonSuccess(c, score, { country });
});

app.get("/offers/:id/regional-price", async (c) => {
  const id = requireIdParam(c);
  const query = parseStrictQuery(c, { country: z.string().optional() });
  // Validate the requested country before any database access so invalid input
  // always produces a 400 problem rather than a 404 or 500.
  const requested = query.country ? countryAndRegion(query.country) : null;
  const offer = await requireOffer(id);

  if (!requested) {
    const grouped = await cached<Record<string, unknown>>(
      v1CacheKey("offer-details.regional-price.all", {
        id,
        availability: priceAvailabilityKey(offer),
      }),
      DYNAMIC_TTL_SECONDS,
      async () => {
        const livePrices = (await PriceEngine.find({
          offerId: id,
        }).lean()) as AnyRecord[];
        const releaseDate = offer.releaseDate ?? offer.effectiveDate ?? null;
        const priceQuery: AnyRecord = { offerId: id };
        if (releaseDate && new Date(releaseDate) <= new Date()) {
          priceQuery.updatedAt = { $gte: new Date(releaseDate) };
        }
        let history = (await PriceEngineHistorical.find(priceQuery, undefined, {
          sort: { updatedAt: -1 },
        }).lean()) as AnyRecord[];
        if (history.length === 0) {
          history = (await PriceEngineHistorical.find(
            { offerId: id },
            undefined,
            { sort: { updatedAt: -1 } },
          ).lean()) as AnyRecord[];
        }

        const result: Record<string, unknown> = {};
        for (const regionCode of REGION_CODES) {
          if (!isPriceRegionEligible(offer, regionCode)) continue;
          const regionHistory = history.filter(
            (row) => row.region === regionCode,
          );
          const livePrice =
            livePrices.find((row) => row.region === regionCode) ?? null;
          if (regionHistory.length === 0 && !livePrice) continue;
          const lastPrice =
            livePrice ??
            regionHistory.sort(
              (left, right) =>
                new Date(right.updatedAt).getTime() -
                new Date(left.updatedAt).getTime(),
            )[0];
          if (!lastPrice) continue;

          normalizeBasePayoutPrice(lastPrice);
          const usdValues = regionHistory
            .map((row) => toUsdCents(row.price))
            .filter((value): value is number => value != null);
          if (livePrice?.price) {
            const liveUsd = toUsdCents(livePrice.price);
            if (liveUsd !== null) usdValues.unshift(liveUsd);
          }
          const discountPrices = [
            ...regionHistory.map((row) => row.price?.discountPrice ?? 0),
            lastPrice.price?.discountPrice ?? 0,
          ];

          result[regionCode] = {
            currentPrice: serializePrice(lastPrice),
            maxPrice: Math.max(...discountPrices),
            minPrice: Math.min(...discountPrices),
            currentPriceUsd: toUsdCents(lastPrice.price),
            currentOriginalPriceUsd: toUsdCents(lastPrice.price, "original"),
            maxPriceUsd: usdValues.length > 0 ? Math.max(...usdValues) : null,
            minPriceUsd: usdValues.length > 0 ? Math.min(...usdValues) : null,
          };
        }
        return result;
      },
    );

    return jsonSuccess(c, grouped, {
      country: null,
      region: null,
      grouped: true,
      regions: Object.keys(grouped).length,
    });
  }

  const { country, region } = requested;
  if (!isPriceCountryEligible(offer, country)) {
    throw notFound(
      "PRICE_NOT_FOUND",
      `No ${country} price is available for this offer.`,
    );
  }

  const data = await cached(
    v1CacheKey("offer-details.regional-price", {
      id,
      region,
      availability: priceAvailabilityKey(offer),
    }),
    DYNAMIC_TTL_SECONDS,
    async () => {
      const livePrice = await loadPrice(id, region);
      const releaseDate = offer.releaseDate ?? offer.effectiveDate ?? null;
      const currentDate = new Date();
      const priceQuery: AnyRecord = { offerId: id, region };
      if (releaseDate && new Date(releaseDate) <= currentDate) {
        priceQuery.updatedAt = {
          $gte: new Date(releaseDate),
          $lte: currentDate,
        };
      }
      let history = (await PriceEngineHistorical.find(priceQuery, undefined, {
        sort: { updatedAt: -1 },
      }).lean()) as AnyRecord[];
      if (history.length === 0) {
        history = (await PriceEngineHistorical.find(
          { offerId: id, region },
          undefined,
          { sort: { updatedAt: -1 } },
        ).lean()) as AnyRecord[];
        if (history.length === 0 && !livePrice) {
          throw notFound(
            "PRICE_NOT_FOUND",
            `No ${country} price is available for this offer.`,
          );
        }
      }

      const current = livePrice ?? history[0];
      if (!current) {
        throw notFound(
          "PRICE_NOT_FOUND",
          `No ${country} price is available for this offer.`,
        );
      }
      normalizeBasePayoutPrice(current);

      const usdValues = history
        .map((row) => toUsdCents(row.price))
        .filter((value): value is number => value != null);
      if (livePrice?.price) {
        const liveUsd = toUsdCents(livePrice.price);
        if (liveUsd !== null) usdValues.unshift(liveUsd);
      }
      const discountPrices = [
        ...history.map((row) => row.price?.discountPrice ?? 0),
        current.price?.discountPrice ?? 0,
      ];

      return {
        currentPrice: serializePrice(current),
        maxPrice: Math.max(...discountPrices),
        minPrice: Math.min(...discountPrices),
        currentPriceUsd: toUsdCents(current.price),
        currentOriginalPriceUsd: toUsdCents(current.price, "original"),
        maxPriceUsd: usdValues.length > 0 ? Math.max(...usdValues) : null,
        minPriceUsd: usdValues.length > 0 ? Math.min(...usdValues) : null,
      };
    },
  );

  return jsonSuccess(c, data, { country, region });
});

app.get("/offers/:id/price-stats", async (c) => {
  const id = requireIdParam(c);
  const query = parseStrictQuery(c, { ...querySchema.regional });
  const { country, region, locale } = regionalParams(query);

  const data = await cached(
    v1CacheKey("offer-details.price-stats", { id, region }),
    DYNAMIC_TTL_SECONDS,
    async () => {
      const offer = await requireOffer(id, {
        countriesWhitelist: 1,
        countriesBlacklist: 1,
      });
      const [current, lowest, lastDiscount] = await Promise.all([
        loadPrice(id, region),
        PriceEngineHistorical.findOne(
          {
            offerId: id,
            region,
            "price.discount": { $gt: 0 },
          },
          undefined,
          { sort: { "price.discountPrice": 1 } },
        ).lean(),
        PriceEngineHistorical.findOne(
          {
            offerId: id,
            region,
            "price.discount": { $gt: 0 },
          },
          undefined,
          { sort: { updatedAt: -1 } },
        ).lean(),
      ]);

      const normalize = (price: AnyRecord | null) => {
        normalizeBasePayoutPrice(price);
        return serializePrice(price);
      };

      return {
        current: isPriceCountryEligible(offer, country)
          ? normalize(current)
          : null,
        lowest: normalize(lowest as AnyRecord | null),
        lastDiscount: normalize(lastDiscount as AnyRecord | null),
      };
    },
  );

  return jsonSuccess(c, data, { country, region, locale });
});

app.get("/offers/:id/requirements", async (c) => {
  const id = requireIdParam(c);

  const data = await cached(
    v1CacheKey("offer-details.requirements", { id }),
    STABLE_TTL_SECONDS,
    async () => {
      const offer = await requireOffer(id, { namespace: 1 });
      const [windows, macos] = await Promise.all([
        resolveOfferRequirements(offer.namespace, id, "windows"),
        resolveOfferRequirements(offer.namespace, id, "macos"),
      ]);
      if (!windows && !macos) {
        throw notFound(
          "REQUIREMENTS_NOT_FOUND",
          "No system requirements are stored for this offer.",
        );
      }
      return {
        windows: windows ? serializeValue(windows) : null,
        macos: macos ? serializeValue(macos) : null,
      };
    },
  );

  return jsonSuccess(c, data);
});

app.get("/offers/:id/reviews", async (c) => {
  const id = requireIdParam(c);
  const query = parseStrictQuery(c, {
    ...querySchema.pagination,
    verified: z.string().optional(),
  });
  const verified = parseBoolean(query.verified, "verified");
  const { limit, cursor } = parsePagination(query, 25);
  const filters = { offerId: id, verified: verified ?? null };
  const binding = {
    operation: "offer-details.reviews",
    filters,
    ordering: "createdAt:desc,_id:desc",
    country: "US",
    locale: "en-US",
    limit,
  };

  const page = await cached<{ elements: unknown[]; pagination: PageMeta }>(
    v1CacheKey("offer-details.reviews", {
      id,
      verified: verified ?? null,
      limit,
      cursor,
    }),
    DYNAMIC_TTL_SECONDS,
    async () => {
      const filter: AnyRecord = { id };
      if (verified !== undefined) filter.verified = verified;
      if (cursor) {
        Object.assign(
          filter,
          keysetFilter(REVIEW_SORT, decodeCursor(cursor, binding)),
        );
      }
      const rows = (await Review.find(filter, undefined, {
        limit: limit + 1,
        sort: mongoSortSpec(REVIEW_SORT),
      }).lean()) as AnyRecord[];
      const { items, hasMore } = trimPage(rows, limit);

      const userIds = Array.from(
        new Set(
          items
            .map((review) => String(review.userId ?? ""))
            .filter((userId) => userId.length > 0),
        ),
      );
      const users =
        userIds.length > 0
          ? ((await db.db
              .collection("epic")
              .find({ accountId: { $in: userIds } })
              .toArray()) as AnyRecord[])
          : [];
      const userByAccountId = new Map(
        users.map((user) => [String(user.accountId), user]),
      );
      const lastRow = items.at(-1);

      return {
        elements: items.map((review) => ({
          ...(serializeValue(review) as AnyRecord),
          user: userByAccountId.has(String(review.userId))
            ? serializeValue(userByAccountId.get(String(review.userId)))
            : null,
        })),
        pagination: pageMeta(
          limit,
          hasMore,
          hasMore && lastRow
            ? encodeCursor(binding, [
                isoOrNull(lastRow.createdAt),
                encodeCursorId(lastRow._id),
              ])
            : null,
        ),
      };
    },
  );

  return jsonSuccess(c, page.elements, {
    ...(verified !== undefined ? { verified } : {}),
    pagination: page.pagination,
  });
});

app.get("/offers/:id/reviews-summary", async (c) => {
  const id = requireIdParam(c);
  const query = parseStrictQuery(c, { verified: z.string().optional() });
  const verified = parseBoolean(query.verified, "verified");

  const summary = await cached(
    v1CacheKey("offer-details.reviews-summary", {
      id,
      verified: verified ?? null,
    }),
    SUMMARY_TTL_SECONDS,
    async () => {
      const match: AnyRecord = { id };
      if (verified !== undefined) match.verified = verified;
      const rows = (await Review.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            averageRating: { $avg: "$rating" },
            recommended: {
              $sum: { $cond: ["$recommended", 1, 0] },
            },
          },
        },
      ])) as unknown as AnyRecord[];
      const stats = rows[0];
      const totalReviews = Number(stats?.total ?? 0);
      const recommended = Number(stats?.recommended ?? 0);
      return {
        overallScore: totalReviews > 0 ? Number(stats?.averageRating ?? 0) : 0,
        recommendedPercentage:
          totalReviews > 0 ? recommended / totalReviews : 0,
        notRecommendedPercentage:
          totalReviews > 0 ? (totalReviews - recommended) / totalReviews : 0,
        totalReviews,
      };
    },
  );

  return jsonSuccess(c, summary, {
    ...(verified !== undefined ? { verified } : {}),
  });
});

app.onError((error, c) => {
  if (error instanceof ProblemError) return problemResponse(c, error);
  throw error;
});

export default app;
