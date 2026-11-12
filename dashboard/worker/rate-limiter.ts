import { DurableObject } from "cloudflare:workers";
import {
  type AdmissionResult,
  decideAdmission,
  type QuotaPolicy,
  type QuotaState,
  validatePolicies,
} from "./rate-limiter-core.js";
import type { DashboardEnv } from "./types.js";
import {
  captureUsage,
  createUsageOutbox,
  flushUsage,
  scheduleUsage,
} from "./usage-outbox.js";
import { generatedV1Routes } from "./v1-routes.generated.js";

export type AdmissionRequest = {
  keyId: string;
  projectId?: string;
  policies: QuotaPolicy[];
  usage?: { projectId: string; operationId: string };
};

type StateRow = {
  window_start: number;
  global_count: number;
  policies_json: string;
};

/**
 * One SQLite-backed object per environment and project identifier.
 *
 * The raw API key never reaches this class. State is a single bounded row per
 * project: the current 60-second window, global and endpoint counters. Optional
 * usage buckets and their durable outbox share the admission transaction.
 */
export class ApiKeyRateLimiter extends DurableObject<DashboardEnv> {
  constructor(ctx: DurableObjectState, env: DashboardEnv) {
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
    createUsageOutbox(ctx.storage);
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
  async admit(request: AdmissionRequest): Promise<AdmissionResult> {
    if (!request || typeof request.keyId !== "string" || !request.keyId) {
      throw new Error("Invalid admission request");
    }
    validatePolicies(request.policies);
    if (
      request.projectId !== undefined &&
      (typeof request.projectId !== "string" || !request.projectId)
    ) {
      throw new Error("Invalid project identity");
    }
    const usage = request.usage;
    if (
      usage &&
      (!usage.projectId ||
        (request.projectId !== undefined &&
          usage.projectId !== request.projectId) ||
        !generatedV1Routes.some(
          (route) => route.operationId === usage.operationId,
        ))
    ) {
      throw new Error("Invalid usage identity");
    }

    const now = Date.now();
    // Keep the deployed class, table and old RPC shape for rolling updates and
    // pending usage alarms. New gateways always supply a project identity.
    const counterId = request.projectId ?? request.keyId;
    const state = this.readState(counterId);
    const decision = decideAdmission({
      now,
      policies: request.policies,
      state,
    });

    if (!decision.result.allowed) {
      return decision.result;
    }

    if (usage && this.env.USAGE_TRACKING_ENABLED === "true") {
      this.ctx.storage.transactionSync(() => {
        this.writeState(counterId, decision.nextState, now);
        captureUsage(this.ctx.storage, {
          keyId: request.keyId,
          projectId: usage.projectId,
          operationId: usage.operationId,
          usageDate: new Date(now).toISOString().slice(0, 10),
          firstUsedAt: now,
        });
      });
      await scheduleUsage(this.ctx.storage, now);
    } else {
      this.writeState(counterId, decision.nextState, now);
    }
    return decision.result;
  }

  async alarm() {
    await flushUsage(
      this.ctx.storage,
      this.env.ENDPOINT_USAGE_QUEUE,
      async (attempts) => {
        await this.env.DB.prepare(
          `INSERT INTO tracking_health (id, value, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at`,
        )
          .bind(
            `outbox:${this.ctx.id.toString()}`,
            `delivery_failed:${attempts}`,
            Date.now(),
          )
          .run();
      },
    );
  }

  /** Operator recovery for retained, exhausted events; never a public RPC route. */
  async retryUsage() {
    this.ctx.storage.sql.exec(
      `UPDATE usage_outbox SET attempts = 0, next_attempt = 0 WHERE delivered = 0`,
    );
    await scheduleUsage(this.ctx.storage);
  }
}
