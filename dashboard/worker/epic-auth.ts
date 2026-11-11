import type { Context, Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { bytesToHex, signHmacToken, verifyHmacToken } from "./crypto.js";
import { upsertEpicUserAndDefaultProject } from "./db.js";
import type { DashboardEnv, EpicSessionUser } from "./types.js";

const SESSION_COOKIE_NAME = "egdata_dash_session";
const OAUTH_STATE_COOKIE_NAME = "egdata_epic_oauth_state";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

const EPIC_AUTHORIZE_URL = "https://www.epicgames.com/id/authorize";
const EPIC_TOKEN_URL = "https://api.epicgames.dev/epic/oauth/v2/token";
const EPIC_USERINFO_URL = "https://api.epicgames.dev/epic/oauth/v2/userInfo";
const EPIC_ACCOUNTS_URL = "https://api.epicgames.dev/epic/id/v2/accounts";

interface SignedSessionPayload {
  user: EpicSessionUser;
  iat: number;
  exp: number;
}

interface SignedOAuthState {
  nonce: string;
  redirectTo: string;
  exp: number;
}

function getSessionSecret(env: DashboardEnv): string {
  if (
    env.DASHBOARD_SESSION_SECRET &&
    env.DASHBOARD_SESSION_SECRET.length >= 16
  ) {
    return env.DASHBOARD_SESSION_SECRET;
  }
  return "egdata-local-dev-session-secret-change-in-prod-32b";
}

function isLocalUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

export function defaultEpicAvatar(displayName: string): string {
  const initial = (displayName.trim()[0] || "E").toUpperCase();
  return `https://shared-static-prod.epicgames.com/epic-profile-icon/D8033C/${encodeURIComponent(initial)}/icon.png?size=512`;
}

export type AuthHonoEnv = {
  Bindings: DashboardEnv;
  Variables: {
    user: EpicSessionUser;
  };
};

export async function readDashboardSession(
  c: Context<AuthHonoEnv>,
): Promise<EpicSessionUser | null> {
  const secret = getSessionSecret(c.env);
  const rawToken = getCookie(c, SESSION_COOKIE_NAME);
  if (!rawToken) return null;

  const parsed = await verifyHmacToken<SignedSessionPayload>(rawToken, secret);
  if (!parsed || !parsed.user || Date.now() >= parsed.exp) {
    return null;
  }
  return parsed.user;
}

export async function issueDashboardSessionCookie(
  c: Context<AuthHonoEnv>,
  user: EpicSessionUser,
): Promise<void> {
  const secret = getSessionSecret(c.env);
  const now = Date.now();
  const token = await signHmacToken(
    {
      user,
      iat: now,
      exp: now + SESSION_TTL_SECONDS * 1000,
    } satisfies SignedSessionPayload,
    secret,
  );

  const secure = !isLocalUrl(c.req.url);
  setCookie(c, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearDashboardSessionCookie(c: Context<AuthHonoEnv>): void {
  const secure = !isLocalUrl(c.req.url);
  deleteCookie(c, SESSION_COOKIE_NAME, {
    path: "/",
    secure,
  });
}

export async function requireDashboardUser(
  c: Context<AuthHonoEnv>,
  next: Next,
) {
  const user = await readDashboardSession(c);
  if (!user) {
    return c.json(
      {
        error: {
          code: "UNAUTHORIZED",
          message: "Sign in with your Epic Games account.",
        },
      },
      401,
      { "Cache-Control": "no-store" },
    );
  }
  c.set("user", user);
  await next();
}

export async function startEpicOAuthRedirect(
  c: Context<AuthHonoEnv>,
): Promise<Response> {
  const reqUrl = new URL(c.req.url);
  const redirectTo = reqUrl.searchParams.get("redirect") || "/";
  const safeRedirect =
    redirectTo.startsWith("/") && !redirectTo.startsWith("//")
      ? redirectTo
      : "/";

  // Support frictionless local dev sign-in if EPIC_CLIENT_ID is not configured on localhost
  const clientId = c.env.EPIC_CLIENT_ID;
  const clientSecret = c.env.EPIC_CLIENT_SECRET;
  if (
    (!clientId || !clientSecret) &&
    (isLocalUrl(c.req.url) || c.env.ENABLE_DEV_AUTH === "true")
  ) {
    const demoName = reqUrl.searchParams.get("name")?.trim() || "EpicDeveloper";
    const demoUser: EpicSessionUser = {
      epicAccountId: "epic_dev_7da0b3179a5b5ef4f1a2d118",
      displayName: demoName,
      avatarUrl: defaultEpicAvatar(demoName),
      preferredLanguage: "en",
      email: "epic_dev_7da0b3179a5b5ef4f1a2d118@accounts.epicgames.com",
    };
    await upsertEpicUserAndDefaultProject(c.env.DB, demoUser);
    await issueDashboardSessionCookie(c, demoUser);
    return c.redirect(safeRedirect, 302);
  }

  if (!clientId || !clientSecret) {
    return c.json(
      {
        error: {
          code: "OAUTH_NOT_CONFIGURED",
          message:
            "EPIC_CLIENT_ID and EPIC_CLIENT_SECRET must be configured via `wrangler secret put`.",
        },
      },
      503,
      { "Cache-Control": "no-store" },
    );
  }

  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const stateToken = await signHmacToken(
    {
      nonce,
      redirectTo: safeRedirect,
      exp: Date.now() + 10 * 60 * 1000,
    } satisfies SignedOAuthState,
    getSessionSecret(c.env),
  );

  const secure = !isLocalUrl(c.req.url);
  setCookie(c, OAUTH_STATE_COOKIE_NAME, stateToken, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });

  const callbackUri = `${reqUrl.origin}/_dashboard/api/auth/epic/callback`;
  const authorize = new URL(EPIC_AUTHORIZE_URL);
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "basic_profile");
  authorize.searchParams.set("redirect_uri", callbackUri);
  authorize.searchParams.set("state", nonce);

  return c.redirect(authorize.toString(), 302);
}

export async function handleEpicOAuthCallback(
  c: Context<AuthHonoEnv>,
): Promise<Response> {
  const reqUrl = new URL(c.req.url);
  const code = reqUrl.searchParams.get("code");
  const stateParam = reqUrl.searchParams.get("state");
  const errorParam = reqUrl.searchParams.get("error");

  if (errorParam) {
    return c.redirect(`/?auth_error=${encodeURIComponent(errorParam)}`, 302);
  }

  const stateCookie = getCookie(c, OAUTH_STATE_COOKIE_NAME);
  deleteCookie(c, OAUTH_STATE_COOKIE_NAME, { path: "/" });

  if (!code || !stateParam || !stateCookie) {
    return c.redirect("/?auth_error=invalid_oauth_state", 302);
  }

  const verifiedState = await verifyHmacToken<SignedOAuthState>(
    stateCookie,
    getSessionSecret(c.env),
  );
  if (
    !verifiedState ||
    verifiedState.nonce !== stateParam ||
    Date.now() >= verifiedState.exp
  ) {
    return c.redirect("/?auth_error=expired_oauth_state", 302);
  }

  const clientId = c.env.EPIC_CLIENT_ID;
  const clientSecret = c.env.EPIC_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return c.redirect("/?auth_error=oauth_not_configured", 302);
  }

  // Matches egdata-app/egdata `/api/token` implementation: HTTP Basic Auth + form-urlencoded
  const basicAuth = btoa(`${clientId}:${clientSecret}`);
  const tokenParams = new URLSearchParams();
  tokenParams.set("grant_type", "authorization_code");
  tokenParams.set("code", code);
  tokenParams.set("scope", "basic_profile");

  const tokenRes = await fetch(EPIC_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: tokenParams,
  });

  if (!tokenRes.ok) {
    console.error("Epic OAuth token exchange failed:", tokenRes.status);
    return c.redirect("/?auth_error=token_exchange_failed", 302);
  }

  const tokenData = (await tokenRes.json()) as {
    access_token: string;
    account_id?: string;
  };

  // Fetch Epic user profile (matches egdata-app/egdata userInfo + accounts enrichment)
  const userInfoRes = await fetch(EPIC_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
    },
  });

  if (!userInfoRes.ok) {
    console.error("Epic userInfo failed:", userInfoRes.status);
    return c.redirect("/?auth_error=userinfo_failed", 302);
  }

  const userInfo = (await userInfoRes.json()) as {
    sub: string;
    preferred_username?: string;
  };

  let preferredLanguage = "en";
  let displayName =
    userInfo.preferred_username || tokenData.account_id || userInfo.sub;

  try {
    const accountsRes = await fetch(
      `${EPIC_ACCOUNTS_URL}?accountId=${encodeURIComponent(userInfo.sub)}`,
      {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
        },
      },
    );
    if (accountsRes.ok) {
      const accounts = (await accountsRes.json()) as Array<{
        accountId: string;
        displayName?: string;
        preferredLanguage?: string;
      }>;
      if (accounts[0]?.displayName) {
        displayName = accounts[0].displayName;
      }
      if (accounts[0]?.preferredLanguage) {
        preferredLanguage = accounts[0].preferredLanguage;
      }
    }
  } catch {
    // Non-fatal profile enrichment
  }

  const sessionUser: EpicSessionUser = {
    epicAccountId: userInfo.sub,
    displayName,
    avatarUrl: defaultEpicAvatar(displayName),
    preferredLanguage,
    email: `${userInfo.sub}@accounts.epicgames.com`,
  };

  await upsertEpicUserAndDefaultProject(c.env.DB, sessionUser);
  await issueDashboardSessionCookie(c, sessionUser);

  return c.redirect(verifiedState.redirectTo || "/", 302);
}
