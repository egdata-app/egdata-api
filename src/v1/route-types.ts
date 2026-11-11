export type V1Scope =
  | "catalog:read"
  | "offers:read"
  | "items:read"
  | "search:read"
  | "profiles:read"
  | "stats:read"
  | "builds:read";

export type V1ExpensivePolicy = "offers-list" | "search" | "heavy" | "bulk";

export type V1ParameterLocation = "path" | "query" | "header";

export type V1Parameter = {
  name: string;
  in: V1ParameterLocation;
  required?: boolean;
  description: string;
  schema: Record<string, unknown>;
};

export type V1OperationMetadata = {
  /** Globally unique, stable operation identifier. */
  operationId: string;
  method: "GET" | "POST";
  /** Full public path including /v1. */
  path: string;
  summary: string;
  description?: string;
  tags: string[];
  /** Permission scope evaluated by the Worker before quota admission. */
  scope: V1Scope;
  auth: "public" | "key";
  /** JSON operations are enveloped; native operations preserve their bytes. */
  responseKind?: "json" | "image" | "xml" | "text" | "ndjson" | "redirect";
  paginated?: boolean;
  /** Existing expensive-operation quota retained from the legacy API. */
  expensivePolicy?: V1ExpensivePolicy;
  parameters?: V1Parameter[];
  requestBody?: {
    required: boolean;
    description: string;
    schema: Record<string, unknown>;
  };
  responseDescription?: string;
  /** Legacy routes this operation replaces. Patterns use `{param}` notation. */
  legacy?: string[];
};

export const defineOperations = <T extends readonly V1OperationMetadata[]>(
  operations: T,
): T => operations;

export const pathParameter = (
  name: string,
  description: string,
): V1Parameter => ({
  name,
  in: "path",
  required: true,
  description,
  schema: { type: "string" },
});

export const queryParameter = (
  name: string,
  description: string,
  schema: Record<string, unknown> = { type: "string" },
  required = false,
): V1Parameter => ({
  name,
  in: "query",
  required,
  description,
  schema,
});

export const cursorParameter = (): V1Parameter => ({
  name: "cursor",
  in: "query",
  description:
    "Opaque forward cursor returned as `meta.pagination.nextCursor`. Cursors expire after 24 hours and are bound to the operation, filters, ordering, country, locale, and page size.",
  schema: { type: "string" },
});

export const limitParameter = (maximum = 100): V1Parameter => ({
  name: "limit",
  in: "query",
  description: `Page size. Defaults to 20; maximum ${maximum}.`,
  schema: { type: "integer", minimum: 1, maximum, default: 20 },
});

export const countryParameter = (): V1Parameter => ({
  name: "country",
  in: "query",
  description:
    "ISO 3166-1 alpha-2 pricing country. Defaults to US; cookies are never used.",
  schema: { type: "string", pattern: "^[A-Z]{2}$", default: "US" },
});

export const localeParameter = (): V1Parameter => ({
  name: "locale",
  in: "query",
  description:
    "BCP 47 locale for localized text. Defaults to en-US; cookies are never used.",
  schema: { type: "string", default: "en-US" },
});

export const problemResponse = {
  description: "RFC 9457 Problem Details",
  content: {
    "application/problem+json": {
      schema: { $ref: "#/components/schemas/Problem" },
    },
  },
} as const;
