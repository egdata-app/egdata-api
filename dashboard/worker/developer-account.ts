import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { bytesToHex, sha256Hex } from "./crypto.js";
import { deliverDeveloperMail, sendDeveloperMail } from "./developer-mail.js";
import { reconcileMailEvents } from "./developer-mail-events.js";
import { listDeveloperReceipts } from "./developer-receipts.js";
import { developerStatus, type LegalDocument } from "./developer-status.js";
import {
  type AuthHonoEnv,
  clearDashboardSessionCookie,
  hasRecentDashboardSession,
  readDashboardSession,
} from "./epic-auth.js";
import { accountDataExport } from "./privacy-export.js";

export const developerAccount = new Hono<AuthHonoEnv>();
developerAccount.use(
  "/*",
  bodyLimit({
    maxSize: 4096,
    onError: (c) =>
      c.json(
        { error: { code: "BODY_TOO_LARGE", message: "Request too large." } },
        413,
      ),
  }),
);
developerAccount.use("/*", async (c, next) => {
  const user = await readDashboardSession(c);
  if (!user)
    return c.json(
      {
        error: {
          code: "UNAUTHORIZED",
          message: "Sign in to manage your account.",
        },
      },
      401,
    );
  c.set("user", user);
  await next();
});

developerAccount.get("/", async (c) =>
  c.json(await developerStatus(c.env, c.get("user").epicAccountId)),
);

developerAccount.get("/export", (c) =>
  accountDataExport(c.env.DB, c.get("user").epicAccountId),
);

developerAccount.post("/email", async (c) => {
  const parsed = z
    .object({ email: z.string().trim().email().max(254) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Enter a valid email address.",
        },
      },
      400,
    );
  const email = parsed.data.email;
  if (email.toLowerCase().endsWith("@accounts.epicgames.com"))
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message:
            "Use an inbox you can receive mail at, not the Epic sign-in placeholder.",
        },
      },
      400,
    );
  const owner = c.get("user").epicAccountId;
  const now = Date.now();
  const token = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await sha256Hex(token);
  const day = new Date(now).toISOString().slice(0, 10);
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO developer_profiles(owner_id) VALUES(?)",
  )
    .bind(owner)
    .run();
  const result =
    await c.env.DB.prepare(`UPDATE developer_profiles SET pending_email=?,token_hash=?,token_expires_at=?,last_sent_at=?,
    send_count=CASE WHEN send_day=? THEN send_count+1 ELSE 1 END,send_day=?
    WHERE owner_id=? AND last_sent_at<=? AND (send_day<>? OR send_count<5)`)
      .bind(
        email,
        hash,
        now + 30 * 60_000,
        now,
        day,
        day,
        owner,
        now - 60_000,
        day,
      )
      .run();
  if (!result.meta.changes)
    return c.json(
      {
        error: {
          code: "RATE_LIMITED",
          message:
            "Wait a minute before resending. Up to five verification emails are allowed per day.",
        },
      },
      429,
      { "Retry-After": "60" },
    );
  // Use a configured first-party origin, never a caller-supplied URL. Fragment tokens
  // are not sent in access logs/referrers; opening the link alone never verifies it.
  const origin = c.env.DASHBOARD_ORIGIN || new URL(c.req.url).origin;
  try {
    const mailId = `verification:${crypto.randomUUID()}`;
    // Track transport without persisting the plaintext verification token.
    // Verification is synchronous; only the authenticated resend flow may retry it.
    await c.env.DB.prepare(
      "INSERT INTO developer_mail(id,recipient,subject,body,created_at,attempts) VALUES(?,?,'Email verification','Verification content is not retained. Request a new code from Profile.',?,8)",
    )
      .bind(mailId, email, now)
      .run();
    const sent = await sendDeveloperMail(
      c.env,
      email,
      "Verify your egdata notification email",
      `Sign in to your egdata developer account and confirm this email:\n\n${origin}/#verify-email=${token}\n\nOr paste this verification code in your profile:\n${token}\n\nExpires in 30 minutes. This is not marketing consent. If you did not request it, ignore this message.`,
    );
    if (sent?.messageId) {
      await c.env.DB.prepare(
        "INSERT OR IGNORE INTO developer_mail_attempts(message_id,mail_id,dispatched_at) VALUES(?,?,?)",
      )
        .bind(sent.messageId, mailId, Date.now())
        .run();
      await reconcileMailEvents(c.env.DB, sent.messageId);
    }
    await c.env.DB.prepare("UPDATE developer_mail SET sent_at=? WHERE id=?")
      .bind(Date.now(), mailId)
      .run();
  } catch {
    await c.env.DB.prepare(
      "UPDATE developer_profiles SET token_hash=NULL,token_expires_at=NULL WHERE owner_id=? AND token_hash=?",
    )
      .bind(owner, hash)
      .run();
    return c.json(
      {
        error: {
          code: "EMAIL_DELIVERY_FAILED",
          message:
            "We could not send the verification email. Please retry later.",
        },
      },
      503,
    );
  }
  return c.json({ ok: true, pendingEmail: email });
});

developerAccount.post("/email/verify", async (c) => {
  const parsed = z
    .object({ token: z.string().regex(/^[a-f0-9]{64}$/) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json(
      {
        error: {
          code: "INVALID_VERIFICATION",
          message: "Enter the verification code from your email.",
        },
      },
      400,
    );
  const owner = c.get("user").epicAccountId;
  const hash = await sha256Hex(parsed.data.token);
  const now = Date.now();
  const id = crypto.randomUUID();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO developer_mail(id,recipient,subject,body,created_at)
      SELECT ?,contact_email,'Your egdata notification email changed',
      'Your developer notification address was replaced. If this was not you, contact contact@egdata.app.',?
      FROM developer_profiles WHERE owner_id=? AND token_hash=? AND token_expires_at>? AND contact_email IS NOT NULL AND contact_email<>pending_email`).bind(
      id,
      now,
      owner,
      hash,
      now,
    ),
    c.env.DB.prepare(`UPDATE developer_profiles SET contact_email=pending_email,verified_at=?,pending_email=NULL,token_hash=NULL,token_expires_at=NULL
      WHERE owner_id=? AND token_hash=? AND token_expires_at>?`).bind(
      now,
      owner,
      hash,
      now,
    ),
  ]);
  if (!results[1].meta.changes)
    return c.json(
      {
        error: {
          code: "INVALID_VERIFICATION",
          message:
            "This code expired, was replaced, or has already been used. Request a new email.",
        },
      },
      409,
    );
  c.executionCtx.waitUntil(deliverDeveloperMail(c.env));
  return c.json(await developerStatus(c.env, owner));
});

developerAccount.post("/agreements", async (c) => {
  const input = z
    .object({
      revision: z.string().max(100),
      version: z.string().max(100),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      accepted: z.literal(true),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!input.success)
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Explicit acceptance of the displayed terms is required.",
        },
      },
      400,
    );
  const owner = c.get("user").epicAccountId;
  const now = Date.now();
  const { revision, version, sha256 } = input.data;
  const receiptId = `rcpt_${crypto.randomUUID()}`;
  // Requirement and text are compared in the write itself, not just in an earlier read.
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`INSERT OR IGNORE INTO legal_acceptances(owner_id,version,edition,sha256,accepted_at,requirement_revision,receipt_id,privacy_version,privacy_sha256)
      SELECT ?,d.version,d.edition,d.sha256,?,r.revision,?,p.version,p.sha256 FROM legal_documents d JOIN legal_rollout r ON r.terms_version=d.version
      JOIN legal_documents p ON p.kind='privacy' AND p.version=r.privacy_version
      WHERE r.id=1 AND r.revision=? AND d.kind='terms' AND d.version=? AND d.sha256=?
      AND EXISTS(SELECT 1 FROM developer_profiles WHERE owner_id=? AND verified_at IS NOT NULL)`).bind(
      owner,
      now,
      receiptId,
      revision,
      version,
      sha256,
      owner,
    ),
    c.env.DB.prepare(`INSERT OR IGNORE INTO developer_mail(id,recipient,subject,body,created_at,receipt_id)
      SELECT 'acceptance:'||a.owner_id||':'||a.version||':'||a.accepted_at,p.contact_email,'Your egdata terms and privacy receipt',
      'Your developer agreement receipt is ready.',?,a.receipt_id
      FROM legal_acceptances a JOIN developer_profiles p ON p.owner_id=a.owner_id
      JOIN legal_documents d ON d.kind='terms' AND d.version=a.version
      WHERE a.owner_id=? AND a.version=? AND a.sha256=? AND a.retain_until IS NULL AND p.verified_at IS NOT NULL AND a.receipt_id=?`).bind(
      now,
      owner,
      version,
      sha256,
      receiptId,
    ),
  ]);
  const status = await developerStatus(c.env, owner);
  if (!status.verifiedAt)
    return c.json(
      {
        error: {
          code: "EMAIL_VERIFICATION_REQUIRED",
          message: "Verify your notification email first.",
        },
      },
      403,
    );
  if (
    !status.eligible ||
    status.revision !== revision ||
    status.terms?.version !== version ||
    status.terms.sha256 !== sha256
  )
    return c.json(
      {
        error: {
          code: "AGREEMENT_CHANGED",
          message:
            "The required terms changed. Review the current version before accepting.",
        },
      },
      409,
    );
  if (results[0].meta.changes)
    c.executionCtx.waitUntil(deliverDeveloperMail(c.env));
  return c.json(status);
});

developerAccount.get("/receipt", async (c) => {
  const acceptances = await listDeveloperReceipts(
    c.env.DB,
    c.get("user").epicAccountId,
  );
  return new Response(JSON.stringify({ acceptances }, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": 'attachment; filename="egdata-acceptances.json"',
      "Cache-Control": "no-store",
    },
  });
});

developerAccount.delete("/", async (c) => {
  const body = await c.req.json<{ confirmation?: string }>().catch(() => null);
  if (body?.confirmation !== "DELETE")
    return c.json(
      {
        error: {
          code: "CONFIRMATION_REQUIRED",
          message: "Type DELETE to confirm account deletion.",
        },
      },
      400,
    );
  if (!(await hasRecentDashboardSession(c)))
    return c.json(
      {
        error: {
          code: "REAUTHENTICATION_REQUIRED",
          message: "Sign in again before deleting your account.",
        },
      },
      403,
    );
  const owner = c.get("user").epicAccountId;
  const now = Date.now();
  // The closure tombstone invalidates every login and warm key cache immediately.
  // It lives beyond both session (7d) and credential-cache (5m) lifetimes.
  const projectIds = "SELECT id FROM projects WHERE owner_epic_id=?";
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO account_closures(owner_id,closed_at,purge_after) VALUES(?,?,?)",
    ).bind(owner, now, now + 30 * 86_400_000),
    c.env.DB.prepare(
      "INSERT INTO developer_mail(id,recipient,subject,body,created_at) SELECT ?,contact_email,'Your egdata account was closed','Your account and active credentials have been deleted. Some legal evidence, security records, analytics, and backups may remain under the Privacy Notice. Contact contact@egdata.app for a data-protection request.',? FROM developer_profiles WHERE owner_id=? AND contact_email IS NOT NULL",
    ).bind(crypto.randomUUID(), now, owner),
    ...[
      "alert_matches",
      "project_alerts",
      "alert_reads",
      "usage_daily",
      "console_sessions",
    ].map((table) =>
      c.env.DB.prepare(
        `DELETE FROM ${table} WHERE project_id IN (${projectIds})`,
      ).bind(owner),
    ),
    c.env.DB.prepare(
      "DELETE FROM usage_dead_letters WHERE key_id IN (SELECT id FROM api_keys WHERE owner_epic_id=?)",
    ).bind(owner),
    c.env.DB.prepare(
      "UPDATE legal_acceptances SET retain_until=? WHERE owner_id=? AND retain_until IS NULL",
    ).bind(now + 5 * 365.25 * 86_400_000, owner),
    c.env.DB.prepare("DELETE FROM users WHERE epic_account_id=?").bind(owner),
  ]);
  clearDashboardSessionCookie(c);
  c.executionCtx.waitUntil(deliverDeveloperMail(c.env));
  return c.json({
    ok: true,
    message:
      "Account closed. Active account records and credentials deleted; other records follow the Privacy Notice.",
  });
});

/** Public immutable legal text. Never serve repository drafts as published terms. */
export async function publicLegalHistory(db: D1Database) {
  const { results } = await db
    .prepare(`SELECT d.kind,d.version,d.edition,d.sha256,d.published_at,
    CASE WHEN (d.kind='terms' AND d.version=r.terms_version) OR (d.kind='privacy' AND d.version=r.privacy_version) THEN 1 ELSE 0 END AS current
    FROM legal_documents d LEFT JOIN legal_rollout r ON r.id=1 ORDER BY d.published_at DESC,d.kind,d.version`)
    .all();
  return Response.json(
    { documents: results },
    {
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

export async function publicLegalDocument(
  db: D1Database,
  kind: "terms" | "privacy",
  version?: string,
) {
  const document = version
    ? await db
        .prepare("SELECT * FROM legal_documents WHERE kind=? AND version=?")
        .bind(kind, version)
        .first<LegalDocument>()
    : await db
        .prepare(
          `SELECT d.* FROM legal_documents d JOIN legal_rollout r ON d.version=${kind === "terms" ? "r.terms_version" : "r.privacy_version"} WHERE r.id=1 AND d.kind=?`,
        )
        .bind(kind)
        .first<LegalDocument>();
  return new Response(
    document?.body ?? "This document has not been published yet.",
    {
      status: document ? 200 : 404,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
