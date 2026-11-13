import type { OpenAPIV3 } from "openapi-types";

const PUBLIC_PATHS = new Set([
  "/health",
  "/ping",
  "/robots.txt",
  "/open-api.json",
  "/ui",
]);

/** Document gateway errors alongside the legacy origin's response contract. */
export function withProjectGatewayQuota(
  document: OpenAPIV3.Document,
): OpenAPIV3.Document {
  document.components ??= {};
  document.components.schemas ??= {};
  document.components.schemas.ProjectQuotaError = {
    type: "object",
    required: ["error"],
    properties: {
      error: {
        type: "object",
        required: ["code", "message"],
        properties: {
          code: {
            type: "string",
            enum: [
              "RATE_LIMITED",
              "MONTHLY_QUOTA_EXCEEDED",
              "PERIOD_QUOTA_EXCEEDED",
              "EXPENSIVE_BUDGET_EXCEEDED",
              "PLAN_ENTITLEMENT_REQUIRED",
              "QUOTA_UNAVAILABLE",
              "ACCOUNT_STATUS_UNAVAILABLE",
              "INVALID_API_KEY",
            ],
          },
          message: { type: "string" },
        },
      },
    },
  };
  for (const [path, item] of Object.entries(document.paths)) {
    if (
      !item ||
      PUBLIC_PATHS.has(path) ||
      path.endsWith("sitemap.xml") ||
      path.startsWith("/auth/")
    )
      continue;
    for (const method of [
      "get",
      "head",
      "post",
      "put",
      "patch",
      "delete",
    ] as const) {
      const operation = item[method];
      if (!operation) continue;
      operation.description =
        `${operation.description ?? ""}\n\nWhen accessed through the Worker gateway with an API key, this operation consumes the project's shared UTC-aligned 60-second quota across all keys, console sessions, and legacy/v1 gateway requests (commercial plans: Free 60/min & 100,000/UTC calendar month shared across free projects; Pro EUR 9/mo VAT-incl 200/min & 300,000/billing period; Scale EUR 19/mo VAT-incl 600/min & 1,000,000/billing period; explicit manual/grandfathered/enterprise grants preserve their approved bounds), alongside explicit expensive-operation minute and period budgets. Plan entitlements are evaluated independently from API key scopes before cache lookup or quota debit; missing capabilities return 403 PLAN_ENTITLEMENT_REQUIRED. Cache hits and conditional 304 responses count toward admitted requests; upstream 5xx failures keep the minute counter consumed while crediting back the monthly/period unit idempotently. Minute/operation exhaustion returns 429 RATE_LIMITED; free monthly exhaustion returns 429 MONTHLY_QUOTA_EXCEEDED; paid period exhaustion returns 429 PERIOD_QUOTA_EXCEEDED; expensive period budget exhaustion returns 429 EXPENSIVE_BUDGET_EXCEEDED, each with Retry-After until reset; unavailable admission returns 503 QUOTA_UNAVAILABLE with Retry-After: 1. Gateway errors use { error: { code, message } }. Unauthenticated public health/spec bypasses and CORS preflights skip quota accounting, while legacy routes require an API key or a trusted first-party credential.`.trim();
      operation.description +=
        " Account closure rejects all account keys, including warm credential caches, with 401 INVALID_API_KEY before quota or response-cache access. Failure to verify credential/account status returns 503 ACCOUNT_STATUS_UNAVAILABLE with Retry-After: 30. Initial dashboard email/terms onboarding does not pause existing API keys, even after a dashboard visit.";
      for (const [status, description] of [
        [
          "401",
          "Invalid/revoked API key, including a key belonging to a closed account (INVALID_API_KEY).",
        ],
        [
          "403",
          "API key scope/restriction denial (SCOPE_DENIED) or plan capability entitlement missing (PLAN_ENTITLEMENT_REQUIRED).",
        ],
        [
          "429",
          "Project minute quota, expensive-operation budget, free-account monthly quota, or paid billing-period quota exhausted at the Worker gateway (RATE_LIMITED, MONTHLY_QUOTA_EXCEEDED, PERIOD_QUOTA_EXCEEDED, or EXPENSIVE_BUDGET_EXCEEDED). Origin rate limits may also return this status.",
        ],
        [
          "503",
          "Worker project quota admission unavailable (QUOTA_UNAVAILABLE), or credential/account status unavailable (ACCOUNT_STATUS_UNAVAILABLE); retry after the indicated delay.",
        ],
      ]) {
        const existing = operation.responses[status];
        if (existing && "$ref" in existing) continue;
        const existingJson = existing?.content?.["application/json"];
        const gatewaySchema = {
          $ref: "#/components/schemas/ProjectQuotaError",
        };
        operation.responses[status] = {
          ...existing,
          description: existing
            ? `${existing.description} ${description}`
            : description,
          content: {
            ...existing?.content,
            "application/json": {
              ...existingJson,
              schema: existingJson?.schema
                ? { anyOf: [existingJson.schema, gatewaySchema] }
                : gatewaySchema,
            },
          },
          headers: {
            ...existing?.headers,
            ...(status !== "401"
              ? {
                  "Retry-After": {
                    description: "Seconds to wait before retrying.",
                    schema: { type: "integer" },
                  },
                }
              : {}),
            ...(status === "429"
              ? {
                  RateLimit: {
                    description:
                      "Remaining shared project allowance and window reset.",
                    schema: { type: "string" },
                  },
                  "RateLimit-Policy": {
                    description:
                      "Project minute and calendar-month quota policies and window lengths in seconds.",
                    schema: { type: "string" },
                  },
                }
              : {}),
          },
        };
      }
    }
  }
  return document;
}
