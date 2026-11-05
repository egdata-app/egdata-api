import { createHash } from "node:crypto";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { opensearch } from "../clients/opensearch.js";
import client from "../clients/response-cache.js";
import {
  type OfferType,
  type PriceEngineType,
  Seller,
} from "../models/index.js";
import { attributesToObject } from "../utils/attributes-to-object.js";
import { regions } from "../utils/countries.js";
import { toOfferCards, wantsExpandedOffers } from "../utils/offer-card.js";
import {
  getLocaleOrErrorResponse,
  getLocalizedCacheTtlSeconds,
  localeCacheSegment,
  localizeOffers,
} from "../utils/offer-localization.js";

const app = new Hono();

const MULTISEARCH_OFFERS_DEFAULT_LIMIT = 10;
const MULTISEARCH_OFFERS_MAX_LIMIT = 50;

const MULTISEARCH_ITEMS_DEFAULT_LIMIT = 10;
const MULTISEARCH_ITEMS_MAX_LIMIT = 50;

const CACHE_HEADERS = {
  "Cache-Control": "public, max-age=60, s-maxage=300",
  "CDN-Cache-Control": "public, max-age=300",
} as const;

const ITEM_CARD_SOURCE_FIELDS = [
  "id",
  "namespace",
  "title",
  "description",
  "keyImages",
  "categories",
  "customAttributes",
  "developer",
  "entitlementType",
  "releaseInfo",
  "status",
  "lastModifiedDate",
];

const parseBoundedLimit = (
  value: string | undefined,
  fallback: number,
  maximum: number,
) => {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(parsed, maximum);
};

const parsePage = (value: string | undefined) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
};

app.get("/", (c) => {
  return c.json({ message: "Hello, World!" });
});

app.get("/offers", async (c) => {
  const localeResult = getLocaleOrErrorResponse(c);
  if (localeResult.errorResponse) {
    return localeResult.errorResponse;
  }
  const { locale } = localeResult;
  const country =
    c.req.query("country") ?? getCookie(c, "EGDATA_COUNTRY") ?? "US";
  const region =
    Object.keys(regions).find((r) => regions[r].countries.includes(country)) ??
    "US";

  let query = c.req.query("query");
  const offerType = c.req.query("offerType");
  const tags = c.req.query("tags");
  const categories = c.req.query("categories");
  const customAttributes = c.req.query("customAttributes");
  const seller = c.req.query("seller");
  const developerDisplayName = c.req.query("developerDisplayName");
  const publisherDisplayName = c.req.query("publisherDisplayName");
  const refundType = c.req.query("refundType");
  const isCodeRedemptionOnly = c.req.query("isCodeRedemptionOnly");
  const excludeBlockchain = c.req.query("excludeBlockchain");
  const pastGiveaways = c.req.query("pastGiveaways");
  const priceMin = c.req.query("priceMin");
  const priceMax = c.req.query("priceMax");
  const onSale = c.req.query("onSale");
  const isLowestPrice = c.req.query("isLowestPrice");
  const isLowestPriceEver = c.req.query("isLowestPriceEver");
  const sortBy = c.req.query("sortBy");
  const sortDir = c.req.query("sortDir") as "asc" | "desc" | undefined;
  const limit = parseBoundedLimit(
    c.req.query("limit"),
    MULTISEARCH_OFFERS_DEFAULT_LIMIT,
    MULTISEARCH_OFFERS_MAX_LIMIT,
  );
  const page = parsePage(c.req.query("page"));
  const from = (page - 1) * limit;
  const expand = wantsExpandedOffers(c);

  if (query?.includes("store.epicgames.com")) {
    const isUrl = URL.canParse(query);
    if (isUrl) {
      const url = new URL(query);
      const slug = url.pathname.split("/").pop();
      query = slug || query;
    }
  }

  const must: Array<Record<string, unknown>> = [];
  const filter: Array<Record<string, unknown>> = [];

  if (query) {
    must.push({
      bool: {
        should: [
          {
            multi_match: {
              query,
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
              title: {
                query,
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

  if (offerType) filter.push({ term: { "offerType.keyword": offerType } });

  if (tags) {
    const tagList = tags.split(",").filter(Boolean);
    if (tagList.length) {
      filter.push({
        terms_set: {
          "tags.id.keyword": {
            terms: tagList,
            minimum_should_match_script: {
              source: tagList.length.toString(),
            },
          },
        },
      });
    }
  }

  if (categories) {
    const catList = categories.split(",").filter(Boolean);
    if (catList.length)
      filter.push({ terms: { "categories.keyword": catList } });
  }

  if (customAttributes) {
    const attrList = customAttributes.split(",").filter(Boolean);
    if (attrList.length)
      filter.push({ terms: { "customAttributes.keyword": attrList } });
  }

  if (seller) filter.push({ term: { "seller.id.keyword": seller } });
  if (developerDisplayName)
    filter.push({
      term: { "developerDisplayName.keyword": developerDisplayName },
    });
  if (publisherDisplayName)
    filter.push({
      term: { "publisherDisplayName.keyword": publisherDisplayName },
    });
  if (refundType) filter.push({ term: { "refundType.keyword": refundType } });
  if (isCodeRedemptionOnly === "true")
    filter.push({ term: { isCodeRedemptionOnly: true } });

  if (excludeBlockchain === "true") {
    filter.push({
      bool: {
        must_not: [{ term: { "customAttributes.isBlockchainUsed": true } }],
      },
    });
  }

  if (pastGiveaways === "true") {
    filter.push({ exists: { field: "freeEntries" } });
  }

  if (priceMin != null || priceMax != null) {
    const range: { gte?: number; lte?: number } = {};
    if (priceMin != null && priceMin !== "") range.gte = Number(priceMin);
    if (priceMax != null && priceMax !== "") range.lte = Number(priceMax);
    if (range.gte !== undefined || range.lte !== undefined) {
      filter.push({
        range: { [`prices.${region}.price.discountPrice`]: range },
      });
    }
  }

  if (onSale === "true") {
    filter.push({
      range: { [`prices.${region}.price.discount`]: { gt: 0 } },
    });
  }

  if (isLowestPrice === "true") {
    filter.push({ term: { isAtLowestPriceUS: true } });
    if (onSale === undefined) {
      filter.push({
        range: { [`prices.${region}.price.discount`]: { gt: 0 } },
      });
    }
  }

  if (isLowestPriceEver === "true") {
    filter.push({ term: { isHistoricalLowestEverUS: true } });
    if (onSale === undefined) {
      filter.push({
        range: { [`prices.${region}.price.discount`]: { gt: 0 } },
      });
    }
  }

  // Sorting
  const sort: Array<Record<string, { order: "asc" | "desc" }>> = [];
  if (sortBy) {
    const dir = sortDir ?? "desc";
    switch (sortBy) {
      case "priceAsc":
      case "priceDesc":
      case "price": {
        const direction = dir || (sortBy === "priceDesc" ? "desc" : "asc");
        sort.push({
          [`prices.${region}.price.discountPrice`]: { order: direction },
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
        sort.push({ releaseDate: { order: dir === "asc" ? "desc" : "asc" } });
        filter.push({
          range: { releaseDate: { gte: new Date().toISOString() } },
        });
        break;
      case "giveawayDate":
        sort.push({ "freeEntries.endDate": { order: dir } });
        filter.push({ exists: { field: "freeEntries" } });
        break;
      case "releaseDate": {
        if (dir === "desc") {
          filter.push({
            range: { releaseDate: { lte: new Date().toISOString() } },
          });
        } else {
          filter.push({
            range: { releaseDate: { gte: new Date().toISOString() } },
          });
        }
        sort.push({ releaseDate: { order: dir } });
        break;
      }
      default:
        sort.push({ [sortBy]: { order: dir } });
    }
  } else {
    if (query) {
      sort.push({ _score: { order: "desc" } });
    } else {
      sort.push({ lastModifiedDate: { order: "desc" } });
    }
  }

  if (sort.length > 0 && query) {
    sort.push({ _score: { order: "desc" } });
  }

  const searchBody = {
    from,
    size: limit,
    query: { bool: { must, filter } },
    sort,
  };
  const queryHash = createHash("sha256")
    .update(JSON.stringify(searchBody))
    .digest("hex");
  const cacheKey = `multisearch:offers:${region}:${page}:${limit}:${
    expand ? "full" : "card"
  }:${localeCacheSegment(locale)}:${queryHash}`;

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, CACHE_HEADERS);
  }

  const response = await opensearch.search({
    index: "egdata.offers",
    body: searchBody,
  });

  // The index stores a price document for every region on every hit. Keep only
  // the requested region's price and drop the rest before responding.
  const offerDocs: OfferType[] = [];
  const priceByOfferId = new Map<string, PriceEngineType | null>();

  for (const hit of response.body.hits.hits) {
    const source = (hit._source ?? {}) as OfferType & {
      prices?: Record<string, PriceEngineType>;
    };
    const doc: OfferType = {
      ...source,
      _id: hit._id,
    };
    priceByOfferId.set(doc.id, source.prices?.[region] ?? null);
    delete doc.prices;
    offerDocs.push(doc);
  }

  const hits = expand
    ? await localizeOffers(
        offerDocs.map((doc) => ({
          ...doc,
          price: priceByOfferId.get(doc.id) ?? null,
        })),
        locale,
      )
    : await toOfferCards(offerDocs, locale, priceByOfferId);

  const total = response.body.hits.total;
  const estimatedTotalHits =
    typeof total === "number" ? total : (total?.value ?? 0);

  const result = {
    hits,
    estimatedTotalHits,
    processingTimeMs: response.body.took,
    query: query || "",
  };

  await client.set(
    cacheKey,
    JSON.stringify(result),
    "EX",
    getLocalizedCacheTtlSeconds(result, 300),
  );

  return c.json(result, 200, CACHE_HEADERS);
});

app.get("/items", async (c) => {
  const { query, type: entitlementType } = c.req.query();
  const limit = parseBoundedLimit(
    c.req.query("limit"),
    MULTISEARCH_ITEMS_DEFAULT_LIMIT,
    MULTISEARCH_ITEMS_MAX_LIMIT,
  );
  const page = parsePage(c.req.query("page"));
  const from = (page - 1) * limit;

  const must: Array<Record<string, unknown>> = [];
  const filter: Array<Record<string, unknown>> = [
    { bool: { must_not: { term: { "namespace.keyword": "ue" } } } },
  ];

  if (query) {
    must.push({
      multi_match: {
        query,
        fields: ["title^2", "description", "id"],
      },
    });
  }

  if (entitlementType) {
    filter.push({ term: { "entitlementType.keyword": entitlementType } });
  }

  const response = await opensearch.search({
    index: "egdata.items",
    body: {
      from,
      size: limit,
      ...(wantsExpandedOffers(c)
        ? {}
        : { _source: ITEM_CARD_SOURCE_FIELDS }),
      query: { bool: { must, filter } },
      sort: [{ lastModifiedDate: { order: "desc" } }],
    },
  });

  const hits = response.body.hits.hits.map((hit) => {
    const source = hit._source || {};
    return {
      ...source,
      _id: hit._id,
      customAttributes: source.customAttributes
        ? attributesToObject(source.customAttributes as never)
        : {},
    };
  });

  const total = response.body.hits.total;
  const estimatedTotalHits =
    typeof total === "number" ? total : (total?.value ?? 0);

  return c.json(
    {
      hits,
      estimatedTotalHits,
      processingTimeMs: response.body.took,
      query: query || "",
    },
    200,
    CACHE_HEADERS,
  );
});

app.get("/sellers", async (c) => {
  const { query } = c.req.query();
  const limit = Math.min(Number(c.req.query("limit")) || 10, 100);

  const filter: Array<Record<string, unknown>> = [];

  if (query) {
    filter.push({
      match: {
        "seller.name": {
          query,
          fuzziness: "AUTO",
        },
      },
    });
  }

  const response = await opensearch.search({
    index: "egdata.offers",
    body: {
      size: 0,
      query: filter.length > 0 ? { bool: { must: filter } } : { match_all: {} },
      aggs: {
        sellers: {
          terms: {
            field: "seller.id.keyword",
            size: limit,
          },
        },
      },
    },
  });

  const buckets = response.body.aggregations?.sellers?.buckets ?? [];
  const sellerIds = buckets.map((b: { key: string }) => b.key);

  const sellerDocs =
    sellerIds.length > 0 ? await Seller.find({ _id: { $in: sellerIds } }) : [];

  const sellerMap = new Map(sellerDocs.map((doc) => [doc._id.toString(), doc]));

  const hits = sellerIds.map((id: string) => sellerMap.get(id)).filter(Boolean);

  return c.json({
    hits,
    estimatedTotalHits: buckets.length,
    processingTimeMs: response.body.took,
    query: query || "",
  });
});

export default app;
