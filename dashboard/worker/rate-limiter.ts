import { DurableObject } from "cloudflare:workers";
import {
  type AdmissionResult,
  decideAdmission,
  FREE_MONTHLY_ALLOWANCE,
  type MonthlyQuotaState,
  type MonthlyQuotaSummary,
  type QuotaPolicy,
  type QuotaState,
  summarizeMonthlyQuota,
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
  ownerEpicId?: string;
  policies: QuotaPolicy[];
  usage?: { projectId: string; operationId: string };
};

type StateRow = {
  window_start: number;
  global_count: number;
  policies_json: string;
};

type MonthlyRow = {
  month_start: number;
  used_count: number;
};

/**
 * One SQLite-backed object per environment and account identifier.
 *
 * The raw API key never reaches this class. Minute state is a single bounded
 * row per project: the current 60-second window, global and endpoint counters.
 * Account-level free monthly allowance uses one bounded row per account,
 * coordinated atomically with project minute admission and optional usage outbox.
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
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS account_monthly_state (
        account_id TEXT PRIMARY KEY,
        month_start INTEGER NOT NULL,
        used_count INTEGER NOT NULL,
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

  private readMonthlyState(accountId: string): MonthlyQuotaState | null {
    const row = this.ctx.storage.sql
      .exec<MonthlyRow>(
        `SELECT month_start, used_count
           FROM account_monthly_state
          WHERE account_id = ?`,
        accountId,
      )
      .toArray()[0];

    if (!row) return null;
    return {
      monthStart: row.month_start,
      used: row.used_count,
    };
  }

  private writeMonthlyState(
    accountId: string,
    state: MonthlyQuotaState,
    now: number,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO account_monthly_state
         (account_id, month_start, used_count, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         month_start = excluded.month_start,
         used_count = excluded.used_count,
         updated_at = excluded.updated_at`,
      accountId,
      state.monthStart,
      state.used,
      now,
    );
  }

  private commitAdmission(
    counterId: string,
    nextState: QuotaState,
    accountId: string | undefined,
    nextMonthlyState: MonthlyQuotaState | null,
    now: number,
    usageEvent?: {
      keyId: string;
      projectId: string;
      operationId: string;
      usageDate: string;
      firstUsedAt: number;
    },
  ): void {
    const applyWrites = () => {
      this.writeState(counterId, nextState, now);
      if (accountId && nextMonthlyState) {
        this.writeMonthlyState(accountId, nextMonthlyState, now);
      }
      if (usageEvent) {
        captureUsage(this.ctx.storage, usageEvent);
      }
    };
    if (
      typeof this.ctx.storage.transactionSync === "function" &&
      ((accountId && nextMonthlyState) || usageEvent)
    ) {
      this.ctx.storage.transactionSync(applyWrites);
    } else {
      applyWrites();
    }
  }

  /**
   * Single RPC conjoining the account monthly, project global, and endpoint
   * policies. State rows are persisted atomically before admission is
   * acknowledged; denials perform reads only.
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
    if (
      request.ownerEpicId !== undefined &&
      (typeof request.ownerEpicId !== "string" || !request.ownerEpicId)
    ) {
      throw new Error("Invalid account identity");
    }
    const hasMonthlyPolicy = request.policies.some(
      (policy) => (policy.window ?? "minute") === "month",
    );
    if (hasMonthlyPolicy && !request.ownerEpicId) {
      throw new Error("Account identity required for monthly quota policy");
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
    // pending usage alarms. New gateways supply both account and project identities.
    const counterId = request.projectId ?? request.keyId;
    const state = this.readState(counterId);
    const monthlyState =
      hasMonthlyPolicy && request.ownerEpicId
        ? this.readMonthlyState(request.ownerEpicId)
        : null;
    const decision = decideAdmission({
      now,
      policies: request.policies,
      state,
      monthlyState,
    });

    if (!decision.result.allowed) {
      return decision.result;
    }

    const trackUsage = usage && this.env.USAGE_TRACKING_ENABLED === "true";
    this.commitAdmission(
      counterId,
      decision.nextState,
      request.ownerEpicId,
      decision.nextMonthlyState,
      now,
      trackUsage
        ? {
            keyId: request.keyId,
            projectId: usage.projectId,
            operationId: usage.operationId,
            usageDate: new Date(now).toISOString().slice(0, 10),
            firstUsedAt: now,
          }
        : undefined,
    );
    if (trackUsage) {
      await scheduleUsage(this.ctx.storage, now);
    }
    return decision.result;
  }

  /** Read-only current monthly quota state for dashboard reporting. */
  async readMonthlyQuota(
    ownerEpicId: string,
    allowance = FREE_MONTHLY_ALLOWANCE,
  ): Promise<MonthlyQuotaSummary> {
    if (typeof ownerEpicId !== "string" || !ownerEpicId) {
      throw new Error("Invalid account identity");
    }
    if (
      !Number.isInteger(allowance) ||
      allowance < 1 ||
      allowance > 1_000_000_000
    ) {
      throw new Error("Invalid monthly allowance");
    }
    const now = Date.now();
    const state = this.readMonthlyState(ownerEpicId);
    return summarizeMonthlyQuota(now, state, allowance);
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
