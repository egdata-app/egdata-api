import { Hono } from "hono";
import sharedRedis from "../../clients/redis.js";
import { db } from "../../db/index.js";
import { buildV1OpenApiDocument } from "../../openapi/v1.js";
import { parseStrictQuery } from "../query.js";
import type { V1Variables } from "../request-context.js";
import { publicJson } from "../response.js";

const app = new Hono<{ Variables: V1Variables }>();

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms),
    ),
  ]);
}

app.get("/health", async (c) => {
  parseStrictQuery(c, {});
  const redisStart = Date.now();
  let redisStatus: "ok" | "error" = "ok";
  let redisLatency: number | null = null;
  try {
    await withTimeout(sharedRedis.ping(), 1_500);
    redisLatency = Date.now() - redisStart;
  } catch {
    redisStatus = "error";
  }

  const mongoStart = Date.now();
  let mongoStatus: "ok" | "error" = "ok";
  let mongoLatency: number | null = null;
  try {
    await withTimeout(db.db.command({ ping: 1 }), 1_500);
    mongoLatency = Date.now() - mongoStart;
  } catch {
    mongoStatus = "error";
  }

  const ok = redisStatus === "ok" && mongoStatus === "ok";
  return publicJson(
    c,
    {
      status: ok ? "ok" : "error",
      services: {
        redis: { status: redisStatus, latencyMs: redisLatency },
        mongodb: { status: mongoStatus, latencyMs: mongoLatency },
      },
    },
    { apiVersion: "v1" },
    ok ? 200 : 503,
  );
});

app.get("/open-api.json", (c) => {
  parseStrictQuery(c, {});
  // This is a contract document consumed directly by OpenAPI tooling, so it is
  // served as the raw document rather than inside the data/meta envelope.
  return c.json(buildV1OpenApiDocument(), 200, {
    "Cache-Control": "public, max-age=60",
    "CDN-Cache-Control": "no-store",
    "X-Request-Id": c.get("requestId") as string,
  });
});

export default app;
