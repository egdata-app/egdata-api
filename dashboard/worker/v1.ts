import { recordApiTelemetry } from "./analytics.js";
import { sha256Hex } from "./crypto.js";
import { touchApiKeyLastUsed } from "./db.js";
import { fetchV1WithEdgeCache } from "./edge-cache.js";
import { resolveApiKeyMetadata } from "./key-cache.js";
import { evaluateKeyPermissions } from "./permissions.js";
import {
  admitProjectRequest,
  MONTHLY_POLICY_NAME,
  rateLimitHeaders,
} from "./project-quota.js";
import type { AdmissionResult } from "./rate-limiter-core.js";
import type { CachedKeyMetadata, DashboardEnv } from "./types.js";
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
  resolveV1Route,
} from "./v1-routes.js";

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

  let meta: CachedKeyMetadata | null;
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
    return request.method === "HEAD" ? new Response(null, response) : response;
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

  const policies = route.expensive
    ? [
        {
          name: route.expensive,
          limit: expensivePolicyLimitForProject(route.expensive, meta),
        },
      ]
    : [];

  let admission: AdmissionResult;
  try {
    admission = await admitProjectRequest(
      env,
      meta,
      policies,
      route.operationId,
    );
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
  const quotaHeaders = rateLimitHeaders(admission, now);

  if (!admission.allowed) {
    const monthlyExhausted = admission.exhaustedPolicy === MONTHLY_POLICY_NAME;
    const exhausted = admission.policies.find(
      (entry) => entry.name === admission.exhaustedPolicy,
    );
    recordApiTelemetry(
      env,
      baseTelemetry(request, meta, {
        routeTemplate: route.path,
        statusCode: 429,
        cacheStatus: "EDGE_BLOCK",
        limitOutcome: monthlyExhausted
          ? "monthly_quota_exceeded"
          : "rate_limited",
        startedAt,
        country,
        clientIp,
        userAgent,
      }),
    );
    return v1Problem(request, {
      requestId,
      status: 429,
      code: monthlyExhausted ? "MONTHLY_QUOTA_EXCEEDED" : "RATE_LIMITED",
      detail: monthlyExhausted
        ? `The free account monthly quota of ${exhausted?.limit.toLocaleString() ?? "100,000"} requests is exhausted across all free projects, API keys, and console sessions until the first day of the next calendar month at 00:00 UTC.`
        : exhausted
          ? `The ${exhausted.name} quota of ${exhausted.limit} requests per 60 seconds for this project is exhausted.`
          : "The project quota for this operation is exhausted.",
      headers: {
        ...corsFor(request),
        ...quotaHeaders,
        "Retry-After": String(admission.retryAfter),
        ...(admission.exhaustedPolicy
          ? { "X-RateLimit-Policy": admission.exhaustedPolicy }
          : {}),
        "X-Egdata-Key-Tier": meta.tier,
      },
    });
  }

  const lastTouch = lastUsedTouchDebounce.get(meta.keyId) ?? 0;
  if (!consoleIdentity && Date.now() - lastTouch > 5 * 60 * 1000) {
    lastUsedTouchDebounce.set(meta.keyId, Date.now());
    ctx.waitUntil(touchApiKeyLastUsed(env.DB, meta.keyId).catch(() => {}));
  }

  let upstreamResponse: Response;
  let cacheStatus: string;
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
              "x-egdata-key-tier": meta.tier,
              "x-egdata-key-project": meta.projectId,
              "x-egdata-authenticated": "1",
            },
          },
        ),
    });
    upstreamResponse = cachedResult.response;
    cacheStatus = cachedResult.cacheStatus;
  } catch {
    return v1Problem(request, {
      requestId,
      status: 502,
      code: "ORIGIN_UNAVAILABLE",
      detail: "The API origin is unavailable.",
      headers: { ...corsFor(request), ...quotaHeaders },
    });
  }

  const routeTemplate = route.path;
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
    }),
  );

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
  outHeaders.set("X-Egdata-Key-Tier", meta.tier);
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
