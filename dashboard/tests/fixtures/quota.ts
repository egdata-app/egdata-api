import type { SQLInputValue } from "node:sqlite";
import { ApiKeyRateLimiter } from "../../worker/rate-limiter";
import type { DashboardEnv } from "../../worker/types";
import { sqliteD1 } from "./sqlite";

/** Exercise actual quota SQL rather than reimplementing the admission decision. */
export function quotaNamespace() {
  const objects = new Map<string, ApiKeyRateLimiter>();
  return {
    idFromName: (name: string) => name,
    get(name: string) {
      let object = objects.get(name);
      if (!object) {
        const { sqlite } = sqliteD1();
        const storage = {
          sql: {
            exec(query: string, ...values: SQLInputValue[]) {
              const statement = sqlite.prepare(query);
              if (!statement.columns().length) {
                statement.run(...values);
                return { toArray: () => [] };
              }
              return { toArray: () => statement.all(...values) };
            },
          },
          transactionSync<T>(fn: () => T): T {
            sqlite.exec("BEGIN");
            try {
              const result = fn();
              sqlite.exec("COMMIT");
              return result;
            } catch (error) {
              sqlite.exec("ROLLBACK");
              throw error;
            }
          },
        };
        object = new ApiKeyRateLimiter(
          { storage } as unknown as DurableObjectState,
          {} as DashboardEnv,
        );
        objects.set(name, object);
      }
      return object;
    },
  };
}
