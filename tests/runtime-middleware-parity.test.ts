import { Hono } from "hono";
import { compress } from "hono/compress";
import { afterEach, expect, it, vi } from "vitest";
import { apiCors } from "../src/middlewares/cors.js";
import { edgeCacheHeaders } from "../src/middlewares/edge-cache.js";
import { originAuth } from "../src/middlewares/origin-auth.js";

const originToken = "middleware-audit-origin-token";
const workerToken = "middleware-audit-worker-token";

afterEach(() => {
  vi.unstubAllEnvs();
});

async function nodeRuntimeRouter() {
  vi.resetModules();
  vi.stubEnv("V1_WORKER_TOKEN", workerToken);
  vi.stubEnv("V1_WORKER_AUTH_REQUIRED", "true");
  const { default: v1Router } = await import("../src/v1/router.js");
  const app = new Hono();
  app.use("/*", originAuth({ token: originToken, required: false }));
  app.use("/*", compress({ threshold: 512 }));
  app.use("/*", apiCors());
  app.route("/v1", v1Router);
  // These global middleware are registered after `/v1` in src/index.ts.
  app.use("/*", edgeCacheHeaders);
  return app;
}

function headers(acceptEncoding?: string) {
  return {
    ...(acceptEncoding === undefined
      ? {}
      : { "accept-encoding": acceptEncoding }),
    origin: "https://egdata.app",
    "x-egdata-origin-token": originToken,
    "x-egdata-worker-token": workerToken,
    "x-egdata-key-id": "key_middleware_audit",
    "x-egdata-key-tier": "free",
    "x-request-id": "req_middleware_audit",
  };
}

it("captures canonical outer middleware negotiation, HEAD, and CORS variation", async () => {
  const app = await nodeRuntimeRouter();
  const protectedHostHeaders = {
    ...headers("gzip"),
    "x-egdata-origin-token": "",
  };
  const protectedHost = await app.request(
    "https://origin-api.egdata.app/v1/countries",
    { headers: protectedHostHeaders },
  );
  expect(protectedHost.status).toBe(403);
  expect(protectedHost.headers.get("access-control-allow-origin")).toBeNull();

  const preflight = await app.request("/v1/countries", {
    method: "OPTIONS",
    headers: {
      ...headers(),
      "access-control-request-method": "GET",
    },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-methods")).toBe(
    "GET,HEAD,PUT,POST,DELETE,PATCH",
  );

  const noEncoding = await app.request("/v1/countries", { headers: headers() });
  expect(noEncoding.status).toBe(200);
  expect(noEncoding.headers.get("content-encoding")).toBeNull();
  expect(noEncoding.headers.get("etag")?.startsWith("W/")).toBe(false);
  expect(noEncoding.headers.get("access-control-allow-origin")).toBe(
    "https://egdata.app",
  );
  const vary = noEncoding.headers.get("vary")?.toLowerCase() ?? "";
  expect(vary).toContain("origin");
  expect(vary).not.toContain("accept-encoding");

  const qualityZero = await app.request("/v1/countries", {
    headers: headers("gzip;q=0, deflate"),
  });
  expect(qualityZero.headers.get("content-encoding")).toBe("gzip");
  expect(qualityZero.headers.get("etag")?.startsWith("W/")).toBe(true);

  const deflate = await app.request("/v1/countries", {
    headers: headers("deflate"),
  });
  expect(deflate.headers.get("content-encoding")).toBe("deflate");

  const tiny = await app.request("/v1/health", {
    headers: headers("gzip"),
  });
  expect(tiny.headers.get("content-length")).toBeNull();
  expect(tiny.headers.get("content-encoding")).toBe("gzip");

  const head = await app.request("/v1/countries", {
    method: "HEAD",
    headers: headers("gzip, deflate"),
  });
  expect(head.status).toBe(200);
  expect(head.headers.get("content-encoding")).toBeNull();
  expect(await head.text()).toBe("");
});
