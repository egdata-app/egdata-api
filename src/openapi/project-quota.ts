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
        `${operation.description ?? ""}\n\nWhen accessed through the Worker gateway with an API key, this operation consumes the project's shared UTC-aligned 60-second quota across all keys, console sessions, and legacy/v1 gateway requests (free: 120/min; pro: 1200/min; enterprise: 6000/min, overridden by approved project RPM), and free projects also consume the account's shared 100,000-request calendar-month allowance (resetting on the 1st of each month at 00:00 UTC). Paid tiers (pro, enterprise) are exempt from the free monthly cap. Cache hits count. Project minute exhaustion returns 429 RATE_LIMITED; free monthly exhaustion returns 429 MONTHLY_QUOTA_EXCEEDED with Retry-After until reset; unavailable admission returns 503 QUOTA_UNAVAILABLE with Retry-After: 1. Gateway errors use { error: { code, message } }. Public unauthenticated bypasses retain their existing behavior.`.trim();
      operation.description +=
        " Account closure rejects all account keys, including warm credential caches, with 401 INVALID_API_KEY before quota or response-cache access. Failure to verify credential/account status returns 503 ACCOUNT_STATUS_UNAVAILABLE with Retry-After: 30. Initial dashboard email/terms onboarding does not pause existing API keys, even after a dashboard visit.";
      for (const [status, description] of [
        [
          "401",
          "Invalid/revoked API key, including a key belonging to a closed account (INVALID_API_KEY).",
        ],
        [
          "429",
          "Project minute quota or free-account monthly quota exhausted at the Worker gateway (RATE_LIMITED or MONTHLY_QUOTA_EXCEEDED). Origin rate limits may also return this status.",
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
