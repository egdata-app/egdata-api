import { timingSafeStringEqual } from "./crypto.js";
import { BILLING_POLICY_DEFAULTS, type PlanVersionId } from "./plans.js";
import type { DashboardEnv } from "./types.js";

export type StripeEnvironment = "test" | "live";

const STRIPE_API_BASE = "https://api.stripe.com/v1";
const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;

export class StripeApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly stripeCode?: string,
  ) {
    super(message);
    this.name = "StripeApiError";
  }
}

export function getStripeEnvironment(
  env: Pick<DashboardEnv, "STRIPE_MODE" | "STRIPE_SECRET_KEY">,
): StripeEnvironment {
  const secret = env.STRIPE_SECRET_KEY?.trim() ?? "";
  const explicitMode = env.STRIPE_MODE?.trim().toLowerCase();
  const keyInferred: StripeEnvironment | null =
    secret.startsWith("sk_test_") ||
    secret.startsWith("rk_test_") ||
    secret.startsWith("rkcs_test_")
      ? "test"
      : secret.startsWith("sk_live_") || secret.startsWith("rk_live_")
        ? "live"
        : null;

  if (explicitMode && explicitMode !== "test" && explicitMode !== "live") {
    throw new Error("Invalid STRIPE_MODE configuration");
  }
  if (explicitMode && keyInferred && explicitMode !== keyInferred) {
    throw new Error(
      `STRIPE_MODE (${explicitMode}) mismatches STRIPE_SECRET_KEY (${keyInferred})`,
    );
  }
  if (explicitMode === "test" || explicitMode === "live") {
    return explicitMode;
  }
  return keyInferred ?? "live";
}

export function isStripeConfigured(
  env: Pick<
    DashboardEnv,
    "STRIPE_SECRET_KEY" | "STRIPE_PRICE_ID_PRO" | "STRIPE_PRICE_ID_SCALE"
  >,
): boolean {
  return Boolean(
    env.STRIPE_SECRET_KEY?.trim() &&
      env.STRIPE_PRICE_ID_PRO?.trim() &&
      env.STRIPE_PRICE_ID_SCALE?.trim(),
  );
}

export function resolveAllowlistedStripePriceId(
  env: Pick<DashboardEnv, "STRIPE_PRICE_ID_PRO" | "STRIPE_PRICE_ID_SCALE">,
  planId: "pro" | "scale",
): string {
  const raw =
    planId === "pro"
      ? env.STRIPE_PRICE_ID_PRO?.trim()
      : env.STRIPE_PRICE_ID_SCALE?.trim();
  if (!raw) {
    throw new Error(`Missing configured Stripe price ID for plan '${planId}'`);
  }
  return raw;
}

export function resolvePlanVersionFromStripePrice(
  env: Pick<DashboardEnv, "STRIPE_PRICE_ID_PRO" | "STRIPE_PRICE_ID_SCALE">,
  priceId: string | null | undefined,
): PlanVersionId | null {
  if (!priceId) return null;
  if (env.STRIPE_PRICE_ID_PRO?.trim() === priceId) return "pro-v1";
  if (env.STRIPE_PRICE_ID_SCALE?.trim() === priceId) return "scale-v1";
  return null;
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifyStripeWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  webhookSecret: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!webhookSecret?.trim() || !signatureHeader?.trim()) {
    return false;
  }

  let timestamp: number | null = null;
  const v1Signatures: string[] = [];
  for (const part of signatureHeader.split(",")) {
    const [key, ...rest] = part.trim().split("=");
    const value = rest.join("=");
    if (!key || !value) continue;
    if (key === "t") {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed > 0) {
        timestamp = parsed;
      }
    } else if (key === "v1" && /^[0-9a-f]{64}$/i.test(value)) {
      v1Signatures.push(value.toLowerCase());
    }
  }

  if (timestamp === null || v1Signatures.length === 0) {
    return false;
  }
  if (Math.abs(nowSeconds - timestamp) > STRIPE_WEBHOOK_TOLERANCE_SECONDS) {
    return false;
  }

  const expectedHex = await hmacSha256Hex(
    webhookSecret.trim(),
    `${timestamp}.${rawBody}`,
  );
  for (const candidate of v1Signatures) {
    if (await timingSafeStringEqual(candidate, expectedHex)) {
      return true;
    }
  }
  return false;
}

export async function signStripeWebhookPayload(
  rawBody: string,
  webhookSecret: string,
  timestampSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const sig = await hmacSha256Hex(
    webhookSecret,
    `${timestampSeconds}.${rawBody}`,
  );
  return `t=${timestampSeconds},v1=${sig}`;
}

export type FormValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | FormValue[]
  | { [key: string]: FormValue };

function appendFormValue(
  out: URLSearchParams,
  prefix: string,
  value: FormValue,
): void {
  if (value === undefined || value === null) return;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    out.append(prefix, String(value));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      appendFormValue(out, `${prefix}[${index}]`, item);
    });
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    appendFormValue(out, `${prefix}[${k}]`, v);
  }
}

export function encodeStripeForm(params: Record<string, FormValue>): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    appendFormValue(out, k, v);
  }
  return out.toString();
}

export async function stripeRequest<T>(
  env: Pick<DashboardEnv, "STRIPE_SECRET_KEY" | "STRIPE_MODE">,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params?: Record<string, FormValue>,
  idempotencyKey?: string,
): Promise<T> {
  const secret = env.STRIPE_SECRET_KEY?.trim();
  if (!secret) {
    throw new StripeApiError("STRIPE_SECRET_KEY is not configured", 503);
  }
  // Validate env mode vs key prefix before sending any live request.
  getStripeEnvironment(env);

  let url = `${STRIPE_API_BASE}${path}`;
  let body: string | undefined;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secret}`,
    "Stripe-Version": BILLING_POLICY_DEFAULTS.stripeApiVersion,
  };

  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }

  if (params && Object.keys(params).length > 0) {
    const encoded = encodeStripeForm(params);
    if (method === "GET") {
      url += `${url.includes("?") ? "&" : "?"}${encoded}`;
    } else {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = encoded;
    }
  }

  const response = await fetch(url, { method, headers, body });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = {};
  }

  if (!response.ok) {
    const errObj =
      parsed.error && typeof parsed.error === "object"
        ? (parsed.error as { message?: string; code?: string })
        : {};
    throw new StripeApiError(
      errObj.message || `Stripe request failed with HTTP ${response.status}`,
      response.status,
      errObj.code,
    );
  }

  return parsed as T;
}

export interface StripeCustomer {
  id: string;
  email?: string | null;
  metadata?: Record<string, string>;
}

export interface StripeCheckoutSession {
  id: string;
  url: string | null;
  customer: string | null;
  subscription: string | null;
  payment_status?: string;
  status?: string;
  metadata?: Record<string, string>;
  client_reference_id?: string | null;
}

export interface StripePortalSession {
  id: string;
  url: string;
}

export interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  current_period_start: number;
  current_period_end: number;
  cancel_at_period_end: boolean;
  canceled_at: number | null;
  latest_invoice?: string | { id: string; payment_intent?: string | { id: string } | null; charge?: string | null } | null;
  metadata?: Record<string, string>;
  items?: {
    data: Array<{
      id: string;
      price?: { id: string } | null;
    }>;
  };
}

export interface StripeInvoice {
  id: string;
  subscription?: string | null;
  customer?: string | null;
  payment_intent?: string | { id: string } | null;
  charge?: string | null;
  status?: string | null;
  amount_paid?: number;
  amount_due?: number;
  period_start?: number;
  period_end?: number;
}

export interface StripeRefund {
  id: string;
  status: string;
  amount: number;
  currency: string;
}

export async function createStripeCustomer(
  env: Pick<DashboardEnv, "STRIPE_SECRET_KEY" | "STRIPE_MODE">,
  params: {
    ownerEpicId: string;
    email?: string | null;
    name?: string | null;
  },
  idempotencyKey?: string,
): Promise<StripeCustomer> {
  return stripeRequest<StripeCustomer>(
    env,
    "POST",
    "/customers",
    {
      ...(params.email ? { email: params.email } : {}),
      ...(params.name ? { name: params.name } : {}),
      metadata: { ownerEpicId: params.ownerEpicId },
    },
    idempotencyKey,
  );
}

export async function createStripeCheckoutSession(
  env: Pick<DashboardEnv, "STRIPE_SECRET_KEY" | "STRIPE_MODE">,
  params: {
    customerId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    clientReferenceId: string;
    metadata: Record<string, string>;
  },
  idempotencyKey?: string,
): Promise<StripeCheckoutSession> {
  return stripeRequest<StripeCheckoutSession>(
    env,
    "POST",
    "/checkout/sessions",
    {
      mode: "subscription",
      customer: params.customerId,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      client_reference_id: params.clientReferenceId,
      allow_promotion_codes: false,
      automatic_tax: { enabled: false },
      line_items: [{ price: params.priceId, quantity: 1 }],
      metadata: params.metadata,
      subscription_data: {
        metadata: params.metadata,
      },
    },
    idempotencyKey,
  );
}

export async function retrieveStripeCheckoutSession(
  env: Pick<DashboardEnv, "STRIPE_SECRET_KEY" | "STRIPE_MODE">,
  sessionId: string,
): Promise<StripeCheckoutSession> {
  return stripeRequest<StripeCheckoutSession>(
    env,
    "GET",
    `/checkout/sessions/${encodeURIComponent(sessionId)}`,
  );
}

export async function expireStripeCheckoutSession(
  env: Pick<DashboardEnv, "STRIPE_SECRET_KEY" | "STRIPE_MODE">,
  sessionId: string,
): Promise<StripeCheckoutSession> {
  return stripeRequest<StripeCheckoutSession>(
    env,
    "POST",
    `/checkout/sessions/${encodeURIComponent(sessionId)}/expire`,
  );
}

export async function createStripePortalSession(
  env: Pick<DashboardEnv, "STRIPE_SECRET_KEY" | "STRIPE_MODE">,
  params: {
    customerId: string;
    returnUrl: string;
    configurationId?: string;
  },
  idempotencyKey?: string,
): Promise<StripePortalSession> {
  return stripeRequest<StripePortalSession>(
    env,
    "POST",
    "/billing_portal/sessions",
    {
      customer: params.customerId,
      return_url: params.returnUrl,
      ...(params.configurationId
        ? { configuration: params.configurationId }
        : {}),
    },
    idempotencyKey,
  );
}

export async function retrieveStripeSubscription(
  env: Pick<DashboardEnv, "STRIPE_SECRET_KEY" | "STRIPE_MODE">,
  subscriptionId: string,
): Promise<StripeSubscription> {
  return stripeRequest<StripeSubscription>(
    env,
    "GET",
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { expand: ["latest_invoice"] },
  );
}

export async function updateStripeSubscriptionPlan(
  env: Pick<DashboardEnv, "STRIPE_SECRET_KEY" | "STRIPE_MODE">,
  params: {
    subscriptionId: string;
    itemId: string;
    priceId: string;
    prorationBehavior?: "create_prorations" | "always_invoice" | "none";
    metadata?: Record<string, string>;
  },
  idempotencyKey?: string,
): Promise<StripeSubscription> {
  return stripeRequest<StripeSubscription>(
    env,
    "POST",
    `/subscriptions/${encodeURIComponent(params.subscriptionId)}`,
    {
      items: [{ id: params.itemId, price: params.priceId }],
      proration_behavior: params.prorationBehavior ?? "always_invoice",
      cancel_at_period_end: false,
      ...(params.metadata ? { metadata: params.metadata } : {}),
    },
    idempotencyKey,
  );
}

export async function cancelStripeSubscription(
  env: Pick<DashboardEnv, "STRIPE_SECRET_KEY" | "STRIPE_MODE">,
  subscriptionId: string,
  options: { atPeriodEnd: boolean; cancelNote?: string },
  idempotencyKey?: string,
): Promise<StripeSubscription> {
  if (options.atPeriodEnd) {
    return stripeRequest<StripeSubscription>(
      env,
      "POST",
      `/subscriptions/${encodeURIComponent(subscriptionId)}`,
      {
        cancel_at_period_end: true,
        ...(options.cancelNote
          ? { cancellation_details: { comment: options.cancelNote } }
          : {}),
      },
      idempotencyKey,
    );
  }
  return stripeRequest<StripeSubscription>(
    env,
    "DELETE",
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    undefined,
    idempotencyKey,
  );
}

export async function retrieveStripeInvoice(
  env: Pick<DashboardEnv, "STRIPE_SECRET_KEY" | "STRIPE_MODE">,
  invoiceId: string,
): Promise<StripeInvoice> {
  return stripeRequest<StripeInvoice>(
    env,
    "GET",
    `/invoices/${encodeURIComponent(invoiceId)}`,
  );
}

export async function createStripeRefund(
  env: Pick<DashboardEnv, "STRIPE_SECRET_KEY" | "STRIPE_MODE">,
  params: {
    paymentIntentId?: string | null;
    chargeId?: string | null;
    amountCents?: number;
    reason?: "requested_by_customer" | "duplicate" | "fraudulent";
    metadata?: Record<string, string>;
  },
  idempotencyKey?: string,
): Promise<StripeRefund> {
  return stripeRequest<StripeRefund>(
    env,
    "POST",
    "/refunds",
    {
      ...(params.paymentIntentId
        ? { payment_intent: params.paymentIntentId }
        : params.chargeId
          ? { charge: params.chargeId }
          : {}),
      ...(params.amountCents && params.amountCents > 0
        ? { amount: params.amountCents }
        : {}),
      reason: params.reason ?? "requested_by_customer",
      ...(params.metadata ? { metadata: params.metadata } : {}),
    },
    idempotencyKey,
  );
}
