import { recordApiTelemetry } from "./analytics.js";
import { sha256Hex } from "./crypto.js";
import { touchApiKeyLastUsed } from "./db.js";
import { resolveApiKeyMetadata } from "./key-cache.js";
import { evaluateKeyPermissions, originMatchesPattern } from "./permissions.js";
import type { DashboardEnv } from "./types.js";

const PUBLIC_UNAUTHENTICATED_PATHS = new Set([
  "/health",
  "/ping",
  "/robots.txt",
  "/open-api.json",
  "/ui",
]);

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
      "Retry-After, RateLimit, RateLimit-Policy, X-Egdata-Key-Tier";
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

function isAllowedFirstPartyOrigin(
  origin: string | null,
  env: DashboardEnv,
): boolean {
  if (!origin) return false;
  const rawList = env.ALLOW_FIRST_PARTY_ORIGINS || "";
  if (!rawList) return false;
  const patterns = rawList
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return patterns.some((pattern) => originMatchesPattern(origin, pattern));
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

  // 1. Always pass CORS preflight OPTIONS directly (browsers never send X-API-Key on preflight)
  if (request.method === "OPTIONS") {
    return forwardToUpstream(
      request,
      env,
      upstreamPath,
      reqUrl.search,
      cfProps,
    );
  }

  // 2. Allow unauthenticated health/docs/auth/sitemap endpoints
  if (
    PUBLIC_UNAUTHENTICATED_PATHS.has(upstreamPath) ||
    upstreamPath.endsWith("sitemap.xml") ||
    upstreamPath.startsWith("/auth/")
  ) {
    return forwardToUpstream(
      request,
      env,
      upstreamPath,
      reqUrl.search,
      cfProps,
    );
  }

  // 3. Extract and validate API key at the Cloudflare edge BEFORE checking CDN Cache
  const rawApiKey = extractClientApiKey(request);
  const requireKey = String(env.REQUIRE_API_KEY) !== "false";

  if (!rawApiKey) {
    // Allow configured first-party web origins (e.g. https://egdata.app) if configured
    if (!requireKey || isAllowedFirstPartyOrigin(originHeader, env)) {
      return forwardToUpstream(
        request,
        env,
        upstreamPath,
        reqUrl.search,
        cfProps,
      );
    }

    return edgeErrorJson(
      401,
      "MISSING_API_KEY",
      "An API key is required. Pass your key in the `X-API-Key` header or create one in the egdata Developer Portal.",
      originHeader,
    );
  }

  const keyHash = await sha256Hex(rawApiKey);
  const keyMeta = await resolveApiKeyMetadata(env, ctx, keyHash);

  if (!keyMeta) {
    return edgeErrorJson(
      401,
      "INVALID_API_KEY",
      "The provided API key is invalid or has been revoked.",
      originHeader,
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

  // 5. Enforce per-key Rate Limiting at the Cloudflare PoP (0ms network hop)
  const limiter =
    keyMeta.tier === "enterprise"
      ? env.RATE_LIMITER_ENTERPRISE
      : keyMeta.tier === "pro"
        ? env.RATE_LIMITER_PRO
        : env.RATE_LIMITER_FREE;

  const { success: withinLimit } = await limiter.limit({ key: keyMeta.keyId });

  if (!withinLimit) {
    recordApiTelemetry(env, {
      ownerEpicId: keyMeta.ownerEpicId,
      keyId: keyMeta.keyId,
      projectId: keyMeta.projectId,
      routeTemplate: normalizeRouteTemplate(upstreamPath, null),
      method: request.method,
      statusCode: 429,
      cacheStatus: "EDGE_BLOCK",
      limitOutcome: "rate_limited",
      origin: originHeader ?? "(direct)",
      clientIp: clientIp ?? "unknown",
      userAgent,
      country,
      latencyMs: performance.now() - startMs,
    });

    return edgeErrorJson(
      429,
      "RATE_LIMITED",
      `API key rate limit exceeded for ${keyMeta.tier} tier. Request higher limits in the egdata Developer Portal.`,
      originHeader,
      {
        "Retry-After": "60",
        "X-Egdata-Key-Tier": keyMeta.tier,
      },
    );
  }

  // 6. Debounced async last_used_at update in D1 (at most once every 5 minutes per isolate per key)
  const lastTouch = lastUsedTouchDebounce.get(keyMeta.keyId) ?? 0;
  if (Date.now() - lastTouch > 5 * 60 * 1000) {
    lastUsedTouchDebounce.set(keyMeta.keyId, Date.now());
    ctx.waitUntil(touchApiKeyLastUsed(env.DB, keyMeta.keyId).catch(() => {}));
  }

  // 7. Forward clean request through Cloudflare's shared zone Cache & Tiered Cache!
  // Stripping `x-api-key` ensures all validated keys share the exact same Cloudflare Cache Key!
  const upstreamResponse = await forwardToUpstream(
    request,
    env,
    upstreamPath,
    reqUrl.search,
    cfProps,
    {
      stripApiKey: true,
      keyTier: keyMeta.tier,
    },
  );

  const cacheStatus = upstreamResponse.headers.get("cf-cache-status") || "MISS";
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
  outHeaders.set("X-Egdata-Key-Tier", keyMeta.tier);

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: outHeaders,
  });
}

async function forwardToUpstream(
  request: Request,
  env: DashboardEnv,
  pathname: string,
  search: string,
  cfProps:
    | {
        tlsCipher?: string;
        tlsVersion?: string;
        httpProtocol?: string;
        asn?: number;
      }
    | undefined,
  opts?: { stripApiKey?: boolean; keyTier?: string },
): Promise<Response> {
  const targetOrigin = env.UPSTREAM_API_ORIGIN || "https://api.egdata.app";
  const upstreamUrl = new URL(`${pathname}${search}`, targetOrigin);

  const headers = new Headers(request.headers);
  if (opts?.stripApiKey) {
    headers.delete("x-api-key");
    const auth = headers.get("authorization");
    if (auth && /^Bearer\s+egk_/i.test(auth)) {
      headers.delete("authorization");
    }
  }

  // Forward authenticated transport signals natively to egdata-api's anti-abuse engine
  if (env.ANTI_ABUSE_EDGE_SECRET) {
    headers.set("x-egdata-edge-secret", env.ANTI_ABUSE_EDGE_SECRET);
    if (cfProps?.tlsCipher)
      headers.set("x-egdata-tls-cipher", cfProps.tlsCipher);
    if (cfProps?.tlsVersion)
      headers.set("x-egdata-tls-version", cfProps.tlsVersion);
    if (cfProps?.httpProtocol)
      headers.set("x-egdata-http-protocol", cfProps.httpProtocol);
    if (cfProps?.asn) headers.set("x-egdata-asn", String(cfProps.asn));
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD";

  return fetch(upstreamUrl.toString(), {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: "manual",
  });
}
