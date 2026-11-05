import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { edgeCacheHeaders } from "../src/middlewares/edge-cache.js";

const createApp = () => {
  const app = new Hono();
  app.use("/*", edgeCacheHeaders);
  app.get("/offers", (c) => c.json({ elements: [] }));
  app.get("/countries", (c) => c.json({ US: {} }));
  app.get("/profiles/example", (c) => c.json({ id: "example" }));
  app.get("/profiles/example/information", (c) =>
    c.json({ id: "example", donations: [] }, 200, {
      "Cache-Control": "no-cache",
    }),
  );
  app.get("/profiles/me", (c) => c.json({ id: "me" }));
  app.get("/auth/session", (c) => c.json({ ok: true }));
  app.get("/offers/abc/og", (c) =>
    c.body(new Uint8Array(1), 200, { "Content-Type": "image/png" }),
  );
  app.get("/free-games", (c) =>
    c.json([], 200, { "Cache-Control": "private, max-age=0" }),
  );
  return app;
};

describe("edge cache headers", () => {
  it("adds shared-cache headers to public offer lists", async () => {
    const response = await createApp().request("/offers");

    expect(response.headers.get("Cache-Control")).toContain("s-maxage=300");
    expect(response.headers.get("CDN-Cache-Control")).toContain(
      "stale-while-revalidate",
    );
  });

  it("uses a longer TTL for country metadata", async () => {
    const response = await createApp().request("/countries");

    expect(response.headers.get("Cache-Control")).toContain("max-age=3600");
  });

  it("skips personalised and authenticated routes", async () => {
    for (const path of [
      "/profiles/me",
      "/profiles/example/information",
      "/auth/session",
    ]) {
      const response = await createApp().request(path);
      expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    }
  });

  it("skips generated images and routes that opt out", async () => {
    const image = await createApp().request("/offers/abc/og");
    const freeGames = await createApp().request("/free-games");

    expect(image.headers.get("CDN-Cache-Control")).toBeNull();
    expect(freeGames.headers.get("Cache-Control")).toBe("private, max-age=0");
  });
});
