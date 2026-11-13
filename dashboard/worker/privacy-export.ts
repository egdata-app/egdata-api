/** Stream bounded pages; explicit column lists exclude credentials and token hashes. */
export function accountDataExport(db: D1Database, owner: string) {
  const sources = [
    [
      "account",
      "SELECT epic_account_id,display_name,preferred_language,created_at,updated_at FROM users WHERE epic_account_id=?",
    ],
    [
      "contact",
      "SELECT contact_email,verified_at,pending_email FROM developer_profiles WHERE owner_id=?",
    ],
    [
      "projects",
      "SELECT id,name,slug,description,website_url,tier,created_at,updated_at,deleted_at,purge_after FROM projects WHERE owner_epic_id=?",
    ],
    [
      "keys",
      "SELECT id,project_id,name,active,tier,scopes_json,allowed_ips_json,allowed_origins_json,allowed_paths_json,allowed_methods_json,custom_rpm,expires_at,last_used_at,revoked_at,created_at FROM api_keys WHERE owner_epic_id=?",
    ],
    [
      "limit_requests",
      "SELECT id,project_id,contact_email,requested_tier,requested_rpm,expected_monthly_requests,use_case,website_url,status,created_at,reviewed_at,review_note FROM limit_requests WHERE owner_epic_id=?",
    ],
    [
      "acceptances",
      "SELECT receipt_id,version,edition,sha256,accepted_at,requirement_revision,privacy_version,privacy_sha256 FROM legal_acceptances WHERE owner_id=? AND retain_until IS NULL",
    ],
    [
      "endpoint_usage",
      "SELECT project_id,key_id,operation_id,usage_date,first_used_at FROM usage_daily WHERE project_id IN (SELECT id FROM projects WHERE owner_epic_id=?)",
    ],
    [
      "alert_reads",
      "SELECT project_id,record_id,read_at FROM alert_reads WHERE user_id=?",
    ],
  ] as const;
  const encoder = new TextEncoder();
  let source = 0;
  let cursor = 0;
  let started = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!started) {
          started = true;
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({ section: "export", generated_at: new Date().toISOString(), scope: "Developer account records in D1. For analytics, security, support, backups, or a complete rights request, contact contact@egdata.app. Credentials and verification secrets are excluded." })}\n`,
            ),
          );
          return;
        }
        while (source < sources.length) {
          const current = sources[source];
          if (!current) {
            controller.close();
            return;
          }
          const [section, query] = current;
          const { results } = await db
            .prepare(
              `${query.replace("SELECT ", "SELECT rowid AS __cursor,")} AND rowid>? ORDER BY rowid LIMIT 250`,
            )
            .bind(owner, cursor)
            .all<Record<string, unknown> & { __cursor: number }>();
          if (results.length)
            controller.enqueue(
              encoder.encode(
                `${results
                  .map(({ __cursor, ...record }) =>
                    JSON.stringify({ section, record }),
                  )
                  .join("\n")}\n`,
              ),
            );
          if (results.length < 250) {
            source++;
            cursor = 0;
          } else cursor = results[results.length - 1].__cursor;
          if (results.length) return;
        }
        controller.enqueue(
          encoder.encode(`${JSON.stringify({ section: "complete" })}\n`),
        );
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": 'attachment; filename="egdata-account.ndjson"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
