import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler, Next } from "hono";
import { ProblemError } from "./errors.js";

export type ApiKeyTier = "free" | "pro" | "scale" | "enterprise";

export type V1KeyIdentity = {
  keyId: string;
  tier: ApiKeyTier;
  projectId: string | null;
};

export type V1Variables = {
  requestId: string;
  v1Key: V1KeyIdentity | null;
};

const INTERNAL_HEADERS = [
  "x-egdata-key-id",
  "x-egdata-key-tier",
  "x-egdata-key-project",
  "x-egdata-worker-token",
  "x-egdata-authenticated",
  "x-egdata-request-id",
  "x-egdata-origin-token",
  "x-request-id",
] as const;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const KEY_ID_PATTERN = /^key_[A-Za-z0-9_-]{4,80}$/;
const TIERS = new Set<ApiKeyTier>(["free", "pro", "scale", "enterprise"]);

export const PUBLIC_V1_PATHS = new Set(["/health", "/open-api.json"]);

const relativePath = (path: string) =>
  path === "/v1" ? "/" : path.startsWith("/v1/") ? path.slice(3) : path;

const isPublicRequest = (c: Context) =>
  c.req.method === "OPTIONS" || PUBLIC_V1_PATHS.has(relativePath(c.req.path));

function secureEquals(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

export function getWorkerToken(): string | undefined {
  return (
    process.env.V1_WORKER_TOKEN?.trim() ||
    process.env.ORIGIN_AUTH_TOKEN?.trim() ||
    undefined
  );
}

export function workerAuthRequired(): boolean {
  // Production always fails closed; local tests may opt out explicitly.
  if (process.env.NODE_ENV === "production") return true;
  if (process.env.V1_WORKER_AUTH_REQUIRED === "true") return true;
  if (process.env.V1_WORKER_AUTH_REQUIRED === "false") return false;
  if (getWorkerToken()) return true;
  return false;
}

/**
 * Establishes the trusted v1 request context.
 *
 * The Worker is the only component allowed to assert API-key identity. Any
 * caller-supplied internal header is removed before handlers run, and identity
 * is accepted only when the Worker shared secret also matches.
 */
export const v1Context = (): MiddlewareHandler => {
  const workerToken = getWorkerToken();
  const requireWorker = workerAuthRequired();

  return async (c, next) => {
    // Capture, then remove every internal header so untrusted values can never
    // reach handlers or be forwarded downstream by mistake.
    const suppliedWorkerToken = c.req.header("x-egdata-worker-token") ?? "";
    const suppliedRequestId =
      c.req.header("x-egdata-request-id") ?? c.req.header("x-request-id") ?? "";
    const suppliedKeyId = c.req.header("x-egdata-key-id") ?? "";
    const suppliedTier = c.req.header("x-egdata-key-tier") ?? "";
    const suppliedProjectId = c.req.header("x-egdata-key-project") ?? "";

    for (const header of INTERNAL_HEADERS) {
      c.req.raw.headers.delete(header);
    }

    const requestId =
      REQUEST_ID_PATTERN.test(suppliedRequestId) &&
      (workerToken ? secureEquals(suppliedWorkerToken, workerToken) : true)
        ? suppliedRequestId
        : `req_${crypto.randomUUID()}`;

    c.set("requestId", requestId);
    c.header("X-Request-Id", requestId);

    if (isPublicRequest(c)) {
      c.set("v1Key", null);
      return next();
    }

    if (requireWorker) {
      if (!workerToken) {
        throw new ProblemError({
          status: 503,
          code: "WORKER_AUTH_NOT_CONFIGURED",
          detail:
            "The API origin cannot verify Worker provenance. The request was not processed.",
        });
      }
      if (!secureEquals(suppliedWorkerToken, workerToken)) {
        throw new ProblemError({
          status: 403,
          code: "UNTRUSTED_WORKER",
          detail:
            "This v1 endpoint is only available through the authenticated API gateway.",
        });
      }
    }

    if (!KEY_ID_PATTERN.test(suppliedKeyId)) {
      throw new ProblemError({
        status: 401,
        code: "MISSING_KEY_CONTEXT",
        detail:
          "The request did not include a verified API key identity. Use the egdata API gateway.",
      });
    }

    const tier = suppliedTier.toLowerCase() as ApiKeyTier;
    if (!TIERS.has(tier)) {
      throw new ProblemError({
        status: 403,
        code: "INVALID_KEY_CONTEXT",
        detail: "The API key tier asserted by the gateway is not recognized.",
      });
    }

    c.set("v1Key", {
      keyId: suppliedKeyId,
      tier,
      projectId: suppliedProjectId || null,
    });

    return next();
  };
};

/**
 * HTTP caching is disabled for v1 while authentication and quotas are
 * evaluated on every request. Internal response caching is still used, and
 * ETags allow private revalidation.
 */
export const v1CachePolicy = (): MiddlewareHandler => {
  return async (c: Context, next: Next) => {
    await next();
    if (c.res.status >= 500 || c.res.status === 429) return;
    if (PUBLIC_V1_PATHS.has(relativePath(c.req.path))) {
      c.res.headers.set("CDN-Cache-Control", "no-store");
      c.res.headers.set("X-Content-Type-Options", "nosniff");
      return;
    }
    const cacheControl = c.res.headers.get("Cache-Control");
    if (!cacheControl || !/private|no-store|no-cache/i.test(cacheControl)) {
      c.res.headers.set("Cache-Control", "private, no-cache");
    }
    c.res.headers.set("CDN-Cache-Control", "no-store");
    c.res.headers.set("Cloudflare-CDN-Cache-Control", "no-store");
    c.res.headers.set("X-Content-Type-Options", "nosniff");
  };
};
