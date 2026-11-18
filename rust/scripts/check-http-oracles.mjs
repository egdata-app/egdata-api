// Execute the canonical Node handlers, check their fixtures, then compare Rust.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const rust = fileURLToPath(new URL("../", import.meta.url));
const tests = fs
  .readdirSync(new URL("../../tests/", import.meta.url))
  .filter((name) => /^rust-.*(?:-oracle|-render)\.test\.ts$/.test(name))
  .sort();
const fixturesDir = new URL(
  "../crates/egdata-api/tests/fixtures/",
  import.meta.url,
);
const env = { ...process.env, RUST_ORACLE_WRITE: "0" };
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(process.execPath, ["rust/scripts/check-og-fixtures.mjs"], root);
run(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    "tests/runtime-middleware-parity.test.ts",
    "tests/legacy-epic-session.test.ts",
    "tests/og-render-parity.test.ts",
    ...tests.map((name) => "tests/" + name),
    "tests/graphql-offers-oracle.test.ts",
    "tests/graphql-validation.test.ts",
    "tests/graphql-apq.test.ts",
  ],
  root,
);
let count = 0;
const contract = JSON.parse(
  fs.readFileSync(
    new URL("../../openapi/egdata.v1.openapi.json", import.meta.url),
    "utf8",
  ),
);
const operations = new Set();
const paths = Object.entries(contract.paths).sort(
  ([a], [b]) => (a.match(/\{/g)?.length ?? 0) - (b.match(/\{/g)?.length ?? 0),
);
for (const suite of fs
  .readdirSync(fixturesDir)
  .filter((name) => name.endsWith(".json"))
  .sort()) {
  const fixture = JSON.parse(
    fs.readFileSync(new URL(suite, fixturesDir), "utf8"),
  );
  if (!Array.isArray(fixture)) continue;
  const cases = fixture.filter((row) => row?.request?.path?.startsWith("/v1/"));
  if (!cases.length) continue;
  if (new Set(cases.map((value) => value.name)).size !== cases.length) {
    throw new Error(`Duplicate case names in ${suite}`);
  }
  count += cases.length;
  for (const entry of cases) {
    const pathname = new URL(entry.request.path, "http://localhost").pathname;
    const method =
      entry.request.method === "HEAD"
        ? "get"
        : entry.request.method.toLowerCase();
    const matched = paths.find(
      ([path, methods]) =>
        methods[method] &&
        new RegExp(
          `^${path
            .split("/")
            .map((segment) =>
              segment.startsWith("{")
                ? "[^/]+"
                : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            )
            .join("/")}$`,
        ).test(pathname),
    );
    if (!matched)
      throw new Error(
        `Undocumented oracle request: ${entry.request.method} ${pathname}`,
      );
    if (entry.response.status < 400)
      operations.add(matched[1][method].operationId);
  }
  console.log(`${suite}: ${cases.length} canonical Node HTTP cases`);
}
run("cargo", ["test", "--workspace", "--locked"], rust);
const inventoryRun = spawnSync(
  "cargo",
  [
    "run",
    "--quiet",
    "-p",
    "egdata-api",
    "--bin",
    "generate-openapi",
    "--",
    "--inventory",
  ],
  { cwd: rust, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);
if (inventoryRun.error) throw inventoryRun.error;
if (inventoryRun.status !== 0) process.exit(inventoryRun.status ?? 1);
const inventory = JSON.parse(inventoryRun.stdout);
const pending = new Set(inventory.missingHandlers);
const registered = paths.flatMap(([, methods]) =>
  Object.values(methods)
    .map((method) => method.operationId)
    .filter((id) => id && !pending.has(id)),
);
if (registered.length !== inventory.implemented) {
  throw new Error(
    "The OpenAPI document and the Rust implementation inventory disagree",
  );
}
const uncovered = registered.filter((id) => !operations.has(id));
if (uncovered.length)
  throw new Error(
    `Missing successful Node HTTP cases for registered handlers: ${uncovered.join(", ")}`,
  );
console.log(
  `Checked ${count} Node HTTP fixtures across ${operations.size} documented operations against Rust; no fixtures rewritten.`,
);

const legacyInventory = spawnSync(
  "cargo",
  [
    "run",
    "--quiet",
    "-p",
    "egdata-api",
    "--bin",
    "generate-openapi",
    "--",
    "--legacy-inventory",
  ],
  { cwd: rust, env, encoding: "utf8" },
);
if (legacyInventory.status !== 0)
  throw new Error(legacyInventory.stderr || "Legacy inventory failed");
const legacy = JSON.parse(legacyInventory.stdout);
const legacyContract = JSON.parse(
  fs.readFileSync(
    new URL("../../openapi/egdata.openapi.json", import.meta.url),
    "utf8",
  ),
);
const requests = fs
  .readdirSync(fixturesDir)
  .filter((name) => /^legacy-.*-http-node\.json$/.test(name))
  .flatMap((name) =>
    JSON.parse(fs.readFileSync(new URL(name, fixturesDir), "utf8")),
  );
const pendingLegacy = new Set(legacy.missingHandlers);
const documented = Object.entries(legacyContract.paths).flatMap(
  ([path, methods]) =>
    Object.entries(methods)
      .filter(([, method]) => method.operationId)
      .map(([method]) => method.toUpperCase() + " " + path),
);
const candidates = [...documented, ...legacy.additionalRoutes].sort(
  (a, b) => (a.match(/\{/g)?.length ?? 0) - (b.match(/\{/g)?.length ?? 0),
);
const covered = new Set();
for (const { request, response } of requests) {
  const pathname = new URL(request.path, "http://localhost").pathname;
  const method = request.method === "HEAD" ? "GET" : request.method;
  const match = candidates.find((entry) => {
    const [verb, path] = entry.split(" ");
    return (
      verb === method &&
      path.split("/").length === pathname.split("/").length &&
      path
        .split("/")
        .every(
          (part, i) => part.startsWith("{") || part === pathname.split("/")[i],
        )
    );
  });
  if (
    match &&
    (response.status < 400 ||
      (pathname === "/search" && response.status === 410))
  )
    covered.add(match);
}
const missing = documented.filter(
  (entry) => !pendingLegacy.has(entry) && !covered.has(entry),
);
if (missing.length)
  throw new Error(
    "Missing canonical response cases for registered legacy routes: " +
      missing.join(", "),
  );
console.log(
  `Checked ${requests.length} legacy HTTP fixtures, including all ${legacy.implemented} mounted documented operations (${legacy.documented} in the contract).`,
);
