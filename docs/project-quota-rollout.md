# Project quota rollout

Recorded 2026-11-12. Deployment is a separate operator action.

## Policy

- All keys and console sessions in a project share one quota across authenticated
  legacy and v1 gateway requests. Existing project tier/custom RPM is authoritative.
- Expensive v1 operations share their existing numerical caps at project scope.
- One project per account by default. Additional projects require operator approval.
- Project creation has a 24-hour account cooldown, including automatic creation
  during login. Deleting a project does not clear that timestamp.
- Existing projects and keys are retained, even when their account is over its cap.
  The cap blocks creation, not requests to existing projects.

## Before deployment

Review current accounts and project grants in D1 (read-only):

```sql
SELECT u.epic_account_id, u.display_name, COUNT(p.id) AS project_count
FROM users u LEFT JOIN projects p ON p.owner_epic_id = u.epic_account_id
GROUP BY u.epic_account_id, u.display_name;

SELECT p.id, p.owner_epic_id, p.tier, p.custom_rpm, COUNT(k.id) AS key_count
FROM projects p LEFT JOIN api_keys k ON k.project_id = p.id AND k.revoked_at IS NULL
GROUP BY p.id, p.owner_epic_id, p.tier, p.custom_rpm;

-- Investigate any historical key-only grants before making projects authoritative.
SELECT k.id, k.project_id, k.tier, k.custom_rpm,
       p.tier AS project_tier, p.custom_rpm AS project_custom_rpm
FROM api_keys k JOIN projects p ON p.id = k.project_id
WHERE k.revoked_at IS NULL
  AND (k.tier <> p.tier OR k.custom_rpm IS NOT p.custom_rpm);
```

Review discrepancies explicitly; apply legitimate grants to the project using the
existing administrator limit-review flow. Notify existing users that their keys
remain valid but now share the project's allowance. Recommend coordinating request
budgets and respecting `Retry-After` rather than rotating keys.

## Deployment order

1. Apply D1 migration `0006_project_creation_policy.sql` with the existing dashboard
   migration command: `pnpm --filter @egdata/dashboard db:migrate:remote`.
   It backfills creation timestamps, retains all projects, and atomically enforces
   the account cap and cooldown with insert triggers.
2. Deploy the dashboard Worker and updated public docs through the normal manual
   release process. No API key rotation or Durable Object class migration is needed.
3. New requests route to `project:<environment>:<projectId>`. The deployed
   `ApiKeyRateLimiter` class/binding name stays stable so old usage outbox alarms and
   in-flight old-version RPCs can finish. Cutover starts new project counters;
   previous per-key minute counts are not aggregated. Schedule a minute-boundary
   cutover and avoid a prolonged mixed-version rollout.
4. Allow up to five minutes for pre-existing key metadata caches to expire after
   grant changes. Check two keys from one project, a console session, and both
   gateways: they should consume one allowance. Verify an unrelated project has
   an independent allowance and unavailable admission returns 503, not a bypass.

## Approving additional projects

After reviewing a request, an operator can set the account's total allowance in D1:

```sql
UPDATE users SET project_limit = 2 WHERE epic_account_id = '<approved-account-id>';
```

The 24-hour creation cooldown still applies. Setting an allowance below the current
project count preserves all existing projects and blocks further creation. This
setting is not accepted from dashboard clients. Each additional project adds its
own quota, so approve it as additional capacity.
