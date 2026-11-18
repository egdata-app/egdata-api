// Rebuild expected validation results from the canonical Node schema without
// importing its database clients. Run from any directory; --write refreshes results.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const sourcePath = new URL("../../src/routes/build-launcher-records.ts", import.meta.url);
const fixturePath = new URL("../crates/egdata-api/tests/fixtures/launcher-validation.json", import.meta.url);
const source = fs.readFileSync(sourcePath, "utf8");
const start = source.indexOf("const hintSchema");
const end = source.indexOf("type Candidate");
if (start < 0 || end <= start) throw new Error("Launcher schema source markers changed");
const schema = new Function("z", source.slice(start, end)
  .replace("export const launcherRecordResolveRequestSchema", "const launcherRecordResolveRequestSchema")
  + ";return launcherRecordResolveRequestSchema;")(z);
const current = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const expected = current.map(({ input }) => {
  const result = schema.safeParse(input);
  return { input, ...(result.success ? { output: result.data.candidates } : {
    errors: result.error.issues.map(issue => ({
      ...(issue.path.length ? {
        parameter: String(issue.path[0]),
        pointer: "/" + issue.path.map(String).map(s => s.replaceAll("~", "~0").replaceAll("/", "~1")).join("/"),
      } : {}),
      code: issue.code.toUpperCase(), message: issue.message,
    })),
  }) };
});
if (process.argv.includes("--write")) {
  fs.writeFileSync(fixturePath, JSON.stringify(expected, null, 2) + "\n");
} else if (JSON.stringify(current) !== JSON.stringify(expected)) {
  throw new Error(`Stale Node validation fixtures: ${fileURLToPath(fixturePath)}`);
}
console.log(`Validated ${expected.length} launcher fixtures against Node schema`);
