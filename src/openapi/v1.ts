import type { OpenAPIV3 } from "openapi-types";
import { v1Operations } from "../v1/operations/index.js";
import type { V1OperationMetadata } from "../v1/route-types.js";

const ERROR_STATUSES = [
  "400",
  "401",
  "403",
  "404",
  "405",
  "409",
  "413",
  "415",
  "429",
  "502",
  "503",
  "504",
];

const problemSchema: OpenAPIV3.SchemaObject = {
  type: "object",
  required: ["type", "title", "status", "detail", "code", "requestId"],
  properties: {
    type: { type: "string", format: "uri" },
    title: { type: "string" },
    status: { type: "integer" },
    detail: { type: "string" },
    instance: { type: "string" },
    code: { type: "string" },
    requestId: { type: "string" },
    errors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          pointer: { type: "string" },
          parameter: { type: "string" },
          code: { type: "string" },
          message: { type: "string" },
        },
      },
    },
  },
};

const paginationSchema: OpenAPIV3.SchemaObject = {
  type: "object",
  required: ["limit", "hasMore", "nextCursor"],
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 100 },
    hasMore: { type: "boolean" },
    nextCursor: { type: "string", nullable: true },
  },
};

const resourceSchemas: Record<string, OpenAPIV3.SchemaObject> = {
  offer: {
    type: "object",
    additionalProperties: true,
    required: ["id", "namespace", "title", "offerType"],
    properties: {
      _id: { type: "string", nullable: true },
      id: { type: "string" },
      namespace: { type: "string", nullable: true },
      title: { type: "string", nullable: true },
      description: { type: "string", nullable: true },
      longDescription: { type: "string", nullable: true },
      offerType: { type: "string", nullable: true },
      effectiveDate: { type: "string", format: "date-time", nullable: true },
      creationDate: { type: "string", format: "date-time", nullable: true },
      lastModifiedDate: {
        type: "string",
        format: "date-time",
        nullable: true,
      },
      releaseDate: { type: "string", format: "date-time", nullable: true },
      keyImages: { type: "array", items: { type: "object" } },
      seller: { type: "object", nullable: true },
      tags: { type: "array", items: { type: "object" } },
      items: { type: "array", items: { type: "object" } },
      price: { $ref: "#/components/schemas/Price" },
    },
  },
  item: {
    type: "object",
    additionalProperties: true,
    required: ["id"],
    properties: {
      _id: { type: "string", nullable: true },
      id: { type: "string" },
      namespace: { type: "string", nullable: true },
      title: { type: "string", nullable: true },
      description: { type: "string", nullable: true },
      customAttributes: { type: "object", nullable: true },
    },
  },
  seller: {
    type: "object",
    additionalProperties: true,
    properties: {
      id: { type: "string", nullable: true },
      name: { type: "string", nullable: true },
    },
  },
};

const priceSchema: OpenAPIV3.SchemaObject = {
  type: "object",
  additionalProperties: true,
  nullable: true,
  properties: {
    offerId: { type: "string", nullable: true },
    region: { type: "string", nullable: true },
    currencyCode: { type: "string", nullable: true },
    precision: { type: "integer", minimum: 0, maximum: 3 },
    originalPrice: { type: "integer", nullable: true },
    discountPrice: { type: "integer", nullable: true },
    discount: { type: "integer", nullable: true },
    updatedAt: { type: "string", format: "date-time", nullable: true },
  },
};

function schemaFor(
  operation: V1OperationMetadata,
): OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject {
  const id = operation.operationId.toLowerCase();
  let item: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject | undefined;
  if (
    id.includes("offer") ||
    (id.includes("search") && !id.includes("changelog"))
  ) {
    item = { $ref: "#/components/schemas/Offer" };
  } else if (id.includes("item")) {
    item = { $ref: "#/components/schemas/Item" };
  } else if (id.includes("seller")) {
    item = { $ref: "#/components/schemas/Seller" };
  }

  if (operation.paginated) {
    return { type: "array", items: item ?? { type: "object" } };
  }
  if (item) return item;
  return { type: "object", additionalProperties: true };
}

function successResponse(
  operation: V1OperationMetadata,
): OpenAPIV3.ResponseObject {
  if (operation.responseKind === "redirect") {
    return {
      description: "Bodyless redirect",
      headers: {
        Location: {
          description: "Canonical GET or native image URL.",
          schema: { type: "string", format: "uri-reference" },
        },
      },
    };
  }
  if (operation.responseKind === "xml") {
    return {
      description: "Native XML document",
      content: { "application/xml": { schema: { type: "string" } } },
    };
  }
  if (operation.responseKind === "text") {
    return {
      description: "Native plain-text document",
      content: { "text/plain": { schema: { type: "string" } } },
    };
  }
  if (operation.responseKind === "ndjson") {
    return {
      description: "Streamed NDJSON, one object per requested root.",
      content: {
        "application/x-ndjson": { schema: { type: "string" } },
      },
    };
  }
  if (operation.responseKind === "image") {
    return {
      description: "Native image",
      content: {
        "image/png": { schema: { type: "string", format: "binary" } },
        "image/webp": { schema: { type: "string", format: "binary" } },
      },
    };
  }
  const meta: OpenAPIV3.SchemaObject = {
    type: "object",
    additionalProperties: true,
    properties: {
      ...(operation.paginated
        ? { pagination: { $ref: "#/components/schemas/Pagination" } }
        : {}),
      ...(operation.operationId === "searchOffers"
        ? {
            facets: { type: "object", additionalProperties: true },
            result: { type: "object", additionalProperties: true },
          }
        : {}),
    },
  };
  return {
    description: operation.responseDescription ?? "Successful response",
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["data", "meta"],
          properties: {
            data: schemaFor(operation),
            meta,
          },
        },
      },
    },
  };
}

function operationObject(
  operation: V1OperationMetadata,
): OpenAPIV3.OperationObject {
  const parameters: OpenAPIV3.ParameterObject[] = (
    operation.parameters ?? []
  ).map((parameter) => ({
    name: parameter.name,
    in: parameter.in,
    required: parameter.required ?? parameter.in === "path",
    description: parameter.description,
    schema: parameter.schema,
  }));

  return {
    operationId: operation.operationId,
    summary: operation.summary,
    description: [
      operation.description,
      ...(operation.auth === "key"
        ? [
            "Account closure rejects all account keys, including warm credential caches, with 401 INVALID_API_KEY before quota or cache access. Failure to verify credential/account status returns uncacheable 503 ACCOUNT_STATUS_UNAVAILABLE with Retry-After: 30. Initial email/terms onboarding gates the dashboard and existing/new console sessions (403 AGREEMENT_REQUIRED or EMAIL_VERIFICATION_REQUIRED), but existing API keys keep working even after a dashboard visit. Privacy notices do not require acceptance.",
          ]
        : []),
    ]
      .filter(Boolean)
      .join("\n\n"),
    tags: operation.tags,
    ...(operation.auth === "key"
      ? { security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }] }
      : { security: [] }),
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(operation.requestBody
      ? {
          requestBody: {
            required: operation.requestBody.required,
            description: operation.requestBody.description,
            content: {
              "application/json": {
                schema: operation.requestBody.schema,
              },
            },
          },
        }
      : {}),
    responses: {
      [operation.responseKind === "redirect" ? "303" : "200"]:
        successResponse(operation),
      ...(ERROR_STATUSES.includes("400")
        ? {
            "400": { $ref: "#/components/responses/Problem" },
            "401": { $ref: "#/components/responses/Problem" },
            "403": { $ref: "#/components/responses/Problem" },
            "404": { $ref: "#/components/responses/Problem" },
            "405": { $ref: "#/components/responses/Problem" },
            "409": { $ref: "#/components/responses/Problem" },
            "413": { $ref: "#/components/responses/Problem" },
            "415": { $ref: "#/components/responses/Problem" },
            "429": { $ref: "#/components/responses/Problem" },
            "502": { $ref: "#/components/responses/Problem" },
            "503": { $ref: "#/components/responses/Problem" },
            "504": { $ref: "#/components/responses/Problem" },
          }
        : {}),
    },
    "x-egdata-visibility": "public",
    "x-egdata-scope": operation.scope,
    ...(operation.auth === "key" ? { "x-egdata-quota-scope": "project" } : {}),
    ...(operation.expensivePolicy
      ? { "x-egdata-quota-policy": operation.expensivePolicy }
      : {}),
    ...(operation.legacy ? { "x-egdata-legacy-paths": operation.legacy } : {}),
    ...(operation.paginated ? { "x-egdata-paginated": true } : {}),
  } as OpenAPIV3.OperationObject;
}

export function buildV1OpenApiDocument(): OpenAPIV3.Document {
  const paths: OpenAPIV3.PathsObject = {};
  for (const operation of v1Operations) {
    const pathItem = (paths[operation.path] ?? {}) as OpenAPIV3.PathItemObject;
    pathItem[operation.method.toLowerCase() as "get" | "post"] =
      operationObject(operation);
    paths[operation.path] = pathItem;
  }

  return {
    openapi: "3.0.3",
    info: {
      title: "egdata Versioned API",
      version: "1.0.0",
      description: [
        "Version 1 of the egdata public read-only REST API.",
        "The updated origin removes Aikido runtime instrumentation, telemetry and Aikido-specific blocking. Existing authentication, origin access controls and gateway quotas still apply. Custom legacy anti-abuse challenges do not apply to v1; deployment is separate from contract publication.",
        "Successful JSON responses use `{ data, meta }`. Paginated collections use opaque forward cursors with `meta.pagination`. Errors use RFC 9457 Problem Details (`application/problem+json`) with a stable `code` and `requestId`.",
        "Applications authenticate data operations with an API key through the Cloudflare Worker gateway. `/v1/health`, `/v1/open-api.json`, and CORS preflights are unauthenticated.",
        "Each project shares one exact quota across all its API keys, console sessions, and authenticated legacy/v1 gateway requests. UTC-aligned 60-second allowances are free 120, pro 1200, and enterprise 6000, unless overridden by the approved project custom RPM. Free accounts also share one 100,000-request calendar-month allowance across all free projects, API keys, and console sessions, resetting on the first day of each UTC month at 00:00 UTC; paid projects (pro, enterprise) are exempt from the free monthly allowance, while a custom RPM increase on a free project does not remove the monthly cap. Expensive v1 operation policies are shared per project. Key creation, rotation, deletion, or project recreation never resets counters. Minute or operation exhaustion returns 429 RATE_LIMITED and free monthly exhaustion returns 429 MONTHLY_QUOTA_EXCEEDED, each with RateLimit, RateLimit-Policy, X-RateLimit-Policy, and Retry-After; unavailable admission returns 503 QUOTA_UNAVAILABLE. Accounts include one project by default, with additional projects approved manually and a 24-hour account-level creation cooldown. Existing projects and keys remain usable.",
        "The signed-in dashboard API console can alternatively use a project-scoped session lasting at most 10 minutes. Console credentials require that dashboard login and are not portable API keys. Console requests use the same operation permissions and quota admission and count toward project usage.",
        "Administrators can review project limit requests in the developer dashboard. Approved RPM applies to existing and future project API keys and the API console; existing key caches can take up to five minutes to refresh. Custom requests use the enterprise tier with the approved RPM override. Expensive-operation caps remain unchanged and approval does not reset quota counters.",
        "Breaking changes require a new major API version. Additive fields and operations may be introduced within v1.",
        "Shared HTTP caching is disabled on outgoing authenticated v1 data responses. Every authenticated data request, including conditional requests, passes API key or dashboard-session authentication, permission checks, and exact quota admission before internal Worker/origin caching or private ETag revalidation. `/v1/health` and `/v1/open-api.json` are unauthenticated, skip quota admission and the Worker edge cache, and successful responses use `Cache-Control: public, max-age=60` with `CDN-Cache-Control: no-store`. CORS preflights also skip authentication and quota admission.",
      ].join("\n\n"),
      contact: { name: "egdata.app", url: "https://egdata.app" },
    },
    servers: [
      {
        url: "https://devs.egdata.app/proxy",
        description: "Staging gateway; operation paths include /v1.",
      },
      {
        url: "https://api.egdata.app",
        description: "Production host; operation paths include /v1.",
      },
    ],
    tags: [
      { name: "System", description: "Health and versioned metadata." },
      { name: "Regions", description: "Countries and Epic pricing regions." },
      { name: "Catalog", description: "Cross-catalog discovery endpoints." },
      {
        name: "Offers",
        description: "Offer listing, events, and bulk checks.",
      },
      {
        name: "Offer Details",
        description: "Offer subresources and relationships.",
      },
      {
        name: "Prices",
        description: "Current, historical, and regional prices.",
      },
      { name: "Offer Reviews", description: "Read-only public offer reviews." },
      { name: "Search", description: "Faceted search and changelog search." },
      { name: "Items", description: "Epic catalog items." },
      { name: "Sellers", description: "Seller metadata and statistics." },
      { name: "Sandboxes", description: "Namespaces and sandbox resources." },
      {
        name: "Builds",
        description: "Build manifests, files, and comparisons.",
      },
      { name: "Free Games", description: "Current and historical giveaways." },
      { name: "Promotions", description: "Promotional events." },
      { name: "Collections", description: "Ranked storefront collections." },
      { name: "Profiles", description: "Public player profiles." },
      { name: "Stats", description: "Aggregate catalog statistics." },
      { name: "Franchises", description: "Franchise metadata and offers." },
      { name: "Game Awards", description: "The Game Awards modules." },
      { name: "Native", description: "Sitemaps and native image responses." },
    ],
    paths,
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "X-API-Key",
          description:
            "Version 1 API key from the egdata Developer Portal. `Authorization: Bearer <key>` is also accepted; sending two different credentials is rejected.",
        },
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Version 1 API key passed as a Bearer credential.",
        },
      },
      schemas: {
        Problem: problemSchema,
        Pagination: paginationSchema,
        Price: priceSchema,
        Offer: resourceSchemas.offer,
        Item: resourceSchemas.item,
        Seller: resourceSchemas.seller,
      },
      responses: {
        Problem: {
          description: "RFC 9457 Problem Details",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/Problem" },
            },
          },
        },
      },
    },
  };
}

export { v1Operations };
