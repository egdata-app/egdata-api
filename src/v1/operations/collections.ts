import {
  countryParameter,
  cursorParameter,
  defineOperations,
  limitParameter,
  localeParameter,
  pathParameter,
  type V1Parameter,
} from "../route-types.js";

const weekParameter: V1Parameter = {
  name: "week",
  in: "path",
  required: true,
  description:
    "ISO week in `YYYYWNN` format, for example `2025W31`. Weeks start on Monday in UTC; `end` is exclusive.",
  schema: { type: "string", pattern: "^\\d{4}W\\d{2}$" },
};

export const collectionsOperations = defineOperations([
  {
    operationId: "getCollection",
    method: "GET",
    path: "/v1/collections/{slug}",
    summary: "Get a collection",
    description:
      "Cursor-paginated collection positions ordered by `position` ascending with the offer ID as a unique tie-breaker. Positions with a non-positive position are excluded. `country` selects the pricing region and `locale` localizes offer text; cookies are never used. Cursors are bound to the collection, ordering, country, locale, and page size.",
    tags: ["Collections"],
    scope: "offers:read",
    auth: "key",
    paginated: true,
    expensivePolicy: "heavy",
    parameters: [
      pathParameter("slug", "Collection slug."),
      countryParameter(),
      localeParameter(),
      limitParameter(100),
      cursorParameter(),
    ],
    responseDescription:
      "`data` is the page of expanded localized offers with `position`, `previousPosition`, and the source position document in `metadata`; `meta` carries `title`, `updatedAt`, and `pagination`.",
    legacy: ["/collections/{slug}"],
  },
  {
    operationId: "getCollectionWeek",
    method: "GET",
    path: "/v1/collections/{slug}/{week}",
    summary: "Get a collection for one ISO week",
    description:
      "Cursor-paginated positions for one ISO week. Each offer is represented by its most recent in-week position; only entries with a positive position are included. The `week` path parameter must match `YYYYWNN` and name a real ISO week, otherwise the endpoint returns a 400 problem instead of the legacy 500. Cursors are bound to the collection, week, ordering, country, locale, and page size.",
    tags: ["Collections"],
    scope: "offers:read",
    auth: "key",
    paginated: true,
    expensivePolicy: "heavy",
    parameters: [
      pathParameter("slug", "Collection slug."),
      weekParameter,
      countryParameter(),
      localeParameter(),
      limitParameter(100),
      cursorParameter(),
    ],
    responseDescription:
      "`data` is the page of expanded localized offers with week position metadata; `meta` carries `title`, `updatedAt`, `start`, `end`, and `pagination`.",
    legacy: ["/collections/{slug}/{week}"],
  },
] as const);
