import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { badRequest, serviceUnavailable } from "./errors.js";

const CURSOR_VERSION = 1;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type CursorSortValue = string | number | null;
export type CursorSortTuple = CursorSortValue[];

export type CursorBinding = {
  operation: string;
  filters?: Record<string, unknown>;
  ordering: string;
  country: string;
  locale: string;
  limit: number;
};

type CursorPayload = CursorBinding & {
  v: typeof CURSOR_VERSION;
  iat: number;
  last: CursorSortTuple;
  filterHash: string;
};

const DEV_SECRET = "egdata-v1-local-cursor-secret-do-not-use-in-production";

function cursorSecret(): string | null {
  const configured = process.env.V1_CURSOR_SECRET?.trim();
  if (configured && configured.length >= 32) return configured;
  if (process.env.NODE_ENV === "test") return DEV_SECRET;
  const explicitDevSecret = process.env.V1_CURSOR_DEV_SECRET?.trim();
  if (explicitDevSecret && explicitDevSecret.length >= 32) {
    return explicitDevSecret;
  }
  return null;
}

function hmac(payload: string): Buffer {
  const secret = cursorSecret();
  if (!secret) {
    throw serviceUnavailable(
      "CURSOR_NOT_CONFIGURED",
      "Cursor pagination is not configured on this API origin.",
    );
  }
  return createHmac("sha256", secret).update(payload).digest();
}

function canonicalize(value: unknown, depth = 0): unknown {
  if (depth > 20 || value === undefined) return null;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry, depth + 1));
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key], depth + 1)]),
  );
}

function normalizeFilters(
  filters: Record<string, unknown> | undefined,
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(filters ?? {})))
    .digest("hex");
}

function encodeBase64Url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value: string): Buffer | null {
  try {
    return Buffer.from(value, "base64url");
  } catch {
    return null;
  }
}

export function encodeCursor(
  binding: CursorBinding,
  last: CursorSortTuple,
): string {
  const payload: CursorPayload = {
    v: CURSOR_VERSION,
    operation: binding.operation,
    filters: binding.filters,
    filterHash: normalizeFilters(binding.filters),
    ordering: binding.ordering,
    country: binding.country,
    locale: binding.locale,
    limit: binding.limit,
    iat: Date.now(),
    last,
  };
  const body = encodeBase64Url(JSON.stringify(payload));
  return `${body}.${encodeBase64Url(hmac(body))}`;
}

export function decodeCursor(
  raw: string,
  binding: CursorBinding,
): CursorSortTuple {
  const [body, signature, extra] = raw.trim().split(".");
  if (!body || !signature || extra !== undefined) {
    throw badRequest(
      "INVALID_CURSOR",
      "The cursor is malformed. Use the `nextCursor` value from a previous response.",
    );
  }

  const expected = hmac(body);
  const supplied = decodeBase64Url(signature);
  if (!supplied || supplied.length !== expected.length) {
    throw badRequest(
      "INVALID_CURSOR",
      "The cursor signature is invalid. Use the `nextCursor` value from a previous response.",
    );
  }
  if (!timingSafeEqual(expected, supplied)) {
    throw badRequest(
      "INVALID_CURSOR",
      "The cursor signature is invalid. Use the `nextCursor` value from a previous response.",
    );
  }

  const decoded = decodeBase64Url(body);
  if (!decoded) {
    throw badRequest(
      "INVALID_CURSOR",
      "The cursor is malformed. Use the `nextCursor` value from a previous response.",
    );
  }

  let payload: CursorPayload;
  try {
    payload = JSON.parse(decoded.toString("utf8")) as CursorPayload;
  } catch {
    throw badRequest(
      "INVALID_CURSOR",
      "The cursor is malformed. Use the `nextCursor` value from a previous response.",
    );
  }

  if (
    payload.v !== CURSOR_VERSION ||
    typeof payload.iat !== "number" ||
    !Array.isArray(payload.last)
  ) {
    throw badRequest(
      "INVALID_CURSOR",
      "The cursor is not supported by this API version.",
    );
  }

  if (Date.now() - payload.iat > MAX_AGE_MS) {
    throw badRequest(
      "EXPIRED_CURSOR",
      "The cursor expired after 24 hours. Restart pagination from the first page.",
    );
  }

  if (Date.now() < payload.iat - 5 * 60 * 1000) {
    throw badRequest("INVALID_CURSOR", "The cursor issue time is invalid.");
  }

  const mismatch =
    payload.operation !== binding.operation ||
    payload.ordering !== binding.ordering ||
    payload.country !== binding.country ||
    payload.locale !== binding.locale ||
    payload.limit !== binding.limit ||
    payload.filterHash !== normalizeFilters(binding.filters);

  if (mismatch) {
    throw badRequest(
      "CURSOR_MISMATCH",
      "The cursor was issued for a different operation, filter set, ordering, country, locale, or page size. Restart pagination with the new parameters.",
    );
  }

  return payload.last;
}
