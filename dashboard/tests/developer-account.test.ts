import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SessionResponse } from "../src/lib/api";
import { sha256Hex, signHmacToken } from "../worker/crypto";
import {
  type DeveloperReceipt,
  listDeveloperReceipts,
  receiptEmail,
} from "../worker/developer-receipts";
import type { DeveloperStatus } from "../worker/developer-status";
import worker from "../worker/index";
import {
  invalidateLocalKeyCache,
  resolveApiKeyMetadata,
  syncKeyToKv,
} from "../worker/key-cache";
import type { DashboardEnv } from "../worker/types";
import { sqliteD1 } from "./fixtures/sqlite";

const origin = "https://devs.egdata.app";
const secret = "developer-account-test-secret-32-chars";
async function setup(active = true) {
  const { db, sqlite } = sqliteD1();
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const file of readdirSync("migrations")
    .filter((x) => x.endsWith(".sql"))
    .sort())
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  sqlite.exec(
    "INSERT INTO users(epic_account_id,display_name) VALUES('owner','Owner'),('other','Other'); INSERT INTO projects(id,owner_epic_id,name,slug) VALUES('project','owner','Project','project')",
  );
  const rawKey = `egk_${crypto.randomUUID()}`;
  const hash = await sha256Hex(rawKey);
  sqlite
    .prepare(
      "INSERT INTO api_keys(id,project_id,owner_epic_id,name,key_prefix,key_hash) VALUES('key','project','owner','Key','egk',?)",
    )
    .run(hash);
  const termsHash = await sha256Hex("Test final terms");
  if (active) {
    sqlite
      .prepare(
        "INSERT INTO legal_documents VALUES('terms','1.0','edition-1',?,'Test final terms',?)",
      )
      .run(termsHash, Date.now());
    sqlite
      .prepare(
        "INSERT INTO legal_documents VALUES('privacy','1.0','',?,'Test privacy notice',?)",
      )
      .run(await sha256Hex("Test privacy notice"), Date.now());
    sqlite.exec("INSERT INTO legal_rollout VALUES(1,'revision-1','1.0','1.0')");
  }
  const send = vi.fn(async (_input: { to: string; text: string }) => ({
    messageId: crypto.randomUUID(),
  }));
  const cache = new Map<string, unknown>();
  const env = {
    DB: db,
    EMAIL: { send },
    DASHBOARD_SESSION_SECRET: secret,
    DASHBOARD_ORIGIN: origin,
    API_KEYS_KV: {
      get: async (key: string) => cache.get(key) ?? null,
      put: async (key: string, value: string) => {
        cache.set(key, JSON.parse(value));
      },
      delete: async (key: string) => {
        cache.delete(key);
      },
    },
  } as unknown as DashboardEnv;
  const work: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      work.push(p);
    },
    passThroughOnException() {},
  } as ExecutionContext;
  const login = async (owner = "owner", iat = Date.now()) =>
    `egdata_dash_session=${await signHmacToken({ user: { epicAccountId: owner, displayName: owner, avatarUrl: "" }, iat, exp: Date.now() + 86400000 }, secret)}`;
  const cookie = await login();
  const call = async (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    worker.fetch(
      new Request(`${origin}/_dashboard/api${path}`, {
        method,
        headers: {
          cookie,
          origin,
          "content-type": "application/json",
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
      ctx,
    );
  const accept = (fields = {}) =>
    call("/account/agreements", "POST", {
      revision: "revision-1",
      version: "1.0",
      sha256: termsHash,
      accepted: true,
      ...fields,
    });
  const verify = async (email = "owner@example.com") => {
    const sent = await call("/account/email", "POST", { email });
    expect(sent.status).toBe(200);
    const token = /verify-email=([a-f0-9]{64})/.exec(
      send.mock.calls.at(-1)![0].text,
    )![1];
    return {
      token,
      response: await call("/account/email/verify", "POST", { token }),
    };
  };
  return {
    db,
    sqlite,
    env,
    ctx,
    hash,
    rawKey,
    send,
    work,
    login,
    cookie,
    call,
    accept,
    verify,
    termsHash,
  };
}

describe("initial developer onboarding", () => {
  it("allows export during onboarding and guards privacy/admin routes with live roles and origin checks", async () => {
    const { call, sqlite, verify, accept } = await setup();
    expect(
      (await call("/account/export", "GET", undefined, { cookie: "" })).status,
    ).toBe(401);
    const exportResponse = await call("/account/export");
    expect(exportResponse.status).toBe(200);
    expect(await exportResponse.text()).toContain('"section":"complete"');
    for (const path of ["/admin/privacy-requests", "/admin/notifications"]) {
      expect((await call(path, "GET", undefined, { cookie: "" })).status).toBe(
        401,
      );
      expect((await call(path)).status).toBe(403);
    }
    sqlite.exec("INSERT INTO user_roles(user_id,role) VALUES('owner','admin')");
    expect((await call("/admin/notifications")).status).toBe(403);
    await verify();
    await accept();
    for (const path of ["/admin/privacy-requests", "/admin/notifications"]) {
      const response = await call(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(
      (
        await call(
          "/admin/privacy-requests",
          "POST",
          {
            ownerId: null,
            caseReference: "test",
            kind: "access",
            receivedAt: Date.now(),
          },
          { origin: "https://other.example" },
        )
      ).status,
    ).toBe(403);
    sqlite.exec("DELETE FROM user_roles WHERE user_id='owner'");
    expect((await call("/admin/notifications")).status).toBe(403);
  });
  it("tracks verification transport without storing the verification code", async () => {
    const { verify, sqlite } = await setup();
    const { token, response } = await verify();
    expect(response.status).toBe(200);
    const mail = sqlite
      .prepare("SELECT * FROM developer_mail WHERE id LIKE 'verification:%'")
      .all();
    expect(mail).toHaveLength(1);
    expect(JSON.stringify(mail)).not.toContain(token);
    expect(
      sqlite.prepare("SELECT status FROM developer_mail_attempts").get(),
    ).toEqual({ status: "queued" });
  });
  it("does not activate a requirement from a schema migration alone", async () => {
    const s = await setup(false);
    expect((await s.call("/projects")).status).toBe(200);
    expect(
      ((await (await s.call("/auth/session")).json()) as SessionResponse)
        .account,
    ).toMatchObject({ enabled: false, eligible: true });
  });
  it("blocks dashboard reads and project creation but preserves an existing warm API key", async () => {
    const s = await setup();
    const before = await resolveApiKeyMetadata(s.env, s.ctx, s.hash);
    expect(before).not.toBeNull();
    expect((await s.call("/projects")).status).toBe(403);
    const session = (await (
      await s.call("/auth/session")
    ).json()) as SessionResponse;
    expect(session.projects).toEqual([]);
    expect(session.account).toMatchObject({
      eligible: false,
      existingKeysContinue: true,
    });
    expect(await resolveApiKeyMetadata(s.env, s.ctx, s.hash)).toEqual(before);
    const otherSession = await s.call("/auth/session", "GET", undefined, {
      cookie: await s.login("other"),
    });
    expect(otherSession.status).toBe(200);
    expect(
      s.sqlite
        .prepare("SELECT COUNT(*) n FROM projects WHERE owner_epic_id='other'")
        .get()!.n,
    ).toBe(0);
  });
  it("requires email verification before acceptance, atomically consumes tokens, and records the exact text/hash once", async () => {
    const s = await setup();
    expect((await s.accept()).status).toBe(403);
    expect(
      s.sqlite.prepare("SELECT COUNT(*) n FROM legal_acceptances").get()!.n,
    ).toBe(0);
    const { token, response } = await s.verify();
    expect(response.status).toBe(200);
    expect(
      (await s.call("/account/email/verify", "POST", { token })).status,
    ).toBe(409);
    expect((await s.accept()).status).toBe(200);
    expect((await s.accept()).status).toBe(200);
    expect(
      s.sqlite.prepare("SELECT COUNT(*) n FROM legal_acceptances").get()!.n,
    ).toBe(1);
    expect((await s.call("/projects")).status).toBe(200);
    const receipt = (await (await s.call("/account/receipt")).json()) as {
      acceptances: Array<{ version: string; sha256: string; body: string }>;
    };
    expect(receipt.acceptances[0]).toMatchObject({
      version: "1.0",
      sha256: s.termsHash,
      body: "Test final terms",
    });
    await Promise.all(s.work);
  });
  it("freezes both documents and receipt identity across profile and rollout changes", async () => {
    const s = await setup();
    await s.verify();
    expect((await s.accept()).status).toBe(200);
    const response = await s.call("/account/receipt");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const { acceptances } = (await response.json()) as {
      acceptances: DeveloperReceipt[];
    };
    const receipt = acceptances[0];
    expect(receipt.receipt_id).toMatch(/^rcpt_/);
    expect(receipt.account_id).toBe("owner");
    expect(receipt.accepted_at_iso).toBe(
      new Date(receipt.accepted_at).toISOString(),
    );
    expect(receipt.privacy_status).toBe("provided");
    expect(receipt.privacy_recorded_at).toBe(receipt.accepted_at);
    expect(receipt.privacy).toMatchObject({
      kind: "privacy",
      version: "1.0",
      body: "Test privacy notice",
      sha256: await sha256Hex("Test privacy notice"),
    });
    expect((await s.accept()).status).toBe(200);
    await Promise.all(s.work);
    const mail = s.send.mock.calls.find(([input]) =>
      input.text.includes(receipt.receipt_id),
    )?.[0];
    expect(mail?.text).toContain("This is not privacy or marketing consent");
    expect(mail?.text).toContain("Test privacy notice");
    expect(mail?.text).toContain("Test final terms");
    expect(mail?.text).toContain(
      `/profile/receipts?receipt=${receipt.receipt_id}`,
    );
    s.sqlite.exec(
      "UPDATE developer_profiles SET contact_email='changed@example.com'; UPDATE users SET display_name='Changed';",
    );
    s.sqlite
      .prepare(
        "INSERT INTO legal_documents VALUES('privacy','2.0','',?,'New notice',?)",
      )
      .run(await sha256Hex("New notice"), Date.now());
    s.sqlite.exec(
      "UPDATE legal_rollout SET privacy_version='2.0',revision='revision-2'",
    );
    expect(await listDeveloperReceipts(s.db, "owner")).toEqual(acceptances);
    expect(() =>
      s.sqlite.exec("UPDATE legal_acceptances SET privacy_version='2.0'"),
    ).toThrow("ACCEPTANCE_EVIDENCE_IMMUTABLE");
    expect(
      (await (
        await s.call("/account/receipt", "GET", undefined, {
          cookie: await s.login("other"),
        })
      ).json()) as unknown,
    ).toEqual({ acceptances: [] });
    expect(
      (await s.call("/account/receipt", "GET", undefined, { cookie: "" }))
        .status,
    ).toBe(401);
  });
  it("does not create acceptance evidence without its durable receipt job", async () => {
    const s = await setup();
    await s.verify();
    s.sqlite.exec(
      "CREATE TRIGGER reject_receipt BEFORE INSERT ON developer_mail WHEN NEW.receipt_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'test receipt failure'); END;",
    );
    expect((await s.accept()).status).toBe(500);
    expect(
      s.sqlite.prepare("SELECT COUNT(*) n FROM legal_acceptances").get()!.n,
    ).toBe(0);
  });
  it("migrates historical receipts without inventing a privacy version", async () => {
    const { db, sqlite } = sqliteD1();
    for (const file of readdirSync("migrations")
      .filter((x) => x.endsWith(".sql") && x < "0009")
      .sort())
      sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
    sqlite.exec(
      "INSERT INTO legal_documents VALUES('terms','old','old-edition','hash','Old terms',1); INSERT INTO legal_acceptances(owner_id,version,edition,sha256,accepted_at,requirement_revision) VALUES('owner','old','old-edition','hash',1000,'old-revision')",
    );
    sqlite.exec(readFileSync("migrations/0009_agreement_receipts.sql", "utf8"));
    const [receipt] = await listDeveloperReceipts(db, "owner");
    expect(receipt.receipt_id).toMatch(/^rcpt_[a-f0-9]{32}$/);
    expect(receipt.privacy).toBeNull();
    expect(receipt.privacy_status).toBe("not_recorded");
    expect(receipt.accepted_at).toBe(1000);
    expect(receipt.privacy_recorded_at).toBeNull();
  });
  it("escapes receipt email metadata and uses the configured first-party URL", async () => {
    const s = await setup();
    await s.verify();
    await s.accept();
    const [receipt] = await listDeveloperReceipts(s.db, "owner");
    const email = receiptEmail(
      { ...receipt, version: '<img src=x onerror="alert(1)">' },
      origin,
    );
    expect(email.html).not.toContain("<img");
    expect(email.html).toContain("&lt;img");
    expect(email.html).toContain(`${origin}/profile/receipts?receipt=`);
    await Promise.all(s.work);
  });
  it("rejects stale requirements, changed hashes and cross-account/cross-origin verification", async () => {
    const s = await setup();
    await s.verify();
    expect((await s.accept({ revision: "old" })).status).toBe(409);
    expect((await s.accept({ sha256: "0".repeat(64) })).status).toBe(409);
    expect((await s.accept()).status).toBe(200);
    expect((await s.accept({ sha256: "0".repeat(64) })).status).toBe(409);
    expect(
      (
        await s.call(
          "/account/email",
          "POST",
          { email: "attacker@example.com" },
          { origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    s.sqlite.exec("UPDATE developer_profiles SET last_sent_at=0");
    await s.call("/account/email", "POST", { email: "next@example.com" });
    const token = /verify-email=([a-f0-9]{64})/.exec(
      s.send.mock.calls.at(-1)![0].text,
    )![1];
    expect(
      (
        await s.call(
          "/account/email/verify",
          "POST",
          { token },
          { cookie: await s.login("other") },
        )
      ).status,
    ).toBe(409);
    const status = (await (await s.call("/account")).json()) as DeveloperStatus;
    expect(status.contactEmail).toBe("owner@example.com");
    expect(status.pendingEmail).toBe("next@example.com");
    expect(status.eligible).toBe(true);
    await Promise.all(s.work);
  });
  it("fails email delivery honestly and invalidates the failed token", async () => {
    const s = await setup();
    s.send.mockRejectedValueOnce(new Error("transport failed"));
    expect(
      (await s.call("/account/email", "POST", { email: "owner@example.com" }))
        .status,
    ).toBe(503);
    expect(
      s.sqlite.prepare("SELECT token_hash FROM developer_profiles").get()!
        .token_hash,
    ).toBeNull();
    expect((await s.accept()).status).toBe(403);
  });
  it("consumes a token only once and deduplicates concurrent acceptance receipts", async () => {
    const s = await setup();
    await s.call("/account/email", "POST", { email: "owner@example.com" });
    const token = /verify-email=([a-f0-9]{64})/.exec(
      s.send.mock.calls.at(-1)![0].text,
    )![1];
    const verified = await Promise.all([
      s.call("/account/email/verify", "POST", { token }),
      s.call("/account/email/verify", "POST", { token }),
    ]);
    expect(verified.map((r) => r.status).sort()).toEqual([200, 409]);
    const accepted = await Promise.all([s.accept(), s.accept()]);
    expect(accepted.map((r) => r.status)).toEqual([200, 200]);
    expect(
      s.sqlite.prepare("SELECT COUNT(*) n FROM legal_acceptances").get()!.n,
    ).toBe(1);
    expect(
      s.sqlite
        .prepare(
          "SELECT COUNT(*) n FROM developer_mail WHERE id LIKE 'acceptance:%'",
        )
        .get()!.n,
    ).toBe(1);
    await Promise.all(s.work);
  });
  it("expires and replaces verification codes without changing the verified contact, and rate-limits sends", async () => {
    const s = await setup();
    await s.verify();
    expect(
      (await s.call("/account/email", "POST", { email: "next@example.com" }))
        .status,
    ).toBe(429);
    s.sqlite.exec("UPDATE developer_profiles SET last_sent_at=0");
    await s.call("/account/email", "POST", { email: "next@example.com" });
    const oldToken = /verify-email=([a-f0-9]{64})/.exec(
      s.send.mock.calls.at(-1)![0].text,
    )![1];
    s.sqlite.exec("UPDATE developer_profiles SET last_sent_at=0");
    await s.call("/account/email", "POST", { email: "final@example.com" });
    const token = /verify-email=([a-f0-9]{64})/.exec(
      s.send.mock.calls.at(-1)![0].text,
    )![1];
    expect(
      (await s.call("/account/email/verify", "POST", { token: oldToken }))
        .status,
    ).toBe(409);
    s.sqlite
      .prepare("UPDATE developer_profiles SET token_expires_at=?")
      .run(Date.now());
    expect(
      (await s.call("/account/email/verify", "POST", { token })).status,
    ).toBe(409);
    expect(
      s.sqlite.prepare("SELECT contact_email FROM developer_profiles").get()!
        .contact_email,
    ).toBe("owner@example.com");
    s.sqlite.exec("UPDATE developer_profiles SET last_sent_at=0,send_count=5");
    expect(
      (await s.call("/account/email", "POST", { email: "final@example.com" }))
        .status,
    ).toBe(429);
    await Promise.all(s.work);
  });
  it("fails closed before quota/upstream access if the closure store cannot be read, including HEAD", async () => {
    const s = await setup();
    await resolveApiKeyMetadata(s.env, s.ctx, s.hash);
    const prepare = s.db.prepare.bind(s.db);
    const mock = vi.spyOn(s.db, "prepare").mockImplementation((query) => {
      if (query.includes("FROM account_closures"))
        throw new Error("status unavailable");
      return prepare(query);
    });
    try {
      for (const path of ["/proxy/offers", "/proxy/v1/offers"]) {
        for (const method of ["GET", "HEAD"]) {
          const response = await worker.fetch(
            new Request(`${origin}${path}`, {
              method,
              headers: { "X-API-Key": s.rawKey, origin },
            }),
            s.env,
            s.ctx,
          );
          expect(response.status).toBe(503);
          expect(response.headers.get("Cache-Control")).toContain("no-store");
          expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
            origin,
          );
          expect(response.headers.get("Retry-After")).toBe("30");
          const body = await response.text();
          if (method === "HEAD") expect(body).toBe("");
          else expect(body).toContain("ACCOUNT_STATUS_UNAVAILABLE");
        }
      }
    } finally {
      mock.mockRestore();
    }
  });
  it("keeps account-management and logout available while blocking already-issued console sessions", async () => {
    const s = await setup();
    const token = `egc_${"a".repeat(64)}`;
    s.sqlite
      .prepare("INSERT INTO console_sessions VALUES('project',?,?,?)")
      .run(
        await sha256Hex(s.cookie.split("=")[1]),
        await sha256Hex(token),
        Date.now() + 600_000,
      );
    const response = await worker.fetch(
      new Request(`${origin}/proxy/v1/offers`, {
        headers: {
          cookie: s.cookie,
          origin,
          "Sec-Fetch-Site": "same-origin",
          "X-Egdata-Console-Session": token,
        },
      }),
      s.env,
      s.ctx,
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("AGREEMENT_REQUIRED");
    expect((await s.call("/account")).status).toBe(200);
    expect((await s.call("/auth/logout", "POST")).status).toBe(200);
    expect((await s.call("/account")).status).toBe(401);
  });
  it("rolls back the whole closure if deleting the account fails", async () => {
    const s = await setup();
    s.sqlite.exec(
      "CREATE TRIGGER fail_closure BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT,'test closure failure'); END",
    );
    const response = await s.call("/account", "DELETE", {
      confirmation: "DELETE",
    });
    expect(response.status).toBe(500);
    expect(
      s.sqlite.prepare("SELECT COUNT(*) n FROM account_closures").get()!.n,
    ).toBe(0);
    expect(s.sqlite.prepare("SELECT COUNT(*) n FROM api_keys").get()!.n).toBe(
      1,
    );
  });
  it("requires fresh acceptance after re-registration and serves immutable public versions", async () => {
    const s = await setup();
    await s.verify();
    await s.accept();
    await Promise.all(s.work);
    await s.call("/account", "DELETE", { confirmation: "DELETE" });
    await Promise.all(s.work);
    expect(() =>
      s.sqlite.exec(
        "INSERT INTO users(epic_account_id,display_name) VALUES('owner','Owner')",
      ),
    ).toThrow("ACCOUNT_CLOSED");
    s.sqlite.exec(
      "DELETE FROM account_closures; INSERT INTO users(epic_account_id,display_name) VALUES('owner','Owner')",
    );
    // Simulate a fresh login after the tombstone/session lifetime has elapsed.
    await s.verify();
    expect(
      ((await (await s.call("/account")).json()) as DeveloperStatus).acceptedAt,
    ).toBeNull();
    expect(
      (
        (await (await s.call("/account/receipt")).json()) as {
          acceptances: unknown[];
        }
      ).acceptances,
    ).toHaveLength(0);
    expect((await s.accept()).status).toBe(200);
    expect(
      s.sqlite.prepare("SELECT COUNT(*) n FROM legal_acceptances").get()!.n,
    ).toBe(2);
    const document = await worker.fetch(
      new Request(`${origin}/terms/1.0`),
      s.env,
      s.ctx,
    );
    expect(document.status).toBe(200);
    expect(await sha256Hex(await document.text())).toBe(s.termsHash);
    expect(() =>
      s.sqlite.exec("UPDATE legal_documents SET body='changed'"),
    ).toThrow("LEGAL_DOCUMENT_IMMUTABLE");
    expect(() => s.sqlite.exec("DELETE FROM legal_documents")).toThrow(
      "LEGAL_DOCUMENT_IMMUTABLE",
    );
    await Promise.all(s.work);
  });
  it("requires recent authentication for deletion, revokes other sessions and warm/delayed caches, and keeps acceptance evidence", async () => {
    const s = await setup();
    await s.verify();
    await s.accept();
    await Promise.all(s.work);
    const meta = (await resolveApiKeyMetadata(s.env, s.ctx, s.hash))!;
    expect(
      (
        await s.call(
          "/account",
          "DELETE",
          { confirmation: "DELETE" },
          { cookie: await s.login("owner", Date.now() - 11 * 60_000) },
        )
      ).status,
    ).toBe(403);
    expect(
      (await s.call("/account", "DELETE", { confirmation: "DELETE" })).status,
    ).toBe(200);
    expect(
      s.sqlite
        .prepare("SELECT COUNT(*) n FROM users WHERE epic_account_id='owner'")
        .get()!.n,
    ).toBe(0);
    expect(s.sqlite.prepare("SELECT COUNT(*) n FROM api_keys").get()!.n).toBe(
      0,
    );
    expect(
      s.sqlite.prepare("SELECT retain_until FROM legal_acceptances").get()!
        .retain_until,
    ).toBeGreaterThan(Date.now());
    await syncKeyToKv(s.env, s.hash, meta); // stale in-flight cache write after closure
    expect(await resolveApiKeyMetadata(s.env, s.ctx, s.hash)).toBeNull();
    invalidateLocalKeyCache(s.hash);
    expect(await resolveApiKeyMetadata(s.env, s.ctx, s.hash)).toBeNull();
    expect((await s.call("/projects")).status).toBe(401);
    expect(
      ((await (await s.call("/auth/session")).json()) as SessionResponse)
        .authenticated,
    ).toBe(false);
    await Promise.all(s.work);
  });
});
