const encoder = new TextEncoder();

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function base64UrlToBytes(input: string): Uint8Array<ArrayBuffer> {
  const padded =
    input.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((input.length + 3) % 4);
  const binary = atob(padded);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export function generateApiKeySecret(): { rawKey: string; keyPrefix: string } {
  const randomBytes = crypto.getRandomValues(new Uint8Array(24));
  const token = bytesToHex(randomBytes);
  const rawKey = `egk_live_${token}`;
  const keyPrefix = `${rawKey.slice(0, 15)}...${rawKey.slice(-4)}`;
  return { rawKey, keyPrefix };
}

export async function signHmacToken(
  payload: object,
  secret: string,
): Promise<string> {
  const payloadB64 = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payloadB64),
  );
  const sigB64 = bytesToBase64Url(new Uint8Array(signature));
  return `${payloadB64}.${sigB64}`;
}

export async function verifyHmacToken<T>(
  token: string,
  secret: string,
): Promise<T | null> {
  const dotIdx = token.indexOf(".");
  if (dotIdx <= 0 || dotIdx === token.length - 1) {
    return null;
  }
  const payloadB64 = token.slice(0, dotIdx);
  const sigB64 = token.slice(dotIdx + 1);

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const sigBytes = base64UrlToBytes(sigB64);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      encoder.encode(payloadB64),
    );
    if (!valid) {
      return null;
    }
    const decoded = new TextDecoder().decode(base64UrlToBytes(payloadB64));
    return JSON.parse(decoded) as T;
  } catch {
    return null;
  }
}

export async function timingSafeStringEqual(
  a: string,
  b: string,
): Promise<boolean> {
  const aRaw = encoder.encode(a);
  const bRaw = encoder.encode(b);
  const [aDigest, bDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", aRaw),
    crypto.subtle.digest("SHA-256", bRaw),
  ]);
  const aBytes = new Uint8Array(aDigest);
  const bBytes = new Uint8Array(bDigest);
  let diff = aRaw.byteLength ^ bRaw.byteLength;
  for (let i = 0; i < aBytes.byteLength; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}
