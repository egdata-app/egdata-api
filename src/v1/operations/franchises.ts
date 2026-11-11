import {
  countryParameter,
  cursorParameter,
  defineOperations,
  limitParameter,
  localeParameter,
  pathParameter,
} from "../route-types.js";

export const franchisesOperations = defineOperations([
  {
    operationId: "getFranchise",
    method: "GET",
    path: "/v1/franchises/{slug}",
    summary: "Get a franchise",
    description:
      "Returns a franchise and a cursor-paginated page of its offers, ordered by `releaseDate` descending with the offer `id` ascending as tie-breaker. Offers are localized with `locale` and priced for the Epic pricing region that contains `country`. The `stats` object aggregates achievements and time-to-beat data over every offer in the franchise, not only the returned page. Cookies are never used.",
    tags: ["Franchises"],
    scope: "offers:read",
    auth: "key",
    responseKind: "json",
    paginated: true,
    parameters: [
      pathParameter("slug", "Franchise slug, as used by `/franchises/{slug}`."),
      countryParameter(),
      localeParameter(),
      cursorParameter(),
      limitParameter(),
    ],
    legacy: ["/franchises/{slug}"],
  },
] as const);
