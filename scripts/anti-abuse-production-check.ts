/** Explicit operator smoke test. Uses a unique header NAME to isolate its
 * fingerprint; synthetic risk is never written to another client's bucket.
 * Run inside the deployed API container. Always restores observe in finally. */
import { createHash, randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { APPEND_WINDOW_SCRIPT } from "../src/services/abuse-scorer.js";
import { TRIAL_KEY } from "../src/services/abuse-trial.js";
import { riskRedisKeys } from "../src/services/abuse-version.js";
import { telemetryRedisOptions } from "../src/services/anti-abuse-runtime.js";

if (
  !process.argv.includes("--run") ||
  process.env.ANTI_ABUSE_MODE !== "observe" ||
  process.env.ANTI_ABUSE_CANARIES === "true"
)
  throw new Error(
    "Explicit --run, observe mode, and disabled canaries are required",
  );
const base = "https://api.egdata.app",
  trialId = `smoke-${randomUUID()}`;
const headers: Record<string, string> = {
  "user-agent": "egdata-controlled-trial",
  accept: "application/json",
  [`egdata-validation-${randomUUID().replaceAll("-", "")}`]: "1",
};
const redis = new Redis({
  ...telemetryRedisOptions(),
  lazyConnect: true,
  connectTimeout: 2000,
  commandTimeout: 3000,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
});
redis.on("error", () => {});
let fp = "",
  trialStarted = false;
let probeStep = 0;
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const assert = (ok: unknown, message: string) => {
  if (!ok) throw new Error(message);
};
async function request(path: string, body?: unknown, token?: string) {
  const start = performance.now();
  // Deliberately unique probe URLs reach the origin without changing cache rules.
  const target =
    body === undefined && path.startsWith("/offers/")
      ? `${path}${path.includes("?") ? "&" : "?"}probe_step=${probeStep++}`
      : path;
  const response = await fetch(base + target, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...headers,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { "x-egdata-session": token } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(12000),
  });
  const json = await response.json();
  return { response, json, ms: performance.now() - start };
}
try {
  await redis.connect();
  assert(
    !(await redis.exists(TRIAL_KEY)),
    "An operator trial is already active",
  );
  const initial = await request("/auth/challenge", {});
  fp = JSON.parse(
    Buffer.from(initial.json.challenge.split(".")[0], "base64url").toString(),
  ).fingerprintHash;
  assert(/^[a-f0-9]{64}$/.test(fp), "No valid trusted fingerprint");
  const list = await request("/offers?limit=1&country=US");
  const offerId = list.json.elements?.[0]?.id;
  assert(
    typeof offerId === "string" && /^[a-f0-9]{32}$/.test(offerId),
    "Could not select a public offer",
  );
  const path = `/offers/${offerId}?abuse_probe=${trialId}`;
  const clean = await request(path);
  assert(
    clean.response.status === 200 && !clean.json.error,
    "Clean tokenless request failed",
  );
  const keys = riskRedisKeys(`fp:${fp}`);
  const now = Date.now();
  // 30 unique resources with irregular intervals produce suspicious risk.
  for (let i = 0; i < 30; i++)
    await redis.eval(
      APPEND_WINDOW_SCRIPT,
      2,
      ...keys,
      JSON.stringify({
        at: now - 15000 + Math.floor(i / 2) * 1000 + (i % 2 ? 100 : 0),
        deep: true,
        support: false,
        route: "/offers/probe",
        itemId: `probe-${i}`,
        mismatch: 0,
      }),
      randomUUID(),
    );
  const expiry = Date.now() + 120000;
  const started = await redis.set(
    TRIAL_KEY,
    JSON.stringify({
      id: trialId,
      createdAt: expiry - 120000,
      expiresAt: expiry,
      fingerprints: [fp],
      route: "offer-details",
    }),
    "PX",
    120000,
    "NX",
  );
  assert(started, "Another trial was started concurrently");
  trialStarted = true;
  await sleep(2500);
  let challenged = await request(path);
  for (
    let i = 0;
    i < 6 && challenged.json.error?.code !== "SESSION_CHALLENGE_REQUIRED";
    i++
  ) {
    await sleep(300);
    challenged = await request(path);
  }
  assert(
    challenged.json.error?.code === "SESSION_CHALLENGE_REQUIRED",
    "Scoped challenge was not enforced",
  );
  assert(
    challenged.response.headers.get("cache-control")?.includes("no-store"),
    "Challenge was cacheable",
  );
  const challenge = (await request("/auth/challenge", {})).json;
  assert(challenge.difficulty === 20, "Expected higher-difficulty PoW");
  let nonce = 0;
  for (; ; nonce++) {
    const hash = createHash("sha256")
      .update(`${challenge.challenge}:${nonce}`)
      .digest();
    if (hash[0] === 0 && hash[1] === 0 && (hash[2] & 0xf0) === 0) break;
    if (Date.now() >= challenge.expiresAt) throw new Error("Proof timed out");
  }
  const redeemed = (
    await request("/auth/challenge", {
      challenge: challenge.challenge,
      nonce: String(nonce),
    })
  ).json;
  assert(typeof redeemed.token === "string", "PoW redemption failed");
  const retried = await request(path, undefined, redeemed.token);
  assert(
    retried.response.status === 200 && !retried.json.error,
    "Session retry failed",
  );
  // The sticky trap belongs solely to this unique test fingerprint.
  await redis.set(keys[1], "1", "PX", 30000);
  let tarpit = await request(path, undefined, redeemed.token);
  for (let i = 0; i < 5 && tarpit.json.limit !== 0; i++) {
    await sleep(300);
    tarpit = await request(path, undefined, redeemed.token);
  }
  assert(
    tarpit.json.limit === 0 && tarpit.json.total === 0 && tarpit.ms >= 2900,
    "Confirmed-risk tarpit was not enforced",
  );
  assert(
    tarpit.response.headers.get("cache-control")?.includes("no-store"),
    "Truncated response was cacheable",
  );
  const outside = await request("/countries");
  assert(
    outside.response.status === 200 && !outside.json.error,
    "Trial affected an unselected path",
  );
  await redis.eval(
    "local v=redis.call('GET',KEYS[1]); if v and cjson.decode(v).id == ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",
    1,
    TRIAL_KEY,
    trialId,
  );
  trialStarted = false;
  await sleep(2500);
  const recovered = await request(path);
  assert(
    recovered.response.status === 200 &&
      recovered.json.limit !== 0 &&
      !recovered.json.error,
    "Rollback did not restore normal access",
  );
  console.log(
    JSON.stringify({
      passed: true,
      scope: "unique synthetic fingerprint only",
      challenge: true,
      powDifficulty: 20,
      sessionRetry: true,
      tarpitMs: Math.round(tarpit.ms),
      rollback: true,
      mode: "observe",
      canaries: false,
    }),
  );
} finally {
  try {
    if (trialStarted)
      await redis.eval(
        "local v=redis.call('GET',KEYS[1]); if v and cjson.decode(v).id == ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",
        1,
        TRIAL_KEY,
        trialId,
      );
    if (/^[a-f0-9]{64}$/.test(fp))
      await redis.del(...riskRedisKeys(`fp:${fp}`));
  } finally {
    redis.disconnect();
  }
}
