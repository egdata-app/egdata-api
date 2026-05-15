import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { corpus } from "./corpus.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = join(HERE, "__snapshots__");
const PROD_BASE = process.env.PROD_BASE ?? "https://api.egdata.app";

type Snapshot = {
  request: { method: string; path: string; body?: unknown };
  status: number;
  headers: Record<string, string>;
  body: unknown;
  capturedAt: string;
};

async function captureOne(entry: (typeof corpus)[number]): Promise<void> {
  const url = `${PROD_BASE}${entry.path}`;
  const init: RequestInit = { method: entry.method };
  if (entry.body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(entry.body);
  }
  const res = await fetch(url, init);

  const contentType = res.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await res.json()
    : await res.text();

  const snapshot: Snapshot = {
    request: {
      method: entry.method,
      path: entry.path,
      ...(entry.body !== undefined ? { body: entry.body } : {}),
    },
    status: res.status,
    headers: {
      "content-type": contentType,
    },
    body,
    capturedAt: new Date().toISOString(),
  };

  const file = join(SNAPSHOT_DIR, `${entry.name}.json`);
  await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`captured ${entry.name} (${res.status}) -> ${file}`);
}

async function main(): Promise<void> {
  await mkdir(SNAPSHOT_DIR, { recursive: true });
  // Sequential to be a polite client to prod.
  for (const entry of corpus) {
    try {
      await captureOne(entry);
    } catch (err) {
      console.error(`failed to capture ${entry.name}:`, err);
      process.exitCode = 1;
    }
  }
}

await main();
