-- Deleted projects remain available to administrators for 90 days.
ALTER TABLE projects ADD COLUMN deleted_at TEXT;
ALTER TABLE projects ADD COLUMN deleted_by TEXT;
ALTER TABLE projects ADD COLUMN deletion_reason TEXT;
ALTER TABLE projects ADD COLUMN purge_after TEXT;
CREATE INDEX projects_purge_after ON projects(purge_after) WHERE deleted_at IS NOT NULL;

-- No foreign keys: this minimal history must survive project/key purging.
CREATE TABLE admin_audit_log (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  project_id TEXT,
  owner_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX admin_audit_project ON admin_audit_log(project_id, sequence DESC);
CREATE INDEX admin_audit_owner ON admin_audit_log(owner_id, sequence DESC);

DROP TRIGGER IF EXISTS enforce_project_creation_policy;
CREATE TRIGGER enforce_project_creation_policy BEFORE INSERT ON projects
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM projects WHERE owner_epic_id=NEW.owner_epic_id AND deleted_at IS NULL)
    >= (SELECT project_limit FROM users WHERE epic_account_id=NEW.owner_epic_id)
    THEN RAISE(ABORT, 'PROJECT_LIMIT_REACHED') END;
  SELECT CASE WHEN (SELECT last_project_created_at FROM users WHERE epic_account_id=NEW.owner_epic_id)
    > CAST(strftime('%s','now') AS INTEGER)-86400
    THEN RAISE(ABORT, 'PROJECT_CREATION_COOLDOWN') END;
END;

-- Prevent races from recreating credentials after a project deletion commits.
CREATE TRIGGER active_project_for_key BEFORE INSERT ON api_keys
WHEN EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'PROJECT_DELETED'); END;
CREATE TRIGGER active_project_for_console BEFORE INSERT ON console_sessions
WHEN EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'PROJECT_DELETED'); END;
