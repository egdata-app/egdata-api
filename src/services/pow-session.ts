import { createHash, randomUUID, webcrypto } from "node:crypto";

export const SESSION_TTL_MS = 600_000;
export const CHALLENGE_TTL_MS = 60_000;
export const SUSPICIOUS_TTL_MS = 30_000;

export interface SessionClaims {
  sessionId: string;
  fingerprintHash: string;
  issuedAt: number;
  riskScore: number;
}

interface SignedClaims extends SessionClaims {
  kind: "session" | "challenge";
  difficulty?: number;
}

export interface PowChallenge {
  challenge: string;
  difficulty: number;
  expiresAt: number;
  algorithm: "SHA-256";
}

/** Separate signing domains prevent challenges from being used as sessions. */
export class PowSessionService {
  private readonly key: Promise<webcrypto.CryptoKey>;

  constructor(
    secret: string,
    private readonly now = Date.now,
  ) {
    if (Buffer.byteLength(secret) < 32) {
      throw new Error("ANTI_ABUSE_SECRET must contain at least 32 bytes");
    }
    this.key = webcrypto.subtle.importKey(
      "raw",
      Buffer.from(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  }

  private async sign(claims: SignedClaims): Promise<string> {
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = await webcrypto.subtle.sign(
      "HMAC",
      await this.key,
      Buffer.from(payload),
    );
    return `${payload}.${Buffer.from(signature).toString("base64url")}`;
  }

  private async read(
    token: string,
    kind: SignedClaims["kind"],
    ttl: number,
  ): Promise<SignedClaims | null> {
    if (token.length > 2048 || !/^[\w-]+\.[\w-]{43}$/.test(token)) return null;
    const [payload, signature] = token.split(".");
    try {
      if (
        !(await webcrypto.subtle.verify(
          "HMAC",
          await this.key,
          Buffer.from(signature, "base64url"),
          Buffer.from(payload),
        ))
      )
        return null;
      const value = JSON.parse(
        Buffer.from(payload, "base64url").toString(),
      ) as SignedClaims;
      if (
        value.kind !== kind ||
        !/^[a-f0-9-]{36}$/.test(value.sessionId) ||
        !/^[a-f0-9]{64}$/.test(value.fingerprintHash) ||
        !Number.isSafeInteger(value.issuedAt) ||
        value.issuedAt > this.now() ||
        this.now() - value.issuedAt >= ttl ||
        !Number.isFinite(value.riskScore) ||
        value.riskScore < 0 ||
        value.riskScore > 1
      )
        return null;
      return value;
    } catch {
      return null;
    }
  }

  async challenge(
    fingerprintHash: string,
    riskScore: number,
    sessionId: string = randomUUID(),
  ): Promise<PowChallenge> {
    const difficulty = riskScore > 0.5 ? 20 : 16;
    const issuedAt = this.now();
    return {
      challenge: await this.sign({
        kind: "challenge",
        sessionId,
        fingerprintHash,
        issuedAt,
        riskScore,
        difficulty,
      }),
      difficulty,
      expiresAt: issuedAt + CHALLENGE_TTL_MS,
      algorithm: "SHA-256",
    };
  }

  async redeem(
    challenge: string,
    nonce: string,
    fingerprintHash: string,
    minimumRisk = 0,
  ) {
    const claims = await this.read(challenge, "challenge", CHALLENGE_TTL_MS);
    if (
      !claims ||
      claims.fingerprintHash !== fingerprintHash ||
      claims.difficulty !== (claims.riskScore > 0.5 ? 20 : 16) ||
      (minimumRisk > 0.5 && claims.difficulty < 20) ||
      !verifyProofOfWork(challenge, nonce, claims.difficulty)
    )
      return null;
    // Replaying a proof yields the SAME session and original lifetime, never
    // a new identity or a renewed expiration. No replay database is needed.
    const session: SignedClaims = {
      kind: "session",
      sessionId: claims.sessionId,
      fingerprintHash,
      issuedAt: claims.issuedAt,
      riskScore: Math.max(claims.riskScore, minimumRisk),
    };
    return {
      token: await this.sign(session),
      session,
      expiresAt: session.issuedAt + SESSION_TTL_MS,
    };
  }

  async verify(
    token: string,
    fingerprintHash: string,
  ): Promise<SessionClaims | null> {
    const claims = await this.read(token, "session", SESSION_TTL_MS);
    return claims?.fingerprintHash === fingerprintHash ? claims : null;
  }

  async canary(fingerprintHash: string): Promise<string> {
    const signature = await webcrypto.subtle.sign(
      "HMAC",
      await this.key,
      Buffer.from(`canary:${fingerprintHash}`),
    );
    return `egcanary_${Buffer.from(signature).subarray(0, 16).toString("hex")}`;
  }
}

/** One hash on the server; a browser worker searches SHA256(challenge + ':' + nonce). */
export function verifyProofOfWork(
  challenge: string,
  nonce: string,
  difficulty: number,
): boolean {
  if (
    !/^[a-zA-Z0-9_-]{1,64}$/.test(nonce) ||
    !Number.isInteger(difficulty) ||
    difficulty < 1 ||
    difficulty > 24
  )
    return false;
  const hash = createHash("sha256").update(`${challenge}:${nonce}`).digest();
  const bytes = Math.floor(difficulty / 8);
  for (let i = 0; i < bytes; i++) if (hash[i] !== 0) return false;
  return difficulty % 8 === 0 || hash[bytes] >>> (8 - (difficulty % 8)) === 0;
}
