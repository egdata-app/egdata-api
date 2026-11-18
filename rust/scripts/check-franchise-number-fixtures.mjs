import fs from "node:fs";
const path = new URL("../crates/egdata-api/tests/fixtures/franchise-number-coercion.json", import.meta.url);
const fixtures = JSON.parse(fs.readFileSync(path, "utf8"));
const current = fixtures.map(({ label, value, missing }) => {
  const input = missing ? undefined : value;
  const result = Number(input) || 0;
  return { label, value, ...(missing ? { missing: true } : {}), expected: Number.isFinite(result) ? result : null };
});
if (process.argv.includes("--write")) fs.writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
else if (JSON.stringify(fixtures) !== JSON.stringify(current)) throw new Error("Stale franchise coercion fixtures; run node rust/scripts/check-franchise-number-fixtures.mjs --write");
console.log(`Validated ${current.length} JavaScript Number(value) || 0 fixtures`);
