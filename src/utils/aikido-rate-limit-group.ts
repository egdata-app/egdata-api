import { createHmac } from "node:crypto";

type HeaderReader = Pick<Headers, "get">;

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

export function getAikidoRateLimitGroup(headers: HeaderReader) {
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

  return `anon:${createHmac("sha256", secret)
    .update(fingerprint)
    .digest("base64url")}`;
}
