import {
  countryParameter,
  cursorParameter,
  defineOperations,
  limitParameter,
  localeParameter,
  queryParameter,
} from "../route-types.js";

const OFFER_TYPES = [
  "IN_GAME_PURCHASE",
  "BASE_GAME",
  "EXPERIENCE",
  "UNLOCKABLE",
  "ADD_ON",
  "Bundle",
  "CONSUMABLE",
  "WALLET",
  "OTHERS",
  "DEMO",
  "DLC",
  "VIRTUAL_CURRENCY",
  "BUNDLE",
  "DIGITAL_EXTRA",
  "EDITION",
] as const;

const SEARCH_SORT_FIELDS = [
  "giveawayDate",
  "releaseDate",
  "lastModifiedDate",
  "effectiveDate",
  "creationDate",
  "viewableDate",
  "pcReleaseDate",
  "upcoming",
  "price",
  "giveaway.endDate",
  "price.price.discountPrice",
] as const;

export const freeGamesOperations = defineOperations([
  {
    operationId: "listFreeGames",
    method: "GET",
    path: "/v1/free-games",
    summary: "Current free games",
    description:
      "Returns current and announced giveaways from the desktop free-games catalog and the mobile freebies feed. Offer documents are expanded and localized, and every entry carries `giveaway` metadata (including the full desktop giveaway history), the current regional price, and the items unlocked by the offer. Cookies are never used.",
    tags: ["Free Games"],
    scope: "catalog:read",
    auth: "key",
    parameters: [countryParameter(), localeParameter()],
    responseDescription:
      "`data` is an array of expanded offers with `giveaway`, `items`, and `price`; entries whose offer document is missing contain `giveaway` only.",
    legacy: ["/free-games"],
  },
  {
    operationId: "listFreeGamesHistory",
    method: "GET",
    path: "/v1/free-games/history",
    summary: "Free game history",
    description:
      "Cursor-paginated giveaway history ordered by `endDate` descending and then `id` descending. Each entry contains the giveaway record, the expanded localized offer, and the current regional price. Cursors are bound to the filter set, ordering, country, locale, and page size, and expire after 24 hours.",
    tags: ["Free Games"],
    scope: "catalog:read",
    auth: "key",
    paginated: true,
    parameters: [
      countryParameter(),
      localeParameter(),
      limitParameter(25),
      cursorParameter(),
    ],
    responseDescription:
      "`data` is the page of expanded offers; `meta.pagination` carries `limit`, `hasMore`, and `nextCursor`.",
    legacy: ["/free-games/history"],
  },
  {
    operationId: "searchFreeGames",
    method: "GET",
    path: "/v1/free-games/search",
    summary: "Search free games",
    description:
      "Searches the `egdata.offers` OpenSearch index for offers with giveaway entries, using the legacy title, offer type, tag, and category filters. Pagination uses `search_after` instead of offsets, so cursors stay stable while the index changes. Results default to `lastModifiedDate` descending with `id.keyword` ascending as a unique tie-breaker. `meta.result.total` is an OpenSearch estimate and may be a lower bound when the index reports a `gte` relation.",
    tags: ["Free Games"],
    scope: "catalog:read",
    auth: "key",
    paginated: true,
    expensivePolicy: "search",
    parameters: [
      queryParameter(
        "title",
        "Full-text query matched against title, description, and offer ID.",
        {
          type: "string",
          maxLength: 200,
        },
      ),
      queryParameter("offerType", "Restrict results to one Epic offer type.", {
        type: "string",
        enum: [...OFFER_TYPES],
      }),
      queryParameter(
        "tags",
        "Comma-separated tag IDs. An offer must contain every supplied tag.",
        { type: "string" },
      ),
      queryParameter(
        "categories",
        "Comma-separated category names. An offer must contain every supplied category.",
        { type: "string" },
      ),
      queryParameter(
        "sortBy",
        "Sort field. `giveawayDate` maps to `freeEntries.endDate`; `price` maps to the selected region's discount price.",
        {
          type: "string",
          enum: [...SEARCH_SORT_FIELDS],
          default: "lastModifiedDate",
        },
      ),
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
      "`data` is the page of localized offers; `meta.result` carries the estimated total, the total relation, `timedOut`, and `tookMs`.",
    legacy: ["/free-games/search"],
  },
  {
    operationId: "getFreeGamesStats",
    method: "GET",
    path: "/v1/free-games/stats",
    summary: "Free game statistics",
    description:
      "Returns giveaway totals, distinct seller counts, repeated giveaways, and the summed value of all recorded giveaways for the selected pricing region. When no price rows exist the value object is still returned with zero amounts and nullable currency codes instead of failing.",
    tags: ["Free Games"],
    scope: "catalog:read",
    auth: "key",
    parameters: [countryParameter(), localeParameter()],
    responseDescription:
      "`data.totalValue.currencyCode`, `data.totalValue.basePayoutCurrencyCode`, and `data.totalValue.payoutCurrencyExchangeRate` are null when no priced giveaway exists.",
    legacy: ["/free-games/stats"],
  },
  {
    operationId: "listMobileFreeGames",
    method: "GET",
    path: "/v1/free-games/mobile",
    summary: "Current mobile free games",
    description:
      "Returns the mobile freebies that are active now, expanded with the localized offer, the normalized giveaway record, and the current regional price. Entries without a matching offer document are omitted.",
    tags: ["Free Games"],
    scope: "catalog:read",
    auth: "key",
    parameters: [countryParameter(), localeParameter()],
    legacy: ["/free-games/mobile"],
  },
  {
    operationId: "listFreeGameSellers",
    method: "GET",
    path: "/v1/free-games/sellers",
    summary: "Free game sellers",
    description:
      "Returns every seller that has appeared in the giveaway catalog, with the number of distinct giveaways attributed to it, ordered by that count descending. The aggregate is global and does not depend on a pricing country.",
    tags: ["Free Games"],
    scope: "catalog:read",
    auth: "key",
    parameters: [],
    legacy: ["/free-games/sellers"],
  },
] as const);
