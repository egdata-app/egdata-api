import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { envFileArgs } from "./env-file.mjs";
const args = envFileArgs(process.argv.slice(2));
const result = spawnSync(
  "cargo",
  [
    "run",
    "--quiet",
    "--locked",
    "-p",
    "egdata-api",
    "--bin",
    "egdata-api",
    "--",
    ...args,
  ],
  {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
