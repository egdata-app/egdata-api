import type { DashboardEnv } from "./types.js";

const maxBytes = 512 * 1024;
const timedOperations = new Set([
  "getHealth",
  "searchOffers",
  "searchFreeGames",
  "searchChangelog",
  "multisearchOffers",
  "multisearchItems",
  "multisearchSellers",
]);
const comparedHeaders = [
  "content-type",
  "cache-control",
  "cdn-cache-control",
  "cloudflare-cdn-cache-control",
  "etag",
  "allow",
  "x-route-template",
  "location",
  "vary",
];

async function digest(
  algorithm: "SHA-1" | "SHA-256",
  bytes: Uint8Array<ArrayBuffer>,
) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest(algorithm, bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

function normalizedTimingJson(
  text: string,
  operation: string,
): string | undefined {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return;
  }
  if (JSON.stringify(payload) !== text) return;
  const duration = (n: unknown) =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (operation === "getHealth") {
    const services = payload?.data?.services;
    for (const name of ["redis", "mongodb"]) {
      const entry = services?.[name];
      if (entry?.status === "ok" && duration(entry.latencyMs))
        entry.latencyMs = 0;
      else if (entry?.status !== "error" || entry.latencyMs !== null) return;
    }
  } else {
    const result = payload?.meta?.result;
    if (!duration(result?.tookMs)) return;
    result.tookMs = 0;
  }
  return JSON.stringify(payload);
}

async function bodyHash(
  res: Response,
  signal: AbortSignal,
  timedOperation: string | undefined,
) {
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      for (;;) {
        const { value, done } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        length += value.byteLength;
        if (length > maxBytes) {
          void reader.cancel().catch(() => {});
          return null;
        }
        chunks.push(value);
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const hash = await digest("SHA-256", bytes);
  const timedStatus =
    res.status === 200 ||
    (timedOperation === "getHealth" && res.status === 503);
  if (!timedOperation || !timedStatus) return { hash };
  const normalized = normalizedTimingJson(
    new TextDecoder().decode(bytes),
    timedOperation,
  );
  if (normalized === undefined) return { hash };
  const etag = res.headers.get("etag");
  const strength = etag?.startsWith("W/") ? "W/" : "";
  if (
    etag !== null &&
    etag !== strength + '"' + (await digest("SHA-1", bytes)) + '"'
  )
    return { hash };
  return {
    hash,
    stable: await digest("SHA-256", new TextEncoder().encode(normalized)),
    validator: etag === null ? null : strength,
  };
}

/** Runs only after staging gateway admission, and only on reads that reach the origin. */
export function compareStagingOrigin(
  env: DashboardEnv,
  ctx: ExecutionContext,
  primary: URL,
  request: Request,
  originHeaders: Headers,
  response: Response,
  operationId: string,
): void {
  if (
    env.RATE_LIMIT_ENVIRONMENT !== "staging" ||
    !env.RUST_SHADOW_ORIGIN ||
    !env.RUST_SHADOW_TOKEN ||
    !["GET", "HEAD"].includes(request.method) ||
    !primary.pathname.startsWith("/v1/")
  )
    return;
  let url: URL;
  try {
    url = new URL(env.RUST_SHADOW_ORIGIN);
  } catch {
    return;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    [
      primary.hostname,
      new URL(request.url).hostname,
      env.API_PROXY_HOST?.toLowerCase(),
    ].includes(url.hostname)
  )
    return;
  url.pathname = primary.pathname;
  url.search = primary.search;
  const headers = new Headers();
  for (const name of [
    "accept",
    "accept-encoding",
    "accept-language",
    "if-none-match",
    "if-modified-since",
    "range",
    "x-egdata-request-id",
    "x-egdata-key-tier",
  ]) {
    const value = originHeaders.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("x-egdata-origin-token", env.RUST_SHADOW_TOKEN);
  if (originHeaders.has("x-egdata-key-id")) {
    headers.set("x-egdata-worker-token", env.RUST_SHADOW_TOKEN);
    headers.set("x-egdata-key-id", "key_staging_mirror");
    if (originHeaders.get("x-egdata-authenticated") === "1")
      headers.set("x-egdata-authenticated", "1");
  }
  // Read both branches concurrently. Stop the comparison at the byte budget while
  // the original response continues to its caller, including streamed responses.
  ctx.waitUntil(
    (async () => {
      const signal = AbortSignal.timeout(8000);
      const timedOperation =
        request.method === "GET" && timedOperations.has(operationId)
          ? operationId
          : undefined;
      const primaryBody = bodyHash(response.clone(), signal, timedOperation);
      const shadow = fetch(url.toString(), {
        method: request.method,
        headers,
        redirect: "manual",
        signal,
      }).then(async (r) => ({
        response: r,
        hash: await bodyHash(r, signal, timedOperation),
      }));
      const [hash, result] = await Promise.all([primaryBody, shadow]);
      const sameExceptTimings =
        hash?.stable !== undefined && hash.stable === result.hash?.stable;
      const headersChanged = comparedHeaders.filter(
        (key) =>
          response.headers.get(key) !== result.response.headers.get(key) &&
          !(
            key === "etag" &&
            sameExceptTimings &&
            hash?.validator === result.hash?.validator
          ),
      );
      const body =
        hash === null || result.hash === null
          ? "over-limit"
          : hash.hash === result.hash.hash
            ? "match"
            : sameExceptTimings
              ? "timing-only"
              : "different";
      console.info("rust-origin-comparison", {
        operationId,
        status: response.status,
        shadowStatus: result.response.status,
        headersChanged,
        body,
      });
    })().catch(() =>
      console.warn("rust-origin-comparison", {
        operationId,
        result: "unavailable",
      }),
    ),
  );
}
