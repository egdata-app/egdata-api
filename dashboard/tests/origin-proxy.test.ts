import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../worker/index";
import { handleEdgeApiProxy } from "../worker/proxy";
import type { DashboardEnv } from "../worker/types";

function environment(overrides: Partial<DashboardEnv> = {}): DashboardEnv {
  return {
    UPSTREAM_API_ORIGIN: "https://origin-api.egdata.app",
    API_PROXY_HOST: "api.egdata.app",
    ORIGIN_AUTH_TOKEN: "test-worker-origin-token",
    REQUIRE_API_KEY: "false",
    ASSETS: { fetch: vi.fn(async () => new Response("dashboard")) },
    ...overrides,
  } as DashboardEnv;
}
const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
afterEach(() => vi.unstubAllGlobals());

describe("dedicated API origin proxy", () => {
  it.each([
    "/_dashboard/api/auth/session?x=1",
    "/proxy/offers?country=ES",
    "/health",
    "/auth/challenge",
  ])("preserves the full API-host path %s", async (path) => {
    const upstream = vi.fn(async () => new Response("upstream"));
    vi.stubGlobal("fetch", upstream);
    const env = environment();
    const res = await worker.fetch(
      new Request(`https://api.egdata.app${path}`),
      env,
      ctx,
    );
    expect(await res.text()).toBe("upstream");
    expect(upstream).toHaveBeenCalledWith(
      `https://origin-api.egdata.app${path}`,
      expect.anything(),
    );
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("keeps dashboard routes and local /proxy prefix handling", async () => {
    const upstream = vi.fn(async () => new Response("upstream"));
    vi.stubGlobal("fetch", upstream);
    const env = environment();
    expect(
      await (
        await worker.fetch(
          new Request("https://developers.egdata.app/"),
          env,
          ctx,
        )
      ).text(),
    ).toBe("dashboard");
    await worker.fetch(
      new Request("http://localhost:4002/proxy/health?test=1"),
      env,
      ctx,
    );
    expect(upstream).toHaveBeenCalledWith(
      "https://origin-api.egdata.app/health?test=1",
      expect.anything(),
    );
  });

  it("overwrites internal credentials and streams POST bodies while preserving user authentication", async () => {
    const upstream = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      expect(headers.get("x-egdata-origin-token")).toBe(
        "test-worker-origin-token",
      );
      expect(headers.get("authorization")).toBe("Bearer user-jwt");
      expect(headers.has("host")).toBe(false);
      expect(headers.has("x-api-key")).toBe(false);
      expect(headers.has("x-egdata-edge-secret")).toBe(false);
      expect(headers.has("x-egdata-tls-version")).toBe(false);
      expect(headers.get("x-forwarded-host")).toBe("api.egdata.app");
      expect(init.redirect).toBe("manual");
      expect(await new Response(init.body).text()).toBe(
        '{"query":"{ health }"}',
      );
      return new Response(null, {
        status: 307,
        headers: { Location: "https://example.com/login" },
      });
    });
    vi.stubGlobal("fetch", upstream);
    const res = await handleEdgeApiProxy(
      new Request("https://api.egdata.app/graphql?locale=es-ES", {
        method: "POST",
        headers: {
          Authorization: "Bearer user-jwt",
          "X-Egdata-Origin-Token": "spoof",
          "X-Egdata-Edge-Secret": "spoof",
          "X-Egdata-Tls-Version": "spoof",
          Host: "api.egdata.app",
        },
        body: '{"query":"{ health }"}',
      }),
      environment(),
      ctx,
    );
    expect(res.status).toBe(307);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it.each([
    "GET",
    "HEAD",
    "OPTIONS",
  ])("authenticates public %s requests and preserves empty/conditional responses", async (method) => {
    const upstream = vi.fn(async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("x-egdata-origin-token")).toBe(
        "test-worker-origin-token",
      );
      expect(new Headers(init.headers).has("x-api-key")).toBe(false);
      expect(new Headers(init.headers).has("authorization")).toBe(false);
      expect(new Headers(init.headers).get("if-none-match")).toBe('"v1"');
      return new Response(null, { status: 304, headers: { ETag: '"v1"' } });
    });
    vi.stubGlobal("fetch", upstream);
    const res = await handleEdgeApiProxy(
      new Request("https://api.egdata.app/health", {
        method,
        headers: {
          "X-API-Key": "egk_unused",
          Authorization: "Bearer egk_unused",
          "If-None-Match": '"v1"',
        },
      }),
      environment(),
      ctx,
    );
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe('"v1"');
  });

  it.each([
    "//attacker.example/path",
    "/%2f%2fattacker.example/path",
  ])("keeps untrusted path %s on the fixed origin", async (path) => {
    const upstream = vi.fn(async (url: string) => {
      expect(new URL(url).origin).toBe("https://origin-api.egdata.app");
      return new Response("ok");
    });
    vi.stubGlobal("fetch", upstream);
    await handleEdgeApiProxy(
      new Request(`https://api.egdata.app${path}`),
      environment(),
      ctx,
    );
    expect(upstream).toHaveBeenCalledOnce();
  });

  it.each([
    { ORIGIN_AUTH_TOKEN: "" },
    { UPSTREAM_API_ORIGIN: "" },
    { UPSTREAM_API_ORIGIN: "https://api.egdata.app" },
    { UPSTREAM_API_ORIGIN: "http://origin-api.egdata.app" },
    { UPSTREAM_API_ORIGIN: "https://user:password@origin-api.egdata.app" },
    { UPSTREAM_API_ORIGIN: "https://origin-api.egdata.app/prefix" },
  ])("fails closed for invalid configuration %j", async (overrides) => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const res = await handleEdgeApiProxy(
      new Request("https://api.egdata.app/health"),
      environment(overrides),
      ctx,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("returns an uncacheable gateway error when the origin cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connection failed")),
    );
    const res = await handleEdgeApiProxy(
      new Request("https://api.egdata.app/health"),
      environment(),
      ctx,
    );
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});
