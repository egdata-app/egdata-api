import { readFileSync } from "node:fs";
import type { Context, Next } from "hono";
import { describe, expect, it, vi } from "vitest";
import { sqliteD1 } from "./fixtures/sqlite";

vi.mock("../worker/epic-auth", () => ({
  requireDashboardUser: async (c: Context, next: Next) => {
    const id = c.req.header("x-test-user");
    if (!id) return c.json({ error: { message: "Unauthorized" } }, 401);
    c.set("user", { epicAccountId: id });
    await next();
  },
}));

import { alertRoutes, handleChangeIngestion } from "../worker/alert-routes";
import { type ChangeRecord, canonicalJson } from "../worker/change-validation";
import { sha256Hex } from "../worker/crypto";
import { importMergedRecord, ingestUsage } from "../worker/endpoint-alerts";
import type { DashboardEnv } from "../worker/types";

const mergedAt = Date.parse("2026-11-01T12:00:00Z");

const record: ChangeRecord = {
  id: "offer-change",
  title: "Fix the offer response",
  recordedDate: "2026-11-01",
  verification: ["tests/offer.test.ts"],
  endpoints: [
    {
      apiVersion: "v1",
      operationId: "getOffer",
      method: "GET",
      path: "/v1/offers/{id}",
      type: "fixed",
      compatibility: "compatible",
      before: "A response field was missing.",
      after: "The response field is included.",
      clientAction: "None",
    },
  ],
};

function setup() {
  const { db, sqlite } = sqliteD1();
  sqlite.exec(readFileSync("migrations/0001_initial.sql", "utf8"));
  sqlite.exec(readFileSync("migrations/0002_endpoint_alerts.sql", "utf8"));
  sqlite.exec(readFileSync("migrations/0003_console_sessions.sql", "utf8"));
  sqlite.exec(
    readFileSync("migrations/0006_project_creation_policy.sql", "utf8"),
  );
  sqlite.exec(readFileSync("migrations/0007_project_recovery.sql", "utf8"));
  sqlite.exec(
    "INSERT INTO users(epic_account_id,display_name) VALUES('user_a','A'),('user_b','B'); INSERT INTO projects(id,owner_epic_id,name,slug) VALUES('project_a','user_a','A','a'),('project_b','user_b','B','b');",
  );
  return {
    db,
    sqlite,
    env: {
      DB: db,
      DASHBOARD_SESSION_SECRET: "test-session-secret",
      CHANGELOG_INGEST_TOKEN: "ingest-only-secret",
      USAGE_TRACKING_ENABLED: "true",
      USAGE_TRACKING_STARTED_AT: "2026-10-20T00:00:00Z",
    } as DashboardEnv,
  };
}

describe("project authorization and ingestion", () => {
  it("enforces project ownership on every private read and mutation", async () => {
    const { env } = setup();
    for (const [path, method] of [
      ["/project_b/inbox", "GET"],
      ["/project_b/read-all", "POST"],
      ["/project_b/offer-change/read", "POST"],
    ]) {
      const req = new Request(`https://devs.egdata.app${path}`, {
        method,
        headers: { "x-test-user": "user_a", origin: "https://devs.egdata.app" },
      });
      expect((await alertRoutes.fetch(req, env)).status).toBe(404);
    }
    expect(
      (
        await alertRoutes.fetch(
          new Request("https://devs.egdata.app/project_a/inbox"),
          env,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await alertRoutes.fetch(
          new Request("https://devs.egdata.app/project_a/offer-change/read", {
            method: "POST",
            headers: {
              "x-test-user": "user_a",
              origin: "https://evil.example",
            },
          }),
          env,
        )
      ).status,
    ).toBe(403);
  });
  it("binds mark-all cutoff to the current user/project and leaves newer alerts unread", async () => {
    const { db, env } = setup();
    const request = (path: string, method = "GET", body?: unknown) =>
      new Request(`https://devs.egdata.app/project_a/${path}`, {
        method,
        headers: {
          "x-test-user": "user_a",
          origin: "https://devs.egdata.app",
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    await ingestUsage(
      db,
      [
        {
          keyId: "key_a",
          projectId: "project_a",
          operationId: "getOffer",
          usageDate: "2026-11-01",
          firstUsedAt: mergedAt - 1000,
        },
      ],
      mergedAt + 1000,
    );
    const publish = async (r: ChangeRecord) =>
      importMergedRecord(db, {
        record: r,
        contentHash: await sha256Hex(canonicalJson(r)),
        mergeCommit: "a".repeat(40),
        mergedAt,
      });
    await publish(record);
    const inbox = (await (
      await alertRoutes.fetch(request("inbox"), env)
    ).json()) as { cutoffToken: string; unread: number };
    expect(inbox.unread).toBe(1);
    await publish({ ...record, id: "second-change" });
    expect(
      (
        await alertRoutes.fetch(
          request("read-all", "POST", { cutoffToken: inbox.cutoffToken }),
          env,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        (await (await alertRoutes.fetch(request("inbox"), env)).json()) as {
          unread: number;
        }
      ).unread,
    ).toBe(1);
    expect(
      (
        await alertRoutes.fetch(
          request("read-all", "POST", { cutoffToken: "forged" }),
          env,
        )
      ).status,
    ).toBe(400);
    const other = new Request("https://devs.egdata.app/project_b/read-all", {
      method: "POST",
      headers: { "x-test-user": "user_b", origin: "https://devs.egdata.app" },
      body: JSON.stringify({ cutoffToken: inbox.cutoffToken }),
    });
    expect((await alertRoutes.fetch(other, env)).status).toBe(400);
  });
  it("authenticates narrow publication, validates IDs/hashes and rejects changed record content", async () => {
    const { env } = setup();
    const published = {
      record,
      mergeCommit: "a".repeat(40),
      mergedAt,
      contentHash: await sha256Hex(canonicalJson(record)),
    };
    const endpoints = [
      {
        apiVersion: "v1",
        operationId: "getOffer",
        method: "GET",
        path: "/v1/offers/{id}",
        status: "active",
      },
    ];
    const body = {
      mergeCommit: published.mergeCommit,
      mergedAt,
      endpoints,
      records: [published],
    };
    const request = (data: unknown, token = "ingest-only-secret") =>
      new Request("https://devs.egdata.app/_internal/change-records", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify(data),
      });
    expect(
      (await handleChangeIngestion(request(body, "wrong"), env)).status,
    ).toBe(401);
    expect((await handleChangeIngestion(request(body), env)).status).toBe(200);
    expect((await handleChangeIngestion(request(body), env)).status).toBe(200);
    expect(
      (
        await handleChangeIngestion(
          request({
            ...body,
            records: [{ ...published, contentHash: "b".repeat(64) }],
          }),
          env,
        )
      ).status,
    ).toBe(409);
    expect(
      (await handleChangeIngestion(request({ ...body, endpoints: [] }), env))
        .status,
    ).toBe(409);
    expect(
      (
        await handleChangeIngestion(
          new Request("https://devs.egdata.app/_internal/change-records", {
            method: "POST",
            headers: { authorization: "Bearer ingest-only-secret" },
            body: "not JSON",
          }),
          env,
        )
      ).status,
    ).toBe(400);
  });
});
