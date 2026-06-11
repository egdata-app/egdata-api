import type { OpenAPIV3 } from "openapi-types";
import {
  arrayOf,
  operation,
  parameterRef,
  ref,
  stringQuery,
} from "./helpers.js";
import type { EgdataPaths } from "./types.js";

const pagination = [parameterRef("page"), parameterRef("limit")];
const regionalPagination = [parameterRef("country"), ...pagination];
const offerId = [parameterRef("offerId")];
const itemId = [parameterRef("itemId")];
const sandboxId = [parameterRef("sandboxId")];
const sellerId = [parameterRef("sellerId")];
const flexibleObjectResponse = (
  description?: string,
): OpenAPIV3.SchemaObject => ({
  type: "object",
  ...(description ? { description } : {}),
  additionalProperties: true,
});
const nullableOffer = {
  allOf: [{ $ref: "#/components/schemas/Offer" }],
  nullable: true,
} satisfies OpenAPIV3.SchemaObject;

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
      description:
        "Returns price history for a country-derived region, an explicit region, or all regions when neither is provided.",
      parameters: [
        ...offerId,
        parameterRef("country"),
        parameterRef("region"),
        parameterRef("since"),
      ],
      response: arrayOf(ref("Price")),
    }),
  },
  "/offers/{id}/regional-price": {
    get: operation({
      operationId: "getOfferRegionalPrices",
      tags: ["Prices"],
      summary: "Get prices for an offer across regions",
      parameters: [...offerId, parameterRef("country")],
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
  "/offers/{id}/franchises": {
    get: operation({
      operationId: "listOfferFranchises",
      tags: ["Offer Details"],
      summary: "List franchises for an offer",
      parameters: offerId,
      response: arrayOf(flexibleObjectResponse("Franchise metadata.")),
    }),
  },
  "/offers/{id}/features": {
    get: operation({
      operationId: "getOfferFeatures",
      tags: ["Offer Details"],
      summary: "Get feature flags for an offer",
      parameters: offerId,
      response: flexibleObjectResponse("Derived store feature flags."),
    }),
  },
  "/offers/{id}/assets": {
    get: operation({
      operationId: "listOfferAssets",
      tags: ["Offer Details"],
      summary: "List assets for an offer",
      parameters: offerId,
      response: arrayOf(ref("Asset")),
    }),
  },
  "/offers/{id}/items": {
    get: operation({
      operationId: "listOfferItems",
      tags: ["Offer Details"],
      summary: "List items for an offer",
      parameters: offerId,
      response: arrayOf(ref("Item")),
    }),
  },
  "/offers/{id}/changelog": {
    get: operation({
      operationId: "listOfferChangelog",
      tags: ["Offer Details"],
      summary: "List changelog entries for an offer",
      parameters: [
        ...offerId,
        ...pagination,
        stringQuery("query", "Optional full-text changelog search."),
        stringQuery("type", "Optional change type filter."),
        stringQuery("field", "Optional changed field filter."),
      ],
      response: {
        type: "object",
        additionalProperties: false,
        required: [
          "elements",
          "page",
          "limit",
          "totalCount",
          "totalPages",
          "hasNextPage",
          "hasPreviousPage",
        ],
        properties: {
          elements: {
            type: "array",
            items: ref("ChangelogEntry"),
          },
          page: { type: "integer" },
          limit: { type: "integer" },
          totalCount: { type: "integer" },
          totalPages: { type: "integer" },
          hasNextPage: { type: "boolean" },
          hasPreviousPage: { type: "boolean" },
        },
      },
    }),
  },
  "/offers/{id}/changelog/stats": {
    get: operation({
      operationId: "getOfferChangelogStats",
      tags: ["Offer Details"],
      summary: "Get offer changelog statistics",
      parameters: [
        ...offerId,
        stringQuery("from", "Start timestamp for the stats window."),
        stringQuery("to", "End timestamp for the stats window."),
      ],
      response: flexibleObjectResponse(
        "Changelog counts by day, weekday, type, and field.",
      ),
    }),
  },
  "/offers/{id}/achievements": {
    get: operation({
      operationId: "listOfferAchievements",
      tags: ["Offer Details"],
      summary: "List achievement sets for an offer",
      parameters: offerId,
      response: arrayOf(ref("AchievementSet")),
    }),
  },
  "/offers/{id}/related": {
    get: operation({
      operationId: "listRelatedOffers",
      tags: ["Offer Details"],
      summary: "List related offers in the same sandbox",
      parameters: [...offerId, parameterRef("country")],
      response: arrayOf(ref("Offer")),
    }),
  },
  "/offers/{id}/mappings": {
    get: operation({
      operationId: "getOfferMappings",
      tags: ["Offer Details"],
      summary: "Get store mappings for an offer",
      parameters: offerId,
      response: flexibleObjectResponse("Store mapping metadata."),
    }),
  },
  "/offers/{id}/media": {
    get: operation({
      operationId: "getOfferMedia",
      tags: ["Offer Details"],
      summary: "Get media metadata for an offer",
      parameters: offerId,
      response: flexibleObjectResponse(
        "Screenshots, trailers, and other media metadata.",
      ),
    }),
  },
  "/offers/{id}/suggestions": {
    get: operation({
      operationId: "listOfferSuggestions",
      tags: ["Offer Details"],
      summary: "List suggested offers",
      parameters: [...offerId, parameterRef("country")],
      response: arrayOf(ref("Offer")),
    }),
  },
  "/offers/{id}/age-rating": {
    get: operation({
      operationId: "getOfferAgeRating",
      tags: ["Offer Details"],
      summary: "Get age rating metadata for an offer",
      parameters: [
        ...offerId,
        parameterRef("country"),
        stringQuery(
          "single",
          "When present, return the country-specific rating only.",
        ),
      ],
      response: flexibleObjectResponse(
        "Age rating metadata keyed by rating authority.",
      ),
    }),
  },
  "/offers/{id}/giveaways": {
    get: operation({
      operationId: "listOfferGiveaways",
      tags: ["Offer Details"],
      summary: "List free-game promotions for an offer",
      parameters: offerId,
      response: arrayOf(flexibleObjectResponse("Free-game promotion record.")),
    }),
  },
  "/offers/{id}/ratings": {
    get: operation({
      operationId: "getOfferRatings",
      tags: ["Offer Details"],
      summary: "Get external ratings for an offer",
      parameters: offerId,
      response: flexibleObjectResponse("External ratings metadata."),
    }),
  },
  "/offers/{id}/tops": {
    get: operation({
      operationId: "getOfferTopPositions",
      tags: ["Offer Details"],
      summary: "Get top-list positions for an offer",
      parameters: offerId,
      response: {
        type: "object",
        additionalProperties: { type: "integer" },
      },
    }),
  },
  "/offers/{id}/polls": {
    get: operation({
      operationId: "getOfferPolls",
      tags: ["Offer Details"],
      summary: "Get community poll data for an offer",
      parameters: offerId,
      response: flexibleObjectResponse("Community poll data."),
    }),
  },
  "/offers/{id}/hltb": {
    get: operation({
      operationId: "getOfferHowLongToBeat",
      tags: ["Offer Details"],
      summary: "Get HowLongToBeat data for an offer",
      parameters: offerId,
      response: flexibleObjectResponse("HowLongToBeat metadata."),
    }),
  },
  "/offers/{id}/collection": {
    get: operation({
      operationId: "listOfferCollectionOffers",
      tags: ["Offer Details"],
      summary: "List collection offers for an offer",
      parameters: [...offerId, parameterRef("country")],
      response: arrayOf(ref("Offer")),
    }),
  },
  "/offers/{id}/collections/{collection}": {
    get: operation({
      operationId: "getOfferCollectionPosition",
      tags: ["Offer Details"],
      summary: "Get an offer position within a collection",
      parameters: [...offerId, parameterRef("collection")],
      response: flexibleObjectResponse("Collection position metadata."),
    }),
  },
  "/offers/{id}/bundle": {
    get: operation({
      operationId: "getOfferBundle",
      tags: ["Offer Details"],
      summary: "Get bundle contents and prices",
      parameters: [...offerId, parameterRef("country")],
      response: {
        type: "object",
        additionalProperties: false,
        required: ["offers", "bundlePrice", "totalPrice"],
        properties: {
          offers: {
            type: "array",
            items: ref("Offer"),
          },
          bundlePrice: {
            allOf: [{ $ref: "#/components/schemas/Price" }],
            nullable: true,
          },
          totalPrice: ref("Price"),
        },
      },
    }),
  },
  "/offers/{id}/in-bundle": {
    get: operation({
      operationId: "listBundlesContainingOffer",
      tags: ["Offer Details"],
      summary: "List bundles that contain an offer",
      parameters: [...offerId, parameterRef("country")],
      response: arrayOf(
        flexibleObjectResponse("Bundle offer and regional price data."),
      ),
    }),
  },
  "/offers/{id}/has-prepurchase": {
    get: operation({
      operationId: "getOfferPrepurchaseAlternative",
      tags: ["Offer Details"],
      summary: "Check whether an offer has a pre-purchase alternative",
      parameters: [...offerId, parameterRef("country")],
      response: {
        type: "object",
        additionalProperties: false,
        required: ["hasPrepurchase"],
        properties: {
          hasPrepurchase: { type: "boolean" },
          offer: nullableOffer,
        },
      },
    }),
  },
  "/offers/{id}/has-regular": {
    get: operation({
      operationId: "getOfferRegularAlternative",
      tags: ["Offer Details"],
      summary: "Check whether a pre-purchase offer has a regular alternative",
      parameters: [...offerId, parameterRef("country")],
      response: {
        type: "object",
        additionalProperties: false,
        required: ["isPrepurchase"],
        properties: {
          isPrepurchase: { type: "boolean" },
          offer: nullableOffer,
        },
      },
    }),
  },
  "/offers/{id}/genres": {
    get: operation({
      operationId: "listOfferDetailGenres",
      tags: ["Offer Details"],
      summary: "List genre tags for an offer",
      parameters: offerId,
      response: arrayOf(flexibleObjectResponse("Genre tag metadata.")),
    }),
  },
  "/offers/{id}/technologies": {
    get: operation({
      operationId: "listOfferTechnologies",
      tags: ["Offer Details"],
      summary: "List technologies detected in offer builds",
      parameters: offerId,
      response: arrayOf(
        flexibleObjectResponse("Detected technology metadata."),
      ),
    }),
  },
  "/offers/{id}/builds": {
    get: operation({
      operationId: "listOfferBuilds",
      tags: ["Offer Details"],
      summary: "List recent builds for an offer",
      parameters: offerId,
      response: arrayOf(ref("Build")),
    }),
  },
  "/offers/{id}/igdb": {
    get: operation({
      operationId: "getOfferIgdb",
      tags: ["Offer Details"],
      summary: "Get IGDB metadata for an offer",
      parameters: offerId,
      response: flexibleObjectResponse("IGDB metadata."),
    }),
  },
  "/offers/{id}/overview": {
    get: operation({
      operationId: "getOfferOverview",
      tags: ["Offer Details"],
      summary: "Get consolidated overview data for an offer",
      parameters: [...offerId, parameterRef("country")],
      response: {
        type: "object",
        additionalProperties: true,
        properties: {
          offer: ref("Offer"),
          price: {
            allOf: [{ $ref: "#/components/schemas/Price" }],
            nullable: true,
          },
          media: flexibleObjectResponse("Media metadata."),
          igdb: flexibleObjectResponse("IGDB metadata."),
          features: flexibleObjectResponse("Derived feature flags."),
          ageRating: flexibleObjectResponse("Age rating metadata."),
          giveaways: {
            type: "array",
            items: flexibleObjectResponse("Free-game promotion record."),
          },
          polls: flexibleObjectResponse("Community poll data."),
          genres: {
            type: "array",
            items: flexibleObjectResponse("Genre tag metadata."),
          },
          technologies: {
            type: "array",
            items: flexibleObjectResponse("Detected technology metadata."),
          },
        },
      },
    }),
  },
  "/offers/{id}/reviews": {
    get: operation({
      operationId: "listOfferReviews",
      tags: ["Offer Reviews"],
      summary: "List public reviews for an offer",
      parameters: [...offerId, ...pagination, parameterRef("verified")],
      response: ref("ReviewListResponse"),
    }),
  },
  "/offers/{id}/reviews-summary": {
    get: operation({
      operationId: "getOfferReviewsSummary",
      tags: ["Offer Reviews"],
      summary: "Get review summary for an offer",
      parameters: [...offerId, parameterRef("verified")],
      response: ref("ReviewSummary"),
    }),
  },
  "/items": {
    get: operation({
      operationId: "listItems",
      tags: ["Items"],
      summary: "List catalog items",
      description:
        "Returns paginated Epic catalog items sorted by last modification date.",
      parameters: pagination,
      response: ref("ItemListResponse"),
    }),
  },
  "/items/{id}": {
    get: operation({
      operationId: "getItem",
      tags: ["Items"],
      summary: "Get an item by ID",
      description:
        "Looks up an item by Mongo document ID or Epic item ID and expands custom attributes.",
      parameters: itemId,
      response: ref("Item"),
    }),
  },
  "/items/bulk": {
    post: operation({
      operationId: "getItemsBulk",
      tags: ["Items"],
      summary: "Fetch multiple items by ID",
      description: "Fetches up to 100 item IDs in one request.",
      requestBody: jsonBody("Item IDs to fetch.", stringArrayBody("items")),
      response: arrayOf(ref("Item")),
    }),
  },
  "/items/bulk/offers": {
    post: operation({
      operationId: "getOffersForItemsBulk",
      tags: ["Items"],
      summary: "Resolve the best offer for multiple items",
      description:
        "Returns an object keyed by requested item ID. Each value is the best matching offer or null when no offer can be resolved.",
      requestBody: jsonBody("Item IDs to resolve.", stringArrayBody("items")),
      response: {
        type: "object",
        additionalProperties: nullableOffer,
      },
    }),
  },
  "/items/{id}/assets": {
    get: operation({
      operationId: "getItemAssets",
      tags: ["Items"],
      summary: "List assets for an item",
      parameters: itemId,
      response: arrayOf(ref("Asset")),
    }),
  },
  "/items/{id}/builds": {
    get: operation({
      operationId: "getItemBuilds",
      tags: ["Items"],
      summary: "List builds associated with an item",
      parameters: itemId,
      response: arrayOf(ref("Build")),
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
  "/sandboxes": {
    get: operation({
      operationId: "listSandboxes",
      tags: ["Sandboxes"],
      summary: "List sandboxes",
      description:
        "Returns paginated Epic namespaces/sandboxes known to egdata.",
      parameters: pagination,
      response: ref("SandboxListResponse"),
    }),
  },
  "/sandboxes/{sandboxId}": {
    get: operation({
      operationId: "getSandbox",
      tags: ["Sandboxes"],
      summary: "Get a sandbox",
      parameters: sandboxId,
      response: ref("Sandbox"),
    }),
  },
  "/sandboxes/{sandboxId}/items": {
    get: operation({
      operationId: "listSandboxItems",
      tags: ["Sandboxes"],
      summary: "List items in a sandbox",
      parameters: [
        ...sandboxId,
        ...pagination,
        parameterRef("entitlementType"),
        parameterRef("status"),
        parameterRef("platforms"),
        parameterRef("title"),
      ],
      response: {
        type: "object",
        additionalProperties: false,
        required: ["elements", "page", "limit", "count"],
        properties: {
          elements: {
            type: "array",
            items: ref("Item"),
          },
          page: { type: "integer" },
          limit: { type: "integer" },
          count: { type: "integer" },
        },
      },
    }),
  },
  "/sandboxes/{sandboxId}/offers": {
    get: operation({
      operationId: "listSandboxOffers",
      tags: ["Sandboxes"],
      summary: "List offers in a sandbox",
      parameters: [
        ...sandboxId,
        ...pagination,
        parameterRef("sandboxOfferType"),
        parameterRef("title"),
      ],
      response: {
        type: "object",
        additionalProperties: false,
        required: ["elements", "page", "limit", "count"],
        properties: {
          elements: {
            type: "array",
            items: ref("Offer"),
          },
          page: { type: "integer" },
          limit: { type: "integer" },
          count: { type: "integer" },
        },
      },
    }),
  },
  "/sandboxes/{sandboxId}/assets": {
    get: operation({
      operationId: "listSandboxAssets",
      tags: ["Sandboxes"],
      summary: "List assets in a sandbox",
      parameters: [...sandboxId, ...pagination, parameterRef("platform")],
      response: {
        type: "object",
        additionalProperties: false,
        required: ["elements", "page", "limit", "count"],
        properties: {
          elements: {
            type: "array",
            items: ref("Asset"),
          },
          page: { type: "integer" },
          limit: { type: "integer" },
          count: { type: "integer" },
        },
      },
    }),
  },
  "/sandboxes/{sandboxId}/base-game": {
    get: operation({
      operationId: "getSandboxBaseGame",
      tags: ["Sandboxes"],
      summary: "Get the base game for a sandbox",
      description:
        "Returns the base game offer for a sandbox, or an executable item fallback when no offer exists.",
      parameters: [...sandboxId, parameterRef("country")],
      response: flexibleObjectResponse(
        "Base game offer or executable item fallback.",
      ),
    }),
  },
  "/sandboxes/{sandboxId}/achievements": {
    get: operation({
      operationId: "listSandboxAchievements",
      tags: ["Sandboxes"],
      summary: "List achievement sets for a sandbox",
      parameters: sandboxId,
      response: arrayOf(ref("AchievementSet")),
    }),
  },
  "/sandboxes/{sandboxId}/changelog": {
    get: operation({
      operationId: "listSandboxChangelog",
      tags: ["Sandboxes"],
      summary: "List changelog entries for a sandbox",
      parameters: [...sandboxId, ...pagination],
      response: ref("ChangelogSearchResponse"),
    }),
  },
  "/sandboxes/{sandboxId}/builds": {
    get: operation({
      operationId: "listSandboxBuilds",
      tags: ["Sandboxes"],
      summary: "List builds for a sandbox",
      parameters: [...sandboxId, ...pagination, parameterRef("platform")],
      response: {
        type: "object",
        additionalProperties: false,
        required: ["elements", "page", "limit", "count"],
        properties: {
          elements: {
            type: "array",
            items: ref("Build"),
          },
          page: { type: "integer" },
          limit: { type: "integer" },
          count: { type: "integer" },
        },
      },
    }),
  },
  "/sandboxes/{sandboxId}/stats": {
    get: operation({
      operationId: "getSandboxStats",
      tags: ["Sandboxes"],
      summary: "Get sandbox statistics",
      parameters: sandboxId,
      response: ref("SandboxStatsResponse"),
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
      requestBody: jsonBody(
        "Search filters and sort options.",
        ref("SearchBody"),
      ),
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
      requestBody: jsonBody(
        "Search filters and sort options.",
        ref("SearchBody"),
      ),
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
      parameters: [
        stringQuery("query", "Optional case-insensitive name filter."),
      ],
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
      parameters: [
        stringQuery("query", "Optional case-insensitive name filter."),
      ],
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
  "/changelist": {
    get: operation({
      operationId: "listChangelist",
      tags: ["Changelog"],
      summary: "List recent changelog records",
      description:
        "Returns recent changelog entries with best-effort `metadata.context` enrichment. Context is null when unavailable.",
      parameters: pagination,
      response: arrayOf(ref("ChangelogEntry")),
    }),
  },
  "/changelist/{id}": {
    get: operation({
      operationId: "getChangelistEntry",
      tags: ["Changelog"],
      summary: "Get a changelog record",
      description:
        "Returns a single changelog entry with best-effort `metadata.context` enrichment. Missing changelog IDs return 404.",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          description: "Mongo changelog document identifier.",
          schema: {
            type: "string",
            example: "6a2ac641bfc3cf2a0efc8507",
          },
        },
      ],
      response: ref("ChangelogEntry"),
    }),
  },
  "/search/changelog": {
    get: operation({
      operationId: "searchChangelog",
      tags: ["Search"],
      summary: "Search changelog records",
      description:
        "Searches changelog entries and hydrates `metadata.changes[].oldValue` and `newValue` from canonical Mongo records or raw OpenSearch values. Search hits include best-effort `document` enrichment.",
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
