import type { UsageEvent } from "./endpoint-alerts.js";

export const OUTBOX_MAX_ATTEMPTS = 12;

export const OUTBOX_BATCH_SIZE = 50;

export function retryDelay(attempts: number) {
  return Math.min(3_600_000, 5_000 * 2 ** Math.min(attempts, 10));
}

type OutboxRow = {
  key_id: string;
  project_id: string;
  operation_id: string;
  usage_date: string;
  first_used_at: number;
  attempts: number;
};

export function createUsageOutbox(storage: DurableObjectStorage) {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS usage_outbox (
    key_id TEXT NOT NULL, project_id TEXT NOT NULL, operation_id TEXT NOT NULL,
    usage_date TEXT NOT NULL, first_used_at INTEGER NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key_id, operation_id, usage_date))`);
}

/** Called in the same SQLite transaction as the existing admission-state write. */
export function captureUsage(storage: DurableObjectStorage, event: UsageEvent) {
  // Lazy pruning avoids periodic alarms for inactive keys; only 35 dates can match.
  pruneUsage(storage, event.firstUsedAt);
  storage.sql.exec(
    `INSERT OR IGNORE INTO usage_outbox
       (key_id, project_id, operation_id, usage_date, first_used_at)
     VALUES (?, ?, ?, ?, ?)`,
    event.keyId,
    event.projectId,
    event.operationId,
    event.usageDate,
    event.firstUsedAt,
  );
}

function pruneUsage(storage: DurableObjectStorage, now: number) {
  storage.sql.exec(
    `DELETE FROM usage_outbox WHERE usage_date < ?`,
    new Date(now - 34 * 86_400_000).toISOString().slice(0, 10),
  );
}

export async function scheduleUsage(
  storage: DurableObjectStorage,
  now = Date.now(),
) {
  const next = storage.sql
    .exec<{ next: number | null }>(
      `SELECT MIN(next_attempt) AS next
         FROM usage_outbox
        WHERE delivered = 0 AND attempts < ?`,
      OUTBOX_MAX_ATTEMPTS,
    )
    .toArray()[0]?.next;
  if (
    next !== null &&
    next !== undefined &&
    (await storage.getAlarm()) === null
  ) {
    await storage.setAlarm(Math.max(now + 1_000, next));
  }
}

export async function flushUsage(
  storage: DurableObjectStorage,
  queue: Queue<UsageEvent>,
  onFailure: (attempts: number) => Promise<void>,
  now = Date.now(),
) {
  pruneUsage(storage, now);
  const rows = storage.sql
    .exec<OutboxRow>(
      `SELECT key_id, project_id, operation_id, usage_date, first_used_at, attempts
         FROM usage_outbox
        WHERE delivered = 0
          AND attempts < ?
          AND next_attempt <= ?
        ORDER BY first_used_at
        LIMIT ?`,
      OUTBOX_MAX_ATTEMPTS,
      now,
      OUTBOX_BATCH_SIZE,
    )
    .toArray();
  if (rows.length) {
    let delivered = false;
    try {
      await queue.sendBatch(
        rows.map((row) => ({
          body: {
            keyId: row.key_id,
            projectId: row.project_id,
            operationId: row.operation_id,
            usageDate: row.usage_date,
            firstUsedAt: row.first_used_at,
          },
          contentType: "json" as const,
        })),
      );
      delivered = true;
    } catch {
      const attempts = Math.max(...rows.map((r) => r.attempts)) + 1;
      console.error(
        JSON.stringify({
          event: "usage_outbox_delivery_failed",
          attempts,
          exhausted: attempts >= OUTBOX_MAX_ATTEMPTS,
        }),
      );
      await onFailure(attempts).catch(() => {});
    }
    storage.transactionSync(() => {
      for (const row of rows) {
        storage.sql.exec(
          `UPDATE usage_outbox
              SET delivered = ?, attempts = attempts + ?, next_attempt = ?
            WHERE key_id = ? AND operation_id = ? AND usage_date = ?`,
          delivered ? 1 : 0,
          delivered ? 0 : 1,
          now + retryDelay(row.attempts + 1),
          row.key_id,
          row.operation_id,
          row.usage_date,
        );
      }
    });
  }
  await scheduleUsage(storage, now);
}
