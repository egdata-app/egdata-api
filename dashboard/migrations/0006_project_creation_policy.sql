-- Existing projects and API keys are retained. Accounts above the default cap
-- may continue using those projects but cannot create more without approval.
ALTER TABLE users ADD COLUMN project_limit INTEGER NOT NULL DEFAULT 1
  CHECK (project_limit BETWEEN 1 AND 100);
ALTER TABLE users ADD COLUMN last_project_created_at INTEGER;

UPDATE users SET last_project_created_at = (
  SELECT MAX(CAST(strftime('%s', created_at) AS INTEGER))
  FROM projects WHERE owner_epic_id = users.epic_account_id
);

-- Checks and timestamp updates are part of the INSERT transaction, including
-- automatic project creation at login. The timestamp survives project deletion.
CREATE TRIGGER enforce_project_creation_policy
BEFORE INSERT ON projects
BEGIN
  SELECT CASE WHEN (
    SELECT COUNT(*) FROM projects WHERE owner_epic_id = NEW.owner_epic_id
  ) >= (
    SELECT project_limit FROM users WHERE epic_account_id = NEW.owner_epic_id
  ) THEN RAISE(ABORT, 'PROJECT_LIMIT_REACHED') END;

  SELECT CASE WHEN (
    SELECT last_project_created_at FROM users
    WHERE epic_account_id = NEW.owner_epic_id
  ) > CAST(strftime('%s', 'now') AS INTEGER) - 86400
  THEN RAISE(ABORT, 'PROJECT_CREATION_COOLDOWN') END;
END;

CREATE TRIGGER record_project_creation
AFTER INSERT ON projects
BEGIN
  UPDATE users SET last_project_created_at = CAST(strftime('%s', 'now') AS INTEGER)
  WHERE epic_account_id = NEW.owner_epic_id;
END;
