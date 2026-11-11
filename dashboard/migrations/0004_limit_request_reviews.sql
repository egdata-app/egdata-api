CREATE TABLE user_roles (
  user_id TEXT NOT NULL REFERENCES users(epic_account_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (user_id, role)
);

-- Bootstrap the existing portal owner's account, never a display name or email.
INSERT INTO user_roles(user_id, role)
SELECT epic_account_id, 'admin' FROM users
WHERE epic_account_id = 'ac7b3a70e3ce4652b49c38e648001d9e';

ALTER TABLE projects ADD COLUMN custom_rpm INTEGER CHECK (custom_rpm BETWEEN 150 AND 500000);
ALTER TABLE limit_requests ADD COLUMN reviewed_by TEXT;
ALTER TABLE limit_requests ADD COLUMN reviewed_at TEXT;
ALTER TABLE limit_requests ADD COLUMN review_note TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_limit_requests_review_queue ON limit_requests(status, created_at, id);
