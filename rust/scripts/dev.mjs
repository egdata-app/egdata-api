// Local-only launcher: real service credentials come from the selected dotenv file.
// The gateway token below is a public development value, never a production secret.
import { spawn } from "node:child_process";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { envFileArgs } from "./env-file.mjs";

const rust = fileURLToPath(new URL("../", import.meta.url));
const args = envFileArgs(process.argv.slice(2));
for (const [i, arg] of args.entries()) {
  if (arg !== "--bind" && !arg.startsWith("--bind=")) continue;
  const address = arg === "--bind" ? args[i + 1] : arg.slice(7);
  if (
    !address ||
    !(address === "::1" || (isIP(address) === 4 && address.startsWith("127.")))
  ) {
    throw new Error(
      "Use a loopback address with the local development gateway token.",
    );
  }
}
const token = "egdata-rust-local-development";
const child = spawn(
  "cargo",
  ["run", "-p", "egdata-api", "--bin", "egdata-api", "--", ...args],
  {
    cwd: rust,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "development",
      ORIGIN_AUTH_TOKEN: token,
      V1_WORKER_TOKEN: token,
      V1_CURSOR_DEV_SECRET:
        "egdata-rust-local-cursor-secret-do-not-use-in-production",
      RESPONSE_CACHE_PREFIX: "rust:local:response:v2:",
    },
  },
);
child.on("error", () => {
  console.error(
    "Cannot launch Cargo. Install the pinned Rust toolchain and ensure cargo is on PATH.",
  );
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
