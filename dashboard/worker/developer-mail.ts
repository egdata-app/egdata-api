import { reconcileMailEvents } from "./developer-mail-events.js";
import { receiptEmail, receiptForMail } from "./developer-receipts.js";
import type { DashboardEnv } from "./types.js";

export async function sendDeveloperMail(
  env: DashboardEnv,
  recipient: string,
  subject: string,
  text: string,
  richHtml?: string,
) {
  if (!env.EMAIL || typeof env.EMAIL.send !== "function")
    throw new Error("Email delivery unavailable");
  const html =
    richHtml ??
    `<pre style="white-space:pre-wrap;font-family:system-ui">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`;
  return env.EMAIL.send({
    to: recipient,
    from: {
      email: env.EMAIL_FROM_ADDRESS || "noreply@egdata.app",
      name: env.EMAIL_FROM_NAME || "egdata Developer Portal",
    },
    subject,
    text,
    html,
    replyTo: "contact@egdata.app",
  });
}

/** Durable receipts/security notices; bounded retry with a lease across isolates. */
export async function deliverDeveloperMail(env: DashboardEnv) {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    "SELECT id,recipient,subject,body,receipt_id,attempts FROM developer_mail WHERE sent_at IS NULL AND leased_until<? AND next_attempt_at<=? AND attempts<8 ORDER BY created_at LIMIT 10",
  )
    .bind(now, now)
    .all<{
      id: string;
      recipient: string;
      subject: string;
      body: string;
      receipt_id: string | null;
      attempts: number;
    }>();
  for (const mail of results) {
    const lease = now + 5 * 60_000;
    const claimed = await env.DB.prepare(
      "UPDATE developer_mail SET leased_until=?,attempts=attempts+1 WHERE id=? AND sent_at IS NULL AND leased_until<? AND attempts<8",
    )
      .bind(lease, mail.id, now)
      .run();
    if (!claimed.meta.changes) continue;
    try {
      const content = mail.receipt_id
        ? receiptEmail(
            await receiptForMail(env.DB, mail.receipt_id),
            env.DASHBOARD_ORIGIN || "https://devs.egdata.app",
          )
        : { text: mail.body, html: undefined };
      const result = await sendDeveloperMail(
        env,
        mail.recipient,
        mail.subject,
        content.text,
        content.html,
      );
      if (result?.messageId) {
        await env.DB.prepare(
          "INSERT OR IGNORE INTO developer_mail_attempts(message_id,mail_id,dispatched_at) VALUES(?,?,?)",
        )
          .bind(result.messageId, mail.id, Date.now())
          .run();
        await reconcileMailEvents(env.DB, result.messageId);
      }
      await env.DB.prepare(
        "UPDATE developer_mail SET sent_at=? WHERE id=? AND leased_until=?",
      )
        .bind(Date.now(), mail.id, lease)
        .run();
    } catch {
      await env.DB.prepare(
        "UPDATE developer_mail SET next_attempt_at=? WHERE id=? AND leased_until=?",
      )
        .bind(
          Date.now() + Math.min(3600000, 60000 * 2 ** mail.attempts),
          mail.id,
          lease,
        )
        .run();
      // No recipient/body/token in logs. The next scheduled run retries durably.
      console.warn(
        "Developer notification delivery failed; inspect the notification outbox.",
      );
    }
  }
}
