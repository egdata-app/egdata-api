import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

// Explicitly invoked, bounded smoke test on the user-approved dashboard host.
// Inserts only disposable test identities; never publishes synthetic change records.
if (!process.argv.includes("--run"))
  throw new Error(
    "Use --run to create and remove disposable staging test identities on devs.egdata.app",
  );
const root = resolve(import.meta.dirname, "..");
const dashboard = resolve(root, "dashboard");
const wrangler = resolve(dashboard, "node_modules/wrangler/bin/wrangler.js");
const suffix = randomBytes(8).toString("hex");
const userId = `smoke_user_${suffix}`;
const projectId = `smoke_project_${suffix}`;
const keyId = `key_smoke_${suffix}`;
const rawKey = `egk_live_${randomBytes(24).toString("hex")}`;
const keyHash = createHash("sha256").update(rawKey).digest("hex");
const temp = resolve(root, ".tmp", `endpoint-alerts-${suffix}.sql`);
mkdirSync(resolve(root, ".tmp"), { recursive: true });
function command(args) {
  return execFileSync(process.execPath, [wrangler, ...args], {
    cwd: dashboard,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function sql(text) {
  writeFileSync(temp, text);
  return JSON.parse(
    command([
      "d1",
      "execute",
      "egdata-dashboard-db",
      "--remote",
      "--config",
      "wrangler.migrations.jsonc",
      "--file",
      temp,
      "--json",
    ]),
  );
}
const evidence = [];
try {
  sql(`INSERT INTO users(epic_account_id,display_name) VALUES('${userId}','Disposable endpoint-alerts verification');
    INSERT INTO projects(id,owner_epic_id,name,slug) VALUES('${projectId}','${userId}','Disposable endpoint-alerts verification','${projectId}');
    INSERT INTO api_keys(id,project_id,owner_epic_id,name,key_prefix,key_hash,scopes_json,allowed_methods_json,custom_rpm,expires_at) VALUES('${keyId}','${projectId}','${userId}','Disposable smoke key','smoke-redacted','${keyHash}','["catalog:read"]','["GET"]',2,'${new Date(Date.now() + 120_000).toISOString()}');`);
  const minuteOffset = Date.now() % 60_000;
  if (minuteOffset > 50_000)
    await new Promise((resolve) => setTimeout(resolve, 61_000 - minuteOffset));
  for (const test of [
    { path: "/v1/countries", key: false, expected: 401 },
    { path: "/v1/countries", method: "OPTIONS", key: true, expected: 204 },
    { path: "/v1/not-registered", key: true, expected: 404 },
    { path: "/v1/offers/abc", key: true, expected: 403 },
    { path: "/v1/countries", key: true, expected: 200 },
    { path: "/v1/countries", key: true, expected: 200 },
    { path: "/v1/countries", key: true, expected: 429 },
  ]) {
    const response = await fetch(`https://devs.egdata.app/proxy${test.path}`, {
      method: test.method ?? "GET",
      headers: test.key ? { "X-API-Key": rawKey } : {},
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    evidence.push({
      path: test.path,
      method: test.method ?? "GET",
      status: response.status,
      expected: test.expected,
    });
    await response.body?.cancel();
    if (response.status !== test.expected)
      throw new Error(`Unexpected status ${response.status} for ${test.path}`);
  }
  let buckets = [];
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const result = sql(
      `SELECT operation_id,usage_date,first_used_at FROM usage_daily WHERE key_id='${keyId}';`,
    );
    buckets = result[0]?.results ?? [];
    if (buckets.length) break;
  }
  if (buckets.length !== 1 || buckets[0].operation_id !== "listCountries")
    throw new Error(
      "Expected exactly one durable usage bucket for admitted country requests",
    );
  evidence.push({
    dailyBuckets: buckets.length,
    operationId: buckets[0].operation_id,
    usageDate: buckets[0].usage_date,
  });
  console.log(JSON.stringify({ ok: true, evidence }, null, 2));
} finally {
  // Revoke in the authority before removing cached metadata; no raw secret is persisted.
  sql(
    `UPDATE api_keys SET active=0,revoked_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id='${keyId}';`,
  );
  command([
    "kv",
    "key",
    "delete",
    `apikey:${keyHash}`,
    "--binding",
    "API_KEYS_KV",
    "--remote",
  ]);
  sql(
    `DELETE FROM usage_daily WHERE key_id='${keyId}'; DELETE FROM alert_reads WHERE project_id='${projectId}'; DELETE FROM alert_matches WHERE project_id='${projectId}'; DELETE FROM project_alerts WHERE project_id='${projectId}'; DELETE FROM api_keys WHERE id='${keyId}'; DELETE FROM projects WHERE id='${projectId}'; DELETE FROM users WHERE epic_account_id='${userId}';`,
  );
  unlinkSync(temp);
}
