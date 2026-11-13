import { readdirSync, readFileSync } from "node:fs";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AuthHonoEnv } from "../worker/epic-auth";
import { accountDataExport } from "../worker/privacy-export";
import { privacyRequestRoutes } from "../worker/privacy-requests";
import {
  calendarMonths,
  purgePrivacyRecords,
} from "../worker/privacy-retention";
import { sqliteD1 } from "./fixtures/sqlite";

function setup() {
  const result = sqliteD1();
  result.sqlite.exec("PRAGMA foreign_keys=ON");
  for (const file of readdirSync("migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort())
    result.sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  result.sqlite.exec(
    "INSERT INTO users(epic_account_id,display_name) VALUES('alice','Alice'),('bob','Bob'); INSERT INTO projects(id,owner_epic_id,name,slug) VALUES('a','alice','A','a'),('b','bob','B','b'); INSERT INTO api_keys(id,project_id,owner_epic_id,name,key_prefix,key_hash) VALUES('ka','a','alice','A','secret-prefix','secret-hash'),('kb','b','bob','B','bob-prefix','bob-hash'); INSERT INTO developer_profiles(owner_id,contact_email,token_hash) VALUES('alice','alice@example.com','verification-secret');",
  );
  return result;
}
describe("privacy operations", () => {
  it("clamps calendar-month response periods including leap years", () => {
    expect(
      new Date(
        calendarMonths(Date.parse("2028-01-31T12:00:00Z"), 1),
      ).toISOString(),
    ).toBe("2028-02-29T12:00:00.000Z");
    expect(
      new Date(
        calendarMonths(Date.parse("2026-01-31T12:00:00Z"), 3),
      ).toISOString(),
    ).toBe("2026-04-30T12:00:00.000Z");
  });
  it("streams only the caller's records, omits secrets and reports its export scope", async () => {
    const { db } = setup();
    const response = accountDataExport(db, "alice");
    const text = await response.text();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(text).toContain("alice@example.com");
    expect(text).toContain('"id":"ka"');
    for (const secret of [
      "secret-prefix",
      "secret-hash",
      "verification-secret",
      "bob",
      '"id":"kb"',
    ])
      expect(text).not.toContain(secret);
    expect(text).toContain("complete rights request");
  });
  it("removes only expired resolved correspondence and retains pending cases", async () => {
    const { db, sqlite } = setup();
    sqlite.exec(
      "INSERT INTO limit_requests(id,owner_epic_id,project_id,contact_email,requested_tier,requested_rpm,expected_monthly_requests,use_case,status,reviewed_at) VALUES('old','alice','a','alice@example.com','pro',1000,1000,'old','approved','2024-01-01T00:00:00Z'),('pending','alice','a','alice@example.com','pro',1000,1000,'pending','pending',NULL);",
    );
    await purgePrivacyRecords(db, Date.parse("2026-11-12T00:00:00Z"));
    expect(sqlite.prepare("SELECT id FROM limit_requests").all()).toEqual([
      { id: "pending" },
    ]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM users").get()).toEqual(
      { count: 2 },
    );
  });
  it("exports multiple pages without skipping records after an earlier row is removed", async () => {
    const { db, sqlite } = setup();
    const insert = sqlite.prepare(
      "INSERT INTO usage_daily VALUES('a','ka',?,'2026-11-12',1)",
    );
    for (let i = 0; i < 501; i++) insert.run(`operation-${i}`);
    const reader = accountDataExport(db, "alice").body!.getReader();
    const decoder = new TextDecoder();
    const records: { section: string; record?: { operation_id: string } }[] =
      [];
    let removed = false;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const rows = decoder
        .decode(chunk.value)
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      records.push(...rows);
      if (!removed && rows.some((row) => row.section === "endpoint_usage")) {
        sqlite.exec("DELETE FROM usage_daily WHERE operation_id='operation-0'");
        removed = true;
      }
    }
    const usage = records.filter((row) => row.section === "endpoint_usage");
    expect(usage).toHaveLength(501);
    expect(new Set(usage.map((row) => row.record!.operation_id)).size).toBe(
      501,
    );
    expect(records.at(-1)).toEqual({ section: "complete" });
    expect(JSON.stringify(records)).not.toContain("__cursor");
  });
  it("fails the download on storage errors instead of marking a partial export complete", async () => {
    const { db } = setup();
    vi.spyOn(db, "prepare").mockImplementation(() => {
      throw new Error("export storage unavailable");
    });
    await expect(accountDataExport(db, "alice").text()).rejects.toThrow(
      "export storage unavailable",
    );
  });
  it("bounds cleanup and preserves exact expiry boundaries and unresolved cases", async () => {
    const { db, sqlite } = setup();
    const now = Date.parse("2026-11-12T00:00:00Z");
    const cutoff = calendarMonths(now, -12);
    const insert = sqlite.prepare(
      "INSERT INTO privacy_requests(id,case_reference,kind,received_at,due_at,resolved_at,created_by) VALUES(?,?,'access',1,2,?,'operator')",
    );
    for (let i = 0; i < 501; i++)
      insert.run(`old-${i}`, `ref-${i}`, cutoff - 1);
    insert.run("boundary", "ref-boundary", cutoff);
    insert.run("open", "ref-open", null);
    sqlite.exec(
      "INSERT INTO privacy_actions VALUES('action','old-0','D1','export',1,'operator','evidence')",
    );
    await purgePrivacyRecords(db, now);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM privacy_requests").get(),
    ).toEqual({ count: 3 });
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM privacy_actions").get(),
    ).toEqual({ count: 0 });
    await purgePrivacyRecords(db, now);
    expect(
      sqlite.prepare("SELECT id FROM privacy_requests ORDER BY id").all(),
    ).toEqual([{ id: "boundary" }, { id: "open" }]);
  });
  it("tracks non-account requests and prevents late or repeated extensions", async () => {
    const { db } = setup();
    const app = new Hono<AuthHonoEnv>();
    app.use("*", async (c, next) => {
      c.set("user", {
        epicAccountId: "admin",
        displayName: "Admin",
        avatarUrl: "",
      });
      await next();
    });
    app.route("/", privacyRequestRoutes);
    const call = (path: string, body: unknown) =>
      app.request(
        path,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        { DB: db } as AuthHonoEnv["Bindings"],
      );
    const created = await call("/", {
      ownerId: null,
      caseReference: "support-123",
      kind: "access",
      receivedAt: Date.now() - 1000,
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect(
      (
        await call(`/${id}/extend`, {
          reason: "Complex multi-store request",
          notifiedAt: Date.now(),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(`/${id}/extend`, {
          reason: "Second extension denied",
          notifiedAt: Date.now(),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call(`/${id}/actions`, {
          store: "D1",
          action: "export",
          evidenceReference: "support-123/export",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call(`/${id}/resolve`, {
          resolution: "Response provided through verified support channel",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(`/${id}/actions`, {
          store: "D1",
          action: "erase",
          evidenceReference: "late-action",
        })
      ).status,
    ).toBe(409);
    const late = (await (
      await call("/", {
        ownerId: null,
        caseReference: "old",
        kind: "erasure",
        receivedAt: Date.now() - 100 * 86400000,
      })
    ).json()) as { id: string };
    expect(
      (
        await call(`/${late.id}/extend`, {
          reason: "Cannot silently extend an overdue request",
          notifiedAt: Date.now(),
        })
      ).status,
    ).toBe(409);
  });
});
