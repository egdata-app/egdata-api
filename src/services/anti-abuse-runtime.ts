import type { MiddlewareHandler } from "hono";
import { Redis, type RedisOptions } from "ioredis";
import {
  type AntiAbuseMode,
  createAntiAbuse,
} from "../middleware/anti-abuse.js";
import {
  AbuseObservations,
  observeAbuseResponses,
  RedisSummaryStore,
} from "./abuse-observation.js";
import { AbuseScorer, RedisRiskStore } from "./abuse-scorer.js";
import { AbuseTrialController } from "./abuse-trial.js";
import { PowCohorts, RedisCohortStore } from "./pow-cohorts.js";
import { PowSessionService } from "./pow-session.js";

/** Select one complete configuration; never mix credentials across hosts. */
export function telemetryRedisOptions(
  env: NodeJS.ProcessEnv = process.env,
): RedisOptions {
  for (const prefix of ["ANTI_ABUSE_REDIS", "CACHE_REDIS"]) {
    const host = env[`${prefix}_HOST`]?.trim();
    const configured = ["PORT", "USER", "PASSWORD", "TLS"].some((key) =>
      env[`${prefix}_${key}`]?.trim(),
    );
    if (!host) {
      if (configured) throw new Error(`${prefix}_HOST is required`);
      continue;
    }
    const port = Number(env[`${prefix}_PORT`] || "6379");
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(`${prefix}_PORT must be an integer between 1 and 65535`);
    const tls = env[`${prefix}_TLS`] || "false";
    if (tls !== "true" && tls !== "false")
      throw new Error(`${prefix}_TLS must be true or false`);
    return {
      host,
      port,
      username: env[`${prefix}_USER`] || undefined,
      password: env[`${prefix}_PASSWORD`] || undefined,
      tls: tls === "true" ? {} : undefined,
    };
  }
  // Backward compatibility only. Operators should use a private local target.
  return {
    host: env.REDISHOST || "127.0.0.1",
    port: Number(env.REDISPORT || "6379"),
    username: env.REDISUSER || undefined,
    password: env.REDISPASSWORD || undefined,
    tls: env.REDISTLS === "true" ? {} : undefined,
  };
}

/** Called after dotenv initialization. No connections or secrets needed in off mode. */
export function createAntiAbuseRuntime() {
  const mode = process.env.ANTI_ABUSE_MODE ?? "off";
  if (!["off", "observe", "enforce"].includes(mode))
    throw new Error("Invalid ANTI_ABUSE_MODE");
  if (mode === "off")
    return {
      middleware: (async (_, next) => next()) satisfies MiddlewareHandler,
      observeResponse: (async (_, next) => next()) satisfies MiddlewareHandler,
      challenge: (async (c) => {
        c.header("Cache-Control", "no-store");
        return c.json({ error: { code: "ANTI_ABUSE_DISABLED" } }, 503);
      }) satisfies MiddlewareHandler,
      close: () => {},
    };
  const sessions = new PowSessionService(process.env.ANTI_ABUSE_SECRET ?? "");
  const redis = new Redis({
    ...telemetryRedisOptions(),
    connectTimeout: 500,
    commandTimeout: 500,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => 5000,
  });
  // Errors are counted by the scorer; do not emit one log line per request.
  redis.on("error", () => {});
  const scorer = new AbuseScorer(new RedisRiskStore(redis));
  const cohorts = new PowCohorts(new RedisCohortStore(redis));
  const observations = new AbuseObservations(
    new RedisSummaryStore(redis),
    Date.now,
    cohorts,
  );
  const trial = new AbuseTrialController(redis);
  observations.start();
  if (mode === "observe") trial.start();
  let last = {
    ...scorer.stats,
    summaryErrors: 0,
    summaryDropped: 0,
    cohortDropped: 0,
    cohortUntracked: 0,
    cohortStoreErrors: 0,
  };
  const metricsTimer = setInterval(() => {
    const current = {
      ...scorer.stats,
      summaryErrors: observations.stats.storeErrors,
      summaryDropped: observations.stats.dropped,
      cohortDropped: cohorts.stats.dropped,
      cohortUntracked: cohorts.stats.untracked,
      cohortStoreErrors: cohorts.stats.storeErrors,
    };
    for (const name of Object.keys(current) as (keyof typeof current)[]) {
      const delta = current[name] - last[name];
      if (delta) observations.increment(`system|${name}`, delta);
    }
    last = current;
  }, 5000);
  metricsTimer.unref();
  return {
    observeResponse: observeAbuseResponses(observations),
    ...createAntiAbuse({
      mode: mode as AntiAbuseMode,
      sessions,
      scorer,
      edgeSecret: process.env.ANTI_ABUSE_EDGE_SECRET,
      trustBotHeaders: process.env.ANTI_ABUSE_TRUST_BOT_HEADERS === "true",
      canaries: process.env.ANTI_ABUSE_CANARIES === "true",
      trial,
    }),
    close: async () => {
      clearInterval(metricsTimer);
      trial.close();
      await observations.close();
      scorer.close();
    },
  };
}
