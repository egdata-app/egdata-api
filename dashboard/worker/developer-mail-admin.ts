import { Hono } from "hono";
import { z } from "zod";
import type { AuthHonoEnv } from "./epic-auth.js";

// Mounted after the existing live admin-role and session checks.
export const developerMailAdmin = new Hono<AuthHonoEnv>();
developerMailAdmin.get("/", async (c) => {
  const p = z
    .object({ offset: z.coerce.number().int().min(0).max(100000).default(0) })
    .safeParse(c.req.query());
  if (!p.success)
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid notification offset.",
        },
      },
      400,
    );
  const { results } =
    await c.env.DB.prepare(`SELECT m.id,m.recipient,m.subject,m.created_at,m.sent_at,m.attempts,m.next_attempt_at,
    (SELECT a.status FROM developer_mail_attempts a WHERE a.mail_id=m.id ORDER BY a.dispatched_at DESC,a.message_id LIMIT 1) AS transport_status
    FROM developer_mail m ORDER BY m.created_at DESC,m.id LIMIT 51 OFFSET ?`)
      .bind(p.data.offset)
      .all();
  c.header("Cache-Control", "no-store");
  return c.json({
    messages: results.slice(0, 50),
    hasMore: results.length > 50,
    note: "Queued is not delivery. Delivered means acceptance by the recipient mail server, not proof of reading. Verification codes are not retained; resend through Profile.",
  });
});
