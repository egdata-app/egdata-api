import { createRequire } from "node:module";
import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import profiles from "../src/routes/profiles.js";
import reviews from "../src/routes/offers/reviews.js";

const {DatabaseSync} = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
let db: InstanceType<typeof DatabaseSync>;
const reads: Array<[string, unknown]> = [];
const now = 2_000_000_000;

// Run the actual parameterized account lookup against an isolated SQL database.
vi.mock("pg", () => ({
  default: {
    Pool: class {
      async query(sql: string, [token, userId]: [string, string]) {
        return { rows: db.prepare(sql).all({ $1: token, $2: userId }) };
      }
    },
  },
}));
vi.mock("better-auth", () => ({
  betterAuth: () => ({
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        if (headers.get("cookie") !== "fixture=owner") return null;
        return {
          session: { token: "owned-session", id: "local-session" },
          user: {
            id: "local-user",
            email: "independent-address@fixture.invalid",
          },
        };
      },
    },
  }),
}));
vi.mock("../src/clients/epic.js", () => ({
  epicStoreClient: {
    getUser: async (id: string) => {
      reads.push(["provider", id]);
      return { epicAccountId: id };
    },
  },
}));
vi.mock("../src/clients/response-cache.js", () => ({
  default: {
    get: async (key: string) => {
      reads.push(["cache", key]);
      return null;
    },
    set: async () => {},
  },
}));
vi.mock("../src/db/index.js", () => ({
  db: {
    db: {
      collection: (name: string) => ({
        findOne: async (filter: unknown) => {
          reads.push([name, filter]);
          return null;
        },
      }),
    },
  },
}));
vi.mock("../src/clients/discord.js", () => ({ discord: {} }));
vi.mock("../src/clients/telegram.js", () => ({ telegramBotService: {} }));
vi.mock("../src/clients/redis.js", () => ({ default: {} }));
vi.mock("../src/clients/achievement-refresh.js", () => ({
  requestAchievementRefresh: vi.fn(),
}));

const app = new Hono()
  .route("/profiles", profiles)
  .route("/offers/:id", reviews);
const headers = { cookie: "fixture=owner" };
beforeEach(() => {
  reads.length = 0;
  db = new DatabaseSync(":memory:");
  db.function("NOW", () => now);
  db.exec(`CREATE TABLE "session" ("token" TEXT,"userId" TEXT,"expiresAt" INTEGER);
    CREATE TABLE "account" ("userId" TEXT,"providerId" TEXT,"accountId" TEXT);
    INSERT INTO "account" VALUES ('other-user','epic','other-account'),('local-user','different-provider','unrelated'),('local-user','epic','');`);
});
afterEach(() => db.close());

it("scopes the profile cache, Epic request and review permission read to the linked provider account", async () => {
  db.prepare('INSERT INTO "session" VALUES (?,?,?)').run(
    "owned-session",
    "local-user",
    now + 60,
  );
  db.exec(
    `INSERT INTO "account" VALUES ('local-user','epic','linked-account'),('local-user','epic','linked-account')`,
  );
  const profile = await app.request("/profiles/me", { headers });
  expect(profile.status).toBe(200);
  expect(profile.headers.get("cache-control")).toBe("private, no-store");
  expect(await profile.json()).toMatchObject({
    epicAccountId: "linked-account",
  });
  const permissions = await app.request(
    "/offers/fixture-offer/reviews/permissions",
    { headers },
  );
  expect(await permissions.json()).toEqual({ canReview: true });
  expect(reads).toEqual([
    ["cache", "epic-me:linked-account"],
    ["provider", "linked-account"],
    ["epic", { accountId: "linked-account" }],
    ["reviews", { userId: "linked-account", id: "fixture-offer" }],
  ]);
});

it.each([
  "missing link",
  "ambiguous links",
  "expired session",
  "revoked session",
  "other owner",
])("rejects a verified cookie with %s before reading profile or review data", async (reason) => {
  if (reason !== "revoked session")
    db.prepare('INSERT INTO "session" VALUES (?,?,?)').run(
      "owned-session",
      reason === "other owner" ? "other-user" : "local-user",
      reason === "expired session" ? now : now + 60,
    );
  if (reason !== "missing link")
    db.exec(
      `INSERT INTO "account" VALUES ('local-user','epic','linked-account')`,
    );
  if (reason === "ambiguous links")
    db.exec(
      `INSERT INTO "account" VALUES ('local-user','epic','second-account')`,
    );
  const profile = await app.request("/profiles/me", { headers });
  expect(profile.status).toBe(401);
  expect(profile.headers.get("cache-control")).toBe("private, no-store");
  expect(await profile.json()).toEqual({ message: "Unauthorized" });
  expect(
    (
      await app.request("/offers/fixture-offer/reviews/permissions", {
        headers,
      })
    ).status,
  ).toBe(401);
  expect(reads).toEqual([]);
});
