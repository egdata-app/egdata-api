import { projectAudit } from "./admin-audit.js";

export const PROJECT_RECOVERY_DAYS = 90;

/** Bounded cron work. Every statement rechecks expiry to serialize with restore. */
export async function purgeDeletedProjects(
  db: D1Database,
  now = new Date().toISOString(),
) {
  const { results } = await db
    .prepare(`SELECT id FROM projects
    WHERE deleted_at IS NOT NULL AND purge_after<=? ORDER BY purge_after,id LIMIT 25`)
    .bind(now)
    .all<{ id: string }>();
  for (const { id } of results) {
    const condition = "id=? AND deleted_at IS NOT NULL AND purge_after<=?";
    const expired = `SELECT id FROM projects WHERE ${condition}`;
    await db.batch([
      projectAudit(
        db,
        {
          actor: "system:retention",
          action: "project.purged",
          reason: "90-day recovery window expired",
          now,
          after: { purged: true },
        },
        condition,
        [id, now],
      ),
      db
        .prepare(
          `DELETE FROM usage_dead_letters WHERE key_id IN (SELECT id FROM api_keys WHERE project_id IN (${expired}))`,
        )
        .bind(id, now),
      ...["usage_daily", "alert_reads", "alert_matches", "project_alerts"].map(
        (table) =>
          db
            .prepare(`DELETE FROM ${table} WHERE project_id IN (${expired})`)
            .bind(id, now),
      ),
      db.prepare(`DELETE FROM projects WHERE ${condition}`).bind(id, now),
    ]);
  }
}
