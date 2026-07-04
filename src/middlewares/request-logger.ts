import type { Context, Next } from "hono";
import { consola, isDebugLoggingEnabled } from "../utils/logger.js";

function getPathname(url: string) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function getCloudflareLocation(c: Context) {
  const header = (name: string) => c.req.header(name) ?? null;

  return {
    country: header("CF-IPCountry"),
    continent: header("CF-IPContinent"),
    region: header("CF-Region"),
    regionCode: header("CF-Region-Code"),
    city: header("CF-IPCity"),
    postalCode: header("CF-Postal-Code"),
    metroCode: header("CF-Metro-Code"),
    timezone: header("CF-Timezone"),
    latitude: header("CF-IPLatitude"),
    longitude: header("CF-IPLongitude"),
  };
}

export async function requestDebugLogger(c: Context, next: Next) {
  if (!isDebugLoggingEnabled()) {
    await next();
    return;
  }

  const start = performance.now();

  try {
    await next();
  } finally {
    consola.debug("Request", {
      request: {
        method: c.req.method,
        pathname: getPathname(c.req.url),
        status: c.res.status,
        durationMs: Number((performance.now() - start).toFixed(2)),
      },
      location: getCloudflareLocation(c),
    });
  }
}
