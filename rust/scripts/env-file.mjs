import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const checkoutEnv = fileURLToPath(new URL("../../.env", import.meta.url));

// Cargo starts in rust/. Resolve the CLI path in the directory where the user invoked it.
export function envFileArgs(args, defaultFile = checkoutEnv) {
  const result = [...args];
  const index = result.findIndex((arg) => arg === "--env-file" || arg.startsWith("--env-file="));
  if (index === -1) {
    if (existsSync(defaultFile)) result.unshift("--env-file", defaultFile);
  } else if (result[index] === "--env-file") {
    const input = result[index + 1];
    if (input && !input.startsWith("-")) result[index + 1] = resolve(input);
  } else {
    const input = result[index].slice("--env-file=".length);
    if (input) result[index] = "--env-file=" + resolve(input);
  }
  return result;
}
