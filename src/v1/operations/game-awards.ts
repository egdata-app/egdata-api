import {
  countryParameter,
  defineOperations,
  localeParameter,
} from "../route-types.js";

export const gameAwardsOperations = defineOperations([
  {
    operationId: "getGameAwards",
    method: "GET",
    path: "/v1/game-awards",
    summary: "The Game Awards modules",
    description:
      "Returns the storefront modules for The Game Awards event, each with its localized and expanded offers and current regional price. Modules are ordered by `moduleIndex`; modules without referenced offers are omitted. OG image generation remains outside v1.",
    tags: ["Game Awards"],
    scope: "catalog:read",
    auth: "key",
    parameters: [countryParameter(), localeParameter()],
    responseDescription:
      "`data` is an array of modules with `title`, `moduleIndex`, `moduleType`, and serialized `offers`.",
    legacy: ["/game-awards"],
  },
] as const);
