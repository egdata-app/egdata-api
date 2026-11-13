-- Deploy schema before the Worker. No draft documents or active requirement are seeded.
CREATE TABLE developer_profiles (
  owner_id TEXT PRIMARY KEY REFERENCES users(epic_account_id) ON DELETE CASCADE,
  contact_email TEXT,
  verified_at INTEGER,
  pending_email TEXT,
  token_hash TEXT,
  token_expires_at INTEGER,
  last_sent_at INTEGER NOT NULL DEFAULT 0,
  send_day TEXT NOT NULL DEFAULT '',
  send_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX developer_profile_token_expiry ON developer_profiles(token_expires_at) WHERE token_expires_at IS NOT NULL;
CREATE TABLE legal_documents (
  kind TEXT NOT NULL CHECK(kind IN ('terms','privacy')),
  version TEXT NOT NULL,
  edition TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  body TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  PRIMARY KEY(kind,version)
);
CREATE TRIGGER immutable_legal_document_update BEFORE UPDATE ON legal_documents
BEGIN SELECT RAISE(ABORT,'LEGAL_DOCUMENT_IMMUTABLE'); END;
CREATE TRIGGER immutable_legal_document_delete BEFORE DELETE ON legal_documents
BEGIN SELECT RAISE(ABORT,'LEGAL_DOCUMENT_IMMUTABLE'); END;
CREATE TABLE legal_rollout (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision TEXT NOT NULL,
  terms_version TEXT NOT NULL,
  privacy_version TEXT NOT NULL
);
CREATE TRIGGER validate_initial_legal_rollout BEFORE INSERT ON legal_rollout
WHEN NOT EXISTS(SELECT 1 FROM legal_documents WHERE kind='terms' AND version=NEW.terms_version)
  OR NOT EXISTS(SELECT 1 FROM legal_documents WHERE kind='privacy' AND version=NEW.privacy_version)
BEGIN SELECT RAISE(ABORT,'LEGAL_DOCUMENT_MISSING'); END;
-- No FK to users: minimal acceptance evidence survives account deletion.
CREATE TABLE legal_acceptances (
  owner_id TEXT NOT NULL,
  version TEXT NOT NULL,
  edition TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  requirement_revision TEXT NOT NULL,
  retain_until INTEGER,
  PRIMARY KEY(owner_id,version,accepted_at)
);
CREATE UNIQUE INDEX current_legal_acceptance ON legal_acceptances(owner_id,version) WHERE retain_until IS NULL;
CREATE INDEX legal_acceptance_expiry ON legal_acceptances(retain_until) WHERE retain_until IS NOT NULL;
CREATE TABLE account_closures (
  owner_id TEXT PRIMARY KEY,
  closed_at INTEGER NOT NULL,
  purge_after INTEGER NOT NULL
);
CREATE TABLE developer_mail (
  id TEXT PRIMARY KEY,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  leased_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX developer_mail_pending ON developer_mail(sent_at,leased_until,created_at);
-- Prevent an in-flight OAuth/session upsert from recreating a closed account.
CREATE TRIGGER reject_closed_account BEFORE INSERT ON users
WHEN EXISTS(SELECT 1 FROM account_closures WHERE owner_id=NEW.epic_account_id)
BEGIN SELECT RAISE(ABORT,'ACCOUNT_CLOSED'); END;
