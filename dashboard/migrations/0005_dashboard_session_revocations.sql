CREATE TABLE dashboard_session_revocations (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX dashboard_session_revocations_expiry
  ON dashboard_session_revocations(expires_at);
