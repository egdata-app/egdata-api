#!/usr/bin/env node
/**
 * Measures end-to-end and quota-gateway latency against a deployed v1 gateway.
 *
 * Usage:
 *   V1_BENCH_URL=https://devs.egdata.app/proxy/v1/countries \
 *   V1_BENCH_API_KEY=egk_... \
 *   node scripts/benchmark-v1-latency.mjs
 *
 * Run from Europe, North America, and Asia with Smart Placement disabled and
 * record p50/p95 separately. This only measures the deployed path; it does not
 * replace staging Durable Object billing metrics.
 */
const url = process.env.V1_BENCH_URL;
const apiKey = process.env.V1_BENCH_API_KEY;
const iterations = Number.parseInt(process.env.V1_BENCH_ITERATIONS || "50", 10);
const label = process.env.V1_BENCH_REGION || "unspecified";

if (!url || !apiKey) {
  console.error("V1_BENCH_URL and V1_BENCH_API_KEY are required.");
  process.exit(1);
}
if (!Number.isInteger(iterations) || iterations < 5 || iterations > 500) {
  console.error("V1_BENCH_ITERATIONS must be an integer between 5 and 500.");
  process.exit(1);
}

const samples = [];
for (let index = 0; index < iterations + 5; index++) {
  const started = performance.now();
  const response = await fetch(url, {
    headers: { "X-API-Key": apiKey, "X-Benchmark-Region": label },
  });
  if (!response.ok) {
    console.error(`Request failed: ${response.status} ${await response.text()}`);
    process.exit(1);
  }
  await response.arrayBuffer();
  const elapsed = performance.now() - started;
  if (index >= 5) samples.push(elapsed);
}

samples.sort((a, b) => a - b);
const percentile = (p) =>
  samples[Math.min(samples.length - 1, Math.ceil((p / 100) * samples.length) - 1)];
const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;

console.log(
  JSON.stringify(
    {
      region: label,
      url,
      iterations,
      p50Ms: Number(percentile(50).toFixed(2)),
      p95Ms: Number(percentile(95).toFixed(2)),
      meanMs: Number(mean.toFixed(2)),
      minMs: Number(samples[0].toFixed(2)),
      maxMs: Number(samples.at(-1).toFixed(2)),
    },
    null,
    2,
  ),
);
