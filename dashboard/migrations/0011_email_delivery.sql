ALTER TABLE developer_mail ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
CREATE TABLE developer_mail_attempts (
  message_id TEXT PRIMARY KEY,
  mail_id TEXT NOT NULL REFERENCES developer_mail(id) ON DELETE CASCADE,
  dispatched_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','deferred','delivered','bounced','failed','rejected','complained')),
  event_at INTEGER,
  terminal_failure INTEGER NOT NULL DEFAULT 0 CHECK(terminal_failure IN (0,1))
);
CREATE INDEX mail_attempts_mail ON developer_mail_attempts(mail_id);
-- Minimal lifecycle inbox supports events that arrive before the send response.
-- No recipient, message body, subject or SMTP response is retained here.
CREATE TABLE developer_mail_events (
  event_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('deferred','delivered','bounced','failed','rejected','complained')),
  event_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX mail_events_message ON developer_mail_events(message_id,event_at);
