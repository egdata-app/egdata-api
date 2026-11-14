import { recordApiTelemetry } from "./analytics.js";
import { UNATTRIBUTED_LEGACY_ID } from "./analytics-types.js";
import { sha256Hex, timingSafeStringEqual } from "./crypto.js";
import { touchApiKeyLastUsed } from "./db.js";
import { fetchLegacyWithEdgeCache } from "./edge-cache.js";
import { resolveCommercialLimitsEnabled } from "./flags.js";
import { resolveApiKeyMetadata } from "./key-cache.js";
import { evaluateKeyPermissions } from "./permissions.js";
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
import type { CachedKeyMetadata, DashboardEnv } from "./types.js";
import { forwardToUpstream } from "./upstream.js";
import { handleV1ApiProxy } from "./v1.js";
import {
  expensivePolicyLimitForProject,
  resolveExpensivePeriodPolicyName,
  resolveLegacyExpensivePolicy,
} from "./v1-routes.js";

const PUBLIC_UNAUTHENTICATED_PATHS = new Set([
  "/health",
  "/ping",
  "/robots.txt",
  "/open-api.json",
  "/ui",
]);

const ANONYMOUS_EDGE_CACHE_PATHS = new Set([
  "/countries",
  "/tags",
  "/offers/genres",
  "/offers/top-sellers",
  "/free-games",
  "/free-games/stats",
  "/search/v2/search",
  "/stats/homepage",
  "/autocomplete",
]);

function isAnonymousEdgeCachePath(pathname: string): boolean {
  return (
    ANONYMOUS_EDGE_CACHE_PATHS.has(pathname) ||
    /^\/offers\/[^/]+\/(?:tops|assets|price)$/.test(pathname)
  );
}

function normalizeRouteTemplate(
  pathname: string,
  responseHeaderTemplate: string | null,
): string {
  if (responseHeaderTemplate) return responseHeaderTemplate;
  // Normalize 24-32 char hex IDs if origin didn't attach X-Route-Template (e.g. 429/403 at edge)
  return pathname.replace(/\/[a-f0-9]{24,36}(?=\/|$)/gi, "/{id}");
}

function edgeErrorJson(
  status: number,
  code: string,
  message: string,
  originHeader: string | null,
  extraHeaders?: Record<string, string>,
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
    "CDN-Cache-Control": "no-store",
    ...extraHeaders,
  };
  if (originHeader) {
    headers["Access-Control-Allow-Origin"] = originHeader;
    headers["Access-Control-Allow-Credentials"] = "true";
    headers["Access-Control-Expose-Headers"] =
      "Retry-After, RateLimit, RateLimit-Policy, X-RateLimit-Policy, X-Egdata-Key-Tier";
    headers.Vary = "Origin";
  }
  return new Response(
    JSON.stringify({
      error: {
        code,
        message,
      },
    }),
    { status, headers },
  );
}

function extractClientApiKey(request: Request): string | null {
  const fromHeader = request.headers.get("x-api-key")?.trim();
  if (fromHeader) return fromHeader;

  // Support Authorization: Bearer egk_... without interfering with non-egk user JWTs
  const auth = request.headers.get("authorization")?.trim();
  if (auth && /^Bearer\s+egk_/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, "").trim();
  }
  return null;
}

async function isTrustedFirstPartyRequest(
  request: Request,
  env: DashboardEnv,
): Promise<boolean> {
  const expected = env.FIRST_PARTY_SERVICE_TOKEN?.trim();
  if (!expected) return false;
  const supplied =
    request.headers.get("x-egdata-first-party-token")?.trim() ?? "";
  if (!supplied) return false;
  return timingSafeStringEqual(supplied, expected);
}

const lastUsedTouchDebounce = new Map<string, number>();

export async function handleEdgeApiProxy(
  request: Request,
  env: DashboardEnv,
  ctx: ExecutionContext,
  options?: { stripPrefix?: string },
): Promise<Response> {
  const startMs = performance.now();
  const reqUrl = new URL(request.url);
  const upstreamPath =
    options?.stripPrefix && reqUrl.pathname.startsWith(options.stripPrefix)
      ? reqUrl.pathname.slice(options.stripPrefix.length) || "/"
      : reqUrl.pathname;

  // Version 1 has its own mandatory authentication, scope mapping, Durable
  // Object quota admission, and trusted-provenance headers.
  if (upstreamPath === "/v1" || upstreamPath.startsWith("/v1/")) {
    return handleV1ApiProxy(request, env, ctx, upstreamPath);
  }

  const originHeader = request.headers.get("origin");
  const clientIp =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null;
  const userAgent = request.headers.get("user-agent") || "";
  const cfProps = (
    request as Request & {
      cf?: {
        country?: string;
        tlsCipher?: string;
        tlsVersion?: string;
        httpProtocol?: string;
        asn?: number;
      };
    }
  ).cf;
  const country = cfProps?.country || "XX";

  // Requests that bypass key validation have no trusted owner. Keep them in a
  // reserved identity visible only through the admin's global analytics scope.
  const recordUnattributed = (
    response: Response,
    limitOutcome = "ok",
    edgeCacheStatus?: string,
  ): Response => {
    recordApiTelemetry(env, {
      ownerEpicId: UNATTRIBUTED_LEGACY_ID,
      keyId: UNATTRIBUTED_LEGACY_ID,
      projectId: UNATTRIBUTED_LEGACY_ID,
      routeTemplate: normalizeRouteTemplate(
        upstreamPath,
        response.headers.get("x-route-template"),
      ),
      method: request.method,
      statusCode: response.status,
      cacheStatus:
        limitOutcome !== "ok"
          ? "EDGE_BLOCK"
          : response.status === 304
            ? "REVALIDATED"
            : edgeCacheStatus ||
              response.headers.get("cf-cache-status") ||
              response.headers.get("x-cache") ||
              "DYNAMIC",
      limitOutcome,
      origin: originHeader ?? "(direct)",
      clientIp: clientIp ?? "unknown",
      userAgent,
      country,
      latencyMs: performance.now() - startMs,
    });
    return response;
  };
  const forwardUnattributed = async () =>
    recordUnattributed(
      await forwardToUpstream(
        request,
        env,
        upstreamPath,
        reqUrl.search,
        cfProps,
      ),
    );

  // 1. Always pass CORS preflight OPTIONS directly (browsers never send X-API-Key on preflight)
  if (request.method === "OPTIONS") {
    return forwardUnattributed();
  }

  // 2. Allow unauthenticated health/docs/auth/sitemap endpoints
  if (
    PUBLIC_UNAUTHENTICATED_PATHS.has(upstreamPath) ||
    upstreamPath.endsWith("sitemap.xml") ||
    upstreamPath.startsWith("/auth/")
  ) {
    return forwardUnattributed();
  }

  // 3. Extract and validate API key at the Cloudflare edge BEFORE checking CDN Cache
  const rawApiKey = extractClientApiKey(request);
  const requireKey = String(env.REQUIRE_API_KEY) !== "false";

  if (!rawApiKey) {
    const trustedFirstParty = await isTrustedFirstPartyRequest(request, env);
    if (!requireKey || trustedFirstParty) {
      if (isAnonymousEdgeCachePath(upstreamPath)) {
        const { response, cacheStatus } = await fetchLegacyWithEdgeCache({
          request,
          ctx,
          pathname: upstreamPath,
          search: reqUrl.search,
          anonymousPublic: true,
          fetchUpstream: (upstreamRequest) =>
            forwardToUpstream(
              upstreamRequest,
              env,
              upstreamPath,
              reqUrl.search,
              cfProps,
            ),
        });
        return recordUnattributed(response, "ok", cacheStatus);
      }
      return forwardUnattributed();
    }

    return recordUnattributed(
      edgeErrorJson(
        401,
        "MISSING_API_KEY",
        "An API key is required. Pass your key in the `X-API-Key` header or create one in the egdata Developer Portal.",
        originHeader,
      ),
      "missing_api_key",
    );
  }

  const keyHash = await sha256Hex(rawApiKey);
  let keyMeta: CachedKeyMetadata | null;
  try {
    keyMeta = await resolveApiKeyMetadata(env, ctx, keyHash);
  } catch {
    const response = edgeErrorJson(
      503,
      "ACCOUNT_STATUS_UNAVAILABLE",
      "Credential and account status could not be verified. Please retry shortly.",
      originHeader,
      { "Retry-After": "30" },
    );
    return request.method === "HEAD" ? new Response(null, response) : response;
  }

  if (!keyMeta) {
    return recordUnattributed(
      edgeErrorJson(
        401,
        "INVALID_API_KEY",
        "The provided API key is invalid or has been revoked.",
        originHeader,
      ),
      "invalid_api_key",
    );
  }

  // 4. Evaluate fine-grained key permissions (IP/CIDR, Origin, Allowed Paths, Methods, Scopes, Expiry)
  const policy = evaluateKeyPermissions(keyMeta, {
    method: request.method,
    pathname: upstreamPath,
    clientIp,
    origin: originHeader,
  });

  if (!policy.allowed) {
    recordApiTelemetry(env, {
      ownerEpicId: keyMeta.ownerEpicId,
      keyId: keyMeta.keyId,
      projectId: keyMeta.projectId,
      routeTemplate: normalizeRouteTemplate(upstreamPath, null),
      method: request.method,
      statusCode: policy.status,
      cacheStatus: "EDGE_BLOCK",
      limitOutcome: policy.reason,
      origin: originHeader ?? "(direct)",
      clientIp: clientIp ?? "unknown",
      userAgent,
      country,
      latencyMs: performance.now() - startMs,
    });

    return edgeErrorJson(
      policy.status,
      policy.reason.toUpperCase(),
      policy.message || "API key permission denied.",
      originHeader,
    );
  }

  // 5. Evaluate server-owned plan entitlements before cache access or quota admission.
  let entitlement: Awaited<
    ReturnType<typeof resolveEffectiveProjectEntitlement>
  >;
  try {
    entitlement = await resolveEffectiveProjectEntitlement(env, keyMeta);
  } catch {
    recordApiTelemetry(env, {
      ownerEpicId: keyMeta.ownerEpicId,
      keyId: keyMeta.keyId,
      projectId: keyMeta.projectId,
      routeTemplate: normalizeRouteTemplate(upstreamPath, null),
      method: request.method,
      statusCode: 503,
      cacheStatus: "EDGE_BLOCK",
      limitOutcome: "account_status_unavailable",
      origin: originHeader ?? "(direct)",
      clientIp: clientIp ?? "unknown",
      userAgent,
      country,
      latencyMs: performance.now() - startMs,
    });
    const response = edgeErrorJson(
      503,
      "ACCOUNT_STATUS_UNAVAILABLE",
      "Plan entitlement status could not be verified. Please retry shortly.",
      originHeader,
      { "Retry-After": "30" },
    );
    return request.method === "HEAD" ? new Response(null, response) : response;
  }
  const entitlementCheck = evaluatePlanEntitlement(entitlement, {
    pathname: upstreamPath,
    method: request.method,
  });
  if (!entitlementCheck.allowed) {
    recordApiTelemetry(env, {
      ownerEpicId: keyMeta.ownerEpicId,
      keyId: keyMeta.keyId,
      projectId: keyMeta.projectId,
      routeTemplate: normalizeRouteTemplate(upstreamPath, null),
      method: request.method,
      statusCode: 403,
      cacheStatus: "EDGE_BLOCK",
      limitOutcome: "entitlement_denied",
      origin: originHeader ?? "(direct)",
      clientIp: clientIp ?? "unknown",
      userAgent,
      country,
      latencyMs: performance.now() - startMs,
    });
    return edgeErrorJson(
      403,
      "PLAN_ENTITLEMENT_REQUIRED",
      entitlementCheck.message ||
        "Current subscription plan does not include access to this capability.",
      originHeader,
      { "X-Egdata-Key-Tier": entitlement.tier },
    );
  }

  // 6. Share one global project allowance with v1 and the API console.
  const commercial = await resolveCommercialLimitsEnabled(env, {
    userId: keyMeta.ownerEpicId,
    environment: env.RATE_LIMIT_ENVIRONMENT,
  });
  const expensivePolicy = resolveLegacyExpensivePolicy(
    upstreamPath,
    request.method,
  );
  const additionalPolicies = expensivePolicy
    ? [
        {
          name: expensivePolicy,
          limit: expensivePolicyLimitForProject(
            expensivePolicy,
            keyMeta,
            entitlement,
            commercial,
          ),
        },
      ]
    : [];
  const periodBudget = resolveExpensivePeriodPolicyName(
    upstreamPath,
    request.method,
  );
  let admission: AdmissionResult;
  try {
    admission = await admitProjectRequest(
      env,
      keyMeta,
      additionalPolicies,
      undefined,
      { entitlement, periodBudget },
    );
  } catch {
    recordApiTelemetry(env, {
      ownerEpicId: keyMeta.ownerEpicId,
      keyId: keyMeta.keyId,
      projectId: keyMeta.projectId,
      routeTemplate: normalizeRouteTemplate(upstreamPath, null),
      method: request.method,
      statusCode: 503,
      cacheStatus: "EDGE_BLOCK",
      limitOutcome: "quota_unavailable",
      origin: originHeader ?? "(direct)",
      clientIp: clientIp ?? "unknown",
      userAgent,
      country,
      latencyMs: performance.now() - startMs,
    });
    return edgeErrorJson(
      503,
      "QUOTA_UNAVAILABLE",
      "The quota service could not confirm admission. Please retry shortly.",
      originHeader,
      { "Retry-After": "1" },
    );
  }
  const quotaHeaders = rateLimitHeaders(admission);

  if (!admission.allowed) {
    const monthlyExhausted = admission.exhaustedPolicy === MONTHLY_POLICY_NAME;
    const dailyExhausted = admission.exhaustedPolicy === DAILY_POLICY_NAME;
    const periodExhausted = admission.exhaustedPolicy === PERIOD_POLICY_NAME;
    const periodBudgetExhausted = Boolean(
      admission.exhaustedPolicy &&
        admission.exhaustedPolicy.endsWith("-period") &&
        !periodExhausted,
    );
    const exhausted = admission.policies.find(
      (entry) => entry.name === admission.exhaustedPolicy,
    );
    const resetIso = exhausted
      ? new Date(exhausted.resetAt).toISOString()
      : new Date(admission.resetAt).toISOString();
    recordApiTelemetry(env, {
      ownerEpicId: keyMeta.ownerEpicId,
      keyId: keyMeta.keyId,
      projectId: keyMeta.projectId,
      routeTemplate: normalizeRouteTemplate(upstreamPath, null),
      method: request.method,
      statusCode: 429,
      cacheStatus: "EDGE_BLOCK",
      limitOutcome: monthlyExhausted
        ? "monthly_quota_exceeded"
        : periodExhausted || dailyExhausted
          ? "period_quota_exceeded"
          : periodBudgetExhausted
            ? "expensive_budget_exceeded"
            : "rate_limited",
      origin: originHeader ?? "(direct)",
      clientIp: clientIp ?? "unknown",
      userAgent,
      country,
      latencyMs: performance.now() - startMs,
    });

    return edgeErrorJson(
      429,
      monthlyExhausted
        ? "MONTHLY_QUOTA_EXCEEDED"
        : periodExhausted || dailyExhausted
          ? "PERIOD_QUOTA_EXCEEDED"
          : periodBudgetExhausted
            ? "EXPENSIVE_BUDGET_EXCEEDED"
            : "RATE_LIMITED",
      monthlyExhausted
        ? "Free account monthly quota of 100,000 requests is exhausted across all free projects, API keys, and console sessions until the next calendar month at 00:00 UTC. Request higher limits in the egdata Developer Portal."
        : dailyExhausted && exhausted
          ? `The ${entitlement.planId} initial 14-day daily allowance of ${exhausted.limit.toLocaleString()} requests is exhausted until ${resetIso}. Full monthly pacing unlocks after your 14-day withdrawal window, or request custom limits in the egdata Developer Portal.`
          : periodExhausted
            ? `The ${entitlement.planId} billing-period allowance is exhausted until ${resetIso}. Manage your subscription in the egdata Developer Portal.`
            : periodBudgetExhausted && exhausted
              ? `The ${exhausted.name} budget of ${exhausted.limit.toLocaleString()} requests for this period is exhausted until ${resetIso}.`
              : `Project rate limit exceeded for ${entitlement.tier} tier. All API keys share this allowance. Request higher limits in the egdata Developer Portal.`,
      originHeader,
      {
        ...quotaHeaders,
        "Retry-After": String(admission.retryAfter),
        ...(admission.exhaustedPolicy
          ? { "X-RateLimit-Policy": admission.exhaustedPolicy }
          : {}),
        "X-Egdata-Key-Tier": entitlement.tier,
      },
    );
  }

  // 7. Debounced async last_used_at update in D1 (at most once every 5 minutes per isolate per key)
  const lastTouch = lastUsedTouchDebounce.get(keyMeta.keyId) ?? 0;
  if (Date.now() - lastTouch > 5 * 60 * 1000) {
    lastUsedTouchDebounce.set(keyMeta.keyId, Date.now());
    ctx.waitUntil(touchApiKeyLastUsed(env.DB, keyMeta.keyId).catch(() => {}));
  }

  // 8. Serve from Worker edge cache or forward to the dedicated origin after permission/entitlement/rate-limit checks.
  const requestCreditId = request.headers.get("cf-ray") || crypto.randomUUID();
  let upstreamResponse: Response;
  let cacheStatus: string;
  try {
    const cachedResult = await fetchLegacyWithEdgeCache({
      request,
      ctx,
      pathname: upstreamPath,
      search: reqUrl.search,
      fetchUpstream: (upstreamRequest) =>
        forwardToUpstream(
          upstreamRequest,
          env,
          upstreamPath,
          reqUrl.search,
          cfProps,
          {
            headers: {
              "x-egdata-authenticated": "1",
              "x-egdata-key-id": keyMeta.keyId,
              "x-egdata-key-tier": entitlement.tier,
              "x-egdata-key-project": keyMeta.projectId,
            },
          },
        ),
    });
    upstreamResponse = cachedResult.response;
    cacheStatus = cachedResult.cacheStatus;
  } catch {
    ctx.waitUntil(
      creditAdmittedRequestUsage(env, {
        adjustmentId: `svc502:${requestCreditId}`,
        ownerEpicId: keyMeta.ownerEpicId,
        projectId: keyMeta.projectId,
        entitlement,
        reason: "origin_unavailable",
      }).catch(() => {}),
    );
    return edgeErrorJson(
      502,
      "ORIGIN_UNAVAILABLE",
      "The API origin is unavailable.",
      originHeader,
      quotaHeaders,
    );
  }

  if (upstreamResponse.status >= 500) {
    ctx.waitUntil(
      creditAdmittedRequestUsage(env, {
        adjustmentId: `svc5xx:${requestCreditId}`,
        ownerEpicId: keyMeta.ownerEpicId,
        projectId: keyMeta.projectId,
        entitlement,
        reason: `upstream_status_${upstreamResponse.status}`,
      }).catch(() => {}),
    );
  }

  const routeTemplate = normalizeRouteTemplate(
    upstreamPath,
    upstreamResponse.headers.get("x-route-template"),
  );

  // 8. Fire-and-forget telemetry to Workers Analytics Engine (0ms latency impact)
  recordApiTelemetry(env, {
    ownerEpicId: keyMeta.ownerEpicId,
    keyId: keyMeta.keyId,
    projectId: keyMeta.projectId,
    routeTemplate,
    method: request.method,
    statusCode: upstreamResponse.status,
    cacheStatus,
    limitOutcome: "ok",
    origin: originHeader ?? "(direct)",
    clientIp: clientIp ?? "unknown",
    userAgent,
    country,
    latencyMs: performance.now() - startMs,
  });

  // Stream response body untouched (zero buffering, preserves strong/weak ETags & gzip/br)
  const outHeaders = new Headers(upstreamResponse.headers);
  for (const [name, value] of Object.entries(quotaHeaders)) {
    outHeaders.set(name, value);
  }
  outHeaders.set("X-Egdata-Key-Tier", entitlement.tier);
  if (originHeader) {
    outHeaders.set("Access-Control-Allow-Origin", originHeader);
    outHeaders.set("Access-Control-Allow-Credentials", "true");
    outHeaders.set(
      "Access-Control-Expose-Headers",
      "Cache-Control, CDN-Cache-Control, ETag, X-Total-Count, X-Cache, X-Route-Template, X-Egdata-Mitigation, Retry-After, Server-Timing, RateLimit, RateLimit-Policy, X-Egdata-Key-Tier",
    );
    const existingVary = outHeaders.get("Vary");
    if (!existingVary) {
      outHeaders.set("Vary", "Origin");
    } else if (!/(?:^|,)\s*Origin\s*(?:,|$)/i.test(existingVary)) {
      outHeaders.set("Vary", `${existingVary}, Origin`);
    }
  } else {
    outHeaders.delete("Access-Control-Allow-Origin");
    outHeaders.delete("Access-Control-Allow-Credentials");
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: outHeaders,
  });
}
