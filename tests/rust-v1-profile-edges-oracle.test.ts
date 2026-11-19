import { readFileSync } from "node:fs";
import { v1CacheKey } from "../src/v1/cache.js";
import { encodeCursor, type CursorBinding } from "../src/v1/cursor.js";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { assertOracle, captureResponse } from "../rust/oracles/record.js";
import { responseEtag } from "../src/middlewares/response-etag.js";
import { ProblemError, problemResponse } from "../src/v1/errors.js";
import {
  v1CachePolicy,
  v1Context,
  type V1Variables,
} from "../src/v1/request-context.js";
import routes from "../src/v1/routes/profiles.js";

type Doc = Record<string, unknown>;
const driver = vi.hoisted(() => {
  const trace: Doc[] = [];
  const answers = new Map<string, unknown[]>();
  const cache = new Map<string, string>();
  const call = (operation: string, entry: Doc, fallback: unknown) => {
    if ("query" in entry) {
      entry.query = JSON.parse(
        JSON.stringify(entry.query, function (key, value) {
          // Mongo's client defaults to ignoreUndefined: false on the wire.
          if (value === undefined) return null;
          return this[key] instanceof Date
            ? { $date: this[key].toISOString() }
            : value;
        }),
      );
    }
    const queue = answers.get(operation);
    const result = queue?.length ? queue.shift() : fallback;
    if (result instanceof Error) {
      trace.push({ call: entry, error: true });
      throw result;
    }
    trace.push({ call: entry, result });
    return result;
  };
  function collection(collection: string) {
    const mongo = (
      method: string,
      query: unknown,
      options: Doc,
      result: unknown,
    ) =>
      call(
        collection + "." + method,
        { collection, method, query, options },
        result,
      );
    return {
      findOne: async (query: Doc, options = {}) =>
        mongo("one", query, options, null),
      countDocuments: async (query: Doc) => mongo("count", query, {}, 0),
      aggregate: (query: unknown[], options = {}) => ({
        toArray: async () => mongo("aggregate", query, options, []),
      }),
      find: (query: Doc, base = {}) => {
        const options: Doc = { ...base };
        return {
          skip(n: number) {
            options.skip = n;
            return this;
          },
          limit(n: number) {
            options.limit = n;
            return this;
          },
          toArray: async () => mongo("many", query, options, []),
        };
      },
    };
  }
  return { trace, answers, cache, call, collection };
});
vi.mock("../src/db/index.js", () => ({
  db: { db: { collection: driver.collection } },
}));
vi.mock("../src/clients/epic.js", () => ({
  epicStoreClient: {
    getUser: async (id: string) =>
      driver.call(
        "epic",
        { method: "epicUser", id },
        { accountId: id, displayName: "Fixture" },
      ),
  },
}));
vi.mock("../src/clients/response-cache.js", () => ({
  default: {
    get: async (key: string) => {
      const value = driver.cache.get(key);
      driver.call(
        "cache.get",
        { method: "get", key },
        value ? JSON.parse(value) : null,
      );
      return value ?? null;
    },
    set: async (key: string, raw: string, mode: string, ttl: number) => {
      expect(mode).toBe("EX");
      driver.call(
        "cache.set",
        { method: "set", key, payload: JSON.parse(raw), ttl },
        null,
      );
      driver.cache.set(key, raw);
    },
  },
}));

it("compares profile cache, storage, projection and pagination at the service boundary", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-17T00:00:00Z"));
  vi.stubEnv(
    "V1_CURSOR_SECRET",
    "deterministic-collection-cursor-secret-for-oracle",
  );
  const app = new Hono<{ Variables: V1Variables }>();
  app.use("*", v1Context());
  app.use("*", responseEtag);
  app.use("*", v1CachePolicy());
  app.route("/v1", routes);
  app.onError((err, c) =>
    problemResponse(
      c,
      err instanceof ProblemError
        ? err
        : new ProblemError({
            status: 500,
            code: "INTERNAL_ERROR",
            detail:
              "The API could not complete the request. Retry later and include the request ID when contacting support.",
          }),
    ),
  );
  const cases: Doc[] = [];
  const start = "/v1/profiles/";
  async function record(
    name: string,
    path: string,
    answers: Record<string, unknown[]> = {},
    status = 200,
    cached = false,
  ) {
    driver.trace.length = 0;
    driver.answers.clear();
    if (!cached) driver.cache.clear();
    for (const [key, value] of Object.entries(answers))
      driver.answers.set(key, [...value]);
    const response = await captureResponse(
      await app.request(start + path, {
        headers: {
          "x-egdata-key-id": "key_oracle",
          "x-egdata-key-tier": "free",
          "x-request-id": "req_node_oracle",
        },
      }),
    );
    expect(response.status, name).toBe(status);
    cases.push({
      name: "v1 profile " + name,
      request: { path: start + path, method: "GET" },
      trace: driver.trace.splice(0),
      response,
    });
    return response.body as { meta?: { pagination?: { nextCursor?: string } } };
  }
  try {
    const user = {
      accountId: "p",
      displayName: "User",
      avatar: { small: "s", medium: "m", large: "l" },
    };
    const account = {
      avatarUrl: { variants: [null] },
      discordId: "",
      creationDate: "2020-04-01",
    };
    const raw = {
      sandboxId: "z",
      totalXP: 9,
      totalUnlocked: 1,
      playerAwards: null,
    };
    const offer = {
      id: "offer",
      namespace: "z",
      title: "Base",
      offerType: "BASE_GAME",
      keyImages: null,
    };
    const detailed = {
      epic: [user],
      "epic.one": [account],
      "reviews.count": [3],
      "player-achievements.many": [
        [
          raw,
          { sandboxId: "a" },
          { sandboxId: null },
          { sandboxId: "no-product" },
          { sandboxId: "missing-offer" },
        ],
      ],
      "sandboxes.many": [
        [
          { _id: "z", parent: "product" },
          { _id: "no-product" },
          { _id: "missing-offer", parent: "product" },
        ],
      ],
      "offers.many": [[offer]],
      "achievementsets.many": [
        [
          {
            sandboxId: "z",
            achievements: [{ xp: null, XP: "4" }, { xp: "6" }],
          },
          { sandboxId: "z", achievements: null },
        ],
      ],
      "products.many": [[{ _id: "product" }]],
    };
    await record("detail joins", "p", detailed);
    await record("cached detail", "p", {}, 200, true);
    await record("detail empty identities", "p", {
      "player-achievements.many": [[{ sandboxId: "" }, { sandboxId: null }]],
    });
    await record("information", "p/information?unused=yes", {
      epic: [user],
      "epic.one": [account],
      "key-codes.many": [[{ details: ["one", "two"] }, { details: null }]],
      "player-achievements.aggregate": [
        [
          {
            totalGames: "3",
            totalAchievements: "6",
            totalXP: "40",
            totalPlayerAwards: "2",
          },
        ],
      ],
      "reviews.count": [2],
    });
    await record(
      "cached identity and stats",
      "p/information",
      { "epic.one": [account], "key-codes.many": [[]] },
      200,
      true,
    );
    const games = [
      {
        sandboxId: "z",
        product: { name: "z" },
        totalXP: 8,
        totalUnlocked: 1,
        completionPercentage: 0.1,
      },
      {
        sandboxId: "a",
        product: { name: "a" },
        totalXP: 7,
        totalUnlocked: 0,
        completionPercentage: 0,
      },
    ];
    for (const sort of ["alphabetical", "xp", "achievements", "completion"]) {
      const path = "p/games?sort=" + sort + "&platinum=true&limit=1";
      const first = await record("games " + sort, path, {
        "player-achievements.aggregate": [games],
      });
      const cursor = first.meta!.pagination!.nextCursor!;
      await record(
        "games continue " + sort,
        path + "&cursor=" + encodeURIComponent(cursor),
        { "player-achievements.aggregate": [[]] },
        200,
        true,
      );
      await record("games cached " + sort, path, {}, 200, true);
    }
    await record("empty leaderboard", "leaderboard");
    await record("cached leaderboard", "leaderboard", {}, 200, true);
    const ack = {
      achievementName: "hello",
      sandboxId: "z",
      unlockDate: null,
      sortUnlockDate: "2021-04-01T00:00:00.000Z",
      achievementDetails: { name: "hello" },
    };
    const ach = await record(
      "achievement selection",
      "p/achievements?limit=1",
      {
        "player-achievements.aggregate": [
          [ack, { ...ack, achievementName: "other" }],
          [{ count: 2 }],
        ],
        "offers.many": [
          [{ namespace: "z", offerType: "DLC", title: "dlc" }, offer],
        ],
      },
    );
    await record(
      "achievement continuation",
      "p/achievements?limit=1&cursor=" +
        encodeURIComponent(ach.meta!.pagination!.nextCursor!),
      { "player-achievements.aggregate": [[]] },
      200,
      true,
    );
    await record(
      "cached achievements",
      "p/achievements?limit=1",
      {},
      200,
      true,
    );
    await record("sandbox achievements", "p/achievements/z?ignored=true", {
      "player-achievements.many": [
        [
          {
            achievementSets: [
              { achievementSetId: "z" },
              { achievementSetId: "b" },
              { achievementSetId: "z" },
            ],
          },
        ],
      ],
      "achievementsets.many": [[]],
    });
    await record(
      "cached sandbox achievements",
      "p/achievements/z",
      {},
      200,
      true,
    );
    for (const path of ["p/rare-achievements", "p/rare-achievements/z"]) {
      await record("rare " + path, path + "?ignored=true", {
        "player-achievements.aggregate": [
          [{ unlockDate: "2021-01-03" }, { name: "undated" }],
        ],
      });
      await record("cached rare " + path, path, {}, 200, true);
    }
    await record("random zero count", "p/random-game", {}, 404);
    await record(
      "random sample vanished",
      "p/random-game",
      { "player-achievements.count": [1] },
      404,
    );
    await record("random sandbox absent", "p/random-game?sandbox=z", {}, 404);
    await record(
      "random catalog sandbox absent",
      "p/random-game",
      { "player-achievements.count": [1], "player-achievements.many": [[raw]] },
      404,
    );
    await record(
      "random base game absent",
      "p/random-game",
      {
        "player-achievements.count": [1],
        "player-achievements.many": [[raw]],
        "sandboxes.one": [{ _id: "z" }],
      },
      404,
    );
    await record("random chosen game", "p/random-game", {
      "player-achievements.count": [1],
      "player-achievements.many": [[raw]],
      "sandboxes.one": [{ _id: "z" }],
      "offers.one": [offer],
    });
    await record("random cached game", "p/random-game", {}, 200, true);
    for (const path of [
      "%20",
      "%20/achievements",
      "%20/achievements/s",
      "p/achievements/%20",
      "%20/rare-achievements",
      "%20/rare-achievements/s",
      "p/rare-achievements/%20",
      "%20/information",
      "%20/games",
      "%20/random-game",
    ]) {
      await record("invalid profile ID " + path, path, {}, 400);
    }
    for (const path of [
      "leaderboard?limit=bad",
      "p/achievements?limit=bad",
      "p/achievements?cursor=bad",
      "p/games?sort=invalid",
      "p/games?limit=bad",
      "p/games?unexpected=x",
      "p/random-game?unexpected=x",
      "p/random-game?sandbox=" + "x".repeat(201),
    ]) {
      await record("invalid profile query " + path, path, {}, 400);
    }
    await record("null sandbox sets", "p/achievements/s", {
      "player-achievements.many": [[{ achievementSets: null }]],
    });
    await record("null aggregate fields", "p/information", {
      epic: [user],
      "epic.one": [{ discordId: 0 }],
      "player-achievements.aggregate": [
        [{ totalXP: true, totalAchievements: [4], totalPlayerAwards: null }],
      ],
    });
    await record("information linked discord", "p/information", {
      epic: [user],
      "epic.one": [{ discordId: "linked", avatarUrl: { variants: ["saved"] } }],
    });
    await record("unmatched achievement namespaces", "p/achievements", {
      "player-achievements.aggregate": [
        [
          {
            achievementName: "partial",
            unlockDate: "2022-01-02",
            sandboxId: null,
          },
        ],
        [],
      ],
    });
    await record("specific random game", "p/random-game?sandbox=z", {
      "player-achievements.one": [raw],
      "sandboxes.one": [{ _id: "z" }],
      "offers.one": [offer],
    });
    const board = [
      { rank: "old", accountId: null },
      { rank: 2, accountId: "next" },
    ];
    const boardPage = await record(
      "historical leaderboard rank",
      "leaderboard?limit=1",
      { "player-achievements.aggregate": [board] },
    );
    await record(
      "null rank continuation",
      "leaderboard?limit=1&cursor=" +
        encodeURIComponent(boardPage.meta!.pagination!.nextCursor!),
      {},
    );
    await record(
      "invalid leaderboard keys",
      "leaderboard?unexpected=true",
      {},
      400,
    );
    await record(
      "invalid leaderboard cursor",
      "leaderboard?cursor=bad",
      {},
      400,
    );
    await record("detail without products", "p", {
      epic: [user],
      "player-achievements.many": [[raw]],
      "sandboxes.many": [[{ _id: "z" }]],
    });
    await record("detail without games", "p", { epic: [user] });
    await record("mixed achievement IDs", "p/achievements/z", {
      "player-achievements.many": [
        [
          {
            achievementSets: [
              { achievementSetId: 42 },
              { achievementSetId: "" },
              { achievementSetId: null },
              { achievementSetId: "42" },
            ],
          },
        ],
      ],
    });
    await record("mixed namespace offers", "p/achievements", {
      "player-achievements.aggregate": [
        [{ sandboxId: 42 }, { sandboxId: "42" }],
        [{ count: "2" }],
      ],
      "offers.many": [
        [
          { namespace: "42", offerType: "DLC" },
          { namespace: "42", offerType: "BASE_GAME", title: "first" },
          { namespace: "42", offerType: "BASE_GAME", title: "second" },
        ],
      ],
    });
    await record("boolean Discord association", "p/information", {
      "epic.one": [{ discordId: true }],
    });
    await record("object Discord association", "p/information", {
      "epic.one": [{ discordId: {} }],
    });
    await record("historical game sort fields", "p/games?sort=xp&limit=1", {
      "player-achievements.aggregate": [[{ totalXP: "8" }, games[1]]],
    });
    await record(
      "numeric catalog sandbox absent",
      "p/random-game",
      {
        "player-achievements.count": [1],
        "player-achievements.many": [[{ sandboxId: 42 }]],
      },
      404,
    );
    await record(
      "null catalog sandbox absent",
      "p/random-game",
      {
        "player-achievements.count": [1],
        "player-achievements.many": [[{ sandboxId: null }]],
      },
      404,
    );
    await record(
      "missing sandbox field",
      "p/random-game",
      {
        "player-achievements.count": [1],
        "player-achievements.many": [[{}]],
      },
      404,
    );
    const bindings: Array<[string, CursorBinding]> = [
      [
        "leaderboard",
        {
          operation: "profiles.leaderboard",
          filters: {},
          ordering: "rank:asc,id:asc",
          country: "US",
          locale: "en-US",
          limit: 1,
        },
      ],
      [
        "p/achievements",
        {
          operation: "profiles.achievements",
          filters: { profileId: "p" },
          ordering: "unlockDate:desc,sandboxId:asc,achievementName:asc",
          country: "US",
          locale: "en-US",
          limit: 1,
        },
      ],
      [
        "p/games",
        {
          operation: "profiles.games",
          filters: { profileId: "p", sort: "completion", platinum: false },
          ordering: "completionPercentage:desc,product.name:asc,sandboxId:asc",
          country: "US",
          locale: "en-US",
          limit: 1,
        },
      ],
    ];
    for (const [path, binding] of bindings) {
      await record(
        "old cursor tuple " + path,
        path +
          "?limit=1&cursor=" +
          encodeURIComponent(encodeCursor(binding, ["old"])),
        {},
        400,
      );
    }
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("V1_CURSOR_SECRET", "");
    vi.stubEnv("V1_CURSOR_DEV_SECRET", "");
    for (const [path, answers] of [
      ["leaderboard", { "player-achievements.aggregate": [board] }],
      ["p/achievements", { "player-achievements.aggregate": [[ack, ack], []] }],
      ["p/games", { "player-achievements.aggregate": [games] }],
    ] satisfies Array<[string, Record<string, unknown[]>]>) {
      await record(
        "unconfigured cursor " + path,
        path + "?limit=1",
        answers,
        503,
      );
      cases[cases.length - 1].cursorSecret = false;
    }
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv(
      "V1_CURSOR_SECRET",
      "deterministic-collection-cursor-secret-for-oracle",
    );
    for (const [path, service] of [
      ["p", "epic"],
      ["p/information", "epic"],
      ["p/games", "epic"],
      ["leaderboard", "player-achievements.aggregate"],
      ["p/achievements", "player-achievements.aggregate"],
      ["p/achievements/z", "player-achievements.many"],
      ["p/achievements/s", "player-achievements.many"],
      ["p/rare-achievements", "player-achievements.aggregate"],
      ["p/rare-achievements/z", "player-achievements.aggregate"],
      ["p/random-game", "epic"],
    ]) {
      await record(
        "service error " + path,
        path,
        { [service]: [new Error("fixture read failed")] },
        500,
      );
      cases[cases.length - 1].failedRead = true;
    }
    // Replay the original response snapshots with the actual cache and model wrappers
    // as well. This captures every operation, including options and cache writes.
    const original = JSON.parse(
      readFileSync(
        new URL(
          "../rust/crates/egdata-api/tests/fixtures/profiles-http-node.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Array<{
      name: string;
      request: { path: string };
      response: { status: number };
      input: {
        epicProfile: unknown;
        mongoAggregateResults: unknown[];
        mongoFindResults: unknown[];
        modelFindResults: unknown[];
        mongoFindOneResults: unknown[];
        modelFindOneResults: unknown[];
      };
    }>;
    vi.stubEnv(
      "V1_CURSOR_SECRET",
      "egdata-v1-local-cursor-secret-do-not-use-in-production",
    );
    for (const item of original) {
      const input = item.input;
      const answers: Record<string, unknown[]> = {
        epic: [input.epicProfile],
        "player-achievements.aggregate": input.mongoAggregateResults,
      };
      const many = input.mongoFindResults,
        model = input.modelFindResults;
      if (item.name === "profiles_detail_populated") {
        answers["player-achievements.many"] = [many[0]];
        answers["products.many"] = [many[1]];
        for (const [i, name] of [
          "sandboxes",
          "offers",
          "achievementsets",
        ].entries())
          answers[name + ".many"] = [model[i]];
      } else if (item.name === "profiles_sandbox_achievements_populated") {
        answers["player-achievements.many"] = many;
        answers["achievementsets.many"] = model;
      } else if (item.name === "profiles_random_game_populated") {
        answers["player-achievements.one"] = input.mongoFindOneResults;
        answers["sandboxes.one"] = [input.modelFindOneResults[0]];
        answers["offers.one"] = [input.modelFindOneResults[1]];
      }
      await record(
        "baseline " + item.name,
        item.request.path.slice(start.length),
        answers,
        item.response.status,
      );
      const entry = cases[cases.length - 1];
      entry.cursorSecret =
        "egdata-v1-local-cursor-secret-do-not-use-in-production";
      expect(entry.response, item.name).toEqual(item.response);
    }
    vi.stubEnv(
      "V1_CURSOR_SECRET",
      "deterministic-collection-cursor-secret-for-oracle",
    );
    await record("leaderboard total across page sizes", "leaderboard?limit=1", {
      "player-achievements.aggregate": [board, [{ total: 83 }]],
    });
    await record(
      "leaderboard total reused",
      "leaderboard?limit=2",
      { "player-achievements.aggregate": [board] },
      200,
      true,
    );
    await record("games platinum total", "p/games?platinum=true&limit=1", {
      "player-achievements.aggregate": [games, [{ total: 17 }]],
    });
    await record(
      "games total reused across sorts",
      "p/games?platinum=true&sort=alphabetical&limit=2",
      { "player-achievements.aggregate": [games] },
      200,
      true,
    );
    await record(
      "games total changes with platinum filter",
      "p/games?limit=2",
      { "player-achievements.aggregate": [games, [{ total: 91 }]] },
      200,
      true,
    );
    const completed = await record(
      "games filter completed",
      "p/games?filter=completed&limit=1",
      { "player-achievements.aggregate": [games, [{ total: 12 }]] },
      200,
      true,
    );
    await record(
      "games filter completed continuation",
      "p/games?filter=completed&limit=1&cursor=" +
        encodeURIComponent(completed.meta!.pagination!.nextCursor!),
      { "player-achievements.aggregate": [[]] },
      200,
      true,
    );
    await record(
      "games filter completed rejects mismatched filter cursor",
      "p/games?filter=in-progress&limit=1&cursor=" +
        encodeURIComponent(completed.meta!.pagination!.nextCursor!),
      {},
      400,
      true,
    );
    await record(
      "games filter near-platinum",
      "p/games?filter=near-platinum&limit=1",
      { "player-achievements.aggregate": [games, [{ total: 4 }]] },
      200,
      true,
    );
    await record(
      "games filter in-progress",
      "p/games?filter=in-progress&limit=1",
      { "player-achievements.aggregate": [games, [{ total: 7 }]] },
      200,
      true,
    );
    await record(
      "games filter platinum reuses platinum total",
      "p/games?filter=platinum&sort=alphabetical&limit=2",
      {},
      200,
      true,
    );
    await record(
      "games filter all reuses default total",
      "p/games?filter=all&limit=2",
      {},
      200,
      true,
    );
    await record(
      "games filter all with platinum=true reuses platinum total",
      "p/games?filter=all&platinum=true&sort=alphabetical&limit=2",
      {},
      200,
      true,
    );
    await record(
      "games filter completed with platinum=true applies filter",
      "p/games?filter=completed&platinum=true&limit=1",
      {},
      200,
      true,
    );
    await record(
      "games invalid filter",
      "p/games?filter=invalid",
      {},
      400,
      true,
    );
    driver.cache.clear();
    driver.cache.set(
      "v1:" + v1CacheKey("profiles.leaderboard", { limit: 3, cursor: null }),
      JSON.stringify({
        entries: [],
        pagination: { limit: 3, hasMore: false, nextCursor: null },
      }),
    );
    const old = await record(
      "old leaderboard page remains readable",
      "leaderboard?limit=3",
      {},
      200,
      true,
    );
    expect(old.meta?.pagination).not.toHaveProperty("total");
    assertOracle("v1-profile-edges", cases);
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
});
