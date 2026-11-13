import { type Context, Hono, type Next } from "hono";
import { z } from "zod";
import {
  BillingError,
  cancelPendingBillingCheckout,
  changeSubscriptionPlan,
  createCustomerBillingPortalSession,
  getProjectBillingSummary,
  getPublicBillingPlans,
  initiateSubscriptionCheckout,
  requestSubscriptionWithdrawal,
} from "./billing.js";
import { readDashboardSession, requireDashboardUser } from "./epic-auth.js";
import { StripeApiError } from "./stripe.js";
import type { DashboardEnv, EpicSessionUser } from "./types.js";

type BillingAppContext = {
  Bindings: DashboardEnv;
  Variables: {
    user: EpicSessionUser;
  };
};

async function requireSessionOnly(
  c: Context<BillingAppContext>,
  next: Next,
) {
  const user = await readDashboardSession(c);
  if (!user) {
    return c.json(
      {
        error: {
          code: "UNAUTHORIZED",
          message: "Sign in with your Epic Games account.",
        },
      },
      401,
      { "Cache-Control": "no-store" },
    );
  }
  c.set("user", user);
  return next();
}

function handleBillingError(c: Context, err: unknown) {
  if (err instanceof BillingError) {
    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        },
      },
      err.status as 400 | 401 | 403 | 404 | 409 | 502 | 503,
      { "Cache-Control": "no-store" },
    );
  }
  if (err instanceof StripeApiError) {
    return c.json(
      {
        error: {
          code: err.stripeCode || "STRIPE_UNAVAILABLE",
          message: err.message,
        },
      },
      (err.status >= 400 && err.status < 500 ? err.status : 502) as 400 | 502,
      { "Cache-Control": "no-store" },
    );
  }
  throw err;
}

const checkoutSchema = z.object({
  projectId: z.string().trim().min(1).max(120),
  planId: z.enum(["pro", "scale"]),
  termsVersion: z.string().trim().min(1).max(64),
  withdrawalAcknowledged: z.boolean(),
  idempotencyKey: z.string().trim().min(1).max(128).optional(),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

const cancelCheckoutSchema = z.object({
  projectId: z.string().trim().min(1).max(120),
});

const portalSchema = z.object({
  returnUrl: z.string().url().optional(),
});

const changePlanSchema = z.object({
  projectId: z.string().trim().min(1).max(120),
  targetPlanId: z.enum(["free", "pro", "scale"]),
  idempotencyKey: z.string().trim().min(1).max(128).optional(),
});

const withdrawalSchema = z.object({
  projectId: z.string().trim().min(1).max(120),
  reason: z.string().trim().max(500).optional(),
  idempotencyKey: z.string().trim().min(1).max(128).optional(),
});

export const billingRoutes = new Hono<BillingAppContext>();

billingRoutes.get("/plans", (c) => {
  return c.json(getPublicBillingPlans(), 200, {
    "Cache-Control": "no-store",
  });
});

billingRoutes.post("/checkout", requireDashboardUser, async (c) => {
  const parsed = checkoutSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid checkout request parameters.",
        },
      },
      400,
    );
  }
  const user = c.get("user");
  try {
    const result = await initiateSubscriptionCheckout(c.env, {
      ownerEpicId: user.epicAccountId,
      ownerDisplayName: user.displayName,
      ...parsed.data,
      requestOrigin: new URL(c.req.url).origin,
    });
    return c.json(result, 200);
  } catch (err) {
    return handleBillingError(c, err);
  }
});

billingRoutes.post("/checkout/cancel", requireSessionOnly, async (c) => {
  const parsed = cancelCheckoutSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid projectId parameter.",
        },
      },
      400,
    );
  }
  const user = c.get("user");
  try {
    const result = await cancelPendingBillingCheckout(c.env, {
      ownerEpicId: user.epicAccountId,
      projectId: parsed.data.projectId,
    });
    return c.json(result, 200);
  } catch (err) {
    return handleBillingError(c, err);
  }
});

// Billing Portal, receipts, and withdrawal/refund controls remain reachable even if
// quota is exhausted, payment is past_due, or onboarding terms were revised.
billingRoutes.post("/portal", requireSessionOnly, async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const parsed = portalSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return c.json(
      { error: { code: "VALIDATION_ERROR", message: "Invalid returnUrl." } },
      400,
    );
  }
  const user = c.get("user");
  try {
    const portal = await createCustomerBillingPortalSession(c.env, {
      ownerEpicId: user.epicAccountId,
      ownerDisplayName: user.displayName,
      returnUrl: parsed.data.returnUrl,
      requestOrigin: new URL(c.req.url).origin,
    });
    return c.json(portal, 200);
  } catch (err) {
    return handleBillingError(c, err);
  }
});

billingRoutes.post(
  "/subscription/change",
  requireDashboardUser,
  async (c) => {
    const parsed = changePlanSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid subscription change parameters.",
          },
        },
        400,
      );
    }
    const user = c.get("user");
    try {
      const result = await changeSubscriptionPlan(c.env, {
        ownerEpicId: user.epicAccountId,
        ...parsed.data,
      });
      return c.json(result, 200);
    } catch (err) {
      return handleBillingError(c, err);
    }
  },
);

billingRoutes.post("/withdrawals", requireSessionOnly, async (c) => {
  const parsed = withdrawalSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid withdrawal or refund request parameters.",
        },
      },
      400,
    );
  }
  const user = c.get("user");
  try {
    const result = await requestSubscriptionWithdrawal(c.env, {
      ownerEpicId: user.epicAccountId,
      ...parsed.data,
    });
    return c.json(result, 200);
  } catch (err) {
    return handleBillingError(c, err);
  }
});

billingRoutes.get("/receipts", requireSessionOnly, async (c) => {
  const user = c.get("user");
  const receipts = await c.env.DB.prepare(
    `SELECT r.id, r.project_id, p.name AS project_name, r.subscription_id,
            r.stripe_checkout_session_id, r.plan_version_id, r.price_eur_cents,
            r.currency, r.vat_included, r.terms_version, r.withdrawal_acknowledged,
            r.withdrawal_expires_at, r.action_type, r.accepted_at, r.created_at
       FROM purchase_receipts r
       LEFT JOIN projects p ON p.id = r.project_id
      WHERE r.owner_epic_id = ?
      ORDER BY r.accepted_at DESC LIMIT 50`,
  )
    .bind(user.epicAccountId)
    .all();

  const withdrawals = await c.env.DB.prepare(
    `SELECT w.id, w.project_id, p.name AS project_name, w.subscription_id,
            w.request_kind, w.status, w.requested_amount_cents,
            w.refunded_amount_cents, w.stripe_refund_id, w.reason,
            w.resolution_note, w.created_at
       FROM withdrawal_requests w
       LEFT JOIN projects p ON p.id = w.project_id
      WHERE w.owner_epic_id = ?
      ORDER BY w.created_at DESC LIMIT 50`,
  )
    .bind(user.epicAccountId)
    .all();

  return c.json({
    receipts: receipts.results,
    withdrawals: withdrawals.results,
  });
});

export const projectBillingRoutes = new Hono<BillingAppContext>();

projectBillingRoutes.get("/:projectId/billing", requireSessionOnly, async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("projectId") ?? "";
  try {
    const summary = await getProjectBillingSummary(
      c.env,
      projectId,
      user.epicAccountId,
    );
    return c.json(summary, 200);
  } catch (err) {
    return handleBillingError(c, err);
  }
});

projectBillingRoutes.get(
  "/:projectId/entitlements",
  requireSessionOnly,
  async (c) => {
    const user = c.get("user");
    const projectId = c.req.param("projectId") ?? "";
    try {
      const summary = await getProjectBillingSummary(
        c.env,
        projectId,
        user.epicAccountId,
      );
      return c.json(
        {
          projectId: summary.project.id,
          entitlement: summary.entitlement,
          subscription: summary.subscription,
          grants: summary.grants,
        },
        200,
      );
    } catch (err) {
      return handleBillingError(c, err);
    }
  },
);

projectBillingRoutes.get("/:projectId/usage", requireSessionOnly, async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("projectId") ?? "";
  try {
    const summary = await getProjectBillingSummary(
      c.env,
      projectId,
      user.epicAccountId,
    );
    return c.json(
      {
        projectId: summary.project.id,
        tier: summary.entitlement.tier,
        planId: summary.entitlement.planId,
        grantSource: summary.entitlement.grantSource,
        periodType: summary.entitlement.periodType,
        usage: summary.usage,
        expensivePeriodBudgets: summary.entitlement.expensivePeriodBudgets,
      },
      200,
    );
  } catch (err) {
    return handleBillingError(c, err);
  }
});
