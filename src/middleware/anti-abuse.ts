import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AbuseEvent, AbuseScorer } from "../services/abuse-scorer.js";
import {
  type PowSessionService,
  SUSPICIOUS_TTL_MS,
} from "../services/pow-session.js";

export const SESSION_COOKIE = "__Host-egdata-session";
export const SESSION_HEADER = "x-egdata-session";
export type AntiAbuseMode = "off" | "observe" | "enforce";

type EdgeSignals = {
  tlsCipher?: string;
  tlsVersion?: string;
  httpProtocol?: string;
  asn?: number;
  botManagement?: { ja3Hash?: string; ja4?: string };
};

type FingerprintOptions = {
  edgeSecret?: string;
  trustBotHeaders?: boolean;
  rawHeaderNames?: string[];
};

const unstableHeaders = new Set([
  "cookie",
  "authorization",
  SESSION_HEADER,
  "content-type",
  "content-length",
  "origin",
  "referer",
  "host",
  "connection",
  "accept-encoding",
  "priority",
  "if-none-match",
  "if-modified-since",
  "cache-control",
  "pragma",
]);

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Header values, IP addresses and UA strings never enter the identity hash. */
export function extractFingerprint(
  request: Request,
  options: FingerprintOptions = {},
) {
  const headers = request.headers;
  const nativeCf = (request as Request & { cf?: EdgeSignals }).cf;
  const forwarded = Boolean(
    options.edgeSecret &&
      safeEqual(headers.get("x-egdata-edge-secret") ?? "", options.edgeSecret),
  );
  const cf: EdgeSignals =
    nativeCf ??
    (forwarded
      ? {
          tlsCipher: headers.get("x-egdata-tls-cipher") ?? undefined,
          tlsVersion: headers.get("x-egdata-tls-version") ?? undefined,
          httpProtocol: headers.get("x-egdata-http-protocol") ?? undefined,
          asn: Number(headers.get("x-egdata-asn")) || undefined,
        }
      : {});
  // An authenticated edge secret proves the request passed our zone, not that
  // every cf-* header originated there. Transform Rules cannot remove these
  // reserved headers. Only opt in after enabling Cloudflare's managed Bot
  // Management header transform, which overwrites them with trusted values.
  const trustBotHeaders = forwarded && options.trustBotHeaders === true;
  const ja4 =
    cf.botManagement?.ja4 ?? (trustBotHeaders ? headers.get("cf-ja4") : null);
  const ja3 =
    cf.botManagement?.ja3Hash ??
    (trustBotHeaders ? headers.get("cf-ja3-hash") : null);
  // Fetch Headers sorts/normalizes names. Only an authenticated edge capture
  // can claim original order; Node rawHeaders describes the edge->origin hop.
  const edgeOrder = forwarded ? headers.get("x-egdata-header-order") : null;
  const headerNames =
    edgeOrder
      ?.slice(0, 4096)
      .split(",")
      .map((name) => name.trim()) ??
    options.rawHeaderNames ??
    Array.from(headers.keys());
  const headerOrder = headerNames
    .filter((name) => {
      const key = name.toLowerCase();
      return (
        !unstableHeaders.has(key) &&
        !/^(?:cf-|x-|forwarded$|traceparent$|tracestate$)/.test(key)
      );
    })
    .map((name) => name.toLowerCase());
  const structural = ["sec-fetch-site", "sec-fetch-mode", "sec-ch-ua"].map(
    (name) => headers.has(name),
  );
  const trustedTransport = Boolean(
    (nativeCf || forwarded) && (ja3 || ja4 || (cf.tlsCipher && cf.tlsVersion)),
  );
  const profile = [
    ja4 || ja3 || "",
    cf.tlsCipher ?? "",
    cf.tlsVersion ?? "",
    cf.httpProtocol ?? "",
    cf.asn ?? "",
    headerOrder,
    structural,
  ];
  const fingerprintHash = createHash("sha256")
    .update(JSON.stringify(profile))
    .digest("hex");
  const mismatches: string[] = [];
  if (
    /Chrome\//.test(headers.get("user-agent") ?? "") &&
    !headers.has("sec-ch-ua")
  )
    mismatches.push("chrome-without-client-hints");
  if (
    /Chrome\//.test(headers.get("user-agent") ?? "") &&
    trustedTransport &&
    cf.httpProtocol === "HTTP/1.1" &&
    /(?:RC4|3DES|DES-CBC|AES128-SHA$|AES256-SHA$)/i.test(cf.tlsCipher ?? "")
  ) {
    mismatches.push("browser-legacy-transport");
  }
  return {
    fingerprintHash,
    trustedTransport,
    headerOrder,
    mismatches,
    riskScore: Math.min(0.3, mismatches.length * 0.15),
  };
}

export function normalizedAbusePath(path: string): string {
  try {
    return decodeURIComponent(path).replace(/\/+$/, "") || "/";
  } catch {
    return path;
  }
}

export function isProtectedPath(
  path: string,
  searchParams = new URLSearchParams(),
): boolean {
  path = normalizedAbusePath(path);
  return (
    /^\/(?:offers|items|sellers|builds|changelist|free-games|collections|franchises|promotions|sandboxes|game-awards|multisearch)(?:\/|$)/.test(
      path,
    ) ||
    path === "/catalog/hydrate" ||
    path === "/graphql" ||
    path === "/search/v2/search" ||
    ["page", "offset", "cursor", "limit"].some((key) => searchParams.has(key))
  );
}

function privateResponse(c: Context) {
  c.header("Cache-Control", "private, no-store");
  c.header("CDN-Cache-Control", "no-store");
  c.header("Cloudflare-CDN-Cache-Control", "no-store");
  c.res.headers.delete("ETag");
}

/** Node-safe, non-blocking delay. Bound concurrent sleepers and cancel on disconnect. */
export function tarpitDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export function createAntiAbuse(options: {
  mode: AntiAbuseMode;
  sessions: PowSessionService;
  scorer: AbuseScorer;
  edgeSecret?: string;
  trustBotHeaders?: boolean;
  canaries?: boolean;
  now?: () => number;
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}) {
  const { sessions, scorer } = options;
  const now = options.now ?? Date.now;
  let sleepers = 0;
  const fingerprint = (c: Context) =>
    extractFingerprint(c.req.raw, {
      edgeSecret: options.edgeSecret,
      trustBotHeaders: options.trustBotHeaders,
      rawHeaderNames: (
        c.env as { incoming?: { rawHeaders?: string[] } } | undefined
      )?.incoming?.rawHeaders?.filter((_, i) => i % 2 === 0),
    });
  const token = (c: Context) =>
    c.req.header(SESSION_HEADER) ?? getCookie(c, SESSION_COOKIE) ?? "";
  const keysFor = (fp: ReturnType<typeof fingerprint>, sessionId?: string) => [
    ...(fp.trustedTransport ? [`fp:${fp.fingerprintHash}`] : []),
    ...(sessionId ? [`session:${sessionId}`] : []),
  ];

  const challenge: MiddlewareHandler = async (c) => {
    privateResponse(c);
    if (options.mode === "off")
      return c.json({ error: { code: "ANTI_ABUSE_DISABLED" } }, 503);
    // Bound streaming input as well as Content-Length; this endpoint is public.
    const reader = c.req.raw.body?.getReader();
    let text = "";
    if (reader) {
      const decoder = new TextDecoder();
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 4096) {
            await reader.cancel();
            return c.json({ error: { code: "INVALID_CHALLENGE" } }, 400);
          }
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } catch {
        return c.json({ error: { code: "INVALID_CHALLENGE" } }, 400);
      }
    }
    let body: { challenge?: string; nonce?: string };
    try {
      body = JSON.parse(text || "{}");
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new Error("object required");
    } catch {
      return c.json({ error: { code: "INVALID_CHALLENGE" } }, 400);
    }
    const fp = fingerprint(c);
    const previous = await sessions.verify(token(c), fp.fingerprintHash);
    const keys = keysFor(fp, previous?.sessionId);
    // A token's issuance score is historical. Current evidence determines
    // difficulty so a client can recover after its behavioral window clears.
    const risk = Math.max(fp.riskScore, scorer.risk(keys));
    if (body.challenge !== undefined || body.nonce !== undefined) {
      if (typeof body.challenge !== "string" || typeof body.nonce !== "string")
        return c.json({ error: { code: "INVALID_CHALLENGE" } }, 400);
      const redeemed = await sessions.redeem(
        body.challenge,
        body.nonce,
        fp.fingerprintHash,
        risk,
      );
      if (redeemed) {
        setCookie(c, SESSION_COOKIE, redeemed.token, {
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
          path: "/",
          maxAge: Math.max(0, Math.floor((redeemed.expiresAt - now()) / 1000)),
        });
        return c.json({ token: redeemed.token, expiresAt: redeemed.expiresAt });
      }
    }
    return c.json(
      await sessions.challenge(fp.fingerprintHash, risk, previous?.sessionId),
    );
  };

  const middleware: MiddlewareHandler = async (c, next) => {
    if (
      options.mode === "off" ||
      c.req.method === "OPTIONS" ||
      c.req.path === "/auth/challenge"
    )
      return next();
    const url = new URL(c.req.url);
    const path = normalizedAbusePath(url.pathname);
    const protectedRoute = isProtectedPath(path, url.searchParams);
    const support =
      /^\/(?:search(?:\/tags|\/v2\/search)?|featured|countries|regions|tags|offers\/genres)$/.test(
        path,
      );
    if (!protectedRoute && !support) return next();
    const fp = fingerprint(c);
    const session = await sessions.verify(token(c), fp.fingerprintHash);
    const keys = keysFor(fp, session?.sessionId);
    const requestedCanaries =
      `${path} ${Array.from(url.searchParams.values()).join(" ")}`.match(
        /egcanary_[a-f0-9]{32}/g,
      );
    const event: AbuseEvent = {
      at: now(),
      deep: protectedRoute && !support,
      support,
      route: path.slice(0, 256),
      mismatch: fp.riskScore,
      page: /^\d{1,9}$/.test(url.searchParams.get("page") ?? "")
        ? Number(url.searchParams.get("page"))
        : undefined,
      itemId: /^\/(?:offers|items|sellers)\/([^/]+)/
        .exec(path)?.[1]
        ?.slice(0, 128),
    };
    if (requestedCanaries?.length)
      event.trap = requestedCanaries.includes(
        await sessions.canary(fp.fingerprintHash),
      );
    if (event.trap) scorer.trap(keys);
    const risk = Math.max(fp.riskScore, scorer.risk(keys));
    scorer.enqueue(keys, event);
    if (options.mode !== "enforce") return next();
    // Also used by legacy limiters/ETag middleware on nested route handlers.
    if (protectedRoute) c.set("antiAbuseEnforced", true);
    if (protectedRoute && risk > 0.8) {
      privateResponse(c);
      if (sleepers < 512) {
        sleepers++;
        try {
          await (options.delay ?? tarpitDelay)(
            3000 + Math.floor((options.random ?? Math.random)() * 2001),
            c.req.raw.signal,
          );
        } finally {
          sleepers--;
        }
      }
      // Deliberately truncated data, without a catalog/database query or
      // corrupting prices, purchase links, or shared cache contents.
      return c.json(
        { elements: [], page: event.page ?? 1, limit: 0, total: 0 },
        200,
      );
    }
    if (
      protectedRoute &&
      risk > 0.5 &&
      (!session || now() - session.issuedAt >= SUSPICIOUS_TTL_MS)
    ) {
      privateResponse(c);
      // Keep a genuine but early-expired token for the next handshake so
      // session-only risk survives when trusted edge signals are unavailable.
      if (!session) {
        setCookie(c, SESSION_COOKIE, "", {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
          maxAge: 0,
        });
      }
      return c.json(
        {
          error: {
            code: "SESSION_CHALLENGE_REQUIRED",
            challengeUrl: "/auth/challenge",
          },
        },
        200,
      );
    }
    await next();
    if (protectedRoute) privateResponse(c);
    // Canary injection is explicit: clients must hide synthetic records. It is
    // limited to the small /items list and applied AFTER the route cache read.
    if (
      options.canaries &&
      session &&
      path === "/items" &&
      c.req.method === "GET" &&
      c.res.status === 200 &&
      c.res.headers.get("content-type")?.includes("application/json")
    ) {
      const body = (await c.res.json()) as {
        elements?: Record<string, unknown>[];
      };
      if (Array.isArray(body.elements)) {
        body.elements.push({
          id: await sessions.canary(fp.fingerprintHash),
          title: "",
          namespace: "egdata-canary",
          synthetic: true,
        });
      }
      c.res = c.json(body, 200);
      c.res.headers.delete("Content-Length");
      privateResponse(c);
    }
  };
  return { middleware, challenge };
}

declare module "hono" {
  interface ContextVariableMap {
    antiAbuseEnforced: boolean;
  }
}
