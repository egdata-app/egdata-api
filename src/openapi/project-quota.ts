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
          code: { type: "string", enum: ["RATE_LIMITED", "QUOTA_UNAVAILABLE"] },
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
        `${operation.description ?? ""}\n\nWhen accessed through the Worker gateway with an API key, this operation consumes the project's shared UTC-aligned 60-second quota across all keys, console sessions, and legacy/v1 gateway requests. Free: 120/min; pro: 1200/min; enterprise: 6000/min, overridden by approved project RPM. Cache hits count. Exhaustion returns 429 RATE_LIMITED; unavailable admission returns 503 QUOTA_UNAVAILABLE with Retry-After: 1. Gateway errors use { error: { code, message } }. Public unauthenticated bypasses retain their existing behavior.`.trim();
      for (const [status, description] of [
        [
          "429",
          "Project quota exhausted at the Worker gateway (RATE_LIMITED). Origin rate limits may also return this status.",
        ],
        [
          "503",
          "Worker project quota admission unavailable (QUOTA_UNAVAILABLE); retry after a short delay.",
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
            "Retry-After": {
              description: "Seconds to wait before retrying.",
              schema: { type: "integer" },
            },
            ...(status === "429"
              ? {
                  RateLimit: {
                    description:
                      "Remaining shared project allowance and window reset.",
                    schema: { type: "string" },
                  },
                  "RateLimit-Policy": {
                    description: "Project quota policy and 60-second window.",
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
