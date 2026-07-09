import { createHmac } from "node:crypto";

type HeaderReader = Pick<Headers, "get">;
type AikidoAnonymousIdentity = {
  id: string;
  name: string;
};

function getHeader(headers: HeaderReader, name: string) {
  return headers.get(name)?.trim() ?? "";
}

function getForwardedClientIp(headers: HeaderReader) {
  return getHeader(headers, "x-forwarded-for").split(",")[0]?.trim() ?? "";
}

function getClientIp(headers: HeaderReader) {
  return (
    getHeader(headers, "cf-connecting-ip") ||
    getForwardedClientIp(headers) ||
    getHeader(headers, "x-real-ip")
  );
}

function getFingerprintSecret() {
  return process.env.JWT_SECRET?.trim() ?? "";
}

function getUserAgentLabel(userAgent: string) {
  const firstProduct = userAgent.split(/\s+/)[0]?.trim() ?? "unknown-client";
  return firstProduct.replace(/[^\w./-]/g, "").slice(0, 48) || "unknown-client";
}

export function getAikidoAnonymousIdentity(
  headers: HeaderReader,
): AikidoAnonymousIdentity | undefined {
  const secret = getFingerprintSecret();
  const clientIp = getClientIp(headers);
  const userAgent = getHeader(headers, "user-agent");

  if (!secret || !clientIp || !userAgent) {
    return undefined;
  }

  const fingerprint = [
    `ip=${clientIp}`,
    `user-agent=${userAgent}`,
    `accept-language=${getHeader(headers, "accept-language")}`,
    `cf-ipcountry=${getHeader(headers, "cf-ipcountry")}`,
  ].join("\n");

  const id = `anon:${createHmac("sha256", secret)
    .update(fingerprint)
    .digest("base64url")}`;
  const country = getHeader(headers, "cf-ipcountry");
  const userAgentLabel = getUserAgentLabel(userAgent);

  return {
    id,
    name: country
      ? `Anonymous ${userAgentLabel} (${country})`
      : `Anonymous ${userAgentLabel}`,
  };
}

export function getAikidoRateLimitGroup(headers: HeaderReader) {
  return getAikidoAnonymousIdentity(headers)?.id;
}
