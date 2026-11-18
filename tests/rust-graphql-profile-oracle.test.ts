import { consola } from "consola";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { assertOracle } from "../rust/oracles/record.js";
import { honoMiddleware } from "../src/middlewares/apollo.js";
import { apiCors } from "../src/middlewares/cors.js";
import { edgeCacheHeaders } from "../src/middlewares/edge-cache.js";
import { responseEtag } from "../src/middlewares/response-etag.js";
import { routeTemplate } from "../src/middlewares/route-template.js";

type Doc = Record<string, unknown>;
const driver = vi.hoisted(() => {
  const trace: Doc[] = [];
  const replies = new Map<string, unknown>();
  const cache = new Map<string, string>();
  let fail: string | undefined;
  function read(call: Doc, key: string, result: unknown) {
    if (key === fail) {
      trace.push({ call, error: true });
      throw new Error("fixture read failed");
    }
    trace.push({ call, result });
    return result;
  }
  function collection(name: string) {
    const call = (method: string, query: Doc, options: Doc) =>
      read(
        { collection: name, method, query, options },
        name,
        replies.get(name) ?? (method === "one" ? null : []),
      );
    return {
      findOne: async (query: Doc, options = {}) => call("one", query, options),
      find: (query: Doc, options = {}) => ({
        toArray: async () => call("many", query, options),
      }),
      countDocuments: async (query: Doc) => call("count", query, {}),
    };
  }
  return {
    trace,
    replies,
    cache,
    collection,
    failAt(key?: string) {
      fail = key;
    },
    read,
  };
});
vi.mock("../src/db/index.js", () => ({
  db: { db: { collection: driver.collection } },
}));
vi.mock("../src/clients/epic.js", () => ({
  epicStoreClient: {
    getUser: async (id: string) =>
      driver.read(
        { method: "epicUser", id },
        "epicUser",
        driver.replies.get("epicUser") ?? null,
      ),
  },
}));
vi.mock("../src/clients/response-cache.js", () => ({
  default: {
    get: async (key: string) => {
      const raw = driver.cache.get(key);
      driver.read(
        { method: "get", key },
        "cache.get",
        raw === undefined ? null : { rawCache: raw },
      );
      return raw ?? null;
    },
    set: async (key: string, payload: string, mode: string, ttl: number) => {
      expect(mode).toBe("EX");
      driver.read(
        { method: "set", key, payload: JSON.parse(payload), ttl },
        "cache.set",
        null,
      );
      driver.cache.set(key, payload);
    },
  },
}));

const id = "fixture-player";
const identity =
  "accountId displayName avatar{small medium large} linkedAccounts creationDate reviewsCount";
const achievement =
  "name displayName description iconUrl rarityPercent xp sandboxId gameTitle unlockedAt";
const game = `sandboxId title imageUrl completionPercent unlocked total earnedXP totalXP hasPlatinum rarestAchievements{${achievement}}`;
const highlights =
  "level totalXP totalGames totalAchievements totalPlatinums reviewsCount";
const games = (args = "") => `games${args}{elements{${game}} total page limit}`;
const activity =
  "type sandboxId gameTitle achievementName achievementIconUrl occurredAt";
const query = (fields: string) => `{profile(id:"${id}"){${fields}}}`;
const key = (segment: string) => `graphql:profile:${id}:${segment}:v2`;

function sampleData() {
  driver.replies.set("epicUser", {
    displayName: "Example player",
    avatar: { small: "epic-s", medium: "epic-m", large: "epic-l" },
  });
  driver.replies.set("epic", {
    avatarUrl: { variants: ["db-avatar"] },
    linkedAccounts: { fixture: "linked" },
    creationDate: new Date("2020-06-03T20:00:00Z"),
  });
  driver.replies.set("reviews", 4);
  const unlock = (
    sandboxId: string,
    achievementName: string,
    unlockDate: string | null,
    unlocked = true,
  ) => ({
    playerAchievement: {
      sandboxId,
      achievementSetId: "set-" + sandboxId,
      achievementName,
      unlockDate,
      unlocked,
    },
  });
  const award = {
    awardType: "PLATINUM",
    achievementSetId: "set-a",
    unlockedDateTime: "2021-06-01T13:00:00.000Z",
  };
  driver.replies.set("player-achievements", [
    {
      sandboxId: "a",
      totalUnlocked: 1,
      totalXP: "70",
      playerAchievements: [
        unlock("a", "explorer", "2021-03-01T00:00:00Z"),
        unlock("a", "begin", null, false),
      ],
      playerAwards: [award],
    },
    {
      sandboxId: "b",
      totalUnlocked: 4,
      totalXP: 90,
      playerAchievements: [unlock("b", "rare", "2022-03-01T00:00:00Z")],
    },
    {
      sandboxId: "a",
      totalUnlocked: 2,
      totalXP: 80,
      playerAwards: [award],
      playerAchievements: [
        unlock("a", "explorer", "2021-06-01T00:00:00Z", false),
        unlock("a", "begin", "2021-04-01T00:00:00Z"),
      ],
    },
    { sandboxId: "c", totalUnlocked: 1, totalXP: 15 },
    { sandboxId: "" },
  ]);
  driver.replies.set("offers", [
    { namespace: "a", title: "Alpha", isDisplayable: false },
    { namespace: "a", title: "Zoo", isDisplayable: true },
    {
      namespace: "b",
      product: { name: "Beta" },
      keyImages: [
        { type: "Thumbnail", url: "thumb" },
        { type: "OfferImageWide", url: "wide" },
      ],
    },
  ]);
  driver.replies.set("achievementsets", [
    {
      sandboxId: "a",
      achievementSetId: "set-a",
      achievements: [
        {
          name: "explorer",
          displayName: "Explorer",
          description: "Travel",
          icon: "icon-a",
          xp: "25",
          completedPercent: 0.125,
        },
        {
          name: "begin",
          lockedDisplayName: "Begin",
          lockedIconLink: "locked-icon",
          score: 55,
          completedPercent: null,
        },
      ],
    },
    {
      sandboxId: "b",
      achievementSetId: "set-b",
      achievements: [
        {
          name: "rare",
          unlockedDisplayName: "Rare",
          unlockedDescription: "Uncommon",
          unlockedIconLink: "rare-image",
          XP: "0x10",
          completedPercent: "0x1",
        },
        ...Array.from({ length: 4 }, (_, n) => ({ name: `b-${n}`, xp: 12 })),
      ],
    },
  ]);
}

it("replays Apollo profile queries with their Epic, MongoDB and Redis calls", async () => {
  const { server } = await import("../src/graphql/index.js");
  const { db } = await import("../src/db/index.js");
  const { createLoaders } = await import("../src/graphql/loaders.js");
  const app = new Hono();
  app.use("*", apiCors(), responseEtag, routeTemplate, edgeCacheHeaders);
  await server.start();
  app.use(
    "/graphql",
    honoMiddleware(server, {
      context: async () => ({
        db: db.db,
        logger: consola,
        loaders: createLoaders(db.db),
      }),
    }),
  );
  const cases: Doc[] = [];
  const record = async (
    name: string,
    fields: string,
    setup?: () => void,
    expectError = false,
    method = "POST",
  ) => {
    driver.trace.length = 0;
    driver.replies.clear();
    driver.cache.clear();
    driver.failAt();
    sampleData();
    setup?.();
    const source = fields.startsWith("{") ? fields : query(fields);
    const request: {
      method: string;
      path: string;
      headers: Record<string, string>;
      body?: { query: string };
    } =
      method === "GET"
        ? {
            path: "/graphql?" + new URLSearchParams({ query: source }),
            method,
            headers: {},
          }
        : {
            path: "/graphql",
            method,
            headers: { "content-type": "application/json" },
            body: { query: source },
          };
    const res = await app.request(request.path, {
      method,
      headers: request.headers,
      body: "body" in request ? JSON.stringify(request.body) : undefined,
    });
    const body = await res.text();
    expect(res.status, name).toBe(200);
    expect(Boolean(JSON.parse(body).errors), name + body).toBe(expectError);
    const headers = Object.fromEntries(
      [...res.headers].filter(([k]) =>
        [
          "content-type",
          "etag",
          "cache-control",
          "cdn-cache-control",
          "vary",
          "allow",
          "x-route-template",
        ].includes(k),
      ),
    );
    cases.push({
      name,
      request,
      trace: driver.trace.splice(0),
      response: { status: res.status, headers, body },
    });
  };
  try {
    await record("public-profile-identity", identity, undefined, false, "GET");
    await record("epic-profile-without-database-row", identity, () =>
      driver.replies.delete("epic"),
    );
    await record("missing-epic-profile", identity, () =>
      driver.replies.delete("epicUser"),
    );
    await record("cached-negative-profile", identity, () =>
      driver.cache.set(key("identity"), "null"),
    );
    await record("cache-hit-identity", identity, () =>
      driver.cache.set(
        key("identity"),
        JSON.stringify({
          accountId: id,
          displayName: "cached",
          reviewsCount: 3,
        }),
      ),
    );
    await record(
      "all-profile-fields-share-aggregation",
      `${identity} highlights{${highlights}} heroGame{sandboxId title imageUrl} featuredGames{${game}} featuredAchievements{${achievement}} recentActivity{${activity}} ${games()} achievements{elements{${achievement}} total page limit}`,
    );
    await record(
      "sort-filter-and-paginate-games",
      `near:${games("(filter:NEAR_PLATINUM,sort:XP)")} alpha:${games("(sort:ALPHABETICAL,limit:1,page:2)")} completed:${games("(filter:COMPLETED)")} platinum:${games("(filter:PLATINUM,sort:ACHIEVEMENTS)")} progress:featuredGames(filter:IN_PROGRESS,limit:0){sandboxId} `,
    );
    await record(
      "paged-achievements-and-activity",
      `achievements(limit:1,page:2){elements{${achievement}} total page limit} recentActivity(limit:1,page:2){${activity}}`,
    );
    await record(
      "empty-achievement-history",
      `highlights{${highlights}} heroGame{title} ${games()} recentActivity{${activity}}`,
      () => driver.replies.delete("player-achievements"),
    );
    await record(
      "matching-cache-hits",
      `highlights{${highlights}} ${games()} featuredAchievements(limit:1){${achievement}} recentActivity(limit:2){${activity}}`,
      () => {
        driver.cache.set(
          key("highlights:reviews:4"),
          JSON.stringify({
            level: 10,
            totalXP: 2500,
            totalGames: 1,
            totalAchievements: 7,
            totalPlatinums: 1,
            reviewsCount: 4,
          }),
        );
        driver.cache.set(key("games:ALL:COMPLETION"), "[]");
        driver.cache.set(key("featured-achievements:1"), "[]");
        driver.cache.set(key("activity:2:1"), "[]");
      },
    );
    await record(
      "concurrent-sibling-aliases-memoize",
      `a:${games()} b:${games()} c:featuredGames(limit:1){sandboxId} d:heroGame{sandboxId}`,
    );
    await record("legacy-hero-cache-order", "heroGame{sandboxId title}", () =>
      driver.cache.set(
        key("games:ALL:COMPLETION"),
        JSON.stringify([
          {
            sandboxId: "old-a",
            title: "Alpha",
            imageUrl: "alpha",
            earnedXP: 30,
            unlocked: 1,
            completionPercent: 10,
          },
          {
            sandboxId: "old-b",
            title: "Beta",
            imageUrl: "beta",
            earnedXP: 60,
            unlocked: 8,
            completionPercent: 90,
          },
        ]),
      ),
    );
    await record(
      "legacy-games-without-platinum-count",
      `highlights{${highlights}}`,
      () =>
        driver.cache.set(
          key("games:ALL:COMPLETION"),
          JSON.stringify([
            { earnedXP: 24, unlocked: 2, hasPlatinum: true },
            { earnedXP: 3, unlocked: 1, hasPlatinum: false },
          ]),
        ),
    );
    await record(
      "identity-cache-keeps-accounts-separate",
      `{one:profile(id:"${id}"){accountId} same:profile(id:"${id}"){displayName} other:profile(id:"fixture-other"){accountId}}`,
    );
    await record(
      "identity-read-fails",
      identity,
      () => driver.failAt("cache.get"),
      true,
    );
    await record(
      "identity-write-fails",
      identity,
      () => driver.failAt("cache.set"),
      true,
    );
    await record(
      "epic-lookup-fails",
      identity,
      () => driver.failAt("epicUser"),
      true,
    );
    await record(
      "child-read-fails-once",
      `accountId a:${games()} b:heroGame{title}`,
      () => driver.failAt("player-achievements"),
      true,
    );
    await record(
      "review-count-read-fails",
      identity,
      () => driver.failAt("reviews"),
      true,
    );
    for (const field of [
      "highlights{totalGames}",
      "featuredAchievements{name}",
      "recentActivity{type}",
    ]) {
      await record(
        "aggregation-failure-" + field.split("{")[0],
        field,
        () => driver.failAt("player-achievements"),
        true,
      );
    }
    await record("historical-sandbox-identifiers", games(), () => {
      driver.replies.set("player-achievements", [
        { sandboxId: ["legacy", 2], totalXP: 6 },
        { sandboxId: 3, totalXP: 9 },
      ]);
      driver.replies.set("offers", [
        {
          namespace: "legacy,2",
          title: "Archive",
          isDisplayable: true,
          lastModifiedDate: "2020-03-01",
          keyImages: [{ type: "Thumbnail", url: "old" }],
        },
        {
          namespace: "legacy,2",
          title: "Archive",
          isDisplayable: true,
          lastModifiedDate: "2021-03-01",
          keyImages: [{ type: "Thumbnail", url: "new" }],
        },
        { namespace: "legacy,2", title: "Zulu", isDisplayable: true },
      ]);
    });
    await record(
      "cached-hero-art-and-completion-tie",
      "heroGame{sandboxId}",
      () => {
        driver.cache.set(
          key("games:ALL:COMPLETION"),
          JSON.stringify([
            {
              sandboxId: "a",
              title: "First",
              imageUrl: "first",
              earnedXP: 15,
              unlocked: 1,
              completionPercent: 0,
            },
            {
              sandboxId: "b",
              title: "Second",
              imageUrl: "second",
              earnedXP: 15,
              unlocked: 2,
              completionPercent: 0,
            },
          ]),
        );
      },
    );
    assertOracle("graphql-profile-node", cases);
  } finally {
    await server.stop();
  }
});
