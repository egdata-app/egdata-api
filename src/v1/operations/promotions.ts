import {
  countryParameter,
  cursorParameter,
  defineOperations,
  limitParameter,
  localeParameter,
  pathParameter,
  queryParameter,
} from "../route-types.js";

const PROMOTION_SORT_FIELDS = [
  "releaseDate",
  "lastModifiedDate",
  "effectiveDate",
  "creationDate",
  "viewableDate",
  "pcReleaseDate",
  "upcoming",
  "price",
] as const;

export const promotionsOperations = defineOperations([
  {
    operationId: "listPromotions",
    method: "GET",
    path: "/v1/promotions",
    summary: "Active promotions",
    description:
      "Returns a bounded list of active event tags ordered by their number of referenced offers. The legacy endpoint returned every active event; v1 caps the list with `limit` and never uses cookies.",
    tags: ["Promotions"],
    scope: "catalog:read",
    auth: "key",
    parameters: [limitParameter(100)],
    responseDescription:
      "`data` is an array of event tag documents with `id`, `name`, `referenceCount`, and status metadata.",
    legacy: ["/promotions"],
  },
  {
    operationId: "listPromotionOffers",
    method: "GET",
    path: "/v1/promotions/{id}",
    summary: "Offers in a promotion",
    description:
      "Cursor-paginated offers carrying the promotion's event tag. Results are ordered by `sortBy` and `sortDir` with the offer ID ascending as a unique tie-breaker, defaulting to `lastModifiedDate` descending. `price` sorting uses the current price engine row for the selected region. `q` filters titles case-insensitively. Cursors are bound to the promotion, query, ordering, country, locale, and page size.",
    tags: ["Promotions"],
    scope: "catalog:read",
    auth: "key",
    paginated: true,
    expensivePolicy: "heavy",
    parameters: [
      pathParameter("id", "Promotion event tag ID."),
      queryParameter("q", "Case-insensitive title filter.", {
        type: "string",
        maxLength: 200,
      }),
      queryParameter("sortBy", "Sort field.", {
        type: "string",
        enum: [...PROMOTION_SORT_FIELDS],
        default: "lastModifiedDate",
      }),
      queryParameter("sortDir", "Sort direction.", {
        type: "string",
        enum: ["asc", "desc"],
        default: "desc",
      }),
      countryParameter(),
      localeParameter(),
      limitParameter(50),
      cursorParameter(),
    ],
    responseDescription:
      "`data` is the page of expanded localized offers; `meta.title` is the event name, `meta.start` is 0 on the first page (null afterwards, because cursors do not expose offsets), and `meta.pagination` carries `limit`, `hasMore`, and `nextCursor`.",
    legacy: ["/promotions/{id}"],
  },
  {
    operationId: "getPromotionCover",
    method: "GET",
    path: "/v1/promotions/{id}/cover",
    summary: "Promotion cover offer",
    description:
      "Returns the localized base-game offer from the first namespace referenced by the promotion. This is the offer metadata the legacy endpoint returned; it is not a rendered image. OG image routes remain outside v1.",
    tags: ["Promotions"],
    scope: "catalog:read",
    auth: "key",
    parameters: [
      pathParameter("id", "Promotion event tag ID."),
      localeParameter(),
    ],
    responseDescription:
      "`data` is the expanded localized base-game offer used as the promotion cover.",
    legacy: ["/promotions/{id}/cover"],
  },
] as const);
