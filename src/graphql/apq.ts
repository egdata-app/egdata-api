import type { HTTPGraphQLRequest } from "@apollo/server";
import {
  getPersistedQuery,
  hashQuery,
  isValidPersistedQueryHash,
  storePersistedQuery,
} from "./persisted-queries.js";
import { MAX_QUERY_BYTES } from "./validation.js";

const PERSISTED_QUERY_NOT_FOUND = "PERSISTED_QUERY_NOT_FOUND";
const PERSISTED_QUERY_HASH_MISMATCH = "PERSISTED_QUERY_HASH_MISMATCH";
const PERSISTED_QUERY_NOT_SUPPORTED = "PERSISTED_QUERY_NOT_SUPPORTED";

type JsonRecord = Record<string, unknown>;

type PersistedQueryExtension = {
  version?: unknown;
  sha256Hash?: unknown;
};

const isRecord = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const getHeader = (headers: Record<string, string>, name: string) => {
  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key ? headers[key] : undefined;
};

const setHeader = (
  headers: Record<string, string>,
  name: string,
  value: string,
) => {
  const existing = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  if (existing && existing !== name) {
    delete headers[existing];
  }
  headers[name] = value;
};

const jsonResponse = (body: JsonRecord, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });

const apqErrorResponse = (
  message: string,
  code: string,
  status = 200,
): Response =>
  jsonResponse(
    {
      errors: [
        {
          message,
          extensions: {
            code,
          },
        },
      ],
    },
    status,
  );

const parseExtensions = (raw: string | null | undefined) => {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const getPersistedQueryExtension = (
  body: unknown,
  search: string,
): PersistedQueryExtension | undefined => {
  if (isRecord(body) && isRecord(body.extensions)) {
    const persistedQuery = body.extensions.persistedQuery;
    if (isRecord(persistedQuery)) {
      return persistedQuery;
    }
  }

  const params = new URLSearchParams(search);
  const extensions = parseExtensions(params.get("extensions"));
  if (extensions && isRecord(extensions.persistedQuery)) {
    return extensions.persistedQuery;
  }

  return undefined;
};

const getRequestQuery = (body: unknown, search: string) => {
  if (isRecord(body) && typeof body.query === "string") {
    return body.query;
  }
  return new URLSearchParams(search).get("query") ?? undefined;
};

const withQuery = (
  request: HTTPGraphQLRequest,
  query: string,
): HTTPGraphQLRequest => {
  if (request.method === "GET") {
    const params = new URLSearchParams(request.search);
    params.set("query", query);
    return {
      ...request,
      search: `?${params.toString()}`,
    };
  }

  return {
    ...request,
    body: isRecord(request.body) ? { ...request.body, query } : { query },
  };
};

/**
 * Implements the Apollo Automatic Persisted Queries protocol at the HTTP
 * boundary, before Apollo parses the request. This keeps GET URLs short and
 * stable (a 64-character hash plus variables) so a CDN can cache them.
 *
 * @see https://www.apollographql.com/docs/apollo-server/performance/apq/
 */
export const applyPersistedQuery = async (
  request: HTTPGraphQLRequest,
): Promise<{ request: HTTPGraphQLRequest; response?: Response }> => {
  const extension = getPersistedQueryExtension(request.body, request.search);
  if (!extension) {
    return { request };
  }

  if (extension.version !== 1) {
    return {
      request,
      response: apqErrorResponse(
        "Unsupported persisted query version.",
        PERSISTED_QUERY_NOT_SUPPORTED,
      ),
    };
  }

  const hash = extension.sha256Hash;
  if (!isValidPersistedQueryHash(hash)) {
    return {
      request,
      response: apqErrorResponse(
        "Invalid persisted query sha256Hash.",
        PERSISTED_QUERY_HASH_MISMATCH,
        400,
      ),
    };
  }

  const normalizedHash = hash.toLowerCase();
  const query = getRequestQuery(request.body, request.search);

  if (query) {
    if (hashQuery(query) !== normalizedHash) {
      return {
        request,
        response: apqErrorResponse(
          "provided sha does not match query",
          PERSISTED_QUERY_HASH_MISMATCH,
          400,
        ),
      };
    }

    if (Buffer.byteLength(query, "utf8") <= MAX_QUERY_BYTES) {
      await storePersistedQuery(normalizedHash, query);
    }

    return { request };
  }

  const stored = await getPersistedQuery(normalizedHash);
  if (!stored) {
    return {
      request,
      response: apqErrorResponse(
        "PersistedQueryNotFound",
        PERSISTED_QUERY_NOT_FOUND,
      ),
    };
  }

  return { request: withQuery(request, stored) };
};

/**
 * Apollo's cache-control plugin emits `max-age=N, public` for cacheable
 * responses. GraphQL GET responses additionally get shared-cache hints and a
 * CDN-specific TTL so Cloudflare can cache the hash URL.
 */
export const applyGraphqlCdnCacheHeaders = (
  headers: Record<string, string>,
  method: string,
) => {
  if (method.toUpperCase() !== "GET") {
    // CDNs do not cache POST, but make the intent explicit and avoid browser
    // or intermediary caching of query-dependent responses.
    const cacheControl = getHeader(headers, "cache-control");
    if (cacheControl && /\bpublic\b/i.test(cacheControl)) {
      setHeader(headers, "cache-control", "no-store");
    }
    return;
  }

  const cacheControl = getHeader(headers, "cache-control");
  const match = /^max-age=(\d+),\s*public$/i.exec(cacheControl ?? "");
  if (!match) {
    return;
  }

  const maxAge = Number(match[1]);
  const staleWhileRevalidate = Math.max(60, Math.min(maxAge * 10, 3_600));

  setHeader(
    headers,
    "cache-control",
    `public, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=${staleWhileRevalidate}`,
  );
  setHeader(
    headers,
    "cdn-cache-control",
    `public, max-age=${maxAge}, stale-while-revalidate=${staleWhileRevalidate}`,
  );

  const vary = getHeader(headers, "vary");
  setHeader(
    headers,
    "vary",
    vary
      ? /accept-encoding/i.test(vary)
        ? vary
        : `${vary}, Accept-Encoding`
      : "Accept-Encoding",
  );
};
