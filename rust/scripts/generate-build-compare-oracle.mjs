import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const sourcePath = path.join(root, "src/v1/routes/builds.ts");
const source = await readFile(sourcePath, "utf8");
const start = source.indexOf("const canonicalTags =");
const end = source.indexOf("const fileSortTuple", start);
if (start < 0 || end < 0) throw new Error("Could not locate compareSnapshotPage source");

const helperSource = `${source.slice(start, end)}\nreturn compareSnapshotPage;`;
const javascript = ts.transpileModule(helperSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const compareSnapshotPage = new Function(
  "Buffer",
  "TOP_ENTRIES_LIMIT",
  javascript,
)(Buffer, 10);
const cacheSource = await readFile(path.join(root, "src/v1/cache.ts"), "utf8");
const cacheStart = cacheSource.indexOf("export const v1CacheKey =");
if (cacheStart < 0) throw new Error("Could not locate v1CacheKey source");
const cacheJavascript = ts.transpileModule(cacheSource.slice(cacheStart), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const cacheExports = {};
new Function("exports", cacheJavascript)(cacheExports);
const expectedCacheKey = `v1:${cacheExports.v1CacheKey("builds.compare", {
  targetId: "507f1f77bcf86cd799439011",
  baseId: "507f1f77bcf86cd799439011",
  targetUpdatedAt: 0,
  baseUpdatedAt: 0,
  dir: "asc",
  statuses: ["added"],
  extensions: null,
  q: null,
  limit: 1,
  cursor: null,
})}`;

const base = [
  { fileName: "Folder/a.txt", fileHash: "old", fileSize: 10, installTags: ["win", "base"] },
  { fileName: "folder/z.pak", fileHash: "old-z", fileSize: 20, installTags: ["base"] },
  { fileName: "same.txt", fileHash: "same", fileSize: 5, installTags: ["common"] },
];
const target = [
  { fileName: "Folder/a.txt", fileHash: "new", fileSize: 14, installTags: ["win"] },
  { fileName: "folder/b.pak", fileHash: "new-b", fileSize: 8, installTags: ["win"] },
  { fileName: "same.txt", fileHash: "same", fileSize: 5, installTags: ["common"] },
];
const filters = {
  statuses: new Set(["added", "modified", "removed", "unchanged"]),
  query: null,
  extensions: null,
  afterPath: "Folder/a.txt",
  direction: "asc",
  limit: 2,
};
async function* stream(rows) {
  yield* rows;
}
const expected = await compareSnapshotPage(stream(base), stream(target), filters);
const fixture = {
  generatedFrom: "src/v1/routes/builds.ts#compareSnapshotPage",
  expectedCacheKey,
  inputs: { base, target },
  filters: {
    statuses: [...filters.statuses].sort(),
    query: filters.query,
    extensions: filters.extensions,
    afterPath: filters.afterPath,
    direction: filters.direction,
    limit: filters.limit,
  },
  expected,
};
const outputPath = path.join(
  root,
  "rust/crates/egdata-api/src/v1/fixtures/build-comparison-node.json",
);
await mkdir(path.dirname(outputPath), { recursive: true });
const fixtureText = `${JSON.stringify(fixture, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== fixtureText) throw new Error("Node build comparison oracle fixture is stale; rerun without --check");
} else {
  await writeFile(outputPath, fixtureText);
}
process.stdout.write(`${outputPath}\n`);
