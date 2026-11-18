import fs from "node:fs";
const path = new URL("../crates/egdata-api/tests/fixtures/collation.json", import.meta.url);
const current = JSON.parse(fs.readFileSync(path, "utf8"));
const expected = current.map(({ locale, input }) => ({ locale, input, sorted: [...input].sort(new Intl.Collator(locale).compare) }));
if (process.argv.includes("--write")) fs.writeFileSync(path, JSON.stringify(expected, null, 2) + "\n");
else if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("Stale Node collation fixtures; inspect ICU version before refreshing");
console.log(`Validated ${expected.length} locale fixtures against Node Intl.Collator (ICU ${process.versions.icu})`);
