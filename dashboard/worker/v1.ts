import { recordApiTelemetry } from "./analytics.js";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  sha256Hex,
  timingSafeStringEqual,
} from "./crypto.js";
import { touchApiKeyLastUsed } from "./db.js";
import { fetchV1WithEdgeCache } from "./edge-cache.js";
import { ingestUsage } from "./endpoint-alerts.js";
import { resolveCommercialLimitsEnabled } from "./flags.js";
import { resolveApiKeyMetadata } from "./key-cache.js";
import { computeIpSubnet, evaluateKeyPermissions } from "./permissions.js";
import { evaluatePlanEntitlement } from "./plans.js";
import {
  admitProjectRequest,
  creditAdmittedRequestUsage,
  DAILY_POLICY_NAME,
  MONTHLY_POLICY_NAME,
  PERIOD_POLICY_NAME,
  rateLimitHeaders,
  resolveEffectiveProjectEntitlement,
} from "./project-quota.js";
import type { AdmissionResult } from "./rate-limiter-core.js";
import {
  API_SCOPES,
  type CachedKeyMetadata,
  type DashboardEnv,
} from "./types.js";
import {
  type CfProperties,
  edgeProblem,
  forwardToUpstream,
} from "./upstream.js";
import {
  allowedMethodsForV1Path,
  canonicalV1Path,
  expensivePolicyLimitForProject,
  isKnownV1Path,
  PUBLIC_V1_PATHS,
  resolveExpensivePeriodPolicyName,
  resolveV1Route,
} from "./v1-routes.js";

export { computeIpSubnet } from "./permissions.js";

export interface WebEphemeralPayload {
  exp: number;
  subnet: string;
}

export type WebEphemeralTokenResult =
  | {
      ok: true;
      payload: WebEphemeralPayload;
    }
  | {
      ok: false;
      status: number;
      code: string;
      detail: string;
    };

export async function signWebEphemeralToken(
  payload: WebEphemeralPayload,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const payloadB64 = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payloadB64),
  );
  const sigB64 = bytesToBase64Url(new Uint8Array(signature));
  return `egw_${payloadB64}.${sigB64}`;
}

let cachedWebOwnerEpicId: string | null = null;

export interface WebBrowserKeyState {
  revoked: boolean;
  active: boolean;
  expiresAt: string | null;
  ownerEpicId: string | null;
}

let cachedWebBrowserKeyState: {
  state: WebBrowserKeyState;
  expiresAt: number;
} | null = null;

export function clearWebOwnerEpicIdCache(): void {
  cachedWebOwnerEpicId = null;
  cachedWebBrowserKeyState = null;
}

export async function resolveWebBrowserKeyState(
  env: DashboardEnv,
  webKeyId: string,
): Promise<WebBrowserKeyState> {
  const now = Date.now();
  if (cachedWebBrowserKeyState && cachedWebBrowserKeyState.expiresAt > now) {
    return cachedWebBrowserKeyState.state;
  }

  // 1. Check API_KEYS_KV
  if (env.API_KEYS_KV) {
    try {
      const fromKv = await env.API_KEYS_KV.get<
        CachedKeyMetadata & { cacheExpiresAt?: number }
      >("apikey:system_ephemeral_browser_key_hash", {
        type: "json",
        cacheTtl: 60,
      });
      if (
        fromKv &&
        typeof fromKv.cacheExpiresAt === "number" &&
        fromKv.cacheExpiresAt > now
      ) {
        const state: WebBrowserKeyState = {
          active: fromKv.active,
          expiresAt: fromKv.expiresAt ?? null,
          revoked: false,
          ownerEpicId: fromKv.ownerEpicId ?? null,
        };
        cachedWebBrowserKeyState = {
          state,
          expiresAt: Math.min(now + 30_000, fromKv.cacheExpiresAt),
        };
        return state;
      }
    } catch {
      // KV lookup failure, fall through to D1
    }
  }

  // 2. Query D1
  if (env.DB) {
    try {
      const row = await env.DB.prepare(
        `SELECT k.active, k.revoked_at, k.expires_at, k.owner_epic_id, p.deleted_at
         FROM api_keys k
         LEFT JOIN projects p ON p.id = k.project_id
         WHERE k.id = ?
         LIMIT 1`,
      )
        .bind(webKeyId)
        .first<{
          active: number | boolean;
          revoked_at: string | number | null;
          expires_at: string | null;
          owner_epic_id: string | null;
          deleted_at: string | number | null;
        }>();

      if (row) {
        const isRevoked = row.revoked_at !== null || row.deleted_at !== null;
        const state: WebBrowserKeyState = {
          revoked: isRevoked,
          active: isRevoked ? false : Boolean(row.active),
          expiresAt: row.expires_at ?? null,
          ownerEpicId: row.owner_epic_id ?? null,
        };
        cachedWebBrowserKeyState = {
          state,
          expiresAt: now + 30_000,
        };
        return state;
      }
    } catch {
      // D1 query error, fall through to default
    }
  }

  const defaultState: WebBrowserKeyState = {
    revoked: false,
    active: true,
    expiresAt: null,
    ownerEpicId: null,
  };
  cachedWebBrowserKeyState = {
    state: defaultState,
    expiresAt: now + 30_000,
  };
  return defaultState;
}

export async function resolveWebOwnerEpicId(
  env: DashboardEnv,
): Promise<string> {
  if (env.WEB_OWNER_EPIC_ID) {
    return env.WEB_OWNER_EPIC_ID;
  }
  if (cachedWebOwnerEpicId) {
    return cachedWebOwnerEpicId;
  }
  try {
    const row = await env.DB.prepare(
      "SELECT owner_epic_id FROM projects WHERE id = ? LIMIT 1",
    )
      .bind(env.WEB_PROJECT_ID || "prj_egdata_web")
      .first<{ owner_epic_id: string }>();
    if (row?.owner_epic_id) {
      cachedWebOwnerEpicId = row.owner_epic_id;
      return cachedWebOwnerEpicId;
    }
  } catch {
    // D1 unavailable
  }
  return "egdata_web_owner";
}

export function isAllowedWebTokenOrigin(
  origin: string | null,
  env: DashboardEnv,
): { allowed: boolean; isLocalhost: boolean } {
  if (!origin) return { allowed: false, isLocalhost: false };
  const trimmed = origin.trim();
  if (trimmed === "https://egdata.app") {
    return { allowed: true, isLocalhost: false };
  }
  if (env.ALLOW_FIRST_PARTY_ORIGINS) {
    const list = env.ALLOW_FIRST_PARTY_ORIGINS.split(",").map((s) => s.trim());
    if (list.includes(trimmed)) {
      return { allowed: true, isLocalhost: false };
    }
  }
  const isLocalhost = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(
    trimmed,
  );
  if (isLocalhost) {
    return { allowed: true, isLocalhost: true };
  }
  return { allowed: false, isLocalhost: false };
}

export async function verifyWebEphemeralToken(
  request: Request,
  rawKey: string,
  clientIp: string | null,
  env: DashboardEnv,
): Promise<WebEphemeralTokenResult> {
  if (!rawKey.startsWith("egw_")) {
    return {
      ok: false,
      status: 401,
      code: "INVALID_WEB_TOKEN",
      detail: "The web ephemeral token format is invalid.",
    };
  }

  // Enforce Origin and Sec-Fetch-Site
  const origin = request.headers.get("origin");
  const originCheck = isAllowedWebTokenOrigin(origin, env);
  const secFetchSite = request.headers
    .get("sec-fetch-site")
    ?.trim()
    .toLowerCase();
  const validSite =
    secFetchSite === "same-site" ||
    (originCheck.isLocalhost && secFetchSite === "same-origin");

  if (!originCheck.allowed || !validSite) {
    return {
      ok: false,
      status: 403,
      code: "FORBIDDEN_ORIGIN",
      detail:
        "Web ephemeral tokens require Origin https://egdata.app and Sec-Fetch-Site: same-site.",
    };
  }

  // Verify HMAC-SHA256 signature
  const secret = env.WEB_EPHEMERAL_KEY_SECRET;
  if (!secret || secret.length < 32) {
    return {
      ok: false,
      status: 401,
      code: "INVALID_WEB_TOKEN",
      detail: "Web ephemeral token verification is not configured.",
    };
  }

  const signedToken = rawKey.slice(4);
  const dotIndex = signedToken.indexOf(".");
  if (dotIndex <= 0 || dotIndex === signedToken.length - 1) {
    return {
      ok: false,
      status: 401,
      code: "INVALID_WEB_TOKEN",
      detail: "The web ephemeral token format is invalid.",
    };
  }

  const payloadB64 = signedToken.slice(0, dotIndex);
  const sigB64 = signedToken.slice(dotIndex + 1);
  if (sigB64.includes(".")) {
    return {
      ok: false,
      status: 401,
      code: "INVALID_WEB_TOKEN",
      detail: "The web ephemeral token format is invalid.",
    };
  }

  const encoder = new TextEncoder();
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const expectedSigBytes = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(payloadB64),
    );
    const expectedSigB64 = bytesToBase64Url(new Uint8Array(expectedSigBytes));
    const valid = await timingSafeStringEqual(sigB64, expectedSigB64);
    if (!valid) {
      return {
        ok: false,
        status: 401,
        code: "INVALID_WEB_TOKEN",
        detail: "The web ephemeral token signature is invalid.",
      };
    }
  } catch {
    return {
      ok: false,
      status: 401,
      code: "INVALID_WEB_TOKEN",
      detail: "The web ephemeral token signature is invalid.",
    };
  }

  let payload: { exp?: unknown; subnet?: unknown };
  try {
    const decodedText = new TextDecoder().decode(base64UrlToBytes(payloadB64));
    payload = JSON.parse(decodedText);
  } catch {
    return {
      ok: false,
      status: 401,
      code: "INVALID_WEB_TOKEN",
      detail: "The web ephemeral token payload is malformed.",
    };
  }

  if (typeof payload?.exp !== "number" || typeof payload?.subnet !== "string") {
    return {
      ok: false,
      status: 401,
      code: "INVALID_WEB_TOKEN",
      detail: "The web ephemeral token payload is invalid.",
    };
  }

  const expMs = payload.exp < 1e12 ? payload.exp * 1000 : payload.exp;
  if (expMs <= Date.now()) {
    return {
      ok: false,
      status: 401,
      code: "EXPIRED_WEB_TOKEN",
      detail: "The web ephemeral token has expired.",
    };
  }

  const expectedSubnet = computeIpSubnet(clientIp);
  if (payload.subnet !== expectedSubnet) {
    return {
      ok: false,
      status: 401,
      code: "INVALID_WEB_TOKEN",
      detail: "The web ephemeral token IP subnet does not match the client IP.",
    };
  }

  return {
    ok: true,
    payload: {
      exp: expMs,
      subnet: payload.subnet,
    },
  };
}

const lastUsedTouchDebounce = new Map<string, number>();

type V1ProblemOptions = {
  requestId: string;
  status: number;
  code: string;
  detail: string;
  headers?: Record<string, string>;
};

function v1Problem(request: Request, options: V1ProblemOptions): Response {
  const response = edgeProblem(
    request,
    options.status,
    options.code,
    options.detail,
    options.requestId,
  );
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    response.headers.set(name, value);
  }
  return response;
}

function corsFor(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Expose-Headers":
      "ETag, X-Request-Id, Retry-After, RateLimit, RateLimit-Policy, X-RateLimit-Policy, X-Egdata-Key-Tier",
    Vary: "Origin",
  };
}

function applyCors(headers: Headers, request: Request): void {
  const cors = corsFor(request);
  for (const [name, value] of Object.entries(cors)) {
    if (name === "Vary") continue;
    headers.set(name, value);
  }
  if (!cors.Vary) return;
  const existing = headers.get("Vary");
  if (!existing) {
    headers.set("Vary", "Origin");
  } else if (!/(?:^|,)\s*Origin\s*(?:,|$)/i.test(existing)) {
    headers.set("Vary", `${existing}, Origin`);
  }
}

function requestIdFor(): string {
  return `req_${crypto.randomUUID().replaceAll("-", "")}`;
}

function extractCredentials(request: Request): {
  rawKey: string | null;
  authorizationPresent: boolean;
  conflict: boolean;
  malformedAuthorization: boolean;
} {
  const headerKey = request.headers.get("x-api-key")?.trim() || null;
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const authorizationPresent = authorization.length > 0;
  let bearerKey: string | null = null;
  let malformedAuthorization = false;

  if (authorizationPresent) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    if (!match?.[1]?.trim()) {
      malformedAuthorization = true;
    } else {
      bearerKey = match[1].trim();
    }
  }

  if (headerKey && bearerKey && headerKey !== bearerKey) {
    return {
      rawKey: null,
      authorizationPresent,
      conflict: true,
      malformedAuthorization,
    };
  }

  return {
    rawKey: headerKey ?? bearerKey,
    authorizationPresent,
    conflict: false,
    malformedAuthorization,
  };
}

function parsedContentLength(headers: Headers): number {
  const raw = headers.get("content-length");
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function baseTelemetry(
  request: Request,
  meta: { ownerEpicId: string; keyId: string; projectId: string },
  options: {
    routeTemplate: string;
    statusCode: number;
    cacheStatus: string;
    limitOutcome: string;
    startedAt: number;
    country: string;
    clientIp: string | null;
    userAgent: string;
    operationId?: string;
    policyFamily?: string;
    errorCode?: string;
    upstreamLatencyMs?: number;
    responseBytes?: number;
  },
) {
  return {
    ownerEpicId: meta.ownerEpicId,
    keyId: meta.keyId,
    projectId: meta.projectId,
    routeTemplate: options.routeTemplate,
    method: request.method,
    statusCode: options.statusCode,
    cacheStatus: options.cacheStatus,
    limitOutcome: options.limitOutcome,
    origin: request.headers.get("origin") ?? "(direct)",
    clientIp: options.clientIp ?? "unknown",
    userAgent: options.userAgent,
    country: options.country,
    latencyMs: performance.now() - options.startedAt,
    operationId: options.operationId,
    policyFamily: options.policyFamily,
    errorCode: options.errorCode,
    upstreamLatencyMs: options.upstreamLatencyMs,
    responseBytes: options.responseBytes,
  };
}

export async function handleV1ApiProxy(
  request: Request,
  env: DashboardEnv,
  ctx: ExecutionContext,
  rawPathname: string,
  consoleIdentity?: CachedKeyMetadata,
): Promise<Response> {
  const startedAt = performance.now();
  const requestId = requestIdFor();
  const reqUrl = new URL(request.url);
  const pathname = canonicalV1Path(rawPathname);

  const cfProps = (request as Request & { cf?: CfProperties }).cf;
  const country = cfProps?.country || "XX";
  const clientIp =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null;
  const userAgent = request.headers.get("user-agent") || "";

  if (!pathname) {
    return v1Problem(request, {
      requestId,
      status: 400,
      code: "INVALID_PATH",
      detail:
        "The request path is not a valid versioned API path. Encoded separators and dot segments are not accepted.",
      headers: corsFor(request),
    });
  }

  // Preflights never authenticate and never reach the quota object.
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsFor(request),
        "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "X-API-Key, Authorization, Content-Type, If-None-Match, X-Request-Id",
        "Access-Control-Max-Age": "600",
        "Cache-Control": "private, no-store",
        "X-Request-Id": requestId,
      },
    });
  }

  const baseHeaders: Record<string, string> = {
    "x-egdata-request-id": requestId,
  };

  if (PUBLIC_V1_PATHS.has(pathname)) {
    const upstream = await forwardToUpstream(
      request,
      env,
      pathname,
      reqUrl.search,
      cfProps,
      { headers: baseHeaders, stripCookies: true },
    );
    // Fetch responses have immutable headers in Workers. Preserve the upstream
    // status/body while applying the same public metadata headers as before.
    const response = new Response(upstream.body, upstream);
    response.headers.set("X-Request-Id", requestId);
    response.headers.set(
      "Cache-Control",
      response.ok ? "public, max-age=60" : "private, no-store",
    );
    response.headers.set("CDN-Cache-Control", "no-store");
    applyCors(response.headers, request);
    return response;
  }

  if (!isKnownV1Path(pathname)) {
    return v1Problem(request, {
      requestId,
      status: 404,
      code: "NOT_FOUND",
      detail: "No version 1 operation exists at this path.",
      headers: corsFor(request),
    });
  }

  const route = resolveV1Route(pathname, request.method);

  const credentials = extractCredentials(request);
  if (credentials.conflict) {
    return v1Problem(request, {
      requestId,
      status: 401,
      code: "CONFLICTING_CREDENTIALS",
      detail:
        "Provide the API key in exactly one place: X-API-Key or Authorization: Bearer, not two different values.",
      headers: corsFor(request),
    });
  }
  if (credentials.malformedAuthorization) {
    return v1Problem(request, {
      requestId,
      status: 401,
      code: "INVALID_AUTHORIZATION",
      detail: "The Authorization header must use the Bearer scheme.",
      headers: corsFor(request),
    });
  }
  if (!credentials.rawKey && !consoleIdentity) {
    return v1Problem(request, {
      requestId,
      status: 401,
      code: "MISSING_API_KEY",
      detail:
        "A version 1 API key is required. Pass it in `X-API-Key` or `Authorization: Bearer`.",
      headers: {
        ...corsFor(request),
        "WWW-Authenticate": 'Bearer realm="egdata-v1"',
      },
    });
  }

  const isWebEphemeral = Boolean(credentials.rawKey?.startsWith("egw_"));
  let meta: CachedKeyMetadata | null = null;

  if (isWebEphemeral) {
    const webOwnerEpicId = await resolveWebOwnerEpicId(env);
    const webKeyId = env.WEB_BROWSER_KEY_ID || "key_egdata_web_browser";
    const webProjectId = env.WEB_PROJECT_ID || "prj_egdata_web";

    const verification = await verifyWebEphemeralToken(
      request,
      credentials.rawKey!,
      clientIp,
      env,
    );
    if (!verification.ok) {
      recordApiTelemetry(
        env,
        baseTelemetry(
          request,
          {
            ownerEpicId: webOwnerEpicId,
            keyId: webKeyId,
            projectId: webProjectId,
          },
          {
            routeTemplate: route?.path ?? pathname,
            statusCode: verification.status,
            cacheStatus: "EDGE_BLOCK",
            limitOutcome: "forbidden",
            startedAt,
            country,
            clientIp,
            userAgent,
            operationId: route?.operationId,
            policyFamily: "web_token",
            errorCode: verification.code,
          },
        ),
      );
      return v1Problem(request, {
        requestId,
        status: verification.status,
        code: verification.code,
        detail: verification.detail,
        headers: corsFor(request),
      });
    }

    const keyState = await resolveWebBrowserKeyState(env, webKeyId);
    if (keyState.revoked) {
      recordApiTelemetry(
        env,
        baseTelemetry(
          request,
          {
            ownerEpicId: webOwnerEpicId,
            keyId: webKeyId,
            projectId: webProjectId,
          },
          {
            routeTemplate: route?.path ?? pathname,
            statusCode: 401,
            cacheStatus: "EDGE_BLOCK",
            limitOutcome: "forbidden",
            startedAt,
            country,
            clientIp,
            userAgent,
            operationId: route?.operationId,
            policyFamily: "web_token",
            errorCode: "INVALID_API_KEY",
          },
        ),
      );
      return v1Problem(request, {
        requestId,
        status: 401,
        code: "INVALID_API_KEY",
        detail: "The provided API key is invalid, revoked, or expired.",
        headers: {
          ...corsFor(request),
          "WWW-Authenticate": 'Bearer realm="egdata-v1", error="invalid_token"',
        },
      });
    }

    const requestOrigin = request.headers.get("origin");
    meta = {
      keyId: webKeyId,
      projectId: webProjectId,
      ownerEpicId:
        env.WEB_OWNER_EPIC_ID || keyState.ownerEpicId || webOwnerEpicId,
      name: "egdata.app Browser (Ephemeral)",
      tier: "enterprise",
      active: keyState.active,
      scopes: [...API_SCOPES],
      allowedIps: [],
      allowedOrigins: requestOrigin
        ? [requestOrigin, "https://egdata.app"]
        : ["https://egdata.app"],
      allowedPaths: [],
      allowedMethods: ["GET", "HEAD", "POST"],
      customRpm: null,
      expiresAt: keyState.expiresAt,
    };
  } else {
    try {
      meta =
        consoleIdentity ??
        (await resolveApiKeyMetadata(
          env,
          ctx,
          await sha256Hex(credentials.rawKey!),
        ));
    } catch {
      const response = v1Problem(request, {
        requestId,
        status: 503,
        code: "ACCOUNT_STATUS_UNAVAILABLE",
        detail:
          "Credential and account status could not be verified. Please retry shortly.",
        headers: { ...corsFor(request), "Retry-After": "30" },
      });
      return request.method === "HEAD"
        ? new Response(null, response)
        : response;
    }
  }

  if (!meta) {
    return v1Problem(request, {
      requestId,
      status: 401,
      code: "INVALID_API_KEY",
      detail: "The provided API key is invalid, revoked, or expired.",
      headers: {
        ...corsFor(request),
        "WWW-Authenticate": 'Bearer realm="egdata-v1", error="invalid_token"',
      },
    });
  }

  // Method validation happens only after key authentication so a data path
  // never exposes its method matrix to anonymous callers. It still happens
  // before permission evaluation and quota admission.
  if (!route) {
    return v1Problem(request, {
      requestId,
      status: 405,
      code: "METHOD_NOT_ALLOWED",
      detail: `The ${request.method} method is not supported for ${pathname}.`,
      headers: {
        ...corsFor(request),
        Allow: allowedMethodsForV1Path(pathname).join(", "),
      },
    });
  }

  const policy = evaluateKeyPermissions(
    meta,
    {
      method: request.method,
      pathname,
      clientIp,
      origin: request.headers.get("origin"),
    },
    Date.now(),
    route.scope,
  );

  if (!policy.allowed) {
    recordApiTelemetry(
      env,
      baseTelemetry(request, meta, {
        routeTemplate: route.path,
        statusCode: policy.status,
        cacheStatus: "EDGE_BLOCK",
        limitOutcome: policy.reason,
        startedAt,
        country,
        clientIp,
        userAgent,
        operationId: route.operationId,
        policyFamily: "key_policy",
        errorCode: policy.reason.toUpperCase(),
      }),
    );
    return v1Problem(request, {
      requestId,
      status: policy.status,
      code: policy.reason.toUpperCase(),
      detail: policy.message ?? "API key permission denied.",
      headers: corsFor(request),
    });
  }

  let quotaHeaders: Record<string, string> = {};
  let effectiveTier: string = meta.tier;
  let entitlement: Awaited<
    ReturnType<typeof resolveEffectiveProjectEntitlement>
  > | null = null;
  let admission: AdmissionResult | null = null;
  let periodBudget: ReturnType<typeof resolveExpensivePeriodPolicyName> | null =
    null;
  const admittedAtMs = Date.now();

  if (isWebEphemeral) {
    if (
      env.RATE_LIMITER_PRO &&
      typeof env.RATE_LIMITER_PRO.limit === "function"
    ) {
      const { success } = await env.RATE_LIMITER_PRO.limit({
        key: `web:${clientIp ?? "unknown"}`,
      });
      if (!success) {
        recordApiTelemetry(
          env,
          baseTelemetry(request, meta, {
            routeTemplate: route.path,
            statusCode: 429,
            cacheStatus: "EDGE_BLOCK",
            limitOutcome: "rate_limited",
            startedAt,
            country,
            clientIp,
            userAgent,
            operationId: route.operationId,
            policyFamily: "web-ip",
            errorCode: "RATE_LIMITED",
          }),
        );
        return v1Problem(request, {
          requestId,
          status: 429,
          code: "RATE_LIMITED",
          detail: "Per-IP rate limit exceeded for web token.",
          headers: {
            ...corsFor(request),
            "Retry-After": "60",
            "X-Egdata-Key-Tier": meta.tier,
          },
        });
      }
    }
  } else {
    try {
      entitlement = await resolveEffectiveProjectEntitlement(env, meta);
    } catch {
      recordApiTelemetry(
        env,
        baseTelemetry(request, meta, {
          routeTemplate: route.path,
          statusCode: 503,
          cacheStatus: "EDGE_BLOCK",
          limitOutcome: "account_status_unavailable",
          startedAt,
          country,
          clientIp,
          userAgent,
        }),
      );
      const response = v1Problem(request, {
        requestId,
        status: 503,
        code: "ACCOUNT_STATUS_UNAVAILABLE",
        detail:
          "Plan entitlement status could not be verified. Please retry shortly.",
        headers: { ...corsFor(request), "Retry-After": "30" },
      });
      return request.method === "HEAD"
        ? new Response(null, response)
        : response;
    }
    effectiveTier = entitlement.tier;
    const entitlementCheck = evaluatePlanEntitlement(entitlement, {
      pathname,
      method: request.method,
      operationId: route.operationId,
    });

    if (!entitlementCheck.allowed) {
      recordApiTelemetry(
        env,
        baseTelemetry(request, meta, {
          routeTemplate: route.path,
          statusCode: 403,
          cacheStatus: "EDGE_BLOCK",
          limitOutcome: "entitlement_denied",
          startedAt,
          country,
          clientIp,
          userAgent,
          operationId: route.operationId,
          policyFamily: "plan_entitlement",
          errorCode: "PLAN_ENTITLEMENT_REQUIRED",
        }),
      );
      return v1Problem(request, {
        requestId,
        status: 403,
        code: "PLAN_ENTITLEMENT_REQUIRED",
        detail:
          entitlementCheck.message ??
          "Current subscription plan does not include access to this capability.",
        headers: {
          ...corsFor(request),
          "X-Egdata-Key-Tier": entitlement.tier,
        },
      });
    }

    const commercial = await resolveCommercialLimitsEnabled(env, {
      userId: meta.ownerEpicId,
      environment: env.RATE_LIMIT_ENVIRONMENT,
    });
    const policies = route.expensive
      ? [
          {
            name: route.expensive,
            limit: expensivePolicyLimitForProject(
              route.expensive,
              meta,
              entitlement,
              commercial,
            ),
          },
        ]
      : [];
    periodBudget = resolveExpensivePeriodPolicyName(
      pathname,
      request.method,
      route.operationId,
    );

    let admissionResult: AdmissionResult;
    try {
      admissionResult = await admitProjectRequest(
        env,
        meta,
        policies,
        route.operationId,
        { entitlement, periodBudget },
      );
      admission = admissionResult;
    } catch {
      recordApiTelemetry(
        env,
        baseTelemetry(request, meta, {
          routeTemplate: route.path,
          statusCode: 503,
          cacheStatus: "EDGE_BLOCK",
          limitOutcome: "quota_unavailable",
          startedAt,
          country,
          clientIp,
          userAgent,
        }),
      );
      return v1Problem(request, {
        requestId,
        status: 503,
        code: "QUOTA_UNAVAILABLE",
        detail:
          "The quota service could not confirm admission. The request was not forwarded and may be retried after a short delay.",
        headers: {
          ...corsFor(request),
          "Retry-After": "1",
        },
      });
    }

    const now = Date.now();
    quotaHeaders = rateLimitHeaders(admissionResult, now);

    if (!admissionResult.allowed) {
      const monthlyExhausted =
        admissionResult.exhaustedPolicy === MONTHLY_POLICY_NAME;
      const dailyExhausted =
        admissionResult.exhaustedPolicy === DAILY_POLICY_NAME;
      const periodExhausted =
        admissionResult.exhaustedPolicy === PERIOD_POLICY_NAME;
      const periodBudgetExhausted = Boolean(
        admissionResult.exhaustedPolicy &&
          admissionResult.exhaustedPolicy.endsWith("-period") &&
          !periodExhausted,
      );
      const exhausted = admissionResult.policies.find(
        (entry) => entry.name === admissionResult.exhaustedPolicy,
      );
      const resetIso = exhausted
        ? new Date(exhausted.resetAt).toISOString()
        : new Date(admissionResult.resetAt).toISOString();
      const limitCode = monthlyExhausted
        ? "MONTHLY_QUOTA_EXCEEDED"
        : periodExhausted || dailyExhausted
          ? "PERIOD_QUOTA_EXCEEDED"
          : periodBudgetExhausted
            ? "EXPENSIVE_BUDGET_EXCEEDED"
            : "RATE_LIMITED";
      recordApiTelemetry(
        env,
        baseTelemetry(request, meta, {
          routeTemplate: route.path,
          statusCode: 429,
          cacheStatus: "EDGE_BLOCK",
          limitOutcome: monthlyExhausted
            ? "monthly_quota_exceeded"
            : periodExhausted || dailyExhausted
              ? "period_quota_exceeded"
              : periodBudgetExhausted
                ? "expensive_budget_exceeded"
                : "rate_limited",
          startedAt,
          country,
          clientIp,
          userAgent,
          operationId: route.operationId,
          policyFamily:
            admissionResult.exhaustedPolicy ??
            periodBudget?.key ??
            route.expensive ??
            "rpm",
          errorCode: limitCode,
        }),
      );
      return v1Problem(request, {
        requestId,
        status: 429,
        code: limitCode,
        detail: monthlyExhausted
          ? `The free account monthly quota of ${exhausted?.limit.toLocaleString() ?? "100,000"} requests is exhausted across all free projects, API keys, and console sessions until the first day of the next calendar month at 00:00 UTC.`
          : dailyExhausted && exhausted
            ? `The ${entitlement.planId} initial 14-day daily allowance of ${exhausted.limit.toLocaleString()} requests is exhausted until ${resetIso}. Full monthly pacing unlocks after your 14-day statutory withdrawal window.`
            : periodExhausted
              ? `The ${entitlement.planId} billing-period allowance of ${exhausted?.limit.toLocaleString() ?? ""} requests is exhausted until ${resetIso}.`
              : periodBudgetExhausted && exhausted
                ? `The ${exhausted.name} budget of ${exhausted.limit.toLocaleString()} requests for this period is exhausted until ${resetIso}.`
                : exhausted
                  ? `The ${exhausted.name} quota of ${exhausted.limit} requests per 60 seconds for this project is exhausted.`
                  : "The project quota for this operation is exhausted.",
        headers: {
          ...corsFor(request),
          ...quotaHeaders,
          "Retry-After": String(admissionResult.retryAfter),
          ...(admissionResult.exhaustedPolicy
            ? { "X-RateLimit-Policy": admissionResult.exhaustedPolicy }
            : {}),
          "X-Egdata-Key-Tier": entitlement.tier,
        },
      });
    }

    const lastTouch = lastUsedTouchDebounce.get(meta.keyId) ?? 0;
    if (!consoleIdentity && Date.now() - lastTouch > 5 * 60 * 1000) {
      lastUsedTouchDebounce.set(meta.keyId, Date.now());
      ctx.waitUntil(touchApiKeyLastUsed(env.DB, meta.keyId).catch(() => {}));
    }
  }

  let upstreamResponse: Response;
  let cacheStatus: string;
  const upstreamStartedAt = performance.now();
  try {
    const cachedResult = await fetchV1WithEdgeCache({
      request,
      ctx,
      pathname,
      search: reqUrl.search,
      fetchUpstream: (upstreamRequest) =>
        forwardToUpstream(
          upstreamRequest,
          env,
          pathname,
          reqUrl.search,
          cfProps,
          {
            stripCookies: true,
            headers: {
              ...baseHeaders,
              "x-egdata-worker-token": env.ORIGIN_AUTH_TOKEN ?? "",
              "x-egdata-key-id": meta.keyId,
              "x-egdata-key-tier": effectiveTier,
              "x-egdata-key-project": meta.projectId,
              "x-egdata-authenticated": "1",
            },
          },
        ),
    });
    upstreamResponse = cachedResult.response;
    cacheStatus = cachedResult.cacheStatus;
  } catch {
    if (!isWebEphemeral && entitlement && admission) {
      ctx.waitUntil(
        creditAdmittedRequestUsage(env, {
          adjustmentId: `svc502:${requestId}`,
          ownerEpicId: meta.ownerEpicId,
          projectId: meta.projectId,
          entitlement,
          admission,
          admittedAtMs,
          periodBudget,
          reason: "origin_unavailable",
        }).catch(() => {}),
      );
    }
    return v1Problem(request, {
      requestId,
      status: 502,
      code: "ORIGIN_UNAVAILABLE",
      detail: "The API origin is unavailable.",
      headers: { ...corsFor(request), ...quotaHeaders },
    });
  }

  if (
    upstreamResponse.status >= 500 &&
    !isWebEphemeral &&
    entitlement &&
    admission
  ) {
    ctx.waitUntil(
      creditAdmittedRequestUsage(env, {
        adjustmentId: `svc5xx:${requestId}`,
        ownerEpicId: meta.ownerEpicId,
        projectId: meta.projectId,
        entitlement,
        admission,
        admittedAtMs,
        periodBudget,
        reason: `upstream_status_${upstreamResponse.status}`,
      }).catch(() => {}),
    );
  }

  const routeTemplate = route.path;
  const upstreamElapsedMs =
    cacheStatus === "HIT" ? 0 : performance.now() - upstreamStartedAt;
  recordApiTelemetry(
    env,
    baseTelemetry(request, meta, {
      routeTemplate,
      statusCode: upstreamResponse.status,
      cacheStatus,
      limitOutcome: "ok",
      startedAt,
      country,
      clientIp,
      userAgent,
      operationId: route.operationId,
      policyFamily: isWebEphemeral
        ? "web-ip"
        : (periodBudget?.key ?? route.expensive ?? ""),
      errorCode:
        upstreamResponse.status >= 400 ? `HTTP_${upstreamResponse.status}` : "",
      upstreamLatencyMs: upstreamElapsedMs,
      responseBytes: parsedContentLength(upstreamResponse.headers),
    }),
  );

  if (
    isWebEphemeral &&
    env.USAGE_TRACKING_ENABLED === "true" &&
    route.operationId
  ) {
    const nowMs = Date.now();
    const usageEvent = {
      projectId: meta.projectId,
      keyId: meta.keyId,
      operationId: route.operationId,
      usageDate: new Date(nowMs).toISOString().slice(0, 10),
      firstUsedAt: nowMs,
    };
    ctx.waitUntil(
      (async () => {
        try {
          if (env.ENDPOINT_USAGE_QUEUE?.send) {
            await env.ENDPOINT_USAGE_QUEUE.send(usageEvent);
          } else if (env.DB) {
            await ingestUsage(env.DB, [usageEvent], nowMs);
          }
        } catch (err) {
          console.error("Failed to record web usage event", err);
        }
      })(),
    );
  }

  const outHeaders = new Headers(upstreamResponse.headers);
  for (const header of [
    "ratelimit",
    "ratelimit-policy",
    "retry-after",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "access-control-allow-credentials",
    "set-cookie",
  ]) {
    outHeaders.delete(header);
  }
  for (const [name, value] of Object.entries(quotaHeaders)) {
    outHeaders.set(name, value);
  }
  outHeaders.set("X-Request-Id", requestId);
  outHeaders.set("X-Egdata-Key-Tier", effectiveTier);
  outHeaders.set(
    "Cache-Control",
    upstreamResponse.status === 303 || pathname.endsWith("/catalog/hydrate")
      ? "private, no-store"
      : "private, no-cache",
  );
  outHeaders.set("CDN-Cache-Control", "no-store");
  outHeaders.set("Cloudflare-CDN-Cache-Control", "no-store");
  applyCors(outHeaders, request);

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: outHeaders,
  });
}
