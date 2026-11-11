-- D1 Schema for egdata Developer Portal & API Key Gateway

CREATE TABLE IF NOT EXISTS users (
  epic_account_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  preferred_language TEXT,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  owner_epic_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  website_url TEXT NOT NULL DEFAULT '',
  tier TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'enterprise')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  FOREIGN KEY (owner_epic_id) REFERENCES users(epic_account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_epic_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  owner_epic_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  tier TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'enterprise')),
  active INTEGER NOT NULL DEFAULT 1,
  scopes_json TEXT NOT NULL DEFAULT '["catalog:read","offers:read","items:read","search:read","graphql:read","profiles:read","stats:read"]',
  allowed_ips_json TEXT NOT NULL DEFAULT '[]',
  allowed_origins_json TEXT NOT NULL DEFAULT '[]',
  allowed_paths_json TEXT NOT NULL DEFAULT '[]',
  allowed_methods_json TEXT NOT NULL DEFAULT '["GET","HEAD"]',
  custom_rpm INTEGER,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_epic_id) REFERENCES users(epic_account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_api_keys_owner ON api_keys(owner_epic_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_project ON api_keys(project_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

CREATE TABLE IF NOT EXISTS limit_requests (
  id TEXT PRIMARY KEY,
  owner_epic_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  requested_tier TEXT NOT NULL CHECK (requested_tier IN ('pro', 'enterprise', 'custom')),
  requested_rpm INTEGER NOT NULL,
  expected_monthly_requests INTEGER NOT NULL,
  use_case TEXT NOT NULL,
  website_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  email_delivery_status TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  FOREIGN KEY (owner_epic_id) REFERENCES users(epic_account_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_limit_requests_owner ON limit_requests(owner_epic_id, created_at DESC);
