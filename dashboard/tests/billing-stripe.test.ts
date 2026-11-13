import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getProjectBillingSummary,
  reconcileBillingState,
} from "../worker/billing";
import { sha256Hex, signHmacToken } from "../worker/crypto";
import worker from "../worker/index";
import { BILLING_POLICY_DEFAULTS, PLAN_VERSIONS } from "../worker/plans";
import {
  readProjectBillingQuota,
  resolveEffectiveProjectEntitlement,
} from "../worker/project-quota";
import { signStripeWebhookPayload } from "../worker/stripe";
import type { DashboardEnv } from "../worker/types";
import { quotaNamespace } from "./fixtures/quota";
import { sqliteD1 } from "./fixtures/sqlite";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const DASHBOARD_ORIGIN = "https://devs.egdata.app";
const DASHBOARD_SECRET = "billing-stripe-test-session-secret-32c";
const WEBHOOK_SECRET = "whsec_test_stripe_webhook_secret_12345";
const PRO_PRICE = "price_pro_eur_900";
const SCALE_PRICE = "price_scale_eur_1900";

interface StripeCallRecord {
  method: string;
  path: string;
  body: string;
  idempotencyKey: string | null;
}

async function createBillingHarness(options?: {
  termsRevisedAfterAccept?: boolean;
}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-12T12:00:00Z"));

  const { db, sqlite } = sqliteD1();
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync("migrations")
    .filter((file) => file.endsWith(".sql"))
    .sort()) {
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  }

  sqlite.exec(`
    INSERT INTO users(epic_account_id, display_name, email, project_limit)
    VALUES
      ('owner_1', 'Owner One', 'owner1@example.com', 5),
      ('admin_1', 'Operator Admin', 'admin@egdata.app', 5);
    INSERT INTO user_roles(user_id, role)
    VALUES ('admin_1', 'admin');
    INSERT INTO projects(id, owner_epic_id, name, slug, tier)
    VALUES ('prj_1', 'owner_1', 'Primary App', 'primary-app', 'free');
    INSERT INTO developer_profiles(owner_id, contact_email, verified_at)
    VALUES
      ('owner_1', 'owner1@example.com', 1000),
      ('admin_1', 'admin@egdata.app', 1000);
  `);

  const termsHash = await sha256Hex("Commercial Terms v1");
  const privacyHash = await sha256Hex("Privacy v1");
  const nowSec = Math.floor(Date.now() / 1000);
  sqlite
    .prepare(
      `INSERT INTO legal_documents(kind, version, edition, sha256, body, published_at)
       VALUES ('terms', '1.0', 'edition-1', ?, 'Commercial Terms v1', ?)`,
    )
    .run(termsHash, nowSec);
  sqlite
    .prepare(
      `INSERT INTO legal_documents(kind, version, edition, sha256, body, published_at)
       VALUES ('privacy', '1.0', '', ?, 'Privacy v1', ?)`,
    )
    .run(privacyHash, nowSec);
  sqlite.exec(
    `INSERT INTO legal_rollout(id, revision, terms_version, privacy_version)
     VALUES (1, 'rev-1', '1.0', '1.0')`,
  );
  sqlite
    .prepare(
      `INSERT INTO legal_acceptances(owner_id, version, edition, sha256, accepted_at, requirement_revision, receipt_id, privacy_version, privacy_sha256)
       VALUES ('owner_1', '1.0', 'edition-1', ?, ?, ?, 'rcpt_owner_1', '1.0', ?)`,
    )
    .run(
      termsHash,
      Date.now(),
      options?.termsRevisedAfterAccept ? "rev-0" : "rev-1",
      privacyHash,
    );
  sqlite
    .prepare(
      `INSERT INTO legal_acceptances(owner_id, version, edition, sha256, accepted_at, requirement_revision, receipt_id, privacy_version, privacy_sha256)
       VALUES ('admin_1', '1.0', 'edition-1', ?, ?, 'rev-1', 'rcpt_admin_1', '1.0', ?)`,
    )
    .run(termsHash, Date.now(), privacyHash);

  const namespace = quotaNamespace();
  const kvStore = new Map<string, unknown>();

  // In-memory simulated Stripe objects & API call log
  const stripeCalls: StripeCallRecord[] = [];
  let liveStripeSub: Record<string, unknown> = {
    id: "sub_stripe_001",
    customer: "cus_stripe_001",
    status: "active",
    current_period_start: Math.floor(Date.UTC(2026, 10, 12, 12, 0, 0) / 1000),
    current_period_end: Math.floor(Date.UTC(2026, 11, 12, 12, 0, 0) / 1000),
    cancel_at_period_end: false,
    latest_invoice: "in_initial_001",
    metadata: {
      ownerEpicId: "owner_1",
      projectId: "prj_1",
      planVersionId: "pro-v1",
      environment: "test",
    },
    items: {
      data: [{ id: "si_001", price: { id: PRO_PRICE } }],
    },
  };
  let failNextStripeDelete = false;
  let refundSeq = 1;
  let checkoutSeq = 1;
  const checkoutSessions = new Map<string, Record<string, unknown>>();

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.hostname !== "api.stripe.com") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      const rawBody = await req.text();
      stripeCalls.push({
        method: req.method,
        path: url.pathname,
        body: rawBody,
        idempotencyKey: req.headers.get("Idempotency-Key"),
      });

      const form = new URLSearchParams(rawBody);
      if (url.pathname === "/v1/customers" && req.method === "POST") {
        return Response.json({ id: "cus_stripe_001", email: form.get("email") });
      }
      if (url.pathname === "/v1/checkout/sessions" && req.method === "POST") {
        const meta: Record<string, string> = {};
        for (const [k, v] of form.entries()) {
          if (k.startsWith("metadata[") && k.endsWith("]")) {
            meta[k.slice(9, -1)] = v;
          }
        }
        liveStripeSub.metadata = {
          ...(liveStripeSub.metadata as Record<string, string>),
          ...meta,
        };
        const sessionId = `cs_test_${String(checkoutSeq++).padStart(3, "0")}`;
        const createdSession = {
          id: sessionId,
          url: `https://checkout.stripe.com/c/pay/${sessionId}`,
          status: "open",
          customer: "cus_stripe_001",
          subscription: null,
          metadata: meta,
        };
        checkoutSessions.set(sessionId, createdSession);
        return Response.json(createdSession);
      }
      if (url.pathname.startsWith("/v1/checkout/sessions/")) {
        const suffix = url.pathname.slice("/v1/checkout/sessions/".length);
        if (suffix.endsWith("/expire") && req.method === "POST") {
          const sessionId = suffix.slice(0, -"/expire".length);
          const existing = checkoutSessions.get(sessionId);
          if (!existing) {
            return Response.json(
              { error: { message: "No such checkout session", code: "resource_missing" } },
              { status: 404 },
            );
          }
          if (existing.status !== "open") {
            return Response.json(
              { error: { message: "Session cannot be expired", code: "checkout_session_not_open" } },
              { status: 400 },
            );
          }
          existing.status = "expired";
          return Response.json(existing);
        }
        if (req.method === "GET") {
          const existing = checkoutSessions.get(suffix);
          if (!existing) {
            return Response.json(
              { error: { message: "No such checkout session", code: "resource_missing" } },
              { status: 404 },
            );
          }
          return Response.json(existing);
        }
      }
      if (
        url.pathname === "/v1/billing_portal/sessions" &&
        req.method === "POST"
      ) {
        return Response.json({
          id: "bps_test_001",
          url: "https://billing.stripe.com/p/session/bps_test_001",
        });
      }
      if (url.pathname.startsWith("/v1/subscriptions/")) {
        if (req.method === "GET") {
          return Response.json(liveStripeSub);
        }
        if (req.method === "POST") {
          const nextPrice = form.get("items[0][price]");
          if (nextPrice) {
            liveStripeSub = {
              ...liveStripeSub,
              items: {
                data: [{ id: "si_001", price: { id: nextPrice } }],
              },
            };
          }
          if (form.has("cancel_at_period_end")) {
            liveStripeSub = {
              ...liveStripeSub,
              cancel_at_period_end: form.get("cancel_at_period_end") === "true",
            };
          }
          return Response.json(liveStripeSub);
        }
        if (req.method === "DELETE") {
          if (failNextStripeDelete) {
            failNextStripeDelete = false;
            return Response.json(
              { error: { message: "Stripe temporary error", code: "api_error" } },
              { status: 500 },
            );
          }
          liveStripeSub = {
            ...liveStripeSub,
            status: "canceled",
            canceled_at: Math.floor(Date.now() / 1000),
          };
          return Response.json(liveStripeSub);
        }
      }
      if (url.pathname.startsWith("/v1/invoices/")) {
        return Response.json({
          id: "in_initial_001",
          charge: "ch_initial_001",
          payment_intent: "pi_initial_001",
          amount_paid: 900,
          currency: "eur",
        });
      }
      if (url.pathname === "/v1/refunds" && req.method === "POST") {
        return Response.json({
          id: `re_${refundSeq++}`,
          status: "succeeded",
          amount: 900,
        });
      }
      return Response.json({ error: { message: "Unhandled Stripe mock route" } }, { status: 404 });
    }),
  );

  const env = {
    DB: db,
    DASHBOARD_SESSION_SECRET: DASHBOARD_SECRET,
    DASHBOARD_ORIGIN,
    API_PROXY_HOST: "api.egdata.app",
    UPSTREAM_API_ORIGIN: "https://origin-api.egdata.app",
    ORIGIN_AUTH_TOKEN: "origin-secret-token",
    COMMERCIAL_PLAN_LIMITS_ENABLED: "true",
    RATE_LIMIT_ENVIRONMENT: "test",
    STRIPE_MODE: "test",
    STRIPE_SECRET_KEY: "sk_test_mock_secret",
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_PRICE_ID_PRO: PRO_PRICE,
    STRIPE_PRICE_ID_SCALE: SCALE_PRICE,
    API_KEYS_KV: {
      get: vi.fn(async (key: string) => kvStore.get(key) ?? null),
      put: vi.fn(async (key: string, val: string) => {
        kvStore.set(key, JSON.parse(val));
      }),
      delete: vi.fn(async (key: string) => {
        kvStore.delete(key);
      }),
    },
    API_KEY_RATE_LIMITER:
      namespace as unknown as DashboardEnv["API_KEY_RATE_LIMITER"],
  } as unknown as DashboardEnv;

  const ctx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;

  async function cookieFor(epicAccountId: string) {
    const token = await signHmacToken(
      {
        user: {
          epicAccountId,
          displayName: epicAccountId,
          avatarUrl: "",
          isAdmin: epicAccountId === "admin_1",
        },
        iat: Date.now(),
        exp: Date.now() + 86_400_000,
      },
      DASHBOARD_SECRET,
    );
    return `egdata_dash_session=${token}`;
  }

  async function dashFetch(
    path: string,
    opts?: {
      method?: string;
      body?: unknown;
      user?: "owner_1" | "admin_1";
      origin?: string;
      baseUrl?: string;
    },
  ) {
    const cookie = await cookieFor(opts?.user ?? "owner_1");
    const baseUrl = opts?.baseUrl ?? DASHBOARD_ORIGIN;
    return worker.fetch(
      new Request(`${baseUrl}${path}`, {
        method: opts?.method ?? "GET",
        headers: {
          Cookie: cookie,
          Origin: opts?.origin ?? baseUrl,
          ...(opts?.body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
        },
        ...(opts?.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      }),
      env,
      ctx,
    );
  }

  async function sendWebhook(
    event: Record<string, unknown>,
    sigOverride?: string,
  ) {
    const rawBody = JSON.stringify(event);
    const sig =
      sigOverride ?? (await signStripeWebhookPayload(rawBody, WEBHOOK_SECRET));
    return worker.fetch(
      new Request(`${DASHBOARD_ORIGIN}/_webhooks/stripe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Stripe-Signature": sig,
        },
        body: rawBody,
      }),
      env,
      ctx,
    );
  }

  return {
    env,
    sqlite,
    namespace,
    stripeCalls,
    setLiveSub: (patch: Record<string, unknown>) => {
      liveStripeSub = { ...liveStripeSub, ...patch };
    },
    getLiveSub: () => liveStripeSub,
    setFailNextStripeDelete: (val: boolean) => {
      failNextStripeDelete = val;
    },
    setCheckoutSessionState: (id: string, patch: Record<string, unknown>) => {
      const current = checkoutSessions.get(id);
      if (current) {
        checkoutSessions.set(id, { ...current, ...patch });
      }
    },
    dashFetch,
    sendWebhook,
  };
}

describe("Phase C: Stripe billing control plane & webhook lifecycle", () => {
  it("verifies webhook HMAC-SHA256 without CSRF, enforces livemode & idempotency, and resolves out-of-order events", async () => {
    const h = await createBillingHarness();

    // Missing/invalid signature returns 400
    const badSig = await h.sendWebhook(
      { id: "evt_bad", type: "invoice.paid", data: { object: {} } },
      "t=100,v1=0000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(badSig.status).toBe(400);
    expect(await badSig.json()).toMatchObject({
      error: { code: "INVALID_STRIPE_SIGNATURE" },
    });

    // Livemode=true rejected when configured in test mode
    const mismatch = await h.sendWebhook({
      id: "evt_live",
      type: "checkout.session.completed",
      livemode: true,
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: "cs_1", subscription: "sub_stripe_001" } },
    });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({
      error: { code: "STRIPE_MODE_MISMATCH" },
    });

    // Requires withdrawal acknowledgment before initiating checkout
    const missingAck = await h.dashFetch("/_dashboard/api/billing/checkout", {
      method: "POST",
      body: {
        projectId: "prj_1",
        planId: "pro",
        termsVersion: "1.0",
        withdrawalAcknowledged: false,
      },
    });
    expect(missingAck.status).toBe(400);

    // Initiates Pro checkout (records purchase_receipt and pending subscription)
    const startCheckout = await h.dashFetch(
      "/_dashboard/api/billing/checkout",
      {
        method: "POST",
        body: {
          projectId: "prj_1",
          planId: "pro",
          termsVersion: "1.0",
          withdrawalAcknowledged: true,
        },
      },
    );
    expect(startCheckout.status).toBe(200);
    const checkoutJson = (await startCheckout.json()) as {
      subscriptionId: string;
      checkoutUrl: string;
      alreadyPending: boolean;
    };
    expect(checkoutJson.checkoutUrl).toContain("checkout.stripe.com");
    expect(checkoutJson.alreadyPending).toBe(false);

    // Valid signed checkout.session.completed webhook (with no Origin/CSRF header) activates Pro
    const completedEvent = {
      id: "evt_checkout_1",
      type: "checkout.session.completed",
      livemode: false,
      created: Math.floor(Date.now() / 1000) + 10,
      data: {
        object: {
          id: "cs_test_001",
          subscription: "sub_stripe_001",
          metadata: {
            ownerEpicId: "owner_1",
            projectId: "prj_1",
            localSubscriptionId: checkoutJson.subscriptionId,
            planVersionId: "pro-v1",
            environment: "test",
          },
        },
      },
    };
    const hook1 = await h.sendWebhook(completedEvent);
    expect(hook1.status).toBe(200);

    // Duplicate delivery returns duplicate: true without re-applying grant
    const hookDup = await h.sendWebhook(completedEvent);
    expect(hookDup.status).toBe(200);
    expect(await hookDup.json()).toMatchObject({
      received: true,
      duplicate: true,
    });

    // Second live checkout on already-subscribed project rejected (single subscription per project)
    const secondSub = await h.dashFetch("/_dashboard/api/billing/checkout", {
      method: "POST",
      body: {
        projectId: "prj_1",
        planId: "scale",
        termsVersion: "1.0",
        withdrawalAcknowledged: true,
      },
    });
    expect(secondSub.status).toBe(409);

    // Out-of-order older customer.subscription.updated (canceled) event does NOT downgrade newer active sub
    const staleHook = await h.sendWebhook({
      id: "evt_stale_order",
      type: "customer.subscription.updated",
      livemode: false,
      created: Math.floor(Date.now() / 1000) - 500,
      data: {
        object: {
          ...h.getLiveSub(),
          status: "canceled",
        },
      },
    });
    expect(staleHook.status).toBe(200);

    const ent = await resolveEffectiveProjectEntitlement(h.env, {
      projectId: "prj_1",
      ownerEpicId: "owner_1",
      tier: "pro",
      customRpm: null,
    });
    expect(ent.tier).toBe("pro");
    expect(ent.rpmLimit).toBe(200);
    expect(ent.periodAllowance).toBe(300_000);
  });

  it("handles upgrades preserving consumed usage, scheduled downgrades, grace expiry, withdrawals, disputes, and deletion recovery", async () => {
    const h = await createBillingHarness();

    // Create & activate Pro subscription
    const coRes = await h.dashFetch("/_dashboard/api/billing/checkout", {
      method: "POST",
      body: {
        projectId: "prj_1",
        planId: "pro",
        termsVersion: "1.0",
        withdrawalAcknowledged: true,
      },
    });
    const { subscriptionId } = (await coRes.json()) as {
      subscriptionId: string;
    };
    await h.sendWebhook({
      id: "evt_act_1",
      type: "checkout.session.completed",
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "cs_test_001",
          subscription: "sub_stripe_001",
          metadata: {
            ownerEpicId: "owner_1",
            projectId: "prj_1",
            localSubscriptionId: subscriptionId,
            planVersionId: "pro-v1",
            environment: "test",
          },
        },
      },
    });

    // Seed consumed period usage = 4,200 on prj_1 DO
    const subRow = h.sqlite
      .prepare(
        "SELECT current_period_start, current_period_end FROM billing_subscriptions WHERE id = ?",
      )
      .get(subscriptionId) as {
      current_period_start: number;
      current_period_end: number;
    };
    const stub = h.namespace.get("account:test:owner_1");
    await stub.admit({
      keyId: "k1",
      policies: [
        { name: "global", limit: 200 },
        {
          name: "period",
          limit: 300_000,
          window: "period",
          periodStart: subRow.current_period_start,
          periodEnd: subRow.current_period_end,
        },
      ],
      projectId: "prj_1",
      ownerEpicId: "owner_1",
    });
    (
      stub as unknown as {
        ctx: { storage: { sql: { exec: (...args: unknown[]) => unknown } } };
      }
    ).ctx.storage.sql.exec(
      `UPDATE project_period_state SET used_count = 4200 WHERE project_id = 'prj_1'`,
    );

    // Upgrade Pro -> Scale: immediate RPM=600 & 1,000,000 allowance, used_count stays 4,200
    const upgradeRes = await h.dashFetch(
      "/_dashboard/api/billing/subscription/change",
      {
        method: "POST",
        body: { projectId: "prj_1", targetPlanId: "scale" },
      },
    );
    expect(upgradeRes.status).toBe(200);
    const usageAfterUpgrade = await readProjectBillingQuota(
      h.env,
      "owner_1",
      "prj_1",
      1_000_000,
      subRow.current_period_start,
      subRow.current_period_end,
    );
    expect(usageAfterUpgrade?.used).toBe(4200);
    expect(usageAfterUpgrade?.allowance).toBe(1_000_000);

    // Schedule downgrade Scale -> Free at period end: keeps Scale capacity until period_end
    const downgradeRes = await h.dashFetch(
      "/_dashboard/api/billing/subscription/change",
      {
        method: "POST",
        body: { projectId: "prj_1", targetPlanId: "free" },
      },
    );
    expect(downgradeRes.status).toBe(200);
    const downJson = (await downgradeRes.json()) as {
      scheduledForPeriodEnd: boolean;
      entitlement: { tier: string; cancelAtPeriodEnd: boolean };
    };
    expect(downJson.scheduledForPeriodEnd).toBe(true);
    expect(downJson.entitlement.tier).toBe("scale");
    expect(downJson.entitlement.cancelAtPeriodEnd).toBe(true);

    // Payment failure enters grace_until (3 days), preserves capacity while within grace, suspends via reconcile after grace
    await h.sendWebhook({
      id: "evt_fail_1",
      type: "invoice.payment_failed",
      livemode: false,
      created: Math.floor(Date.now() / 1000) + 10,
      data: {
        object: {
          id: "in_fail_1",
          subscription: "sub_stripe_001",
        },
      },
    });
    const inGrace = await resolveEffectiveProjectEntitlement(h.env, {
      projectId: "prj_1",
      ownerEpicId: "owner_1",
      tier: "scale",
      customRpm: null,
    });
    expect(inGrace.status).toBe("grace");
    expect(inGrace.rpmLimit).toBe(600);

    // Portal & billing summary remain reachable even with unaccepted revised terms and past_due status
    const portalRes = await h.dashFetch("/_dashboard/api/billing/portal", {
      method: "POST",
      body: {},
    });
    expect(portalRes.status).toBe(200);
    expect(((await portalRes.json()) as { url: string }).url).toContain(
      "billing.stripe.com",
    );

    // Advance past gracePeriodDays -> cron reconcileBillingState moves past_due -> unpaid & reverts to Free
    vi.advanceTimersByTime(
      (BILLING_POLICY_DEFAULTS.gracePeriodDays + 1) * 86_400_000,
    );
    const rec = await reconcileBillingState(h.env);
    expect(rec.expiredGraceCount).toBe(1);
    const afterGrace = await resolveEffectiveProjectEntitlement(h.env, {
      projectId: "prj_1",
      ownerEpicId: "owner_1",
      tier: "free",
      customRpm: null,
    });
    expect(afterGrace.tier).toBe("free");
    expect(afterGrace.rpmLimit).toBe(PLAN_VERSIONS["free-v1"].rpmLimit);

    // Invoice paid recovers subscription -> then exercise 14-day withdrawal refund within window
    h.setLiveSub({
      status: "active",
      cancel_at_period_end: false,
      latest_invoice: "in_initial_001",
    });
    await h.sendWebhook({
      id: "evt_paid_recover",
      type: "invoice.paid",
      livemode: false,
      created: Math.floor(Date.now() / 1000) + 20,
      data: {
        object: {
          id: "in_initial_001",
          subscription: "sub_stripe_001",
        },
      },
    });
    const summaryBeforeWithdraw = await getProjectBillingSummary(
      h.env,
      "prj_1",
      "owner_1",
    );
    expect(summaryBeforeWithdraw.subscription?.status).toBe("active");

    // Rewind clock back inside withdrawal window? Better: check withdrawal_expires_at in DB and set SystemTime within it
    vi.setSystemTime(new Date("2026-11-12T12:05:00Z"));
    const withdrawRes = await h.dashFetch(
      "/_dashboard/api/billing/withdrawals",
      {
        method: "POST",
        body: { projectId: "prj_1", reason: "No longer needed" },
      },
    );
    expect(withdrawRes.status).toBe(200);
    const withdrawJson = (await withdrawRes.json()) as {
      status: string;
      stripeRefundId: string;
    };
    expect(withdrawJson.status).toBe("refunded_full");
    expect(withdrawJson.stripeRefundId).toBe("re_1");
    expect(
      h.stripeCalls.some((c) => c.path === "/v1/refunds" && c.method === "POST"),
    ).toBe(true);

    // Paid grant revoked & subscription canceled immediately
    const postWithdrawEnt = await resolveEffectiveProjectEntitlement(h.env, {
      projectId: "prj_1",
      ownerEpicId: "owner_1",
      tier: "free",
      customRpm: null,
    });
    expect(postWithdrawEnt.tier).toBe("free");

    // Account billing receipts endpoint returns purchase receipt & withdrawal with project names
    const receiptsRes = await h.dashFetch("/_dashboard/api/billing/receipts");
    expect(receiptsRes.status).toBe(200);
    const receiptsJson = (await receiptsRes.json()) as {
      receipts: Array<Record<string, unknown>>;
      withdrawals: Array<Record<string, unknown>>;
    };
    expect(receiptsJson.receipts).toHaveLength(1);
    expect(receiptsJson.receipts[0]).toMatchObject({
      project_id: "prj_1",
      project_name: "Primary App",
      stripe_checkout_session_id: "cs_test_001",
      price_eur_cents: 900,
    });
    expect(receiptsJson.withdrawals).toHaveLength(1);
    expect(receiptsJson.withdrawals[0]).toMatchObject({
      project_id: "prj_1",
      project_name: "Primary App",
      status: "refunded_full",
      stripe_refund_id: "re_1",
    });

    // Admin usage adjustment & reconciliation endpoints work end-to-end
    const adjRes = await h.dashFetch(
      "/_dashboard/api/admin/projects/prj_1/usage-adjustments",
      {
        method: "POST",
        user: "admin_1",
        body: {
          adjustmentId: "adj_test_001",
          scope: "period",
          amount: 500,
          reason: "Operator credit test",
        },
      },
    );
    expect(adjRes.status).toBe(200);
    expect(
      h.sqlite
        .prepare("SELECT reason FROM usage_adjustments WHERE adjustment_id = 'adj_test_001'")
        .get(),
    ).toEqual({ reason: "Operator credit test" });
  });

  it("cancels subscriptions on admin project delete / account close without deleting financial records, and restores clean state", async () => {
    const h = await createBillingHarness({ termsRevisedAfterAccept: true });

    // User with outdated legal agreement can still fetch billing portal & receipts
    const portalWhileOutdated = await h.dashFetch(
      "/_dashboard/api/billing/portal",
      { method: "POST", body: {} },
    );
    expect(portalWhileOutdated.status).toBe(200);

    // Accept current terms and activate subscription directly in DB to test deletion/restore hooks
    h.sqlite.exec(
      `UPDATE legal_acceptances SET retain_until = ${Date.now() + 86_400_000} WHERE owner_id = 'owner_1';
       INSERT INTO legal_acceptances(owner_id, version, edition, sha256, accepted_at, requirement_revision, receipt_id, privacy_version, privacy_sha256)
       VALUES ('owner_1', '1.0', 'edition-1', '${await sha256Hex("Commercial Terms v1")}', ${Date.now() + 1}, 'rev-1', 'rcpt_owner_1_v2', '1.0', '${await sha256Hex("Privacy v1")}')`,
    );

    h.sqlite.exec(`
      INSERT OR IGNORE INTO billing_customers(owner_epic_id, environment, stripe_customer_id)
      VALUES ('owner_1', 'test', 'cus_stripe_001');
      INSERT INTO billing_subscriptions(
        id, owner_epic_id, project_id, environment, stripe_customer_id,
        stripe_subscription_id, plan_version_id, status,
        current_period_start, current_period_end, cancel_at_period_end
      ) VALUES (
        'sub_del_1', 'owner_1', 'prj_1', 'test', 'cus_stripe_001',
        'sub_stripe_001', 'pro-v1', 'active',
        ${Date.now() - 86_400_000}, ${Date.now() + 29 * 86_400_000}, 0
      );
      UPDATE projects SET tier = 'pro' WHERE id = 'prj_1';
    `);

    // Simulate transient Stripe DELETE failure -> admin delete marks needs_reconcile = 1, then cron fixes it
    h.setFailNextStripeDelete(true);
    const delRes = await h.dashFetch("/_dashboard/api/admin/projects/prj_1", {
      method: "DELETE",
      user: "admin_1",
      body: { reason: "Policy review deletion" },
    });
    expect(delRes.status).toBe(200);

    const rowAfterDelete = h.sqlite
      .prepare(
        "SELECT status, needs_reconcile FROM billing_subscriptions WHERE id = 'sub_del_1'",
      )
      .get() as { status: string; needs_reconcile: number };
    expect(rowAfterDelete.status).toBe("canceled");
    expect(rowAfterDelete.needs_reconcile).toBe(1);

    // Admin reconcile clears needs_reconcile & finishes Stripe DELETE
    const recRes = await h.dashFetch("/_dashboard/api/admin/billing/reconcile", {
      method: "POST",
      user: "admin_1",
    });
    expect(recRes.status).toBe(200);
    expect(((await recRes.json()) as { reconciledCount: number }).reconciledCount).toBe(1);
    expect(
      h.sqlite
        .prepare("SELECT needs_reconcile FROM billing_subscriptions WHERE id = 'sub_del_1'")
        .get(),
    ).toEqual({ needs_reconcile: 0 });

    // Restore project: subscription stays canceled & financial record remains intact
    const restoreRes = await h.dashFetch(
      "/_dashboard/api/admin/projects/prj_1/restore",
      {
        method: "POST",
        user: "admin_1",
        body: { reason: "Restored on Free plan" },
      },
    );
    expect(restoreRes.status).toBe(200);
    expect(
      h.sqlite
        .prepare("SELECT id, status FROM billing_subscriptions WHERE id = 'sub_del_1'")
        .get(),
    ).toEqual({ id: "sub_del_1", status: "canceled" });

    // Lost dispute webhook cancels paid grant & records audit
    h.sqlite.exec(
      `UPDATE billing_subscriptions SET status = 'active' WHERE id = 'sub_del_1'`,
    );
    const disputeRes = await h.sendWebhook({
      id: "evt_dispute_lost",
      type: "charge.dispute.closed",
      livemode: false,
      created: Math.floor(Date.now() / 1000) + 30,
      data: {
        object: {
          id: "dp_1",
          status: "lost",
          metadata: { localSubscriptionId: "sub_del_1" },
        },
      },
    });
    expect(disputeRes.status).toBe(200);
    expect(
      h.sqlite
        .prepare(
          "SELECT status, dispute_status FROM billing_subscriptions WHERE id = 'sub_del_1'",
        )
        .get(),
    ).toEqual({ status: "canceled", dispute_status: "lost" });
  });

  it("rejects untrusted Stripe redirect URLs while permitting configured dashboard and local dev origins", async () => {
    const h = await createBillingHarness();

    const badCheckoutUrls = [
      {
        successUrl: "https://evil.example/phish",
        cancelUrl: `${DASHBOARD_ORIGIN}/limits`,
      },
      {
        successUrl: `${DASHBOARD_ORIGIN}/limits`,
        cancelUrl: "https://devs.egdata.app.evil.example/limits",
      },
      {
        successUrl: "https://user:pass@devs.egdata.app/limits",
      },
      {
        successUrl: "http://localhost:4002/limits",
      },
    ];

    for (const bad of badCheckoutUrls) {
      const res = await h.dashFetch("/_dashboard/api/billing/checkout", {
        method: "POST",
        body: {
          projectId: "prj_1",
          planId: "pro",
          termsVersion: "1.0",
          withdrawalAcknowledged: true,
          ...bad,
        },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "VALIDATION_ERROR",
      );
    }

    const badPortalUrls = [
      "https://evil.example/return",
      "https://devs.egdata.app.evil.example/limits",
      "https://user:pass@devs.egdata.app/limits",
      "http://localhost:4002/limits",
    ];
    for (const returnUrl of badPortalUrls) {
      const res = await h.dashFetch("/_dashboard/api/billing/portal", {
        method: "POST",
        body: { returnUrl },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "VALIDATION_ERROR",
      );
    }

    // None of the rejected requests should have touched Stripe
    expect(h.stripeCalls).toHaveLength(0);

    // Same-origin returnUrl and localhost dev origin are permitted
    const okPortal = await h.dashFetch("/_dashboard/api/billing/portal", {
      method: "POST",
      body: { returnUrl: `${DASHBOARD_ORIGIN}/limits?project=prj_1` },
    });
    expect(okPortal.status).toBe(200);

    const localPortal = await h.dashFetch("/_dashboard/api/billing/portal", {
      method: "POST",
      baseUrl: "http://localhost:4002",
      body: { returnUrl: "http://localhost:4002/limits" },
    });
    expect(localPortal.status).toBe(200);

    const localCrossPortPortal = await h.dashFetch(
      "/_dashboard/api/billing/portal",
      {
        method: "POST",
        baseUrl: "http://localhost:4002",
        body: { returnUrl: "http://localhost:9999/limits" },
      },
    );
    expect(localCrossPortPortal.status).toBe(400);

    const okCheckout = await h.dashFetch("/_dashboard/api/billing/checkout", {
      method: "POST",
      body: {
        projectId: "prj_1",
        planId: "pro",
        termsVersion: "1.0",
        withdrawalAcknowledged: true,
        successUrl: `${DASHBOARD_ORIGIN}/limits?project=prj_1&checkout=success`,
        cancelUrl: `${DASHBOARD_ORIGIN}/limits?project=prj_1&checkout=canceled`,
      },
    });
    expect(okCheckout.status).toBe(200);
  });

  it("ignores stale invoice.payment_failed and invoice.paid events older than last_event_created", async () => {
    const h = await createBillingHarness();
    const baseSec = Math.floor(Date.now() / 1000);

    const coRes = await h.dashFetch("/_dashboard/api/billing/checkout", {
      method: "POST",
      body: {
        projectId: "prj_1",
        planId: "pro",
        termsVersion: "1.0",
        withdrawalAcknowledged: true,
      },
    });
    const { subscriptionId } = (await coRes.json()) as {
      subscriptionId: string;
    };

    await h.sendWebhook({
      id: "evt_order_completed",
      type: "checkout.session.completed",
      livemode: false,
      created: baseSec + 100,
      data: {
        object: {
          id: "cs_test_001",
          subscription: "sub_stripe_001",
          metadata: {
            ownerEpicId: "owner_1",
            projectId: "prj_1",
            localSubscriptionId: subscriptionId,
            planVersionId: "pro-v1",
            environment: "test",
          },
        },
      },
    });

    // Newer invoice.paid succeeds at baseSec + 200
    h.setLiveSub({
      status: "active",
      latest_invoice: "in_new_paid",
    });
    await h.sendWebhook({
      id: "evt_new_paid",
      type: "invoice.paid",
      livemode: false,
      created: baseSec + 200,
      data: {
        object: {
          id: "in_new_paid",
          subscription: "sub_stripe_001",
        },
      },
    });

    // Delayed invoice.payment_failed from baseSec + 150 must NOT mark subscription past_due
    const staleFailRes = await h.sendWebhook({
      id: "evt_stale_fail",
      type: "invoice.payment_failed",
      livemode: false,
      created: baseSec + 150,
      data: {
        object: {
          id: "in_old_failed",
          subscription: "sub_stripe_001",
        },
      },
    });
    expect(staleFailRes.status).toBe(200);

    const subAfterStaleFail = h.sqlite
      .prepare(
        "SELECT status, grace_until, last_invoice_id, last_event_created FROM billing_subscriptions WHERE id = ?",
      )
      .get(subscriptionId) as {
      status: string;
      grace_until: number | null;
      last_invoice_id: string | null;
      last_event_created: number;
    };
    expect(subAfterStaleFail).toMatchObject({
      status: "active",
      grace_until: null,
      last_invoice_id: "in_new_paid",
      last_event_created: baseSec + 200,
    });

    const entAfterStaleFail = await resolveEffectiveProjectEntitlement(h.env, {
      projectId: "prj_1",
      ownerEpicId: "owner_1",
      tier: "pro",
      customRpm: null,
    });
    expect(entAfterStaleFail.status).toBe("active");
    expect(entAfterStaleFail.tier).toBe("pro");

    // Advance past grace window: reconciliation must NOT revoke paid capacity
    vi.advanceTimersByTime(
      (BILLING_POLICY_DEFAULTS.gracePeriodDays + 1) * 86_400_000,
    );
    const rec = await reconcileBillingState(h.env);
    expect(rec.expiredGraceCount).toBe(0);

    // A genuinely newer invoice.payment_failed at baseSec + 300 enters grace period
    const freshFailRes = await h.sendWebhook({
      id: "evt_fresh_fail",
      type: "invoice.payment_failed",
      livemode: false,
      created: baseSec + 300,
      data: {
        object: {
          id: "in_fresh_fail",
          subscription: "sub_stripe_001",
        },
      },
    });
    expect(freshFailRes.status).toBe(200);

    // Delayed older invoice.paid (with Stripe key and in fallback without Stripe key) must NOT clobber newer past_due
    h.setLiveSub({ status: "active", latest_invoice: "in_stale_paid" });
    await h.sendWebhook({
      id: "evt_stale_paid_with_key",
      type: "invoice.paid",
      livemode: false,
      created: baseSec + 250,
      data: {
        object: {
          id: "in_stale_paid_1",
          subscription: "sub_stripe_001",
        },
      },
    });
    h.env.STRIPE_SECRET_KEY = undefined;
    await h.sendWebhook({
      id: "evt_stale_paid_no_key",
      type: "invoice.paid",
      livemode: false,
      created: baseSec + 260,
      data: {
        object: {
          id: "in_stale_paid_2",
          subscription: "sub_stripe_001",
        },
      },
    });

    const subAfterStalePaid = h.sqlite
      .prepare(
        "SELECT status, grace_until, last_invoice_id, last_event_created FROM billing_subscriptions WHERE id = ?",
      )
      .get(subscriptionId) as {
      status: string;
      grace_until: number | null;
      last_invoice_id: string | null;
      last_event_created: number;
    };
    expect(subAfterStalePaid.status).toBe("past_due");
    expect(subAfterStalePaid.grace_until).not.toBeNull();
    expect(subAfterStalePaid.last_invoice_id).toBe("in_fresh_fail");
    expect(subAfterStalePaid.last_event_created).toBe(baseSec + 300);

    // Newer invoice.paid in fallback mode (without STRIPE_SECRET_KEY) succeeds and advances last_event_created
    await h.sendWebhook({
      id: "evt_newer_paid_no_key",
      type: "invoice.paid",
      livemode: false,
      created: baseSec + 400,
      data: {
        object: {
          id: "in_recovered_paid",
          subscription: "sub_stripe_001",
        },
      },
    });
    const subRecovered = h.sqlite
      .prepare(
        "SELECT status, grace_until, last_invoice_id, last_event_created FROM billing_subscriptions WHERE id = ?",
      )
      .get(subscriptionId) as {
      status: string;
      grace_until: number | null;
      last_invoice_id: string | null;
      last_event_created: number;
    };
    expect(subRecovered).toMatchObject({
      status: "active",
      grace_until: null,
      last_invoice_id: "in_recovered_paid",
      last_event_created: baseSec + 400,
    });
  });

  it("resumes, switches, cancels, and reconciles abandoned checkout_pending sessions without wedging", async () => {
    const h = await createBillingHarness();

    // 1. User clicks Subscribe to Pro then hits browser Back
    const first = await h.dashFetch("/_dashboard/api/billing/checkout", {
      method: "POST",
      body: {
        projectId: "prj_1",
        planId: "pro",
        termsVersion: "1.0",
        withdrawalAcknowledged: true,
      },
    });
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as {
      subscriptionId: string;
      checkoutSessionId: string;
      checkoutUrl: string | null;
      alreadyPending: boolean;
    };
    expect(firstJson.checkoutSessionId).toBe("cs_test_001");
    expect(firstJson.checkoutUrl).toBe(
      "https://checkout.stripe.com/c/pay/cs_test_001",
    );
    expect(firstJson.alreadyPending).toBe(false);

    // 2. Retrying Subscribe to Pro returns the live open checkoutUrl instead of null
    const retrySame = await h.dashFetch("/_dashboard/api/billing/checkout", {
      method: "POST",
      body: {
        projectId: "prj_1",
        planId: "pro",
        termsVersion: "1.0",
        withdrawalAcknowledged: true,
      },
    });
    expect(retrySame.status).toBe(200);
    expect(await retrySame.json()).toMatchObject({
      subscriptionId: firstJson.subscriptionId,
      checkoutSessionId: "cs_test_001",
      checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_001",
      alreadyPending: true,
      planVersionId: "pro-v1",
    });

    // 3. Switching to Scale while Pro checkout is pending expires Pro session and creates a new Scale checkout
    const switchScale = await h.dashFetch("/_dashboard/api/billing/checkout", {
      method: "POST",
      body: {
        projectId: "prj_1",
        planId: "scale",
        termsVersion: "1.0",
        withdrawalAcknowledged: true,
      },
    });
    expect(switchScale.status).toBe(200);
    const scaleJson = (await switchScale.json()) as {
      subscriptionId: string;
      checkoutSessionId: string;
      checkoutUrl: string | null;
      alreadyPending: boolean;
      planVersionId: string;
    };
    expect(scaleJson.checkoutSessionId).toBe("cs_test_002");
    expect(scaleJson.checkoutUrl).toBe(
      "https://checkout.stripe.com/c/pay/cs_test_002",
    );
    expect(scaleJson.alreadyPending).toBe(false);
    expect(scaleJson.planVersionId).toBe("scale-v1");

    const oldRow = h.sqlite
      .prepare("SELECT status FROM billing_subscriptions WHERE id = ?")
      .get(firstJson.subscriptionId) as { status: string };
    expect(oldRow.status).toBe("incomplete_expired");
    expect(
      h.stripeCalls.some(
        (c) =>
          c.method === "POST" &&
          c.path === "/v1/checkout/sessions/cs_test_001/expire",
      ),
    ).toBe(true);

    // 4. Explicit cancel (?checkout=canceled or Cancel button) clears pending state back to Free
    const cancelRes = await h.dashFetch(
      "/_dashboard/api/billing/checkout/cancel",
      {
        method: "POST",
        body: { projectId: "prj_1" },
      },
    );
    expect(cancelRes.status).toBe(200);
    expect(await cancelRes.json()).toMatchObject({ canceled: true });

    const scaleRow = h.sqlite
      .prepare("SELECT status FROM billing_subscriptions WHERE id = ?")
      .get(scaleJson.subscriptionId) as { status: string };
    expect(scaleRow.status).toBe("incomplete_expired");

    // 5. Reconcile completed session cleanly if payment succeeded before retry and webhook hadn't arrived yet
    const third = await h.dashFetch("/_dashboard/api/billing/checkout", {
      method: "POST",
      body: {
        projectId: "prj_1",
        planId: "pro",
        termsVersion: "1.0",
        withdrawalAcknowledged: true,
      },
    });
    expect(third.status).toBe(200);
    const thirdJson = (await third.json()) as {
      subscriptionId: string;
      checkoutSessionId: string;
    };
    h.setCheckoutSessionState(thirdJson.checkoutSessionId, {
      status: "complete",
      subscription: "sub_stripe_001",
      metadata: {
        ownerEpicId: "owner_1",
        projectId: "prj_1",
        localSubscriptionId: thirdJson.subscriptionId,
        planVersionId: "pro-v1",
        environment: "test",
      },
    });

    const retryAfterPaid = await h.dashFetch(
      "/_dashboard/api/billing/checkout",
      {
        method: "POST",
        body: {
          projectId: "prj_1",
          planId: "pro",
          termsVersion: "1.0",
          withdrawalAcknowledged: true,
        },
      },
    );
    expect(retryAfterPaid.status).toBe(409);

    const activeRow = h.sqlite
      .prepare("SELECT status FROM billing_subscriptions WHERE id = ?")
      .get(thirdJson.subscriptionId) as { status: string };
    expect(activeRow.status).toBe("active");
  });
});
