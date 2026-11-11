import {
  countryParameter,
  cursorParameter,
  defineOperations,
  limitParameter,
  localeParameter,
  pathParameter,
  queryParameter,
} from "../route-types.js";

const sandboxIdParameter = (description: string) =>
  pathParameter("sandboxId", description);

const titleParameter = queryParameter(
  "title",
  "Literal, case-insensitive substring matched against the record title.",
  { type: "string", maxLength: 200 },
);

const sandboxPlatformsParameter = queryParameter(
  "platforms",
  "Comma-separated release platforms; an item matches when at least one release entry uses one of them.",
  { type: "string", maxLength: 500 },
);

const assetPlatformParameter = queryParameter(
  "platform",
  "Comma-separated asset platforms. Matching is exact and case-sensitive.",
  { type: "string", maxLength: 500 },
);

export const sandboxesOperations = defineOperations([
  {
    operationId: "listSandboxes",
    method: "GET",
    path: "/v1/sandboxes",
    summary: "List sandboxes",
    description:
      "Returns the known Epic namespaces (sandboxes) ordered by namespace identifier (`_id`) ascending. Pass `meta.pagination.nextCursor` as `cursor` to fetch the next page.",
    tags: ["Sandboxes"],
    scope: "catalog:read",
    auth: "key",
    paginated: true,
    parameters: [cursorParameter(), limitParameter()],
    responseDescription: "Cursor page of serialized namespace documents.",
    legacy: ["/sandboxes"],
  },
  {
    operationId: "getSandbox",
    method: "GET",
    path: "/v1/sandboxes/{sandboxId}",
    summary: "Get a sandbox",
    description:
      "Returns the stored sandbox record, falling back to the corresponding namespace record when no sandbox document exists. Sandboxes from the list operation are always retrievable.",
    tags: ["Sandboxes"],
    scope: "catalog:read",
    auth: "key",
    parameters: [
      sandboxIdParameter("Epic namespace identifier of the sandbox."),
    ],
    legacy: ["/sandboxes/{sandboxId}"],
  },
  {
    operationId: "listSandboxItems",
    method: "GET",
    path: "/v1/sandboxes/{sandboxId}/items",
    summary: "List items in a sandbox",
    description:
      "Returns catalog items whose namespace matches the sandbox, ordered by `lastModifiedDate` descending with `id` ascending as a stable tie-breaker; items without a modification date sort last.",
    tags: ["Sandboxes"],
    scope: "catalog:read",
    auth: "key",
    paginated: true,
    parameters: [
      sandboxIdParameter("Epic namespace identifier of the sandbox."),
      cursorParameter(),
      limitParameter(),
      queryParameter(
        "entitlementType",
        "Comma-separated entitlement types, for example `EXECUTABLE` or `ENTITLEMENT`.",
        { type: "string", maxLength: 500 },
      ),
      queryParameter(
        "status",
        "Comma-separated item statuses, for example `ACTIVE`.",
        { type: "string", maxLength: 500 },
      ),
      sandboxPlatformsParameter,
      titleParameter,
    ],
    responseDescription: "Cursor page of serialized catalog items.",
    legacy: ["/sandboxes/{sandboxId}/items"],
  },
  {
    operationId: "listSandboxOffers",
    method: "GET",
    path: "/v1/sandboxes/{sandboxId}/offers",
    summary: "List offers in a sandbox",
    description:
      "Returns offers whose namespace matches the sandbox, ordered by `lastModifiedDate` descending with `id` ascending as a stable tie-breaker. Each offer is localized for the requested locale and carries the current price for the country's Epic pricing region when one is stored.",
    tags: ["Sandboxes"],
    scope: "offers:read",
    auth: "key",
    paginated: true,
    parameters: [
      sandboxIdParameter("Epic namespace identifier of the sandbox."),
      cursorParameter(),
      limitParameter(),
      countryParameter(),
      localeParameter(),
      queryParameter(
        "offerType",
        "Comma-separated Epic offer types, for example `BASE_GAME` or `DLC`.",
        { type: "string", maxLength: 500 },
      ),
      titleParameter,
    ],
    responseDescription:
      "Cursor page of serialized offers with localized text and current regional prices.",
    legacy: ["/sandboxes/{sandboxId}/offers"],
  },
  {
    operationId: "listSandboxAssets",
    method: "GET",
    path: "/v1/sandboxes/{sandboxId}/assets",
    summary: "List assets in a sandbox",
    description:
      "Returns stored asset records merged with synthetic assets generated from item release info that has no stored artifact, ordered by `updatedAt` descending with `artifactId` and then `platform` ascending. Synthetic assets report zero sizes, the source item title, and a deterministic `_id` so cursors stay stable.",
    tags: ["Sandboxes"],
    scope: "catalog:read",
    auth: "key",
    paginated: true,
    parameters: [
      sandboxIdParameter("Epic namespace identifier of the sandbox."),
      cursorParameter(),
      limitParameter(),
      assetPlatformParameter,
    ],
    responseDescription: "Cursor page of serialized real and synthetic assets.",
    legacy: ["/sandboxes/{sandboxId}/assets"],
  },
  {
    operationId: "getSandboxBaseGame",
    method: "GET",
    path: "/v1/sandboxes/{sandboxId}/base-game",
    summary: "Get the base game for a sandbox",
    description:
      "Returns the released base-game offer for the sandbox with its current regional price and localized text. When no released base game exists it falls back to a pre-purchase base game, then to an executable item, which is returned with `isItem: true`.",
    tags: ["Sandboxes"],
    scope: "catalog:read",
    auth: "key",
    parameters: [
      sandboxIdParameter("Epic namespace identifier of the sandbox."),
      countryParameter(),
      localeParameter(),
    ],
    responseDescription:
      "Serialized offer with `price`, or a serialized item with `isItem: true`.",
    legacy: ["/sandboxes/{sandboxId}/base-game"],
  },
  {
    operationId: "listSandboxAchievements",
    method: "GET",
    path: "/v1/sandboxes/{sandboxId}/achievements",
    summary: "List achievement sets for a sandbox",
    description:
      "Returns every achievement set stored for the sandbox. The bounded reference response is not paginated.",
    tags: ["Sandboxes"],
    scope: "catalog:read",
    auth: "key",
    parameters: [
      sandboxIdParameter("Epic namespace identifier of the sandbox."),
    ],
    responseDescription: "Array of serialized achievement sets.",
    legacy: ["/sandboxes/{sandboxId}/achievements"],
  },
  {
    operationId: "getSandboxChangelog",
    method: "GET",
    path: "/v1/sandboxes/{sandboxId}/changelog",
    summary: "List changelog entries for a sandbox",
    description:
      "Returns changelog entries for the sandbox, its offers, its items, their assets, and their builds as `{ hits }`, ordered by `timestamp` descending with `_id` descending as a stable tie-breaker. Each hit carries the resolved context document in `metadata.context`. Totals are not calculated; use `meta.pagination.hasMore`.",
    tags: ["Sandboxes"],
    scope: "catalog:read",
    auth: "key",
    paginated: true,
    parameters: [
      sandboxIdParameter("Epic namespace identifier of the sandbox."),
      cursorParameter(),
      limitParameter(),
    ],
    responseDescription:
      "Object with a `hits` array of changelog entries including `metadata.context`.",
    legacy: ["/sandboxes/{sandboxId}/changelog"],
  },
  {
    operationId: "listSandboxBuilds",
    method: "GET",
    path: "/v1/sandboxes/{sandboxId}/builds",
    summary: "List builds for a sandbox",
    description:
      "Returns build summaries for every build app referenced by the sandbox's items, ordered by `updatedAt` descending with `_id` descending as a stable tie-breaker. Use `platform` to restrict the items whose release info is considered.",
    tags: ["Sandboxes"],
    scope: "catalog:read",
    auth: "key",
    paginated: true,
    parameters: [
      sandboxIdParameter("Epic namespace identifier of the sandbox."),
      cursorParameter(),
      limitParameter(),
      queryParameter(
        "platform",
        "Comma-separated release platforms used to restrict the sandbox items.",
        { type: "string", maxLength: 500 },
      ),
    ],
    responseDescription: "Cursor page of serialized build summaries.",
    legacy: ["/sandboxes/{sandboxId}/builds"],
  },
  {
    operationId: "getSandboxStats",
    method: "GET",
    path: "/v1/sandboxes/{sandboxId}/stats",
    summary: "Get sandbox statistics",
    description:
      "Returns offer, item, asset, build, and achievement counts for the sandbox. The asset count includes synthetic assets generated from release info without a stored artifact.",
    tags: ["Sandboxes"],
    scope: "catalog:read",
    auth: "key",
    parameters: [
      sandboxIdParameter("Epic namespace identifier of the sandbox."),
    ],
    responseDescription:
      "Object with `offers`, `items`, `assets`, `builds`, and `achievements` counts.",
    legacy: ["/sandboxes/{sandboxId}/stats"],
  },
] as const);
