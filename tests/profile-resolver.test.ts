import { beforeEach, describe, expect, it, vi } from "vitest";
import profileResolvers from "../src/graphql/resolvers/profile.js";

type Resolver = (
  parent: unknown,
  args: Record<string, unknown>,
  context: Record<string, unknown>,
  info: unknown,
) => Promise<unknown>;

type ProfileAchievementResult = {
  description: string | null;
  displayName: string;
  iconUrl: string;
  rarityPercent: number;
  xp: number;
  sandboxId: string;
  gameTitle: string;
};

type ProfileActivityResult = {
  type: string;
  occurredAt: string;
  gameTitle: string;
  achievementName: string;
  achievementIconUrl: string;
};

type ProfileGameResult = {
  sandboxId: string;
  title: string;
  imageUrl: string;
  completionPercent: number;
  unlocked: number;
  total: number;
  earnedXP: number;
  totalXP: number;
  hasPlatinum: boolean;
  rarestAchievements: ProfileAchievementResult[];
};

type QueryLike = {
  lean: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted(() => ({
  achievementSetFind: vi.fn(),
  collection: vi.fn(),
  epicFindOne: vi.fn(),
  epicGetUser: vi.fn(),
  offerFind: vi.fn(),
  playerAchievementsFind: vi.fn(),
  playerAchievementsToArray: vi.fn(),
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  reviewCountDocuments: vi.fn(),
}));

vi.mock("../src/clients/epic.js", () => ({
  epicStoreClient: {
    getUser: mocks.epicGetUser,
  },
}));

vi.mock("../src/clients/redis.js", () => ({
  default: {
    get: mocks.redisGet,
    set: mocks.redisSet,
  },
}));

vi.mock("../src/db/index.js", () => ({
  db: {
    db: {
      collection: mocks.collection,
    },
  },
}));

vi.mock("../src/models/index.js", () => ({
  AchievementSet: {
    find: mocks.achievementSetFind,
  },
  Offer: {
    find: mocks.offerFind,
  },
  Review: {
    countDocuments: mocks.reviewCountDocuments,
  },
}));

function lean<T>(value: T): QueryLike {
  return {
    lean: vi.fn().mockResolvedValue(value),
  };
}

const epicProfile = {
  epicAccountId: "player-1",
  displayName: "Player One",
  avatar: {
    small: "https://example.test/epic-small.png",
    medium: "https://example.test/epic-medium.png",
    large: "https://example.test/epic-large.png",
  },
};

const dbProfile = {
  accountId: "player-1",
  avatarUrl: {
    variants: ["https://example.test/db-avatar.png"],
  },
  linkedAccounts: {
    steam: "steam-player",
  },
  creationDate: "2024-01-01T00:00:00.000Z",
};

const playerAchievementRows = [
  {
    epicAccountId: "player-1",
    sandboxId: "sandbox-a",
    totalXP: 225,
    totalUnlocked: 3,
    playerAwards: [
      {
        awardType: "PLATINUM",
        unlockedDateTime: "2024-05-04T00:00:00.000Z",
        achievementSetId: "set-a",
      },
    ],
    playerAchievements: [
      {
        playerAchievement: {
          achievementName: "rare-a",
          achievementSetId: "set-a",
          sandboxId: "sandbox-a",
          unlocked: true,
          unlockDate: "2024-05-03T00:00:00.000Z",
          XP: 100,
        },
      },
      {
        playerAchievement: {
          achievementName: "medium-a",
          achievementSetId: "set-a",
          sandboxId: "sandbox-a",
          unlocked: true,
          unlockDate: "2024-05-02T00:00:00.000Z",
          XP: 75,
        },
      },
      {
        playerAchievement: {
          achievementName: "common-a",
          achievementSetId: "set-a",
          sandboxId: "sandbox-a",
          unlocked: true,
          unlockDate: "2024-05-01T00:00:00.000Z",
          XP: 50,
        },
      },
    ],
  },
  {
    epicAccountId: "player-1",
    sandboxId: "sandbox-b",
    totalXP: 25,
    totalUnlocked: 1,
    playerAwards: [],
    playerAchievements: [
      {
        playerAchievement: {
          achievementName: "rare-b",
          achievementSetId: "set-b",
          sandboxId: "sandbox-b",
          unlocked: true,
          unlockDate: "2024-04-01T00:00:00.000Z",
          XP: 25,
        },
      },
    ],
  },
];

const offers = [
  {
    namespace: "sandbox-a",
    title: "Alpha Game",
    isDisplayable: true,
    lastModifiedDate: "2024-01-10T00:00:00.000Z",
    keyImages: [
      {
        type: "OfferImageWide",
        url: "https://example.test/alpha-wide.jpg",
        md5: "alpha",
      },
    ],
  },
  {
    namespace: "sandbox-b",
    title: "Beta Game",
    isDisplayable: true,
    lastModifiedDate: "2024-01-11T00:00:00.000Z",
    keyImages: [
      {
        type: "OfferImageWide",
        url: "https://example.test/beta-wide.jpg",
        md5: "beta",
      },
    ],
  },
];

const achievementSets = [
  {
    sandboxId: "sandbox-a",
    achievementSetId: "set-a",
    isBase: true,
    achievements: [
      {
        name: "rare-a",
        unlockedDisplayName: "Rare Alpha",
        unlockedDescription: "Rare Alpha description",
        unlockedIconLink: "https://example.test/rare-alpha.png",
        completedPercent: 1.5,
        xp: 100,
      },
      {
        name: "medium-a",
        displayName: "Medium Alpha",
        description: "Medium Alpha description",
        unlockedIcon: "https://example.test/medium-alpha.png",
        completedPercent: 35,
        xp: 75,
      },
      {
        name: "common-a",
        displayName: "Common Alpha",
        description: "Common Alpha description",
        unlockedIcon: "https://example.test/common-alpha.png",
        completedPercent: 60,
        xp: 50,
      },
    ],
  },
  {
    sandboxId: "sandbox-b",
    achievementSetId: "set-b",
    isBase: true,
    achievements: [
      {
        name: "rare-b",
        displayName: "Rare Beta",
        description: "Rare Beta description",
        unlockedIcon: "https://example.test/rare-beta.png",
        completedPercent: 2,
        xp: 25,
      },
      {
        name: "locked-b",
        displayName: "Locked Beta",
        description: "Locked Beta description",
        unlockedIcon: "https://example.test/locked-beta.png",
        completedPercent: 20,
        xp: 25,
      },
    ],
  },
];

function queryResolver(name: string) {
  return (profileResolvers.Query as Record<string, Resolver>)[name];
}

function profileResolver(name: string) {
  return (profileResolvers.Profile as Record<string, Resolver>)[name];
}

async function getProfile(context: Record<string, unknown> = {}) {
  return queryResolver("profile")(null, { id: "player-1" }, context, {});
}

beforeEach(() => {
  vi.clearAllMocks();

  mocks.redisGet.mockResolvedValue(null);
  mocks.redisSet.mockResolvedValue("OK");
  mocks.epicGetUser.mockResolvedValue(epicProfile);
  mocks.epicFindOne.mockResolvedValue(dbProfile);
  mocks.reviewCountDocuments.mockResolvedValue(2);
  mocks.playerAchievementsToArray.mockResolvedValue(playerAchievementRows);
  mocks.playerAchievementsFind.mockReturnValue({
    toArray: mocks.playerAchievementsToArray,
  });
  mocks.offerFind.mockReturnValue(lean(offers));
  mocks.achievementSetFind.mockReturnValue(lean(achievementSets));
  mocks.collection.mockImplementation((name: string) => {
    if (name === "epic") {
      return {
        findOne: mocks.epicFindOne,
      };
    }

    if (name === "player-achievements") {
      return {
        find: mocks.playerAchievementsFind,
      };
    }

    throw new Error(`Unexpected collection ${name}`);
  });
});

describe("profile GraphQL resolver", () => {
  it("returns null for a missing Epic profile", async () => {
    mocks.epicGetUser.mockResolvedValue(null);

    await expect(getProfile()).resolves.toBeNull();
    expect(mocks.epicFindOne).not.toHaveBeenCalled();
    expect(mocks.reviewCountDocuments).not.toHaveBeenCalled();
  });

  it("returns base identity with database avatar and linked accounts", async () => {
    const profile = await getProfile();

    expect(profile).toMatchObject({
      accountId: "player-1",
      displayName: "Player One",
      avatar: {
        small: "https://example.test/db-avatar.png",
        medium: "https://example.test/db-avatar.png",
        large: "https://example.test/db-avatar.png",
      },
      linkedAccounts: {
        steam: "steam-player",
      },
      creationDate: "2024-01-01T00:00:00.000Z",
      reviewsCount: 2,
    });
  });

  it("aggregates highlights with platinum XP and level calculation", async () => {
    const context = {};
    const profile = await getProfile(context);
    const highlights = await profileResolver("highlights")(
      profile,
      {},
      context,
      {},
    );

    expect(highlights).toEqual({
      level: 2,
      totalXP: 500,
      totalGames: 2,
      totalAchievements: 4,
      totalPlatinums: 1,
      reviewsCount: 2,
    });

    const refreshedProfile = {
      ...(profile as Record<string, unknown>),
      reviewsCount: 3,
    };
    const refreshedHighlights = await profileResolver("highlights")(
      refreshedProfile,
      {},
      context,
      {},
    );

    expect(refreshedHighlights).toMatchObject({ reviewsCount: 3 });
    expect(mocks.redisGet).toHaveBeenCalledWith(
      expect.stringContaining("graphql:profile:player-1:highlights:reviews:2:"),
    );
    expect(mocks.redisGet).toHaveBeenCalledWith(
      expect.stringContaining("graphql:profile:player-1:highlights:reviews:3:"),
    );
  });

  it("returns featured achievements sorted by rarity, XP, and unlock date", async () => {
    const context = {};
    const profile = await getProfile(context);
    const achievements = (await profileResolver("featuredAchievements")(
      profile,
      { limit: 3 },
      context,
      {},
    )) as ProfileAchievementResult[];

    expect(achievements.map((achievement) => achievement.displayName)).toEqual([
      "Rare Alpha",
      "Rare Beta",
      "Medium Alpha",
    ]);
    expect(achievements[0]).toMatchObject({
      sandboxId: "sandbox-a",
      gameTitle: "Alpha Game",
      description: "Rare Alpha description",
      iconUrl: "https://example.test/rare-alpha.png",
      rarityPercent: 1.5,
      xp: 100,
    });
  });

  it("filters and sorts featured games and paginated game connections", async () => {
    const context = {};
    const profile = await getProfile(context);
    const featuredGames = (await profileResolver("featuredGames")(
      profile,
      { filter: "ALL", limit: 1, sort: "XP" },
      context,
      {},
    )) as ProfileGameResult[];
    const inProgressGames = await profileResolver("games")(
      profile,
      {
        filter: "IN_PROGRESS",
        limit: 12,
        page: 1,
        sort: "ALPHABETICAL",
      },
      context,
      {},
    );

    expect(featuredGames).toHaveLength(1);
    expect(featuredGames[0]).toMatchObject({
      sandboxId: "sandbox-a",
      title: "Alpha Game",
      imageUrl: "https://example.test/alpha-wide.jpg",
      completionPercent: 100,
      unlocked: 3,
      total: 3,
      earnedXP: 225,
      totalXP: 225,
      hasPlatinum: true,
    });
    expect(featuredGames[0].rarestAchievements).toHaveLength(3);
    expect(inProgressGames).toMatchObject({
      total: 1,
      page: 1,
      limit: 12,
      elements: [
        {
          sandboxId: "sandbox-b",
          title: "Beta Game",
          completionPercent: 50,
        },
      ],
    });
  });

  it("returns recent activity sorted newest first with supported activity types", async () => {
    const context = {};
    const profile = await getProfile(context);
    const activity = (await profileResolver("recentActivity")(
      profile,
      { limit: 3, page: 1 },
      context,
      {},
    )) as ProfileActivityResult[];

    expect(activity.map((item) => item.type)).toEqual([
      "PLATINUM_EARNED",
      "ACHIEVEMENT_UNLOCKED",
      "ACHIEVEMENT_UNLOCKED",
    ]);
    expect(activity.map((item) => item.occurredAt)).toEqual([
      "2024-05-04T00:00:00.000Z",
      "2024-05-03T00:00:00.000Z",
      "2024-05-02T00:00:00.000Z",
    ]);
    expect(activity[1]).toMatchObject({
      gameTitle: "Alpha Game",
      achievementName: "Rare Alpha",
      achievementIconUrl: "https://example.test/rare-alpha.png",
    });
  });

  it("reuses profile aggregation work across selected fields in one request", async () => {
    const context = {};
    const profile = await getProfile(context);

    await profileResolver("highlights")(profile, {}, context, {});
    await profileResolver("featuredGames")(
      profile,
      { filter: "ALL", limit: 2, sort: "COMPLETION" },
      context,
      {},
    );
    await profileResolver("recentActivity")(
      profile,
      { limit: 5, page: 1 },
      context,
      {},
    );

    expect(mocks.playerAchievementsFind).toHaveBeenCalledTimes(1);
    expect(mocks.playerAchievementsToArray).toHaveBeenCalledTimes(1);
    expect(mocks.offerFind).toHaveBeenCalledTimes(1);
    expect(mocks.achievementSetFind).toHaveBeenCalledTimes(1);
  });
});
