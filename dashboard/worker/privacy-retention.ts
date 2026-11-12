const DAY = 86_400_000;

/** Calendar months, clamped to the last day instead of overflowing short months. */
export function calendarMonths(timestamp: number, months: number) {
  const result = new Date(timestamp);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result.getTime();
}

/** Daily bounded cleanup. Repeated runs drain backlogs without oversized D1 writes. */
export async function purgePrivacyRecords(db: D1Database, now = Date.now()) {
  const iso = (time: number) => new Date(time).toISOString();
  const alertCutoff = now - 90 * DAY;
  await db.batch([
    db
      .prepare(
        "DELETE FROM developer_mail_events WHERE event_id IN (SELECT event_id FROM developer_mail_events WHERE received_at<? LIMIT 500)",
      )
      .bind(now - 30 * DAY),
    db
      .prepare(
        "DELETE FROM admin_audit_log WHERE sequence IN (SELECT sequence FROM admin_audit_log WHERE julianday(created_at)<julianday(?) LIMIT 500)",
      )
      .bind(iso(calendarMonths(now, -24))),
    db
      .prepare(
        "DELETE FROM limit_requests WHERE id IN (SELECT id FROM limit_requests WHERE status!='pending' AND reviewed_at IS NOT NULL AND julianday(reviewed_at)<julianday(?) LIMIT 500)",
      )
      .bind(iso(calendarMonths(now, -12))),
    ...["alert_matches", "alert_reads", "project_alerts"].map((table) =>
      db
        .prepare(
          `DELETE FROM ${table} WHERE rowid IN (SELECT a.rowid FROM ${table} a JOIN change_records c ON c.id=a.record_id WHERE c.merged_at<? LIMIT 500)`,
        )
        .bind(alertCutoff),
    ),
    db
      .prepare(
        "DELETE FROM privacy_requests WHERE id IN (SELECT id FROM privacy_requests WHERE resolved_at IS NOT NULL AND resolved_at<? LIMIT 500)",
      )
      .bind(calendarMonths(now, -12)),
    db
      .prepare(
        "UPDATE developer_profiles SET pending_email=NULL,token_hash=NULL,token_expires_at=NULL WHERE owner_id IN (SELECT owner_id FROM developer_profiles WHERE token_expires_at<? LIMIT 500)",
      )
      .bind(now),
  ]);
}
