import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signHmacToken } from "../worker/crypto";
import {
  createProject,
  findRawKeyByHash,
  listUserProjects,
  upsertEpicUserAndDefaultProject,
} from "../worker/db";
import worker from "../worker/index";
import type { DashboardEnv } from "../worker/types";
import { sqliteD1 } from "./fixtures/sqlite";

const user = { epicAccountId: "owner", displayName: "Owner", avatarUrl: "" };
const projectInput = {
  ownerEpicId: "owner",
  name: "Project",
  slug: "project",
  description: "",
  websiteUrl: "",
};

function setup(applyPolicy = true) {
  const result = sqliteD1();
  for (const migration of [
    "0001_initial.sql",
    "0004_limit_request_reviews.sql",
    "0005_dashboard_session_revocations.sql",
  ]) {
    result.sqlite.exec(readFileSync(`migrations/${migration}`, "utf8"));
  }
  result.sqlite.exec(
    "INSERT INTO users(epic_account_id, display_name) VALUES ('owner', 'Owner')",
  );
  if (applyPolicy) migrate(result.sqlite);
  return result;
}

function migrate(sqlite: ReturnType<typeof sqliteD1>["sqlite"]) {
  sqlite.exec(
    readFileSync("migrations/0006_project_creation_policy.sql", "utf8"),
  );
}

afterEach(() => vi.restoreAllMocks());

describe("account project creation policy", () => {
  it("admits only one concurrent project creation", async () => {
    const { db } = setup();
    const results = await Promise.allSettled([
      createProject(db, projectInput),
      createProject(db, projectInput),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { code: "PROJECT_LIMIT_REACHED" } });
    expect(await listUserProjects(db, "owner")).toHaveLength(1);
  });

  it("creates one default project across concurrent login and manual requests", async () => {
    const { db, sqlite } = setup();
    // Even an approved multi-project account must receive only one default.
    sqlite.exec("UPDATE users SET project_limit = 3");
    const results = await Promise.all([
      upsertEpicUserAndDefaultProject(db, user),
      upsertEpicUserAndDefaultProject(db, user),
      createProject(db, projectInput),
    ]);
    expect(results[0]).toHaveLength(1);
    expect(results[1]).toHaveLength(1);
    expect(await listUserProjects(db, "owner")).toHaveLength(1);
  });

  it("keeps the cooldown after deletion, allows login, and expires after 24 hours", async () => {
    const { db, sqlite } = setup();
    await createProject(db, projectInput);
    sqlite.exec("DELETE FROM projects");
    await expect(createProject(db, projectInput)).rejects.toMatchObject({
      code: "PROJECT_CREATION_COOLDOWN",
    });
    expect(await upsertEpicUserAndDefaultProject(db, user)).toEqual([]);
    sqlite.exec(
      "UPDATE users SET last_project_created_at = last_project_created_at - 86400",
    );
    expect(await upsertEpicUserAndDefaultProject(db, user)).toHaveLength(1);
  });

  it("retains existing projects, keys, approved limits, and blocks further creation", async () => {
    const { db, sqlite } = setup(false);
    const first = await createProject(db, projectInput);
    if (!first) throw new Error("Expected the initial project to be created");
    await createProject(db, projectInput);
    sqlite
      .prepare(
        "UPDATE projects SET tier = 'pro', custom_rpm = 1500 WHERE id = ?",
      )
      .run(first.id);
    sqlite
      .prepare(
        "INSERT INTO api_keys(id,project_id,owner_epic_id,name,key_prefix,key_hash) VALUES('key',?,'owner','Key','egk','hash')",
      )
      .run(first.id);
    migrate(sqlite);
    expect(await listUserProjects(db, "owner")).toHaveLength(2);
    expect(await findRawKeyByHash(db, "hash")).toMatchObject({
      id: "key",
      tier: "pro",
      custom_rpm: 1500,
    });
    await expect(createProject(db, projectInput)).rejects.toMatchObject({
      code: "PROJECT_LIMIT_REACHED",
    });
    // Operator approval changes only the account allowance, not key permissions.
    sqlite.exec(
      "UPDATE users SET project_limit = 3, last_project_created_at = last_project_created_at - 86400",
    );
    expect(await createProject(db, projectInput)).not.toBeNull();
    expect(await listUserProjects(db, "owner")).toHaveLength(3);
  });

  it("returns actionable HTTP errors and ignores client-supplied allowances", async () => {
    const { db } = setup();
    await createProject(db, projectInput);
    const secret = "project-policy-session-secret-at-least-32";
    const cookie = await signHmacToken(
      { user, exp: Date.now() + 60_000, iat: Date.now() },
      secret,
    );
    const response = await worker.fetch(
      new Request("https://devs.egdata.app/_dashboard/api/projects", {
        method: "POST",
        headers: {
          origin: "https://devs.egdata.app",
          "content-type": "application/json",
          cookie: `egdata_dash_session=${cookie}`,
        },
        body: JSON.stringify({ name: "Extra project", projectLimit: 100 }),
      }),
      { DB: db, DASHBOARD_SESSION_SECRET: secret } as DashboardEnv,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "PROJECT_LIMIT_REACHED" },
    });
  });

  it("does not hide unrelated database failures during login", async () => {
    const { db, sqlite } = setup();
    sqlite.exec(
      "CREATE TRIGGER reject_projects BEFORE INSERT ON projects BEGIN SELECT RAISE(ABORT, 'write failure'); END",
    );
    await expect(upsertEpicUserAndDefaultProject(db, user)).rejects.toThrow(
      "write failure",
    );
  });
});
