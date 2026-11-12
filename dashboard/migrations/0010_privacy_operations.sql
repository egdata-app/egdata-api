-- Purge obsolete avatar URLs, including accounts that have not logged in again.
UPDATE users SET avatar_url=NULL;
CREATE INDEX IF NOT EXISTS admin_audit_expiry ON admin_audit_log(created_at);
CREATE INDEX IF NOT EXISTS resolved_limit_request_expiry ON limit_requests(status,reviewed_at);

-- Operator-managed rights cases also support people without a developer account.
-- Store a mailbox/case reference, not copied correspondence or identity documents.
CREATE TABLE privacy_requests (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  case_reference TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('access','erasure','rectification','restriction','objection','portability')),
  received_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  extended_due_at INTEGER,
  extension_reason TEXT,
  extension_notified_at INTEGER,
  resolved_at INTEGER,
  resolution TEXT,
  created_by TEXT NOT NULL,
  CHECK(extended_due_at IS NULL OR (extension_reason IS NOT NULL AND extension_notified_at IS NOT NULL))
);
CREATE INDEX privacy_request_due ON privacy_requests(resolved_at,due_at);
CREATE INDEX privacy_request_owner ON privacy_requests(owner_id);

-- Minimum restore/restriction evidence; contains no email, IP or credential.
CREATE TABLE privacy_actions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES privacy_requests(id) ON DELETE CASCADE,
  store TEXT NOT NULL,
  action TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  evidence_reference TEXT NOT NULL
);
