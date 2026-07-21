import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { describe, expect, it } from "vitest";
import { catalogHydrationRootKey } from "../src/catalog/hydration.js";
import { responseEtag } from "../src/middlewares/response-etag.js";
import type { CatalogHydrationReader } from "../src/routes/catalog-hydrate.js";
import { createCatalogHydrateRoute } from "../src/routes/catalog-hydrate.js";

const identifier = {
  type: "item" as const,
  namespace: "test-namespace",
  id: "test-item",
};

const reader: CatalogHydrationReader = {
  resolve: async (value) => ({
    schemaVersion: 2,
    rootKey: catalogHydrationRootKey(value),
    identifier: value,
    hydratedAt: "2026-07-20T10:00:00.000Z",
    status: "unchanged",
    graphHash: "b".repeat(64),
  }),
};

const request = (identifiers: unknown[]) => ({
  schemaVersion: 2,
  identifiers,
  knownRoots: [],
  knownRecords: [],
});

describe("catalog hydration route", () => {
  it("streams one independently parseable NDJSON result per root", async () => {
    const second = { type: "item" as const, namespace: "ue", id: "missing" };
    const response = await createCatalogHydrateRoute(reader).request(
      "/hydrate",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request([identifier, second])),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "application/x-ndjson",
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const lines = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      schemaVersion: 2,
      status: "unchanged",
      identifier,
    });
    expect(lines[1]).toMatchObject({ status: "unchanged", identifier: second });
  });

  it("allows outer CORS middleware to finalize headers before streaming", async () => {
    const app = new Hono();
    app.use(
      "*",
      cors({
        origin: (origin) => origin || "https://egdata.app",
        credentials: true,
      }),
    );
    app.use("*", responseEtag);
    app.route("/catalog", createCatalogHydrateRoute(reader));
    const server = serve({ fetch: app.fetch, port: 0 });
    await once(server, "listening");
    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(
        `http://127.0.0.1:${address.port}/catalog/hydrate`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost",
          },
          body: JSON.stringify(request([identifier])),
        },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "http://localhost",
      );
      expect(response.headers.get("vary")).toContain("Origin");
      expect(response.headers.has("etag")).toBe(false);
      expect((await response.text()).trim()).toContain('"status":"unchanged"');
    } finally {
      server.close();
    }
  });

  it("rejects v1, duplicate, malformed, and oversized requests", async () => {
    const app = createCatalogHydrateRoute(reader);
    for (const body of [
      { ...request([identifier]), schemaVersion: 1 },
      request([identifier, identifier]),
    ]) {
      const response = await app.request("/hydrate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    const malformed = await app.request("/hydrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    expect(malformed.status).toBe(400);
    const oversized = await app.request("/hydrate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(300 * 1024),
      },
      body: "{}",
    });
    expect(oversized.status).toBe(413);
  });

  it("isolates and sanitizes a root failure without failing its sibling", async () => {
    const app = createCatalogHydrateRoute({
      resolve: async (value) => {
        if (value.namespace === "ue")
          throw new Error("mongodb://secret-host/private");
        return reader.resolve(value, request([value]) as never);
      },
    });
    const response = await app.request("/hydrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        request([identifier, { type: "item", namespace: "ue", id: "missing" }]),
      ),
    });
    const lines = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.map((line) => line.status)).toEqual(["unchanged", "error"]);
    expect(JSON.stringify(lines)).not.toContain("secret-host");
  });
});
