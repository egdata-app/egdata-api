import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertOracle, captureResponse } from "../rust/oracles/record.js";
import { ProblemError, problemResponse } from "../src/v1/errors.js";
import { responseEtag } from "../src/middlewares/response-etag.js";
import { v1CachePolicy, v1Context } from "../src/v1/request-context.js";
import type { V1Variables } from "../src/v1/request-context.js";
import ProfileRoute from "../src/v1/routes/profiles.js";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  aggregate: vi.fn(),
  findOne: vi.fn(),
  findMany: vi.fn(),
  countDocuments: vi.fn(),
  modelFind: vi.fn(),
  modelFindOne: vi.fn(),
}));

vi.mock("../src/clients/epic.js", () => ({
  epicStoreClient: { getUser: mocks.getUser },
}));
vi.mock("../src/v1/cache.js", () => ({
  cachedTotal: async (
    _operation: string,
    _parts: unknown,
    _ttl: number,
    fn: () => unknown,
  ) => fn(),
  cached: async (_key: string, _ttl: number, fn: () => unknown) => fn(),
  v1CacheKey: (op: string, parts: Record<string, unknown>) =>
    `${op}:${JSON.stringify(parts)}`,
}));
vi.mock("../src/db/index.js", () => ({
  db: {
    db: {
      collection: () => ({
        aggregate: mocks.aggregate,
        findOne: mocks.findOne,
        countDocuments: mocks.countDocuments,
        find: mocks.findMany,
      }),
    },
  },
}));
vi.mock("../src/models/index.js", () => ({
  AchievementSet: { find: mocks.modelFind },
  Offer: { find: mocks.modelFind, findOne: mocks.modelFindOne },
  Sandbox: { find: mocks.modelFind, findOne: mocks.modelFindOne },
}));

const app = new Hono<{ Variables: V1Variables }>();
app.use("*", v1Context());
app.use("*", responseEtag);
app.use("*", v1CachePolicy());
app.route("/v1", ProfileRoute);
app.onError((error, c) =>
  problemResponse(
    c,
    error instanceof ProblemError
      ? error
      : new ProblemError({
          status: 500,
          code: "INTERNAL_ERROR",
          detail:
            "The API could not complete the request. Retry later and include the request ID when contacting support.",
        }),
  ),
);

describe("Rust profiles HTTP Node oracle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-17T00:00:00.000Z"));
    mocks.getUser.mockReset().mockResolvedValue(null);
    mocks.aggregate
      .mockReset()
      .mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });
    mocks.findOne.mockReset().mockResolvedValue(null);
    mocks.findMany
      .mockReset()
      .mockReturnValue({
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([]),
      });
    mocks.countDocuments.mockReset().mockResolvedValue(0);
    const q = { lean: vi.fn().mockResolvedValue([]) };
    mocks.modelFind.mockReset().mockReturnValue(q);
    mocks.modelFindOne
      .mockReset()
      .mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
  });

  it("records all nine profile operations through the actual Hono handlers", async () => {
    type TestProfile =
      | {
          epicAccountId: string;
          displayName: string;
          avatar: { small: string; medium: string; large: string };
        }
      | null
      | "__EPIC_ERROR__";
    const profile = {
      epicAccountId: "player-2",
      displayName: "Public Player",
      avatar: {
        small: "https://img/s",
        medium: "https://img/m",
        large: "https://img/l",
      },
    };
    const gameRows = [0.9, 0.8, 0.7].map((completionPercentage, index) => ({
      totalUnlocked: 9 - index,
      totalXP: 1000 - index * 100,
      playerAwards: [],
      productAchievements: { totalAchievements: 10, totalProductXP: 1000 },
      completionPercentage,
      baseOfferForSandbox: {
        id: `offer-${index}`,
        namespace: `sandbox-${index}`,
        keyImages: [],
      },
      product: { name: `Game ${index}`, slug: `game-${index}` },
      sandboxId: `sandbox-${index}`,
    }));
    const nodeHeaders = {
      "x-egdata-key-id": "key_oracle",
      "x-egdata-key-tier": "free",
      "x-request-id": "req_node_oracle",
    };
    const leaderboardRows = [
      {
        rank: 1,
        accountId: "account-1",
        displayName: "Top Player",
        xpEarned: 9000,
        achievementsWon: 90,
        awardsEarned: 2,
        awardsByType: { GOLD: 2 },
      },
      {
        rank: 2,
        accountId: "account-2",
        displayName: "Second Player",
        xpEarned: 8000,
        achievementsWon: 80,
        awardsEarned: 1,
        awardsByType: { SILVER: 1 },
      },
      {
        rank: 3,
        accountId: "account-3",
        displayName: "Third Player",
        xpEarned: 7000,
        achievementsWon: 70,
        awardsEarned: 0,
        awardsByType: {},
      },
    ];
    const detailFindResults = [
      [
        {
          sandboxId: "sandbox-1",
          playerAwards: [{ awardType: "GOLD", id: "award-1" }],
          totalXP: 50,
          totalUnlocked: 2,
        },
      ],
      [{ _id: "product-1", name: "Product One" }],
    ];
    const detailModelFindResults = [
      [{ _id: "sandbox-1", parent: "product-1" }],
      [
        {
          id: "offer-1",
          namespace: "sandbox-1",
          title: "Game One",
          productSlug: "game-one",
          keyImages: [],
        },
      ],
      [{ sandboxId: "sandbox-1", achievements: [{ xp: 5 }, { xp: 10 }] }],
    ];
    const randomSaved = {
      epicAccountId: "player-2",
      sandboxId: "sandbox-1",
      totalXP: 50,
    };
    const randomModelFindOneResults = [
      { _id: "sandbox-1", parent: "product-1" },
      {
        id: "offer-1",
        namespace: "sandbox-1",
        offerType: "BASE_GAME",
        title: "Game One",
        productSlug: "game-one",
        keyImages: [],
      },
    ];
    const achievementRows = [0, 1].map((index) => ({
      achievementName: `Achievement ${index}`,
      unlockDate: `2026-11-${16 - index}T00:00:00.000Z`,
      XP: 10,
      sandboxId: `sandbox-${index}`,
      isBase: true,
      achievementDetails: {
        name: `Achievement ${index}`,
        description: `Description ${index}`,
        xp: 10,
        completedPercent: 12 + index,
      },
      sortUnlockDate: `2026-11-${16 - index}T00:00:00.000Z`,
    }));
    const rareRows = [
      {
        name: "Rare Achievement",
        description: "Rare",
        completedPercent: 3,
        sandboxId: "sandbox-1",
        achievementSetId: "set-1",
        unlocked: true,
        unlockDate: "2026-11-16T00:00:00.000Z",
        offer: {
          id: "offer-1",
          namespace: "sandbox-1",
          title: "Game One",
          productSlug: "game-one",
          keyImages: [],
        },
      },
    ];
    const rareSandboxRows = [
      {
        name: "Rare Sandbox Achievement",
        description: "Rare sandbox",
        completedPercent: 1,
        sandboxId: "sandbox-1",
        achievementSetId: "set-1",
        unlocked: true,
        unlockDate: "2026-11-15T00:00:00.000Z",
      },
    ];
    const informationRows = [
      {
        totalGames: 5,
        totalPlayerAwards: 3,
        totalAchievements: 25,
        totalXP: 100,
      },
    ];
    const sandboxPlayerRows = [
      {
        epicAccountId: "player-1",
        sandboxId: "sandbox-1",
        achievementSets: [{ achievementSetId: "set-1" }],
        playerAchievements: [{ achievementName: "A" }],
      },
    ];
    const sandboxSetRows = [
      {
        achievementSetId: "set-1",
        sandboxId: "sandbox-1",
        achievements: [{ name: "A", xp: 10 }],
      },
    ];
    const paths: Array<
      [string, string, TestProfile, Record<string, unknown>[][] | null]
    > = [
      [
        "profiles_leaderboard",
        "/v1/profiles/leaderboard?limit=2",
        null,
        [leaderboardRows],
      ],
      ["profiles_detail_missing", "/v1/profiles/player-1", null, null],
      [
        "profiles_achievements",
        "/v1/profiles/player-1/achievements?limit=2",
        null,
        null,
      ],
      [
        "profiles_achievements_populated",
        "/v1/profiles/player-1/achievements?limit=1",
        null,
        [achievementRows, [{ count: 2 }]],
      ],
      [
        "profiles_sandbox_achievements",
        "/v1/profiles/player-1/achievements/sandbox-1",
        null,
        null,
      ],
      [
        "profiles_sandbox_achievements_populated",
        "/v1/profiles/player-1/achievements/sandbox-1",
        null,
        null,
      ],
      [
        "profiles_rare_achievements",
        "/v1/profiles/player-1/rare-achievements",
        null,
        [rareRows],
      ],
      [
        "profiles_rare_sandbox_achievements",
        "/v1/profiles/player-1/rare-achievements/sandbox-1",
        null,
        [rareSandboxRows],
      ],
      [
        "profiles_information_missing",
        "/v1/profiles/player-1/information",
        null,
        null,
      ],
      [
        "profiles_games_missing",
        "/v1/profiles/player-1/games?limit=2",
        null,
        null,
      ],
      [
        "profiles_random_game_missing",
        "/v1/profiles/player-1/random-game?sandbox=sandbox-1",
        null,
        null,
      ],
      [
        "profiles_random_game_populated",
        "/v1/profiles/player-2/random-game?sandbox=sandbox-1",
        profile,
        null,
      ],
      ["profiles_detail_populated", "/v1/profiles/player-2", profile, null],
      [
        "profiles_information_populated",
        "/v1/profiles/player-2/information",
        profile,
        [informationRows],
      ],
      [
        "profiles_games_populated",
        "/v1/profiles/player-2/games?limit=2",
        profile,
        [gameRows],
      ],

      [
        "profiles_games_invalid_platinum",
        "/v1/profiles/player-2/games?platinum=perhaps",
        profile,
        null,
      ],
      [
        "profiles_games_invalid_cursor",
        "/v1/profiles/player-2/games?cursor=not-a-cursor",
        profile,
        null,
      ],
      [
        "profiles_epic_failure",
        "/v1/profiles/player-3",
        "__EPIC_ERROR__",
        null,
      ],
    ];
    const cases = [] as Array<Record<string, unknown>>;
    for (const [name, path, profile, aggregateResults] of paths) {
      let aggregateIndex = 0;
      mocks.aggregate
        .mockReset()
        .mockImplementation(() => ({
          toArray: vi
            .fn()
            .mockResolvedValue(aggregateResults?.[aggregateIndex++] ?? []),
        }));
      const mongoOneResults =
        name === "profiles_random_game_populated" ? [randomSaved] : [];
      let mongoOneIndex = 0;
      mocks.findOne
        .mockReset()
        .mockImplementation(
          async () => mongoOneResults[mongoOneIndex++] ?? null,
        );
      mocks.countDocuments.mockReset().mockResolvedValue(0);
      let findIndex = 0;
      const findResults =
        name === "profiles_detail_populated"
          ? detailFindResults
          : name === "profiles_sandbox_achievements_populated"
            ? [sandboxPlayerRows]
            : [];
      mocks.findMany
        .mockReset()
        .mockImplementation(() => ({
          skip: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          toArray: vi.fn().mockResolvedValue(findResults[findIndex++] ?? []),
        }));
      let modelIndex = 0;
      const modelResults =
        name === "profiles_detail_populated"
          ? detailModelFindResults
          : name === "profiles_sandbox_achievements_populated"
            ? [sandboxSetRows]
            : [];
      mocks.modelFind
        .mockReset()
        .mockImplementation(() => ({
          lean: vi.fn().mockResolvedValue(modelResults[modelIndex++] ?? []),
        }));
      const modelOneResults =
        name === "profiles_random_game_populated"
          ? randomModelFindOneResults
          : [];
      let modelOneIndex = 0;
      mocks.modelFindOne
        .mockReset()
        .mockImplementation(() => ({
          lean: vi
            .fn()
            .mockResolvedValue(modelOneResults[modelOneIndex++] ?? null),
        }));
      mocks.getUser.mockReset();
      if (profile === "__EPIC_ERROR__") mocks.getUser.mockResolvedValue(null);
      else mocks.getUser.mockResolvedValue(profile);
      const request = { method: "GET", path };
      const response = await app.request(path, { headers: nodeHeaders });
      cases.push({
        name,
        request,
        input: {
          mongoAggregate: mocks.aggregate.mock.calls.map(
            ([pipeline]) => pipeline,
          ),
          mongoAggregateResults: aggregateResults ?? [],
          mongoFind: mocks.findMany.mock.calls.map(([filter]) => filter),
          mongoFindResults: findResults,
          modelFind: mocks.modelFind.mock.calls.map(([filter]) => filter),
          modelFindResults: modelResults,
          mongoFindOne: mocks.findOne.mock.calls.map(([filter]) => filter),
          mongoFindOneResults: mongoOneResults,
          modelFindOne: mocks.modelFindOne.mock.calls.map(([filter]) => filter),
          modelFindOneResults: modelOneResults,
          mongoCount: mocks.countDocuments.mock.calls.map(([filter]) => filter),
          epicProfile: profile === "__EPIC_ERROR__" ? null : profile,
          epicError: profile === "__EPIC_ERROR__",
        },
        response: await captureResponse(response),
      });
    }
    const firstPage = cases.find(
      (entry) => entry.name === "profiles_leaderboard",
    )?.response as { body: { meta: { pagination: { nextCursor: string } } } };
    const cursor = firstPage.body.meta.pagination.nextCursor;
    mocks.aggregate
      .mockReset()
      .mockReturnValue({
        toArray: vi.fn().mockResolvedValue([leaderboardRows[2]]),
      });
    const cursorPath = `/v1/profiles/leaderboard?limit=2&cursor=${encodeURIComponent(cursor)}`;
    const cursorResponse = await app.request(cursorPath, {
      headers: nodeHeaders,
    });
    cases.push({
      name: "profiles_leaderboard_continuation",
      request: { method: "GET", path: cursorPath },
      input: {
        mongoAggregate: mocks.aggregate.mock.calls.map(
          ([pipeline]) => pipeline,
        ),
        mongoAggregateResults: [[leaderboardRows[2]]],
        mongoFindOne: [],
        mongoCount: [],
        epicProfile: null,
        epicError: false,
      },
      response: await captureResponse(cursorResponse),
    });
    const gameFirstPage = cases.find(
      (entry) => entry.name === "profiles_games_populated",
    )?.response as { body: { meta: { pagination: { nextCursor: string } } } };
    mocks.aggregate
      .mockReset()
      .mockReturnValue({ toArray: vi.fn().mockResolvedValue([gameRows[2]]) });
    mocks.getUser.mockReset().mockResolvedValue(profile);
    const gameCursorPath = `/v1/profiles/player-2/games?limit=2&cursor=${encodeURIComponent(gameFirstPage.body.meta.pagination.nextCursor)}`;
    const gameCursorResponse = await app.request(gameCursorPath, {
      headers: nodeHeaders,
    });
    cases.push({
      name: "profiles_games_continuation",
      request: { method: "GET", path: gameCursorPath },
      input: {
        mongoAggregate: mocks.aggregate.mock.calls.map(
          ([pipeline]) => pipeline,
        ),
        mongoAggregateResults: [[gameRows[2]]],
        mongoFind: [],
        modelFind: [],
        mongoFindOne: [],
        mongoCount: [],
        epicProfile: profile,
        epicError: false,
      },
      response: await captureResponse(gameCursorResponse),
    });
    assertOracle("profiles-http-node", cases);
    expect(new Set(cases.map(({ name }) => name)).size).toBe(cases.length);
  });
});
