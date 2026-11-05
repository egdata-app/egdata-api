import type { MiddlewareHandler } from "hono";
import { Redis } from "ioredis";
import {
  type AntiAbuseMode,
  createAntiAbuse,
} from "../middleware/anti-abuse.js";
import { AbuseScorer, RedisRiskStore } from "./abuse-scorer.js";
import { PowSessionService } from "./pow-session.js";

/** Called after dotenv initialization. No connections or secrets needed in off mode. */
export function createAntiAbuseRuntime() {
  const mode = process.env.ANTI_ABUSE_MODE ?? "off";
  if (!["off", "observe", "enforce"].includes(mode))
    throw new Error("Invalid ANTI_ABUSE_MODE");
  if (mode === "off")
    return {
      middleware: (async (_, next) => next()) satisfies MiddlewareHandler,
      challenge: (async (c) => {
        c.header("Cache-Control", "no-store");
        return c.json({ error: { code: "ANTI_ABUSE_DISABLED" } }, 503);
      }) satisfies MiddlewareHandler,
      close: () => {},
    };
  const sessions = new PowSessionService(process.env.ANTI_ABUSE_SECRET ?? "");
  const redis = new Redis({
    host: process.env.REDISHOST || "127.0.0.1",
    port: Number(process.env.REDISPORT || "6379"),
    username: process.env.REDISUSER || undefined,
    password: process.env.REDISPASSWORD || undefined,
    tls: process.env.REDISTLS === "true" ? {} : undefined,
    connectTimeout: 500,
    commandTimeout: 500,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => 5000,
  });
  // Errors are counted by the scorer; do not emit one log line per request.
  redis.on("error", () => {});
  const scorer = new AbuseScorer(new RedisRiskStore(redis));
  return {
    ...createAntiAbuse({
      mode: mode as AntiAbuseMode,
      sessions,
      scorer,
      edgeSecret: process.env.ANTI_ABUSE_EDGE_SECRET,
      canaries: process.env.ANTI_ABUSE_CANARIES === "true",
    }),
    close: () => scorer.close(),
  };
}
