import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../worker/crypto";
import { sqliteD1 } from "./fixtures/sqlite";

describe("initial legal publication", () => {
  it("rejects drafts and invalid metadata before writing output, and activates only after both immutable documents exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "egdata-legal-"));
    try {
      const terms = join(dir, "terms.md");
      const privacy = join(dir, "privacy.md");
      const output = join(dir, "rollout.sql");
      const run = (version = "1.0", date = "2026-11-12T00:00:00Z") =>
        spawnSync(
          process.execPath,
          [
            "scripts/prepare-legal-rollout.mjs",
            terms,
            privacy,
            version,
            date,
            output,
          ],
          { encoding: "utf8" },
        );
      writeFileSync(terms, "REVIEW DRAFT - TO COMPLETE");
      writeFileSync(privacy, "Final privacy notice");
      expect(run().status).not.toBe(0);
      const body = "Final terms: Ignacio's service.\nUTF-8: España.\n";
      writeFileSync(terms, body);
      expect(run("../unsafe").status).not.toBe(0);
      expect(run("1.0", "2026-11-12").status).not.toBe(0);
      expect(run().status).toBe(0);
      expect(run().status).not.toBe(0); // Never overwrite a prepared publication.
      const { sqlite } = sqliteD1();
      sqlite.exec(readFileSync("migrations/0001_initial.sql", "utf8"));
      sqlite.exec(
        readFileSync("migrations/0008_developer_accounts.sql", "utf8"),
      );
      expect(() =>
        sqlite.exec(
          "INSERT INTO legal_rollout VALUES(1,'bad','missing','missing')",
        ),
      ).toThrow("LEGAL_DOCUMENT_MISSING");
      const sql = readFileSync(output, "utf8");
      expect(sql).not.toMatch(/BEGIN TRANSACTION|COMMIT;/);
      const activation = sql.lastIndexOf("INSERT INTO legal_rollout");
      sqlite.exec(sql.slice(0, activation));
      expect(
        sqlite.prepare("SELECT COUNT(*) n FROM legal_rollout").get()!.n,
      ).toBe(0);
      expect(
        sqlite
          .prepare("SELECT body,sha256 FROM legal_documents WHERE kind='terms'")
          .get(),
      ).toMatchObject({ body, sha256: await sha256Hex(body) });
      sqlite.exec(sql.slice(activation));
      expect(
        sqlite.prepare("SELECT COUNT(*) n FROM legal_rollout").get()!.n,
      ).toBe(1);
      expect(() => sqlite.exec(sql.slice(activation))).toThrow();
      sqlite.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
