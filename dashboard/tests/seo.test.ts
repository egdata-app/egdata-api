import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import worker from "../worker/index";
import { ROBOTS_TXT } from "../worker/seo";
import type { DashboardEnv } from "../worker/types";

const context = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

const indexHtml = readFileSync(resolve("index.html"), "utf8");

function htmlAssetsEnv(origin = "https://devs.egdata.app"): DashboardEnv {
  return {
    DASHBOARD_ORIGIN: origin,
    API_PROXY_HOST: "api.egdata.app",
    UPSTREAM_API_ORIGIN: "https://origin-api.egdata.app",
    ORIGIN_AUTH_TOKEN: "test-origin-token",
    REQUIRE_API_KEY: "false",
    ASSETS: {
      fetch: vi.fn(async (req: Request) => {
        const pathname = new URL(req.url).pathname;
        if (pathname === "/og-image.png") {
          return new Response(new Uint8Array([137, 80, 78, 71]), {
            status: 200,
            headers: { "content-type": "image/png" },
          });
        }
        return new Response(indexHtml, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }),
    },
  } as unknown as DashboardEnv;
}

/**
 * Evaluates standard longest-match robots.txt Allow/Disallow precedence
 * (RFC 9309 / Googlebot) for `User-agent: *`.
 */
function isAllowedByRobots(robotsTxt: string, path: string): boolean {
  const rules: Array<{ type: "allow" | "disallow"; pattern: string }> = [];
  let active = false;

  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      active = value === "*";
      continue;
    }
    if (!active) continue;
    if (field === "allow" && value) {
      rules.push({ type: "allow", pattern: value });
    } else if (field === "disallow" && value) {
      rules.push({ type: "disallow", pattern: value });
    }
  }

  let best: { type: "allow" | "disallow"; length: number } | null = null;
  for (const rule of rules) {
    const endAnchored = rule.pattern.endsWith("$");
    const rawPattern = endAnchored ? rule.pattern.slice(0, -1) : rule.pattern;
    const escaped = rawPattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", ".*");
    const regex = new RegExp(`^${escaped}${endAnchored ? "$" : ""}`);
    if (!regex.test(path)) continue;
    if (
      !best ||
      rule.pattern.length > best.length ||
      (rule.pattern.length === best.length && rule.type === "allow")
    ) {
      best = { type: rule.type, length: rule.pattern.length };
    }
  }

  return best ? best.type === "allow" : true;
}

describe("dashboard robots.txt", () => {
  it("keeps public/robots.txt synchronized with the worker response", async () => {
    const publicRobots = readFileSync(resolve("public/robots.txt"), "utf8");
    expect(publicRobots).toBe(ROBOTS_TXT);

    const env = htmlAssetsEnv();
    const getRes = await worker.fetch(
      new Request("https://devs.egdata.app/robots.txt"),
      env,
      context,
    );
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(getRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await getRes.text()).toBe(ROBOTS_TXT);

    const headRes = await worker.fetch(
      new Request("https://devs.egdata.app/robots.txt", { method: "HEAD" }),
      env,
      context,
    );
    expect(headRes.status).toBe(200);
    expect(await headRes.text()).toBe("");
  });

  it("allows only homepage, docs, problems, and required static assets", () => {
    const allowedPaths = [
      "/",
      "/docs",
      "/docs/",
      "/docs/get-started",
      "/docs/problems",
      "/docs/missing-api-key",
      "/docs/getOffer",
      "/problems",
      "/problems/",
      "/problems/invalid-query",
      "/assets/index-abc123.js",
      "/assets/index-abc123.css",
      "/og-image.png",
    ];
    for (const path of allowedPaths) {
      expect(
        isAllowedByRobots(ROBOTS_TXT, path),
        `${path} should be allowed`,
      ).toBe(true);
    }

    const disallowedPaths = [
      "/keys",
      "/analytics",
      "/limits",
      "/alerts",
      "/profile",
      "/profile/billing",
      "/profile/agreements",
      "/profile/receipts",
      "/admin/users",
      "/admin/projects",
      "/agreements",
      "/receipts",
      "/terms",
      "/privacy",
      "/legal/history",
      "/_dashboard/api/auth/session",
      "/_dashboard/api/keys",
      "/proxy/v1/offers",
      "/docs-extra",
      "/problems-extra",
    ];
    for (const path of disallowedPaths) {
      expect(
        isAllowedByRobots(ROBOTS_TXT, path),
        `${path} should be disallowed`,
      ).toBe(false);
    }
  });

  it("does not intercept /robots.txt on api.egdata.app", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response("User-agent: *\nDisallow: /\nAllow: /sitemap.xml\n", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const res = await worker.fetch(
        new Request("https://api.egdata.app/robots.txt"),
        htmlAssetsEnv(),
        context,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Allow: /sitemap.xml");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("dashboard homepage OG image and per-route SEO", () => {
  it("provides a valid 1200x630 PNG OG image in public/og-image.png", async () => {
    const png = readFileSync(resolve("public/og-image.png"));
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(png.toString("ascii", 12, 16)).toBe("IHDR");
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    expect(width).toBe(1200);
    expect(height).toBe(630);

    const res = await worker.fetch(
      new Request("https://devs.egdata.app/og-image.png"),
      htmlAssetsEnv(),
      context,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toBeNull();
  });

  it("serves Open Graph and Twitter card metadata only on the homepage", async () => {
    const res = await worker.fetch(
      new Request("https://devs.egdata.app/"),
      htmlAssetsEnv(),
      context,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toBeNull();

    const html = await res.text();
    expect(html).toContain('<meta name="robots" content="index, follow" />');
    expect(html).toContain(
      '<link rel="canonical" href="https://devs.egdata.app/" />',
    );
    expect(html).toContain('<meta property="og:type" content="website" />');
    expect(html).toContain(
      '<meta property="og:url" content="https://devs.egdata.app/" />',
    );
    expect(html).toContain(
      '<meta property="og:image" content="https://devs.egdata.app/og-image.png" />',
    );
    expect(html).toContain('<meta property="og:image:width" content="1200" />');
    expect(html).toContain('<meta property="og:image:height" content="630" />');
    expect(html).toContain(
      '<meta name="twitter:card" content="summary_large_image" />',
    );
    expect(html).toContain(
      '<meta name="twitter:image" content="https://devs.egdata.app/og-image.png" />',
    );
  });

  it("serves indexable route-specific SEO without homepage OG tags on docs and problems", async () => {
    const env = htmlAssetsEnv();

    const docsRes = await worker.fetch(
      new Request("https://devs.egdata.app/docs"),
      env,
      context,
    );
    expect(docsRes.headers.get("x-robots-tag")).toBeNull();
    const docsHtml = await docsRes.text();
    expect(docsHtml).toContain(
      "<title>API Reference — egdata Developer Portal</title>",
    );
    expect(docsHtml).toContain(
      '<link rel="canonical" href="https://devs.egdata.app/docs" />',
    );
    expect(docsHtml).toContain(
      '<meta name="robots" content="index, follow" />',
    );
    expect(docsHtml).not.toContain("og:image");
    expect(docsHtml).not.toContain("twitter:card");

    const problemRes = await worker.fetch(
      new Request("https://devs.egdata.app/docs/missing-api-key"),
      env,
      context,
    );
    const problemHtml = await problemRes.text();
    expect(problemHtml).toContain(
      "<title>Missing API key — egdata API Docs</title>",
    );
    expect(problemHtml).toContain(
      '<link rel="canonical" href="https://devs.egdata.app/docs/missing-api-key" />',
    );
    expect(problemHtml).not.toContain("og:image");
    expect(problemHtml).not.toContain("twitter:image");

    const problemsPathRes = await worker.fetch(
      new Request("https://devs.egdata.app/problems/rate-limited"),
      env,
      context,
    );
    const problemsPathHtml = await problemsPathRes.text();
    expect(problemsPathHtml).toContain(
      "<title>Rate limited — egdata API Problems</title>",
    );
    expect(problemsPathHtml).toContain(
      '<link rel="canonical" href="https://devs.egdata.app/problems/rate-limited" />',
    );
    expect(problemsPathHtml).not.toContain("og:image");

    const opRes = await worker.fetch(
      new Request("https://devs.egdata.app/docs/getOffer"),
      env,
      context,
    );
    const opHtml = await opRes.text();
    expect(opHtml).toContain(
      "<title>getOffer — API Reference | egdata Developer Portal</title>",
    );
    expect(opHtml).toContain(
      '<link rel="canonical" href="https://devs.egdata.app/docs/getOffer" />',
    );
    expect(opHtml).not.toContain("og:image");
  });

  it("marks non-crawlable portal routes as noindex and strips OG tags", async () => {
    const env = htmlAssetsEnv();
    for (const path of [
      "/keys",
      "/analytics",
      "/limits",
      "/alerts",
      "/profile",
      "/profile/billing",
      "/admin/users",
    ]) {
      const res = await worker.fetch(
        new Request(`https://devs.egdata.app${path}`),
        env,
        context,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      const html = await res.text();
      expect(html).toContain(
        '<meta name="robots" content="noindex, nofollow" />',
      );
      expect(html).not.toContain('rel="canonical"');
      expect(html).not.toContain("og:image");
      expect(html).not.toContain("twitter:card");
    }
  });

  it("escapes dynamic doc slugs in SEO head tags", async () => {
    const res = await worker.fetch(
      new Request(
        `https://devs.egdata.app/docs/${encodeURIComponent('"><script>alert(1)</script>')}`,
      ),
      htmlAssetsEnv(),
      context,
    );
    const html = await res.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
