import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db/index.js";
import { corpus } from "./corpus.js";
import { diffShape } from "./diff.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = join(HERE, "__snapshots__");

const hasMongo = Boolean(process.env.MONGO_URL);

describe.skipIf(!hasMongo)("route golden snapshots", () => {
  let app: import("hono").Hono;

  beforeAll(async () => {
    await db.connect();
    // Import after env + db connect so route handlers find what they need.
    ({ app } = await import("../src/index.js"));
  });

  afterAll(async () => {
    // Best-effort: Hono has no teardown; Mongo client cleanup is left to
    // process exit. Add explicit close here if leaked handles surface in CI.
  });

  for (const entry of corpus) {
    it(`${entry.method} ${entry.path}`, async () => {
      const snapshotPath = join(SNAPSHOT_DIR, `${entry.name}.json`);
      let snapshot: {
        status: number;
        body: unknown;
        headers: Record<string, string>;
      };
      try {
        snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
      } catch {
        throw new Error(
          `missing snapshot for "${entry.name}" — run \`pnpm test:capture\` first`,
        );
      }

      const init: RequestInit = { method: entry.method };
      if (entry.body !== undefined) {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify(entry.body);
      }
      const res = await app.request(entry.path, init);
      expect(res.status, `status mismatch for ${entry.path}`).toBe(
        snapshot.status,
      );

      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        // Non-JSON responses (e.g. sitemaps, OG images): just assert status.
        return;
      }

      const body = await res.json();
      if (entry.path === "/" && Array.isArray((snapshot.body as any).endpoints)) {
        expect((body as any).endpoints, "route inventory changed").toEqual(
          (snapshot.body as any).endpoints,
        );
      }

      const diffs = diffShape(snapshot.body, body);
      if (diffs.length > 0) {
        const summary = diffs
          .slice(0, 20)
          .map((d) => `  ${d.path}: ${d.message}`)
          .join("\n");
        throw new Error(
          `shape mismatch for ${entry.path}:\n${summary}${diffs.length > 20 ? `\n  ...and ${diffs.length - 20} more` : ""}`,
        );
      }
    });
  }
});

describe.skipIf(hasMongo)(
  "route golden snapshots (skipped: no MONGO_URL)",
  () => {
    it("requires MONGO_URL to run", () => {
      expect(hasMongo).toBe(false);
    });
  },
);
