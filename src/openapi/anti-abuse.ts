import type { OpenAPIV3 } from "openapi-types";
import { isProtectedPath } from "../middleware/anti-abuse.js";
import type { EgdataOperation } from "./types.js";

const reference = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject) => ({
  "application/json": { schema },
});

export const challengeOperation: EgdataOperation = {
  operationId: "createAbuseChallenge",
  tags: ["System"],
  "x-egdata-visibility": "public",
  summary: "Initialize or solve a proof-of-work session challenge",
  description:
    "Send {} to receive a signed challenge. Solve SHA-256(challenge + ':' + nonce) with the returned leading-zero bit difficulty, then POST {challenge, nonce} to receive a ten-minute session. Invalid/expired proofs return a fresh challenge with HTTP 200. Enabled in observe/enforce modes. No account login is required.",
  requestBody: {
    required: true,
    content: json({
      oneOf: [
        { type: "object", additionalProperties: false, maxProperties: 0 },
        {
          type: "object",
          required: ["challenge", "nonce"],
          properties: {
            challenge: { type: "string", maxLength: 2048 },
            nonce: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,64}$" },
          },
        },
      ],
    }),
  },
  responses: {
    200: {
      description:
        "Signed PoW challenge or session token. Always no-store. A session also sets the Secure, HttpOnly, SameSite=Lax __Host-egdata-session cookie.",
      headers: { "Set-Cookie": { schema: { type: "string" } } },
      content: json({
        oneOf: [reference("PowChallenge"), reference("PowSession")],
      }),
    },
    400: {
      description:
        "Malformed JSON, invalid field types, or body larger than 4096 bytes.",
      content: json({
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: {
              code: { type: "string", enum: ["INVALID_CHALLENGE"] },
            },
          },
        },
      }),
    },
    503: { description: "Anti-abuse is disabled (ANTI_ABUSE_DISABLED)." },
  },
};

/** Keep conditional session requirements consistent with the runtime gate. */
export function withAntiAbuseContract(
  document: OpenAPIV3.Document,
): OpenAPIV3.Document {
  const result = structuredClone(document);
  result.components ??= {};
  result.components.securitySchemes = {
    ...result.components.securitySchemes,
    AbuseSessionHeader: {
      type: "apiKey",
      in: "header",
      name: "x-egdata-session",
      description:
        "PoW session required when anti-abuse enforcement is enabled; not account authentication.",
    },
    AbuseSessionCookie: {
      type: "apiKey",
      in: "cookie",
      name: "__Host-egdata-session",
    },
  };
  result.components.schemas = {
    ...result.components.schemas,
    PowChallenge: {
      type: "object",
      required: ["challenge", "difficulty", "expiresAt", "algorithm"],
      properties: {
        challenge: { type: "string" },
        difficulty: { type: "integer", enum: [16, 20] },
        expiresAt: {
          type: "integer",
          format: "int64",
          description: "Unix milliseconds; challenge expires after 60 seconds.",
        },
        algorithm: { type: "string", enum: ["SHA-256"] },
      },
    },
    PowSession: {
      type: "object",
      required: ["token", "expiresAt"],
      properties: {
        token: { type: "string" },
        expiresAt: {
          type: "integer",
          format: "int64",
          description:
            "Unix milliseconds; ten minutes from challenge issuance. Suspicious sessions can expire after 30 seconds.",
        },
      },
    },
    SessionChallengeRequired: {
      type: "object",
      required: ["error"],
      properties: {
        error: {
          type: "object",
          required: ["code", "challengeUrl"],
          properties: {
            code: { type: "string", enum: ["SESSION_CHALLENGE_REQUIRED"] },
            challengeUrl: { type: "string", enum: ["/auth/challenge"] },
          },
        },
      },
    },
    AbuseTruncatedResponse: {
      type: "object",
      required: ["elements", "page", "limit", "total"],
      properties: {
        elements: { type: "array", maxItems: 0, items: { type: "object" } },
        page: { type: "integer" },
        limit: { type: "integer", enum: [0] },
        total: { type: "integer", enum: [0] },
      },
    },
    SyntheticItem: {
      type: "object",
      required: ["id", "title", "namespace", "synthetic"],
      properties: {
        id: { type: "string", pattern: "^egcanary_[a-f0-9]{32}$" },
        title: { type: "string", enum: [""] },
        namespace: { type: "string", enum: ["egdata-canary"] },
        synthetic: { type: "boolean", enum: [true] },
      },
    },
  };
  const itemList = result.components.schemas.ItemListResponse;
  if (
    itemList &&
    !("$ref" in itemList) &&
    itemList.properties?.elements &&
    !("$ref" in itemList.properties.elements)
  ) {
    const elements = itemList.properties.elements;
    if (elements.type === "array")
      elements.items = { anyOf: [elements.items, reference("SyntheticItem")] };
  }
  for (const [path, item] of Object.entries(result.paths)) {
    if (!item) continue;
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
      const pagination = operation.parameters?.some((parameter) =>
        "$ref" in parameter
          ? /\/(?:page|limit|offset|cursor)$/.test(parameter.$ref)
          : parameter.in === "query" &&
            ["page", "limit", "offset", "cursor"].includes(parameter.name),
      );
      if (!isProtectedPath(path) && !pagination) continue;
      operation.description =
        `${operation.description ?? ""}\n\nWhen ANTI_ABUSE_MODE=enforce, a PoW session is required${!isProtectedPath(path) ? " when pagination query parameters are present" : ""}. SESSION_CHALLENGE_REQUIRED and truncated mitigation responses use HTTP 200. Protected responses are private/no-store. Scores above 0.8 receive a 3–5 second delay and a truncated envelope; 0.5–0.8 sessions expire early and require harder PoW. Legacy IP rate limits are skipped on these requests.`.trim();
      operation.security = (operation.security ?? [{}]).flatMap((existing) => [
        { ...existing, AbuseSessionHeader: [] },
        { ...existing, AbuseSessionCookie: [] },
      ]);
      const response = operation.responses["200"];
      if (response && !("$ref" in response)) {
        const original = response.content?.["application/json"]?.schema;
        response.content = {
          ...response.content,
          ...json({
            anyOf: [
              ...(original ? [original] : []),
              reference("SessionChallengeRequired"),
              reference("AbuseTruncatedResponse"),
            ],
          }),
        };
      }
    }
  }
  return result;
}
