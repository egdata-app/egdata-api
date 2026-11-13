import type { Context, Next } from "hono";

type CacheRule = {
  test: RegExp;
  browser: string;
  cdn: string;
};

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const rules: CacheRule[] = [
  {
    test: /^\/autocomplete$/,
    browser: `public, max-age=${MINUTE}, s-maxage=${MINUTE}`,
    cdn: `public, max-age=${MINUTE}`,
  },
  {
    test: /^\/stats\/homepage$/,
    browser: `public, max-age=${MINUTE}, s-maxage=${5 * MINUTE}`,
    cdn: `public, max-age=${5 * MINUTE}`,
  },
  {
    test: /^\/(?:countries|regions)$/,
    browser: `public, max-age=${HOUR}, s-maxage=${DAY}, stale-while-revalidate=${DAY}`,
    cdn: `public, max-age=${DAY}, stale-while-revalidate=${7 * DAY}`,
  },
  {
    test: /^\/free-games\/stats$/,
    browser: `public, max-age=${HOUR}, s-maxage=${DAY}, stale-while-revalidate=${DAY}`,
    cdn: `public, max-age=${DAY}, stale-while-revalidate=${7 * DAY}`,
  },
  {
    test: /^\/(?:tags|search\/tags|offers\/genres)$/,
    browser: `public, max-age=${5 * MINUTE}, s-maxage=${HOUR}, stale-while-revalidate=${HOUR}`,
    cdn: `public, max-age=${HOUR}, stale-while-revalidate=${DAY}`,
  },
  {
    test: /^\/sellers$/,
    browser: `public, max-age=${HOUR}, s-maxage=${HOUR}, stale-while-revalidate=${DAY}`,
    cdn: `public, max-age=${HOUR}, stale-while-revalidate=${DAY}`,
  },
  {
    test: /^\/offers\/(?:top-sellers|top-wishlisted|featured-discounts)$/,
    browser: `public, max-age=${5 * MINUTE}, s-maxage=${HOUR}, stale-while-revalidate=${HOUR}`,
    cdn: `public, max-age=${HOUR}, stale-while-revalidate=${DAY}`,
  },
  {
    test: /^\/(?:offers|items|builds|changelist|free-games|collections|franchises|promotions|sandboxes|sellers|game-awards|multisearch)(?:\/|$)/,
    browser: `public, max-age=${MINUTE}, s-maxage=${5 * MINUTE}, stale-while-revalidate=${10 * MINUTE}`,
    cdn: `public, max-age=${5 * MINUTE}, stale-while-revalidate=${HOUR}`,
  },
  {
    test: /^\/profiles\/(?!me(?:\/|$)|[^/]+\/(?:refresh|information|refresh-status)(?:\/|$))/,
    browser: `public, max-age=${MINUTE}, s-maxage=${5 * MINUTE}, stale-while-revalidate=${5 * MINUTE}`,
    cdn: `public, max-age=${5 * MINUTE}, stale-while-revalidate=${HOUR}`,
  },
  {
    test: /^\/search\/v2\/search$/,
    browser: `public, max-age=${MINUTE}, s-maxage=${5 * MINUTE}, stale-while-revalidate=${10 * MINUTE}`,
    cdn: `public, max-age=${5 * MINUTE}, stale-while-revalidate=${HOUR}`,
  },
];

const skipExact = new Set([
  "/",
  "/health",
  "/ping",
  "/robots.txt",
  "/open-api.json",
  "/doc",
  "/ui",
]);

const skipPrefixes = [
  "/auth",
  "/accounts",
  "/admin",
  "/users",
  "/users-service",
  "/push",
  "/launcher",
  "/catalog",
  "/offers/regen",
  "/items/regen",
  "/search/natural-language",
  "/graphql",
];

const isSkipped = (c: Context) => {
  const path = c.req.path;
  if (skipExact.has(path)) return true;
  if (
    skipPrefixes.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    )
  ) {
    return true;
  }
  // Generated images and sitemaps set their own longer-lived headers.
  if (
    path.endsWith("/og") ||
    path.endsWith("/og.webp") ||
    path.endsWith("sitemap.xml")
  ) {
    return true;
  }
  // Authenticated per-user subresources under otherwise public prefixes.
  if (path.endsWith("/ownership") || path.endsWith("/permissions")) {
    return true;
  }
  return false;
};

const hasPrivateCacheControl = (value: string | null) =>
  Boolean(
    value && /(?:^|,)\s*(?:private|no-store|no-cache)\s*(?:,|$)/i.test(value),
  );

/**
 * Adds explicit shared-cache headers to public GET endpoints.
 *
 * Cloudflare does not cache JSON by default; these headers make the intended
 * TTL explicit for a Cache Rule (and work as-is with CDNs that honor
 * s-maxage/CDN-Cache-Control). Personalised and authenticated routes are
 * deliberately skipped.
 */
export const edgeCacheHeaders = async (c: Context, next: Next) => {
  await next();

  if (c.req.method === "GET") {
    const vary = c.res.headers.get("Vary");
    if (!vary) {
      c.res.headers.set("Vary", "Accept-Encoding");
    } else if (!/\baccept-encoding\b/i.test(vary)) {
      c.res.headers.set("Vary", `${vary}, Accept-Encoding`);
    }
    // The newly shared homepage response can fall back to EGDATA_COUNTRY.
    // Require an explicit country for shared caching rather than mixing cookie
    // variants. The Worker bypasses responses that vary on Cookie.
    if (
      c.req.path === "/stats/homepage" &&
      c.req.query("country") === undefined
    ) {
      const current = c.res.headers.get("Vary");
      if (!/\bcookie\b/i.test(current ?? "")) {
        c.res.headers.set("Vary", `${current}, Cookie`);
      }
    }
  }

  if (c.req.method !== "GET" || c.res.status !== 200) {
    return;
  }
  if (isSkipped(c) || c.res.headers.has("Set-Cookie")) {
    return;
  }
  if (hasPrivateCacheControl(c.res.headers.get("Cache-Control"))) {
    return;
  }

  const rule = rules.find((candidate) => candidate.test.test(c.req.path));
  if (!rule) {
    return;
  }

  c.res.headers.set("Cache-Control", rule.browser);
  c.res.headers.set("CDN-Cache-Control", rule.cdn);
};
