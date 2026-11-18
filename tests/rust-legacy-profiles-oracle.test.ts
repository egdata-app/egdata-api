import { Hono } from "hono";
import { BSON, ObjectId } from "mongodb";
import { expect, it, vi } from "vitest";
import { createReadRecorder } from "../rust/oracles/legacy-catalog-record.js";
import { assertOracle } from "../rust/oracles/record.js";
import { apiCors } from "../src/middlewares/cors.js";
import { edgeCacheHeaders } from "../src/middlewares/edge-cache.js";
import { responseEtag } from "../src/middlewares/response-etag.js";
import { routeTemplate } from "../src/middlewares/route-template.js";

const r = createReadRecorder();
const id = "fixture-player";
const user = {
  id: "fixture-account",
  email: id + "@accounts.epicgames.com",
  epicAccountId: id,
};
const profile = {
  displayName: "Fixture",
  avatar: { small: "s", medium: "m", large: "l" },
};
let epic: unknown = profile;
let refreshFailure = false;
let sessionFailure = false;
let rawStatus: string | Error | undefined;
const cacheOverrides = new Map<string, string>();
vi.mock("../src/db/index.js", () => ({
  db: {
    db: {
      collection: (name: string) => {
        const collection = r.collection(name);
        return {
          ...collection,
          findOne: (filter: Record<string, unknown>, options: unknown) =>
            collection.findOne(
              BSON.deserialize(
                BSON.serialize(filter, { ignoreUndefined: false }),
              ),
              options,
            ),
        };
      },
    },
  },
}));
vi.mock("../src/clients/response-cache.js", () => ({
  default: {
    ...r.cache,
    get: async (key: string) => {
      const raw = cacheOverrides.get(key);
      if (raw === undefined) return r.cache.get(key);
      r.service({ method: "get", key }, { rawCache: raw });
      return raw;
    },
  },
}));
vi.mock("../src/clients/redis.js", () => ({
  default: {
    get: async (key: string) => {
      if (rawStatus === undefined) return r.sharedRedis.get(key);
      const call = { service: "primaryRedis", method: "get", key };
      if (rawStatus instanceof Error) return r.fail(call);
      r.service(call, { rawCache: rawStatus });
      return rawStatus;
    },
  },
}));
vi.mock("../src/clients/achievement-refresh.js", () => ({
  requestAchievementRefresh: async (id: string, ttlMs: number) => {
    const call = { method: "profileRefresh", id, ttlMs };
    if (refreshFailure) r.fail(call);
    return r.service(call, { reusedCooldown: false });
  },
}));
vi.mock("../src/clients/epic.js", () => ({
  epicStoreClient: {
    getUser: async (id: string) =>
      epic instanceof Error
        ? r.fail({ method: "epicUser", id })
        : r.service({ method: "epicUser", id }, epic),
  },
}));
vi.mock("../src/utils/auth.js", () => ({
  getLinkedEpicSession: async (headers: Headers) => {
    const cookie = headers.get("cookie") ?? "";
    if (sessionFailure) return r.fail({ method: "session", cookie });
    const active = r.service(
      { method: "session", cookie },
      cookie === "session=fixture" ? user : null,
    );
    return active ? { user: active, epicAccountId: id } : null;
  },
}));

it("executes the legacy profile HTTP routes with deterministic Epic, Redis and Mongo services", async () => {
  const app = new Hono();
  app.use("*", apiCors(), responseEtag, routeTemplate, edgeCacheHeaders);
  app.route("/profiles", (await import("../src/routes/profiles.js")).default);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-11-17T00:00:00Z");
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    type Input = Parameters<typeof r.record>;
    const cases: Awaited<ReturnType<typeof r.record>>[] = [];
    async function get(
      name: string,
      path: string,
      status: number,
      reads: Input[4] = [],
      hit: unknown = null,
      headers?: Record<string, string>,
      failAt?: number,
    ) {
      const result = await r.record(
        app,
        "legacy-profile-" + name,
        { method: "GET", path: "/profiles/" + path, headers },
        status,
        reads,
        hit,
        [],
        failAt,
      );
      if (path === "me") {
        expect(result.response.headers["cache-control"]).toBe(
          "private, no-store",
        );
      }
      cases.push(result);
      return result;
    }
    const cookie = { cookie: "session=fixture" };
    const db = {
      accountId: id,
      creationDate: new Date("2021-01-01T00:00:00Z"),
      avatarUrl: { variants: ["custom"] },
      linkedAccounts: [],
      discordId: "x",
    };
    const sb = "fixture-sandbox",
      set = "fixture-set",
      player = "player-achievements";
    const entry = {
      sandboxId: sb,
      totalXP: 10,
      totalUnlocked: 1,
      playerAwards: [],
      achievementSets: [{ achievementSetId: set }, { achievementSetId: set }],
    };
    const defs = {
      achievementSetId: set,
      sandboxId: sb,
      achievements: [{ name: "A", xp: 20 }],
    };
    const offer = {
      id: "fixture-base",
      namespace: sb,
      title: "Game",
      offerType: "BASE_GAME",
      productSlug: "game",
      keyImages: [],
    };
    const productId = new ObjectId("65ba00000000000000000042");
    await get("sitemap", "sitemap.xml", 200, [
      ["epic", "many", [{ accountId: id }]],
    ]);
    await get("leaderboard", "leaderboard", 200, [
      [player, "aggregate", [{ rank: 1, accountId: id, xpEarned: 300 }]],
    ]);
    await get("me-anonymous", "me", 401);
    await get("me", "me", 200, [["epic", "one", db]], null, cookie);
    const cachedProfile = { displayName: "Cached" };
    const cached = await get("me-cached", "me", 200, [], cachedProfile, cookie);
    await get("me-conditional", "me", 304, [], cachedProfile, {
      ...cookie,
      "if-none-match": cached.response.headers.etag,
    });
    await get(
      "me-db-error",
      "me",
      500,
      [["epic", "one", new Error("Profile read failed")]],
      null,
      cookie,
    );
    await get("detail", id, 200, [
      ["epic", "one", db],
      ["reviews", "count", 2],
      [player, "many", [entry]],
      ["sandboxes", "one", { _id: sb, parent: productId }],
      ["products", "one", { _id: productId }],
      ["offers", "one", offer],
      ["achievementsets", "many", [defs]],
    ]);
    await get("detail-creation-date", id, 200, [
      ["epic", "one", { accountId: id }],
      ["epic", "update", { modifiedCount: 1 }],
      ["reviews", "count", 0],
      [player, "many", []],
    ]);
    await get("detail-cached", id, 200, [], { displayName: "Cached" });
    await get("information", id + "/information", 200, [
      ["epic", "one", db],
      [
        "key-codes",
        "many",
        [{ details: [{ amount: 1 }] }, { details: { amount: 2 } }],
      ],
      [
        player,
        "aggregate",
        [
          {
            totalGames: 1,
            totalAchievements: 2,
            totalPlayerAwards: 1,
            totalXP: 10,
          },
        ],
      ],
      ["reviews", "count", 3],
    ]);
    await get("sandbox-achievements", id + "/achievements/" + sb, 200, [
      [player, "many", [entry]],
      ["achievementsets", "many", [defs]],
    ]);
    await get("achievements", id + "/achievements?page=0x2&limit=2extra", 200, [
      [
        player,
        "aggregate",
        [
          {
            sandboxId: sb,
            achievementDetails: defs.achievements[0],
            unlockDate: "2025-01-01",
          },
          { sandboxId: sb, achievementDetails: { name: "B" } },
        ],
      ],
      [player, "aggregate", [{ count: 5 }]],
      [
        "offers",
        "many",
        [
          offer,
          { ...offer, id: "second-base" },
          { ...offer, id: "dlc", offerType: "DLC" },
        ],
      ],
    ]);
    await get("rare", id + "/rare-achievements", 200, [
      [player, "aggregate", [{ name: "A" }]],
    ]);
    await get("rare-sandbox", id + "/rare-achievements/" + sb, 200, [
      [player, "aggregate", [{ name: "A" }]],
    ]);
    await get(
      "rare-cache",
      id + "/rare-achievements",
      200,
      [],
      [{ name: "Cached" }],
    );
    await get(
      "games",
      id + "/games?sort=alphabetical&platinum=true&page=2&limit=3",
      200,
      [[player, "aggregate", [{ paginated: [{ sandboxId: sb }], total: 8 }]]],
    );
    await get("games-empty", id + "/games?sort=unknown", 400, [
      [player, "aggregate", []],
    ]);
    await get("random", id + "/random-game", 200, [
      [player, "count", 1],
      [player, "many", [entry]],
      ["sandboxes", "one", { _id: sb }],
      ["offers", "one", offer],
    ]);
    await get("random-missing", id + "/random-game?sandbox=" + sb, 404, [
      [player, "one", null],
    ]);
    await get("refresh-now", id + "/refresh-status", 200, [
      ["key-codes", "one", null],
    ]);
    await get(
      "refresh-status-donor",
      id + "/refresh-status",
      200,
      [["key-codes", "one", { accountId: id }]],
      { timestamp: Date.now() - 1100 },
    );
    epic = null;
    await get("me-missing", "me", 404, [["epic", "one", null]], null, cookie);
    await get("detail-missing", id, 404, [
      ["epic", "one", null],
      ["reviews", "count", 0],
    ]);
    await get("games-missing", id + "/games", 404);
    await get("information-missing", id + "/information", 404);
    await get("random-profile-missing", id + "/random-game", 404);
    epic = new Error("fixture provider unavailable");
    for (const [path, status] of [
      ["me", 500],
      [id, 400],
      [id + "/information", 400],
      [id + "/games", 400],
      [id + "/random-game", 400],
    ] as const)
      await get("provider-fault-" + path, path, status, [], null, cookie);
    epic = profile;
    sessionFailure = true;
    await get("session-store-fault", "me", 500, [], null, cookie);
    sessionFailure = false;
    await get("sitemap-history", "sitemap.xml", 200, [
      [
        "epic",
        "many",
        [
          {},
          { accountId: null },
          { accountId: 37 },
          { accountId: new ObjectId("65ba00000000000000000042") },
        ],
      ],
    ]);
    const error = new Error("fixture storage unavailable");
    const identityReads: Input[4] = [
      ["epic", "one", db],
      ["reviews", "count", 1],
      [player, "many", [entry]],
      ["sandboxes", "one", { _id: sb, parent: productId }],
      ["products", "one", { _id: productId }],
      ["offers", "one", offer],
      ["achievementsets", "many", [defs]],
    ];
    await get("sparse-objectid-summary", id, 200, [
      ...identityReads.slice(0, 2),
      [player, "many", [{ sandboxId: productId }]],
      ["sandboxes", "one", { parent: productId }],
      ["products", "one", {}],
      ["offers", "one", {}],
      ["achievementsets", "many", []],
    ]);
    await get("sandbox-objectid-sets", id + "/achievements/" + sb, 200, [
      [
        player,
        "many",
        [
          {
            achievementSets: [
              { achievementSetId: productId },
              { achievementSetId: new ObjectId(productId.toHexString()) },
              {},
              {},
            ],
          },
        ],
      ],
      ["achievementsets", "many", []],
    ]);
    await get("sandbox-null-set", id + "/achievements/" + sb, 500, [
      [player, "many", [{ achievementSets: [null] }]],
    ]);
    await get("random-objectid", id + "/random-game", 200, [
      [player, "count", 1],
      [player, "many", [{ sandboxId: productId }]],
      ["sandboxes", "one", {}],
      ["offers", "one", offer],
    ]);
    await get("achievements-objectid-namespace", id + "/achievements", 200, [
      [
        player,
        "aggregate",
        [
          {
            sandboxId: productId,
            achievementDetails: { name: "old namespace" },
          },
        ],
      ],
      [player, "aggregate", [{ count: 1 }]],
      [
        "offers",
        "many",
        [{ ...offer, namespace: new ObjectId(productId.toHexString()) }],
      ],
    ]);
    await get("detail-incomplete-avatar", id, 400, [
      ["epic", "one", { ...db, avatarUrl: {} }],
      ["reviews", "count", 0],
      [player, "many", []],
    ]);
    await get(
      "info-incomplete-avatar",
      id + "/information",
      400,
      [
        ["epic", "one", { ...db, avatarUrl: {} }],
        ["key-codes", "many", []],
      ],
      profile,
    );
    const infoReads: Input[4] = [
      ["epic", "one", db],
      ["key-codes", "many", []],
      [player, "aggregate", []],
      ["reviews", "count", 0],
    ];
    const achReads: Input[4] = [
      [player, "aggregate", []],
      [player, "aggregate", []],
      ["offers", "many", []],
    ];
    const gameReads: Input[4] = [
      [player, "aggregate", [{ total: 2, paginated: [] }]],
    ];
    const randomReads: Input[4] = [
      [player, "count", 1],
      [player, "many", [entry]],
      ["sandboxes", "one", { _id: sb }],
      ["offers", "one", offer],
    ];
    const singleRead: Input[4] = [
      [player, "many", [entry]],
      ["achievementsets", "many", [defs]],
    ];
    for (const [label, path, reads, headers, failures] of [
      ["sitemap", "sitemap.xml", [["epic", "many", []]], undefined, [[0, 500]]],
      [
        "leaderboard",
        "leaderboard",
        [[player, "aggregate", []]],
        undefined,
        [[0, 500]],
      ],
      [
        "me",
        "me",
        [["epic", "one", db]],
        cookie,
        [
          [1, 500],
          [4, 500],
        ],
      ],
      [
        "detail",
        id,
        identityReads,
        undefined,
        [
          [0, 500],
          [2, 400],
          [3, 400],
          [4, 400],
          [5, 400],
          [6, 400],
          [7, 400],
          [8, 400],
          [9, 400],
        ],
      ],
      [
        "info",
        id + "/information",
        infoReads,
        undefined,
        [
          [0, 400],
          [2, 400],
          [3, 400],
          [4, 400],
          [5, 400],
          [6, 400],
          [7, 400],
          [8, 400],
        ],
      ],
      [
        "achievements",
        id + "/achievements",
        achReads,
        undefined,
        [
          [0, 500],
          [1, 500],
          [2, 500],
          [3, 500],
        ],
      ],
      [
        "sets",
        id + "/achievements/" + sb,
        singleRead,
        undefined,
        [
          [0, 500],
          [1, 500],
          [2, 500],
        ],
      ],
      [
        "rare",
        id + "/rare-achievements",
        [[player, "aggregate", []]],
        undefined,
        [
          [0, 500],
          [1, 500],
          [2, 500],
        ],
      ],
      [
        "rare-sandbox",
        id + "/rare-achievements/" + sb,
        [[player, "aggregate", []]],
        undefined,
        [
          [0, 500],
          [1, 500],
          [2, 500],
        ],
      ],
      [
        "games",
        id + "/games",
        gameReads,
        undefined,
        [
          [0, 500],
          [2, 400],
          [3, 400],
        ],
      ],
      [
        "random",
        id + "/random-game",
        randomReads,
        undefined,
        [
          [0, 500],
          [2, 400],
          [3, 400],
          [4, 400],
          [5, 400],
          [6, 400],
        ],
      ],
    ] as Array<
      [
        string,
        string,
        Input[4],
        Record<string, string> | undefined,
        Array<[number, number]>,
      ]
    >) {
      for (const [at, status] of failures)
        await get(
          label + "-failure-" + at,
          path,
          status,
          reads,
          null,
          headers,
          at,
        );
    }
    for (const path of [
      id + "/achievements/" + sb,
      id + "/rare-achievements/" + sb,
      id + "/games",
      id + "/random-game",
    ])
      await get("historical-cache-" + path, path, 200, [], { cached: true });
    await get(
      "me-backfill-fault",
      "me",
      500,
      [
        ["epic", "one", { creationDate: 0 }],
        ["epic", "update", error],
      ],
      null,
      cookie,
    );
    await get("detail-backfill-fault", id, 400, [
      ["epic", "one", { creationDate: "" }],
      ["epic", "update", error],
    ]);
    await get("info-backfill-fault", id + "/information", 400, [
      ["epic", "one", { creationDate: false }],
      ["key-codes", "many", []],
      ["epic", "update", error],
    ]);
    for (const [label, avatar, status] of [
      ["absent", {}, 200],
      ["old-url", { avatarUrl: "photo" }, 500],
      ["no-variants", { avatarUrl: {} }, 500],
      ["empty", { avatarUrl: { variants: [] } }, 200],
      ["keyed", { avatarUrl: { variants: { 0: "x" } } }, 200],
      ["text", { avatarUrl: { variants: "img" } }, 200],
    ] as const)
      await get(
        "me-avatar-" + label,
        "me",
        status,
        [["epic", "one", { ...db, avatarUrl: null, ...avatar }]],
        null,
        cookie,
      );
    for (const [label, entryValue] of [
      ["missing", null],
      ["incomplete", { _id: sb }],
    ] as const) {
      const reads: Input[4] = [
        ...identityReads.slice(0, 3),
        ["sandboxes", "one", entryValue],
      ];
      if (entryValue)
        reads.push(
          ["products", "one", null],
          ["offers", "one", null],
          ["achievementsets", "many", []],
        );
      await get("detail-sandbox-" + label, id, 200, reads);
    }
    for (const [label, sets, status] of [
      ["missing-list", [{}], 400],
      ["missing-xp", [{ achievements: [{}] }], 200],
      ["null-xp", [{ achievements: [{ xp: null }] }], 200],
      ["text-xp", [{ achievements: [{ xp: "5" }, { xp: 4 }] }], 200],
      [
        "different-sets",
        [{ achievements: [{ xp: 2 }] }, { achievements: [{ xp: "8" }] }],
        200,
      ],
      [
        "text-then-number",
        [{ achievements: [{ xp: "5" }, {}] }, { achievements: [{ xp: 3 }] }],
        200,
      ],
      [
        "text-then-text",
        [{ achievements: [{ xp: "5" }] }, { achievements: [{ xp: "8" }] }],
        200,
      ],
      ["null-achievement", [{ achievements: [null] }], 400],
    ] as const)
      await get("detail-set-" + label, id, status, [
        ...identityReads.slice(0, -1),
        ["achievementsets", "many", sets],
      ]);
    await get(
      "info-split-caches",
      id + "/information",
      200,
      [
        ["epic", "one", null],
        ["key-codes", "many", [{}, { details: null }]],
      ],
      { cached: true },
    );
    await get("info-cached-falsy", id + "/information", 404, [], false);
    for (const [name, value] of [
      ["old-text", "abc"],
      ["old-array", ["entry1", "entry2"]],
      ["old-flag", true],
    ] as const)
      await get(
        "info-cache-" + name,
        id + "/information",
        200,
        infoReads.slice(0, 2),
        value,
      );
    for (const [label, xp, awards] of [
      ["strings", "50", "2"],
      ["empty", "", 0],
      ["historical-bools", true, true],
    ] as const)
      await get("info-stats-" + label, id + "/information", 200, [
        ...infoReads.slice(0, 2),
        [
          player,
          "aggregate",
          [
            {
              totalGames: null,
              totalAchievements: 0,
              totalXP: xp,
              totalPlayerAwards: awards,
            },
          ],
        ],
        ["reviews", "count", 0],
      ]);
    for (const [label, path, key, status, reads, headers] of [
      ["self", "me", "epic-me:" + id, 500, [], cookie],
      ["detail", id, "epic-profile:" + id + ":v0.3", 500, [], undefined],
      [
        "info",
        id + "/information",
        "epic-profile:" + id + ":epic-data",
        400,
        [],
        undefined,
      ],
      [
        "stats",
        id + "/information",
        "epic-profile:" + id + ":stats",
        400,
        infoReads.slice(0, 2),
        undefined,
      ],
      [
        "games",
        id + "/games",
        "epic-profile:" +
          id +
          ":games:page:1:limit:10:platinum:false:sort:completion",
        500,
        [],
        undefined,
      ],
      [
        "random",
        id + "/random-game",
        "epic-profile:" + id + ":random-game:random",
        500,
        [],
        undefined,
      ],
    ] as Array<
      [
        string,
        string,
        string,
        number,
        Input[4],
        Record<string, string> | undefined,
      ]
    >) {
      cacheOverrides.set(key, "[");
      await get("raw-cache-" + label, path, status, reads, null, headers);
      cacheOverrides.clear();
    }
    await get("achievements-old-details", id + "/achievements", 200, [
      [
        player,
        "aggregate",
        [
          { sandboxId: sb, achievementDetails: "str" },
          { sandboxId: sb, achievementDetails: ["entry"] },
          { sandboxId: sb },
        ],
      ],
      [player, "aggregate", []],
      ["offers", "many", []],
    ]);
    for (const [label, total] of [
      ["null", null],
      ["text", "12"],
      ["missing", undefined],
    ] as const)
      await get("games-total-" + label, id + "/games?sort=xp", 200, [
        [player, "aggregate", [{ total }]],
      ]);
    await get(
      "games-achievements-sort",
      id + "/games?sort=achievements&limit=0&page=-0",
      200,
      gameReads,
    );
    for (const [label, page, limit] of [
      ["invalid", "--2", "bad"],
      ["clamped", "500", "1000"],
      ["negative", "-4", "-8"],
      ["no-page", "", "0"],
    ])
      await get(
        "achievements-page-" + label,
        id + "/achievements?page=" + page + "&limit=" + limit,
        200,
        achReads,
      );
    await get("sandbox-bad-player", id + "/achievements/" + sb, 500, [
      [player, "many", [{}]],
    ]);
    await get("random-none", id + "/random-game", 404, [[player, "count", 0]]);
    await get("random-sandbox-gone", id + "/random-game?sandbox=" + sb, 404, [
      [player, "one", entry],
      ["sandboxes", "one", null],
    ]);
    await get("random-offer-gone", id + "/random-game?sandbox=" + sb, 404, [
      [player, "one", entry],
      ["sandboxes", "one", { _id: sb }],
      ["offers", "one", null],
    ]);
    await get(
      "random-player-read-failed",
      id + "/random-game?sandbox=" + sb,
      400,
      [[player, "one", error]],
    );
    for (const [name, value, status] of [
      ["invalid", "[", 500],
      ["null", "null", 500],
      ["empty", "", 200],
      ["missing", "{}", 200],
      ["null-date", '{"timestamp":null}', 200],
      [
        "text-date",
        JSON.stringify({ timestamp: String(Date.now() + 1500) }),
        200,
      ],
      ["array-date", JSON.stringify({ timestamp: [Date.now()] }), 200],
      ["unavailable", error, 500],
    ] as const) {
      rawStatus = value;
      await get("raw-status-" + name, id + "/refresh-status", status, [
        ["key-codes", "one", null],
      ]);
    }
    rawStatus = undefined;
    await get("refresh-status-donor-read-fault", id + "/refresh-status", 500, [
      ["key-codes", "one", error],
    ]);
    for (const [name, donor, failed] of [
      ["accepted", false, false],
      ["donor", true, false],
      ["error", false, true],
    ] as const) {
      refreshFailure = failed;
      cases.push(
        await r.record(
          app,
          "legacy-profile-refresh-" + name,
          { method: "PUT", path: "/profiles/" + id + "/refresh" },
          failed ? 500 : 200,
          [["key-codes", "one", donor ? { accountId: id } : null]],
        ),
      );
    }
    cases.push(
      await r.record(
        app,
        "legacy-profile-refresh-donor-lookup-failed",
        { method: "PUT", path: "/profiles/" + id + "/refresh" },
        500,
        [["key-codes", "one", error]],
      ),
    );
    assertOracle("legacy-profiles-http-node", cases);
  } finally {
    logged.mockRestore();
    cacheOverrides.clear();
    rawStatus = undefined;
    sessionFailure = false;
    vi.useRealTimers();
    epic = profile;
    refreshFailure = false;
  }
});
