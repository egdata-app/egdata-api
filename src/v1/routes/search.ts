import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { opensearch } from "../../clients/opensearch.js";
import sharedRedis from "../../clients/redis.js";
import {
  CloudflareVectorizeError,
  queryOffersWithNaturalLanguage,
  VectorizeConfigurationError,
} from "../../clients/vectorize.js";
import { Changelog, Offer, TagModel } from "../../models/index.js";
import { localizeOffers } from "../../utils/offer-localization.js";
import { orderOffersObject } from "../../utils/order-offers-object.js";
import { cached, v1CacheKey } from "../cache.js";
import { decodeCursor, encodeCursor } from "../cursor.js";
import { badRequest, notFound, ProblemError } from "../errors.js";
import {
  type MongoSortField,
  mongoKeysetFilter,
  mongoSortSpec,
  parsePagination,
  trimPage,
} from "../pagination.js";
import {
  canonicalCountry,
  canonicalLocale,
  parseBoolean,
  parseCsv,
  parseInteger,
  parseStrictQuery,
  readJsonBody,
  regionalParams,
} from "../query.js";
import type { V1Variables } from "../request-context.js";
import { jsonSuccess } from "../response.js";
import { serializeOffer, serializeValue } from "../serialization.js";

const app = new Hono<{ Variables: V1Variables }>();

// The OpenSearch client exposes overloads for callback and promise styles;
// narrow it to the promise form used by v1.
const searchOpenSearch = (params: Record<string, unknown>): Promise<any> =>
  (
    opensearch.search as unknown as (
      input: Record<string, unknown>,
    ) => Promise<any>
  )(params);

const TECHNOLOGY_FIELD = "lastBuilds.technologies.technology.keyword";

type FacetMode = "minimal" | "full" | "none";

type SearchInput = {
  title?: string;
  offerType?: string;
  tags?: string[];
  categories?: string[];
  customAttributes?: string[];
  technologies?: string[];
  seller?: string;
  developerDisplayName?: string;
  publisherDisplayName?: string;
  refundType?: string;
  isCodeRedemptionOnly?: boolean;
  excludeBlockchain?: boolean;
  onSale?: boolean;
  pastGiveaways?: boolean;
  isLowestPrice?: boolean;
  isLowestPriceEver?: boolean;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  facets: FacetMode;
  limit: number;
  country: string;
  region: string;
  locale: string;
  cursor: string | null;
  price?: { min?: number; max?: number };
};

const SEARCH_SORT_FIELDS = new Set([
  "releaseDate",
  "lastModifiedDate",
  "effectiveDate",
  "creationDate",
  "viewableDate",
  "pcReleaseDate",
  "upcoming",
  "priceAsc",
  "priceDesc",
  "price",
  "discount",
  "discountPercent",
  "priceUpdatedAt",
  "giveawayDate",
]);

const searchShape = {
  title: z.string().max(500).optional(),
  offerType: z.string().max(80).optional(),
  tags: z.string().optional(),
  categories: z.string().optional(),
  customAttributes: z.string().optional(),
  technologies: z.string().optional(),
  seller: z.string().max(200).optional(),
  developerDisplayName: z.string().max(300).optional(),
  publisherDisplayName: z.string().max(300).optional(),
  refundType: z.string().max(80).optional(),
  isCodeRedemptionOnly: z.string().optional(),
  excludeBlockchain: z.string().optional(),
  onSale: z.string().optional(),
  pastGiveaways: z.string().optional(),
  isLowestPrice: z.string().optional(),
  isLowestPriceEver: z.string().optional(),
  priceMin: z.string().optional(),
  priceMax: z.string().optional(),
  sortBy: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
  facets: z.enum(["full", "minimal", "none"]).optional(),
  country: z.string().optional(),
  locale: z.string().optional(),
  limit: z.string().optional(),
  cursor: z.string().optional(),
};

function parseSearchInput(
  c: Parameters<typeof parseStrictQuery>[0],
): SearchInput {
  const query = parseStrictQuery(c, searchShape);
  const { country, region, locale } = regionalParams(query);
  const { limit, cursor } = parsePagination(query);
  const priceMin = parseInteger(query.priceMin, "priceMin", { min: 0 });
  const priceMax = parseInteger(query.priceMax, "priceMax", { min: 0 });
  if (priceMin !== undefined && priceMax !== undefined && priceMin > priceMax) {
    throw badRequest(
      "INVALID_QUERY",
      "`priceMin` cannot be greater than `priceMax`.",
    );
  }
  if (query.sortBy && !SEARCH_SORT_FIELDS.has(query.sortBy)) {
    throw badRequest(
      "INVALID_QUERY",
      `Unsupported \`sortBy\` value '${query.sortBy}'.`,
    );
  }
  return {
    title: query.title?.trim() || undefined,
    offerType: query.offerType?.trim() || undefined,
    tags: parseCsv(query.tags),
    categories: parseCsv(query.categories),
    customAttributes: parseCsv(query.customAttributes),
    technologies: parseCsv(query.technologies),
    seller: query.seller?.trim() || undefined,
    developerDisplayName: query.developerDisplayName?.trim() || undefined,
    publisherDisplayName: query.publisherDisplayName?.trim() || undefined,
    refundType: query.refundType?.trim() || undefined,
    isCodeRedemptionOnly: parseBoolean(
      query.isCodeRedemptionOnly,
      "isCodeRedemptionOnly",
    ),
    excludeBlockchain: parseBoolean(
      query.excludeBlockchain,
      "excludeBlockchain",
    ),
    onSale: parseBoolean(query.onSale, "onSale"),
    pastGiveaways: parseBoolean(query.pastGiveaways, "pastGiveaways"),
    isLowestPrice: parseBoolean(query.isLowestPrice, "isLowestPrice"),
    isLowestPriceEver: parseBoolean(
      query.isLowestPriceEver,
      "isLowestPriceEver",
    ),
    sortBy: query.sortBy,
    sortDir: query.sortDir,
    facets: query.facets ?? "full",
    limit,
    country,
    region,
    locale,
    cursor,
    ...(priceMin !== undefined || priceMax !== undefined
      ? {
          price: {
            ...(priceMin !== undefined ? { min: priceMin } : {}),
            ...(priceMax !== undefined ? { max: priceMax } : {}),
          },
        }
      : {}),
  };
}

function normalizedFilters(input: SearchInput): Record<string, unknown> {
  return {
    title: input.title ?? null,
    offerType: input.offerType ?? null,
    tags: input.tags ?? [],
    categories: input.categories ?? [],
    customAttributes: input.customAttributes ?? [],
    technologies: input.technologies ?? [],
    seller: input.seller ?? null,
    developerDisplayName: input.developerDisplayName ?? null,
    publisherDisplayName: input.publisherDisplayName ?? null,
    refundType: input.refundType ?? null,
    isCodeRedemptionOnly: input.isCodeRedemptionOnly ?? null,
    excludeBlockchain: input.excludeBlockchain ?? null,
    onSale: input.onSale ?? null,
    pastGiveaways: input.pastGiveaways ?? null,
    isLowestPrice: input.isLowestPrice ?? null,
    isLowestPriceEver: input.isLowestPriceEver ?? null,
    price: input.price ?? null,
  };
}

function orderingFor(input: SearchInput): string {
  const dir = input.sortDir ?? "desc";
  if (input.sortBy) return `${input.sortBy}:${dir},id:asc`;
  if (input.title) return "_score:desc,id:asc";
  return "lastModifiedDate:desc,id:asc";
}

function buildQuery(input: SearchInput): {
  must: Array<Record<string, unknown>>;
  filter: Array<Record<string, unknown>>;
} {
  const must: Array<Record<string, unknown>> = [];
  const filter: Array<Record<string, unknown>> = [];

  if (input.title) {
    must.push({
      bool: {
        should: [
          {
            multi_match: {
              query: input.title,
              fields: [
                "title^4",
                "title.synonym^3",
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
          {
            match_phrase: {
              title: { query: input.title, boost: 10, slop: 2 },
            },
          },
        ],
        minimum_should_match: 1,
      },
    });
  }

  if (input.offerType) {
    filter.push({ term: { "offerType.keyword": input.offerType } });
  }
  if (input.tags?.length) {
    filter.push({
      terms_set: {
        "tags.id.keyword": {
          terms: input.tags,
          minimum_should_match_script: {
            source: input.tags.length.toString(),
          },
        },
      },
    });
  }
  if (input.technologies?.length) {
    filter.push({
      terms_set: {
        [TECHNOLOGY_FIELD]: {
          terms: input.technologies,
          minimum_should_match_script: {
            source: input.technologies.length.toString(),
          },
        },
      },
    });
  }
  if (input.categories?.length) {
    filter.push({ terms: { "categories.keyword": input.categories } });
  }
  if (input.customAttributes?.length) {
    filter.push({
      terms: { "customAttributes.keyword": input.customAttributes },
    });
  }
  if (input.seller) {
    filter.push({ term: { "seller.id.keyword": input.seller } });
  }
  if (input.developerDisplayName) {
    filter.push({
      term: { "developerDisplayName.keyword": input.developerDisplayName },
    });
  }
  if (input.publisherDisplayName) {
    filter.push({
      term: { "publisherDisplayName.keyword": input.publisherDisplayName },
    });
  }
  if (input.refundType) {
    filter.push({ term: { "refundType.keyword": input.refundType } });
  }
  if (input.isCodeRedemptionOnly) {
    filter.push({ term: { isCodeRedemptionOnly: true } });
  }
  if (input.excludeBlockchain) {
    filter.push({
      bool: {
        must_not: [{ term: { "customAttributes.isBlockchainUsed": true } }],
      },
    });
  }
  if (input.pastGiveaways) {
    filter.push({ exists: { field: "freeEntries" } });
  }
  if (input.price) {
    const range: Record<string, number> = {};
    if (input.price.min !== undefined) range.gte = input.price.min;
    if (input.price.max !== undefined) range.lte = input.price.max;
    filter.push({
      range: { [`prices.${input.region}.price.discountPrice`]: range },
    });
  }
  if (input.onSale !== undefined) {
    filter.push({
      range: {
        [`prices.${input.region}.price.discount`]: input.onSale
          ? { gt: 0 }
          : { lte: 0 },
      },
    });
  }
  if (input.isLowestPrice) {
    filter.push({ term: { isAtLowestPriceUS: true } });
    if (input.onSale === undefined) {
      filter.push({
        range: { [`prices.${input.region}.price.discount`]: { gt: 0 } },
      });
    }
  }
  if (input.isLowestPriceEver) {
    filter.push({ term: { isHistoricalLowestEverUS: true } });
    if (input.onSale === undefined) {
      filter.push({
        range: { [`prices.${input.region}.price.discount`]: { gt: 0 } },
      });
    }
  }
  if (input.sortBy === "upcoming") {
    filter.push({ range: { releaseDate: { gte: new Date().toISOString() } } });
  }
  if (input.sortBy === "releaseDate") {
    filter.push({
      range: {
        releaseDate:
          (input.sortDir ?? "desc") === "desc"
            ? { lte: new Date().toISOString() }
            : { gte: new Date().toISOString() },
      },
    });
  }
  if (input.sortBy === "giveawayDate") {
    filter.push({ exists: { field: "freeEntries" } });
  }

  return { must, filter };
}

function buildSort(input: SearchInput): Array<Record<string, unknown>> {
  const dir = input.sortDir ?? "desc";
  const sort: Array<Record<string, unknown>> = [];
  const tie = { "id.keyword": { order: "asc", missing: "_last" } };

  if (!input.sortBy) {
    if (input.title) {
      sort.push({ _score: { order: "desc" } });
    } else {
      sort.push({ lastModifiedDate: { order: "desc", missing: "_last" } });
    }
    sort.push(tie);
    return sort;
  }

  switch (input.sortBy) {
    case "priceAsc":
    case "priceDesc":
    case "price": {
      const direction =
        input.sortBy === "priceDesc"
          ? "desc"
          : input.sortBy === "priceAsc"
            ? "asc"
            : dir;
      sort.push({
        [`prices.${input.region}.price.discountPrice`]: {
          order: direction,
          missing: "_last",
        },
      });
      break;
    }
    case "discount":
      sort.push({
        [`prices.${input.region}.price.discount`]: {
          order: dir,
          missing: "_last",
        },
      });
      break;
    case "discountPercent":
      sort.push({
        [`prices.${input.region}.appliedRules.discountSetting.discountPercentage`]:
          {
            order: dir,
            missing: "_last",
          },
      });
      break;
    case "priceUpdatedAt":
      sort.push({
        [`prices.${input.region}.updatedAt`]: {
          order: dir,
          missing: "_last",
        },
      });
      break;
    case "upcoming":
      sort.push({
        releaseDate: {
          order: dir === "asc" ? "desc" : "asc",
          missing: "_last",
        },
      });
      break;
    case "giveawayDate":
      sort.push({
        "freeEntries.endDate": { order: dir, missing: "_last" },
      });
      break;
    default:
      sort.push({ [input.sortBy]: { order: dir, missing: "_last" } });
  }

  if (input.title) sort.push({ _score: { order: "desc" } });
  sort.push(tie);
  return sort;
}

function buildAggregations(
  mode: FacetMode,
  region: string,
): Record<string, unknown> | undefined {
  if (mode === "none") return undefined;
  const aggregations: Record<string, unknown> = {
    offerType: { terms: { field: "offerType.keyword", size: 100 } },
    technologies: {
      terms: {
        field: TECHNOLOGY_FIELD,
        size: mode === "full" ? 10_000 : 1_000,
      },
    },
    priceStats: {
      stats: { field: `prices.${region}.price.discountPrice` },
    },
  };
  if (mode === "full") {
    aggregations.tags = { terms: { field: "tags.name.keyword", size: 10_000 } };
    aggregations.developer = {
      terms: { field: "developerDisplayName.keyword", size: 1_000 },
    };
    aggregations.publisher = {
      terms: { field: "publisherDisplayName.keyword", size: 1_000 },
    };
    aggregations.seller = {
      terms: { field: "seller.name.keyword", size: 1_000 },
    };
  }
  return aggregations;
}

async function runSearch(input: SearchInput) {
  const { must, filter } = buildQuery(input);
  const sort = buildSort(input);
  const binding = {
    operation: "search.offers",
    filters: normalizedFilters(input),
    ordering: orderingFor(input),
    country: input.country,
    locale: input.locale,
    limit: input.limit,
  };
  const aggregations = buildAggregations(input.facets, input.region);
  const cacheKey = v1CacheKey("search.offers", {
    region: input.region,
    locale: input.locale,
    limit: input.limit,
    cursor: input.cursor,
    filters: normalizedFilters(input),
    ordering: binding.ordering,
    facets: input.facets,
  });

  return cached(cacheKey, 60, async () => {
    const searchAfter = input.cursor
      ? decodeCursor(input.cursor, binding)
      : undefined;

    let response: any;
    try {
      response = await searchOpenSearch({
        index: "egdata.offers",
        body: {
          size: input.limit + 1,
          track_total_hits: false,
          query: { bool: { must, filter } },
          sort,
          ...(aggregations ? { aggregations } : {}),
          ...(searchAfter ? { search_after: searchAfter } : {}),
        },
      });
    } catch {
      throw new ProblemError({
        status: 503,
        code: "SEARCH_UNAVAILABLE",
        detail:
          "Offer search is temporarily unavailable. Please retry shortly.",
        headers: { "Retry-After": "1" },
      });
    }

    const hits = (response.body.hits.hits ?? []) as Array<{
      _source?: Record<string, any>;
      sort?: Array<string | number | null>;
    }>;
    const { items, hasMore } = trimPage(hits, input.limit);
    const docs = items.map((hit) => {
      const source = { ...(hit._source ?? {}) };
      const price = source.prices?.[input.region] ?? null;
      delete source.prices;
      return { source, price };
    });
    const localized = await localizeOffers(
      docs.map((doc) => ({
        ...orderOffersObject(doc.source),
        price: doc.price,
      })),
      input.locale,
    );
    const lastHit = items.at(-1);
    const lastSort = lastHit?.sort;
    return {
      offers: localized.map((offer) =>
        serializeOffer(offer, { price: offer.price }),
      ),
      pagination: {
        limit: input.limit,
        hasMore,
        nextCursor:
          hasMore && lastSort
            ? encodeCursor(binding, lastSort as Array<string | number | null>)
            : null,
      },
      facets: serializeValue(response.body.aggregations ?? {}),
      result: {
        tookMs: response.body.took ?? 0,
        timedOut: Boolean(response.body.timed_out),
      },
    };
  });
}

app.get("/search", async (c) => {
  const input = parseSearchInput(c);
  const result = await runSearch(input);
  return jsonSuccess(c, result.offers, {
    country: input.country,
    region: input.region,
    locale: input.locale,
    facets: result.facets,
    result: result.result,
    pagination: result.pagination,
  });
});

const searchRedirectSchema = z
  .object({
    title: z.string().max(500).optional(),
    offerType: z.string().max(80).optional(),
    tags: z.array(z.string().trim().min(1)).max(100).optional(),
    categories: z.array(z.string().trim().min(1)).max(100).optional(),
    customAttributes: z.array(z.string().trim().min(1)).max(100).optional(),
    technologies: z.array(z.string().trim().min(1)).max(100).optional(),
    seller: z.string().max(200).optional(),
    developerDisplayName: z.string().max(300).optional(),
    publisherDisplayName: z.string().max(300).optional(),
    refundType: z.string().max(80).optional(),
    isCodeRedemptionOnly: z.boolean().optional(),
    excludeBlockchain: z.boolean().optional(),
    onSale: z.boolean().optional(),
    pastGiveaways: z.boolean().optional(),
    isLowestPrice: z.boolean().optional(),
    isLowestPriceEver: z.boolean().optional(),
    sortBy: z.string().max(80).optional(),
    sortDir: z.enum(["asc", "desc"]).optional(),
    facets: z.enum(["full", "minimal", "none"]).optional(),
    price: z
      .object({
        min: z.number().int().min(0).optional(),
        max: z.number().int().min(0).optional(),
      })
      .strict()
      .optional(),
    limit: z.number().int().min(1).max(100).optional(),
    country: z.string().optional(),
    locale: z.string().optional(),
  })
  .strict();

app.post("/search", async (c) => {
  const body = await readJsonBody(c);
  const parsed = searchRedirectSchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest(
      "INVALID_BODY",
      "Provide a valid search filter object. Unknown fields and unsupported sorts are rejected.",
    );
  }
  const input = parsed.data;
  if (input.sortBy && !SEARCH_SORT_FIELDS.has(input.sortBy)) {
    throw badRequest(
      "INVALID_BODY",
      `Unsupported \`sortBy\` value '${input.sortBy}'.`,
    );
  }
  if (
    input.price?.min !== undefined &&
    input.price.max !== undefined &&
    input.price.min > input.price.max
  ) {
    throw badRequest("INVALID_BODY", "`price.min` cannot exceed `price.max`.");
  }

  const params = new URLSearchParams();
  const setList = (name: string, values: string[] | undefined) => {
    if (!values?.length) return;
    const deduped = Array.from(new Set(values)).sort();
    if (deduped.some((value) => value.includes(","))) {
      for (const value of deduped) params.append(`${name}[]`, value);
    } else {
      params.set(name, deduped.join(","));
    }
  };
  if (input.title?.trim()) params.set("title", input.title.trim());
  if (input.offerType?.trim()) params.set("offerType", input.offerType.trim());
  setList("tags", input.tags);
  setList("categories", input.categories);
  setList("customAttributes", input.customAttributes);
  setList("technologies", input.technologies);
  if (input.seller?.trim()) params.set("seller", input.seller.trim());
  if (input.developerDisplayName?.trim()) {
    params.set("developerDisplayName", input.developerDisplayName.trim());
  }
  if (input.publisherDisplayName?.trim()) {
    params.set("publisherDisplayName", input.publisherDisplayName.trim());
  }
  if (input.refundType?.trim()) {
    params.set("refundType", input.refundType.trim());
  }
  for (const key of [
    "isCodeRedemptionOnly",
    "excludeBlockchain",
    "onSale",
    "pastGiveaways",
    "isLowestPrice",
    "isLowestPriceEver",
  ] as const) {
    if (input[key] !== undefined) params.set(key, String(input[key]));
  }
  if (input.price?.min !== undefined) {
    params.set("priceMin", String(input.price.min));
  }
  if (input.price?.max !== undefined) {
    params.set("priceMax", String(input.price.max));
  }
  if (input.sortBy) params.set("sortBy", input.sortBy);
  if (input.sortDir) params.set("sortDir", input.sortDir);
  if (input.facets) params.set("facets", input.facets);
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  params.set("country", canonicalCountry(input.country));
  params.set("locale", canonicalLocale(input.locale));
  params.sort();

  c.header("Cache-Control", "no-store");
  const publicBase = (
    process.env.V1_PUBLIC_BASE_URL?.trim() || "https://api.egdata.app/v1"
  ).replace(/\/+$/, "");
  return c.redirect(`${publicBase}/search?${params.toString()}`, 303);
});

app.get("/search/tags", async (c) => {
  const tags = await TagModel.find({ status: "ACTIVE" }).lean();
  return jsonSuccess(
    c,
    tags.map((tag) => serializeValue(tag)),
    {
      count: tags.length,
    },
  );
});

app.get("/search/offer-types", async (c) => {
  const rows = await Offer.aggregate<{
    _id: string | null;
    count: number;
  }>([{ $group: { _id: "$offerType", count: { $sum: 1 } } }]).exec();
  const data = rows
    .filter((row) => row._id)
    .map((row) => ({ offerType: row._id, count: row.count }))
    .sort((a, b) => b.count - a.count);
  return jsonSuccess(c, data, { count: data.length });
});

const facetNameShape = {
  query: z.string().max(200).optional(),
  limit: z.string().optional(),
};

async function listDeveloperOrPublisher(
  c: Parameters<typeof parseStrictQuery>[0],
  field: "developerDisplayName" | "publisherDisplayName",
) {
  const query = parseStrictQuery(c, facetNameShape);
  const limit = Math.min(
    Math.max(Number.parseInt(query.limit || "100", 10) || 100, 1),
    500,
  );
  const pipeline: Record<string, unknown>[] = [
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    { $match: { _id: { $ne: null } } },
    { $sort: { count: -1, _id: 1 } },
    { $limit: limit },
  ];
  if (query.query) {
    pipeline.unshift({
      $match: {
        [field]: {
          $regex: query.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          $options: "i",
        },
      },
    });
  }
  const rows = await Offer.aggregate<{ _id: string; count: number }>(
    pipeline,
  ).exec();
  return jsonSuccess(
    c,
    rows.map((row) => ({ name: row._id, count: row.count })),
    { limit, count: rows.length },
  );
}

app.get("/search/developers", (c) =>
  listDeveloperOrPublisher(c, "developerDisplayName"),
);
app.get("/search/publishers", (c) =>
  listDeveloperOrPublisher(c, "publisherDisplayName"),
);

const CHANGELOG_SORT: MongoSortField[] = [
  { field: "timestamp", direction: -1, nulls: "last" },
  { field: "_id", direction: 1, nulls: "last" },
];

app.get("/search/changelog", async (c) => {
  const query = parseStrictQuery(c, {
    query: z.string().max(500).optional(),
    type: z.string().max(100).optional(),
    id: z.string().max(200).optional(),
    limit: z.string().optional(),
    cursor: z.string().optional(),
  });
  const { limit, cursor } = parsePagination(query, 50);
  const binding = {
    operation: "search.changelog",
    filters: {
      query: query.query ?? null,
      type: query.type ?? null,
      id: query.id ?? null,
    },
    ordering: "timestamp:desc,_id:asc",
    country: "US",
    locale: "en-US",
    limit,
  };

  if (!query.query?.trim()) {
    const page = await cached(
      v1CacheKey("search.changelog", {
        id: query.id ?? null,
        type: query.type ?? null,
        limit,
        cursor,
      }),
      60,
      async () => {
        const last = cursor ? decodeCursor(cursor, binding) : null;
        const filter: Record<string, unknown> = {
          "metadata.contextType": { $nin: ["file", "achievements"] },
        };
        if (query.type) filter["metadata.contextType"] = query.type;
        if (query.id) filter["metadata.contextId"] = query.id;
        if (last) {
          const tuple: Array<string | number | null | Date | ObjectId> = [
            ...last,
          ];
          if (typeof tuple[0] === "string") tuple[0] = new Date(tuple[0]);
          if (typeof tuple[1] === "string" && ObjectId.isValid(tuple[1])) {
            tuple[1] = new ObjectId(tuple[1]);
          }
          Object.assign(
            filter,
            mongoKeysetFilter(
              CHANGELOG_SORT,
              tuple as Array<string | number | null>,
            ),
          );
        }
        const rows = await Changelog.find(filter, undefined, {
          limit: limit + 1,
          sort: mongoSortSpec(CHANGELOG_SORT),
        }).lean();
        const { items, hasMore } = trimPage(rows, limit);
        const lastRow = items.at(-1) as Record<string, any> | undefined;
        return {
          hits: items.map((row) => serializeValue(row)),
          pagination: {
            limit,
            hasMore,
            nextCursor:
              hasMore && lastRow
                ? encodeCursor(binding, [
                    lastRow.timestamp
                      ? new Date(lastRow.timestamp).toISOString()
                      : null,
                    String(lastRow._id),
                  ])
                : null,
          },
        };
      },
    );
    return jsonSuccess(c, page.hits, {
      pagination: page.pagination,
      query: "",
    });
  }

  const searchAfter = cursor ? decodeCursor(cursor, binding) : undefined;
  let response: any;
  try {
    const must: Record<string, unknown>[] = [
      {
        query_string: {
          query: query.query,
          default_operator: "AND",
        },
      },
    ];
    const filter: Record<string, unknown>[] = [
      { term: { "metadata.contextType.keyword": "file" } },
      { term: { "metadata.contextType.keyword": "achievements" } },
    ];
    if (query.type) {
      filter.push({ term: { "metadata.contextType.keyword": query.type } });
    }
    if (query.id) {
      filter.push({ term: { "metadata.contextId.keyword": query.id } });
    }
    response = await searchOpenSearch({
      index: "egdata.changelog",
      body: {
        size: limit + 1,
        track_total_hits: false,
        query: { bool: { must, must_not: filter } },
        sort: [
          { timestamp: { order: "desc", missing: "_last" } },
          { "metadata.contextId.keyword": { order: "asc", missing: "_last" } },
          {
            "metadata.contextType.keyword": { order: "asc", missing: "_last" },
          },
        ],
        ...(searchAfter ? { search_after: searchAfter } : {}),
      },
    });
  } catch {
    throw new ProblemError({
      status: 503,
      code: "SEARCH_UNAVAILABLE",
      detail:
        "Changelog search is temporarily unavailable. Please retry shortly.",
      headers: { "Retry-After": "1" },
    });
  }

  const rawHits = (response.body.hits.hits ?? []) as Array<{
    _id: string;
    _source?: Record<string, unknown>;
    sort?: Array<string | number | null>;
  }>;
  const { items, hasMore } = trimPage(rawHits, limit);
  const lastHit = items.at(-1);
  const lastSort = lastHit?.sort;
  const page = {
    hits: items.map((hit) => ({
      ...(serializeValue(hit._source ?? {}) as Record<string, unknown>),
      _id: hit._id,
    })),
    pagination: {
      limit,
      hasMore,
      nextCursor:
        hasMore && lastSort
          ? encodeCursor(binding, lastSort as Array<string | number | null>)
          : null,
    },
  };
  return jsonSuccess(c, page.hits, {
    pagination: page.pagination,
    query: query.query,
    result: {
      tookMs: response.body.took ?? 0,
      timedOut: Boolean(response.body.timed_out),
    },
  });
});

const naturalLanguageSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    topK: z.number().int().min(1).max(50).optional(),
  })
  .strict();

app.post("/search/natural-language", async (c) => {
  const query = parseStrictQuery(c, { locale: z.string().optional() });
  const { locale } = regionalParams({ locale: query.locale });
  const body = await readJsonBody(c);
  const parsed = naturalLanguageSchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest(
      "INVALID_BODY",
      "Provide a `query` between 1 and 500 characters and an optional `topK` between 1 and 50.",
    );
  }

  const { query: text, topK = 10 } = parsed.data;
  try {
    const vectorMatches = await queryOffersWithNaturalLanguage(text, topK);
    const vectorObjectIds = vectorMatches
      .map((match) => match.id)
      .filter((id) => ObjectId.isValid(id));
    const offerIds = vectorMatches
      .map((match) => match.metadata?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const lookupFilters = [
      ...(offerIds.length > 0 ? [{ id: { $in: offerIds } }] : []),
      ...(vectorObjectIds.length > 0
        ? [{ _id: { $in: vectorObjectIds.map((id) => new ObjectId(id)) } }]
        : []),
    ];
    const offers =
      lookupFilters.length === 0
        ? []
        : await Offer.find(
            lookupFilters.length === 1
              ? lookupFilters[0]
              : { $or: lookupFilters },
          ).lean();
    const byId = new Map<string, Record<string, any>>();
    for (const offer of offers) {
      byId.set(String(offer._id), offer);
      byId.set(String(offer.id), offer);
    }
    const ranked = vectorMatches.flatMap((match) => {
      const metadataId =
        typeof match.metadata?.id === "string" ? match.metadata.id : undefined;
      const offer =
        (metadataId ? byId.get(metadataId) : undefined) ?? byId.get(match.id);
      return offer
        ? [{ score: match.score, offer: orderOffersObject(offer) }]
        : [];
    });
    const localized = await localizeOffers(
      ranked.map((entry) => entry.offer),
      locale,
    );
    const matches = ranked.map((entry, index) => ({
      score: entry.score,
      offer: serializeOffer(localized[index]),
    }));
    return jsonSuccess(c, matches, {
      query: text,
      count: matches.length,
      locale,
    });
  } catch (error) {
    if (error instanceof VectorizeConfigurationError) {
      throw new ProblemError({
        status: 503,
        code: "NATURAL_LANGUAGE_SEARCH_NOT_CONFIGURED",
        detail: "Natural-language search is not configured.",
      });
    }
    if (error instanceof CloudflareVectorizeError) {
      throw new ProblemError({
        status: 502,
        code: "NATURAL_LANGUAGE_SEARCH_UNAVAILABLE",
        detail: "Natural-language search is temporarily unavailable.",
        headers: { "Retry-After": "1" },
      });
    }
    throw error;
  }
});

app.get("/search/:id", async (c) => {
  parseStrictQuery(c, {});
  const id = c.req.param("id");
  const cachedQuery = await sharedRedis.get(`q:${id}`);
  if (!cachedQuery) {
    throw notFound(
      "SEARCH_QUERY_NOT_FOUND",
      "No cached search query exists with this ID.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cachedQuery);
  } catch {
    throw notFound(
      "SEARCH_QUERY_NOT_FOUND",
      "No cached search query exists with this ID.",
    );
  }
  return jsonSuccess(c, serializeValue(parsed));
});

app.get("/search/:id/count", async (c) => {
  const id = c.req.param("id");
  const query = parseStrictQuery(c, { country: z.string().optional() });
  const { country, region } = regionalParams(query);
  const cachedQuery = await sharedRedis.get(`q:${id}`);
  if (!cachedQuery) {
    throw notFound(
      "SEARCH_QUERY_NOT_FOUND",
      "No cached search query exists with this ID.",
    );
  }
  let parsed: Record<string, any>;
  try {
    parsed = JSON.parse(cachedQuery) as Record<string, any>;
  } catch {
    throw notFound(
      "SEARCH_QUERY_NOT_FOUND",
      "No cached search query exists with this ID.",
    );
  }

  const result = await cached(
    v1CacheKey("search.query-count", { id, region }),
    300,
    async () => {
      const mongoQuery: Record<string, any> = { namespace: { $ne: "ue" } };
      if (parsed.title) {
        mongoQuery.title = {
          $regex: new RegExp(
            String(parsed.title).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            "i",
          ),
        };
      }
      if (parsed.offerType) mongoQuery.offerType = parsed.offerType;
      if (parsed.tags?.length) mongoQuery["tags.id"] = { $all: parsed.tags };
      if (parsed.categories?.length) {
        mongoQuery.categories = { $all: parsed.categories };
      }
      if (parsed.seller) {
        mongoQuery.$or = [
          { "seller.name": parsed.seller },
          { "seller.id": parsed.seller },
        ];
      }
      if (parsed.developerDisplayName) {
        mongoQuery.developerDisplayName = parsed.developerDisplayName;
      }
      if (parsed.publisherDisplayName) {
        mongoQuery.publisherDisplayName = parsed.publisherDisplayName;
      }
      if (parsed.refundType) mongoQuery.refundType = parsed.refundType;
      if (parsed.isCodeRedemptionOnly !== undefined) {
        mongoQuery.isCodeRedemptionOnly = parsed.isCodeRedemptionOnly;
      }
      const priceQuery: Record<string, any> = {};
      if (parsed.price?.min !== undefined) {
        priceQuery["price.discountPrice"] = { $gte: parsed.price.min };
      }
      if (parsed.price?.max !== undefined) {
        priceQuery["price.discountPrice"] = {
          ...(priceQuery["price.discountPrice"] ?? {}),
          $lte: parsed.price.max,
        };
      }
      if (parsed.onSale) {
        priceQuery["price.discount"] = { $gt: 0 };
      }

      const [row] = await Offer.aggregate<{
        tagCounts: Array<{ _id: unknown; count: number }>;
        offerTypeCounts: Array<{ _id: unknown; count: number }>;
        total: Array<{ total: number }>;
        developer: Array<{ _id: unknown; count: number }>;
        publisher: Array<{ _id: unknown; count: number }>;
        priceRange: Array<{
          minPrice: number | null;
          maxPrice: number | null;
          currency?: string;
        }>;
      }>([
        { $match: mongoQuery },
        {
          $lookup: {
            from: "pricev2",
            localField: "id",
            foreignField: "offerId",
            as: "priceEngine",
            pipeline: [
              { $match: { region, ...priceQuery } },
              { $sort: { updatedAt: -1 } },
              { $limit: 1 },
            ],
          },
        },
        { $addFields: { price: { $arrayElemAt: ["$priceEngine", 0] } } },
        { $match: { price: { $ne: null } } },
        ...(parsed.pastGiveaways
          ? [
              {
                $lookup: {
                  from: "freegames",
                  localField: "id",
                  foreignField: "id",
                  as: "freegame",
                },
              },
              { $match: { freegame: { $ne: [] } } },
            ]
          : []),
        {
          $facet: {
            total: [{ $count: "total" }],
            tagCounts: [
              { $unwind: "$tags" },
              { $group: { _id: "$tags.id", count: { $sum: 1 } } },
            ],
            offerTypeCounts: [
              { $group: { _id: "$offerType", count: { $sum: 1 } } },
            ],
            developer: [
              { $unwind: "$developerDisplayName" },
              {
                $group: {
                  _id: "$developerDisplayName",
                  count: { $sum: 1 },
                },
              },
            ],
            publisher: [
              { $unwind: "$publisherDisplayName" },
              {
                $group: {
                  _id: "$publisherDisplayName",
                  count: { $sum: 1 },
                },
              },
              { $sort: { count: -1 } },
            ],
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
      ]).exec();

      return {
        tagCounts: row?.tagCounts ?? [],
        offerTypeCounts: row?.offerTypeCounts ?? [],
        total: row?.total?.[0]?.total ?? 0,
        developer: row?.developer ?? [],
        publisher: row?.publisher ?? [],
        priceRange: row?.priceRange?.[0] ?? {
          minPrice: null,
          maxPrice: null,
        },
      };
    },
  );

  return jsonSuccess(c, result, { country, region });
});

export default app;
