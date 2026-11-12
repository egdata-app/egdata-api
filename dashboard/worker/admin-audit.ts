export interface AuditInput {
  actor: string;
  action: string;
  reason: string;
  now: string;
  after: Record<string, unknown>;
}

/** INSERT SELECT snapshots the actual prior state inside the mutation batch. */
export function projectAudit(
  db: D1Database,
  input: AuditInput,
  condition: string,
  bindings: unknown[],
) {
  return db
    .prepare(`INSERT INTO admin_audit_log
    (actor_id,action,target_type,target_id,project_id,owner_id,reason,before_json,after_json,created_at)
    SELECT ?,?,'project',id,id,owner_epic_id,?,
      json_object('name',name,'tier',tier,'customRpm',custom_rpm,'deletedAt',deleted_at,'purgeAfter',purge_after),?,?
    FROM projects WHERE ${condition}`)
    .bind(
      input.actor,
      input.action,
      input.reason,
      JSON.stringify(input.after),
      input.now,
      ...bindings,
    );
}

export function userAudit(db: D1Database, input: AuditInput, id: string) {
  return db
    .prepare(`INSERT INTO admin_audit_log
    (actor_id,action,target_type,target_id,project_id,owner_id,reason,before_json,after_json,created_at)
    SELECT ?,?,'user',epic_account_id,NULL,epic_account_id,?,json_object('projectLimit',project_limit),?,?
    FROM users WHERE epic_account_id=?`)
    .bind(
      input.actor,
      input.action,
      input.reason,
      JSON.stringify(input.after),
      input.now,
      id,
    );
}

export function keyAudit(
  db: D1Database,
  input: AuditInput,
  condition: string,
  bindings: unknown[],
) {
  return db
    .prepare(`INSERT INTO admin_audit_log
    (actor_id,action,target_type,target_id,project_id,owner_id,reason,before_json,after_json,created_at)
    SELECT ?,?,'key',id,project_id,owner_epic_id,?,json_object('name',name,'active',active,'revokedAt',revoked_at),?,?
    FROM api_keys WHERE ${condition}`)
    .bind(
      input.actor,
      input.action,
      input.reason,
      JSON.stringify(input.after),
      input.now,
      ...bindings,
    );
}
