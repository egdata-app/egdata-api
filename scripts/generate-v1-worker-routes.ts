import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderWorkerRouteTable } from "./v1-worker-routes.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "dashboard", "worker", "v1-routes.generated.ts");

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, renderWorkerRouteTable());

console.log(`wrote ${OUT}`);
