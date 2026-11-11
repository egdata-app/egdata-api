import {
  countryParameter,
  cursorParameter,
  defineOperations,
  limitParameter,
  localeParameter,
  queryParameter,
} from "../route-types.js";

export const multisearchOperations = defineOperations([
  {
    operationId: "multisearchOffers",
    method: "GET",
    path: "/v1/multisearch/offers",
    summary: "Cross-catalog offer search",
    description:
      "OpenSearch offer search with legacy multisearch filters. Cursor pagination uses search_after.",
    tags: ["Search"],
    scope: "search:read",
    auth: "key",
    paginated: true,
    expensivePolicy: "heavy",
    legacy: ["/multisearch/offers"],
    parameters: [
      queryParameter("query", "Free-text query or Epic Store URL."),
      queryParameter("offerType", "Exact offer type."),
      queryParameter("tags", "Comma-separated tag IDs."),
      queryParameter("categories", "Comma-separated categories."),
      queryParameter("customAttributes", "Comma-separated custom attributes."),
      queryParameter("seller", "Seller ID."),
      queryParameter("developerDisplayName", "Developer display name."),
      queryParameter("publisherDisplayName", "Publisher display name."),
      queryParameter("refundType", "Refund type."),
      queryParameter(
        "isCodeRedemptionOnly",
        "Filter code-redemption-only offers.",
        {
          type: "boolean",
        },
      ),
      queryParameter("excludeBlockchain", "Exclude blockchain offers.", {
        type: "boolean",
      }),
      queryParameter("pastGiveaways", "Only offers with giveaway history.", {
        type: "boolean",
      }),
      queryParameter("onSale", "Only discounted offers.", { type: "boolean" }),
      queryParameter("isLowestPrice", "Only lowest-price offers.", {
        type: "boolean",
      }),
      queryParameter("isLowestPriceEver", "Only historical-lowest offers.", {
        type: "boolean",
      }),
      queryParameter("priceMin", "Minimum discount price.", {
        type: "integer",
      }),
      queryParameter("priceMax", "Maximum discount price.", {
        type: "integer",
      }),
      queryParameter("sortBy", "Sort field.", { type: "string" }),
      queryParameter("sortDir", "Sort direction.", {
        type: "string",
        enum: ["asc", "desc"],
      }),
      countryParameter(),
      localeParameter(),
      limitParameter(100),
      cursorParameter(),
    ],
  },
  {
    operationId: "multisearchItems",
    method: "GET",
    path: "/v1/multisearch/items",
    summary: "Cross-catalog item search",
    tags: ["Search", "Items"],
    scope: "items:read",
    auth: "key",
    paginated: true,
    expensivePolicy: "heavy",
    legacy: ["/multisearch/items"],
    parameters: [
      queryParameter("query", "Free-text item query."),
      queryParameter("type", "Entitlement type filter."),
      limitParameter(100),
      cursorParameter(),
    ],
  },
  {
    operationId: "multisearchSellers",
    method: "GET",
    path: "/v1/multisearch/sellers",
    summary: "Cross-catalog seller search",
    tags: ["Search", "Sellers"],
    scope: "search:read",
    auth: "key",
    expensivePolicy: "heavy",
    legacy: ["/multisearch/sellers"],
    parameters: [
      queryParameter("query", "Seller name query."),
      queryParameter("limit", "Maximum sellers (1-100).", {
        type: "integer",
        minimum: 1,
        maximum: 100,
        default: 20,
      }),
    ],
  },
] as const);
