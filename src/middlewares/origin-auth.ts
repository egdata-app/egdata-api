import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

const GATEWAY_IDENTITY_HEADERS = [
  "x-egdata-authenticated",
  "x-egdata-key-id",
  "x-egdata-key-tier",
  "x-egdata-key-project",
] as const;

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

    const tokenValid =
      expected !== null &&
      supplied.length > 0 &&
      timingSafeEqual(expected, createHash("sha256").update(supplied).digest());

    if (!tokenValid) {
      for (const header of GATEWAY_IDENTITY_HEADERS) {
        c.req.raw.headers.delete(header);
      }
      c.set("trustedGatewayAuthenticated", false);
    } else {
      c.set(
        "trustedGatewayAuthenticated",
        c.req.header("x-egdata-authenticated") === "1",
      );
    }

    // Global enforcement is a separate cutover after public traffic uses the Worker.
    const hostname = new URL(c.req.url).hostname
      .toLowerCase()
      .replace(/\.$/, "");
    if (!required && hostname !== originHost) return next();

    if (!tokenValid) {
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
