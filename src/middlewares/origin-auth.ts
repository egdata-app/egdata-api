import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/** Authenticate the Worker-to-origin hop independently of client authentication. */
export function originAuth({
  token = process.env.ORIGIN_AUTH_TOKEN,
  required = process.env.ORIGIN_AUTH_REQUIRED === "true",
  protectedHost = process.env.ORIGIN_AUTH_HOST || "origin-api.egdata.app",
}: {
  token?: string;
  required?: boolean;
  protectedHost?: string;
} = {}): MiddlewareHandler {
  const expected = token ? createHash("sha256").update(token).digest() : null;
  const originHost = protectedHost.toLowerCase().replace(/\.$/, "");

  return async (c, next) => {
    const supplied = c.req.header("x-egdata-origin-token") ?? "";
    // Keep this infrastructure credential away from downstream handlers/loggers.
    c.req.raw.headers.delete("x-egdata-origin-token");

    // Global enforcement is a separate cutover after public traffic uses the Worker.
    const hostname = new URL(c.req.url).hostname
      .toLowerCase()
      .replace(/\.$/, "");
    if (!required && hostname !== originHost) return next();

    if (
      !expected ||
      !timingSafeEqual(expected, createHash("sha256").update(supplied).digest())
    ) {
      c.header("Cache-Control", "private, no-store");
      c.header("CDN-Cache-Control", "no-store");
      c.header("Cloudflare-CDN-Cache-Control", "no-store");
      return c.json(
        {
          error: {
            code: expected ? "ORIGIN_ACCESS_DENIED" : "ORIGIN_NOT_CONFIGURED",
            message: expected
              ? "Use the public API gateway at https://api.egdata.app."
              : "The API origin is not configured.",
          },
        },
        expected ? 403 : 503,
      );
    }

    return next();
  };
}
