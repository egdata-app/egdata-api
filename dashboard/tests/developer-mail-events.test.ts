import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { deliverDeveloperMail } from "../worker/developer-mail";
import {
  ingestMailEvent,
  reconcileMailEvents,
} from "../worker/developer-mail-events";
import type { DashboardEnv } from "../worker/types";
import { sqliteD1 } from "./fixtures/sqlite";

function setup() {
  const { db, sqlite } = sqliteD1();
  for (const file of readdirSync("migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort())
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  sqlite.exec(
    "INSERT INTO developer_mail(id,recipient,subject,body,created_at) VALUES('mail','contact@example.com','Test','Test',1)",
  );
  return {
    db,
    sqlite,
    env: { DB: db, EMAIL_FROM_ADDRESS: "noreply@egdata.app" } as DashboardEnv,
  };
}
function event(status: string, id = status, time = Date.now()) {
  return {
    type: `cf.email.sending.message.${status}`,
    source: { type: "email.sending", domain: "egdata.app" },
    payload: {
      eventId: id,
      messageId: "message",
      recipient: "private@example.com",
      delivery: { status },
    },
    metadata: {
      eventSchemaVersion: 1,
      eventTimestamp: new Date(time).toISOString(),
    },
  };
}
describe("email delivery evidence", () => {
  it("handles events before send response, duplicates, and a bounce after delivery", async () => {
    const { db, sqlite, env } = setup();
    await ingestMailEvent(env, event("delivered"));
    await ingestMailEvent(env, event("delivered"));
    sqlite.exec(
      "INSERT INTO developer_mail_attempts(message_id,mail_id,dispatched_at) VALUES('message','mail',1)",
    );
    await reconcileMailEvents(db, "message");
    expect(
      sqlite.prepare("SELECT status FROM developer_mail_attempts").get(),
    ).toEqual({ status: "delivered" });
    await ingestMailEvent(
      env,
      event("deferred", "late-deferred", Date.now() + 500),
    );
    expect(
      sqlite.prepare("SELECT status FROM developer_mail_attempts").get(),
    ).toEqual({ status: "delivered" });
    await ingestMailEvent(env, event("bounced"));
    await ingestMailEvent(
      env,
      event("delivered", "late-delivery", Date.now() + 1000),
    );
    expect(
      sqlite
        .prepare("SELECT status,terminal_failure FROM developer_mail_attempts")
        .get(),
    ).toEqual({ status: "bounced", terminal_failure: 1 });
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM developer_mail_events")
        .get(),
    ).toEqual({ count: 4 });
    expect(
      JSON.stringify(
        sqlite.prepare("SELECT * FROM developer_mail_events").all(),
      ),
    ).not.toContain("private@example.com");
  });
  it("backs off failed sends and records transport acceptance on a later retry", async () => {
    const { env, sqlite } = setup();
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary send failure"))
      .mockResolvedValue({ messageId: "message" });
    env.EMAIL = { send } as SendEmail;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await deliverDeveloperMail(env);
      expect(
        sqlite.prepare("SELECT attempts,sent_at FROM developer_mail").get(),
      ).toEqual({ attempts: 1, sent_at: null });
      await deliverDeveloperMail(env);
      expect(send).toHaveBeenCalledTimes(1);
      sqlite.exec("UPDATE developer_mail SET leased_until=0,next_attempt_at=0");
      await deliverDeveloperMail(env);
      expect(send).toHaveBeenCalledTimes(2);
      expect(
        sqlite.prepare("SELECT status FROM developer_mail_attempts").get(),
      ).toEqual({ status: "queued" });
      expect(
        sqlite.prepare("SELECT sent_at FROM developer_mail").get()!.sent_at,
      ).not.toBeNull();
      await ingestMailEvent(env, event("delivered"));
      expect(
        sqlite.prepare("SELECT status FROM developer_mail_attempts").get(),
      ).toEqual({ status: "delivered" });
      await deliverDeveloperMail(env);
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      warning.mockRestore();
    }
  });
  it("rejects malformed or wrong-domain events without storing payloads", async () => {
    const { env, sqlite } = setup();
    await expect(
      ingestMailEvent(env, {
        ...event("delivered"),
        source: { type: "email.sending", domain: "other.example" },
      }),
    ).rejects.toThrow();
    await expect(ingestMailEvent(env, event("unknown"))).rejects.toThrow();
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM developer_mail_events")
        .get(),
    ).toEqual({ count: 0 });
  });
});
