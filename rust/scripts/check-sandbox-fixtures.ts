// Execute the canonical helper with fake model reads, without importing live clients.
// pnpm exec tsx rust/scripts/check-sandbox-fixtures.ts [--write]
import fs from "node:fs";
import ts from "typescript";
import { isoOrNull, serializeValue } from "../../src/v1/serialization.js";

const path = new URL("../crates/egdata-api/tests/fixtures/sandbox-assets.json", import.meta.url);
const source = fs.readFileSync(new URL("../../src/v1/routes/sandboxes.ts", import.meta.url), "utf8");
const start = source.indexOf("type AssetTuple =");
const end = source.indexOf("async function changelogContextIds");
if (start < 0 || end <= start) throw new Error("Sandbox source markers changed");
const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const current = JSON.parse(fs.readFileSync(path, "utf8"));
const expected = [];
for (const { input } of current) {
    const queries: unknown[] = [];
    const model = (name: string, rows: unknown[]) => ({ find: (...args: unknown[]) => {
        queries.push({ collection: name, args });
        return { lean: async () => rows };
    } });
    const helper = new Function("Item", "Asset", "isoOrNull", "serializeValue", "isString", code + "; return mergedSandboxAssets;")(
        model("items", input.items), model("assets", input.assets), isoOrNull, serializeValue,
        (value: unknown) => typeof value === "string" && value.length > 0,
    );
    expected.push({ input, output: await helper(input.sandboxId, input.platforms), queries });
}
if (process.argv.includes("--write")) fs.writeFileSync(path, JSON.stringify(expected, null, 2) + "\n");
else if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("Stale sandbox Node fixtures");
console.log(`Validated ${expected.length} sandbox asset fixtures against Node helper`);
