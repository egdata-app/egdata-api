// Execute only the canonical pure parser, avoiding live database/client imports.
import fs from "node:fs";
import ts from "typescript";
const source = fs.readFileSync(new URL("../../src/v1/routes/items.ts", import.meta.url), "utf8");
const path = new URL("../crates/egdata-api/tests/fixtures/items-bulk-validation.json", import.meta.url);
const start = source.indexOf("function parseBulkBody(");
const end = source.indexOf('app.get("/items"', start);
if (start < 0 || end <= start) throw new Error("Bulk parser source markers changed");
const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const parser = new Function("badRequest", "BULK_MAX_ITEMS", "BULK_MAX_ID_LENGTH", code + "; return parseBulkBody;")(
    (code, detail, errors) => ({ code, detail, errors }), 100, 200,
);
const cases = [
    ["not_object", null], ["array_body", []], ["number_body", 3],
    ["unknown_fields", { items: [], bad: 1, other: true }],
    ["unknown_pointer", { items: [], "a/b~c": true }],
    ["items_not_array", { items: "x" }], ["items_missing", {}],
    ["too_many", { items: Array(101).fill("x") }],
    ["entry_wrong_type", { items: [4] }],
    ["entry_second_wrong_type", { items: ["valid", null] }],
    ["entry_invalid_length", { items: ["  "] }],
    ["entry_too_long", { items: ["x".repeat(201)] }],
    ["entry_utf16_length", { items: ["😀".repeat(101)] }],
];
const expected = cases.map(([name, body]) => {
    try { parser(body); throw new Error(`Expected ${name} to be invalid`); }
    catch (expected) { if (!expected.code) throw expected; return { name, body, expected }; }
});
const output = JSON.stringify(expected, null, 2) + "\n";
if (process.argv.includes("--write")) fs.writeFileSync(path, output);
else if (JSON.stringify(JSON.parse(fs.readFileSync(path, "utf8"))) !== JSON.stringify(expected)) throw new Error("Stale item bulk validation fixtures");
console.log(`Validated ${expected.length} item bulk fixtures against Node parser`);
