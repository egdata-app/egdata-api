import { DurableObject } from "cloudflare:workers";
import {
  type AdmissionResult,
  decideAdmission,
  type QuotaPolicy,
  type QuotaState,
  validatePolicies,
} from "./rate-limiter-core.js";

export type AdmissionRequest = {
  keyId: string;
  policies: QuotaPolicy[];
};

type StateRow = {
  window_start: number;
  global_count: number;
  policies_json: string;
};

/**
 * One SQLite-backed object per environment and internal API key identifier.
 *
 * The raw API key never reaches this class. State is a single bounded row per
 * key: the current 60-second window, the global counter, and at most a few
 * endpoint counters. No history, alarms, timers, or background work are kept.
 */
export class ApiKeyRateLimiter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS rate_limit_state (
        key_id TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        global_count INTEGER NOT NULL,
        policies_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  private readState(keyId: string): QuotaState | null {
    const row = this.ctx.storage.sql
      .exec<StateRow>(
        `SELECT window_start, global_count, policies_json
           FROM rate_limit_state
          WHERE key_id = ?`,
        keyId,
      )
      .toArray()[0];

    if (!row) return null;

    let policyCounts: Record<string, number> = {};
    try {
      const parsed = JSON.parse(row.policies_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [name, value] of Object.entries(parsed)) {
          if (Number.isInteger(value) && (value as number) >= 0) {
            policyCounts[name] = value as number;
          }
        }
      }
    } catch {
      policyCounts = {};
    }

    return {
      windowStart: row.window_start,
      globalCount: row.global_count,
      policyCounts,
    };
  }

  private writeState(keyId: string, state: QuotaState, now: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO rate_limit_state
         (key_id, window_start, global_count, policies_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key_id) DO UPDATE SET
         window_start = excluded.window_start,
         global_count = excluded.global_count,
         policies_json = excluded.policies_json,
         updated_at = excluded.updated_at`,
      keyId,
      state.windowStart,
      state.globalCount,
      JSON.stringify(state.policyCounts),
      now,
    );
  }

  /**
   * Single RPC conjoining the global and endpoint policies. The row is
   * persisted before admission is acknowledged; denials perform a read only.
   */
  admit(request: AdmissionRequest): AdmissionResult {
    if (!request || typeof request.keyId !== "string" || !request.keyId) {
      throw new Error("Invalid admission request");
    }
    validatePolicies(request.policies);

    const now = Date.now();
    const state = this.readState(request.keyId);
    const decision = decideAdmission({
      now,
      policies: request.policies,
      state,
    });

    if (!decision.result.allowed) {
      return decision.result;
    }

    this.writeState(request.keyId, decision.nextState, now);
    return decision.result;
  }
}
