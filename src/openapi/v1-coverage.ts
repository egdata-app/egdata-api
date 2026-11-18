import policy from "../../openapi/route-policy.json" with { type: "json" };
export type V1Exclusion = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "*";
  path: string;
  reason: string;
};

/**
 * Legacy routes that intentionally have no v1 operation. Everything not
 * listed here and not documented in the legacy contract must be mapped to a
 * registered v1 operation; scripts/check-openapi.ts enforces that.
 */
export const v1Exclusions: V1Exclusion[] = policy.v1Exclusions as V1Exclusion[];
