import {
  countryParameter,
  cursorParameter,
  defineOperations,
  limitParameter,
  localeParameter,
  pathParameter,
  type V1OperationMetadata,
} from "../route-types.js";

type RequestBody = NonNullable<V1OperationMetadata["requestBody"]>;

const bulkItemsBody: RequestBody = {
  required: true,
  description:
    "Item identifiers to resolve. At most 100 unique identifiers are accepted per request.",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        maxItems: 100,
        items: { type: "string", minLength: 1, maxLength: 200 },
      },
    },
  },
};

const itemIdParameter = (description: string) =>
  pathParameter("id", description);

export const itemsOperations = defineOperations([
  {
    operationId: "listItems",
    method: "GET",
    path: "/v1/items",
    summary: "List catalog items",
    description:
      "Returns catalog items ordered by `lastModifiedDate` descending with `id` ascending as a stable tie-breaker; items without a modification date sort last. Pass `meta.pagination.nextCursor` as `cursor` to fetch the next page.",
    tags: ["Items"],
    scope: "items:read",
    auth: "key",
    paginated: true,
    parameters: [cursorParameter(), limitParameter()],
    legacy: ["/items"],
  },
  {
    operationId: "getItem",
    method: "GET",
    path: "/v1/items/{id}",
    summary: "Get an item",
    description:
      "Returns one catalog item. The catalog `id` is preferred; legacy `_id` values also resolve.",
    tags: ["Items"],
    scope: "items:read",
    auth: "key",
    parameters: [
      itemIdParameter(
        "Item identifier. The catalog `id` is preferred; legacy `_id` values also resolve.",
      ),
    ],
    legacy: ["/items/{id}"],
  },
  {
    operationId: "getItemAssets",
    method: "GET",
    path: "/v1/items/{id}/assets",
    summary: "List item assets",
    description:
      "Returns the asset records whose `itemId` matches the item identifier.",
    tags: ["Items"],
    scope: "items:read",
    auth: "key",
    parameters: [itemIdParameter("Item catalog id.")],
    responseDescription: "Array of serialized asset documents.",
    legacy: ["/items/{id}/assets"],
  },
  {
    operationId: "getItemBuilds",
    method: "GET",
    path: "/v1/items/{id}/builds",
    summary: "List item builds",
    description:
      "Returns build summaries for every app referenced by the item's release info, including manifest status, platform, and size metadata.",
    tags: ["Items"],
    scope: "items:read",
    auth: "key",
    parameters: [itemIdParameter("Item catalog id.")],
    responseDescription: "Array of build summaries with ISO 8601 timestamps.",
    legacy: ["/items/{id}/builds"],
  },
  {
    operationId: "getItemChangelog",
    method: "GET",
    path: "/v1/items/{id}/changelog",
    summary: "List item changelog entries",
    description:
      "Returns changelog entries for the item, its assets, and its builds as `{ metadata, timestamp, document }` rows ordered by `timestamp` descending with `_id` descending as a stable tie-breaker. Pass `meta.pagination.nextCursor` as `cursor` to fetch the next page.",
    tags: ["Items"],
    scope: "items:read",
    auth: "key",
    paginated: true,
    parameters: [
      itemIdParameter("Item catalog id."),
      cursorParameter(),
      limitParameter(),
    ],
    responseDescription:
      "Array of changelog entries shaped as `{ metadata, timestamp, document }`.",
    legacy: ["/items/{id}/changelog"],
  },
  {
    operationId: "getItemOffer",
    method: "GET",
    path: "/v1/items/{id}/offer",
    summary: "Get the current base-game offer for an item",
    description:
      "Selects the current base-game offer for the item, preferring offers that are not pre-purchases, and returns it with the current regional price. Offers are filtered by country eligibility before selection.",
    tags: ["Items"],
    scope: "items:read",
    auth: "key",
    parameters: [
      itemIdParameter("Item catalog id."),
      countryParameter(),
      localeParameter(),
    ],
    legacy: ["/items/{id}/offer"],
  },
  {
    operationId: "getItemsBulk",
    method: "POST",
    path: "/v1/items/bulk",
    summary: "Get multiple items",
    description:
      "Resolves up to 100 item identifiers in one request. Found items are returned in input order, and identifiers that do not resolve are listed in `meta.missing`.",
    tags: ["Items"],
    scope: "items:read",
    auth: "key",
    requestBody: bulkItemsBody,
    responseDescription:
      "Array of serialized items in input order; unresolved identifiers are listed in `meta.missing`.",
    legacy: ["/items/bulk"],
  },
  {
    operationId: "getOffersForItemsBulk",
    method: "POST",
    path: "/v1/items/bulk/offers",
    summary: "Get the best current offer for multiple items",
    description:
      "Resolves up to 100 item identifiers and returns one offer per item, combining direct item links with `offersubitems` mappings and ranking base games ahead of other offer types and released offers ahead of pre-purchases. Country-ineligible offers are skipped.",
    tags: ["Items"],
    scope: "items:read",
    auth: "key",
    parameters: [countryParameter(), localeParameter()],
    requestBody: bulkItemsBody,
    responseDescription:
      "Object keyed by each input item identifier; every value is a serialized offer or null.",
    legacy: ["/items/bulk/offers"],
  },
] as const);
