import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { originAuth } from "../src/middlewares/origin-auth.js";

const token = "test-origin-token-with-32-random-bytes";

function createApp(
  options: Parameters<typeof originAuth>[0] = { token, required: true },
) {
  const app = new Hono();
  const downstream = vi.fn();
  app.use("/*", originAuth(options));
  app.all("*", (c) => {
    downstream();
    return c.json({
      authorization: c.req.header("authorization"),
      originToken: c.req.header("x-egdata-origin-token") ?? null,
    });
  });
  return { app, downstream };
}

afterEach(() => vi.unstubAllEnvs());

describe("origin authentication", () => {
  it.each([
    "/",
    "/health",
    "/ping",
    "/auth/challenge",
    "/graphql",
    "/offers",
    "/open-api.json",
    "/sitemap.xml",
  ])("protects %s before downstream handlers", async (path) => {
    const { app, downstream } = createApp();
    const res = await app.request(`https://origin-api.egdata.app${path}`);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: { code: "ORIGIN_ACCESS_DENIED" },
    });
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(res.headers.get("CDN-Cache-Control")).toBe("no-store");
    expect(downstream).not.toHaveBeenCalled();
  });

  it.each([
    "GET",
    "POST",
    "OPTIONS",
    "HEAD",
  ])("rejects incorrect credentials on %s", async (method) => {
    const { app, downstream } = createApp();
    const res = await app.request("https://beta-api.egdata.app/offers", {
      method,
      headers: {
        "X-Egdata-Origin-Token": "wrong",
        Origin: "https://egdata.app",
      },
    });
    expect(res.status).toBe(403);
    expect(downstream).not.toHaveBeenCalled();
  });

  it("accepts the Worker token while preserving user auth and removing the secret", async () => {
    const { app, downstream } = createApp();
    const res = await app.request("/profiles/me", {
      headers: {
        "X-Egdata-Origin-Token": token,
        Authorization: "Bearer user-jwt",
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      authorization: "Bearer user-jwt",
      originToken: null,
    });
    expect(downstream).toHaveBeenCalledOnce();
  });

  it("fails closed when global enforcement is enabled without a token", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ORIGIN_AUTH_REQUIRED", "true");
    vi.stubEnv("ORIGIN_AUTH_TOKEN", "");
    const { app, downstream } = createApp({});
    const res = await app.request("/health");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: { code: "ORIGIN_NOT_CONFIGURED" },
    });
    expect(downstream).not.toHaveBeenCalled();
  });

  it("allows unconfigured local development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ORIGIN_AUTH_REQUIRED", "false");
    vi.stubEnv("ORIGIN_AUTH_TOKEN", "");
    const { app } = createApp({});
    expect((await app.request("/health")).status).toBe(200);
  });

  it("protects only the dedicated hostname during staging", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { app } = createApp({ token, required: false });
    expect((await app.request("https://api.egdata.app/health")).status).toBe(
      200,
    );
    expect(
      (await app.request("https://beta-api.egdata.app/health")).status,
    ).toBe(200);
    expect(
      (await app.request("https://origin-api.egdata.app/health")).status,
    ).toBe(403);
    expect(
      (
        await app.request("https://origin-api.egdata.app/health", {
          headers: { "X-Forwarded-Host": "api.egdata.app" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request("https://origin-api.egdata.app/health", {
          headers: { "X-Egdata-Origin-Token": token },
        })
      ).status,
    ).toBe(200);
  });

  it("fails closed on the dedicated hostname even when its token is missing", async () => {
    const { app } = createApp({ token: "", required: false });
    expect(
      (await app.request("https://origin-api.egdata.app/health")).status,
    ).toBe(503);
  });

  it("normalizes hostname case and trailing dots", async () => {
    const { app } = createApp({ token, required: false });
    expect(
      (
        await app.request("https://ORIGIN-API.EGDATA.APP.:443/health", {
          headers: { Forwarded: "host=api.egdata.app" },
        })
      ).status,
    ).toBe(403);
  });
});
