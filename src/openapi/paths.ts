import type { OpenAPIV3 } from "openapi-types";
import { arrayOf, ok, operation, parameterRef, ref, stringQuery } from "./helpers.js";
import type { EgdataPaths } from "./types.js";

const pagination = [parameterRef("page"), parameterRef("limit")];
const regionalPagination = [parameterRef("country"), ...pagination];
const offerId = [parameterRef("offerId")];
const itemId = [parameterRef("itemId")];
const sellerId = [parameterRef("sellerId")];

const jsonBody = (
  description: string,
  schema: OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject,
): OpenAPIV3.RequestBodyObject => ({
  required: true,
  description,
  content: {
    "application/json": {
      schema,
    },
  },
});

const stringArrayBody = (property: string): OpenAPIV3.SchemaObject => ({
  type: "object",
  required: [property],
  additionalProperties: false,
  properties: {
    [property]: {
      type: "array",
      items: { type: "string" },
    },
  },
});

export const paths: EgdataPaths = {
  "/health": {
    get: operation({
      operationId: "getHealth",
      tags: ["System"],
      summary: "Check API dependency health",
      description: "Reports Redis and MongoDB connectivity and latency.",
      response: ref("HealthResponse"),
    }),
  },
  "/countries": {
    get: operation({
      operationId: "listCountries",
      tags: ["Regions"],
      summary: "List supported countries",
      response: ref("CountryMap"),
    }),
  },
  "/regions": {
    get: operation({
      operationId: "listRegions",
      tags: ["Regions"],
      summary: "List Epic pricing regions",
      response: {
        type: "object",
        additionalProperties: ref("Region"),
      },
    }),
  },
  "/region": {
    get: operation({
      operationId: "getRegionForCountry",
      tags: ["Regions"],
      summary: "Resolve a country to an Epic pricing region",
      parameters: [parameterRef("country")],
      response: ref("RegionLookupResponse"),
    }),
  },
  "/latest-games": {
    get: operation({
      operationId: "listLatestGames",
      tags: ["Catalog"],
      summary: "List recently created catalog offers",
      parameters: [parameterRef("country")],
      response: arrayOf(ref("Offer")),
    }),
  },
  "/featured": {
    get: operation({
      operationId: "listFeaturedGames",
      tags: ["Catalog"],
      summary: "List featured offers",
      response: arrayOf(ref("Offer")),
    }),
  },
  "/autocomplete": {
    get: operation({
      operationId: "autocompleteOffers",
      tags: ["Catalog"],
      summary: "Autocomplete offer titles",
      parameters: [
        stringQuery("query", "Search text to autocomplete.", "civilization"),
        parameterRef("limit"),
      ],
      response: {
        type: "object",
        required: ["elements", "total"],
        additionalProperties: false,
        properties: {
          elements: {
            type: "array",
            items: ref("Offer"),
          },
          total: { type: "integer" },
        },
      },
    }),
  },
  "/active-sales": {
    get: operation({
      operationId: "listActiveSales",
      tags: ["Catalog"],
      summary: "List active sale events with representative offers",
      parameters: [parameterRef("country")],
      response: arrayOf({
        type: "object",
        additionalProperties: true,
      }),
    }),
  },
  "/offers": {
    get: operation({
      operationId: "listOffers",
      tags: ["Offers"],
      summary: "List offers with regional price data",
      parameters: regionalPagination,
      response: ref("OfferListResponse"),
    }),
  },
  "/offers/{id}": {
    get: operation({
      operationId: "getOffer",
      tags: ["Offers"],
      summary: "Get an offer by ID",
      parameters: offerId,
      response: ref("Offer"),
    }),
  },
  "/offers/slugs": {
    post: operation({
      operationId: "resolveOfferSlugs",
      tags: ["Offers"],
      summary: "Resolve store slugs to offer IDs",
      requestBody: jsonBody("Slugs to resolve.", stringArrayBody("slugs")),
      response: arrayOf({
        type: "object",
        required: ["slug", "id", "namespace"],
        additionalProperties: false,
        properties: {
          slug: { type: "string" },
          id: { type: "string", nullable: true },
          namespace: { type: "string", nullable: true },
        },
      }),
    }),
  },
  "/offers/exists": {
    post: operation({
      operationId: "checkOffersExist",
      tags: ["Offers"],
      summary: "Check whether offer IDs exist",
      requestBody: jsonBody("Offer IDs to check.", stringArrayBody("offers")),
      response: {
        type: "object",
        required: ["existingOffers", "nonExistingOffers"],
        additionalProperties: false,
        properties: {
          existingOffers: {
            type: "array",
            items: { type: "string" },
          },
          nonExistingOffers: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
    }),
  },
  "/offers/upcoming": {
    get: operation({
      operationId: "listUpcomingOffers",
      tags: ["Offers"],
      summary: "List upcoming games and add-ons",
      parameters: regionalPagination,
      response: ref("OfferListResponse"),
    }),
  },
  "/offers/latest-released": {
    get: operation({
      operationId: "listLatestReleasedOffers",
      tags: ["Offers"],
      summary: "List recently released offers",
      parameters: regionalPagination,
      response: ref("OfferListResponse"),
    }),
  },
  "/offers/latest-achievements": {
    get: operation({
      operationId: "listLatestAchievementOffers",
      tags: ["Offers"],
      summary: "List recently released base games with achievements",
      parameters: [parameterRef("country")],
      response: arrayOf({
        allOf: [{ $ref: "#/components/schemas/Offer" }],
      }),
    }),
  },
  "/offers/top-sellers": {
    get: operation({
      operationId: "listTopSellersOffers",
      tags: ["Offers"],
      summary: "List top-selling offers",
      parameters: pagination,
      response: ref("OfferListResponse"),
    }),
  },
  "/offers/top-wishlisted": {
    get: operation({
      operationId: "listTopWishlistedOffers",
      tags: ["Offers"],
      summary: "List top-wishlisted offers",
      parameters: pagination,
      response: ref("OfferListResponse"),
    }),
  },
  "/offers/featured-discounts": {
    get: operation({
      operationId: "listFeaturedDiscounts",
      tags: ["Offers"],
      summary: "List featured discounted offers",
      parameters: [parameterRef("country")],
      response: arrayOf(ref("Offer")),
    }),
  },
  "/offers/events": {
    get: operation({
      operationId: "listOfferEvents",
      tags: ["Offers"],
      summary: "List active offer event tags",
      response: arrayOf({
        type: "object",
        additionalProperties: true,
      }),
    }),
  },
  "/offers/events/{id}": {
    get: operation({
      operationId: "getOfferEvent",
      tags: ["Offers"],
      summary: "List offers for an event tag",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          description: "Event tag ID.",
          schema: { type: "string" },
        },
        ...regionalPagination,
      ],
      response: {
        type: "object",
        additionalProperties: false,
        properties: {
          elements: {
            type: "array",
            items: ref("Offer"),
          },
          title: { type: "string" },
          limit: { type: "integer" },
          start: { type: "integer" },
          page: { type: "integer" },
          count: { type: "integer" },
        },
      },
    }),
  },
  "/offers/genres": {
    get: operation({
      operationId: "listOfferGenres",
      tags: ["Offers"],
      summary: "List active genres with representative offers",
      response: arrayOf({
        type: "object",
        additionalProperties: true,
      }),
    }),
  },
  "/offers/{id}/price": {
    get: operation({
      operationId: "getOfferPrice",
      tags: ["Prices"],
      summary: "Get current regional price for an offer",
      parameters: [...offerId, parameterRef("country")],
      response: ref("Price"),
    }),
  },
  "/offers/{id}/price-history": {
    get: operation({
      operationId: "getOfferPriceHistory",
      tags: ["Prices"],
      summary: "Get historical regional prices for an offer",
      parameters: [...offerId, parameterRef("country")],
      response: arrayOf(ref("Price")),
    }),
  },
  "/offers/{id}/regional-price": {
    get: operation({
      operationId: "getOfferRegionalPrices",
      tags: ["Prices"],
      summary: "Get prices for an offer across regions",
      parameters: offerId,
      response: arrayOf(ref("Price")),
    }),
  },
  "/offers/{id}/price/fairness": {
    get: operation({
      operationId: "getOfferPriceFairness",
      tags: ["Prices"],
      summary: "Get regional price fairness data for an offer",
      parameters: offerId,
      response: {
        type: "object",
        additionalProperties: true,
      },
    }),
  },
  "/offers/{id}/price-stats": {
    get: operation({
      operationId: "getOfferPriceStats",
      tags: ["Prices"],
      summary: "Get aggregate price statistics for an offer",
      parameters: offerId,
      response: {
        type: "object",
        additionalProperties: true,
      },
    }),
  },
  "/items": {
    get: operation({
      operationId: "listItems",
      tags: ["Items"],
      summary: "List catalog items",
      parameters: pagination,
      response: ref("ItemListResponse"),
    }),
  },
  "/items/{id}": {
    get: operation({
      operationId: "getItem",
      tags: ["Items"],
      summary: "Get an item by ID",
      parameters: itemId,
      response: ref("Item"),
    }),
  },
  "/items/bulk": {
    post: operation({
      operationId: "getItemsBulk",
      tags: ["Items"],
      summary: "Fetch multiple items by ID",
      requestBody: jsonBody("Item IDs to fetch.", stringArrayBody("items")),
      response: arrayOf(ref("Item")),
    }),
  },
  "/items/bulk/offers": {
    post: operation({
      operationId: "getOffersForItemsBulk",
      tags: ["Items"],
      summary: "Fetch offer candidates for multiple items",
      requestBody: jsonBody("Item IDs to resolve.", stringArrayBody("items")),
      response: arrayOf({
        type: "object",
        additionalProperties: true,
      }),
    }),
  },
  "/items/{id}/assets": {
    get: operation({
      operationId: "getItemAssets",
      tags: ["Items"],
      summary: "List assets for an item",
      parameters: itemId,
      response: arrayOf({
        type: "object",
        additionalProperties: true,
      }),
    }),
  },
  "/items/{id}/builds": {
    get: operation({
      operationId: "getItemBuilds",
      tags: ["Items"],
      summary: "List builds associated with an item",
      parameters: itemId,
      response: arrayOf({
        type: "object",
        additionalProperties: true,
      }),
    }),
  },
  "/items/{id}/changelog": {
    get: operation({
      operationId: "getItemChangelog",
      tags: ["Items"],
      summary: "List changelog entries for an item",
      parameters: [...itemId, ...pagination],
      response: arrayOf(ref("ChangelogEntry")),
    }),
  },
  "/items/{id}/offer": {
    get: operation({
      operationId: "getItemOffer",
      tags: ["Items"],
      summary: "Get the offer associated with an item",
      parameters: itemId,
      response: ref("Offer"),
    }),
  },
  "/free-games": {
    get: operation({
      operationId: "getFreeGames",
      tags: ["Free Games"],
      summary: "Get current and upcoming free games",
      response: ref("FreeGamesResponse"),
    }),
  },
  "/free-games/history": {
    get: operation({
      operationId: "listFreeGamesHistory",
      tags: ["Free Games"],
      summary: "List historical free game promotions",
      parameters: pagination,
      response: {
        type: "object",
        additionalProperties: true,
      },
    }),
  },
  "/free-games/search": {
    get: operation({
      operationId: "searchFreeGames",
      tags: ["Free Games"],
      summary: "Search historical free game promotions",
      parameters: [
        stringQuery("query", "Search text.", "fallout"),
        ...pagination,
      ],
      response: {
        type: "object",
        additionalProperties: true,
      },
    }),
  },
  "/free-games/stats": {
    get: operation({
      operationId: "getFreeGamesStats",
      tags: ["Free Games"],
      summary: "Get free games statistics",
      response: ref("StatsResponse"),
    }),
  },
  "/free-games/mobile": {
    get: operation({
      operationId: "listMobileFreeGames",
      tags: ["Free Games"],
      summary: "List current mobile free games",
      parameters: [parameterRef("country")],
      response: ref("FreeGamesResponse"),
    }),
  },
  "/free-games/sellers": {
    get: operation({
      operationId: "listFreeGamesSellers",
      tags: ["Free Games"],
      summary: "List sellers represented in free game history",
      response: arrayOf(ref("SellerSummary")),
    }),
  },
  "/search/v2/search": {
    post: operation({
      operationId: "searchOffersV2",
      tags: ["Search"],
      summary: "Search offers with OpenSearch-backed filters and aggregations",
      parameters: [parameterRef("country")],
      requestBody: jsonBody("Search filters and sort options.", ref("SearchBody")),
      response: ref("SearchResponse"),
    }),
  },
  "/search": {
    post: operation({
      operationId: "searchOffersLegacy",
      tags: ["Search"],
      summary: "Search offers with the legacy Mongo-backed implementation",
      description:
        "Legacy search endpoint retained for compatibility. New integrations should prefer POST /search/v2/search.",
      parameters: [parameterRef("country")],
      requestBody: jsonBody("Search filters and sort options.", ref("SearchBody")),
      response: {
        type: "object",
        required: ["elements", "page", "limit", "query"],
        additionalProperties: false,
        properties: {
          elements: {
            type: "array",
            items: ref("Offer"),
          },
          page: { type: "integer" },
          limit: { type: "integer" },
          query: { type: "string" },
        },
      },
    }),
  },
  "/search/{id}": {
    get: operation({
      operationId: "getSavedSearchQuery",
      tags: ["Search"],
      summary: "Get a saved legacy search query by hash",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          description: "Saved query hash returned by POST /search.",
          schema: { type: "string" },
        },
      ],
      response: ref("SearchBody"),
    }),
  },
  "/search/{id}/count": {
    get: operation({
      operationId: "countSavedSearchResults",
      tags: ["Search"],
      summary: "Get facet counts for a saved legacy search query",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          description: "Saved query hash returned by POST /search.",
          schema: { type: "string" },
        },
        parameterRef("country"),
      ],
      response: {
        type: "object",
        additionalProperties: true,
        properties: {
          tagCounts: {
            type: "array",
            items: { type: "object", additionalProperties: true },
          },
          offerTypeCounts: {
            type: "array",
            items: { type: "object", additionalProperties: true },
          },
          total: { type: "integer" },
          developer: {
            type: "array",
            items: { type: "object", additionalProperties: true },
          },
          publisher: {
            type: "array",
            items: { type: "object", additionalProperties: true },
          },
          priceRange: { type: "object", additionalProperties: true },
        },
      },
    }),
  },
  "/search/tags": {
    get: operation({
      operationId: "listSearchTags",
      tags: ["Search"],
      summary: "List searchable active tags",
      response: arrayOf({
        type: "object",
        additionalProperties: true,
      }),
    }),
  },
  "/search/offer-types": {
    get: operation({
      operationId: "listSearchOfferTypes",
      tags: ["Search"],
      summary: "List available offer types with counts",
      response: arrayOf({
        type: "object",
        properties: {
          _id: { type: "string" },
          count: { type: "integer" },
        },
        additionalProperties: true,
      }),
    }),
  },
  "/search/developers": {
    get: operation({
      operationId: "listSearchDevelopers",
      tags: ["Search"],
      summary: "List developer facet values",
      parameters: [stringQuery("query", "Optional case-insensitive name filter.")],
      response: arrayOf({
        type: "object",
        properties: {
          _id: { type: "string", nullable: true },
          count: { type: "integer" },
        },
        additionalProperties: true,
      }),
    }),
  },
  "/search/publishers": {
    get: operation({
      operationId: "listSearchPublishers",
      tags: ["Search"],
      summary: "List publisher facet values",
      parameters: [stringQuery("query", "Optional case-insensitive name filter.")],
      response: arrayOf({
        type: "object",
        properties: {
          _id: { type: "string", nullable: true },
          count: { type: "integer" },
        },
        additionalProperties: true,
      }),
    }),
  },
  "/search/changelog": {
    get: operation({
      operationId: "searchChangelog",
      tags: ["Search"],
      summary: "Search changelog records",
      parameters: [
        stringQuery("query", "Search text."),
        stringQuery("type", "Optional context type filter.", "offer"),
        stringQuery("id", "Optional context ID filter."),
        ...pagination,
      ],
      response: {
        type: "object",
        required: ["hits", "estimatedTotalHits", "processingTimeMs", "query"],
        additionalProperties: true,
        properties: {
          hits: {
            type: "array",
            items: ref("ChangelogEntry"),
          },
          estimatedTotalHits: { type: "integer" },
          processingTimeMs: { type: "number" },
          query: { type: "string" },
        },
      },
    }),
  },
  "/sellers": {
    get: operation({
      operationId: "listSellers",
      tags: ["Sellers"],
      summary: "List sellers",
      response: arrayOf(ref("SellerSummary")),
    }),
  },
  "/sellers/{id}": {
    get: operation({
      operationId: "listSellerOffers",
      tags: ["Sellers"],
      summary: "List offers for a seller",
      parameters: [
        ...sellerId,
        ...regionalPagination,
        stringQuery("offerType", "Optional offer type filter.", "BASE_GAME"),
        stringQuery(
          "ignoredSandboxes",
          "Comma-separated sandbox IDs to exclude from the result.",
        ),
      ],
      response: arrayOf(ref("Offer")),
    }),
  },
  "/sellers/{id}/cover": {
    get: operation({
      operationId: "getSellerCoverOffers",
      tags: ["Sellers"],
      summary: "Get representative cover offers for a seller",
      parameters: [...sellerId, parameterRef("country")],
      response: arrayOf(ref("Offer")),
    }),
  },
  "/sellers/{id}/stats": {
    get: operation({
      operationId: "getSellerStats",
      tags: ["Sellers"],
      summary: "Get seller catalog statistics",
      parameters: sellerId,
      response: ref("StatsResponse"),
    }),
  },
  "/stats": {
    get: operation({
      operationId: "getStats",
      tags: ["Stats"],
      summary: "Get global catalog statistics",
      response: ref("StatsResponse"),
    }),
  },
  "/stats/homepage": {
    get: operation({
      operationId: "getHomepageStats",
      tags: ["Stats"],
      summary: "Get statistics used on the egdata.app homepage",
      response: ref("StatsResponse"),
    }),
  },
  "/stats/releases/monthly": {
    get: operation({
      operationId: "getMonthlyReleaseStats",
      tags: ["Stats"],
      summary: "Get monthly release counts",
      response: arrayOf(ref("StatsResponse")),
    }),
  },
  "/stats/releases/yearly": {
    get: operation({
      operationId: "getYearlyReleaseStats",
      tags: ["Stats"],
      summary: "Get yearly release counts",
      response: arrayOf(ref("StatsResponse")),
    }),
  },
  "/stats/creations/monthly": {
    get: operation({
      operationId: "getMonthlyCreationStats",
      tags: ["Stats"],
      summary: "Get monthly catalog creation counts",
      response: arrayOf(ref("StatsResponse")),
    }),
  },
  "/stats/creations/yearly": {
    get: operation({
      operationId: "getYearlyCreationStats",
      tags: ["Stats"],
      summary: "Get yearly catalog creation counts",
      response: arrayOf(ref("StatsResponse")),
    }),
  },
};

export const documentedOperations = Object.entries(paths).flatMap(
  ([path, item]) =>
    (["get", "post", "put", "patch", "delete", "options"] as const).flatMap(
      (method) => {
        const op = item[method];
        return op
          ? [
              {
                method: method.toUpperCase(),
                path,
                operationId: op.operationId,
              },
            ]
          : [];
      },
    ),
);
