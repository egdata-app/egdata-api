import { config } from "dotenv";
import { Redis } from "ioredis";
import {
  powCounters,
  SUMMARY_PREFIX,
} from "../src/services/abuse-observation.js";
import { parseTrial, TRIAL_KEY } from "../src/services/abuse-trial.js";
import { telemetryRedisOptions } from "../src/services/anti-abuse-runtime.js";

config({ quiet: true });
const [command, ...args] = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
};
if (!["report", "status", "start-trial", "stop-trial"].includes(command))
  throw new Error(
    "Use report [--minutes 60], status, start-trial --id ID --fingerprint HASH --route offer-details --seconds 120, or stop-trial --id ID. Run inside the deployed API container to use its Redis configuration.",
  );
const redis = new Redis({
  ...telemetryRedisOptions(),
  lazyConnect: true,
  connectTimeout: 2000,
  commandTimeout: 3000,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
});
redis.on("error", () => {});
try {
  await redis.connect();
  if (command === "status") {
    const trial = parseTrial(await redis.get(TRIAL_KEY));
    console.log(
      JSON.stringify({
        mode: process.env.ANTI_ABUSE_MODE ?? "off",
        canaries: process.env.ANTI_ABUSE_CANARIES === "true",
        trial: trial
          ? {
              id: trial.id,
              expiresAt: new Date(trial.expiresAt).toISOString(),
              route: trial.route,
              fingerprints: trial.fingerprints.length,
            }
          : null,
      }),
    );
  } else if (command === "start-trial") {
    if (
      process.env.ANTI_ABUSE_MODE !== "observe" ||
      process.env.ANTI_ABUSE_CANARIES === "true"
    )
      throw new Error(
        "A scoped trial requires observe mode with canaries disabled",
      );
    const now = Date.now(),
      seconds = Number(option("seconds") ?? "120");
    const trial = parseTrial(
      JSON.stringify({
        id: option("id"),
        createdAt: now,
        expiresAt: now + seconds * 1000,
        route: option("route") ?? "offer-details",
        fingerprints: [option("fingerprint")],
      }),
      now,
    );
    if (!trial)
      throw new Error(
        "Invalid trial: require an ID, exact SHA256 fingerprint, supported route and duration <= 900 seconds",
      );
    const written = await redis.set(
      TRIAL_KEY,
      JSON.stringify(trial),
      "PX",
      trial.expiresAt - now,
      "NX",
    );
    if (!written)
      throw new Error("Another trial exists; stop it by ID or wait for expiry");
    console.log(
      JSON.stringify({
        started: trial.id,
        expiresAt: new Date(trial.expiresAt).toISOString(),
        route: trial.route,
      }),
    );
  } else if (command === "stop-trial") {
    const id = option("id");
    if (!id || !/^[a-zA-Z0-9_-]{1,64}$/.test(id))
      throw new Error("A trial ID is required");
    const stopped = await redis.eval(
      "local v=redis.call('GET',KEYS[1]); if v and cjson.decode(v).id == ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",
      1,
      TRIAL_KEY,
      id,
    );
    console.log(
      JSON.stringify({ id, stopped: stopped === 1, rollbackWithinSeconds: 2 }),
    );
  } else {
    const minutes = Number(option("minutes") ?? "60");
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)
      throw new Error("minutes must be between 1 and 1440");
    const current = Math.floor(Date.now() / 60000),
      totals: Record<string, number> = {},
      byScope: Record<string, Record<string, number>> = {},
      byRoute: Record<string, { requests: number; bodyBytes: number }> = {};
    let buckets = 0;
    for (let offset = 0; offset < minutes; offset += 30) {
      const pipeline = redis.pipeline();
      for (let i = offset; i < Math.min(minutes, offset + 30); i++)
        pipeline.hgetall(`${SUMMARY_PREFIX}${current - i}`);
      for (const [error, data] of (await pipeline.exec()) ?? []) {
        if (error) throw new Error("Unable to read summary bucket");
        const row = data as Record<string, string>;
        if (Object.keys(row).length) buckets++;
        for (const [field, raw] of Object.entries(row)) {
          if (field.startsWith("__")) continue;
          const value = Number(raw),
            parts = field.split("|"),
            metric = parts.at(-1) ?? field;
          totals[metric] = (totals[metric] ?? 0) + value;
          if (parts.length === 5) {
            const scope = parts[0];
            byScope[scope] ??= {};
            byScope[scope][metric] = (byScope[scope][metric] ?? 0) + value;
            const group = parts.slice(0, 4).join("|");
            byRoute[group] ??= { requests: 0, bodyBytes: 0 };
            if (metric === "requests" || metric === "bodyBytes")
              byRoute[group][metric] += value;
          }
        }
      }
    }
    console.log(
      JSON.stringify(
        {
          observedAt: new Date().toISOString(),
          requestedMinutes: minutes,
          bucketsWithData: buckets,
          totals,
          pow: {
            totals: powCounters(totals),
            byScope: Object.fromEntries(
              Object.entries(byScope).map(([scope, values]) => [
                scope,
                powCounters(values),
              ]),
            ),
            limitations:
              "Request/attempt counts, not unique puzzles or users. Accepted proof replays count again. passedWithSession means admitted to a route, not successful browser recovery. Old buckets have no PoW coverage; inspect observedResponses. No browser failures, abandonment or Cloudflare cache hits are recorded. Handshakes use the global mode scope; scoped-trial handshakes appear under observe.",
          },
          routes: Object.entries(byRoute)
            .sort((a, b) => b[1].bodyBytes - a[1].bodyBytes)
            .slice(0, 40)
            .map(([group, values]) => ({ group, ...values })),
          limitations:
            "Origin response-body bytes as consumed after app compression; excludes cache hits, transport overhead and requests rejected before anti-abuse. Best-effort summaries, not a billing report.",
        },
        null,
        2,
      ),
    );
  }
} finally {
  redis.disconnect();
}
