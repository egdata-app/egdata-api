import type { OpenAPIV3 } from "openapi-types";
import { jsonContent } from "./components.js";
import {
  arrayOf,
  operation,
  parameterRef,
  ref,
  stringQuery,
} from "./helpers.js";
import type { EgdataPaths } from "./types.js";

const pagination = [parameterRef("page"), parameterRef("limit")];
const localizedPagination = [parameterRef("locale"), ...pagination];
const regionalLocalizedPagination = [
  parameterRef("country"),
  parameterRef("locale"),
  ...pagination,
];
const offerId = [parameterRef("offerId")];
const localizedOfferId = [...offerId, parameterRef("locale")];
const regionalLocalizedOfferId = [
  ...offerId,
  parameterRef("country"),
  parameterRef("locale"),
];
const itemId = [parameterRef("itemId")];
const sandboxId = [parameterRef("sandboxId")];
const sellerId = [parameterRef("sellerId")];
const buildId: OpenAPIV3.ParameterObject = {
  name: "id",
  in: "path",
  required: true,
  description: "Mongo build document identifier.",
  schema: { type: "string" },
};
const buildPage: OpenAPIV3.ParameterObject = {
  name: "page",
  in: "query",
  required: false,
  description:
    "One-based page number. Build endpoints reject requests whose calculated offset exceeds 100,000 records.",
  schema: { type: "integer", minimum: 1, maximum: 100_001, default: 1 },
};
const buildLimit: OpenAPIV3.ParameterObject = {
  name: "limit",
  in: "query",
  required: false,
  description: "Maximum records per page.",
  schema: { type: "integer", minimum: 1, maximum: 100 },
};
const buildPagination = [buildPage, buildLimit];
const targetBuildId: OpenAPIV3.ParameterObject = {
  name: "targetId",
  in: "path",
  required: true,
  description: "Target build identifier.",
  schema: { type: "string" },
};
const baseBuildId: OpenAPIV3.ParameterObject = {
  name: "baseId",
  in: "path",
  required: true,
  description: "Baseline build identifier.",
  schema: { type: "string" },
};
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

const launcherIdentity: OpenAPIV3.SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["artifactId", "catalogItemId", "catalogNamespace"],
  properties: {
    artifactId: { type: "string", maxLength: 256 },
    catalogItemId: { type: "string", maxLength: 256 },
    catalogNamespace: { type: "string", maxLength: 256 },
  },
};

const launcherResolverRequest: OpenAPIV3.SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["requestId", "buildAppName", "buildVersion", "platform"],
        properties: {
          requestId: { type: "string", minLength: 1, maxLength: 128 },
          buildAppName: { type: "string", minLength: 1, maxLength: 256 },
          buildVersion: { type: "string", maxLength: 512 },
          platform: { type: "string", enum: ["Windows"] },
          catalogHint: launcherIdentity,
        },
      },
    },
  },
};

const launcherResolverResponse: OpenAPIV3.SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      maxItems: 100,
      items: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["requestId", "status", "record"],
            properties: {
              requestId: { type: "string" },
              status: { type: "string", enum: ["resolved"] },
              record: {
                type: "object",
                additionalProperties: false,
                required: [
                  "artifactId",
                  "catalogItemId",
                  "catalogNamespace",
                  "displayName",
                  "kind",
                  "appCategories",
                  "mainGame",
                  "mandatoryAppFolderName",
                  "canRunOffline",
                  "requiresAuth",
                  "ownershipToken",
                  "ignoredProcessNames",
                ],
                properties: {
                  ...launcherIdentity.properties,
                  displayName: { type: "string" },
                  kind: {
                    type: "string",
                    enum: ["base-game", "addon", "digital-extra"],
                  },
                  appCategories: { type: "array", items: { type: "string" } },
                  mainGame: { ...launcherIdentity, nullable: true },
                  mandatoryAppFolderName: { type: "string" },
                  canRunOffline: { type: "boolean" },
                  requiresAuth: { type: "boolean" },
                  ownershipToken: { type: "boolean" },
                  ignoredProcessNames: {
                    type: "array",
                    items: { type: "string" },
                  },
                },
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["requestId", "status"],
            properties: {
              requestId: { type: "string" },
              status: {
                type: "string",
                enum: ["not-found", "ambiguous", "unsupported"],
              },
            },
          },
        ],
      },
    },
  },
};

export const paths: EgdataPaths = {
  "/catalog/hydrate": {
    post: operation({
      operationId: "hydrateCatalogGraph",
      tags: ["Catalog"],
      summary: "Hydrate catalog records for known technical identifiers",
      description:
        "Resolves up to 25 item, asset, or release-app roots directly from the catalog collections. The response is NDJSON with one isolated, content-hashed graph result per line.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: ref("CatalogHydrationRequest"),
          },
        },
      },
      response: {
        200: {
          description:
            "An NDJSON stream of resolved, unchanged, not-found, or isolated error results. Each decoded line is at most 2 MiB and 500 records.",
          content: {
            "application/x-ndjson": {
              schema: {
                type: "string",
                description:
                  "Newline-delimited CatalogHydrationRootResult objects.",
              },
            },
          },
        },
        400: {
          description: "The hydration batch is malformed.",
          content: {
            "application/json": jsonContent(ref("ErrorResponse")),
          },
        },
        413: {
          description: "The request body is too large.",
          content: {
            "application/json": jsonContent(ref("ErrorResponse")),
          },
        },
        503: {
          description: "Catalog hydration is temporarily unavailable.",
          content: {
            "application/json": jsonContent(ref("ErrorResponse")),
          },
        },
      },
    }),
  },
  "/health": {
    get: operation({
      operationId: "getHealth",
      tags: ["System"],
      summary: "Check API dependency health",
      description: "Reports Redis and MongoDB connectivity and latency.",
      response: ref("HealthResponse"),
    }),
  },
  "/builds": {
    get: operation({
      operationId: "listBuilds",
      tags: ["Builds"],
      summary: "List observed builds",
      parameters: [
        ...buildPagination,
        stringQuery(
          "sortBy",
          "Sort field: createdAt, updatedAt, or firstSeenAt.",
          "firstSeenAt",
          { enum: ["createdAt", "updatedAt", "firstSeenAt"] },
        ),
        stringQuery("sortDir", "Sort direction: asc or desc.", "desc", {
          enum: ["asc", "desc"],
        }),
      ],
      response: arrayOf(ref("Build")),
    }),
  },
  "/builds/resolve-launcher-records": {
    post: operation({
      operationId: "resolveLauncherRecords",
      tags: ["Builds"],
      summary: "Resolve parsed Windows manifests to launcher metadata",
      description:
        "Resolves bounded, path-free metadata from parsed binary manifests. Ambiguous catalog, asset, and parent relationships are returned without guessing.",
      requestBody: jsonBody(
        "Up to 100 parsed Windows manifest candidates. Local paths and manifest bytes are not accepted.",
        launcherResolverRequest,
      ),
      response: {
        200: {
          description: "A result for each candidate in request order.",
          content: {
            "application/json": jsonContent(launcherResolverResponse),
          },
        },
        400: {
          description:
            "The request did not satisfy the bounded resolver contract.",
          content: { "application/json": jsonContent(ref("ErrorResponse")) },
        },
      },
    }),
  },
  "/builds/{id}": {
    get: operation({
      operationId: "getBuild",
      tags: ["Builds"],
      summary: "Get a sanitized build snapshot",
      parameters: [buildId],
      response: ref("Build"),
    }),
  },
  "/builds/{id}/history": {
    get: operation({
      operationId: "getBuildHistory",
      tags: ["Builds"],
      summary: "List comparison candidates for a build",
      description:
        "Returns chronological observations for the same stream or platform and identifies the previous comparable snapshot.",
      parameters: [
        buildId,
        ...buildPagination,
        stringQuery("scope", "Candidate scope: stream or platform.", "stream", {
          enum: ["stream", "platform"],
        }),
      ],
      response: ref("BuildHistoryResponse"),
    }),
  },
  "/builds/{targetId}/compare/{baseId}": {
    get: operation({
      operationId: "compareBuilds",
      tags: ["Builds"],
      summary: "Compare two stored build snapshots",
      description:
        "Compares immutable file snapshots by full path. Full-download deltas are not patch-download estimates.",
      parameters: [
        targetBuildId,
        baseBuildId,
        ...buildPagination,
        stringQuery(
          "status",
          "Comma-separated added, removed, modified, or unchanged statuses.",
          "added,modified,removed",
          {
            pattern:
              "^(added|removed|modified|unchanged)(,(added|removed|modified|unchanged))*$",
          },
        ),
        stringQuery("q", "Literal case-insensitive file path search."),
        stringQuery(
          "extension",
          "Comma-separated file extensions without leading dots.",
          "pak,dll",
        ),
        stringQuery("dir", "Path order: asc or desc.", "asc", {
          enum: ["asc", "desc"],
        }),
      ],
      response: {
        200: {
          description: "Build comparison.",
          content: {
            "application/json": jsonContent(ref("BuildComparisonResponse")),
          },
        },
        409: {
          description:
            "One or both builds do not have a comparable stored snapshot.",
          content: { "application/json": jsonContent(ref("ErrorResponse")) },
        },
      },
    }),
  },
  "/builds/{id}/files": {
    get: operation({
      operationId: "listBuildFiles",
      tags: ["Builds"],
      summary: "List files in a build snapshot",
      parameters: [
        buildId,
        ...buildPagination,
        stringQuery("q", "Literal case-insensitive file path search."),
        stringQuery("extension", "Comma-separated file extensions."),
        stringQuery(
          "sort",
          "Sort field: depth, fileName, or fileSize.",
          "depth",
          { enum: ["depth", "fileName", "fileSize"] },
        ),
        stringQuery("dir", "Sort direction: asc or desc.", "asc", {
          enum: ["asc", "desc"],
        }),
      ],
      response: ref("BuildFileListResponse"),
    }),
  },
  "/builds/{id}/tree": {
    get: operation({
      operationId: "getBuildFileTree",
      tags: ["Builds"],
      summary: "Expand one directory of a build file tree",
      description:
        "Returns only immediate child files and directories. Expand a directory by passing the path returned for that directory.",
      parameters: [
        buildId,
        ...buildPagination,
        stringQuery(
          "path",
          "Relative directory to expand, using forward slashes. Omit for the build root.",
        ),
      ],
      response: ref("BuildFileTreeResponse"),
    }),
  },
  "/builds/{id}/items": {
    get: operation({
      operationId: "listBuildItems",
      tags: ["Builds"],
      summary: "List catalog items associated with a build",
      parameters: [buildId, ...buildPagination],
      response: ref("BuildItemsResponse"),
    }),
  },
  "/builds/{id}/install-options": {
    get: operation({
      operationId: "getBuildInstallOptions",
      tags: ["Builds"],
      summary: "Summarize install tags in a build",
      parameters: [buildId],
      response: ref("BuildInstallOptions"),
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
      parameters: [parameterRef("country"), parameterRef("locale")],
      response: arrayOf(ref("Offer")),
    }),
  },
  "/featured": {
    get: operation({
      operationId: "listFeaturedGames",
      tags: ["Catalog"],
      summary: "List featured offers",
      parameters: [parameterRef("locale")],
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
        parameterRef("locale"),
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
      parameters: [parameterRef("country"), parameterRef("locale")],
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
      parameters: regionalLocalizedPagination,
      response: ref("OfferListResponse"),
    }),
  },
  "/offers/{id}": {
    get: operation({
      operationId: "getOffer",
      tags: ["Offers"],
      summary: "Get an offer by ID",
      parameters: localizedOfferId,
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
      parameters: regionalLocalizedPagination,
      response: ref("OfferListResponse"),
    }),
  },
  "/offers/latest-released": {
    get: operation({
      operationId: "listLatestReleasedOffers",
      tags: ["Offers"],
      summary: "List recently released offers",
      parameters: regionalLocalizedPagination,
      response: ref("OfferListResponse"),
    }),
  },
  "/offers/latest-achievements": {
    get: operation({
      operationId: "listLatestAchievementOffers",
      tags: ["Offers"],
      summary: "List recently released base games with achievements",
      parameters: [parameterRef("country"), parameterRef("locale")],
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
      parameters: localizedPagination,
      response: ref("OfferListResponse"),
    }),
  },
  "/offers/top-wishlisted": {
    get: operation({
      operationId: "listTopWishlistedOffers",
      tags: ["Offers"],
      summary: "List top-wishlisted offers",
      parameters: localizedPagination,
      response: ref("OfferListResponse"),
    }),
  },
  "/offers/featured-discounts": {
    get: operation({
      operationId: "listFeaturedDiscounts",
      tags: ["Offers"],
      summary: "List featured discounted offers",
      parameters: [parameterRef("country"), parameterRef("locale")],
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
        ...regionalLocalizedPagination,
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
      parameters: [parameterRef("locale")],
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
      parameters: regionalLocalizedOfferId,
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
      parameters: regionalLocalizedOfferId,
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
      parameters: regionalLocalizedOfferId,
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
      parameters: regionalLocalizedOfferId,
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
      parameters: regionalLocalizedOfferId,
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
      parameters: regionalLocalizedOfferId,
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
      parameters: regionalLocalizedOfferId,
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
      parameters: regionalLocalizedOfferId,
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
      parameters: [parameterRef("locale")],
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
      parameters: [...itemId, parameterRef("locale")],
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
        parameterRef("locale"),
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
      parameters: [
        ...sandboxId,
        parameterRef("country"),
        parameterRef("locale"),
      ],
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
      parameters: [parameterRef("locale")],
      response: ref("FreeGamesResponse"),
    }),
  },
  "/free-games/history": {
    get: operation({
      operationId: "listFreeGamesHistory",
      tags: ["Free Games"],
      summary: "List historical free game promotions",
      parameters: localizedPagination,
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
        parameterRef("locale"),
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
      parameters: [parameterRef("country"), parameterRef("locale")],
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
      parameters: [parameterRef("country"), parameterRef("locale")],
      requestBody: jsonBody(
        "Search filters and sort options.",
        ref("SearchBody"),
      ),
      response: ref("SearchResponse"),
    }),
  },
  "/search/natural-language": {
    post: operation({
      operationId: "searchOffersWithNaturalLanguage",
      tags: ["Search"],
      summary: "Search offers with natural language",
      description:
        "Embeds the query with Cloudflare Workers AI, ranks offer vectors in Cloudflare Vectorize, and hydrates each match from canonical Mongo offer documents using its indexed offer ID. Stale vectors that no longer resolve to an offer are omitted.",
      parameters: [parameterRef("locale")],
      requestBody: jsonBody(
        "Natural-language query and result limit.",
        ref("NaturalLanguageSearchBody"),
      ),
      response: {
        200: {
          description: "Ranked, hydrated offer matches.",
          content: {
            "application/json": jsonContent(
              ref("NaturalLanguageSearchResponse"),
            ),
          },
        },
        502: {
          description: "Cloudflare Workers AI or Vectorize is unavailable.",
          content: {
            "application/json": jsonContent(ref("ErrorResponse")),
          },
        },
        503: {
          description: "Natural-language search is not configured.",
          content: {
            "application/json": jsonContent(ref("ErrorResponse")),
          },
        },
      },
    }),
  },
  "/search": {
    post: operation({
      operationId: "searchOffersLegacy",
      tags: ["Search"],
      summary: "Search offers with the legacy Mongo-backed implementation",
      description:
        "Legacy search endpoint retained for compatibility. New integrations should prefer POST /search/v2/search.",
      parameters: [parameterRef("country"), parameterRef("locale")],
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
        ...regionalLocalizedPagination,
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
      parameters: [
        ...sellerId,
        parameterRef("country"),
        parameterRef("locale"),
      ],
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
