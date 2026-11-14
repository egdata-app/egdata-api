import type { ApiScope, CachedKeyMetadata } from "./types.js";

function parseIpv4(ip: string): number | null {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const num = Number(part);
    if (num < 0 || num > 255) return null;
    result = (result << 8) | num;
  }
  return result >>> 0;
}

function parseIpv6(ip: string): Uint16Array | null {
  const trimmed = ip.trim().toLowerCase();
  if (!trimmed.includes(":")) return null;

  // Handle IPv4-mapped IPv6 like ::ffff:192.168.1.1
  let normalized = trimmed;
  const lastColon = normalized.lastIndexOf(":");
  if (lastColon !== -1 && normalized.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4(normalized.slice(lastColon + 1));
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    normalized = `${normalized.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const doubleColonParts = normalized.split("::");
  if (doubleColonParts.length > 2) return null;

  const left = doubleColonParts[0] ? doubleColonParts[0].split(":") : [];
  const right =
    doubleColonParts.length === 2 && doubleColonParts[1]
      ? doubleColonParts[1].split(":")
      : [];

  if (doubleColonParts.length === 1 && left.length !== 8) return null;
  if (left.length + right.length > 8) return null;

  const missing = 8 - (left.length + right.length);
  const full = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (full.length !== 8) return null;

  const groups = new Uint16Array(8);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/.test(full[i])) return null;
    groups[i] = Number.parseInt(full[i], 16);
  }
  return groups;
}

export function isValidIpOrCidr(rule: string): boolean {
  const trimmed = rule.trim();
  if (!trimmed) return false;
  const [addr, prefixRaw, extra] = trimmed.split("/");
  if (extra !== undefined) return false;

  const v4 = parseIpv4(addr);
  if (v4 !== null) {
    if (prefixRaw === undefined) return true;
    if (!/^\d{1,2}$/.test(prefixRaw)) return false;
    const bits = Number(prefixRaw);
    return bits >= 0 && bits <= 32;
  }

  const v6 = parseIpv6(addr);
  if (v6 !== null) {
    if (prefixRaw === undefined) return true;
    if (!/^\d{1,3}$/.test(prefixRaw)) return false;
    const bits = Number(prefixRaw);
    return bits >= 0 && bits <= 128;
  }

  return false;
}

export function ipMatchesRule(clientIp: string, rule: string): boolean {
  const trimmedRule = rule.trim();
  if (!trimmedRule) return false;
  if (trimmedRule === "*") return true;

  const [ruleAddr, prefixRaw] = trimmedRule.split("/");

  const clientV4 = parseIpv4(clientIp);
  const ruleV4 = parseIpv4(ruleAddr);
  if (clientV4 !== null && ruleV4 !== null) {
    const bits = prefixRaw !== undefined ? Number(prefixRaw) : 32;
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xffffffff : (~0 << (32 - bits)) >>> 0;
    return (clientV4 & mask) >>> 0 === (ruleV4 & mask) >>> 0;
  }

  const clientV6 = parseIpv6(clientIp);
  const ruleV6 = parseIpv6(ruleAddr);
  if (clientV6 !== null && ruleV6 !== null) {
    const bits = prefixRaw !== undefined ? Number(prefixRaw) : 128;
    if (!Number.isInteger(bits) || bits < 0 || bits > 128) return false;
    let remaining = bits;
    for (let i = 0; i < 8 && remaining > 0; i++) {
      const groupBits = Math.min(16, remaining);
      const mask =
        groupBits === 16 ? 0xffff : (0xffff << (16 - groupBits)) & 0xffff;
      if ((clientV6[i] & mask) !== (ruleV6[i] & mask)) {
        return false;
      }
      remaining -= groupBits;
    }
    return true;
  }

  return false;
}

export function isIpAllowed(
  clientIp: string | null,
  allowedIps: string[],
): boolean {
  if (allowedIps.length === 0) return true;
  if (!clientIp) return false;
  return allowedIps.some((rule) => ipMatchesRule(clientIp, rule));
}

export function originMatchesPattern(origin: string, pattern: string): boolean {
  const cleanOrigin = origin.trim().toLowerCase().replace(/\/+$/, "");
  const cleanPattern = pattern.trim().toLowerCase().replace(/\/+$/, "");
  if (!cleanPattern) return false;
  if (cleanPattern === "*") return true;
  if (cleanOrigin === cleanPattern) return true;

  // Support wildcard subdomain e.g. https://*.example.com or *.example.com
  try {
    const originUrl = new URL(cleanOrigin);
    if (cleanPattern.startsWith("https://*.")) {
      const suffix = cleanPattern.slice("https://*".length); // ".example.com"
      return (
        originUrl.protocol === "https:" &&
        (originUrl.hostname === suffix.slice(1) ||
          originUrl.hostname.endsWith(suffix))
      );
    }
    if (cleanPattern.startsWith("http://*.")) {
      const suffix = cleanPattern.slice("http://*".length);
      return (
        originUrl.protocol === "http:" &&
        (originUrl.hostname === suffix.slice(1) ||
          originUrl.hostname.endsWith(suffix))
      );
    }
    if (cleanPattern.startsWith("*.")) {
      const suffix = cleanPattern.slice(1); // ".example.com"
      return (
        originUrl.hostname === suffix.slice(1) ||
        originUrl.hostname.endsWith(suffix)
      );
    }
  } catch {
    return false;
  }
  return false;
}

export function isOriginAllowed(
  originHeader: string | null,
  allowedOrigins: string[],
): boolean {
  if (allowedOrigins.length === 0) return true;
  if (!originHeader) return false;
  return allowedOrigins.some((pattern) =>
    originMatchesPattern(originHeader, pattern),
  );
}

export function pathMatchesPattern(pathname: string, pattern: string): boolean {
  const cleanPattern = pattern.trim();
  if (!cleanPattern) return false;
  if (cleanPattern === "*" || cleanPattern === "/*") return true;
  if (cleanPattern.endsWith("/*")) {
    const prefix = cleanPattern.slice(0, -2);
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
  }
  if (cleanPattern.endsWith("*")) {
    const prefix = cleanPattern.slice(0, -1);
    return pathname.startsWith(prefix);
  }
  return pathname === cleanPattern;
}

export function isPathAllowed(
  pathname: string,
  allowedPaths: string[],
): boolean {
  if (allowedPaths.length === 0) return true;
  return allowedPaths.some((pattern) => pathMatchesPattern(pathname, pattern));
}

export function requiredScopeForPath(pathname: string): ApiScope {
  if (pathname === "/graphql" || pathname.startsWith("/graphql/")) {
    return "graphql:read";
  }
  if (pathname.startsWith("/offers")) {
    return "offers:read";
  }
  if (pathname.startsWith("/items")) {
    return "items:read";
  }
  if (pathname.startsWith("/search") || pathname.startsWith("/multisearch")) {
    return "search:read";
  }
  if (pathname.startsWith("/profiles")) {
    return "profiles:read";
  }
  if (pathname.startsWith("/builds")) {
    return "builds:read";
  }
  if (
    pathname.startsWith("/stats") ||
    pathname.startsWith("/free-games/stats") ||
    pathname.startsWith("/game-awards")
  ) {
    return "stats:read";
  }
  return "catalog:read";
}

export interface PolicyEvaluationResult {
  allowed: boolean;
  reason:
    | "ok"
    | "key_inactive"
    | "key_expired"
    | "method_denied"
    | "ip_denied"
    | "origin_denied"
    | "path_denied"
    | "scope_denied";
  status: 200 | 401 | 403;
  message?: string;
}

export function evaluateKeyPermissions(
  meta: CachedKeyMetadata,
  request: {
    method: string;
    pathname: string;
    clientIp: string | null;
    origin: string | null;
  },
  nowMs = Date.now(),
  requiredScope?: ApiScope,
): PolicyEvaluationResult {
  if (!meta.active) {
    return {
      allowed: false,
      reason: "key_inactive",
      status: 401,
      message: "API key has been revoked or deactivated.",
    };
  }

  if (meta.expiresAt) {
    const exp = Date.parse(meta.expiresAt);
    if (Number.isFinite(exp) && nowMs >= exp) {
      return {
        allowed: false,
        reason: "key_expired",
        status: 401,
        message: "API key has expired.",
      };
    }
  }

  const method = request.method.toUpperCase();
  if (
    meta.allowedMethods.length > 0 &&
    !meta.allowedMethods.some((m) => m.toUpperCase() === method)
  ) {
    return {
      allowed: false,
      reason: "method_denied",
      status: 403,
      message: `HTTP method ${method} is not permitted for this API key.`,
    };
  }

  if (!isIpAllowed(request.clientIp, meta.allowedIps)) {
    return {
      allowed: false,
      reason: "ip_denied",
      status: 403,
      message: "Client IP address is not in this API key's allowlist.",
    };
  }

  if (!isOriginAllowed(request.origin, meta.allowedOrigins)) {
    return {
      allowed: false,
      reason: "origin_denied",
      status: 403,
      message: "Request Origin header is not permitted for this API key.",
    };
  }

  if (!isPathAllowed(request.pathname, meta.allowedPaths)) {
    return {
      allowed: false,
      reason: "path_denied",
      status: 403,
      message: `Path ${request.pathname} is not permitted for this API key.`,
    };
  }

  const neededScope = requiredScope ?? requiredScopeForPath(request.pathname);
  if (meta.scopes.length > 0 && !meta.scopes.includes(neededScope)) {
    return {
      allowed: false,
      reason: "scope_denied",
      status: 403,
      message: `API key is missing required scope '${neededScope}'.`,
    };
  }

  return { allowed: true, reason: "ok", status: 200 };
}
