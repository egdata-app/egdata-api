import { z } from "zod";
import type { DashboardEnv } from "./types.js";

const statuses = [
  "delivered",
  "deferred",
  "bounced",
  "failed",
  "rejected",
  "complained",
] as const;
const eventSchema = z.object({
  type: z.string(),
  source: z.object({ type: z.literal("email.sending"), domain: z.string() }),
  payload: z.object({
    eventId: z.string().min(1).max(128),
    messageId: z.string().min(1).max(256),
    delivery: z.object({ status: z.enum(statuses) }),
  }),
  metadata: z.object({
    eventSchemaVersion: z.literal(1),
    eventTimestamp: z.iso.datetime(),
  }),
});
const failureSql = "('bounced','failed','rejected','complained')";

/** Safe on duplicate/out-of-order events, including a bounce after delivery. */
export async function reconcileMailEvents(db: D1Database, messageId: string) {
  await db
    .prepare(`UPDATE developer_mail_attempts SET
    status=(SELECT e.status FROM developer_mail_events e WHERE e.message_id=? ORDER BY e.status IN ${failureSql} DESC,e.status='delivered' DESC,e.event_at DESC,e.event_id DESC LIMIT 1),
    event_at=(SELECT MAX(e.event_at) FROM developer_mail_events e WHERE e.message_id=?),
    terminal_failure=EXISTS(SELECT 1 FROM developer_mail_events e WHERE e.message_id=? AND e.status IN ${failureSql})
    WHERE message_id=? AND EXISTS(SELECT 1 FROM developer_mail_events e WHERE e.message_id=?)`)
    .bind(messageId, messageId, messageId, messageId, messageId)
    .run();
}

export async function ingestMailEvent(env: DashboardEnv, body: unknown) {
  const parsed = eventSchema.safeParse(body);
  if (!parsed.success) throw new Error("Invalid email lifecycle event");
  const e = parsed.data;
  const domain = (env.EMAIL_FROM_ADDRESS || "noreply@egdata.app").split("@")[1];
  if (
    e.source.domain.toLowerCase() !== domain.toLowerCase() ||
    e.type !== `cf.email.sending.message.${e.payload.delivery.status}`
  )
    throw new Error("Unexpected email lifecycle source");
  const eventAt = Date.parse(e.metadata.eventTimestamp);
  if (eventAt > Date.now() + 300000)
    throw new Error("Invalid email lifecycle timestamp");
  await env.DB.prepare(
    "INSERT OR IGNORE INTO developer_mail_events(event_id,message_id,status,event_at,received_at) VALUES(?,?,?,?,?)",
  )
    .bind(
      e.payload.eventId,
      e.payload.messageId,
      e.payload.delivery.status,
      eventAt,
      Date.now(),
    )
    .run();
  await reconcileMailEvents(env.DB, e.payload.messageId);
}
