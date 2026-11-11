import type { OpenAPIV3 } from "openapi-types";
import {
  canonicalV1Path,
  resolveV1Route,
  PUBLIC_V1_PATHS,
} from "../../worker/v1-routes";

export type ApiDocument = OpenAPIV3.Document;

export type Operation = {
  operationId: string;
  method: string;
  path: string;
  operation: OpenAPIV3.OperationObject;
};

export function operations(document: ApiDocument): Operation[] {
  const result: Operation[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of ["get", "post", "head"] as const) {
      const operation = item?.[method];
      if (operation?.operationId) {
        result.push({
          operationId: operation.operationId,
          method: method.toUpperCase(),
          path,
          operation,
        });
      }
    }
  }
  return result;
}

/** Drop executable server overrides and external references before giving Scalar a document. */
export function safeDocument(input: unknown): ApiDocument {
  if (!input || typeof input !== "object" || !("paths" in input)) {
    throw new Error("Invalid deployed OpenAPI document");
  }
  function clean(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== "object") return value;
    const obj = value as Record<string, unknown>;
    if (typeof obj.$ref === "string" && !obj.$ref.startsWith("#/")) {
      throw new Error("External schema references are disabled");
    }
    return Object.fromEntries(
      Object.entries(obj)
        .filter(
          ([key]) =>
            !["servers", "externalDocs", "callbacks", "webhooks"].includes(key),
        )
        .map(([k, v]) => [k, clean(v)]),
    );
  }
  const doc = clean(input) as ApiDocument;
  doc.servers = [{ url: "/proxy", description: "Same-origin v1 gateway" }];
  doc.paths = Object.fromEntries(
    Object.entries(doc.paths).filter(
      ([path]) => path.startsWith("/v1/") && canonicalV1Path(path) === path,
    ),
  );
  return doc;
}

export function executable(operation: Operation) {
  const registered = resolveV1Route(operation.path, operation.method);
  const publicId =
    operation.path === "/v1/health"
      ? "getHealth"
      : operation.path === "/v1/open-api.json"
        ? "getV1OpenApi"
        : null;
  return (
    (registered?.operationId === operation.operationId &&
      registered.path === operation.path) ||
    (publicId === operation.operationId &&
      ["GET", "HEAD"].includes(operation.method))
  );
}

/** A build snapshot can explain an endpoint, but only the deployed contract enables requests. */
export function operationReference(
  id: string | undefined,
  deployed: ApiDocument | null,
  snapshot: ApiDocument | null,
) {
  const live = deployed
    ? operations(deployed).find((e) => e.operationId === id)
    : undefined;
  const reference =
    live ??
    (snapshot
      ? operations(snapshot).find((e) => e.operationId === id)
      : undefined);
  return { reference, deployed: live, document: live ? deployed : snapshot };
}

export function requestUrl(
  operation: Operation,
  parameters: Record<string, string>,
  query: Record<string, string>,
): string {
  if (!executable(operation)) {
    throw new Error("Operation is not registered in this gateway");
  }
  const path = operation.path.replace(
    /\{([^}]+)\}/g,
    (_match, name: string) => {
      const value = parameters[name];
      if (
        !value ||
        /[\\/\0%?#]/.test(value) ||
        value === "." ||
        value === ".."
      ) {
        throw new Error(`Enter a valid ${name}`);
      }
      return encodeURIComponent(value);
    },
  );
  if (!canonicalV1Path(path)) throw new Error("Invalid operation path");
  const matched = resolveV1Route(decodeURIComponent(path), operation.method);
  if (
    !PUBLIC_V1_PATHS.has(path) &&
    matched?.operationId !== operation.operationId
  ) {
    throw new Error("Path resolves to a different operation");
  }
  const qs = new URLSearchParams(
    Object.entries(query).filter(([, value]) => value !== ""),
  );
  return `/proxy${path}${qs.size ? `?${qs}` : ""}`;
}

export function redactedSnippet(operation: Operation): string {
  return `curl -X ${operation.method} '${location.origin}/proxy${operation.path}' \\\n  -H 'X-API-Key: <YOUR_API_KEY>'`;
}

export type TryResult = {
  status: number;
  duration: number;
  headers: Record<string, string>;
  kind: "json" | "text" | "image" | "binary";
  text?: string;
  blob?: Blob;
  contentType: string;
};

export async function executeOperation(
  operation: Operation,
  key: string,
  parameters: Record<string, string>,
  query: Record<string, string>,
  body: string,
  signal: AbortSignal,
  consoleSession?: { token: string; expiresAt: number },
): Promise<TryResult> {
  if (consoleSession && Date.now() >= consoleSession.expiresAt) {
    throw new Error("Console session expired. Start a new session.");
  }
  if (consoleSession && key)
    throw new Error("Choose a console session or an API key.");
  const url = requestUrl(operation, parameters, query);
  const start = performance.now();
  const response = await fetch(url, {
    method: operation.method,
    credentials: consoleSession ? "same-origin" : "omit",
    redirect: "manual",
    cache: "no-store",
    signal,
    headers: {
      ...(key ? { "X-API-Key": key } : {}),
      ...(consoleSession
        ? { "X-Egdata-Console-Session": consoleSession.token }
        : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body && operation.method !== "GET" && operation.method !== "HEAD"
      ? { body }
      : {}),
  });
  const duration = Math.round(performance.now() - start);
  const headers = Object.fromEntries(
    [...response.headers]
      .filter(
        ([name]) =>
          !/(authorization|api.?key|cookie|console-session)/i.test(name),
      )
      .map(([name, value]) => [
        name,
        (key ? value.replaceAll(key, "[REDACTED]") : value).replaceAll(
          consoleSession?.token ?? "\u0000",
          "[REDACTED]",
        ),
      ]),
  );
  const contentType =
    response.headers.get("content-type") ?? "application/octet-stream";
  const reader = response.body?.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  if (reader) {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("Response exceeds 8 MiB preview limit");
      }
      chunks.push(value);
    }
  }
  const blob = new Blob(chunks, { type: contentType });
  const base = { status: response.status, duration, headers, contentType };
  if (/^image\/(png|webp|jpeg|gif)(;|$)/i.test(contentType)) {
    return { ...base, kind: "image", blob };
  }
  if (/json|xml|^text\//i.test(contentType)) {
    let text = await blob.text();
    if (key) text = text.replaceAll(key, "[REDACTED]");
    if (consoleSession)
      text = text.replaceAll(consoleSession.token, "[REDACTED]");
    const kind = contentType.includes("json") ? "json" : "text";
    if (kind === "json") {
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* Preserve non-JSON error bodies. */
      }
    }
    return { ...base, kind, text };
  }
  return { ...base, kind: "binary", blob };
}
