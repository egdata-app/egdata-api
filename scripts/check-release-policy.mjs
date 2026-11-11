import { spawnSync } from "node:child_process";
// Strict, read-only policy; no labels or touched-file bypass.
const result = spawnSync(
  process.execPath,
  [
    "node_modules/tsx/dist/cli.mjs",
    "scripts/changelog.ts",
    "check",
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
