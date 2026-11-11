import { Hono } from "hono";
import { z } from "zod";
import { opensearch } from "../../clients/opensearch.js";
import { Seller } from "../../models/index.js";
import { attributesToObject } from "../../utils/attributes-to-object.js";
import { localizeOffers } from "../../utils/offer-localization.js";
import { orderOffersObject } from "../../utils/order-offers-object.js";
import { cached, v1CacheKey } from "../cache.js";
import { decodeCursor, encodeCursor } from "../cursor.js";
import { ProblemError } from "../errors.js";
import { parsePagination, trimPage } from "../pagination.js";
import {
  parseBoolean,
  parseCsv,
  parseInteger,
  parseStrictQuery,
  regionalParams,
} from "../query.js";
import type { V1Variables } from "../request-context.js";
import { jsonSuccess } from "../response.js";
import {
  serializeOffer,
  serializeSeller,
  serializeValue,
} from "../serialization.js";

const app = new Hono<{ Variables: V1Variables }>();

const searchOpenSearch = (params: Record<string, unknown>): Promise<any> =>
  (
    opensearch.search as unknown as (
      input: Record<string, unknown>,
    ) => Promise<any>
  )(params);

function unavailable(detail: string): ProblemError {
  return new ProblemError({
    status: 503,
    code: "SEARCH_UNAVAILABLE",
    detail,
    headers: { "Retry-After": "1" },
  });
}

const offersShape = {
  query: z.string().max(500).optional(),
  offerType: z.string().max(80).optional(),
  tags: z.string().optional(),
  categories: z.string().optional(),
  customAttributes: z.string().optional(),
  seller: z.string().max(200).optional(),
  developerDisplayName: z.string().max(300).optional(),
  publisherDisplayName: z.string().max(300).optional(),
  refundType: z.string().max(80).optional(),
  isCodeRedemptionOnly: z.string().optional(),
  excludeBlockchain: z.string().optional(),
  pastGiveaways: z.string().optional(),
  onSale: z.string().optional(),
  isLowestPrice: z.string().optional(),
  isLowestPriceEver: z.string().optional(),
  priceMin: z.string().optional(),
  priceMax: z.string().optional(),
  sortBy: z.string().max(80).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
  country: z.string().optional(),
  locale: z.string().optional(),
  limit: z.string().optional(),
  cursor: z.string().optional(),
};

app.get("/multisearch/offers", async (c) => {
  const query = parseStrictQuery(c, offersShape);
  const { country, region, locale } = regionalParams(query);
  const { limit, cursor } = parsePagination(query);
  const sortDir = query.sortDir ?? "desc";
  let text = query.query?.trim() || undefined;

  if (text?.includes("store.epicgames.com")) {
    try {
      const url = new URL(text);
      text = url.pathname.split("/").pop() || text;
    } catch {
      // Keep the literal query when it is not a valid URL.
    }
  }

  const filters = {
    query: text ?? null,
    offerType: query.offerType ?? null,
    tags: parseCsv(query.tags) ?? [],
    categories: parseCsv(query.categories) ?? [],
    customAttributes: parseCsv(query.customAttributes) ?? [],
    seller: query.seller ?? null,
    developerDisplayName: query.developerDisplayName ?? null,
    publisherDisplayName: query.publisherDisplayName ?? null,
    refundType: query.refundType ?? null,
    isCodeRedemptionOnly:
      parseBoolean(query.isCodeRedemptionOnly, "isCodeRedemptionOnly") ?? null,
    excludeBlockchain:
      parseBoolean(query.excludeBlockchain, "excludeBlockchain") ?? null,
    pastGiveaways: parseBoolean(query.pastGiveaways, "pastGiveaways") ?? null,
    onSale: parseBoolean(query.onSale, "onSale") ?? null,
    isLowestPrice: parseBoolean(query.isLowestPrice, "isLowestPrice") ?? null,
    isLowestPriceEver:
      parseBoolean(query.isLowestPriceEver, "isLowestPriceEver") ?? null,
    priceMin: parseInteger(query.priceMin, "priceMin", { min: 0 }) ?? null,
    priceMax: parseInteger(query.priceMax, "priceMax", { min: 0 }) ?? null,
    sortBy: query.sortBy ?? null,
    sortDir,
  };
  const ordering = `${query.sortBy ?? (text ? "_score" : "lastModifiedDate")}:${sortDir},id:asc`;
  const binding = {
    operation: "multisearch.offers",
    filters,
    ordering,
    country,
    locale,
    limit,
  };

  const page = await cached(
    v1CacheKey("multisearch.offers", {
      region,
      locale,
      limit,
      cursor,
      filters,
    }),
    60,
    async () => {
      const must: Array<Record<string, unknown>> = [];
      const filter: Array<Record<string, unknown>> = [];
      if (text) {
        must.push({
          bool: {
            should: [
              {
                multi_match: {
                  query: text,
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
                  title: { query: text, boost: 10, slop: 2 },
                },
              },
            ],
            minimum_should_match: 1,
          },
        });
      }
      if (filters.offerType) {
        filter.push({ term: { "offerType.keyword": filters.offerType } });
      }
      if (filters.tags.length) {
        filter.push({
          terms_set: {
            "tags.id.keyword": {
              terms: filters.tags,
              minimum_should_match_script: {
                source: filters.tags.length.toString(),
              },
            },
          },
        });
      }
      if (filters.categories.length) {
        filter.push({ terms: { "categories.keyword": filters.categories } });
      }
      if (filters.customAttributes.length) {
        filter.push({
          terms: { "customAttributes.keyword": filters.customAttributes },
        });
      }
      if (filters.seller) {
        filter.push({ term: { "seller.id.keyword": filters.seller } });
      }
      if (filters.developerDisplayName) {
        filter.push({
          term: {
            "developerDisplayName.keyword": filters.developerDisplayName,
          },
        });
      }
      if (filters.publisherDisplayName) {
        filter.push({
          term: {
            "publisherDisplayName.keyword": filters.publisherDisplayName,
          },
        });
      }
      if (filters.refundType) {
        filter.push({ term: { "refundType.keyword": filters.refundType } });
      }
      if (filters.isCodeRedemptionOnly) {
        filter.push({ term: { isCodeRedemptionOnly: true } });
      }
      if (filters.excludeBlockchain) {
        filter.push({
          bool: {
            must_not: [{ term: { "customAttributes.isBlockchainUsed": true } }],
          },
        });
      }
      if (filters.pastGiveaways) {
        filter.push({ exists: { field: "freeEntries" } });
      }
      const priceRange: Record<string, number> = {};
      if (filters.priceMin !== null) priceRange.gte = filters.priceMin;
      if (filters.priceMax !== null) priceRange.lte = filters.priceMax;
      if (Object.keys(priceRange).length) {
        filter.push({
          range: { [`prices.${region}.price.discountPrice`]: priceRange },
        });
      }
      if (filters.onSale) {
        filter.push({
          range: { [`prices.${region}.price.discount`]: { gt: 0 } },
        });
      }

      let sortField = query.sortBy;
      let direction = sortDir;
      if (
        sortField === "priceAsc" ||
        sortField === "priceDesc" ||
        sortField === "price"
      ) {
        sortField = `prices.${region}.price.discountPrice`;
        direction =
          query.sortBy === "priceAsc"
            ? "asc"
            : query.sortBy === "priceDesc"
              ? "desc"
              : sortDir;
      } else if (sortField === "discount") {
        sortField = `prices.${region}.price.discount`;
      } else if (sortField === "upcoming") {
        sortField = "releaseDate";
        direction = sortDir === "asc" ? "desc" : "asc";
        filter.push({
          range: { releaseDate: { gte: new Date().toISOString() } },
        });
      } else if (sortField === "giveawayDate") {
        sortField = "freeEntries.endDate";
      }

      const sort = [
        sortField
          ? { [sortField]: { order: direction, missing: "_last" } }
          : { _score: { order: "desc" } },
        ...(text && sortField ? [{ _score: { order: "desc" } }] : []),
        { "id.keyword": { order: "asc", missing: "_last" } },
      ];

      const searchAfter = cursor ? decodeCursor(cursor, binding) : undefined;
      let response: any;
      try {
        response = await searchOpenSearch({
          index: "egdata.offers",
          body: {
            size: limit + 1,
            track_total_hits: false,
            query: { bool: { must, filter } },
            sort,
            ...(searchAfter ? { search_after: searchAfter } : {}),
          },
        });
      } catch {
        throw unavailable("Offer search is temporarily unavailable.");
      }

      const rawHits = (response.body.hits.hits ?? []) as Array<{
        _source?: Record<string, any>;
        sort?: Array<string | number | null>;
        _id?: string;
      }>;
      const { items, hasMore } = trimPage(rawHits, limit);
      const localized = await localizeOffers(
        items.map((hit) => orderOffersObject({ ...(hit._source ?? {}) })),
        locale,
      );
      const lastSort = items.at(-1)?.sort;
      return {
        hits: localized.map((offer) => serializeOffer(offer)),
        pagination: {
          limit,
          hasMore,
          nextCursor:
            hasMore && lastSort
              ? encodeCursor(binding, lastSort as Array<string | number | null>)
              : null,
        },
        result: {
          tookMs: response.body.took ?? 0,
          timedOut: Boolean(response.body.timed_out),
        },
      };
    },
  );

  return jsonSuccess(c, page.hits, {
    country,
    region,
    locale,
    result: page.result,
    pagination: page.pagination,
  });
});

app.get("/multisearch/items", async (c) => {
  const query = parseStrictQuery(c, {
    query: z.string().max(500).optional(),
    type: z.string().max(100).optional(),
    limit: z.string().optional(),
    cursor: z.string().optional(),
  });
  const { limit, cursor } = parsePagination(query);
  const binding = {
    operation: "multisearch.items",
    filters: { query: query.query ?? null, type: query.type ?? null },
    ordering: "lastModifiedDate:desc,id:asc",
    country: "",
    locale: "",
    limit,
  };

  const page = await cached(
    v1CacheKey("multisearch.items", {
      query: query.query ?? null,
      type: query.type ?? null,
      limit,
      cursor,
    }),
    60,
    async () => {
      const must: Array<Record<string, unknown>> = [];
      const filter: Array<Record<string, unknown>> = [
        { bool: { must_not: { term: { "namespace.keyword": "ue" } } } },
      ];
      if (query.query) {
        must.push({
          multi_match: {
            query: query.query,
            fields: ["title^2", "description", "id"],
          },
        });
      }
      if (query.type) {
        filter.push({ term: { "entitlementType.keyword": query.type } });
      }
      const searchAfter = cursor ? decodeCursor(cursor, binding) : undefined;
      let response: any;
      try {
        response = await searchOpenSearch({
          index: "egdata.items",
          body: {
            size: limit + 1,
            track_total_hits: false,
            query: { bool: { must, filter } },
            sort: [
              { lastModifiedDate: { order: "desc", missing: "_last" } },
              { "id.keyword": { order: "asc", missing: "_last" } },
            ],
            ...(searchAfter ? { search_after: searchAfter } : {}),
          },
        });
      } catch {
        throw unavailable("Item search is temporarily unavailable.");
      }
      const rawHits = (response.body.hits.hits ?? []) as Array<{
        _source?: Record<string, any>;
        sort?: Array<string | number | null>;
      }>;
      const { items, hasMore } = trimPage(rawHits, limit);
      const lastSort = items.at(-1)?.sort;
      return {
        hits: items.map((hit) => {
          const source = hit._source ?? {};
          return {
            ...(serializeValue(source) as Record<string, unknown>),
            customAttributes: source.customAttributes
              ? attributesToObject(source.customAttributes as never)
              : {},
          };
        }),
        pagination: {
          limit,
          hasMore,
          nextCursor:
            hasMore && lastSort
              ? encodeCursor(binding, lastSort as Array<string | number | null>)
              : null,
        },
        result: {
          tookMs: response.body.took ?? 0,
          timedOut: Boolean(response.body.timed_out),
        },
      };
    },
  );

  return jsonSuccess(c, page.hits, {
    result: page.result,
    pagination: page.pagination,
  });
});

app.get("/multisearch/sellers", async (c) => {
  const query = parseStrictQuery(c, {
    query: z.string().max(300).optional(),
    limit: z.string().optional(),
  });
  const limit = Math.min(Number.parseInt(query.limit || "20", 10) || 20, 100);

  const page = await cached(
    v1CacheKey("multisearch.sellers", {
      query: query.query ?? null,
      limit,
    }),
    300,
    async () => {
      const filters: Array<Record<string, unknown>> = [];
      if (query.query) {
        filters.push({
          match: { "seller.name": { query: query.query, fuzziness: "AUTO" } },
        });
      }
      let response: any;
      try {
        response = await searchOpenSearch({
          index: "egdata.offers",
          body: {
            size: 0,
            query:
              filters.length > 0
                ? { bool: { must: filters } }
                : { match_all: {} },
            aggs: {
              sellers: { terms: { field: "seller.id.keyword", size: limit } },
            },
          },
        });
      } catch {
        throw unavailable("Seller search is temporarily unavailable.");
      }
      const buckets = (response.body.aggregations?.sellers?.buckets ??
        []) as Array<{ key: string }>;
      const sellerIds = buckets.map((bucket) => bucket.key);
      const docs =
        sellerIds.length > 0
          ? await Seller.find({ _id: { $in: sellerIds } }).lean()
          : [];
      const byId = new Map(docs.map((doc) => [String(doc._id), doc]));
      return {
        hits: sellerIds
          .map((id) => serializeSeller(byId.get(id)))
          .filter(Boolean),
        result: {
          tookMs: response.body.took ?? 0,
          timedOut: Boolean(response.body.timed_out),
        },
      };
    },
  );

  return jsonSuccess(c, page.hits, {
    result: page.result,
    count: page.hits.length,
  });
});

export default app;
