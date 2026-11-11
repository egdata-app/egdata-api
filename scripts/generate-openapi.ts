import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "../src/openapi/index.js";
import { buildV1OpenApiDocument } from "../src/openapi/v1.js";
import { renderWorkerRouteTable } from "./v1-worker-routes.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEGACY_OUT = resolve(ROOT, "openapi", "egdata.openapi.json");
const V1_OUT = resolve(ROOT, "openapi", "egdata.v1.openapi.json");
const WORKER_ROUTES_OUT = resolve(
  ROOT,
  "dashboard",
  "worker",
  "v1-routes.generated.ts",
);

const legacyDocument = buildOpenApiDocument();
const v1Document = buildV1OpenApiDocument();

await mkdir(dirname(LEGACY_OUT), { recursive: true });
await writeFile(LEGACY_OUT, `${JSON.stringify(legacyDocument, null, 2)}\n`);
await writeFile(V1_OUT, `${JSON.stringify(v1Document, null, 2)}\n`);
await writeFile(WORKER_ROUTES_OUT, renderWorkerRouteTable());

console.log(`wrote ${LEGACY_OUT}`);
console.log(`wrote ${V1_OUT}`);
console.log(`wrote ${WORKER_ROUTES_OUT}`);
