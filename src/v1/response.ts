import type { Context } from "hono";
import { ProblemError } from "./errors.js";

const NO_STORE_PATHS = new Set(["/v1/health", "/v1/open-api.json"]);

const isNoStorePath = (path: string) =>
  NO_STORE_PATHS.has(path) ||
  NO_STORE_PATHS.has(
    path === "/v1" ? "/" : path.startsWith("/v1/") ? path.slice(3) : path,
  );

export function responseHeaders(c: Context): Headers {
  const headers = new Headers();
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-Request-Id", c.get("requestId") as string);
  headers.set("X-Content-Type-Options", "nosniff");
  if (isNoStorePath(c.req.path)) {
    headers.set("Cache-Control", "public, max-age=0, must-revalidate");
    headers.set("CDN-Cache-Control", "no-store");
  } else {
    headers.set("Cache-Control", "private, no-cache");
    headers.set("CDN-Cache-Control", "no-store");
    headers.set("Cloudflare-CDN-Cache-Control", "no-store");
  }
  return headers;
}

export type SuccessMeta = Record<string, unknown>;

export function jsonSuccess(
  c: Context,
  data: unknown,
  meta: SuccessMeta = {},
  status: 200 | 201 = 200,
): Response {
  const body = JSON.stringify({ data, meta });
  return new Response(c.req.method === "HEAD" ? null : body, {
    status,
    headers: responseHeaders(c),
  });
}

export function emptySuccess(c: Context, status: 204 | 205 = 204): Response {
  return new Response(null, { status, headers: responseHeaders(c) });
}

export function nativeResponse(
  c: Context,
  body: BodyInit | null,
  init: {
    status?: number;
    contentType: string;
    cacheControl: string;
    cdnCacheControl?: string;
    headers?: Record<string, string>;
  },
): Response {
  const headers = responseHeaders(c);
  headers.set("Content-Type", init.contentType);
  headers.set("Cache-Control", init.cacheControl);
  if (init.cdnCacheControl) {
    headers.set("CDN-Cache-Control", init.cdnCacheControl);
  } else {
    headers.set("CDN-Cache-Control", "no-store");
  }
  for (const [name, value] of Object.entries(init.headers ?? {})) {
    headers.set(name, value);
  }
  return new Response(c.req.method === "HEAD" ? null : body, {
    status: init.status ?? 200,
    headers,
  });
}

/**
 * Early handlers (health/openapi) use a tiny JSON envelope but never a
 * request-specific identifier in the body, so their responses remain safe to
 * cache at a future layer.
 */
export function publicJson(
  c: Context,
  data: unknown,
  meta: SuccessMeta = {},
  status = 200,
): Response {
  const headers = responseHeaders(c);
  headers.set("Cache-Control", "public, max-age=60");
  return new Response(JSON.stringify({ data, meta }), {
    status,
    headers,
  });
}

export function methodNotAllowed(c: Context, allowed: string[]): Response {
  const headers = responseHeaders(c);
  headers.set("Allow", allowed.join(", "));
  headers.set("Content-Type", "application/problem+json");
  return new Response(
    JSON.stringify({
      type: "https://api.egdata.app/problems/method-not-allowed",
      title: "Method Not Allowed",
      status: 405,
      detail: `The ${c.req.method} method is not supported for ${c.req.path}.`,
      instance: c.req.path,
      code: "METHOD_NOT_ALLOWED",
      requestId: c.get("requestId") as string,
    }),
    { status: 405, headers },
  );
}

export function requireMeta(meta: SuccessMeta | undefined): SuccessMeta {
  return meta ?? {};
}

export function problemOrRethrow(error: unknown): never {
  if (error instanceof ProblemError) throw error;
  throw error;
}
