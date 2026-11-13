import { DurableObject } from "cloudflare:workers";
import {
  type EffectiveProjectEntitlement,
  PLAN_VERSIONS,
} from "./plans.js";
import {
  type AdmissionResult,
  applyUsageCredit,
  DAILY_POLICY_NAME,
  type DailyQuotaState,
  type DailyQuotaSummary,
  decideAdmission,
  FREE_MONTHLY_ALLOWANCE,
  MONTHLY_POLICY_NAME,
  type MonthlyQuotaState,
  type MonthlyQuotaSummary,
  PERIOD_POLICY_NAME,
  type PeriodQuotaState,
  type PeriodQuotaSummary,
  type QuotaPolicy,
  type QuotaState,
  summarizeDailyQuota,
  summarizeMonthlyQuota,
  summarizePeriodQuota,
  utcDayBounds,
  utcMonthBounds,
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
  bonus_count: number;
};

type DailyRow = {
  day_start: number;
  used_count: number;
};

type PeriodRow = {
  period_start: number;
  period_end: number;
  used_count: number;
  policies_json: string;
  bonus_count: number;
};

type EntitlementRow = {
  project_id: string;
  revision: number;
  plan_id: string;
  plan_version_id: string;
  tier: string;
  grant_source: string;
  status: string;
  rpm_limit: number;
  period_allowance: number | null;
  period_type: string;
  period_start: number | null;
  period_end: number | null;
  initial_daily_limit: number | null;
  initial_daily_limit_until: number | null;
  expensive_minute_json: string;
  expensive_period_json: string | null;
  entitlements_json: string;
  grace_until: number | null;
  cancel_at_period_end: number;
  subscription_id: string | null;
  updated_at: number;
};

function parsePositiveIntMap(raw: string | null): Record<string, number> {
  if (!raw) return {};
  const result: Record<string, number> = {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [name, value] of Object.entries(parsed)) {
        if (Number.isInteger(value) && (value as number) >= 0) {
          result[name] = value as number;
        }
      }
    }
  } catch {
    return {};
  }
  return result;
}

/**
 * One SQLite-backed object per environment and account identifier.
 *
 * The raw API key never reaches this class. Minute state is a single bounded
 * row per project: the current 60-second window, global and endpoint counters.
 * Account-level free monthly allowance uses one bounded row per account, and
 * project billing periods + authoritative entitlements use bounded per-project rows.
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
      CREATE TABLE IF NOT EXISTS project_daily_state (
        project_id TEXT PRIMARY KEY,
        day_start INTEGER NOT NULL,
        used_count INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS account_monthly_state (
        account_id TEXT PRIMARY KEY,
        month_start INTEGER NOT NULL,
        used_count INTEGER NOT NULL,
        bonus_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )
    `);
    const monthlyCols = ctx.storage.sql
      .exec<{ name: string }>(`PRAGMA table_info(account_monthly_state)`)
      .toArray();
    if (!monthlyCols.some((c) => c.name === "bonus_count")) {
      ctx.storage.sql.exec(
        `ALTER TABLE account_monthly_state ADD COLUMN bonus_count INTEGER NOT NULL DEFAULT 0`,
      );
    }
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS project_period_state (
        project_id TEXT PRIMARY KEY,
        period_start INTEGER NOT NULL,
        period_end INTEGER NOT NULL,
        used_count INTEGER NOT NULL,
        policies_json TEXT NOT NULL,
        bonus_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )
    `);
    const periodCols = ctx.storage.sql
      .exec<{ name: string }>(`PRAGMA table_info(project_period_state)`)
      .toArray();
    if (!periodCols.some((c) => c.name === "bonus_count")) {
      ctx.storage.sql.exec(
        `ALTER TABLE project_period_state ADD COLUMN bonus_count INTEGER NOT NULL DEFAULT 0`,
      );
    }
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS project_entitlements (
        project_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        plan_id TEXT NOT NULL,
        plan_version_id TEXT NOT NULL,
        tier TEXT NOT NULL,
        grant_source TEXT NOT NULL,
        status TEXT NOT NULL,
        rpm_limit INTEGER NOT NULL,
        period_allowance INTEGER,
        period_type TEXT NOT NULL,
        period_start INTEGER,
        period_end INTEGER,
        expensive_minute_json TEXT NOT NULL,
        expensive_period_json TEXT,
        entitlements_json TEXT NOT NULL,
        grace_until INTEGER,
        cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
        subscription_id TEXT,
        updated_at INTEGER NOT NULL
      )
    `);
    const entitlementCols = ctx.storage.sql
      .exec<{ name: string }>(`PRAGMA table_info(project_entitlements)`)
      .toArray();
    if (!entitlementCols.some((c) => c.name === "initial_daily_limit")) {
      ctx.storage.sql.exec(
        `ALTER TABLE project_entitlements ADD COLUMN initial_daily_limit INTEGER`,
      );
    }
    if (!entitlementCols.some((c) => c.name === "initial_daily_limit_until")) {
      ctx.storage.sql.exec(
        `ALTER TABLE project_entitlements ADD COLUMN initial_daily_limit_until INTEGER`,
      );
    }
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_adjustments (
        adjustment_id TEXT PRIMARY KEY,
        project_id TEXT,
        owner_epic_id TEXT NOT NULL,
        target_scope TEXT NOT NULL,
        target_window_start INTEGER NOT NULL,
        credit_amount INTEGER NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL
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

  private readDailyState(projectId: string): DailyQuotaState | null {
    const row = this.ctx.storage.sql
      .exec<DailyRow>(
        `SELECT day_start, used_count
           FROM project_daily_state
          WHERE project_id = ?`,
        projectId,
      )
      .toArray()[0];

    if (!row) return null;
    return {
      dayStart: row.day_start,
      used: row.used_count,
    };
  }

  private writeDailyState(
    projectId: string,
    state: DailyQuotaState,
    now: number,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO project_daily_state
         (project_id, day_start, used_count, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         day_start = excluded.day_start,
         used_count = excluded.used_count,
         updated_at = excluded.updated_at`,
      projectId,
      state.dayStart,
      state.used,
      now,
    );
  }

  private readMonthlyState(accountId: string): MonthlyQuotaState | null {
    const row = this.ctx.storage.sql
      .exec<MonthlyRow>(
        `SELECT month_start, used_count, bonus_count
           FROM account_monthly_state
          WHERE account_id = ?`,
        accountId,
      )
      .toArray()[0];

    if (!row) return null;
    return {
      monthStart: row.month_start,
      used: row.used_count,
      bonus: Math.max(0, row.bonus_count ?? 0),
    };
  }

  private writeMonthlyState(
    accountId: string,
    state: MonthlyQuotaState,
    now: number,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO account_monthly_state
         (account_id, month_start, used_count, bonus_count, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         month_start = excluded.month_start,
         used_count = excluded.used_count,
         bonus_count = excluded.bonus_count,
         updated_at = excluded.updated_at`,
      accountId,
      state.monthStart,
      state.used,
      Math.max(0, state.bonus ?? 0),
      now,
    );
  }

  private readPeriodState(projectId: string): PeriodQuotaState | null {
    const row = this.ctx.storage.sql
      .exec<PeriodRow>(
        `SELECT period_start, period_end, used_count, policies_json, bonus_count
           FROM project_period_state
          WHERE project_id = ?`,
        projectId,
      )
      .toArray()[0];

    if (!row) return null;
    return {
      periodStart: row.period_start,
      periodEnd: row.period_end,
      used: row.used_count,
      policyCounts: parsePositiveIntMap(row.policies_json),
      bonus: Math.max(0, row.bonus_count ?? 0),
    };
  }

  private writePeriodState(
    projectId: string,
    state: PeriodQuotaState,
    now: number,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO project_period_state
         (project_id, period_start, period_end, used_count, policies_json, bonus_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         period_start = excluded.period_start,
         period_end = excluded.period_end,
         used_count = excluded.used_count,
         policies_json = excluded.policies_json,
         bonus_count = excluded.bonus_count,
         updated_at = excluded.updated_at`,
      projectId,
      state.periodStart,
      state.periodEnd,
      state.used,
      JSON.stringify(state.policyCounts),
      Math.max(0, state.bonus ?? 0),
      now,
    );
  }

  private readStoredEntitlement(
    projectId: string,
    ownerEpicId = "",
  ): EffectiveProjectEntitlement | null {
    const row = this.ctx.storage.sql
      .exec<EntitlementRow>(
        `SELECT project_id, revision, plan_id, plan_version_id, tier, grant_source,
                status, rpm_limit, period_allowance, period_type, period_start, period_end,
                initial_daily_limit, initial_daily_limit_until,
                expensive_minute_json, expensive_period_json, entitlements_json,
                grace_until, cancel_at_period_end, subscription_id, updated_at
           FROM project_entitlements
          WHERE project_id = ?`,
        projectId,
      )
      .toArray()[0];

    if (!row) return null;

    let expensiveMinuteLimits = { ...PLAN_VERSIONS["free-v1"].expensiveMinuteLimits };
    try {
      const parsed = JSON.parse(row.expensive_minute_json) as Record<string, number>;
      if (parsed && typeof parsed === "object") {
        expensiveMinuteLimits = {
          "offers-list": Number(parsed["offers-list"]) || expensiveMinuteLimits["offers-list"],
          search: Number(parsed.search) || expensiveMinuteLimits.search,
          heavy: Number(parsed.heavy) || expensiveMinuteLimits.heavy,
          bulk: Number(parsed.bulk) || expensiveMinuteLimits.bulk,
        };
      }
    } catch {
      // keep default
    }

    let expensivePeriodBudgets: EffectiveProjectEntitlement["expensivePeriodBudgets"] = null;
    if (row.expensive_period_json) {
      try {
        const parsed = JSON.parse(row.expensive_period_json) as Record<string, number>;
        if (parsed && typeof parsed === "object") {
          expensivePeriodBudgets = {
            "nl-search": Number(parsed["nl-search"]) || 0,
            bulk: Number(parsed.bulk) || 0,
            image: Number(parsed.image) || 0,
          };
        }
      } catch {
        expensivePeriodBudgets = null;
      }
    }

    let entitlements: string[] = [...PLAN_VERSIONS["free-v1"].entitlements];
    try {
      const parsed = JSON.parse(row.entitlements_json) as unknown;
      if (Array.isArray(parsed)) {
        entitlements = parsed.filter((v): v is string => typeof v === "string");
      }
    } catch {
      // keep default
    }

    return {
      projectId: row.project_id,
      ownerEpicId,
      planId: row.plan_id as EffectiveProjectEntitlement["planId"],
      planVersionId: row.plan_version_id as EffectiveProjectEntitlement["planVersionId"],
      tier: row.tier as EffectiveProjectEntitlement["tier"],
      grantSource: row.grant_source as EffectiveProjectEntitlement["grantSource"],
      revision: row.revision,
      rpmLimit: row.rpm_limit,
      periodAllowance: row.period_allowance,
      periodType: row.period_type as EffectiveProjectEntitlement["periodType"],
      periodStart: row.period_start,
      periodEnd: row.period_end,
      initialDailyLimit: row.initial_daily_limit,
      initialDailyLimitUntil: row.initial_daily_limit_until,
      expensiveMinuteLimits,
      expensivePeriodBudgets,
      entitlements,
      status: row.status as EffectiveProjectEntitlement["status"],
      graceUntil: row.grace_until,
      cancelAtPeriodEnd: row.cancel_at_period_end === 1,
      subscriptionId: row.subscription_id,
      reason: null,
    };
  }

  private resolveEffectivePoliciesForStoredEntitlement(
    requestPolicies: QuotaPolicy[],
    stored: EffectiveProjectEntitlement | null,
    now: number,
  ): QuotaPolicy[] {
    if (!stored) return requestPolicies;

    const graceExpired =
      stored.status === "grace" &&
      stored.graceUntil !== null &&
      now >= stored.graceUntil;
    const paidSuspended =
      stored.status === "expired" || stored.status === "revoked" || graceExpired;

    const freeSpec = PLAN_VERSIONS["free-v1"];
    const effectiveRpm = paidSuspended ? freeSpec.rpmLimit : stored.rpmLimit;

    const hasActiveDailyCap =
      !paidSuspended &&
      typeof stored.initialDailyLimit === "number" &&
      stored.initialDailyLimit > 0 &&
      typeof stored.initialDailyLimitUntil === "number" &&
      now < stored.initialDailyLimitUntil;

    const next: QuotaPolicy[] = [];
    for (const policy of requestPolicies) {
      const win = policy.window ?? "minute";
      if (win === "day") {
        if (!hasActiveDailyCap) {
          continue;
        }
        next.push({
          ...policy,
          limit: Math.min(policy.limit, stored.initialDailyLimit!),
        });
        continue;
      }
      if (policy.name === "global") {
        next.push({ ...policy, limit: Math.min(policy.limit, effectiveRpm) });
        continue;
      }
      if (win === "minute") {
        const table = paidSuspended
          ? freeSpec.expensiveMinuteLimits
          : stored.expensiveMinuteLimits;
        const cap = table[policy.name as keyof typeof table];
        next.push(
          cap ? { ...policy, limit: Math.min(policy.limit, cap) } : policy,
        );
        continue;
      }
      if (win === "period" && policy.name === PERIOD_POLICY_NAME) {
        if (paidSuspended) {
          // Paid grace/subscription expired in DO before cache caught up: enforce free monthly cap instead.
          next.push({
            name: MONTHLY_POLICY_NAME,
            limit: FREE_MONTHLY_ALLOWANCE,
            window: "month",
          });
        } else {
          next.push({
            ...policy,
            limit: stored.periodAllowance ?? policy.limit,
            periodStart: stored.periodStart ?? policy.periodStart,
            periodEnd: stored.periodEnd ?? policy.periodEnd,
          });
        }
        continue;
      }
      next.push(policy);
    }

    if (
      hasActiveDailyCap &&
      !next.some((policy) => (policy.window ?? "minute") === "day")
    ) {
      next.push({
        name: DAILY_POLICY_NAME,
        limit: stored.initialDailyLimit!,
        window: "day",
      });
    }

    if (
      paidSuspended &&
      !next.some((policy) => (policy.window ?? "minute") === "month")
    ) {
      next.push({
        name: MONTHLY_POLICY_NAME,
        limit: FREE_MONTHLY_ALLOWANCE,
        window: "month",
      });
    }

    return next;
  }

  private commitAdmission(
    counterId: string,
    nextState: QuotaState,
    accountId: string | undefined,
    nextDailyState: DailyQuotaState | null,
    nextMonthlyState: MonthlyQuotaState | null,
    nextPeriodState: PeriodQuotaState | null,
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
      if (nextDailyState) {
        this.writeDailyState(counterId, nextDailyState, now);
      }
      if (accountId && nextMonthlyState) {
        this.writeMonthlyState(accountId, nextMonthlyState, now);
      }
      if (nextPeriodState) {
        this.writePeriodState(counterId, nextPeriodState, now);
      }
      if (usageEvent) {
        captureUsage(this.ctx.storage, usageEvent);
      }
    };
    if (
      typeof this.ctx.storage.transactionSync === "function" &&
      (nextDailyState || (accountId && nextMonthlyState) || nextPeriodState || usageEvent)
    ) {
      this.ctx.storage.transactionSync(applyWrites);
    } else {
      applyWrites();
    }
  }

  /** Synchronizes server-owned entitlement limits directly into the DO. */
  async syncProjectEntitlement(
    entitlement: EffectiveProjectEntitlement,
  ): Promise<void> {
    if (!entitlement || !entitlement.projectId) {
      throw new Error("Invalid project entitlement");
    }
    const existing = this.readStoredEntitlement(
      entitlement.projectId,
      entitlement.ownerEpicId,
    );
    if (existing && existing.revision > entitlement.revision) {
      return;
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO project_entitlements (
         project_id, revision, plan_id, plan_version_id, tier, grant_source,
         status, rpm_limit, period_allowance, period_type, period_start, period_end,
         initial_daily_limit, initial_daily_limit_until,
         expensive_minute_json, expensive_period_json, entitlements_json,
         grace_until, cancel_at_period_end, subscription_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         revision = excluded.revision,
         plan_id = excluded.plan_id,
         plan_version_id = excluded.plan_version_id,
         tier = excluded.tier,
         grant_source = excluded.grant_source,
         status = excluded.status,
         rpm_limit = excluded.rpm_limit,
         period_allowance = excluded.period_allowance,
         period_type = excluded.period_type,
         period_start = excluded.period_start,
         period_end = excluded.period_end,
         initial_daily_limit = excluded.initial_daily_limit,
         initial_daily_limit_until = excluded.initial_daily_limit_until,
         expensive_minute_json = excluded.expensive_minute_json,
         expensive_period_json = excluded.expensive_period_json,
         entitlements_json = excluded.entitlements_json,
         grace_until = excluded.grace_until,
         cancel_at_period_end = excluded.cancel_at_period_end,
         subscription_id = excluded.subscription_id,
         updated_at = excluded.updated_at`,
      entitlement.projectId,
      entitlement.revision,
      entitlement.planId,
      entitlement.planVersionId,
      entitlement.tier,
      entitlement.grantSource,
      entitlement.status,
      entitlement.rpmLimit,
      entitlement.periodAllowance,
      entitlement.periodType,
      entitlement.periodStart,
      entitlement.periodEnd,
      entitlement.initialDailyLimit ?? null,
      entitlement.initialDailyLimitUntil ?? null,
      JSON.stringify(entitlement.expensiveMinuteLimits),
      entitlement.expensivePeriodBudgets
        ? JSON.stringify(entitlement.expensivePeriodBudgets)
        : null,
      JSON.stringify(entitlement.entitlements),
      entitlement.graceUntil,
      entitlement.cancelAtPeriodEnd ? 1 : 0,
      entitlement.subscriptionId,
      Date.now(),
    );
  }

  async readProjectEntitlement(
    projectId: string,
    ownerEpicId = "",
  ): Promise<EffectiveProjectEntitlement | null> {
    return this.readStoredEntitlement(projectId, ownerEpicId);
  }

  /**
   * Single RPC conjoining the account monthly, project billing period,
   * project global, and endpoint policies. State rows are persisted atomically
   * before admission is acknowledged; denials perform reads only.
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

    const now = Date.now();
    const counterId = request.projectId ?? request.keyId;
    const storedEntitlement = request.projectId
      ? this.readStoredEntitlement(request.projectId, request.ownerEpicId ?? "")
      : null;
    const effectivePolicies = this.resolveEffectivePoliciesForStoredEntitlement(
      request.policies,
      storedEntitlement,
      now,
    );
    validatePolicies(effectivePolicies);

    const hasDailyPolicy = effectivePolicies.some(
      (policy) => (policy.window ?? "minute") === "day",
    );
    const hasMonthlyPolicy = effectivePolicies.some(
      (policy) => (policy.window ?? "minute") === "month",
    );
    if (hasMonthlyPolicy && !request.ownerEpicId) {
      throw new Error("Account identity required for monthly quota policy");
    }
    const hasPeriodPolicy = effectivePolicies.some(
      (policy) => (policy.window ?? "minute") === "period",
    );

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

    const state = this.readState(counterId);
    const dailyState = hasDailyPolicy ? this.readDailyState(counterId) : null;
    const monthlyState =
      hasMonthlyPolicy && request.ownerEpicId
        ? this.readMonthlyState(request.ownerEpicId)
        : null;
    const periodState = hasPeriodPolicy ? this.readPeriodState(counterId) : null;

    const decision = decideAdmission({
      now,
      policies: effectivePolicies,
      state,
      dailyState,
      monthlyState,
      periodState,
    });

    if (!decision.result.allowed) {
      return decision.result;
    }

    const trackUsage = usage && this.env.USAGE_TRACKING_ENABLED === "true";
    this.commitAdmission(
      counterId,
      decision.nextState,
      request.ownerEpicId,
      decision.nextDailyState,
      decision.nextMonthlyState,
      decision.nextPeriodState,
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

  async readProjectDailyQuota(
    projectId: string,
    allowance: number,
  ): Promise<DailyQuotaSummary> {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project identity");
    }
    const state = this.readDailyState(projectId);
    return summarizeDailyQuota(Date.now(), state, allowance);
  }

  /** Read-only project billing period quota & expensive budget usage for dashboard reporting. */
  async readProjectQuota(
    projectId: string,
    allowance: number,
    periodStart: number,
    periodEnd: number,
  ): Promise<PeriodQuotaSummary & { policyCounts: Record<string, number> }> {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project identity");
    }
    const state = this.readPeriodState(projectId);
    const summary = summarizePeriodQuota(
      state,
      allowance,
      periodStart,
      periodEnd,
    );
    const samePeriod =
      state !== null &&
      state.periodStart === periodStart &&
      state.periodEnd === periodEnd;
    return {
      ...summary,
      policyCounts: samePeriod ? { ...state.policyCounts } : {},
    };
  }

  /**
   * Idempotent usage credit for service-side failures ("refund") or operator
   * quota grants ("bonus"). Replaying the same adjustmentId does not
   * double-credit; refund mode never drops counters below zero, while bonus mode
   * adds extra capacity on top of the active month/period allowance even when used is 0.
   */
  async creditUsage(params: {
    adjustmentId: string;
    ownerEpicId: string;
    projectId?: string;
    scope: "period" | "month";
    windowStart?: number;
    periodEnd?: number;
    amount?: number;
    reason: string;
    mode?: "refund" | "bonus";
  }): Promise<{ applied: boolean; remainingUsed: number; bonus?: number }> {
    const amount = Number.isInteger(params.amount) ? (params.amount ?? 1) : 1;
    if (!params.adjustmentId || !params.ownerEpicId || amount < 1) {
      throw new Error("Invalid usage adjustment parameters");
    }

    const mode = params.mode === "bonus" ? "bonus" : "refund";
    const now = Date.now();
    const monthBounds = utcMonthBounds(now);
    const windowStart =
      params.windowStart ??
      (params.scope === "month" ? monthBounds.monthStart : 0);

    let applied = false;
    let remainingUsed = 0;
    let appliedBonus: number | undefined;

    const apply = () => {
      const existing = this.ctx.storage.sql
        .exec<{ adjustment_id: string }>(
          `SELECT adjustment_id FROM usage_adjustments WHERE adjustment_id = ?`,
          params.adjustmentId,
        )
        .toArray()[0];

      if (params.scope === "month") {
        const monthly = this.readMonthlyState(params.ownerEpicId);
        const sameMonth = monthly !== null && monthly.monthStart === windowStart;
        const currentUsed = sameMonth ? monthly.used : 0;
        const currentBonus = sameMonth ? (monthly.bonus ?? 0) : 0;
        if (existing) {
          remainingUsed = currentUsed;
          if (currentBonus > 0) appliedBonus = currentBonus;
          return;
        }
        if (mode === "bonus") {
          remainingUsed = currentUsed;
          const nextBonus = currentBonus + amount;
          appliedBonus = nextBonus;
          this.writeMonthlyState(
            params.ownerEpicId,
            { monthStart: windowStart, used: currentUsed, bonus: nextBonus },
            now,
          );
        } else {
          remainingUsed = sameMonth ? applyUsageCredit(currentUsed, amount) : 0;
          if (currentBonus > 0) appliedBonus = currentBonus;
          if (sameMonth) {
            this.writeMonthlyState(
              params.ownerEpicId,
              {
                monthStart: monthly.monthStart,
                used: remainingUsed,
                bonus: currentBonus,
              },
              now,
            );
          }
        }
      } else {
        if (!params.projectId) {
          throw new Error("projectId is required for period usage credit");
        }
        const period = this.readPeriodState(params.projectId);
        if (mode === "bonus") {
          const stored = this.readStoredEntitlement(
            params.projectId,
            params.ownerEpicId,
          );
          const targetStart =
            windowStart > 0
              ? windowStart
              : (period?.periodStart ?? stored?.periodStart ?? 0);
          const targetEnd =
            params.periodEnd ??
            (period && period.periodStart === targetStart
              ? period.periodEnd
              : undefined) ??
            (stored && stored.periodStart === targetStart
              ? (stored.periodEnd ?? undefined)
              : undefined) ??
            0;
          const hasPeriodWindow = targetStart > 0 && targetEnd > targetStart;
          const samePeriod =
            hasPeriodWindow &&
            period !== null &&
            period.periodStart === targetStart &&
            period.periodEnd === targetEnd;
          const currentUsed = samePeriod ? period.used : 0;
          const currentBonus = samePeriod ? (period.bonus ?? 0) : 0;
          if (existing) {
            remainingUsed = currentUsed;
            if (currentBonus > 0) appliedBonus = currentBonus;
            return;
          }
          if (hasPeriodWindow) {
            remainingUsed = currentUsed;
            const nextBonus = currentBonus + amount;
            appliedBonus = nextBonus;
            this.writePeriodState(
              params.projectId,
              {
                periodStart: targetStart,
                periodEnd: targetEnd,
                used: currentUsed,
                policyCounts: samePeriod ? { ...period.policyCounts } : {},
                bonus: nextBonus,
              },
              now,
            );
          }
        } else {
          const samePeriod =
            period !== null &&
            (windowStart === 0 || period.periodStart === windowStart);
          const currentUsed = samePeriod ? period.used : 0;
          const currentBonus = samePeriod ? (period.bonus ?? 0) : 0;
          if (existing) {
            remainingUsed = currentUsed;
            if (currentBonus > 0) appliedBonus = currentBonus;
            return;
          }
          remainingUsed = samePeriod ? applyUsageCredit(currentUsed, amount) : 0;
          if (currentBonus > 0) appliedBonus = currentBonus;
          if (samePeriod) {
            this.writePeriodState(
              params.projectId,
              {
                periodStart: period.periodStart,
                periodEnd: period.periodEnd,
                used: remainingUsed,
                policyCounts: period.policyCounts,
                bonus: currentBonus,
              },
              now,
            );
          }
          const daily = this.readDailyState(params.projectId);
          const dayBounds = utcDayBounds(now);
          if (daily && daily.dayStart === dayBounds.dayStart) {
            this.writeDailyState(
              params.projectId,
              {
                dayStart: daily.dayStart,
                used: applyUsageCredit(daily.used, amount),
              },
              now,
            );
          }
        }
      }

      this.ctx.storage.sql.exec(
        `INSERT INTO usage_adjustments (
           adjustment_id, project_id, owner_epic_id, target_scope,
           target_window_start, credit_amount, reason, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        params.adjustmentId,
        params.projectId ?? null,
        params.ownerEpicId,
        params.scope,
        windowStart,
        amount,
        params.reason,
        now,
      );
      applied = true;
    };

    if (typeof this.ctx.storage.transactionSync === "function") {
      this.ctx.storage.transactionSync(apply);
    } else {
      apply();
    }

    return {
      applied,
      remainingUsed,
      ...(appliedBonus !== undefined ? { bonus: appliedBonus } : {}),
    };
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
