import { epicStoreClient } from "../../clients/epic.js";
import client from "../../clients/redis.js";
import { db } from "../../db/index.js";
import { AchievementSet, Offer, Review } from "../../models/index.js";
import { getImage } from "../../utils/get-image.js";

type Document = Record<string, any>;

export type ProfileRequestCache = Map<string, Promise<unknown>>;

export type ProfileGameFilter =
  | "ALL"
  | "COMPLETED"
  | "NEAR_PLATINUM"
  | "IN_PROGRESS"
  | "PLATINUM";

export type ProfileGameSort =
  | "COMPLETION"
  | "ALPHABETICAL"
  | "XP"
  | "ACHIEVEMENTS";

export type ProfileIdentity = {
  accountId: string;
  displayName: string | null;
  avatar: {
    small: string | null;
    medium: string | null;
    large: string | null;
  };
  linkedAccounts: Document | null;
  creationDate: string | Date | null;
  reviewsCount: number;
};

export type ProfileHighlights = {
  level: number;
  totalXP: number;
  totalGames: number;
  totalAchievements: number;
  totalPlatinums: number;
  reviewsCount: number;
};

export type ProfileAchievement = {
  name: string;
  displayName: string;
  description: string | null;
  iconUrl: string | null;
  rarityPercent: number;
  xp: number;
  sandboxId: string;
  gameTitle: string;
  unlockedAt: string | Date | null;
};

export type ProfileGame = {
  sandboxId: string;
  title: string;
  imageUrl: string | null;
  completionPercent: number;
  unlocked: number;
  total: number;
  earnedXP: number;
  totalXP: number;
  hasPlatinum: boolean;
  platinumCount: number;
  rarestAchievements: ProfileAchievement[];
};

export type ProfileActivityItem = {
  type: "ACHIEVEMENT_UNLOCKED" | "PLATINUM_EARNED";
  sandboxId: string;
  gameTitle: string;
  achievementName: string | null;
  achievementIconUrl: string | null;
  occurredAt: string | Date;
};

export type ProfileGameConnection = {
  elements: ProfileGame[];
  total: number;
  page: number;
  limit: number;
};

export type ProfileAchievementConnection = {
  elements: ProfileAchievement[];
  total: number;
  page: number;
  limit: number;
};

type PlayerAchievementRow = {
  playerAchievement?: {
    achievementName?: string;
    achievementSetId?: string;
    sandboxId?: string;
    unlocked?: boolean;
    unlockDate?: string | Date | null;
    XP?: number;
  };
};

type NormalizedPlayerGame = {
  sandboxId: string;
  totalUnlocked: number;
  totalXP: number;
  playerAwards: Document[];
  playerAchievements: PlayerAchievementRow[];
};

type ProfileAggregationData = {
  games: ProfileGame[];
  achievements: ProfileAchievement[];
  activity: ProfileActivityItem[];
};

const PROFILE_CACHE_VERSION = "v1";
const PROFILE_IDENTITY_TTL_SECONDS = 3600;
const PROFILE_HIGHLIGHTS_TTL_SECONDS = 300;
const PROFILE_GAMES_TTL_SECONDS = 60;
const PROFILE_ACHIEVEMENTS_TTL_SECONDS = 3600;
const PROFILE_ACTIVITY_TTL_SECONDS = 60;
const DEFAULT_LIMIT = 12;
const DEFAULT_ACHIEVEMENT_LIMIT = 25;
const MAX_LIMIT = 100;
const PLATINUM_XP = 250;

const GAME_IMAGE_TYPES: Parameters<typeof getImage>[1] = [
  "DieselStoreFrontWide",
  "OfferImageWide",
  "Thumbnail",
  "DieselGameBoxWide",
  "DieselStoreFrontTall",
  "OfferImageTall",
];

function clampLimit(value: number | undefined, fallback: number) {
  if (!value || Number.isNaN(value)) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(value), 1), MAX_LIMIT);
}

function clampPage(value: number | undefined) {
  if (!value || Number.isNaN(value)) {
    return 1;
  }

  return Math.max(Math.trunc(value), 1);
}

function roundPercent(value: number) {
  const clamped = Math.min(Math.max(value, 0), 100);
  return Number(clamped.toFixed(2));
}

function normalizeRarityPercent(value: unknown) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return 100;
  }

  const percentage = numeric > 0 && numeric <= 1 ? numeric * 100 : numeric;
  return roundPercent(percentage);
}

function toTime(value: string | Date | null | undefined) {
  if (!value) {
    return 0;
  }

  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function latestDate(
  a: string | Date | null | undefined,
  b: string | Date | null | undefined,
) {
  return toTime(a) >= toTime(b) ? a : b;
}

function stableAwardKey(award: Document) {
  return [
    award.awardType ?? "",
    award.achievementSetId ?? "",
    award.unlockedDateTime ?? "",
  ].join(":");
}

function stableAchievementKey(row: PlayerAchievementRow) {
  const achievement = row.playerAchievement ?? {};
  return [
    achievement.sandboxId ?? "",
    achievement.achievementSetId ?? "",
    achievement.achievementName ?? "",
  ].join(":");
}

function getAchievementXP(achievement: Document) {
  const xp = Number(achievement.xp ?? achievement.XP ?? achievement.score ?? 0);
  return Number.isFinite(xp) ? xp : 0;
}

function getAchievementIconUrl(achievement: Document) {
  return (
    achievement.unlockedIcon ??
    achievement.lockedIcon ??
    achievement.iconUrl ??
    achievement.icon ??
    null
  );
}

function getAchievementDisplayName(achievement: Document) {
  return (
    achievement.displayName ??
    achievement.title ??
    achievement.name ??
    "Unknown achievement"
  );
}

function getGameTitle(offer: Document | null | undefined, sandboxId: string) {
  return offer?.title ?? offer?.product?.name ?? sandboxId;
}

function getGameImageUrl(offer: Document | null | undefined) {
  const keyImages = Array.isArray(offer?.keyImages) ? offer.keyImages : [];

  if (keyImages.length === 0) {
    return null;
  }

  return getImage(keyImages, GAME_IMAGE_TYPES)?.url ?? null;
}

function normalizePlayerGames(rows: Document[]) {
  const bySandbox = new Map<string, NormalizedPlayerGame>();

  for (const row of rows) {
    const sandboxId = String(row.sandboxId ?? "");

    if (!sandboxId) {
      continue;
    }

    const existing =
      bySandbox.get(sandboxId) ??
      ({
        sandboxId,
        totalUnlocked: 0,
        totalXP: 0,
        playerAwards: [],
        playerAchievements: [],
      } satisfies NormalizedPlayerGame);

    existing.totalUnlocked = Math.max(
      existing.totalUnlocked,
      Number(row.totalUnlocked ?? 0),
    );
    existing.totalXP = Math.max(existing.totalXP, Number(row.totalXP ?? 0));

    const awardMap = new Map(
      existing.playerAwards.map((award) => [stableAwardKey(award), award]),
    );
    for (const award of row.playerAwards ?? []) {
      awardMap.set(stableAwardKey(award), award);
    }
    existing.playerAwards = Array.from(awardMap.values());

    const achievementMap = new Map(
      existing.playerAchievements.map((achievement) => [
        stableAchievementKey(achievement),
        achievement,
      ]),
    );
    for (const playerAchievement of row.playerAchievements ?? []) {
      const key = stableAchievementKey(playerAchievement);
      const previous = achievementMap.get(key);

      if (!previous) {
        achievementMap.set(key, playerAchievement);
        continue;
      }

      const previousAchievement = previous.playerAchievement ?? {};
      const nextAchievement = playerAchievement.playerAchievement ?? {};
      achievementMap.set(key, {
        playerAchievement: {
          ...previousAchievement,
          ...nextAchievement,
          unlocked:
            Boolean(previousAchievement.unlocked) ||
            Boolean(nextAchievement.unlocked),
          unlockDate: latestDate(
            previousAchievement.unlockDate,
            nextAchievement.unlockDate,
          ),
          XP: Math.max(
            Number(previousAchievement.XP ?? 0),
            Number(nextAchievement.XP ?? 0),
          ),
        },
      });
    }
    existing.playerAchievements = Array.from(achievementMap.values());

    bySandbox.set(sandboxId, existing);
  }

  return Array.from(bySandbox.values());
}

function groupBySandbox(rows: Document[]) {
  const bySandbox = new Map<string, Document[]>();

  for (const row of rows) {
    const sandboxId = String(row.sandboxId ?? row.namespace ?? "");

    if (!sandboxId) {
      continue;
    }

    const current = bySandbox.get(sandboxId) ?? [];
    current.push(row);
    bySandbox.set(sandboxId, current);
  }

  return bySandbox;
}

function chooseBaseOffer(offers: Document[]) {
  return [...offers].sort((a, b) => {
    const displayableA = a.isDisplayable ? 1 : 0;
    const displayableB = b.isDisplayable ? 1 : 0;

    if (displayableA !== displayableB) {
      return displayableB - displayableA;
    }

    const titleCompare = String(a.title ?? "").localeCompare(
      String(b.title ?? ""),
    );

    if (titleCompare !== 0) {
      return titleCompare;
    }

    return toTime(b.lastModifiedDate) - toTime(a.lastModifiedDate);
  })[0];
}

async function readCached<T>(
  cacheKey: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
) {
  const cached = await client.get(cacheKey);

  if (cached) {
    return JSON.parse(cached) as T;
  }

  const result = await loader();
  await client.set(cacheKey, JSON.stringify(result), "EX", ttlSeconds);
  return result;
}

function memoize<T>(
  requestCache: ProfileRequestCache | undefined,
  key: string,
  loader: () => Promise<T>,
) {
  if (!requestCache) {
    return loader();
  }

  const cached = requestCache.get(key) as Promise<T> | undefined;

  if (cached) {
    return cached;
  }

  const promise = loader();
  requestCache.set(key, promise as Promise<unknown>);
  return promise;
}

function findAchievementDetails(
  achievementSetsBySandbox: Map<string, Document[]>,
  sandboxId: string,
  achievementSetId: string | undefined,
  achievementName: string | undefined,
) {
  if (!achievementName) {
    return null;
  }

  const sets = achievementSetsBySandbox.get(sandboxId) ?? [];

  for (const set of sets) {
    if (
      achievementSetId &&
      set.achievementSetId &&
      set.achievementSetId !== achievementSetId
    ) {
      continue;
    }

    const achievement = (set.achievements ?? []).find(
      (item: Document) => item.name === achievementName,
    );

    if (achievement) {
      return achievement;
    }
  }

  return null;
}

function buildAchievement(
  row: PlayerAchievementRow,
  achievementDetails: Document,
  gameTitle: string,
  sandboxId: string,
): ProfileAchievement {
  const playerAchievement = row.playerAchievement ?? {};
  const name = String(
    achievementDetails.name ?? playerAchievement.achievementName ?? "",
  );

  return {
    name,
    displayName: String(getAchievementDisplayName(achievementDetails)),
    description: achievementDetails.description ?? null,
    iconUrl: getAchievementIconUrl(achievementDetails),
    rarityPercent: normalizeRarityPercent(achievementDetails.completedPercent),
    xp: getAchievementXP(achievementDetails),
    sandboxId,
    gameTitle,
    unlockedAt: playerAchievement.unlockDate ?? null,
  };
}

function buildActivityItems(
  game: NormalizedPlayerGame,
  gameTitle: string,
  achievements: ProfileAchievement[],
) {
  const achievementItems: ProfileActivityItem[] = achievements
    .filter((achievement) => achievement.unlockedAt)
    .map((achievement) => ({
      type: "ACHIEVEMENT_UNLOCKED",
      sandboxId: game.sandboxId,
      gameTitle,
      achievementName: achievement.displayName,
      achievementIconUrl: achievement.iconUrl,
      occurredAt: achievement.unlockedAt as string | Date,
    }));

  const awardItems: ProfileActivityItem[] = game.playerAwards
    .filter((award) => award.unlockedDateTime)
    .map((award) => ({
      type: "PLATINUM_EARNED",
      sandboxId: game.sandboxId,
      gameTitle,
      achievementName: null,
      achievementIconUrl: null,
      occurredAt: award.unlockedDateTime,
    }));

  return [...achievementItems, ...awardItems];
}

async function buildProfileAggregationData(accountId: string) {
  const rows = await db.db
    .collection("player-achievements")
    .find({ epicAccountId: { $eq: accountId } })
    .toArray();

  const playerGames = normalizePlayerGames(rows);
  const sandboxIds = playerGames.map((game) => game.sandboxId);

  if (sandboxIds.length === 0) {
    return {
      games: [],
      achievements: [],
      activity: [],
    } satisfies ProfileAggregationData;
  }

  const [offers, achievementSets] = await Promise.all([
    Offer.find({
      namespace: { $in: sandboxIds },
      offerType: "BASE_GAME",
      isCodeRedemptionOnly: false,
    }).lean(),
    AchievementSet.find({ sandboxId: { $in: sandboxIds } }).lean(),
  ]);

  const offersBySandbox = groupBySandbox(offers);
  const achievementSetsBySandbox = groupBySandbox(achievementSets);
  const games: ProfileGame[] = [];
  const achievements: ProfileAchievement[] = [];
  const activity: ProfileActivityItem[] = [];

  for (const game of playerGames) {
    const offer = chooseBaseOffer(offersBySandbox.get(game.sandboxId) ?? []);
    const sets = achievementSetsBySandbox.get(game.sandboxId) ?? [];
    const totalAchievements = sets.reduce(
      (total, set) => total + (set.achievements?.length ?? 0),
      0,
    );
    const totalXP = sets.reduce(
      (total, set) =>
        total +
        (set.achievements ?? []).reduce(
          (sum: number, achievement: Document) =>
            sum + getAchievementXP(achievement),
          0,
        ),
      0,
    );
    const unlockedAchievements = game.playerAchievements
      .filter((row) => row.playerAchievement?.unlocked)
      .map((row) => {
        const playerAchievement = row.playerAchievement ?? {};
        const achievementDetails = findAchievementDetails(
          achievementSetsBySandbox,
          game.sandboxId,
          playerAchievement.achievementSetId,
          playerAchievement.achievementName,
        );

        if (!achievementDetails) {
          return null;
        }

        return buildAchievement(
          row,
          achievementDetails,
          getGameTitle(offer, game.sandboxId),
          game.sandboxId,
        );
      })
      .filter((achievement): achievement is ProfileAchievement =>
        Boolean(achievement),
      );

    unlockedAchievements.sort(sortAchievementsByRarity);
    achievements.push(...unlockedAchievements);
    activity.push(
      ...buildActivityItems(
        game,
        getGameTitle(offer, game.sandboxId),
        unlockedAchievements,
      ),
    );

    games.push({
      sandboxId: game.sandboxId,
      title: getGameTitle(offer, game.sandboxId),
      imageUrl: getGameImageUrl(offer),
      completionPercent:
        totalAchievements > 0
          ? roundPercent((game.totalUnlocked / totalAchievements) * 100)
          : 0,
      unlocked: game.totalUnlocked,
      total: totalAchievements,
      earnedXP: game.totalXP,
      totalXP,
      hasPlatinum: game.playerAwards.length > 0,
      platinumCount: game.playerAwards.length,
      rarestAchievements: unlockedAchievements.slice(0, 3),
    });
  }

  achievements.sort(sortAchievementsByRarity);
  activity.sort((a, b) => toTime(b.occurredAt) - toTime(a.occurredAt));

  return {
    games,
    achievements,
    activity,
  } satisfies ProfileAggregationData;
}

function sortAchievementsByRarity(
  a: ProfileAchievement,
  b: ProfileAchievement,
) {
  if (a.rarityPercent !== b.rarityPercent) {
    return a.rarityPercent - b.rarityPercent;
  }

  if (a.xp !== b.xp) {
    return b.xp - a.xp;
  }

  return toTime(b.unlockedAt) - toTime(a.unlockedAt);
}

function filterGames(games: ProfileGame[], filter: ProfileGameFilter) {
  switch (filter) {
    case "COMPLETED":
      return games.filter((game) => game.completionPercent >= 100);
    case "IN_PROGRESS":
      return games.filter(
        (game) =>
          game.unlocked > 0 &&
          game.completionPercent < 100 &&
          !game.hasPlatinum,
      );
    case "NEAR_PLATINUM":
      return games.filter(
        (game) =>
          game.unlocked > 0 &&
          game.completionPercent >= 80 &&
          game.completionPercent < 100 &&
          !game.hasPlatinum,
      );
    case "PLATINUM":
      return games.filter((game) => game.hasPlatinum);
    default:
      return games;
  }
}

function sortGames(games: ProfileGame[], sort: ProfileGameSort) {
  return [...games].sort((a, b) => {
    if (sort === "ALPHABETICAL") {
      return (
        a.title.localeCompare(b.title) || a.sandboxId.localeCompare(b.sandboxId)
      );
    }

    if (sort === "XP" && a.earnedXP !== b.earnedXP) {
      return b.earnedXP - a.earnedXP;
    }

    if (sort === "ACHIEVEMENTS" && a.unlocked !== b.unlocked) {
      return b.unlocked - a.unlocked;
    }

    if (a.completionPercent !== b.completionPercent) {
      return b.completionPercent - a.completionPercent;
    }

    if (a.earnedXP !== b.earnedXP) {
      return b.earnedXP - a.earnedXP;
    }

    if (a.unlocked !== b.unlocked) {
      return b.unlocked - a.unlocked;
    }

    return (
      a.title.localeCompare(b.title) || a.sandboxId.localeCompare(b.sandboxId)
    );
  });
}

function paginate<T>(items: T[], limit: number, page: number) {
  const resolvedLimit = clampLimit(limit, DEFAULT_LIMIT);
  const resolvedPage = clampPage(page);
  const start = (resolvedPage - 1) * resolvedLimit;

  return {
    elements: items.slice(start, start + resolvedLimit),
    total: items.length,
    page: resolvedPage,
    limit: resolvedLimit,
  };
}

function getAggregationData(
  accountId: string,
  requestCache?: ProfileRequestCache,
) {
  return memoize(requestCache, `profile:${accountId}:aggregation`, () =>
    buildProfileAggregationData(accountId),
  );
}

export async function getProfileIdentity(
  accountId: string,
  requestCache?: ProfileRequestCache,
) {
  return memoize(requestCache, `profile:${accountId}:identity`, () =>
    readCached<ProfileIdentity | null>(
      `graphql:profile:${accountId}:identity:${PROFILE_CACHE_VERSION}`,
      PROFILE_IDENTITY_TTL_SECONDS,
      async () => {
        const profile = await epicStoreClient.getUser(accountId);

        if (!profile) {
          return null;
        }

        const [dbProfile, reviewsCount] = await Promise.all([
          db.db.collection("epic").findOne({
            accountId: { $eq: accountId },
          }),
          Review.countDocuments({ userId: accountId }),
        ]);

        return {
          accountId,
          displayName: profile.displayName ?? null,
          avatar: {
            small:
              dbProfile?.avatarUrl?.variants?.[0] ??
              profile.avatar?.small ??
              null,
            medium:
              dbProfile?.avatarUrl?.variants?.[0] ??
              profile.avatar?.medium ??
              null,
            large:
              dbProfile?.avatarUrl?.variants?.[0] ??
              profile.avatar?.large ??
              null,
          },
          linkedAccounts: dbProfile?.linkedAccounts ?? null,
          creationDate: dbProfile?.creationDate ?? null,
          reviewsCount,
        };
      },
    ),
  );
}

export async function getProfileGames(
  accountId: string,
  args: {
    filter?: ProfileGameFilter;
    sort?: ProfileGameSort;
  } = {},
  requestCache?: ProfileRequestCache,
) {
  const filter = args.filter ?? "ALL";
  const sort = args.sort ?? "COMPLETION";

  return memoize(
    requestCache,
    `profile:${accountId}:games:${filter}:${sort}`,
    () =>
      readCached<ProfileGame[]>(
        `graphql:profile:${accountId}:games:${filter}:${sort}:${PROFILE_CACHE_VERSION}`,
        PROFILE_GAMES_TTL_SECONDS,
        async () => {
          const data = await getAggregationData(accountId, requestCache);
          return sortGames(filterGames(data.games, filter), sort);
        },
      ),
  );
}

export async function getProfileHighlights(
  accountId: string,
  reviewsCount: number,
  requestCache?: ProfileRequestCache,
) {
  return memoize(
    requestCache,
    `profile:${accountId}:highlights:reviews:${reviewsCount}`,
    () =>
      readCached<ProfileHighlights>(
        `graphql:profile:${accountId}:highlights:reviews:${reviewsCount}:${PROFILE_CACHE_VERSION}`,
        PROFILE_HIGHLIGHTS_TTL_SECONDS,
        async () => {
          const games = await getProfileGames(
            accountId,
            { filter: "ALL", sort: "COMPLETION" },
            requestCache,
          );
          const totalPlatinums = games.reduce(
            (sum, game) =>
              sum + (game.platinumCount ?? (game.hasPlatinum ? 1 : 0)),
            0,
          );
          const totalXP =
            games.reduce((sum, game) => sum + game.earnedXP, 0) +
            totalPlatinums * PLATINUM_XP;

          return {
            level: Math.floor(totalXP / PLATINUM_XP),
            totalXP,
            totalGames: games.length,
            totalAchievements: games.reduce(
              (sum, game) => sum + game.unlocked,
              0,
            ),
            totalPlatinums,
            reviewsCount,
          };
        },
      ),
  );
}

export async function getProfileHeroGame(
  accountId: string,
  requestCache?: ProfileRequestCache,
) {
  const games = await getProfileGames(
    accountId,
    { filter: "ALL", sort: "COMPLETION" },
    requestCache,
  );

  return (
    [...games].sort((a, b) => {
      const imageA = a.imageUrl ? 1 : 0;
      const imageB = b.imageUrl ? 1 : 0;

      if (imageA !== imageB) {
        return imageB - imageA;
      }

      if (a.completionPercent !== b.completionPercent) {
        return b.completionPercent - a.completionPercent;
      }

      if (a.earnedXP !== b.earnedXP) {
        return b.earnedXP - a.earnedXP;
      }

      if (a.unlocked !== b.unlocked) {
        return b.unlocked - a.unlocked;
      }

      return (
        a.title.localeCompare(b.title) || a.sandboxId.localeCompare(b.sandboxId)
      );
    })[0] ?? null
  );
}

export async function getFeaturedAchievements(
  accountId: string,
  limit: number | undefined,
  requestCache?: ProfileRequestCache,
) {
  const resolvedLimit = clampLimit(limit, 8);

  return memoize(
    requestCache,
    `profile:${accountId}:featured-achievements:${resolvedLimit}`,
    () =>
      readCached<ProfileAchievement[]>(
        `graphql:profile:${accountId}:featured-achievements:${resolvedLimit}:${PROFILE_CACHE_VERSION}`,
        PROFILE_ACHIEVEMENTS_TTL_SECONDS,
        async () => {
          const data = await getAggregationData(accountId, requestCache);
          return data.achievements.slice(0, resolvedLimit);
        },
      ),
  );
}

export async function getRecentActivity(
  accountId: string,
  limit: number | undefined,
  page: number | undefined,
  requestCache?: ProfileRequestCache,
) {
  const resolvedLimit = clampLimit(limit, DEFAULT_LIMIT);
  const resolvedPage = clampPage(page);

  return memoize(
    requestCache,
    `profile:${accountId}:activity:${resolvedLimit}:${resolvedPage}`,
    () =>
      readCached<ProfileActivityItem[]>(
        `graphql:profile:${accountId}:activity:${resolvedLimit}:${resolvedPage}:${PROFILE_CACHE_VERSION}`,
        PROFILE_ACTIVITY_TTL_SECONDS,
        async () => {
          const data = await getAggregationData(accountId, requestCache);
          const start = (resolvedPage - 1) * resolvedLimit;
          return data.activity.slice(start, start + resolvedLimit);
        },
      ),
  );
}

export async function getFeaturedGames(
  accountId: string,
  args: {
    filter?: ProfileGameFilter;
    limit?: number;
    sort?: ProfileGameSort;
  },
  requestCache?: ProfileRequestCache,
) {
  const games = await getProfileGames(
    accountId,
    {
      filter: args.filter ?? "ALL",
      sort: args.sort ?? "COMPLETION",
    },
    requestCache,
  );

  return games.slice(0, clampLimit(args.limit, 6));
}

export async function getProfileGameConnection(
  accountId: string,
  args: {
    filter?: ProfileGameFilter;
    limit?: number;
    page?: number;
    sort?: ProfileGameSort;
  },
  requestCache?: ProfileRequestCache,
): Promise<ProfileGameConnection> {
  const games = await getProfileGames(
    accountId,
    {
      filter: args.filter ?? "ALL",
      sort: args.sort ?? "COMPLETION",
    },
    requestCache,
  );

  return paginate(games, args.limit ?? DEFAULT_LIMIT, args.page ?? 1);
}

export async function getProfileAchievementConnection(
  accountId: string,
  limit: number | undefined,
  page: number | undefined,
  requestCache?: ProfileRequestCache,
): Promise<ProfileAchievementConnection> {
  const data = await getAggregationData(accountId, requestCache);
  return paginate(
    data.achievements,
    limit ?? DEFAULT_ACHIEVEMENT_LIMIT,
    page ?? 1,
  );
}
