-- Website first-party identity for egdata.app (SSR and browser ephemeral tokens)
-- In production/deployed environments, seeds website project identity.
-- In empty test databases, dev seed or fallback resolves identity.

INSERT OR IGNORE INTO users (
  epic_account_id, display_name, project_limit, last_project_created_at, created_at, updated_at
)
SELECT
  'egdata_web_owner', 'EGDATA Web', 100, 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE EXISTS (SELECT 1 FROM users);

INSERT OR IGNORE INTO user_roles (user_id, role)
SELECT 'egdata_web_owner', 'admin'
WHERE EXISTS (SELECT 1 FROM users WHERE epic_account_id = 'egdata_web_owner');

INSERT OR IGNORE INTO projects (
  id, owner_epic_id, name, slug, description, website_url, tier, created_at, updated_at
)
SELECT
  'prj_egdata_web',
  'egdata_web_owner',
  'egdata.app',
  'egdata-web',
  'Official egdata.app website (SSR & Browser)',
  'https://egdata.app',
  'enterprise',
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE EXISTS (SELECT 1 FROM users WHERE epic_account_id = 'egdata_web_owner');

INSERT OR IGNORE INTO entitlement_grants (
  id, project_id, owner_epic_id, source, plan_id, plan_version_id, tier,
  rpm_limit, period_allowance, expensive_limits_json, effective_from, effective_until,
  revision, subscription_id, granted_by, reason, created_at, updated_at
)
SELECT
  'egr_egdata_web_enterprise',
  'prj_egdata_web',
  'egdata_web_owner',
  'manual',
  'enterprise',
  'manual-custom',
  'enterprise',
  6000,
  NULL,
  '{}',
  0,
  NULL,
  1,
  NULL,
  'system',
  'Official egdata.app website',
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE EXISTS (SELECT 1 FROM projects WHERE id = 'prj_egdata_web');

INSERT OR IGNORE INTO api_keys (
  id, project_id, owner_epic_id, name, key_prefix, key_hash, tier, active,
  scopes_json, allowed_ips_json, allowed_origins_json, allowed_paths_json, allowed_methods_json,
  created_at, updated_at
)
SELECT
  'key_egdata_web_browser',
  'prj_egdata_web',
  'egdata_web_owner',
  'egdata.app Browser (Ephemeral)',
  'egw_browser_',
  'system_ephemeral_browser_key_hash',
  'enterprise',
  1,
  '["catalog:read","offers:read","items:read","search:read","stats:read","builds:read"]',
  '[]',
  '["https://egdata.app"]',
  '[]',
  '["GET","HEAD","POST"]',
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE EXISTS (SELECT 1 FROM projects WHERE id = 'prj_egdata_web');

INSERT OR IGNORE INTO api_keys (
  id, project_id, owner_epic_id, name, key_prefix, key_hash, tier, active,
  scopes_json, allowed_ips_json, allowed_origins_json, allowed_paths_json, allowed_methods_json,
  created_at, updated_at
)
SELECT
  'key_egdata_web_ssr',
  'prj_egdata_web',
  'egdata_web_owner',
  'egdata.app SSR (Internal)',
  'egw_ssr_',
  'system_internal_ssr_key_hash',
  'enterprise',
  1,
  '["catalog:read","offers:read","items:read","search:read","stats:read","builds:read"]',
  '[]',
  '[]',
  '[]',
  '["GET","HEAD","POST"]',
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE EXISTS (SELECT 1 FROM projects WHERE id = 'prj_egdata_web');
