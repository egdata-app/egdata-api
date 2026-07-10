import { createHash } from "node:crypto";
import type { Types } from "@opensearch-project/opensearch";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { type Document, type Filter, ObjectId } from "mongodb";
import { z } from "zod";
import { opensearch } from "../clients/opensearch.js";
import client from "../clients/redis.js";
import {
  CloudflareVectorizeError,
  queryOffersWithNaturalLanguage,
  VectorizeConfigurationError,
} from "../clients/vectorize.js";
import { db } from "../db/index.js";
import {
  Asset,
  Changelog,
  type ChangelogType,
  Item,
  Offer,
  type OfferType,
  type PriceEngineType,
  Tags,
} from "../models/index.js";
import { regions } from "../utils/countries.js";
import { consola } from "../utils/logger.js";
import {
  getLocaleOrErrorResponse,
  getLocalizedCacheTtlSeconds,
  localeCacheSegment,
  localizeOffers,
} from "../utils/offer-localization.js";
import { orderOffersObject } from "../utils/order-offers-object.js";

type AggregationContainer = Types.Common_Aggregations.AggregationContainer;
type PipelineStage = Record<string, unknown>;

interface SearchBody {
  title?: string;
  offerType?:
    | "IN_GAME_PURCHASE"
    | "BASE_GAME"
    | "EXPERIENCE"
    | "UNLOCKABLE"
    | "ADD_ON"
    | "Bundle"
    | "CONSUMABLE"
    | "WALLET"
    | "OTHERS"
    | "DEMO"
    | "DLC"
    | "VIRTUAL_CURRENCY"
    | "BUNDLE"
    | "DIGITAL_EXTRA"
    | "EDITION";
  tags?: string[];
  customAttributes?: string[];
  seller?: string;
  sortBy?:
    | "releaseDate"
    | "lastModifiedDate"
    | "effectiveDate"
    | "creationDate"
    | "viewableDate"
    | "pcReleaseDate"
    | "upcoming"
    | "priceAsc"
    | "priceDesc"
    | "price"
    | "discount"
    | "discountPercent"
    | "giveawayDate";
  sortDir?: "asc" | "desc";
  limit?: number;
  page?: number;
  refundType?: string;
  isCodeRedemptionOnly?: boolean;
  price?: {
    min?: number;
    max?: number;
  };
  onSale?: boolean;
  categories?: string[];
  developerDisplayName?: string;
  publisherDisplayName?: string;
  spt?: boolean;
  excludeBlockchain?: boolean;
  pastGiveaways?: boolean;
  isLowestPrice?: boolean;
  isLowestPriceEver?: boolean;
}

const naturalLanguageSearchBodySchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    topK: z.number().int().min(1).max(50).optional(),
  })
  .strict();

interface MongoQuery {
  $text?: {
    $search: string;
    $language: string;
  };
  offerType?: string;
  "tags.id"?: { $all: string[] } | { $ne: string };
  customAttributes?: {
    $elemMatch: { id: { $in: string[] } };
  };
  categories?: { $all: string[] };
  $or?: Array<{ "seller.name": string } | { "seller.id": string }>;
  refundType?: string;
  isCodeRedemptionOnly?: boolean;
  developerDisplayName?: string;
  publisherDisplayName?: string;
  "keyImages.url"?: { $regex: RegExp };
  namespace?: { $ne: string };
  [key: string]: any;
}

interface PriceQuery {
  "price.discountPrice"?: {
    $gte?: number;
    $lte?: number;
  };
  "price.discount"?: { $gt: number };
}

type ChangelogChange = Record<string, unknown> & {
  oldValue?: unknown;
  newValue?: unknown;
  oldValueRaw?: unknown;
  newValueRaw?: unknown;
};

type ChangelogSearchHit = ChangelogType & {
  _id: string;
  document?: unknown;
  metadata?: Record<string, unknown> & {
    contextType?: string;
    contextId?: string;
    changes?: ChangelogChange[];
  };
};

const hasOwn = (value: object, key: string) => Object.hasOwn(value, key);

const parseChangelogRawValue = (rawValue: unknown) => {
  if (rawValue === null || rawValue === undefined) {
    return null;
  }

  if (typeof rawValue !== "string") {
    return rawValue;
  }

  try {
    return JSON.parse(rawValue);
  } catch {
    return rawValue;
  }
};

const normalizeChangelogValue = (currentValue: unknown, rawValue: unknown) => {
  if (currentValue !== null && currentValue !== undefined) {
    return currentValue;
  }

  return parseChangelogRawValue(rawValue);
};

const toPlainChangelog = (
  document: ChangelogType & { toObject?: () => ChangelogType },
) => {
  if (typeof document.toObject === "function") {
    return document.toObject();
  }

  return document;
};

const toMongoIdCandidates = (ids: string[]) => [
  ...ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id)),
  ...ids,
];

const hydrateChangelogValues = async (hits: ChangelogSearchHit[]) => {
  if (hits.length === 0) {
    return hits;
  }

  const ids = Array.from(new Set(hits.map((hit) => hit._id).filter(Boolean)));
  let mongoChangesById = new Map<string, ChangelogType>();

  if (ids.length > 0) {
    try {
      const mongoChanges = await Changelog.find({
        _id: { $in: toMongoIdCandidates(ids) },
      });
      mongoChangesById = new Map(
        mongoChanges.map((change) => {
          const plainChange = toPlainChangelog(change);
          return [String(plainChange._id), plainChange];
        }),
      );
    } catch {
      mongoChangesById = new Map();
    }
  }

  for (const hit of hits) {
    const changes = hit.metadata?.changes;
    if (!Array.isArray(changes)) {
      continue;
    }

    const mongoChange = mongoChangesById.get(String(hit._id));
    const mongoChangeItems = Array.isArray(mongoChange?.metadata?.changes)
      ? (mongoChange.metadata.changes as ChangelogChange[])
      : [];

    hit.metadata = {
      ...hit.metadata,
      changes: changes.map((change, index) => {
        const mongoChangeItem = mongoChangeItems[index];
        const hydratedChange = { ...change };

        hydratedChange.oldValue =
          mongoChangeItem && hasOwn(mongoChangeItem, "oldValue")
            ? mongoChangeItem.oldValue
            : normalizeChangelogValue(change.oldValue, change.oldValueRaw);
        hydratedChange.newValue =
          mongoChangeItem && hasOwn(mongoChangeItem, "newValue")
            ? mongoChangeItem.newValue
            : normalizeChangelogValue(change.newValue, change.newValueRaw);

        return hydratedChange;
      }),
    };
  }

  return hits;
};

const resolveChangelogSearchDocument = async (
  contextType?: string,
  contextId?: string,
) => {
  if (!contextType || !contextId) {
    return null;
  }

  if (contextType === "offer") {
    return Offer.findOne({ id: { $eq: contextId } });
  }

  if (contextType === "item") {
    return Item.findOne({ id: { $eq: contextId } });
  }

  if (contextType === "asset") {
    const asset = await Asset.findOne({
      $or: [{ artifactId: { $eq: contextId } }, { id: { $eq: contextId } }],
    });

    if (!asset?.itemId) {
      return null;
    }

    return Item.findOne({
      id: { $eq: asset.itemId },
    });
  }

  if (contextType === "build") {
    const filter = (ObjectId.isValid(contextId)
      ? {
          $or: [{ _id: new ObjectId(contextId) }, { _id: { $eq: contextId } }],
        }
      : { _id: { $eq: contextId } }) as unknown as Filter<Document>;

    return db.db.collection("builds").findOne(filter, {
      projection: {
        _id: 1,
        appName: 1,
        buildVersion: 1,
      },
    });
  }

  return null;
};

const enrichChangelogSearchDocuments = async (hits: ChangelogSearchHit[]) => {
  await Promise.all(
    hits.map(async (hit) => {
      try {
        hit.document = await resolveChangelogSearchDocument(
          hit.metadata?.contextType,
          hit.metadata?.contextId,
        );
      } catch {
        hit.document = null;
      }

      return hit;
    }),
  );

  return hits;
};

function buildBaseQuery(query: SearchBody): MongoQuery {
  const mongoQuery: MongoQuery = {};

  // Always exclude 'ue' namespace
  mongoQuery.namespace = { $ne: "ue" };

  if (query.title) {
    mongoQuery.$text = {
      $search: query.title
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .split(" ")
        .map((q) => `"${q.trim()}"`)
        .join(" | "),
      $language: "en",
    };
  }

  if (query.offerType) {
    mongoQuery.offerType = query.offerType;
  }

  if (query.tags) {
    mongoQuery["tags.id"] = { $all: query.tags };
  }

  if (query.customAttributes) {
    mongoQuery.customAttributes = {
      $elemMatch: { id: { $in: query.customAttributes } },
    };
  }

  if (query.categories) {
    mongoQuery.categories = { $all: query.categories };
  }

  if (query.seller) {
    mongoQuery.$or = [
      { "seller.name": query.seller },
      { "seller.id": query.seller },
    ];
  }

  if (query.refundType) {
    mongoQuery.refundType = query.refundType;
  }

  if (query.isCodeRedemptionOnly !== undefined) {
    mongoQuery.isCodeRedemptionOnly = query.isCodeRedemptionOnly;
  }

  if (query.excludeBlockchain) {
    if (query.tags) {
      mongoQuery["tags.id"] = { $all: query.tags, $ne: "21739" };
    } else {
      mongoQuery["tags.id"] = { $ne: "21739" };
    }
  }

  if (query.developerDisplayName) {
    mongoQuery.developerDisplayName = query.developerDisplayName;
  }

  if (query.publisherDisplayName) {
    mongoQuery.publisherDisplayName = query.publisherDisplayName;
  }

  if (query.spt) {
    mongoQuery["keyImages.url"] = { $regex: /spt/i };
  }

  return mongoQuery;
}

function buildPriceQuery(query: SearchBody): PriceQuery {
  const priceQuery: PriceQuery = {};

  if (query.price) {
    if (query.price.min !== undefined && query.price.min !== null) {
      priceQuery["price.discountPrice"] = {
        $gte: query.price.min,
      };
    }

    if (query.price.max !== undefined && query.price.max !== null) {
      priceQuery["price.discountPrice"] = {
        ...priceQuery["price.discountPrice"],
        $lte: query.price.max,
      };
    }
  }

  if (
    query.onSale ||
    ["discount", "discountPercent"].includes(query.sortBy || "")
  ) {
    priceQuery["price.discount"] = { $gt: 0 };
  }

  return priceQuery;
}

function buildSortParams(
  query: SearchBody,
  sort: string,
  dir: 1 | -1,
): Record<string, 1 | -1 | { $meta: string }> {
  let sortParams: Record<string, 1 | -1 | { $meta: string }> = {};

  if (query.title) {
    sortParams = {
      score: { $meta: "textScore" },
    };
  }

  if (
    ![
      "upcoming",
      "priceAsc",
      "priceDesc",
      "price",
      "discount",
      "discountPercent",
    ].includes(sort)
  ) {
    sortParams[sort] = dir;
  } else if (sort === "upcoming") {
    sortParams = {
      releaseDate: 1,
    };
  } else {
    sortParams = {
      lastModifiedDate: dir,
    };
  }

  return sortParams;
}

const app = new Hono();

app.get("/", (c) => c.json("Hello, World!"));

app.post("/", async (c) => {
  const start = new Date();
  const localeResult = getLocaleOrErrorResponse(c);
  if (localeResult.errorResponse) {
    return localeResult.errorResponse;
  }
  const { locale } = localeResult;

  const country = c.req.query("country");
  const cookieCountry = getCookie(c, "EGDATA_COUNTRY");

  const selectedCountry = country ?? cookieCountry ?? "US";

  const region =
    Object.keys(regions).find((r) =>
      regions[r].countries.includes(selectedCountry),
    ) || "US";

  const body = await c.req.json().catch((err) => {
    c.status(400);
    return null;
  });

  if (!body) {
    return c.json({
      message: "Invalid body",
    });
  }

  const query = body as SearchBody;

  const queryId = createHash("md5")
    .update(
      JSON.stringify({
        ...query,
        page: undefined,
        limit: undefined,
      }),
    )
    .digest("hex");

  const cacheKey = `offers:search:${queryId}:${region}:${query.page}:${query.limit}:${localeCacheSegment(locale)}:v0.1`;

  const cached = await client.get(cacheKey);

  if (cached) {
    consola.debug(`Cache hit for ${cacheKey}`);
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  consola.debug(`Cache miss for ${cacheKey}`);

  const queryCache = `q:${queryId}`;

  const cachedQuery = await client.get(queryCache);

  if (!cachedQuery) {
    consola.debug(`Cache miss for ${queryCache}`);
    await client.set(queryCache, JSON.stringify(query));
  } else {
    consola.debug(`Cache hit for ${queryCache}`);
  }

  const limit = Math.min(query.limit || 10, 50);
  const page = Math.max(query.page || 1, 1);

  const sort = query.sortBy || "lastModifiedDate";
  const sortDir = query.sortDir || "desc";
  const dir: 1 | -1 = sortDir === "asc" ? 1 : -1;

  const mongoQuery = buildBaseQuery(query);
  const priceQuery = buildPriceQuery(query);

  // Add date-based filters
  if (["effectiveDate", "creationDate", "viewableDate"].includes(sort)) {
    mongoQuery[sort] = { $lt: new Date("2090-01-01") };
  }

  if (["releaseDate", "pcReleaseDate"].includes(sort)) {
    mongoQuery[sort] = { $lte: new Date() };
  }

  if (["upcoming"].includes(sort)) {
    mongoQuery["releaseDate"] = {
      $gte: new Date(),
    };
  }

  if (!sort) {
    mongoQuery.lastModifiedDate = { $lt: new Date() };
  }

  let offersPipeline: PipelineStage[] = [];
  let collection = "offers";

  if (
    ["priceAsc", "priceDesc", "price", "discount", "discountPercent"].includes(
      sort,
    )
  ) {
    let priceSortOrder: 1 | -1 =
      sort === "priceAsc" || sort === "priceDesc"
        ? sort === "priceAsc"
          ? 1
          : -1
        : dir;

    const sortKey = () => {
      if (sort === "discountPercent") {
        return "appliedRules.discountSetting.discountPercentage";
      }

      if (sort === "discount") {
        return "price.discount";
      }

      return "price.discountPrice";
    };

    if (sort === "discountPercent") {
      priceSortOrder = priceSortOrder * -1;
    }

    collection = "pricev2";
    offersPipeline = [
      {
        $match: {
          region: region,
          ...priceQuery,
        },
      },
      {
        $sort: {
          [sortKey()]: priceSortOrder,
        },
      },
      {
        $addFields: {
          price: "$$ROOT",
        },
      },
      {
        $lookup: {
          from: "offers",
          localField: "offerId",
          foreignField: "id",
          as: "offerDetails",
        },
      },
      {
        $unwind: "$offerDetails",
      },
      {
        $replaceRoot: {
          newRoot: {
            $mergeObjects: ["$offerDetails", "$$ROOT"],
          },
        },
      },
      {
        $match: mongoQuery,
      },
      ...(query.pastGiveaways
        ? [
            {
              $lookup: {
                from: "freegames",
                localField: "id",
                foreignField: "id",
                as: "freegame",
              },
            },
            {
              $match: {
                freegame: { $ne: [] },
              },
            },
          ]
        : []),
      {
        $skip: (page - 1) * limit,
      },
      {
        $limit: limit,
      },
      {
        $project: {
          discountPrice: 0,
          offerDetails: 0,
          appliedRules: 0,
          region: 0,
          country: 0,
          offerId: 0,
          updatedAt: 0,
          freegame: 0,
        },
      },
    ];
  } else {
    offersPipeline = [
      {
        $match: mongoQuery,
      },
      {
        $sort: {
          ...(query.title ? { score: { $meta: "textScore" } } : {}),
          ...buildSortParams(query, sort, dir),
        },
      },
      {
        $lookup: {
          from: "pricev2",
          localField: "id",
          foreignField: "offerId",
          as: "priceEngine",
          pipeline: [
            {
              $match: {
                region: region,
                ...priceQuery,
              },
            },
          ],
        },
      },
      {
        $addFields: {
          price: { $arrayElemAt: ["$priceEngine", 0] },
        },
      },
      {
        $match: {
          price: { $ne: null },
        },
      },
      ...(query.pastGiveaways
        ? [
            {
              $lookup: {
                from: "freegames",
                localField: "id",
                foreignField: "id",
                as: "freegame",
              },
            },
            {
              $match: {
                freegame: { $ne: [] },
              },
            },
          ]
        : []),
      {
        $project: {
          priceEngine: 0,
          freegame: 0,
        },
      },
      {
        $skip: (page - 1) * limit,
      },
      {
        $limit: limit,
      },
    ];
  }

  const dbColl = db.db.collection(collection);

  const aggregation = dbColl.aggregate(offersPipeline);

  const offersData = await aggregation.toArray();

  const sortedElements = offersData.sort((a, b) => {
    if (query.sortBy === "price" && query.title) {
      if (sortDir === "asc") {
        return a.price.price.discountPrice - b.price.price.discountPrice;
      }
      return b.price.price.discountPrice - a.price.price.discountPrice;
    }

    return 0;
  });

  const result = {
    elements: await localizeOffers(sortedElements, locale),
    page,
    limit,
    query: queryId,
  };

  await client.set(
    cacheKey,
    JSON.stringify(result),
    "EX",
    getLocalizedCacheTtlSeconds(result, 3600),
  );

  return c.json(result, 200, {
    "Server-Timing": `db;dur=${new Date().getTime() - start.getTime()}`,
  });
});

app.get("/tags", async (c) => {
  const tags = await Tags.find({
    status: "ACTIVE",
  });

  return c.json(tags, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/offer-types", async (c) => {
  const types = await Offer.aggregate([
    { $group: { _id: "$offerType", count: { $sum: 1 } } },
  ]);

  return c.json(
    types.filter((t) => t._id),
    200,
    {
      "Cache-Control": "public, max-age=60",
    },
  );
});

app.get("/developers", async (c) => {
  const query = c.req.query("query");

  const pipeline: PipelineStage[] = [
    {
      $group: {
        _id: "$developerDisplayName",
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1 } },
  ];

  if (query) {
    pipeline.unshift({
      $match: {
        developerDisplayName: { $regex: new RegExp(query, "i") },
      },
    });
  }

  const developers = await Offer.aggregate(pipeline);

  return c.json(developers, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/publishers", async (c) => {
  const query = c.req.query("query");

  const pipeline: PipelineStage[] = [
    {
      $group: {
        _id: "$publisherDisplayName",
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1 } },
  ];

  if (query) {
    pipeline.unshift({
      $match: {
        publisherDisplayName: { $regex: new RegExp(query, "i") },
      },
    });
  }

  const publishers = await Offer.aggregate(pipeline);

  return c.json(publishers, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/changelog", async (c) => {
  // Get the search opts (query, page, limit, type)
  const {
    query,
    page: requestedPage,
    limit: requestedLimit,
    type,
    id,
  } = c.req.query();

  // Parse the page and limit
  const page = Math.max(Number.parseInt(requestedPage, 10) || 1, 1);
  const limit = Math.min(Number.parseInt(requestedLimit, 10) || 10, 50);
  const debug = c.req.query("debug") === "1";

  const must: Array<Record<string, unknown>> = [];
  const filter: Array<Record<string, unknown>> = [];
  let relatedContextIds: string[] = [];

  if (query) {
    const [offerMatches, itemMatches] = await Promise.all([
      opensearch.search({
        index: "egdata.offers",
        body: {
          size: 100,
          query: {
            multi_match: {
              query,
              fields: ["title^3", "description", "id"],
            },
          },
        },
      }),
      opensearch.search({
        index: "egdata.items",
        body: {
          size: 100,
          query: {
            multi_match: {
              query,
              fields: ["title^3", "description", "id"],
            },
          },
        },
      }),
    ]);

    relatedContextIds = Array.from(
      new Set([
        ...offerMatches.body.hits.hits
          .map((hit) => (hit._source as { id?: string } | undefined)?.id)
          .filter((id): id is string => Boolean(id)),
        ...itemMatches.body.hits.hits
          .map((hit) => (hit._source as { id?: string } | undefined)?.id)
          .filter((id): id is string => Boolean(id)),
      ]),
    );

    const should: Array<Record<string, unknown>> = [
      {
        query_string: {
          query,
          default_operator: "AND",
        },
      },
    ];

    if (relatedContextIds.length > 0) {
      should.push({
        terms: { "metadata.contextId.keyword": relatedContextIds },
      });
      should.push({ terms: { "metadata.contextId": relatedContextIds } });
    }

    must.push({
      bool: {
        should,
        minimum_should_match: 1,
      },
    });
  }

  if (id) {
    filter.push({ term: { "metadata.contextId.keyword": id } });
  }

  if (type) {
    filter.push({ term: { "metadata.contextType.keyword": type } });
  }

  const mustNot: Array<Record<string, unknown>> = [
    { term: { "metadata.contextType.keyword": "file" } },
    { term: { "metadata.contextType.keyword": "achievements" } },
  ];

  // Build query with match_all fallback when no must clauses
  let queryBody: Record<string, unknown>;
  if (must.length > 0) {
    const boolQuery: Record<string, unknown> = {
      must_not: mustNot,
      must,
    };
    if (filter.length > 0) {
      boolQuery.filter = filter;
    }
    queryBody = { bool: boolQuery };
  } else {
    // No search term - use match_all
    queryBody = {
      bool: {
        must_not: mustNot,
        ...(filter.length > 0 ? { filter } : {}),
      },
    };
  }

  const response = await opensearch.search({
    index: "egdata.changelog",
    body: {
      from: (page - 1) * limit,
      size: limit,
      query: queryBody,
      sort: [{ timestamp: { order: "desc" } }],
    },
  });

  const responseHits = response.body.hits.hits as unknown as Array<{
    _id: string;
    _source?: ChangelogType;
  }>;
  const hits = responseHits.map((hit) => ({
    ...hit._source,
    _id: hit._id,
  })) as ChangelogSearchHit[];

  await hydrateChangelogValues(hits);

  await enrichChangelogSearchDocuments(hits);

  const total = response.body.hits.total;
  const estimatedTotalHits =
    typeof total === "number" ? total : (total?.value ?? 0);

  if (query && estimatedTotalHits === 0 && relatedContextIds.length > 0) {
    const mongoFilter: Record<string, unknown> = {
      "metadata.contextType": { $nin: ["file", "achievements"] },
      "metadata.contextId": { $in: relatedContextIds },
    };

    if (id) {
      mongoFilter["metadata.contextId"] = id;
    }

    if (type) {
      mongoFilter["metadata.contextType"] = type;
    }

    const [fallbackHits, fallbackTotal] = await Promise.all([
      Changelog.find(mongoFilter, undefined, {
        sort: { timestamp: -1 },
        skip: (page - 1) * limit,
        limit,
      }),
      Changelog.countDocuments(mongoFilter),
    ]);

    const fallbackResponseHits = fallbackHits.map((hit) => ({
      ...hit.toObject(),
      _id: String(hit._id),
    })) as ChangelogSearchHit[];

    await enrichChangelogSearchDocuments(fallbackResponseHits);

    return c.json(
      {
        hits: fallbackResponseHits,
        estimatedTotalHits: fallbackTotal,
        processingTimeMs: response.body.took,
        query: query || "",
        ...(debug
          ? {
              debug: {
                usedMongoFallback: true,
                relatedContextIdsCount: relatedContextIds.length,
                relatedContextIdsSample: relatedContextIds.slice(0, 10),
                queryBody,
              },
            }
          : {}),
      },
      200,
      {
        "Cache-Control": debug ? "no-store" : "public, max-age=60",
      },
    );
  }

  const debugInfo = debug
    ? {
        relatedContextIdsCount: relatedContextIds.length,
        relatedContextIdsSample: relatedContextIds.slice(0, 10),
        queryBody,
      }
    : undefined;

  // Return the changelogs with MeiliSearch-compatible format
  return c.json(
    {
      hits,
      estimatedTotalHits,
      processingTimeMs: response.body.took,
      query: query || "",
      ...(debugInfo ? { debug: debugInfo } : {}),
    },
    200,
    {
      "Cache-Control": debug ? "no-store" : "public, max-age=60",
    },
  );
});

app.post("/natural-language", async (c) => {
  const localeResult = getLocaleOrErrorResponse(c);
  if (localeResult.errorResponse) {
    return localeResult.errorResponse;
  }

  const body = await c.req.json().catch(() => null);
  const parsedBody = naturalLanguageSearchBodySchema.safeParse(body);

  if (!parsedBody.success) {
    return c.json(
      {
        message:
          "Invalid body. Provide a query between 1 and 500 characters and an optional topK between 1 and 50.",
      },
      400,
    );
  }

  const { query, topK = 10 } = parsedBody.data;

  try {
    const vectorMatches = await queryOffersWithNaturalLanguage(query, topK);
    const vectorIds = Array.from(
      new Set(
        vectorMatches
          .map((match) => match.id)
          .filter((id) => ObjectId.isValid(id)),
      ),
    );
    const offerIds = Array.from(
      new Set(
        vectorMatches
          .map((match) => match.metadata?.id)
          .filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          ),
      ),
    );
    const lookupFilters = [
      ...(offerIds.length > 0 ? [{ id: { $in: offerIds } }] : []),
      ...(vectorIds.length > 0
        ? [{ _id: { $in: vectorIds.map((id) => new ObjectId(id)) } }]
        : []),
    ];
    const offers =
      lookupFilters.length === 0
        ? []
        : await Offer.find(
            lookupFilters.length === 1
              ? lookupFilters[0]
              : { $or: lookupFilters },
          );
    const offersByLookupId = new Map<string, (typeof offers)[number]>();
    for (const offer of offers) {
      offersByLookupId.set(String(offer._id), offer);
      offersByLookupId.set(offer.id, offer);
    }
    const rankedMatches = vectorMatches.flatMap((match) => {
      const metadataOfferId =
        typeof match.metadata?.id === "string" ? match.metadata.id : undefined;
      const offer =
        (metadataOfferId
          ? offersByLookupId.get(metadataOfferId)
          : undefined) ?? offersByLookupId.get(match.id);

      return offer
        ? [
            {
              score: match.score,
              offer: orderOffersObject(offer),
            },
          ]
        : [];
    });
    const localizedOffers = await localizeOffers(
      rankedMatches.map((match) => match.offer),
      localeResult.locale,
    );

    return c.json(
      {
        query,
        count: rankedMatches.length,
        matches: rankedMatches.map((match, index) => ({
          score: match.score,
          offer: localizedOffers[index],
        })),
      },
      200,
      { "Cache-Control": "no-store" },
    );
  } catch (error) {
    if (error instanceof VectorizeConfigurationError) {
      consola.error("Natural-language offer search is not configured", error);
      return c.json(
        { message: "Natural-language search is not configured" },
        503,
      );
    }

    if (error instanceof CloudflareVectorizeError) {
      consola.error("Cloudflare natural-language offer search failed", error);
      return c.json(
        { message: "Natural-language search is temporarily unavailable" },
        502,
      );
    }

    consola.error("Natural-language offer search failed", error);
    return c.json({ message: "Natural-language search failed" }, 500);
  }
});

app.post("/v2/search", async (c) => {
  const localeResult = getLocaleOrErrorResponse(c);
  if (localeResult.errorResponse) {
    return localeResult.errorResponse;
  }
  const { locale } = localeResult;
  const country = c.req.query("country");
  const cookieCountry = getCookie(c, "EGDATA_COUNTRY");
  const selectedCountry = country ?? cookieCountry ?? "US";
  const region =
    Object.keys(regions).find((r) =>
      regions[r].countries.includes(selectedCountry),
    ) ?? "US";

  const body = await c.req.json().catch(() => null);
  if (!body) {
    return c.json({ message: "Invalid body" }, 400);
  }
  const q = body as SearchBody;

  const limit = Math.min(q.limit ?? 10, 100);
  const page = Math.max(q.page ?? 1, 1);
  const from = (page - 1) * limit;

  const must: Array<Record<string, unknown>> = [];
  const filter: Array<Record<string, unknown>> = [];

  if (q.title) {
    must.push({
      bool: {
        should: [
          // 1. Broad Search: Handles synonyms, typos, and metadata
          {
            multi_match: {
              query: q.title,
              fields: [
                "title^4", // Priority 1: Exact word matches
                "title.synonym^3", // Priority 2: Matches "Civ 6" to "Civilization VI"
                "developerDisplayName^2",
                "publisherDisplayName^2",
                "tags.name",
                "description",
              ],
              type: "best_fields",
              fuzziness: "AUTO",
              operator: "and",
            },
          },
          // 2. Phrase Boost: huge score boost for exact phrasing
          {
            match_phrase: {
              title: {
                query: q.title,
                boost: 10,
                slop: 2,
              },
            },
          },
        ],
        minimum_should_match: 1,
      },
    });
  }
  if (q.offerType) filter.push({ term: { "offerType.keyword": q.offerType } });
  if (q.tags?.length) {
    filter.push({
      terms_set: {
        "tags.id.keyword": {
          terms: q.tags,
          minimum_should_match_script: {
            source: q.tags.length.toString(),
          },
        },
      },
    });
  }
  if (q.categories?.length)
    filter.push({ terms: { "categories.keyword": q.categories } });
  if (q.customAttributes?.length)
    filter.push({ terms: { "customAttributes.keyword": q.customAttributes } });
  if (q.seller) filter.push({ term: { "seller.id.keyword": q.seller } });
  if (q.developerDisplayName)
    filter.push({
      term: { "developerDisplayName.keyword": q.developerDisplayName },
    });
  if (q.publisherDisplayName)
    filter.push({
      term: { "publisherDisplayName.keyword": q.publisherDisplayName },
    });
  if (q.refundType)
    filter.push({ term: { "refundType.keyword": q.refundType } });
  if (q.isCodeRedemptionOnly)
    filter.push({ term: { isCodeRedemptionOnly: true } });
  if (q.excludeBlockchain) {
    filter.push({
      bool: {
        must_not: [{ term: { "customAttributes.isBlockchainUsed": true } }],
      },
    });
  }

  if (q.pastGiveaways) {
    filter.push({ exists: { field: "freeEntries" } });
  }

  if (q.price) {
    const range: { gte?: number; lte?: number } = {};
    if (q.price.min != null) range.gte = q.price.min;
    if (q.price.max != null) range.lte = q.price.max;
    filter.push({ range: { [`prices.${region}.price.discountPrice`]: range } });
  }

  if (q.onSale !== undefined) {
    filter.push({
      range: { [`prices.${region}.price.discount`]: { gt: q.onSale ? 0 : 0 } },
    });
  }

  if (q.isLowestPrice) {
    // Push separate filter clauses to avoid malformed query structure
    filter.push({ term: { isAtLowestPriceUS: true } });
    // Enforce onSale to be true
    if (q.onSale === undefined) {
      filter.push({
        range: { [`prices.${region}.price.discount`]: { gt: 0 } },
      });
    }
  }

  if (q.isLowestPriceEver) {
    filter.push({ term: { isHistoricalLowestEverUS: true } });
    // Enforce onSale to be true
    if (q.onSale === undefined) {
      filter.push({
        range: { [`prices.${region}.price.discount`]: { gt: 0 } },
      });
    }
  }

  const sort: Array<Record<string, { order: "asc" | "desc" }>> = [];
  if (q.sortBy) {
    const dir = q.sortDir ?? "desc";
    switch (q.sortBy) {
      case "priceAsc":
      case "priceDesc":
      case "price": {
        const direction = dir || (q.sortBy === "priceDesc" ? "desc" : "asc");
        sort.push({
          [`prices.${region}.price.discountPrice`]: {
            order: direction,
          },
        });
        break;
      }
      case "discount":
        sort.push({
          [`prices.${region}.price.discount`]: { order: dir },
        });
        break;
      case "discountPercent":
        sort.push({
          [`prices.${region}.appliedRules.discountSetting.discountPercentage`]:
            { order: dir },
        });
        break;
      case "upcoming":
        // Release date that is in the future (inverted direction, asc = desc, desc = asc)
        sort.push({ releaseDate: { order: dir === "asc" ? "desc" : "asc" } });
        filter.push({
          range: {
            releaseDate: {
              gte: new Date().toISOString(),
            },
          },
        });
        break;
      case "giveawayDate":
        sort.push({ "freeEntries.endDate": { order: dir } });
        // Check if freeEntries is an array and has at least one element
        filter.push({
          exists: {
            field: "freeEntries",
          },
        });
        break;
      case "releaseDate": {
        // If the sort by is `releaseDate` and the sortDir is `desc`
        // exclude the offers not released right now
        if (dir === "desc") {
          filter.push({
            range: {
              releaseDate: {
                lte: new Date().toISOString(),
              },
            },
          });
        } else {
          filter.push({
            range: {
              releaseDate: {
                gte: new Date().toISOString(),
              },
            },
          });
        }

        sort.push({ releaseDate: { order: dir } });
        break;
      }
      default:
        sort.push({ [q.sortBy]: { order: dir } });
    }
  } else {
    if (q.title) {
      sort.push({ _score: { order: "desc" } });
    } else {
      sort.push({ lastModifiedDate: { order: "desc" } });
    }
  }

  if (sort.length > 0) {
    // If there is a title query, sort by _score as secondary sort
    if (q.title) {
      sort.push({ _score: { order: "desc" } });
    }
  }

  const aggregations: Record<string, AggregationContainer> = {
    offerType: { terms: { field: "offerType.keyword", size: 100 } },
    tags: { terms: { field: "tags.name.keyword", size: 10_000 } },
    developer: { terms: { field: "developerDisplayName.keyword", size: 1000 } },
    publisher: { terms: { field: "publisherDisplayName.keyword", size: 1000 } },
    seller: { terms: { field: "seller.name.keyword", size: 1000 } },
    price_stats: { stats: { field: `prices.${region}.price.discountPrice` } },
  };

  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        must,
        filter,
        sort,
        aggregations,
      }),
    )
    .digest("hex");

  const cacheKey = `search:v2:${hash}:${localeCacheSegment(locale)}`;

  const cached = false; //await client.get(cacheKey);

  if (cached) {
    const result = JSON.parse(cached);
    result.meta.cached = true;
    return c.json(result, 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  consola.debug("OpenSearch query", { must, filter, sort, aggregations });

  const osResponse = await opensearch.search({
    index: "egdata.offers",
    body: {
      from,
      size: limit,
      query: { bool: { must, filter } },
      sort,
      aggregations,
    },
  });

  const hits = osResponse.body.hits.hits;
  const total =
    typeof osResponse.body.hits.total === "number"
      ? osResponse.body.hits.total
      : osResponse.body.hits.total?.value;

  const offers = await localizeOffers(
    hits.map((hit) => {
      const doc = hit._source as OfferType & {
        prices: Record<string, PriceEngineType> | undefined;
      };
      const regionalPrice: PriceEngineType | null =
        doc.prices?.[region] ?? null;
      doc.prices = undefined;
      return {
        ...orderOffersObject(doc),
        price: regionalPrice,
      };
    }),
    locale,
  );

  const result = {
    total,
    offers,
    page,
    limit,
    aggregations: osResponse.body.aggregations,
    meta: {
      ms: osResponse.body.took,
      timed_out: osResponse.body.timed_out,
      cached: false,
    },
  };

  await client.set(
    cacheKey,
    JSON.stringify(result),
    "EX",
    getLocalizedCacheTtlSeconds(result, 3600),
  );

  return c.json(result, 200, { "Cache-Control": "public, max-age=60" });
});

app.get("/:id", async (c) => {
  const { id } = c.req.param();

  const queryKey = `q:${id}`;

  const cachedQuery = await client.get(queryKey);

  if (!cachedQuery) {
    c.status(404);
    return c.json({
      message: "Query not found",
    });
  }

  return c.json(JSON.parse(cachedQuery));
});

app.get("/:id/count", async (c) => {
  const country = c.req.query("country");
  const cookieCountry = getCookie(c, "EGDATA_COUNTRY");

  const selectedCountry = country ?? cookieCountry ?? "US";

  // Get the region for the selected country
  const region =
    Object.keys(regions).find((r) =>
      regions[r].countries.includes(selectedCountry),
    ) || "US";

  const { id } = c.req.param();

  const queryKey = `q:${id}`;
  const cacheKey = `search:count:${id}:${region}:v0.5`;

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const cachedQuery = await client.get(queryKey);

  if (!cachedQuery) {
    c.status(404);
    return c.json({
      message: "Query not found",
    });
  }

  const query = JSON.parse(cachedQuery);

  const mongoQuery: Record<string, any> = {};
  const priceQuery: Record<string, any> = {};

  // Always exclude 'ue' namespace
  mongoQuery.namespace = { $ne: "ue" };

  // Build queries as before
  if (query.title) {
    mongoQuery.title = { $regex: new RegExp(query.title, "i") };
  }

  if (query.offerType) {
    mongoQuery.offerType = query.offerType;
  }

  if (query.tags) {
    mongoQuery["tags.id"] = { $all: query.tags };
  }

  if (query.customAttributes) {
    mongoQuery.customAttributes = {
      $elemMatch: { id: { $in: query.customAttributes } },
    };
  }

  if (query.categories) {
    mongoQuery["categories"] = { $all: query.categories };
  }

  if (query.seller) {
    mongoQuery["$or"] = [
      { "seller.name": query.seller },
      { "seller.id": query.seller },
    ];
  }

  if (query.developerDisplayName) {
    mongoQuery.developerDisplayName = query.developerDisplayName;
  }

  if (query.publisherDisplayName) {
    mongoQuery.publisherDisplayName = query.publisherDisplayName;
  }

  if (query.refundType) {
    mongoQuery.refundType = query.refundType;
  }

  if (query.isCodeRedemptionOnly !== undefined) {
    mongoQuery.isCodeRedemptionOnly = query.isCodeRedemptionOnly;
  }

  if (query.excludeBlockchain) {
    if (query.tags) {
      mongoQuery["tags.id"].$ne = "21739";
    } else {
      mongoQuery["tags.id"] = { $ne: "21739" };
    }
  }

  if (query.price) {
    if (query.price.min) {
      priceQuery["price.discountPrice"] = {
        $gte: query.price.min,
      };
    }

    if (query.price.max) {
      priceQuery["price.discountPrice"] = {
        ...priceQuery["price.discountPrice"],
        $lte: query.price.max,
      };
    }
  }

  if (query.onSale) {
    priceQuery["price.discount"] = { $gt: 0 };
  }

  try {
    // Combine all aggregations into a single pipeline
    const [mainAggregation] = await Promise.allSettled([
      Offer.aggregate([
        { $match: mongoQuery },
        {
          $lookup: {
            from: "pricev2",
            localField: "id",
            foreignField: "offerId",
            as: "priceEngine",
            pipeline: [
              {
                $match: {
                  region: region,
                  ...priceQuery,
                },
              },
            ],
          },
        },
        {
          $addFields: {
            price: { $arrayElemAt: ["$priceEngine", 0] },
          },
        },
        {
          $match: {
            price: { $ne: null },
          },
        },
        ...(query.pastGiveaways
          ? [
              {
                $lookup: {
                  from: "freegames",
                  localField: "id",
                  foreignField: "id",
                  as: "freegame",
                },
              },
              {
                $match: {
                  freegame: { $ne: [] },
                },
              },
            ]
          : []),
        {
          $facet: {
            // Get total count
            total: [{ $count: "total" }],

            // Get tag counts
            tagCounts: [
              { $unwind: "$tags" },
              { $group: { _id: "$tags.id", count: { $sum: 1 } } },
            ],

            // Get offer type counts
            offerTypeCounts: [
              { $group: { _id: "$offerType", count: { $sum: 1 } } },
            ],

            // Get developer counts
            developer: [
              { $unwind: "$developerDisplayName" },
              { $group: { _id: "$developerDisplayName", count: { $sum: 1 } } },
            ],

            // Get publisher counts
            publisher: [
              { $unwind: "$publisherDisplayName" },
              { $group: { _id: "$publisherDisplayName", count: { $sum: 1 } } },
              { $sort: { count: -1 } },
            ],

            // Get price range
            priceRange: [
              {
                $group: {
                  _id: null,
                  minPrice: { $min: "$price.price.discountPrice" },
                  maxPrice: { $max: "$price.price.discountPrice" },
                  currency: { $first: "$price.price.currencyCode" },
                },
              },
            ],
          },
        },
      ]),
    ]);

    if (mainAggregation.status === "rejected") {
      throw mainAggregation.reason;
    }

    const result = {
      tagCounts: mainAggregation.value[0]?.tagCounts || [],
      offerTypeCounts: mainAggregation.value[0]?.offerTypeCounts || [],
      total: mainAggregation.value[0]?.total[0]?.total || 0,
      developer: mainAggregation.value[0]?.developer || [],
      publisher: mainAggregation.value[0]?.publisher || [],
      priceRange: mainAggregation.value[0]?.priceRange[0] || {
        minPrice: null,
        maxPrice: null,
      },
    };

    // Cache the result for 24 hours
    await client.set(cacheKey, JSON.stringify(result), "EX", 3600);

    return c.json(result, 200, {
      "Cache-Control": "public, max-age=60",
    });
  } catch (err) {
    consola.error("Error in count endpoint:", err);
    c.status(500);
    return c.json({ message: "Error while counting results" });
  }
});

export default app;
