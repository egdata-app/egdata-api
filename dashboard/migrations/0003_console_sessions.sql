-- Console credentials are deliberately separate from public API keys.
CREATE TABLE console_sessions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  dashboard_session_hash TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, dashboard_session_hash)
);
CREATE INDEX console_sessions_expiry ON console_sessions(expires_at);
