import { type Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { bytesToHex, sha256Hex } from "./crypto.js";
import { developerStatus } from "./developer-status.js";
import {
  type AuthHonoEnv,
  readDashboardSession,
  requireDashboardUser,
} from "./epic-auth.js";
import {
  API_SCOPES,
  type ApiKeyTier,
  type CachedKeyMetadata,
} from "./types.js";
import { edgeProblem } from "./upstream.js";
import { handleV1ApiProxy } from "./v1.js";

export const CONSOLE_HEADER = "X-Egdata-Console-Session";
export const CONSOLE_TTL_MS = 10 * 60 * 1000;

function isDashboardRequest(c: Context<AuthHonoEnv>) {
  const origin = new URL(c.req.url).origin;
  return (
    origin === c.env.DASHBOARD_ORIGIN &&
    c.req.header("Sec-Fetch-Site") === "same-origin" &&
    (!c.req.header("Origin") || c.req.header("Origin") === origin)
  );
}

async function sessionHash(c: Context<AuthHonoEnv>) {
  const cookie = getCookie(c, "egdata_dash_session");
  return cookie ? sha256Hex(cookie) : null;
}

export async function revokeConsoleLogin(c: Context<AuthHonoEnv>) {
  const hash = await sessionHash(c);
  if (hash)
    await c.env.DB.prepare(
      "DELETE FROM console_sessions WHERE dashboard_session_hash = ?",
    )
      .bind(hash)
      .run();
}

export const consoleSessionRoutes = new Hono<AuthHonoEnv>();
consoleSessionRoutes.use("/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (
    !isDashboardRequest(c) ||
    c.req.header("Origin") !== new URL(c.req.url).origin
  ) {
    return c.json(
      { error: { message: "Use the signed-in API console." } },
      403,
    );
  }
  return requireDashboardUser(c, next);
});

consoleSessionRoutes.post("/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  const project = await c.env.DB.prepare(
    "SELECT id FROM projects WHERE id = ? AND owner_epic_id = ? AND deleted_at IS NULL",
  )
    .bind(projectId, c.get("user").epicAccountId)
    .first();
  if (!project)
    return c.json({ error: { message: "Project not found." } }, 404);
  const hash = await sessionHash(c);
  if (!hash) return c.json({ error: { message: "Sign in again." } }, 401);
  const token = `egc_${bytesToHex(crypto.getRandomValues(new Uint8Array(32)))}`;
  const expiresAt = Date.now() + CONSOLE_TTL_MS;
  await c.env.DB.prepare(`INSERT INTO console_sessions(project_id,dashboard_session_hash,token_hash,expires_at)
    VALUES(?,?,?,?) ON CONFLICT(project_id,dashboard_session_hash)
    DO UPDATE SET token_hash=excluded.token_hash, expires_at=excluded.expires_at`)
    .bind(projectId, hash, await sha256Hex(token), expiresAt)
    .run();
  return c.json({ token, expiresAt, projectId }, 201);
});

consoleSessionRoutes.delete("/:projectId", async (c) => {
  const body = await c.req.json<{ token?: string }>().catch(() => null);
  if (!body?.token || !/^egc_[a-f0-9]{64}$/.test(body.token)) {
    return c.json({ error: { message: "Console token required." } }, 400);
  }
  const hash = await sessionHash(c);
  await c.env.DB.prepare(`DELETE FROM console_sessions WHERE project_id=? AND dashboard_session_hash=?
    AND token_hash=?
    AND project_id IN (SELECT id FROM projects WHERE owner_epic_id=?)`)
    .bind(
      c.req.param("projectId"),
      hash,
      await sha256Hex(body.token),
      c.get("user").epicAccountId,
    )
    .run();
  return c.json({ ok: true });
});

/** Only this authenticated dashboard path can supply trusted console identity. */
export const consoleProxy = new Hono<AuthHonoEnv>();
consoleProxy.all("/*", async (c) => {
  const fail = (status: number, code: string, detail: string) =>
    edgeProblem(c.req.raw, status, code, detail);
  if (
    !isDashboardRequest(c) ||
    !new URL(c.req.url).pathname.startsWith("/proxy/v1/")
  ) {
    return fail(
      403,
      "CONSOLE_ONLY",
      "Console sessions are restricted to the dashboard v1 console.",
    );
  }
  if (c.req.header("X-API-Key") || c.req.header("Authorization")) {
    return fail(
      401,
      "CONFLICTING_CREDENTIALS",
      "Choose either a console session or an API key.",
    );
  }
  const token = c.req.header(CONSOLE_HEADER) ?? "";
  if (!/^egc_[a-f0-9]{64}$/.test(token))
    return fail(401, "INVALID_CONSOLE_SESSION", "Start a new console session.");
  const user = await readDashboardSession(c);
  if (!user)
    return fail(
      401,
      "CONSOLE_SIGN_IN_REQUIRED",
      "Sign in to use the API console.",
    );
  try {
    const status = await developerStatus(c.env, user.epicAccountId);
    if (!status.eligible)
      return fail(
        403,
        status.acceptedAt
          ? "EMAIL_VERIFICATION_REQUIRED"
          : "AGREEMENT_REQUIRED",
        "Complete onboarding in the developer portal. Existing API keys keep working.",
      );
  } catch {
    return fail(
      503,
      "LEGAL_STATUS_UNAVAILABLE",
      "Account status is temporarily unavailable.",
    );
  }
  const hash = await sessionHash(c);
  const row =
    await c.env.DB.prepare(`SELECT p.id, p.tier, p.custom_rpm, s.expires_at FROM console_sessions s
    JOIN projects p ON p.id=s.project_id
    WHERE s.token_hash=? AND s.dashboard_session_hash=? AND p.owner_epic_id=? AND s.expires_at>? AND p.deleted_at IS NULL`)
      .bind(await sha256Hex(token), hash, user.epicAccountId, Date.now())
      .first<{
        id: string;
        tier: ApiKeyTier;
        custom_rpm: number | null;
        expires_at: number;
      }>();
  if (!row)
    return fail(
      401,
      "INVALID_CONSOLE_SESSION",
      "Console session expired or ended. Start a new session.",
    );
  const meta: CachedKeyMetadata = {
    keyId: `console_${row.id}`,
    projectId: row.id,
    ownerEpicId: user.epicAccountId,
    name: "API console",
    tier: row.tier,
    active: true,
    scopes: [...API_SCOPES],
    allowedIps: [],
    allowedOrigins: [],
    allowedPaths: [],
    allowedMethods: ["GET", "HEAD", "POST"],
    customRpm: row.custom_rpm,
    expiresAt: new Date(row.expires_at).toISOString(),
  };
  // The stable project identity shares quotas and durable usage across renewals/tabs/logins.
  // Hono's context declaration predates the optional Workers exports property;
  // this is the original runtime context supplied by the Worker fetch handler.
  return handleV1ApiProxy(
    c.req.raw,
    c.env,
    c.executionCtx as ExecutionContext,
    new URL(c.req.url).pathname.slice(6),
    meta,
  );
});
