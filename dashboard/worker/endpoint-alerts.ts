import { z } from "zod";
import {
  canonicalJson,
  validateChangeRecord,
  type ChangeRecord,
} from "./change-validation.js";
import { sha256Hex } from "./crypto.js";

export const DAY_MS = 86_400_000;

export const mergeLabel = "Merged; deployment not verified.";

export type UsageEvent = {
  keyId: string;
  projectId: string;
  operationId: string;
  usageDate: string;
  firstUsedAt: number;
};

export const usageEventSchema = z
  .object({
    keyId: z.string().min(1).max(100),
    projectId: z.string().min(1).max(100),
    operationId: z
      .string()
      .regex(/^[A-Za-z][\w.-]*$/)
      .max(150),
    usageDate: z.iso.date(),
    firstUsedAt: z.number().int().nonnegative(),
  })
  .strict();

export function mergeWindow(mergedAt: number) {
  const day = new Date(mergedAt).toISOString().slice(0, 10);
  return {
    mergeDate: day,
    windowStart: new Date(Date.parse(day) - 29 * DAY_MS)
      .toISOString()
      .slice(0, 10),
  };
}

export function qualifiesUsage(event: UsageEvent, mergedAt: number) {
  const window = mergeWindow(mergedAt);
  return (
    event.usageDate >= window.windowStart &&
    event.usageDate <= window.mergeDate &&
    event.firstUsedAt <= mergedAt &&
    new Date(event.firstUsedAt).toISOString().slice(0, 10) === event.usageDate
  );
}

// Re-run after imports AND delayed usage deliveries. Unique constraints make both orderings safe.
// No join against active api_keys: revocation after qualifying usage must not erase relevance.
function reconciliationStatements(
  db: D1Database,
  options: { recordId?: string; events?: UsageEvent[] } = {},
) {
  const recordId = options.recordId ?? "";
  const events = JSON.stringify(options.events ?? []);
  return [
    db
      .prepare(
        `INSERT INTO alert_matches
           (project_id, record_id, operation_id, key_id, first_used_at)
         SELECT u.project_id, c.id, u.operation_id, u.key_id, MIN(u.first_used_at)
           FROM usage_daily u
           JOIN change_operations o
             ON o.api_version = 'v1' AND o.operation_id = u.operation_id
           JOIN change_records c ON c.id = o.record_id
          WHERE u.usage_date BETWEEN c.window_start AND c.merge_date
            AND u.first_used_at <= c.merged_at
            AND (c.import_complete = 1 OR c.id = ?)
            AND (? = '' OR c.id = ?)
            AND (
              ? = '[]'
              OR EXISTS (
                SELECT 1
                  FROM json_each(?) event
                 WHERE json_extract(event.value, '$.keyId') = u.key_id
                   AND json_extract(event.value, '$.operationId') = u.operation_id
                   AND json_extract(event.value, '$.usageDate') = u.usage_date
              )
            )
          GROUP BY u.project_id, c.id, u.operation_id, u.key_id
         ON CONFLICT(project_id, record_id, operation_id, key_id)
         DO UPDATE SET first_used_at = MIN(first_used_at, excluded.first_used_at)`,
      )
      .bind(recordId, recordId, recordId, events, events),
    db
      .prepare(
        `INSERT OR IGNORE INTO project_alerts (project_id, record_id)
         SELECT DISTINCT project_id, record_id
           FROM alert_matches m
          WHERE (? = '' OR record_id = ?)
            AND (
              ? = '[]'
              OR EXISTS (
                SELECT 1
                  FROM json_each(?) event
                 WHERE json_extract(event.value, '$.keyId') = m.key_id
                   AND json_extract(event.value, '$.operationId') = m.operation_id
              )
            )`,
      )
      .bind(recordId, recordId, events, events),
  ];
}

export async function reconcileAlerts(
  db: D1Database,
  options: { recordId?: string; events?: UsageEvent[] } = {},
) {
  await db.batch(reconciliationStatements(db, options));
}

export async function ingestUsage(
  db: D1Database,
  events: UsageEvent[],
  now = Date.now(),
) {
  const valid = events.map((e) => usageEventSchema.parse(e));
  const oldest = new Date(now - 34 * DAY_MS).toISOString().slice(0, 10);
  for (const e of valid) {
    if (
      new Date(e.firstUsedAt).toISOString().slice(0, 10) !== e.usageDate ||
      e.firstUsedAt > now + 60_000
    ) {
      throw new Error("Invalid usage timestamp");
    }
  }
  const statements = valid
    .filter((e) => e.usageDate >= oldest)
    .map((e) =>
      db
        .prepare(
          `INSERT INTO usage_daily
             (project_id, key_id, operation_id, usage_date, first_used_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(key_id, operation_id, usage_date)
           DO UPDATE SET first_used_at = MIN(first_used_at, excluded.first_used_at)
             WHERE project_id = excluded.project_id`,
        )
        .bind(e.projectId, e.keyId, e.operationId, e.usageDate, e.firstUsedAt),
    );
  if (statements.length) await db.batch(statements);
  if (valid.length) await reconcileAlerts(db, { events: valid });
  await db
    .prepare(
      `INSERT INTO tracking_health (id, value, updated_at)
       VALUES ('lastDelivery', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    )
    .bind(String(now), now)
    .run();
}

export type PublishedRecord = {
  record: ChangeRecord;
  contentHash: string;
  mergeCommit: string;
  mergedAt: number;
};

export async function importMergedRecord(
  db: D1Database,
  input: PublishedRecord,
) {
  const record = validateChangeRecord(input.record);
  if (
    !/^[a-f0-9]{40}$/.test(input.mergeCommit) ||
    !Number.isSafeInteger(input.mergedAt) ||
    input.mergedAt < 0 ||
    input.mergedAt > Date.now() + 60_000
  ) {
    throw new Error("Invalid merge metadata");
  }
  const computed = await sha256Hex(canonicalJson(record));
  if (computed !== input.contentHash) throw new Error("Content hash mismatch");
  const window = mergeWindow(input.mergedAt);
  // Insert-ignore + read rejects conflicting concurrent imports without overwriting history.
  await db
    .prepare(
      `INSERT OR IGNORE INTO change_records
         (id, content_hash, record_json, merge_commit, merged_at, window_start, merge_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      record.id,
      computed,
      canonicalJson(record),
      input.mergeCommit,
      input.mergedAt,
      window.windowStart,
      window.mergeDate,
    )
    .run();
  const stored = await db
    .prepare(
      `SELECT content_hash, merge_commit, merged_at FROM change_records WHERE id = ?`,
    )
    .bind(record.id)
    .first<{ content_hash: string; merge_commit: string; merged_at: number }>();
  if (
    !stored ||
    stored.content_hash !== computed ||
    stored.merge_commit !== input.mergeCommit ||
    stored.merged_at !== input.mergedAt
  ) {
    throw new Error("Immutable record ID conflict");
  }
  await db.batch(
    record.endpoints.map((e) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO change_operations (record_id, api_version, operation_id) VALUES (?, ?, ?)`,
        )
        .bind(record.id, e.apiVersion, e.operationId),
    ),
  );
  // The receipt and alert sequences become visible together. A failed import
  // cannot leak alerts into a read-all cutoff or be skipped on publication retry.
  await db.batch([
    ...reconciliationStatements(db, { recordId: record.id }),
    db
      .prepare(`UPDATE change_records SET import_complete = 1 WHERE id = ?`)
      .bind(record.id),
  ]);
}

export async function projectOwned(
  db: D1Database,
  projectId: string,
  userId: string,
) {
  return !!(await db
    .prepare(`SELECT id FROM projects WHERE id = ? AND owner_epic_id = ?`)
    .bind(projectId, userId)
    .first());
}

export async function listAlerts(
  db: D1Database,
  projectId: string,
  userId: string,
  filters: {
    unread?: boolean;
    endpoint?: string;
    type?: string;
    compatibility?: string;
    before?: number;
  } = {},
) {
  // Capture the server cutoff before reading pages/counts; later inserts stay unread.
  const snapshot = await db
    .prepare(
      `SELECT COALESCE(MAX(sequence), 0) AS cutoff FROM project_alerts WHERE project_id = ?`,
    )
    .bind(projectId)
    .first<{ cutoff: number }>();
  const cutoff = snapshot?.cutoff ?? 0;
  const rows = await db
    .prepare(
      `SELECT a.sequence, c.record_json, c.id, c.merge_commit, c.merged_at, r.read_at
         FROM project_alerts a
         JOIN change_records c ON c.id = a.record_id
         LEFT JOIN alert_reads r
           ON r.project_id = a.project_id
          AND r.record_id = a.record_id
          AND r.user_id = ?
        WHERE a.project_id = ?
          AND a.sequence < ?
          AND (? = 0 OR r.read_at IS NULL)
          AND (
            ? = ''
            OR EXISTS (
              SELECT 1
                FROM alert_matches m
               WHERE m.project_id = a.project_id
                 AND m.record_id = a.record_id
                 AND m.operation_id = ?
            )
          )
          AND EXISTS (
            SELECT 1
              FROM json_each(c.record_json, '$.endpoints') e
              JOIN alert_matches m
                ON m.record_id = a.record_id
               AND m.project_id = a.project_id
               AND m.operation_id = json_extract(e.value, '$.operationId')
             WHERE json_extract(e.value, '$.apiVersion') = 'v1'
               AND (? = '' OR m.operation_id = ?)
               AND (? = '' OR json_extract(e.value, '$.type') = ?)
               AND (? = '' OR json_extract(e.value, '$.compatibility') = ?)
          )
        ORDER BY a.sequence DESC
        LIMIT 50`,
    )
    .bind(
      userId,
      projectId,
      Math.min(filters.before ?? Number.MAX_SAFE_INTEGER, cutoff + 1),
      filters.unread ? 1 : 0,
      filters.endpoint ?? "",
      filters.endpoint ?? "",
      filters.endpoint ?? "",
      filters.endpoint ?? "",
      filters.type ?? "",
      filters.type ?? "",
      filters.compatibility ?? "",
      filters.compatibility ?? "",
    )
    .all<{
      sequence: number;
      record_json: string;
      id: string;
      merge_commit: string;
      merged_at: number;
      read_at: number | null;
    }>();
  const count = await db
    .prepare(
      `SELECT COUNT(*) AS unread
         FROM project_alerts a
         LEFT JOIN alert_reads r
           ON r.project_id = a.project_id
          AND r.record_id = a.record_id
          AND r.user_id = ?
        WHERE a.project_id = ?
          AND a.sequence <= ?
          AND r.read_at IS NULL`,
    )
    .bind(userId, projectId, cutoff)
    .first<{ unread: number }>();
  const alerts = await Promise.all(
    rows.results.map(async (row) => {
      const matches = await db
        .prepare(
          `SELECT operation_id, key_id, first_used_at
             FROM alert_matches
            WHERE project_id = ? AND record_id = ?
            ORDER BY operation_id, key_id`,
        )
        .bind(projectId, row.id)
        .all<{ operation_id: string; key_id: string; first_used_at: number }>();
      return {
        sequence: row.sequence,
        record: JSON.parse(row.record_json) as ChangeRecord,
        mergeCommit: row.merge_commit,
        mergedAt: row.merged_at,
        read: row.read_at !== null,
        matches: matches.results,
        label: mergeLabel,
      };
    }),
  );
  return {
    alerts,
    unread: count?.unread ?? 0,
    cutoff,
    nextBefore:
      rows.results.length === 50 ? rows.results.at(-1)!.sequence : null,
  };
}

export async function markRead(
  db: D1Database,
  projectId: string,
  userId: string,
  recordId: string,
) {
  await db
    .prepare(
      `INSERT OR IGNORE INTO alert_reads (user_id, project_id, record_id, read_at)
       SELECT ?, project_id, record_id, ?
         FROM project_alerts
        WHERE project_id = ? AND record_id = ?`,
    )
    .bind(userId, Date.now(), projectId, recordId)
    .run();
}

export async function markAllRead(
  db: D1Database,
  projectId: string,
  userId: string,
  cutoff: number,
) {
  await db
    .prepare(
      `INSERT OR IGNORE INTO alert_reads (user_id, project_id, record_id, read_at)
       SELECT ?, project_id, record_id, ?
         FROM project_alerts
        WHERE project_id = ? AND sequence <= ?`,
    )
    .bind(userId, Date.now(), projectId, cutoff)
    .run();
}
