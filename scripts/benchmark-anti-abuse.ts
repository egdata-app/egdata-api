import { performance } from "node:perf_hooks";
import { Hono } from "hono";
import {
  createAntiAbuse,
  extractFingerprint,
} from "../src/middleware/anti-abuse.js";
import {
  AbuseObservations,
  observeAbuseResponses,
} from "../src/services/abuse-observation.js";
import { AbuseScorer } from "../src/services/abuse-scorer.js";
import {
  PowSessionService,
  verifyProofOfWork,
} from "../src/services/pow-session.js";

// Local reproducible microbenchmark. No secrets, database, or network required.
const sessions = new PowSessionService(
  "benchmark-only-signing-secret-32-bytes",
);
const scorer = new AbuseScorer();
const requestHeaders = {
  accept: "application/json",
  "user-agent": "benchmark",
};
const request = new Request("https://api.test/items", {
  headers: requestHeaders,
});
const fp = extractFingerprint(request);
const challenge = await sessions.challenge(fp.fingerprintHash, 0);
let nonce = 0;
while (
  !verifyProofOfWork(challenge.challenge, String(nonce), challenge.difficulty)
)
  nonce++;
const redeemed = await sessions.redeem(
  challenge.challenge,
  String(nonce),
  fp.fingerprintHash,
);
if (!redeemed) throw new Error("Benchmark proof failed");
const token = redeemed.token;
const headers = { ...requestHeaders, "x-egdata-session": token };

async function measure(run: () => unknown | Promise<unknown>) {
  for (let i = 0; i < 250; i++) await run();
  const samples: number[] = [];
  for (let i = 0; i < 2000; i++) {
    const start = performance.now();
    await run();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return { median: samples[1000], p95: samples[1900], p99: samples[1980] };
}

const fast = await measure(async () => {
  const fingerprint = extractFingerprint(request);
  const session = await sessions.verify(token, fingerprint.fingerprintHash);
  scorer.risk([`session:${session?.sessionId}`]);
});
const baseline = new Hono();
baseline.get("/items", (c) => c.json({ elements: [] }));
const protectedApp = new Hono();
const observations = new AbuseObservations({ write: async () => {} });
protectedApp.use("*", observeAbuseResponses(observations));
protectedApp.use(
  "*",
  // This deliberately repetitive workload now triggers route-hammering. Measure
  // scoring/verification overhead in observe mode, excluding intentional delays.
  createAntiAbuse({ mode: "observe", sessions, scorer }).middleware,
);
protectedApp.get("/items", (c) => c.json({ elements: [] }));
const plain = await measure(async () =>
  (await baseline.request("/items", { headers })).arrayBuffer(),
);
const protectedTiming = await measure(async () =>
  (await protectedApp.request("/items", { headers })).arrayBuffer(),
);
await scorer.drain();
scorer.close();
await observations.close();
console.log(
  JSON.stringify(
    {
      unit: "milliseconds",
      samples: 2000,
      concurrency: 1,
      fastPath: fast,
      baselineHono: plain,
      protectedHono: protectedTiming,
      addedP95: protectedTiming.p95 - plain.p95,
      note: "Observe mode with a valid session and warm local cache; includes Hono request construction. Excludes canary parsing, intentional tarpits, network and production load.",
    },
    null,
    2,
  ),
);
