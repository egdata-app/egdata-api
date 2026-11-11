import { Hono } from "hono";
import { z } from "zod";
import { epicStoreClient } from "../../clients/epic.js";
import { db } from "../../db/index.js";
import { AchievementSet, Offer, Sandbox } from "../../models/index.js";
import { cached, v1CacheKey } from "../cache.js";
import { type CursorSortTuple, decodeCursor, encodeCursor } from "../cursor.js";
import { notFound } from "../errors.js";
import {
  type MongoSortField,
  mongoKeysetFilter,
  mongoSortSpec,
  pageMeta,
  parsePagination,
  trimPage,
} from "../pagination.js";
import {
  parseBoolean,
  parseStrictQuery,
  querySchema,
  requireIdParam,
} from "../query.js";
import type { V1Variables } from "../request-context.js";
import { jsonSuccess } from "../response.js";
import {
  dateValue,
  isoOrNull,
  serializeValue,
  stringId,
} from "../serialization.js";

// biome-ignore lint/suspicious/noExplicitAny: Mongo documents are untyped.
type AnyRecord = Record<string, any>;

const app = new Hono<{ Variables: V1Variables }>();

/**
 * Profile routes never accept a country or locale. The legacy implementations
 * are not localized and always use the US/en-US defaults, so cursors bind to
 * those constants for a stable signature.
 */
const COUNTRY = "US";
const LOCALE = "en-US";

const PROFILE_TTL_SECONDS = 60;
const ACHIEVEMENTS_TTL_SECONDS = 3600;
const SANDBOX_ACHIEVEMENTS_TTL_SECONDS = 60;
const RARE_ACHIEVEMENTS_TTL_SECONDS = 86_400;
const RARE_SANDBOX_ACHIEVEMENTS_TTL_SECONDS = 3600;
const INFORMATION_IDENTITY_TTL_SECONDS = 3600;
const INFORMATION_STATS_TTL_SECONDS = 300;
const GAMES_TTL_SECONDS = 60;
const GAMES_IDENTITY_TTL_SECONDS = 60;
const RANDOM_GAME_TTL_SECONDS = 360;
const RANDOM_GAME_IDENTITY_TTL_SECONDS = 60;

async function fetchEpicProfile(accountId: string, ttlSeconds: number) {
  return cached(
    v1CacheKey("profiles.identity", { id: accountId, ttl: ttlSeconds }),
    ttlSeconds,
    () => epicStoreClient.getUser(accountId),
  );
}

function profileAvatar(
  profile: {
    avatar?: {
      small?: string | null;
      medium?: string | null;
      large?: string | null;
    } | null;
  } | null,
  dbProfile: AnyRecord | null,
) {
  const variants = dbProfile?.avatarUrl?.variants;
  const storedAvatar = Array.isArray(variants) ? variants[0] : undefined;
  return {
    small: storedAvatar ?? profile?.avatar?.small ?? null,
    medium: storedAvatar ?? profile?.avatar?.medium ?? null,
    large: storedAvatar ?? profile?.avatar?.large ?? null,
  };
}

/* ------------------------------------------------------------------------- */
/* Leaderboard                                                                */
/* ------------------------------------------------------------------------- */

const LEADERBOARD_ORDERING = "rank:asc,id:asc";
const LEADERBOARD_SORT: MongoSortField[] = [
  { field: "rank", direction: 1, nulls: "first" },
  { field: "accountId", direction: 1, nulls: "first" },
];

/**
 * Port of the legacy aggregation. Ranks are computed over every player before
 * the keyset filter, so `rank` is always the global position; the filter then
 * walks the (rank, accountId) tuple in ascending order.
 */
function leaderboardPipeline(
  last: CursorSortTuple | null,
  limit: number,
): AnyRecord[] {
  const pipeline: AnyRecord[] = [
    {
      $project: {
        epicAccountId: 1,
        sandboxId: 1,
        totalXP: 1,
        totalUnlocked: 1,
        playerAwards: 1,
      },
    },
    {
      $group: {
        _id: { player: "$epicAccountId", sandbox: "$sandboxId" },
        xpForSandbox: { $max: "$totalXP" },
        unlockedForSandbox: { $max: "$totalUnlocked" },
        awardsForSandbox_arr: { $push: "$playerAwards" },
      },
    },
    {
      $addFields: {
        awardsForSandbox: {
          $reduce: {
            input: "$awardsForSandbox_arr",
            initialValue: [],
            in: { $setUnion: ["$$value", "$$this"] },
          },
        },
      },
    },
    { $project: { awardsForSandbox_arr: 0 } },
    {
      $group: {
        _id: "$_id.player",
        xpEarned: { $sum: "$xpForSandbox" },
        achievementsWon: { $sum: "$unlockedForSandbox" },
        awards_arr: { $push: "$awardsForSandbox" },
      },
    },
    {
      $addFields: {
        awards: {
          $reduce: {
            input: "$awards_arr",
            initialValue: [],
            in: { $setUnion: ["$$value", "$$this"] },
          },
        },
        awardsEarned: {
          $size: {
            $reduce: {
              input: "$awards_arr",
              initialValue: [],
              in: { $setUnion: ["$$value", "$$this"] },
            },
          },
        },
      },
    },
    { $project: { awards_arr: 0 } },
    {
      $addFields: {
        awardsByType: {
          $arrayToObject: {
            $map: {
              input: {
                $setUnion: {
                  $map: {
                    input: "$awards",
                    as: "a",
                    in: "$$a.awardType",
                  },
                },
              },
              as: "type",
              in: {
                k: "$$type",
                v: {
                  $size: {
                    $filter: {
                      input: "$awards",
                      as: "a",
                      cond: { $eq: ["$$a.awardType", "$$type"] },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    {
      $lookup: {
        from: "epic",
        localField: "_id",
        foreignField: "accountId",
        as: "player",
      },
    },
    { $unwind: { path: "$player", preserveNullAndEmptyArrays: true } },
    {
      $setWindowFields: {
        sortBy: { xpEarned: -1 },
        output: { rank: { $rank: {} } },
      },
    },
    {
      $project: {
        _id: 0,
        rank: 1,
        accountId: "$_id",
        displayName: "$player.displayName",
        xpEarned: 1,
        achievementsWon: 1,
        awardsEarned: 1,
        awardsByType: 1,
      },
    },
  ];

  if (last) {
    pipeline.push({ $match: mongoKeysetFilter(LEADERBOARD_SORT, last) });
  }
  pipeline.push(
    { $sort: mongoSortSpec(LEADERBOARD_SORT) },
    { $limit: limit + 1 },
  );
  return pipeline;
}

const leaderboardCursorTuple = (entry: AnyRecord): CursorSortTuple => [
  typeof entry.rank === "number" ? entry.rank : null,
  entry.accountId ?? null,
];

app.get("/profiles/leaderboard", async (c) => {
  const query = parseStrictQuery(c, querySchema.pagination);
  const { limit, cursor } = parsePagination({ ...query });
  const binding = {
    operation: "profiles.leaderboard",
    filters: {},
    ordering: LEADERBOARD_ORDERING,
    country: COUNTRY,
    locale: LOCALE,
    limit,
  };

  const result = await cached(
    v1CacheKey("profiles.leaderboard", { limit, cursor }),
    PROFILE_TTL_SECONDS,
    async () => {
      const last = cursor ? decodeCursor(cursor, binding) : null;
      const rows = (await db.db
        .collection("player-achievements")
        .aggregate(leaderboardPipeline(last, limit), { allowDiskUse: true })
        .toArray()) as AnyRecord[];
      const { items, hasMore } = trimPage(rows, limit);
      const lastEntry = items[items.length - 1];

      return {
        entries: items.map((entry) => serializeValue(entry)),
        pagination: pageMeta(
          limit,
          hasMore,
          hasMore && lastEntry
            ? encodeCursor(binding, leaderboardCursorTuple(lastEntry))
            : null,
        ),
      };
    },
  );

  return jsonSuccess(c, result.entries, { pagination: result.pagination });
});

/* ------------------------------------------------------------------------- */
/* Profile detail                                                             */
/* ------------------------------------------------------------------------- */

type PlayerProductAchievements = {
  epicAccountId?: string;
  sandboxId?: string;
  totalXP?: number;
  totalUnlocked?: number;
  achievementSets?: Array<{
    achievementSetId?: string;
    isBase?: boolean;
    totalUnlocked?: number;
    totalXP?: number;
  }>;
  playerAwards?: AnyRecord[];
  playerAchievements?: AnyRecord[];
};

const emptyAchievementsSummary = () => ({
  __typename: "AchievementsSummaryResponse" as const,
  status: 200 as const,
  data: [] as unknown[],
});

async function buildAchievementsSummary(accountId: string) {
  const rows = (await db.db
    .collection("player-achievements")
    .find({ epicAccountId: accountId })
    .toArray()) as AnyRecord[];

  if (rows.length === 0) return emptyAchievementsSummary();

  const sandboxIds = [
    ...new Set(
      rows
        .map((row) => String(row.sandboxId ?? ""))
        .filter((sandboxId) => sandboxId.length > 0),
    ),
  ];
  if (sandboxIds.length === 0) return emptyAchievementsSummary();

  const [sandboxes, offers, achievementSets] = await Promise.all([
    Sandbox.find({ _id: { $in: sandboxIds } }).lean() as Promise<AnyRecord[]>,
    Offer.find({
      namespace: { $in: sandboxIds },
      offerType: "BASE_GAME",
    }).lean() as Promise<AnyRecord[]>,
    AchievementSet.find({
      sandboxId: { $in: sandboxIds },
    }).lean() as Promise<AnyRecord[]>,
  ]);

  const parentIds = sandboxes
    .map((sandbox) => sandbox.parent)
    .filter((parent) => parent !== null && parent !== undefined);
  const products =
    parentIds.length > 0
      ? ((await db.db
          .collection("products")
          .find({ _id: { $in: parentIds } })
          .toArray()) as AnyRecord[])
      : [];

  const sandboxById = new Map<string, AnyRecord>();
  for (const sandbox of sandboxes) {
    sandboxById.set(String(sandbox._id), sandbox);
  }

  const productById = new Map<string, AnyRecord>();
  for (const product of products) {
    productById.set(String(product._id), product);
  }

  const offerBySandbox = new Map<string, AnyRecord>();
  for (const offer of offers) {
    const sandboxId = String(offer.namespace ?? "");
    if (!offerBySandbox.has(sandboxId)) offerBySandbox.set(sandboxId, offer);
  }

  const setsBySandbox = new Map<string, AnyRecord[]>();
  for (const set of achievementSets) {
    const sandboxId = String(set.sandboxId ?? "");
    const current = setsBySandbox.get(sandboxId) ?? [];
    current.push(set);
    setsBySandbox.set(sandboxId, current);
  }

  const data: AnyRecord[] = [];

  for (const row of rows as PlayerProductAchievements[]) {
    const sandboxId = String(row.sandboxId ?? "");
    const sandbox = sandboxById.get(sandboxId);
    if (!sandbox) continue;

    const product = productById.get(String(sandbox.parent ?? ""));
    const offer = offerBySandbox.get(sandboxId);
    if (!product || !offer) continue;

    const sets = setsBySandbox.get(sandboxId) ?? [];
    let totalAchievements = 0;
    let totalProductXP = 0;
    for (const set of sets) {
      const achievements = Array.isArray(set.achievements)
        ? (set.achievements as AnyRecord[])
        : [];
      totalAchievements += achievements.length;
      for (const achievement of achievements) {
        totalProductXP += Number(achievement.xp ?? achievement.XP ?? 0);
      }
    }

    data.push({
      playerAwards: serializeValue(row.playerAwards ?? []),
      totalXP: row.totalXP ?? null,
      totalUnlocked: row.totalUnlocked ?? null,
      sandboxId: row.sandboxId ?? null,
      baseOfferForSandbox: {
        id: stringId(offer.id),
        namespace: offer.namespace ?? null,
        keyImages: serializeValue(offer.keyImages ?? []),
      },
      product: {
        name: offer.title ?? null,
        slug: offer.productSlug ?? null,
      },
      productAchievements: {
        totalAchievements,
        totalProductXP,
      },
    });
  }

  return {
    __typename: "AchievementsSummaryResponse" as const,
    status: 200 as const,
    data,
  };
}

app.get("/profiles/:id", async (c) => {
  const id = requireIdParam(c);

  const payload = await cached(
    v1CacheKey("profiles.detail", { id }),
    PROFILE_TTL_SECONDS,
    async () => {
      const profile = await epicStoreClient.getUser(id);
      if (!profile) {
        throw notFound(
          "PROFILE_NOT_FOUND",
          `No Epic profile was found for '${id}'.`,
        );
      }

      const [dbProfile, reviewsCount, achievements] = await Promise.all([
        db.db.collection("epic").findOne({ accountId: { $eq: id } }),
        db.db.collection("reviews").countDocuments({ userId: id }),
        buildAchievementsSummary(id),
      ]);

      const serialized = serializeValue(profile) as AnyRecord;

      return {
        ...serialized,
        achievements,
        avatar: profileAvatar(profile, dbProfile),
        linkedAccounts: serializeValue(dbProfile?.linkedAccounts ?? null),
        creationDate: dateValue(dbProfile?.creationDate ?? null),
        reviews: reviewsCount,
      };
    },
  );

  return jsonSuccess(c, payload);
});

/* ------------------------------------------------------------------------- */
/* Achievements                                                               */
/* ------------------------------------------------------------------------- */

const ACHIEVEMENTS_ORDERING =
  "unlockDate:desc,sandboxId:asc,achievementName:asc";
const ACHIEVEMENTS_SORT: MongoSortField[] = [
  { field: "sortUnlockDate", direction: -1, nulls: "last" },
  { field: "sandboxId", direction: 1, nulls: "first" },
  { field: "achievementName", direction: 1, nulls: "first" },
];

const achievementsFilterFromCursor = (last: CursorSortTuple): AnyRecord => {
  // `unlockDate` is stored as a date in Mongo but travels in the cursor as an
  // ISO string, so the first tuple value is restored before the comparison.
  const tuple = last.map((value, index) =>
    index === 0 && typeof value === "string" ? new Date(value) : value,
  ) as unknown as Array<string | number | null>;
  return mongoKeysetFilter(ACHIEVEMENTS_SORT, tuple);
};

function achievementsPipeline(
  accountId: string,
  last: CursorSortTuple | null,
  limit: number,
): AnyRecord[] {
  const pipeline: AnyRecord[] = [
    { $match: { epicAccountId: accountId } },
    { $unwind: "$playerAchievements" },
    { $match: { "playerAchievements.playerAchievement.unlocked": true } },
    {
      $addFields: {
        unlockDate: "$playerAchievements.playerAchievement.unlockDate",
      },
    },
    {
      $group: {
        _id: {
          achievementName:
            "$playerAchievements.playerAchievement.achievementName",
          sandboxId: "$playerAchievements.playerAchievement.sandboxId",
        },
        doc: { $first: "$$ROOT" },
        latestUnlockDate: { $max: "$unlockDate" },
      },
    },
    { $replaceRoot: { newRoot: "$doc" } },
    {
      $addFields: {
        sortUnlockDate: {
          $convert: {
            input: "$unlockDate",
            to: "date",
            onError: null,
            onNull: null,
          },
        },
      },
    },
    {
      $lookup: {
        from: "achievementsets",
        let: {
          achievementName:
            "$playerAchievements.playerAchievement.achievementName",
          sandboxId: "$playerAchievements.playerAchievement.sandboxId",
        },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ["$sandboxId", "$$sandboxId"] },
            },
          },
          { $unwind: "$achievements" },
          {
            $match: {
              $expr: { $eq: ["$achievements.name", "$$achievementName"] },
            },
          },
          {
            $project: {
              _id: 0,
              achievementDetails: "$achievements",
            },
          },
        ],
        as: "achievementDetails",
      },
    },
    {
      $unwind: {
        path: "$achievementDetails",
        preserveNullAndEmptyArrays: false,
      },
    },
    {
      $project: {
        _id: 0,
        achievementName:
          "$playerAchievements.playerAchievement.achievementName",
        unlockDate: "$playerAchievements.playerAchievement.unlockDate",
        XP: "$playerAchievements.playerAchievement.XP",
        sandboxId: "$playerAchievements.playerAchievement.sandboxId",
        isBase: "$playerAchievements.playerAchievement.isBase",
        achievementDetails: "$achievementDetails.achievementDetails",
        sortUnlockDate: 1,
      },
    },
  ];

  if (last) pipeline.push({ $match: achievementsFilterFromCursor(last) });
  pipeline.push(
    { $sort: mongoSortSpec(ACHIEVEMENTS_SORT) },
    { $limit: limit + 1 },
  );
  return pipeline;
}

const achievementsCountPipeline = (accountId: string): AnyRecord[] => [
  { $match: { epicAccountId: accountId } },
  { $unwind: "$playerAchievements" },
  { $match: { "playerAchievements.playerAchievement.unlocked": true } },
  {
    $group: {
      _id: {
        achievementName:
          "$playerAchievements.playerAchievement.achievementName",
        sandboxId: "$playerAchievements.playerAchievement.sandboxId",
      },
    },
  },
  { $count: "count" },
];

const achievementsCursorTuple = (row: AnyRecord): CursorSortTuple => [
  isoOrNull(row.sortUnlockDate),
  row.sandboxId ?? null,
  row.achievementName ?? null,
];

app.get("/profiles/:id/achievements", async (c) => {
  const id = requireIdParam(c);
  const query = parseStrictQuery(c, querySchema.pagination);
  const { limit, cursor } = parsePagination({ ...query });
  const binding = {
    operation: "profiles.achievements",
    filters: { profileId: id },
    ordering: ACHIEVEMENTS_ORDERING,
    country: COUNTRY,
    locale: LOCALE,
    limit,
  };

  const result = await cached(
    v1CacheKey("profiles.achievements", { id, limit, cursor }),
    ACHIEVEMENTS_TTL_SECONDS,
    async () => {
      const last = cursor ? decodeCursor(cursor, binding) : null;
      const [rows, count] = await Promise.all([
        db.db
          .collection("player-achievements")
          .aggregate(achievementsPipeline(id, last, limit), {
            allowDiskUse: true,
          })
          .toArray() as Promise<AnyRecord[]>,
        cached(
          v1CacheKey("profiles.achievements.count", { id }),
          ACHIEVEMENTS_TTL_SECONDS,
          async () => {
            const countRows = (await db.db
              .collection("player-achievements")
              .aggregate(achievementsCountPipeline(id))
              .toArray()) as AnyRecord[];
            return Number(countRows[0]?.count ?? 0);
          },
        ),
      ]);

      const { items, hasMore } = trimPage(rows, limit);
      const lastRow = items[items.length - 1];

      const sandboxIds = [
        ...new Set(
          items
            .map((row) => String(row.sandboxId ?? ""))
            .filter((sandboxId) => sandboxId.length > 0),
        ),
      ];
      const offers =
        sandboxIds.length > 0
          ? ((await Offer.find({
              namespace: { $in: sandboxIds },
              offerType: { $in: ["BASE_GAME", "DLC"] },
              prePurchase: { $ne: true },
            }).lean()) as AnyRecord[])
          : [];

      const offerBySandbox = new Map<string, AnyRecord>();
      for (const offer of offers) {
        const sandboxId = String(offer.namespace ?? "");
        const current = offerBySandbox.get(sandboxId);
        if (
          !current ||
          (offer.offerType === "BASE_GAME" && current.offerType !== "BASE_GAME")
        ) {
          offerBySandbox.set(sandboxId, offer);
        }
      }

      const achievements = items.map((row) => {
        const details =
          (serializeValue(row.achievementDetails) as AnyRecord | null) ?? {};
        const offer = offerBySandbox.get(String(row.sandboxId ?? ""));
        return {
          ...details,
          unlocked: true,
          unlockDate: dateValue(row.unlockDate ?? row.sortUnlockDate),
          offer: offer ? serializeValue(offer) : null,
        };
      });

      return {
        achievements,
        count,
        pagination: pageMeta(
          limit,
          hasMore,
          hasMore && lastRow
            ? encodeCursor(binding, achievementsCursorTuple(lastRow))
            : null,
        ),
      };
    },
  );

  return jsonSuccess(
    c,
    { achievements: result.achievements, count: result.count },
    { pagination: result.pagination },
  );
});

app.get("/profiles/:id/achievements/:sandboxId", async (c) => {
  const id = requireIdParam(c);
  const sandboxId = requireIdParam(c, "sandboxId");

  const result = await cached(
    v1CacheKey("profiles.achievements.sandbox", { id, sandboxId }),
    SANDBOX_ACHIEVEMENTS_TTL_SECONDS,
    async () => {
      const playerAchievements = (await db.db
        .collection("player-achievements")
        .find({ epicAccountId: id, sandboxId })
        .toArray()) as AnyRecord[];

      const setIds = [
        ...new Set(
          playerAchievements
            .flatMap((entry) =>
              Array.isArray(entry.achievementSets)
                ? (entry.achievementSets as AnyRecord[])
                : [],
            )
            .map((set) => String(set.achievementSetId ?? ""))
            .filter((setId) => setId.length > 0),
        ),
      ];

      const sandboxAchievements =
        setIds.length > 0
          ? ((await AchievementSet.find({
              achievementSetId: { $in: setIds },
            }).lean()) as AnyRecord[])
          : [];

      return {
        playerAchievements: playerAchievements.map((row) =>
          serializeValue(row),
        ),
        sandboxAchievements: sandboxAchievements.map((row) =>
          serializeValue(row),
        ),
      };
    },
  );

  return jsonSuccess(c, result);
});

/* ------------------------------------------------------------------------- */
/* Rare achievements                                                          */
/* ------------------------------------------------------------------------- */

const rareAchievementsPipeline: AnyRecord[] = [
  {
    $match: {
      playerAchievements: {
        $elemMatch: { "playerAchievement.unlocked": true },
      },
    },
  },
  { $unwind: "$playerAchievements" },
  { $match: { "playerAchievements.playerAchievement.unlocked": true } },
  {
    $lookup: {
      from: "achievementsets",
      let: {
        setId: "$playerAchievements.playerAchievement.achievementSetId",
        name: "$playerAchievements.playerAchievement.achievementName",
      },
      pipeline: [
        { $match: { $expr: { $eq: ["$achievementSetId", "$$setId"] } } },
        { $unwind: "$achievements" },
        { $match: { $expr: { $eq: ["$achievements.name", "$$name"] } } },
        {
          $project: {
            _id: 0,
            sandboxId: 1,
            achievementSetId: 1,
            achievement: "$achievements",
          },
        },
      ],
      as: "achDoc",
    },
  },
  { $unwind: "$achDoc" },
  {
    $replaceRoot: {
      newRoot: {
        $mergeObjects: [
          "$achDoc.achievement",
          {
            sandboxId: "$achDoc.sandboxId",
            achievementSetId: "$achDoc.achievementSetId",
            unlocked: true,
            unlockDate: "$playerAchievements.playerAchievement.unlockDate",
          },
        ],
      },
    },
  },
  {
    $group: {
      _id: null,
      rare25: {
        $topN: {
          n: 25,
          sortBy: { completedPercent: 1 },
          output: "$$ROOT",
        },
      },
    },
  },
  { $unwind: "$rare25" },
  { $replaceRoot: { newRoot: "$rare25" } },
  {
    $lookup: {
      from: "offers",
      let: { sbx: "$sandboxId" },
      pipeline: [
        {
          $match: {
            $expr: {
              $and: [
                { $eq: ["$namespace", "$$sbx"] },
                { $eq: ["$offerType", "BASE_GAME"] },
                { $eq: ["$isCodeRedemptionOnly", false] },
              ],
            },
          },
        },
        { $sort: { isDisplayable: -1, title: 1, lastModifiedDate: -1 } },
        { $limit: 1 },
        {
          $project: {
            _id: 0,
            id: 1,
            namespace: 1,
            keyImages: 1,
            title: 1,
            productSlug: 1,
          },
        },
      ],
      as: "offer",
    },
  },
  { $unwind: { path: "$offer", preserveNullAndEmptyArrays: true } },
];

const rareSandboxAchievementsPipeline = (
  accountId: string,
  sandboxId: string,
): AnyRecord[] => [
  { $match: { epicAccountId: accountId, sandboxId } },
  { $unwind: "$playerAchievements" },
  { $match: { "playerAchievements.playerAchievement.unlocked": true } },
  {
    $lookup: {
      from: "achievementsets",
      let: {
        setId: "$playerAchievements.playerAchievement.achievementSetId",
        name: "$playerAchievements.playerAchievement.achievementName",
      },
      pipeline: [
        { $match: { $expr: { $eq: ["$achievementSetId", "$$setId"] } } },
        { $unwind: "$achievements" },
        { $match: { $expr: { $eq: ["$achievements.name", "$$name"] } } },
        {
          $project: {
            _id: 0,
            sandboxId: 1,
            achievementSetId: 1,
            achievement: "$achievements",
          },
        },
      ],
      as: "achDoc",
    },
  },
  { $unwind: "$achDoc" },
  {
    $replaceRoot: {
      newRoot: {
        $mergeObjects: [
          "$achDoc.achievement",
          {
            sandboxId: "$achDoc.sandboxId",
            achievementSetId: "$achDoc.achievementSetId",
            unlocked: true,
            unlockDate: "$playerAchievements.playerAchievement.unlockDate",
          },
        ],
      },
    },
  },
  { $sort: { completedPercent: 1 } },
  { $limit: 3 },
];

const serializeRareRows = (rows: AnyRecord[]) =>
  rows.map((row) => {
    const serialized = serializeValue(row) as AnyRecord;
    if ("unlockDate" in serialized) {
      serialized.unlockDate = dateValue(row.unlockDate);
    }
    return serialized;
  });

app.get("/profiles/:id/rare-achievements", async (c) => {
  const id = requireIdParam(c);

  const rows = await cached(
    v1CacheKey("profiles.rareAchievements", { id }),
    RARE_ACHIEVEMENTS_TTL_SECONDS,
    async () => {
      const pipeline: AnyRecord[] = [
        {
          $match: {
            epicAccountId: id,
            playerAchievements: {
              $elemMatch: { "playerAchievement.unlocked": true },
            },
          },
        },
        ...rareAchievementsPipeline.slice(1),
      ];
      const result = (await db.db
        .collection("player-achievements")
        .aggregate(pipeline, { allowDiskUse: true })
        .toArray()) as AnyRecord[];
      return serializeRareRows(result);
    },
  );

  return jsonSuccess(c, rows);
});

app.get("/profiles/:id/rare-achievements/:sandboxId", async (c) => {
  const id = requireIdParam(c);
  const sandboxId = requireIdParam(c, "sandboxId");

  const rows = await cached(
    v1CacheKey("profiles.rareAchievements.sandbox", { id, sandboxId }),
    RARE_SANDBOX_ACHIEVEMENTS_TTL_SECONDS,
    async () => {
      const result = (await db.db
        .collection("player-achievements")
        .aggregate(rareSandboxAchievementsPipeline(id, sandboxId))
        .toArray()) as AnyRecord[];
      return serializeRareRows(result);
    },
  );

  return jsonSuccess(c, rows);
});

/* ------------------------------------------------------------------------- */
/* Profile information                                                        */
/* ------------------------------------------------------------------------- */

const informationStatsPipeline = (accountId: string): AnyRecord[] => [
  { $match: { epicAccountId: accountId } },
  {
    $group: {
      _id: "$sandboxId",
      playerAwards: { $first: "$playerAwards" },
      totalUnlocked: { $first: "$totalUnlocked" },
      totalXP: { $first: "$totalXP" },
    },
  },
  {
    $group: {
      _id: null,
      totalGames: { $sum: 1 },
      totalPlayerAwards: {
        $sum: { $size: { $ifNull: ["$playerAwards", []] } },
      },
      totalAchievements: { $sum: { $ifNull: ["$totalUnlocked", 0] } },
      totalXP: { $sum: { $ifNull: ["$totalXP", 0] } },
    },
  },
];

app.get("/profiles/:id/information", async (c) => {
  const id = requireIdParam(c);

  const profile = await fetchEpicProfile(id, INFORMATION_IDENTITY_TTL_SECONDS);
  if (!profile) {
    throw notFound(
      "PROFILE_NOT_FOUND",
      `No Epic profile was found for '${id}'.`,
    );
  }

  const [dbProfile, donations, stats] = await Promise.all([
    db.db.collection("epic").findOne({ accountId: { $eq: id } }),
    db.db
      .collection("key-codes")
      .find({ accountId: { $eq: id } })
      .toArray(),
    cached(
      v1CacheKey("profiles.information.stats", { id }),
      INFORMATION_STATS_TTL_SECONDS,
      async () => {
        const [statsRows, reviewsCount] = await Promise.all([
          db.db
            .collection("player-achievements")
            .aggregate(informationStatsPipeline(id))
            .toArray() as Promise<AnyRecord[]>,
          db.db.collection("reviews").countDocuments({ userId: id }),
        ]);

        const totals = (statsRows[0] ?? {}) as AnyRecord;
        const totalPlayerAwards = Number(totals.totalPlayerAwards ?? 0);

        return {
          totalGames: Number(totals.totalGames ?? 0),
          totalAchievements: Number(totals.totalAchievements ?? 0),
          totalPlayerAwards,
          totalXP: Number(totals.totalXP ?? 0) + totalPlayerAwards * 250,
          reviewsCount,
        };
      },
    ),
  ]);

  const donationDetails: unknown[] = [];
  for (const donation of donations) {
    if (Array.isArray(donation.details)) {
      donationDetails.push(...donation.details);
    }
  }

  return jsonSuccess(c, {
    ...(serializeValue(profile) as AnyRecord),
    stats,
    avatar: profileAvatar(profile, dbProfile),
    linkedAccounts: serializeValue(dbProfile?.linkedAccounts ?? null),
    creationDate: dateValue(dbProfile?.creationDate ?? null),
    donations: serializeValue(donationDetails),
    discord: Boolean(dbProfile?.discordId),
  });
});

/* ------------------------------------------------------------------------- */
/* Games                                                                      */
/* ------------------------------------------------------------------------- */

const GAME_SORT_VALUES = [
  "completion",
  "alphabetical",
  "xp",
  "achievements",
] as const;

type GameSort = (typeof GAME_SORT_VALUES)[number];

const GAME_SORTS: Record<
  GameSort,
  { ordering: string; fields: MongoSortField[] }
> = {
  completion: {
    ordering: "completionPercentage:desc,product.name:asc,sandboxId:asc",
    fields: [
      { field: "completionPercentage", direction: -1, nulls: "last" },
      { field: "product.name", direction: 1, nulls: "first" },
      { field: "sandboxId", direction: 1, nulls: "first" },
    ],
  },
  alphabetical: {
    ordering: "product.name:asc,sandboxId:asc",
    fields: [
      { field: "product.name", direction: 1, nulls: "first" },
      { field: "sandboxId", direction: 1, nulls: "first" },
    ],
  },
  xp: {
    ordering: "totalXP:desc,product.name:asc,sandboxId:asc",
    fields: [
      { field: "totalXP", direction: -1, nulls: "last" },
      { field: "product.name", direction: 1, nulls: "first" },
      { field: "sandboxId", direction: 1, nulls: "first" },
    ],
  },
  achievements: {
    ordering: "totalUnlocked:desc,product.name:asc,sandboxId:asc",
    fields: [
      { field: "totalUnlocked", direction: -1, nulls: "last" },
      { field: "product.name", direction: 1, nulls: "first" },
      { field: "sandboxId", direction: 1, nulls: "first" },
    ],
  },
};

function gameSortValue(row: AnyRecord, field: string): string | number | null {
  switch (field) {
    case "product.name":
      return row.product?.name ?? null;
    case "completionPercentage":
      return typeof row.completionPercentage === "number"
        ? row.completionPercentage
        : null;
    case "totalXP":
      return typeof row.totalXP === "number" ? row.totalXP : null;
    case "totalUnlocked":
      return typeof row.totalUnlocked === "number" ? row.totalUnlocked : null;
    case "sandboxId":
      return row.sandboxId ?? null;
    default:
      return null;
  }
}

const gamesCursorTuple = (sort: GameSort, row: AnyRecord): CursorSortTuple =>
  GAME_SORTS[sort].fields.map((field) => gameSortValue(row, field.field));

function gamesPipeline(
  accountId: string,
  sort: GameSort,
  platinumOnly: boolean,
  last: CursorSortTuple | null,
  limit: number,
): AnyRecord[] {
  const pipeline: AnyRecord[] = [
    { $match: { epicAccountId: accountId } },
    {
      $group: {
        _id: "$sandboxId",
        totalUnlocked: { $max: "$totalUnlocked" },
        totalXP: { $max: "$totalXP" },
        playerAwards_arr: { $push: "$playerAwards" },
      },
    },
    {
      $addFields: {
        playerAwards: {
          $reduce: {
            input: "$playerAwards_arr",
            initialValue: [],
            in: { $setUnion: ["$$value", "$$this"] },
          },
        },
      },
    },
    { $project: { playerAwards_arr: 0 } },
  ];

  if (platinumOnly) {
    pipeline.push({
      $match: {
        $expr: { $gt: [{ $size: "$playerAwards" }, 0] },
      },
    });
  }

  pipeline.push(
    {
      $lookup: {
        from: "offers",
        let: { sbx: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$namespace", "$$sbx"] },
                  { $eq: ["$offerType", "BASE_GAME"] },
                  { $eq: ["$isCodeRedemptionOnly", false] },
                ],
              },
            },
          },
          { $sort: { isDisplayable: -1, title: 1, lastModifiedDate: -1 } },
          { $limit: 1 },
          {
            $project: {
              _id: 0,
              id: 1,
              namespace: 1,
              keyImages: 1,
              title: 1,
              productSlug: 1,
            },
          },
        ],
        as: "offer",
      },
    },
    { $unwind: { path: "$offer", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "achievementsets",
        localField: "_id",
        foreignField: "sandboxId",
        as: "achievementSets",
      },
    },
    {
      $addFields: {
        totalAchievements: {
          $sum: {
            $map: {
              input: "$achievementSets",
              as: "s",
              in: { $size: { $ifNull: ["$$s.achievements", []] } },
            },
          },
        },
        totalProductXP: {
          $sum: {
            $map: {
              input: "$achievementSets",
              as: "s",
              in: {
                $reduce: {
                  input: { $ifNull: ["$$s.achievements", []] },
                  initialValue: 0,
                  in: { $add: ["$$value", "$$this.xp"] },
                },
              },
            },
          },
        },
      },
    },
    {
      $addFields: {
        productAchievements: {
          totalAchievements: "$totalAchievements",
          totalProductXP: "$totalProductXP",
        },
        completionPercentage: {
          $cond: [
            { $eq: ["$totalAchievements", 0] },
            0,
            { $divide: ["$totalUnlocked", "$totalAchievements"] },
          ],
        },
        baseOfferForSandbox: {
          id: "$offer.id",
          namespace: "$offer.namespace",
          keyImages: "$offer.keyImages",
        },
        product: {
          name: "$offer.title",
          slug: "$offer.productSlug",
        },
        sandboxId: "$_id",
      },
    },
    {
      $project: {
        _id: 0,
        offer: 0,
        achievementSets: 0,
        totalAchievements: 0,
        totalProductXP: 0,
      },
    },
  );

  if (last) {
    pipeline.push({
      $match: mongoKeysetFilter(GAME_SORTS[sort].fields, last),
    });
  }

  pipeline.push(
    { $sort: mongoSortSpec(GAME_SORTS[sort].fields) },
    { $limit: limit + 1 },
  );
  return pipeline;
}

app.get("/profiles/:id/games", async (c) => {
  const id = requireIdParam(c);
  const query = parseStrictQuery(c, {
    ...querySchema.pagination,
    sort: z.enum(GAME_SORT_VALUES).optional(),
    platinum: z.string().optional(),
  });
  const { limit, cursor } = parsePagination({ ...query });
  const sort = query.sort ?? "completion";
  const platinumOnly = parseBoolean(query.platinum, "platinum") ?? false;
  const binding = {
    operation: "profiles.games",
    filters: { profileId: id, sort, platinum: platinumOnly },
    ordering: GAME_SORTS[sort].ordering,
    country: COUNTRY,
    locale: LOCALE,
    limit,
  };

  const result = await cached(
    v1CacheKey("profiles.games", {
      id,
      limit,
      cursor,
      sort,
      platinum: platinumOnly,
    }),
    GAMES_TTL_SECONDS,
    async () => {
      const profile = await fetchEpicProfile(id, GAMES_IDENTITY_TTL_SECONDS);
      if (!profile) {
        throw notFound(
          "PROFILE_NOT_FOUND",
          `No Epic profile was found for '${id}'.`,
        );
      }

      const last = cursor ? decodeCursor(cursor, binding) : null;
      const rows = (await db.db
        .collection("player-achievements")
        .aggregate(gamesPipeline(id, sort, platinumOnly, last, limit), {
          allowDiskUse: true,
          ...(sort === "alphabetical"
            ? { collation: { locale: "en", strength: 2 } }
            : {}),
        })
        .toArray()) as AnyRecord[];

      const { items, hasMore } = trimPage(rows, limit);
      const lastRow = items[items.length - 1];

      return {
        achievements: items.map((row) => serializeValue(row)),
        pagination: pageMeta(
          limit,
          hasMore,
          hasMore && lastRow
            ? encodeCursor(binding, gamesCursorTuple(sort, lastRow))
            : null,
        ),
      };
    },
  );

  return jsonSuccess(
    c,
    { achievements: result.achievements },
    { pagination: result.pagination },
  );
});

/* ------------------------------------------------------------------------- */
/* Random game                                                                */
/* ------------------------------------------------------------------------- */

app.get("/profiles/:id/random-game", async (c) => {
  const id = requireIdParam(c);
  const query = parseStrictQuery(c, {
    sandbox: z.string().max(200).optional(),
  });
  const sandbox = query.sandbox?.trim() || null;

  const offer = await cached(
    v1CacheKey("profiles.randomGame", { id, sandbox: sandbox ?? "random" }),
    RANDOM_GAME_TTL_SECONDS,
    async () => {
      const profile = await fetchEpicProfile(
        id,
        RANDOM_GAME_IDENTITY_TTL_SECONDS,
      );
      if (!profile) {
        throw notFound(
          "PROFILE_NOT_FOUND",
          `No Epic profile was found for '${id}'.`,
        );
      }

      let saved: AnyRecord | null = null;

      if (sandbox) {
        saved = (await db.db.collection("player-achievements").findOne({
          epicAccountId: { $eq: id },
          sandboxId: { $eq: sandbox },
        })) as AnyRecord | null;
      } else {
        const total = await db.db
          .collection("player-achievements")
          .countDocuments({ epicAccountId: { $eq: id } });

        if (total === 0) {
          throw notFound(
            "PROFILE_ACHIEVEMENTS_NOT_FOUND",
            `No achievements were found for '${id}'.`,
          );
        }

        const randomSkip = Math.floor(Math.random() * total);
        const rows = (await db.db
          .collection("player-achievements")
          .find({ epicAccountId: { $eq: id } })
          .skip(randomSkip)
          .limit(1)
          .toArray()) as AnyRecord[];
        saved = rows[0] ?? null;
      }

      if (!saved) {
        throw notFound(
          "PROFILE_SANDBOX_ACHIEVEMENTS_NOT_FOUND",
          sandbox
            ? `No achievements were found for '${id}' in sandbox '${sandbox}'.`
            : `No achievements were found for '${id}'.`,
        );
      }

      const sandboxData = await Sandbox.findOne({
        _id: { $eq: saved.sandboxId },
      }).lean();
      if (!sandboxData) {
        throw notFound(
          "SANDBOX_NOT_FOUND",
          `No sandbox was found for '${saved.sandboxId}'.`,
        );
      }

      const offerDoc = await Offer.findOne({
        namespace: { $eq: saved.sandboxId },
        offerType: "BASE_GAME",
      }).lean();
      if (!offerDoc) {
        throw notFound(
          "OFFER_NOT_FOUND",
          `No base-game offer was found for sandbox '${saved.sandboxId}'.`,
        );
      }

      return serializeValue(offerDoc) as AnyRecord;
    },
  );

  return jsonSuccess(c, offer);
});

export default app;
