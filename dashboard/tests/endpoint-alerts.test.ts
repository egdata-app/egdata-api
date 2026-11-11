import { readFileSync } from "node:fs";
import { describe, expect, it, vi, afterEach } from "vitest";
import { sqliteD1 } from "./fixtures/sqlite";
import {
  DAY_MS,
  importMergedRecord,
  ingestUsage,
  listAlerts,
  markAllRead,
  markRead,
  mergeWindow,
  projectOwned,
  qualifiesUsage,
  type UsageEvent,
} from "../worker/endpoint-alerts";
import { canonicalJson, type ChangeRecord } from "../worker/change-validation";
import { sha256Hex } from "../worker/crypto";

const mergedAt = Date.parse("2026-11-11T12:00:00Z");

function setup() {
  const ctx = sqliteD1();
  ctx.sqlite.exec(readFileSync("migrations/0001_initial.sql", "utf8"));
  ctx.sqlite.exec(readFileSync("migrations/0002_endpoint_alerts.sql", "utf8"));
  return ctx;
}

const usage = (overrides: Partial<UsageEvent> = {}): UsageEvent => ({
  keyId: "key_revoked",
  projectId: "project_a",
  operationId: "getOffer",
  usageDate: "2026-11-11",
  firstUsedAt: mergedAt - 1000,
  ...overrides,
});

const record = (id = "offer-fix"): ChangeRecord => ({
  id,
  recordedDate: "2026-11-11",
  title: "Fix offer response field",
  verification: ["tests/offers.test.ts"],
  endpoints: [
    {
      apiVersion: "v1",
      operationId: "getOffer",
      method: "GET",
      path: "/v1/offers/{id}",
      type: "fixed",
      compatibility: "compatible",
      before: "A response field was omitted.",
      after: "The response field is present.",
      clientAction: "None",
    },
  ],
});

async function publish(db: D1Database, r = record(), time = mergedAt) {
  await importMergedRecord(db, {
    record: r,
    contentHash: await sha256Hex(canonicalJson(r)),
    mergeCommit: "a".repeat(40),
    mergedAt: time,
  });
}

afterEach(() => vi.useRealTimers());

describe("durable usage and merged-record matching", () => {
  it("retries interrupted imports without exposing partial alerts or completion receipts", async () => {
    const { db, sqlite } = setup();
    vi.spyOn(Date, "now").mockReturnValue(mergedAt + DAY_MS);
    await ingestUsage(db, [usage()]);
    sqlite.exec(`CREATE TRIGGER fail_completion BEFORE UPDATE OF import_complete ON change_records
      WHEN NEW.import_complete = 1 BEGIN SELECT RAISE(ABORT, 'simulated interruption'); END`);
    await expect(publish(db)).rejects.toThrow("simulated interruption");
    expect(
      sqlite.prepare("SELECT import_complete FROM change_records").get()
        ?.import_complete,
    ).toBe(0);
    expect((await listAlerts(db, "project_a", "user_a")).unread).toBe(0);
    // Delayed usage must not publish an interrupted import either.
    await ingestUsage(db, [usage()]);
    const cutoff = (await listAlerts(db, "project_a", "user_a")).cutoff;
    sqlite.exec("DROP TRIGGER fail_completion");
    await publish(db);
    await markAllRead(db, "project_a", "user_a", cutoff);
    expect((await listAlerts(db, "project_a", "user_a")).unread).toBe(1);
    expect(
      sqlite.prepare("SELECT import_complete FROM change_records").get()
        ?.import_complete,
    ).toBe(1);
  });
  it("uses 30 UTC dates inclusive and excludes first use after merge", () => {
    expect(mergeWindow(mergedAt)).toEqual({
      windowStart: "2026-10-13",
      mergeDate: "2026-11-11",
    });
    expect(
      qualifiesUsage(
        usage({
          usageDate: "2026-10-13",
          firstUsedAt: Date.parse("2026-10-13T00:00:00Z"),
        }),
        mergedAt,
      ),
    ).toBe(true);
    expect(
      qualifiesUsage(
        usage({
          usageDate: "2026-10-12",
          firstUsedAt: Date.parse("2026-10-12T23:59:59Z"),
        }),
        mergedAt,
      ),
    ).toBe(false);
    expect(qualifiesUsage(usage({ firstUsedAt: mergedAt + 1 }), mergedAt)).toBe(
      false,
    );
    expect(qualifiesUsage(usage({ firstUsedAt: mergedAt }), mergedAt)).toBe(
      true,
    );
  });
  it("deduplicates publication and usage, retains earliest daily timestamp and revoked keys", async () => {
    const { db, sqlite } = setup();
    vi.spyOn(Date, "now").mockReturnValue(mergedAt + DAY_MS);
    await ingestUsage(db, [usage(), usage({ firstUsedAt: mergedAt - 5000 })]);
    await publish(db);
    await publish(db);
    await ingestUsage(db, [usage()]);
    const inbox = await listAlerts(db, "project_a", "user_a");
    expect(inbox.alerts).toHaveLength(1);
    expect(inbox.alerts[0].matches).toEqual([
      {
        operation_id: "getOffer",
        key_id: "key_revoked",
        first_used_at: mergedAt - 5000,
      },
    ]);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM usage_daily").get()?.count,
    ).toBe(1);
    const changed = record();
    changed.title = "Changed content under same ID";
    await expect(publish(db, changed)).rejects.toThrow("conflict");
  });
  it("reconciles delayed events against original merge window, never against ingestion date", async () => {
    const { db } = setup();
    vi.spyOn(Date, "now").mockReturnValue(mergedAt + 3 * DAY_MS);
    await publish(db);
    await ingestUsage(db, [usage({ firstUsedAt: mergedAt + 1000 })]);
    expect((await listAlerts(db, "project_a", "user_a")).alerts).toHaveLength(
      0,
    );
    await ingestUsage(db, [
      usage({ firstUsedAt: mergedAt - 1000 }),
      usage({
        projectId: "project_b",
        keyId: "key_b",
        usageDate: "2026-11-12",
        firstUsedAt: mergedAt + DAY_MS,
      }),
    ]);
    expect((await listAlerts(db, "project_a", "user_a")).alerts).toHaveLength(
      1,
    );
    expect((await listAlerts(db, "project_b", "user_b")).alerts).toHaveLength(
      0,
    );
  });
  it("isolates users/projects and mark-all cutoff leaves concurrent alerts unread", async () => {
    const { db } = setup();
    vi.spyOn(Date, "now").mockReturnValue(mergedAt + DAY_MS);
    await ingestUsage(db, [usage()]);
    await publish(db);
    const before = await listAlerts(db, "project_a", "user_a");
    await publish(db, record("second-fix"));
    await markAllRead(db, "project_a", "user_a", before.cutoff);
    expect((await listAlerts(db, "project_a", "user_a")).unread).toBe(1);
    expect((await listAlerts(db, "project_a", "user_b")).unread).toBe(2);
    expect((await listAlerts(db, "project_b", "user_a")).unread).toBe(0);
    await markRead(db, "project_a", "user_a", "second-fix");
    expect((await listAlerts(db, "project_a", "user_a")).unread).toBe(0);
    expect(await projectOwned(db, "project_a", "user_b")).toBe(false);
  });
  it("filters by operation, type, compatibility and unread; alerts outlive usage", async () => {
    const { db, sqlite } = setup();
    vi.spyOn(Date, "now").mockReturnValue(mergedAt + DAY_MS);
    await ingestUsage(db, [usage()]);
    await publish(db);
    sqlite.exec("DELETE FROM usage_daily");
    expect(
      (
        await listAlerts(db, "project_a", "user_a", {
          endpoint: "getOffer",
          type: "fixed",
          compatibility: "compatible",
          unread: true,
        })
      ).alerts,
    ).toHaveLength(1);
    expect(
      (await listAlerts(db, "project_a", "user_a", { endpoint: "getItem" }))
        .alerts,
    ).toHaveLength(0);
    expect(
      (
        await listAlerts(db, "project_a", "user_a", {
          compatibility: "breaking",
        })
      ).alerts,
    ).toHaveLength(0);
  });
});
