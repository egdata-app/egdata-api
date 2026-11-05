import { gunzipSync } from "node:zlib";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { describe, expect, it } from "vitest";

const createApp = () => {
  const app = new Hono();
  app.use("/*", compress({ threshold: 128 }));
  app.get("/json", (c) =>
    c.json({ payload: "compressible-json-".repeat(100) }),
  );
  app.get("/image", (c) =>
    c.body(new Uint8Array(512), 200, { "Content-Type": "image/png" }),
  );
  return app;
};

describe("origin compression", () => {
  it("gzip-compresses JSON when the client accepts gzip", async () => {
    const response = await createApp().request("/json", {
      headers: { "Accept-Encoding": "gzip" },
    });
    const body = Buffer.from(await response.arrayBuffer());

    expect(response.headers.get("Content-Encoding")).toBe("gzip");
    expect(body.length).toBeLessThan(200);
    expect(gunzipSync(body).toString("utf8")).toContain("compressible-json");
  });

  it("does not compress already-compressed image responses", async () => {
    const response = await createApp().request("/image", {
      headers: { "Accept-Encoding": "gzip" },
    });

    expect(response.headers.get("Content-Encoding")).toBeNull();
    expect(response.headers.get("Content-Type")).toBe("image/png");
  });

  it("leaves the response uncompressed when gzip is not accepted", async () => {
    const response = await createApp().request("/json", {
      headers: { "Accept-Encoding": "identity" },
    });

    expect(response.headers.get("Content-Encoding")).toBeNull();
  });
});
