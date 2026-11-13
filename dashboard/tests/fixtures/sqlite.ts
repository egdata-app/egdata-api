import { createRequire } from "node:module";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

export function sqliteD1() {
  const sqlite = new DatabaseSync(":memory:");
  const db = {
    prepare(query: string) {
      let values: any[] = [];
      const statement = {
        bind(...args: any[]) {
          values = args;
          return statement;
        },
        execute() {
          const result = sqlite.prepare(query).run(...values);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
        async run() {
          return statement.execute();
        },
        async all() {
          return {
            success: true,
            results: sqlite.prepare(query).all(...values),
          };
        },
        async first(column?: string) {
          const row = sqlite.prepare(query).get(...values);
          return column ? (row?.[column] ?? null) : (row ?? null);
        },
      };
      return statement;
    },
    async batch(statements: Array<{ execute: () => unknown }>) {
      sqlite.exec("BEGIN");
      try {
        const result = [];
        // D1 batches are serialized transactions; never yield inside one in this fixture.
        for (const stmt of statements) result.push(stmt.execute());
        sqlite.exec("COMMIT");
        return result;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { sqlite, db: db as unknown as D1Database };
}
