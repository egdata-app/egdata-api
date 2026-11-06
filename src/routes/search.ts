import { createHash } from "node:crypto";
import type { Types } from "@opensearch-project/opensearch";
import { type Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { type Document, type Filter, ObjectId } from "mongodb";
import { z } from "zod";
import { opensearch } from "../clients/opensearch.js";
import sharedRedis from "../clients/redis.js";
import client from "../clients/response-cache.js";
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
import { searchAbuseResource } from "../services/abuse-search.js";
import { regions } from "../utils/countries.js";
import { consola } from "../utils/logger.js";
import { toOfferCards, wantsExpandedOffers } from "../utils/offer-card.js";
import {
  getLocaleOrErrorResponse,
  getLocalizedCacheTtlSeconds,
  localeCacheSegment,
  localizeOffers,
} from "../utils/offer-localization.js";
import { orderOffersObject } from "../utils/order-offers-object.js";

type AggregationContainer = Types.Common_Aggregations.AggregationContainer;
type PipelineStage = Record<string, unknown>;

const TECHNOLOGY_FIELD = "lastBuilds.technologies.technology.keyword";

type FacetMode = "minimal" | "full" | "none";

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
    | "priceUpdatedAt"
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
  facets?: FacetMode;
}

interface SearchV2Body extends SearchBody {
  technologies?: string[];
}

const SEARCH_CACHE_HEADERS = {
  "Cache-Control":
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  "CDN-Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
} as const;

const LEGACY_SEARCH_ERROR = {
  error: {
    code: "DEPRECATED",
    message: "Use /search/v2/search instead.",
  },
} as const;

const deprecatedSearchResponse = (c: Context) =>
  c.json(LEGACY_SEARCH_ERROR, 410, { "Cache-Control": "no-store" });

const normalizeFacetMode = (value: unknown): FacetMode =>
  value === "minimal" || value === "none" ? value : "full";

const buildSearchAggregations = (
  facets: FacetMode,
  region: string,
): Record<string, AggregationContainer> | undefined => {
  if (facets === "none") {
    return undefined;
  }

  const aggregations: Record<string, AggregationContainer> = {
    offerType: { terms: { field: "offerType.keyword", size: 100 } },
    technologies: { terms: { field: TECHNOLOGY_FIELD, size: 1000 } },
    price_stats: { stats: { field: `prices.${region}.price.discountPrice` } },
  };

  if (facets === "full") {
    aggregations.technologies = {
      terms: { field: TECHNOLOGY_FIELD, size: 10_000 },
    };
    aggregations.tags = { terms: { field: "tags.name.keyword", size: 10_000 } };
    aggregations.developer = {
      terms: { field: "developerDisplayName.keyword", size: 1000 },
    };
    aggregations.publisher = {
      terms: { field: "publisherDisplayName.keyword", size: 1000 },
    };
    aggregations.seller = {
      terms: { field: "seller.name.keyword", size: 1000 },
    };
  }

  return aggregations;
};

const parseBooleanQueryParam = (value: string | undefined) => {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }

  return undefined;
};

const parseNumberQueryParam = (value: string | undefined) => {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const parseCsvQueryParam = (value: string | undefined) => {
  if (value === undefined) {
    return undefined;
  }

  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return items.length > 0 ? items : undefined;
};

const parseSearchV2Query = (c: Context): SearchV2Body => {
  const params = c.req.query();
  const price: { min?: number; max?: number } = {};
  const priceMin = parseNumberQueryParam(params.priceMin);
  const priceMax = parseNumberQueryParam(params.priceMax);

  if (priceMin !== undefined) {
    price.min = priceMin;
  }
  if (priceMax !== undefined) {
    price.max = priceMax;
  }

  return {
    title: params.title,
    offerType: params.offerType as SearchBody["offerType"],
    tags: parseCsvQueryParam(params.tags),
    categories: parseCsvQueryParam(params.categories),
    customAttributes: parseCsvQueryParam(params.customAttributes),
    seller: params.seller,
    developerDisplayName: params.developerDisplayName,
    publisherDisplayName: params.publisherDisplayName,
    refundType: params.refundType,
    isCodeRedemptionOnly: parseBooleanQueryParam(params.isCodeRedemptionOnly),
    excludeBlockchain: parseBooleanQueryParam(params.excludeBlockchain),
    onSale: parseBooleanQueryParam(params.onSale),
    pastGiveaways: parseBooleanQueryParam(params.pastGiveaways),
    isLowestPrice: parseBooleanQueryParam(params.isLowestPrice),
    isLowestPriceEver: parseBooleanQueryParam(params.isLowestPriceEver),
    sortBy: params.sortBy as SearchBody["sortBy"],
    sortDir: params.sortDir as SearchBody["sortDir"],
    limit: parseNumberQueryParam(params.limit),
    page: parseNumberQueryParam(params.page),
    facets: normalizeFacetMode(params.facets),
    technologies: parseCsvQueryParam(params.technologies),
    ...(Object.keys(price).length > 0 ? { price } : {}),
  };
};

const naturalLanguageSearchBodySchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    topK: z.number().int().min(1).max(50).optional(),
  })
  .strict();

const technologyFilterSchema = z
  .array(z.string().trim().min(1))
  .transform((technologies) => Array.from(new Set(technologies)))
  .optional();

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

const app = new Hono();

app.get("/", (c) => deprecatedSearchResponse(c));

app.post("/", (c) => deprecatedSearchResponse(c));

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

  const mongoFilter: Record<string, unknown> = {
    "metadata.contextType": { $nin: ["file", "achievements"] },
  };

  if (id) {
    mongoFilter["metadata.contextId"] = id;
  }

  if (type) {
    mongoFilter["metadata.contextType"] = {
      $eq: type,
      $nin: ["file", "achievements"],
    };
  }

  // OpenSearch is asynchronous and can lag behind newly recorded changes. Use
  // MongoDB as the source of truth for the recent-changes view (no text query).
  if (!query?.trim()) {
    const startedAt = performance.now();
    const [mongoHits, estimatedTotalHits] = await Promise.all([
      Changelog.find(mongoFilter, undefined, {
        sort: { timestamp: -1 },
        skip: (page - 1) * limit,
        limit,
      }),
      Changelog.countDocuments(mongoFilter),
    ]);

    const hits = mongoHits.map((hit) => ({
      ...hit.toObject(),
      _id: String(hit._id),
    })) as ChangelogSearchHit[];

    await enrichChangelogSearchDocuments(hits);

    return c.json(
      {
        hits,
        estimatedTotalHits,
        processingTimeMs: Math.round(performance.now() - startedAt),
        query: "",
      },
      200,
      {
        "Cache-Control": debug ? "no-store" : "public, max-age=60",
      },
    );
  }

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
    const fallbackMongoFilter: Record<string, unknown> = {
      ...mongoFilter,
      "metadata.contextId": { $in: relatedContextIds },
    };

    if (id) {
      fallbackMongoFilter["metadata.contextId"] = id;
    }

    const [fallbackHits, fallbackTotal] = await Promise.all([
      Changelog.find(fallbackMongoFilter, undefined, {
        sort: { timestamp: -1 },
        skip: (page - 1) * limit,
        limit,
      }),
      Changelog.countDocuments(fallbackMongoFilter),
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
        (metadataOfferId ? offersByLookupId.get(metadataOfferId) : undefined) ??
        offersByLookupId.get(match.id);

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

const runSearchV2 = async (c: Context, body: unknown) => {
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

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ message: "Invalid body" }, 400);
  }

  const rawBody = body as Record<string, unknown>;
  const parsedTechnologies = technologyFilterSchema.safeParse(
    rawBody.technologies,
  );
  if (!parsedTechnologies.success) {
    return c.json(
      {
        message:
          "Invalid technologies. Provide an array of non-empty technology names.",
      },
      400,
    );
  }

  const facets = normalizeFacetMode(rawBody.facets);
  const expand = wantsExpandedOffers(c);
  const q: SearchV2Body = {
    ...(rawBody as SearchV2Body),
    technologies: parsedTechnologies.data,
    facets,
  };

  const limit = Math.min(q.limit ?? 10, 100);
  const page = Math.max(q.page ?? 1, 1);
  const from = (page - 1) * limit;
  const recordAbuse = c.get("antiAbuseCatalog");
  if (recordAbuse) {
    const resource = searchAbuseResource(q, page, limit, region, locale);
    if (resource) recordAbuse(resource);
  }

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
  if (q.technologies?.length) {
    filter.push({
      terms_set: {
        [TECHNOLOGY_FIELD]: {
          terms: q.technologies,
          minimum_should_match_script: {
            source: q.technologies.length.toString(),
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
      case "priceUpdatedAt":
        sort.push({ [`prices.${region}.updatedAt`]: { order: dir } });
        break;
      case "upcoming":
        // Release date that is in the future (inverted direction, asc = desc, desc = asc)
        sort.push({ releaseDate: { order: dir === "asc" ? "desc" : "asc" } });
        filter.push({
          range: {
            releaseDate: {
              gte: "now",
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
                lte: "now",
              },
            },
          });
        } else {
          filter.push({
            range: {
              releaseDate: {
                gte: "now",
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

  const aggregations = buildSearchAggregations(facets, region);

  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        region,
        facets,
        expand,
        must,
        filter,
        sort,
        aggregations: aggregations ?? null,
        page,
        limit,
      }),
    )
    .digest("hex");

  const cacheKey = `search:v2:${hash}:${localeCacheSegment(locale)}`;

  const cached = await client.get(cacheKey);

  if (cached) {
    const result = JSON.parse(cached);
    result.meta.cached = true;
    return c.json(result, 200, SEARCH_CACHE_HEADERS);
  }

  consola.debug("OpenSearch query", { must, filter, sort, aggregations });

  const osResponse = await opensearch.search({
    index: "egdata.offers",
    body: {
      from,
      size: limit,
      query: { bool: { must, filter } },
      sort,
      ...(aggregations ? { aggregations } : {}),
    },
  });

  const hits = osResponse.body.hits.hits;
  const total =
    typeof osResponse.body.hits.total === "number"
      ? osResponse.body.hits.total
      : osResponse.body.hits.total?.value;

  const offerDocs: OfferType[] = [];
  const priceByOfferId = new Map<string, PriceEngineType | null>();

  for (const hit of hits) {
    const doc = hit._source as OfferType & {
      prices?: Record<string, PriceEngineType>;
    };
    priceByOfferId.set(doc.id, doc.prices?.[region] ?? null);
    delete doc.prices;
    offerDocs.push(doc);
  }

  const offers = expand
    ? await localizeOffers(
        offerDocs.map((doc) => ({
          ...orderOffersObject(doc),
          price: priceByOfferId.get(doc.id) ?? null,
        })),
        locale,
      )
    : await toOfferCards(offerDocs, locale, priceByOfferId);

  const responseAggregations: Record<string, unknown> = {};
  if (aggregations) {
    const osAggregations = osResponse.body.aggregations ?? {};
    for (const key of Object.keys(aggregations)) {
      if (osAggregations[key] !== undefined) {
        responseAggregations[key] = osAggregations[key];
      }
    }
  }

  const result = {
    total,
    offers,
    page,
    limit,
    aggregations: responseAggregations,
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

  return c.json(result, 200, SEARCH_CACHE_HEADERS);
};

app.post("/v2/search", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) {
    return c.json({ message: "Invalid body" }, 400);
  }

  return runSearchV2(c, body);
});

app.get("/v2/search", (c) => runSearchV2(c, parseSearchV2Query(c)));

app.get("/:id", async (c) => {
  const { id } = c.req.param();

  const queryKey = `q:${id}`;

  const cachedQuery = await sharedRedis.get(queryKey);

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

  const cachedQuery = await sharedRedis.get(queryKey);

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
