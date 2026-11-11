import {
  cursorParameter,
  defineOperations,
  limitParameter,
  pathParameter,
  queryParameter,
} from "../route-types.js";

export const profilesOperations = defineOperations([
  {
    operationId: "listProfileLeaderboard",
    method: "GET",
    path: "/v1/profiles/leaderboard",
    summary: "Profile XP leaderboard",
    description:
      "Ranks public Epic player profiles by the achievement XP stored for every sandbox they have played. Ties share the same `rank`; entries are ordered by `rank` ascending and then `accountId` ascending. `data` is the leaderboard array and `meta.pagination` carries `limit`, `hasMore`, and `nextCursor`.",
    tags: ["Profiles"],
    scope: "profiles:read",
    auth: "key",
    responseKind: "json",
    paginated: true,
    expensivePolicy: "heavy",
    parameters: [cursorParameter(), limitParameter(100)],
    responseDescription:
      "`data` is an array of entries with `rank`, `accountId`, `displayName`, `xpEarned`, `achievementsWon`, `awardsEarned`, and `awardsByType`.",
    legacy: ["/profiles/leaderboard"],
  },
  {
    operationId: "getProfile",
    method: "GET",
    path: "/v1/profiles/{id}",
    summary: "Get a player profile",
    description:
      "Returns the public Epic profile, the linked Discord account metadata egdata stores, the profile creation date, the review count, and a per-sandbox achievement summary. Private self-profile and mutation endpoints are not part of v1.",
    tags: ["Profiles"],
    scope: "profiles:read",
    auth: "key",
    responseKind: "json",
    expensivePolicy: "heavy",
    parameters: [pathParameter("id", "Epic account ID.")],
    responseDescription:
      "`data` contains `epicAccountId`, `displayName`, `avatar`, `linkedAccounts`, `creationDate`, `reviews`, and an `achievements` summary with one entry per sandbox that has a base-game offer.",
    legacy: ["/profiles/{id}"],
  },
  {
    operationId: "listProfileAchievements",
    method: "GET",
    path: "/v1/profiles/{id}/achievements",
    summary: "List unlocked profile achievements",
    description:
      "Lists the profile's unlocked achievements, joined with the achievement-set metadata and the owning base-game or DLC offer. Ordered by unlock date descending, with `sandboxId` and `achievementName` as unique tie-breakers. `meta.pagination` carries `limit`, `hasMore`, and `nextCursor`.",
    tags: ["Profiles"],
    scope: "profiles:read",
    auth: "key",
    responseKind: "json",
    paginated: true,
    expensivePolicy: "heavy",
    parameters: [
      pathParameter("id", "Epic account ID."),
      cursorParameter(),
      limitParameter(100),
    ],
    responseDescription:
      "`data.achievements` is the page of unlocked achievements (achievement-set fields plus `unlocked`, `unlockDate`, and `offer`); `data.count` is the total number of distinct unlocked achievements.",
    legacy: ["/profiles/{id}/achievements"],
  },
  {
    operationId: "getProfileAchievements",
    method: "GET",
    path: "/v1/profiles/{id}/achievements/{sandboxId}",
    summary: "Get profile achievements for one sandbox",
    description:
      "Returns the stored player achievement records for one sandbox together with the achievement-set metadata referenced by those records. Empty arrays are returned when the profile has no recorded achievements for the sandbox.",
    tags: ["Profiles"],
    scope: "profiles:read",
    auth: "key",
    responseKind: "json",
    expensivePolicy: "heavy",
    parameters: [
      pathParameter("id", "Epic account ID."),
      pathParameter("sandboxId", "Epic sandbox ID (the base-game namespace)."),
    ],
    responseDescription:
      "`data.playerAchievements` and `data.sandboxAchievements` preserve the legacy field names.",
    legacy: ["/profiles/{id}/achievements/{sandboxId}"],
  },
  {
    operationId: "listProfileRareAchievements",
    method: "GET",
    path: "/v1/profiles/{id}/rare-achievements",
    summary: "List rarest unlocked profile achievements",
    description:
      "Returns the 25 rarest unlocked achievements across all of the profile's games, ordered by `completedPercent` ascending. Each entry includes the matching base-game offer when one is available. This collection is bounded and not paginated.",
    tags: ["Profiles"],
    scope: "profiles:read",
    auth: "key",
    responseKind: "json",
    expensivePolicy: "heavy",
    parameters: [pathParameter("id", "Epic account ID.")],
    responseDescription:
      "`data` is an array of achievement-set fields plus `sandboxId`, `achievementSetId`, `unlocked`, `unlockDate`, and an optional `offer` object.",
    legacy: ["/profiles/{id}/rare-achievements"],
  },
  {
    operationId: "getProfileRareAchievements",
    method: "GET",
    path: "/v1/profiles/{id}/rare-achievements/{sandboxId}",
    summary: "Get rarest profile achievements for one sandbox",
    description:
      "Returns up to three of the rarest unlocked achievements for one sandbox, ordered by `completedPercent` ascending. This collection is bounded and not paginated.",
    tags: ["Profiles"],
    scope: "profiles:read",
    auth: "key",
    responseKind: "json",
    expensivePolicy: "heavy",
    parameters: [
      pathParameter("id", "Epic account ID."),
      pathParameter("sandboxId", "Epic sandbox ID (the base-game namespace)."),
    ],
    responseDescription:
      "`data` is an array of achievement-set fields plus `sandboxId`, `achievementSetId`, `unlocked`, and `unlockDate`.",
    legacy: ["/profiles/{id}/rare-achievements/{sandboxId}"],
  },
  {
    operationId: "getProfileInformation",
    method: "GET",
    path: "/v1/profiles/{id}/information",
    summary: "Get profile details and statistics",
    description:
      "Returns the public Epic profile together with aggregate achievement statistics (games played, unlocked achievements, awards, total XP, reviews), the donation details stored for the account, and whether a Discord account is linked. This resource is not paginated.",
    tags: ["Profiles"],
    scope: "profiles:read",
    auth: "key",
    responseKind: "json",
    expensivePolicy: "heavy",
    parameters: [pathParameter("id", "Epic account ID.")],
    responseDescription:
      "`data` contains `epicAccountId`, `displayName`, `avatar`, `linkedAccounts`, `creationDate`, `stats` (`totalGames`, `totalAchievements`, `totalPlayerAwards`, `totalXP`, `reviewsCount`), `donations`, and `discord`.",
    legacy: ["/profiles/{id}/information"],
  },
  {
    operationId: "listProfileGames",
    method: "GET",
    path: "/v1/profiles/{id}/games",
    summary: "List profile games",
    description:
      "Returns one achievement-completion summary per sandbox the profile has played, ordered by the selected `sort` with `sandboxId` as the unique tie-breaker. Use `platinum=true` to keep only games with a platinum award. `meta.pagination` carries `limit`, `hasMore`, and `nextCursor`; the legacy `page` parameter is replaced by the cursor.",
    tags: ["Profiles"],
    scope: "profiles:read",
    auth: "key",
    responseKind: "json",
    paginated: true,
    expensivePolicy: "heavy",
    parameters: [
      pathParameter("id", "Epic account ID."),
      cursorParameter(),
      limitParameter(100),
      queryParameter(
        "sort",
        "Ordering of the games: `completion` (default), `alphabetical`, `xp`, or `achievements`.",
        {
          type: "string",
          enum: ["completion", "alphabetical", "xp", "achievements"],
          default: "completion",
        },
      ),
      queryParameter(
        "platinum",
        "When true, only games with at least one platinum award are returned.",
        { type: "boolean", default: false },
      ),
    ],
    responseDescription:
      "`data.achievements` is the page of per-sandbox summaries with `sandboxId`, `totalUnlocked`, `totalXP`, `productAchievements`, `completionPercentage`, `baseOfferForSandbox`, and `product`. The key keeps the legacy name.",
    legacy: ["/profiles/{id}/games"],
  },
  {
    operationId: "getProfileRandomGame",
    method: "GET",
    path: "/v1/profiles/{id}/random-game",
    summary: "Get a random owned game",
    description:
      "Returns the full offer for a game the profile has achievement data for. When `sandbox` is supplied, that game is returned instead of a random one. This resource is bounded and not paginated.",
    tags: ["Profiles"],
    scope: "profiles:read",
    auth: "key",
    responseKind: "json",
    expensivePolicy: "heavy",
    parameters: [
      pathParameter("id", "Epic account ID."),
      queryParameter(
        "sandbox",
        "Optional sandbox ID. Returns that game instead of a random one.",
      ),
    ],
    responseDescription:
      "`data` is the serialized offer document, including `id`, `namespace`, `title`, `productSlug`, and `keyImages`.",
    legacy: ["/profiles/{id}/random-game"],
  },
] as const);
