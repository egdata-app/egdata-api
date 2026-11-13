-- Paid plans, Stripe billing control plane, and explicit entitlement grants.
-- Safely expands CHECK constraints on projects/api_keys/limit_requests to allow
-- the 'scale' tier while preserving all rows, triggers, indexes, and foreign keys.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE _tmp_console_sessions AS SELECT * FROM console_sessions;
CREATE TABLE _tmp_limit_requests AS SELECT * FROM limit_requests;
CREATE TABLE _tmp_api_keys AS SELECT * FROM api_keys;
CREATE TABLE _tmp_projects AS SELECT * FROM projects;

DROP TRIGGER IF EXISTS active_project_for_console;
DROP TRIGGER IF EXISTS active_project_for_key;
DROP TRIGGER IF EXISTS enforce_project_creation_policy;
DROP TRIGGER IF EXISTS record_project_creation;

DROP TABLE console_sessions;
DROP TABLE limit_requests;
DROP TABLE api_keys;
DROP TABLE projects;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  owner_epic_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  website_url TEXT NOT NULL DEFAULT '',
  tier TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'scale', 'enterprise')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  custom_rpm INTEGER CHECK (custom_rpm BETWEEN 150 AND 500000),
  deleted_at TEXT,
  deleted_by TEXT,
  deletion_reason TEXT,
  purge_after TEXT,
  FOREIGN KEY (owner_epic_id) REFERENCES users(epic_account_id) ON DELETE CASCADE
);

INSERT INTO projects (
  id, owner_epic_id, name, slug, description, website_url, tier,
  created_at, updated_at, custom_rpm, deleted_at, deleted_by, deletion_reason, purge_after
)
SELECT
  id, owner_epic_id, name, slug, description, website_url, tier,
  created_at, updated_at, custom_rpm, deleted_at, deleted_by, deletion_reason, purge_after
FROM _tmp_projects;

CREATE INDEX idx_projects_owner ON projects(owner_epic_id);
CREATE INDEX projects_purge_after ON projects(purge_after) WHERE deleted_at IS NOT NULL;

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  owner_epic_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  tier TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'scale', 'enterprise')),
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

INSERT INTO api_keys (
  id, project_id, owner_epic_id, name, key_prefix, key_hash, tier, active,
  scopes_json, allowed_ips_json, allowed_origins_json, allowed_paths_json, allowed_methods_json,
  custom_rpm, expires_at, last_used_at, revoked_at, created_at, updated_at
)
SELECT
  id, project_id, owner_epic_id, name, key_prefix, key_hash, tier, active,
  scopes_json, allowed_ips_json, allowed_origins_json, allowed_paths_json, allowed_methods_json,
  custom_rpm, expires_at, last_used_at, revoked_at, created_at, updated_at
FROM _tmp_api_keys;

CREATE INDEX idx_api_keys_owner ON api_keys(owner_epic_id);
CREATE INDEX idx_api_keys_project ON api_keys(project_id);
CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);

CREATE TABLE limit_requests (
  id TEXT PRIMARY KEY,
  owner_epic_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  requested_tier TEXT NOT NULL CHECK (requested_tier IN ('pro', 'scale', 'enterprise', 'custom')),
  requested_rpm INTEGER NOT NULL,
  expected_monthly_requests INTEGER NOT NULL,
  use_case TEXT NOT NULL,
  website_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  email_delivery_status TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_note TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (owner_epic_id) REFERENCES users(epic_account_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

INSERT INTO limit_requests (
  id, owner_epic_id, project_id, contact_email, requested_tier, requested_rpm,
  expected_monthly_requests, use_case, website_url, status, email_delivery_status,
  created_at, reviewed_by, reviewed_at, review_note
)
SELECT
  id, owner_epic_id, project_id, contact_email, requested_tier, requested_rpm,
  expected_monthly_requests, use_case, website_url, status, email_delivery_status,
  created_at, reviewed_by, reviewed_at, review_note
FROM _tmp_limit_requests;

CREATE INDEX idx_limit_requests_owner ON limit_requests(owner_epic_id, created_at DESC);
CREATE INDEX idx_limit_requests_review_queue ON limit_requests(status, created_at, id);
CREATE INDEX resolved_limit_request_expiry ON limit_requests(status, reviewed_at);

CREATE TABLE console_sessions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  dashboard_session_hash TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, dashboard_session_hash)
);

INSERT INTO console_sessions (project_id, dashboard_session_hash, token_hash, expires_at)
SELECT project_id, dashboard_session_hash, token_hash, expires_at FROM _tmp_console_sessions;

CREATE INDEX console_sessions_expiry ON console_sessions(expires_at);

DROP TABLE _tmp_console_sessions;
DROP TABLE _tmp_limit_requests;
DROP TABLE _tmp_api_keys;
DROP TABLE _tmp_projects;

CREATE TRIGGER enforce_project_creation_policy BEFORE INSERT ON projects
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM projects WHERE owner_epic_id=NEW.owner_epic_id AND deleted_at IS NULL)
    >= (SELECT project_limit FROM users WHERE epic_account_id=NEW.owner_epic_id)
    THEN RAISE(ABORT, 'PROJECT_LIMIT_REACHED') END;
  SELECT CASE WHEN (SELECT last_project_created_at FROM users WHERE epic_account_id=NEW.owner_epic_id)
    > CAST(strftime('%s','now') AS INTEGER)-86400
    THEN RAISE(ABORT, 'PROJECT_CREATION_COOLDOWN') END;
END;

CREATE TRIGGER record_project_creation
AFTER INSERT ON projects
BEGIN
  UPDATE users SET last_project_created_at = CAST(strftime('%s', 'now') AS INTEGER)
  WHERE epic_account_id = NEW.owner_epic_id;
END;

CREATE TRIGGER active_project_for_key BEFORE INSERT ON api_keys
WHEN EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'PROJECT_DELETED'); END;

CREATE TRIGGER active_project_for_console BEFORE INSERT ON console_sessions
WHEN EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'PROJECT_DELETED'); END;

-- Versioned plan specifications. Published versions remain immutable once sold.
CREATE TABLE IF NOT EXISTS plan_versions (
  version_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL CHECK (plan_id IN ('free', 'pro', 'scale')),
  tier TEXT NOT NULL CHECK (tier IN ('free', 'pro', 'scale', 'enterprise')),
  display_name TEXT NOT NULL,
  price_eur_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'eur',
  vat_included INTEGER NOT NULL DEFAULT 1,
  billing_interval TEXT NOT NULL DEFAULT 'month',
  period_type TEXT NOT NULL CHECK (period_type IN ('calendar_month', 'billing_period')),
  rpm_limit INTEGER NOT NULL,
  period_allowance INTEGER NOT NULL,
  expensive_limits_json TEXT NOT NULL,
  entitlements_json TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

INSERT OR IGNORE INTO plan_versions (
  version_id, plan_id, tier, display_name, price_eur_cents, currency, vat_included,
  billing_interval, period_type, rpm_limit, period_allowance, expensive_limits_json, entitlements_json
) VALUES
  (
    'free-v1', 'free', 'free', 'Free', 0, 'eur', 1, 'month', 'calendar_month', 60, 100000,
    '{"minute":{"offers-list":5,"search":60,"heavy":20,"bulk":5},"period":{"nl-search":500,"bulk":1000,"image":2000}}',
    '["catalog:ordinary","search:basic","search:nl","image:og","bulk:resolve","graphql:read"]'
  ),
  (
    'pro-v1', 'pro', 'pro', 'Pro', 900, 'eur', 1, 'month', 'billing_period', 200, 300000,
    '{"minute":{"offers-list":20,"search":200,"heavy":60,"bulk":15},"period":{"nl-search":2500,"bulk":10000,"image":15000}}',
    '["catalog:ordinary","search:basic","search:nl","image:og","bulk:resolve","graphql:read","tier:pro"]'
  ),
  (
    'scale-v1', 'scale', 'scale', 'Scale', 1900, 'eur', 1, 'month', 'billing_period', 600, 1000000,
    '{"minute":{"offers-list":60,"search":600,"heavy":180,"bulk":40},"period":{"nl-search":10000,"bulk":40000,"image":50000}}',
    '["catalog:ordinary","search:basic","search:nl","image:og","bulk:resolve","graphql:read","tier:pro","tier:scale"]'
  );

-- One Stripe customer per developer account per Stripe environment.
CREATE TABLE IF NOT EXISTS billing_customers (
  owner_epic_id TEXT PRIMARY KEY,
  stripe_customer_id TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'live' CHECK (environment IN ('test', 'live')),
  email TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (environment, stripe_customer_id)
);

-- Project-scoped Stripe subscription records (retained for financial/dispute audit even if project/account deletes).
CREATE TABLE IF NOT EXISTS billing_subscriptions (
  id TEXT PRIMARY KEY,
  owner_epic_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  stripe_customer_id TEXT NOT NULL,
  stripe_subscription_id TEXT,
  stripe_subscription_item_id TEXT,
  stripe_checkout_session_id TEXT,
  stripe_price_id TEXT,
  plan_version_id TEXT NOT NULL REFERENCES plan_versions(version_id),
  pending_plan_version_id TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'checkout_pending',
    'incomplete',
    'trialing',
    'active',
    'past_due',
    'canceled',
    'unpaid',
    'incomplete_expired',
    'paused'
  )),
  environment TEXT NOT NULL DEFAULT 'live' CHECK (environment IN ('test', 'live')),
  current_period_start INTEGER NOT NULL,
  current_period_end INTEGER NOT NULL,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  canceled_at INTEGER,
  grace_until INTEGER,
  last_event_created INTEGER NOT NULL DEFAULT 0,
  last_invoice_id TEXT,
  dispute_status TEXT NOT NULL DEFAULT 'none' CHECK (dispute_status IN ('none', 'needs_response', 'under_review', 'won', 'lost')),
  refund_status TEXT NOT NULL DEFAULT 'none' CHECK (refund_status IN ('none', 'requested', 'partial', 'full', 'failed')),
  refunded_eur_cents INTEGER NOT NULL DEFAULT 0,
  needs_reconcile INTEGER NOT NULL DEFAULT 0,
  reconcile_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_sub_stripe_id
  ON billing_subscriptions(environment, stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_sub_checkout_id
  ON billing_subscriptions(environment, stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_sub_live_project
  ON billing_subscriptions(project_id)
  WHERE status IN ('checkout_pending', 'incomplete', 'trialing', 'active', 'past_due');
CREATE INDEX IF NOT EXISTS idx_billing_sub_owner ON billing_subscriptions(owner_epic_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_sub_reconcile
  ON billing_subscriptions(needs_reconcile, updated_at)
  WHERE needs_reconcile = 1;

-- Authoritative server-owned project entitlement grants.
CREATE TABLE IF NOT EXISTS entitlement_grants (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_epic_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('free', 'subscription', 'manual', 'grandfathered')),
  plan_id TEXT NOT NULL,
  plan_version_id TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('free', 'pro', 'scale', 'enterprise')),
  rpm_limit INTEGER NOT NULL,
  period_allowance INTEGER,
  expensive_limits_json TEXT NOT NULL,
  effective_from INTEGER NOT NULL,
  effective_until INTEGER,
  revision INTEGER NOT NULL,
  subscription_id TEXT REFERENCES billing_subscriptions(id) ON DELETE SET NULL,
  granted_by TEXT,
  reason TEXT NOT NULL DEFAULT '',
  revoked_at INTEGER,
  revoked_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_entitlement_grants_active
  ON entitlement_grants(project_id, revision DESC, created_at DESC)
  WHERE revoked_at IS NULL;

-- Backfill existing paid/manual projects explicitly so they are never treated as Stripe subscriptions.
-- Free projects with custom_rpm stay on the free-v1 calendar-month plan via evaluatePlanEntitlement.
INSERT OR IGNORE INTO entitlement_grants (
  id, project_id, owner_epic_id, source, plan_id, plan_version_id, tier,
  rpm_limit, period_allowance, expensive_limits_json, effective_from, effective_until,
  revision, subscription_id, granted_by, reason
)
SELECT
  'grant_legacy_' || id,
  id,
  owner_epic_id,
  'manual',
  CASE WHEN tier = 'enterprise' THEN 'enterprise' ELSE tier END,
  'manual-custom',
  tier,
  COALESCE(
    custom_rpm,
    CASE WHEN tier = 'enterprise' THEN 6000 ELSE 1200 END
  ),
  NULL,
  '{}',
  0,
  NULL,
  1,
  NULL,
  'migration_0012',
  'Existing non-free grant preserved from pre-billing model'
FROM projects
WHERE tier IN ('pro', 'enterprise');

-- Durable idempotent webhook inbox.
CREATE TABLE IF NOT EXISTS stripe_event_inbox (
  environment TEXT NOT NULL DEFAULT 'live' CHECK (environment IN ('test', 'live')),
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  stripe_created INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'failed', 'ignored')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  payload_summary_json TEXT NOT NULL DEFAULT '{}',
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  processed_at TEXT,
  PRIMARY KEY (environment, event_id)
);

CREATE INDEX IF NOT EXISTS idx_stripe_inbox_retry
  ON stripe_event_inbox(status, next_attempt_at)
  WHERE status IN ('received', 'failed');

-- Period usage summaries & auditable credits.
CREATE TABLE IF NOT EXISTS usage_periods (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  owner_epic_id TEXT NOT NULL,
  subscription_id TEXT,
  plan_version_id TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  included_allowance INTEGER NOT NULL,
  used_requests INTEGER NOT NULL DEFAULT 0,
  credited_requests INTEGER NOT NULL DEFAULT 0,
  expensive_usage_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (project_id, period_start, period_end)
);

CREATE TABLE IF NOT EXISTS usage_adjustments (
  adjustment_id TEXT PRIMARY KEY,
  project_id TEXT,
  owner_epic_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('period', 'month')),
  window_start INTEGER NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 1),
  reason TEXT NOT NULL,
  actor_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_usage_adjustments_project
  ON usage_adjustments(project_id, created_at DESC);

-- Statutory/purchase disclosures & consumer withdrawal audit trail.
CREATE TABLE IF NOT EXISTS purchase_receipts (
  id TEXT PRIMARY KEY,
  owner_epic_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  subscription_id TEXT,
  stripe_checkout_session_id TEXT,
  plan_version_id TEXT NOT NULL,
  price_eur_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'eur',
  vat_included INTEGER NOT NULL DEFAULT 1,
  terms_version TEXT NOT NULL,
  withdrawal_acknowledged INTEGER NOT NULL DEFAULT 1,
  withdrawal_expires_at INTEGER NOT NULL,
  action_type TEXT NOT NULL DEFAULT 'checkout',
  accepted_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_purchase_receipts_owner
  ON purchase_receipts(owner_epic_id, created_at DESC);

CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id TEXT PRIMARY KEY,
  owner_epic_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  request_kind TEXT NOT NULL CHECK (request_kind IN ('statutory_withdrawal', 'goodwill_refund')),
  status TEXT NOT NULL CHECK (status IN ('requested', 'refund_pending', 'refunded_full', 'refunded_partial', 'denied', 'failed')),
  requested_amount_cents INTEGER,
  refunded_amount_cents INTEGER NOT NULL DEFAULT 0,
  stripe_refund_id TEXT,
  reason TEXT NOT NULL DEFAULT '',
  resolution_note TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_owner
  ON withdrawal_requests(owner_epic_id, created_at DESC);

CREATE TABLE IF NOT EXISTS billing_actions (
  id TEXT PRIMARY KEY,
  owner_epic_id TEXT NOT NULL,
  project_id TEXT,
  subscription_id TEXT,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_billing_actions_owner
  ON billing_actions(owner_epic_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_actions_project
  ON billing_actions(project_id, created_at DESC);
