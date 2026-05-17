import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "../src/openapi/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "openapi", "egdata.openapi.json");

const document = buildOpenApiDocument();

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(document, null, 2)}\n`);

console.log(`wrote ${OUT}`);

