import type { DashboardEnv } from "./types.js";

export const FEATURE_FLAG_KEYS = {
  paidPlans: "enable-paid-plans",
  commercialPlanLimits: "enable-commercial-plan-limits",
} as const;

export interface FeatureFlagsState {
  paidPlans: boolean;
  commercialLimits: boolean;
}

export interface FlagEvaluationSubject {
  userId?: string | null;
  environment?: string | null;
  isAdmin?: boolean;
}

function parseBooleanEnv(value?: string): boolean | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

function buildFlagshipContext(
  subject?: FlagEvaluationSubject,
): FlagshipEvaluationContext | undefined {
  if (!subject) return undefined;
  const context: Record<string, FlagshipEvaluationContextValue> = {};
  if (subject.userId) {
    context.targetingKey = subject.userId;
    context.userId = subject.userId;
  }
  if (subject.environment) {
    context.environment = subject.environment;
  }
  if (typeof subject.isAdmin === "boolean") {
    context.isAdmin = subject.isAdmin;
  }
  return Object.keys(context).length > 0 ? context : undefined;
}

async function evaluateBooleanFlag(
  env: Partial<DashboardEnv> | undefined,
  flagKey: string,
  envVarValue: string | undefined,
  subject?: FlagEvaluationSubject,
): Promise<boolean> {
  const fallback = parseBooleanEnv(envVarValue) ?? false;
  if (!env?.FLAGS || typeof env.FLAGS.getBooleanValue !== "function") {
    return fallback;
  }
  try {
    return await env.FLAGS.getBooleanValue(
      flagKey,
      fallback,
      buildFlagshipContext(subject),
    );
  } catch {
    return fallback;
  }
}

export async function isPaidPlansEnabled(
  env?: Partial<DashboardEnv>,
  subject?: FlagEvaluationSubject,
): Promise<boolean> {
  return evaluateBooleanFlag(
    env,
    FEATURE_FLAG_KEYS.paidPlans,
    env?.PAID_PLANS_ENABLED,
    subject,
  );
}

export async function resolveCommercialLimitsEnabled(
  env?: Partial<DashboardEnv>,
  subject?: FlagEvaluationSubject,
): Promise<boolean> {
  return evaluateBooleanFlag(
    env,
    FEATURE_FLAG_KEYS.commercialPlanLimits,
    env?.COMMERCIAL_PLAN_LIMITS_ENABLED,
    subject,
  );
}

export async function resolveFeatureFlags(
  env?: Partial<DashboardEnv>,
  subject?: FlagEvaluationSubject,
): Promise<FeatureFlagsState> {
  const [paidPlans, commercialLimits] = await Promise.all([
    isPaidPlansEnabled(env, subject),
    resolveCommercialLimitsEnabled(env, subject),
  ]);
  return { paidPlans, commercialLimits };
}
