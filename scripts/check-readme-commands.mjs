import { readFile } from "node:fs/promises";

const readme = await readFile("README.md", "utf8");

const required = [
  "pnpm install",
  "pnpm dev",
  "http://localhost:4000",
  "pnpm build",
  "pnpm start",
  "pnpm test:unit",
  "pnpm openapi:check",
  "pnpm docs:build",
];

const forbidden = ["bun install", "bun run dev", "localhost:3000"];

const missing = required.filter((needle) => !readme.includes(needle));
const stale = forbidden.filter((needle) => readme.includes(needle));

if (missing.length > 0 || stale.length > 0) {
  if (missing.length > 0) {
    console.error("README is missing required command references:");
    for (const item of missing) console.error(`- ${item}`);
  }
  if (stale.length > 0) {
    console.error("README still contains stale command references:");
    for (const item of stale) console.error(`- ${item}`);
  }
  process.exit(1);
}

console.log("README command check passed.");

