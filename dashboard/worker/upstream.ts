import type { DashboardEnv } from "./types.js";

const INTERNAL_HEADERS = [
  "x-egdata-console-session",
  "x-egdata-key-id",
  "x-egdata-key-tier",
  "x-egdata-key-project",
  "x-egdata-worker-token",
  "x-egdata-authenticated",
  "x-egdata-request-id",
  "x-egdata-origin-token",
  "x-request-id",
  "x-egdata-edge-secret",
  "x-egdata-tls-cipher",
  "x-egdata-tls-version",
  "x-egdata-http-protocol",
  "x-egdata-asn",
  "x-egdata-header-order",
];

export type CfProperties = {
  country?: string;
  tlsCipher?: string;
  tlsVersion?: string;
  httpProtocol?: string;
  asn?: number;
};

export type ForwardOptions = {
  /** Trusted headers to set after caller-supplied values are removed. */
  headers?: Record<string, string>;
  /** v1 never accepts cookie-selected behavior or ambient credentials. */
  stripCookies?: boolean;
};

export async function forwardToUpstream(
  request: Request,
  env: DashboardEnv,
  pathname: string,
  search: string,
  cfProps: CfProperties | undefined,
  options: ForwardOptions = {},
): Promise<Response> {
  let upstreamUrl: URL;
  try {
    upstreamUrl = new URL(env.UPSTREAM_API_ORIGIN);
    const localHttp =
      upstreamUrl.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(upstreamUrl.hostname);
    if (
      !env.ORIGIN_AUTH_TOKEN ||
      (upstreamUrl.protocol !== "https:" && !localHttp) ||
      upstreamUrl.username ||
      upstreamUrl.password ||
      upstreamUrl.pathname !== "/" ||
      upstreamUrl.search ||
      upstreamUrl.hash ||
      upstreamUrl.hostname.toLowerCase() ===
        env.API_PROXY_HOST?.toLowerCase() ||
      upstreamUrl.host === new URL(request.url).host
    )
      throw new Error("Invalid origin configuration");
  } catch {
    return upstreamConfigurationError(request);
  }

  // Assign URL components: a path beginning // must never replace the host and
  // leak the origin credential to an attacker-controlled server.
  upstreamUrl.pathname = pathname;
  upstreamUrl.search = search;

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("x-api-key");
  const auth = headers.get("authorization");
  if (auth && /^Bearer\s+egk_/i.test(auth)) {
    headers.delete("authorization");
  }
  if (options.stripCookies) {
    headers.delete("cookie");
    headers.delete("authorization");
  }
  for (const name of INTERNAL_HEADERS) {
    headers.delete(name);
  }
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers.set(name, value);
  }

  headers.set("x-egdata-origin-token", env.ORIGIN_AUTH_TOKEN);
  headers.set("x-forwarded-host", env.API_PROXY_HOST);
  headers.set("x-forwarded-proto", "https");

  // Forward authenticated transport signals natively to the API's anti-abuse
  // engine. v1 requests do not run browser challenges, but retaining the
  // signals keeps aggregate abuse analysis accurate.
  if (env.ANTI_ABUSE_EDGE_SECRET) {
    if (!headers.has("x-egdata-edge-secret")) {
      headers.set("x-egdata-edge-secret", env.ANTI_ABUSE_EDGE_SECRET);
    }
    if (cfProps?.tlsCipher)
      headers.set("x-egdata-tls-cipher", cfProps.tlsCipher);
    if (cfProps?.tlsVersion)
      headers.set("x-egdata-tls-version", cfProps.tlsVersion);
    if (cfProps?.httpProtocol)
      headers.set("x-egdata-http-protocol", cfProps.httpProtocol);
    if (cfProps?.asn) headers.set("x-egdata-asn", String(cfProps.asn));
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD";

  try {
    return await fetch(upstreamUrl.toString(), {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: "manual",
    });
  } catch {
    return originUnavailableError(request);
  }
}

function corsFor(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Expose-Headers":
      "X-Request-Id, Retry-After, RateLimit, RateLimit-Policy, X-Egdata-Key-Tier, ETag",
    Vary: "Origin",
  };
}

export function upstreamConfigurationError(
  request: Request,
  requestId?: string,
): Response {
  return edgeProblem(
    request,
    503,
    "ORIGIN_NOT_CONFIGURED",
    "The API origin is not configured.",
    requestId,
  );
}

export function originUnavailableError(
  request: Request,
  requestId?: string,
): Response {
  return edgeProblem(
    request,
    502,
    "ORIGIN_UNAVAILABLE",
    "The API origin is unavailable.",
    requestId,
  );
}

export function edgeProblem(
  request: Request,
  status: number,
  code: string,
  detail: string,
  requestId?: string,
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/problem+json",
    "Cache-Control": "private, no-store",
    "CDN-Cache-Control": "no-store",
    "Cloudflare-CDN-Cache-Control": "no-store",
    ...corsFor(request),
  };
  if (requestId) headers["X-Request-Id"] = requestId;
  const titles: Record<number, string> = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    405: "Method Not Allowed",
    415: "Unsupported Media Type",
    429: "Too Many Requests",
    502: "Bad Gateway",
    503: "Service Unavailable",
  };
  return new Response(
    JSON.stringify({
      type: `https://api.egdata.app/problems/${code
        .toLowerCase()
        .replaceAll("_", "-")}`,
      title: titles[status] ?? "Error",
      status,
      detail,
      instance: new URL(request.url).pathname,
      code,
      ...(requestId ? { requestId } : {}),
    }),
    { status, headers },
  );
}
