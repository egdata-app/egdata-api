import type { Context, Next } from "hono";

const HEX_ID = /\b[0-9a-f]{24,32}\b/gi;
const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const SELLER_ID = /\bo-[a-z0-9]{20,}\b/gi;
const NUMERIC_ID = /^\d{4,}$/;

/**
 * Returns a route template suitable for grouping analytics by endpoint rather
 * than by individual document id. The value is exposed as X-Route-Template so
 * Cloudflare Logpush / origin logs can aggregate it without path parsing.
 *
 * @example /offers/014812a6932f45bebfa6313ee17ddac0/og -> /offers/{id}/og
 */
export const routeTemplateForPath = (path: string) => {
  return path
    .split("/")
    .map((segment) => {
      if (!segment) return segment;
      if (NUMERIC_ID.test(segment)) return "{id}";
      return segment
        .replace(UUID, "{uuid}")
        .replace(SELLER_ID, "{sellerId}")
        .replace(HEX_ID, "{id}");
    })
    .join("/");
};

export const routeTemplate = async (c: Context, next: Next) => {
  await next();

  if (c.res.headers.has("X-Route-Template")) {
    return;
  }

  c.res.headers.set("X-Route-Template", routeTemplateForPath(c.req.path));
};
