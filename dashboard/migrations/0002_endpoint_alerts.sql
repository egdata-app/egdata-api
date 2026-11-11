-- Daily usage retention is independent of persistent alert history.
CREATE TABLE usage_daily (
  project_id TEXT NOT NULL, key_id TEXT NOT NULL, operation_id TEXT NOT NULL,
  usage_date TEXT NOT NULL, first_used_at INTEGER NOT NULL,
  PRIMARY KEY (key_id, operation_id, usage_date)
);
CREATE INDEX usage_match ON usage_daily(operation_id, usage_date, first_used_at);
CREATE INDEX usage_project ON usage_daily(project_id, usage_date);
CREATE TABLE change_records (
  id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, record_json TEXT NOT NULL,
  merge_commit TEXT NOT NULL, merged_at INTEGER NOT NULL, window_start TEXT NOT NULL,
  merge_date TEXT NOT NULL, import_complete INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE change_operations (
  record_id TEXT NOT NULL REFERENCES change_records(id), api_version TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  PRIMARY KEY(record_id, api_version, operation_id)
);
CREATE INDEX changes_by_operation ON change_operations(api_version, operation_id, record_id);
CREATE TABLE endpoint_registry (
  endpoint_key TEXT PRIMARY KEY, api_version TEXT NOT NULL, operation_id TEXT NOT NULL,
  method TEXT NOT NULL, path TEXT NOT NULL, status TEXT NOT NULL, last_merged_at INTEGER NOT NULL
);
CREATE TABLE project_alerts (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL,
  record_id TEXT NOT NULL REFERENCES change_records(id),
  UNIQUE(project_id, record_id)
);
CREATE TABLE alert_matches (
  project_id TEXT NOT NULL, record_id TEXT NOT NULL, operation_id TEXT NOT NULL,
  key_id TEXT NOT NULL, first_used_at INTEGER NOT NULL,
  PRIMARY KEY(project_id, record_id, operation_id, key_id),
  FOREIGN KEY(record_id) REFERENCES change_records(id)
);
CREATE TABLE alert_reads (
  user_id TEXT NOT NULL, project_id TEXT NOT NULL, record_id TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, project_id, record_id)
);
CREATE TABLE tracking_health (
  id TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE usage_dead_letters (
  key_id TEXT NOT NULL, operation_id TEXT NOT NULL, usage_date TEXT NOT NULL,
  event_json TEXT NOT NULL, received_at INTEGER NOT NULL,
  PRIMARY KEY(key_id,operation_id,usage_date)
);
