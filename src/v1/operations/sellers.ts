import {
  countryParameter,
  cursorParameter,
  defineOperations,
  limitParameter,
  localeParameter,
  pathParameter,
  queryParameter,
} from "../route-types.js";

const sellerIdParameter = (description: string) =>
  pathParameter("id", description);

export const sellersOperations = defineOperations([
  {
    operationId: "listSellers",
    method: "GET",
    path: "/v1/sellers",
    summary: "List sellers",
    description:
      "Returns the bounded reference list of sellers referenced by at least one offer, sorted by display name. The list is not paginated; `meta.truncated` reports whether the safety cap was reached.",
    tags: ["Sellers"],
    scope: "offers:read",
    auth: "key",
    responseDescription: "Bounded array of serialized sellers.",
    legacy: ["/sellers"],
  },
  {
    operationId: "listSellerOffers",
    method: "GET",
    path: "/v1/sellers/{id}",
    summary: "List offers for a seller",
    description:
      "Returns a cursor-paginated list of the seller's offers with the current regional price attached, ordered by `lastModifiedDate` descending with `id` ascending as a stable tie-breaker. Use `offerType` to restrict the offer type and `ignoredSandboxes` to exclude namespaces.",
    tags: ["Sellers"],
    scope: "offers:read",
    auth: "key",
    paginated: true,
    expensivePolicy: "heavy",
    parameters: [
      sellerIdParameter("Seller identifier (`seller.id` on offers)."),
      cursorParameter(),
      limitParameter(),
      countryParameter(),
      localeParameter(),
      queryParameter(
        "offerType",
        "Restrict results to an exact Epic offer type, for example `BASE_GAME` or `DLC`.",
        { type: "string", maxLength: 64 },
      ),
      queryParameter(
        "ignoredSandboxes",
        "Comma-separated namespace identifiers whose offers must be excluded.",
        { type: "string" },
      ),
    ],
    legacy: ["/sellers/{id}"],
  },
  {
    operationId: "getSellerCoverOffers",
    method: "GET",
    path: "/v1/sellers/{id}/cover",
    summary: "Get cover offers for a seller",
    description:
      "Returns up to five offers from the top-sellers collection for the seller, falling back to the seller's most recently modified offers. Each offer carries the current regional price and the response carries localization metadata.",
    tags: ["Sellers"],
    scope: "offers:read",
    auth: "key",
    expensivePolicy: "heavy",
    parameters: [
      sellerIdParameter("Seller identifier (`seller.id` on offers)."),
      countryParameter(),
      localeParameter(),
    ],
    responseDescription:
      "Up to five serialized offers with current regional prices.",
    legacy: ["/sellers/{id}/cover"],
  },
  {
    operationId: "getSellerStats",
    method: "GET",
    path: "/v1/sellers/{id}/stats",
    summary: "Get seller statistics",
    description:
      "Returns offer, item, game, and free-game counts for the seller, together with the serialized seller record.",
    tags: ["Sellers"],
    scope: "offers:read",
    auth: "key",
    parameters: [sellerIdParameter("Seller document `_id`.")],
    responseDescription:
      "Object with `offers`, `items`, `games`, `freegames`, and `seller`.",
    legacy: ["/sellers/{id}/stats"],
  },
] as const);
