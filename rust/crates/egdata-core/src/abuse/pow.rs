//! Proof-of-Work challenge/session token signing, verification, and canary tokens.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::Utc;
use hmac::{Hmac, Mac};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;
use uuid::Uuid;

use crate::error::CoreError;

type HmacSha256 = Hmac<Sha256>;

pub const SESSION_TTL_MS: i64 = 600_000;
pub const CHALLENGE_TTL_MS: i64 = 60_000;
pub const SUSPICIOUS_TTL_MS: i64 = 30_000;

/// Verified anti-abuse session claims.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionClaims {
    pub session_id: String,
    pub fingerprint_hash: String,
    pub issued_at: i64,
    pub risk_score: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum TokenKind {
    Session,
    Challenge,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignedClaims {
    kind: TokenKind,
    session_id: String,
    fingerprint_hash: String,
    issued_at: i64,
    risk_score: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    difficulty: Option<u32>,
}

/// Proof-of-work challenge issued to suspicious clients.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PowChallenge {
    pub challenge: String,
    pub difficulty: u32,
    pub expires_at: i64,
    pub algorithm: String,
}

/// Redeemed proof-of-work session token and claims.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedeemedSession {
    pub token: String,
    pub session: SessionClaims,
    pub expires_at: i64,
}

fn token_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[\w-]+\.[\w-]{43}$").expect("valid regex"))
}

fn session_id_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-f0-9-]{36}$").expect("valid regex"))
}

fn fingerprint_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-f0-9]{64}$").expect("valid regex"))
}

fn nonce_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-zA-Z0-9_-]{1,64}$").expect("valid regex"))
}

/// Separate signing domains prevent challenges from being used as sessions.
#[derive(Debug, Clone)]
pub struct PowSessionService {
    secret: Vec<u8>,
}

impl PowSessionService {
    pub const MIN_SECRET_BYTES: usize = 32;

    /// Creates a new `PowSessionService` after validating `secret` is at least 32 bytes.
    pub fn new(secret: &str) -> Result<Self, CoreError> {
        if secret.len() < Self::MIN_SECRET_BYTES {
            return Err(CoreError::InvalidInput(
                "ANTI_ABUSE_SECRET must contain at least 32 bytes".to_string(),
            ));
        }
        Ok(Self {
            secret: secret.as_bytes().to_vec(),
        })
    }

    fn sign(&self, claims: &SignedClaims) -> String {
        let json = serde_json::to_vec(claims).expect("serializable claims");
        let payload = URL_SAFE_NO_PAD.encode(json);
        let mut mac = HmacSha256::new_from_slice(&self.secret).expect("valid hmac key");
        mac.update(payload.as_bytes());
        let sig = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        format!("{payload}.{sig}")
    }

    fn read(&self, token: &str, kind: TokenKind, ttl: i64, now_ms: i64) -> Option<SignedClaims> {
        if token.len() > 2048 || !token_regex().is_match(token) {
            return None;
        }
        let (payload, signature) = token.split_once('.').expect("token regex requires dot");
        let sig_bytes = URL_SAFE_NO_PAD.decode(signature).ok()?;
        let mut mac = HmacSha256::new_from_slice(&self.secret).expect("HMAC accepts any key size");
        mac.update(payload.as_bytes());
        mac.verify_slice(&sig_bytes).ok()?;

        let decoded = URL_SAFE_NO_PAD.decode(payload).ok()?;
        let value: SignedClaims = serde_json::from_slice(&decoded).ok()?;
        if value.kind != kind
            || !session_id_regex().is_match(&value.session_id)
            || !fingerprint_regex().is_match(&value.fingerprint_hash)
            || value.issued_at > now_ms
            || now_ms - value.issued_at >= ttl
            || !value.risk_score.is_finite()
            || !(0.0..=1.0).contains(&value.risk_score)
        {
            return None;
        }
        Some(value)
    }

    /// Issues a PoW challenge at the supplied timestamp.
    pub fn challenge_at(
        &self,
        fingerprint_hash: &str,
        risk_score: f64,
        session_id: Option<&str>,
        now_ms: i64,
    ) -> PowChallenge {
        let difficulty = if risk_score > 0.5 { 20 } else { 16 };
        let sid = session_id
            .map(str::to_string)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let challenge = self.sign(&SignedClaims {
            kind: TokenKind::Challenge,
            session_id: sid,
            fingerprint_hash: fingerprint_hash.to_string(),
            issued_at: now_ms,
            risk_score,
            difficulty: Some(difficulty),
        });
        PowChallenge {
            challenge,
            difficulty,
            expires_at: now_ms + CHALLENGE_TTL_MS,
            algorithm: "SHA-256".to_string(),
        }
    }

    /// Issues a PoW challenge using current UTC time.
    pub fn challenge(
        &self,
        fingerprint_hash: &str,
        risk_score: f64,
        session_id: Option<&str>,
    ) -> PowChallenge {
        self.challenge_at(
            fingerprint_hash,
            risk_score,
            session_id,
            Utc::now().timestamp_millis(),
        )
    }

    /// Redeems a solved PoW challenge into a session token at the supplied timestamp.
    pub fn redeem_at(
        &self,
        challenge: &str,
        nonce: &str,
        fingerprint_hash: &str,
        minimum_risk: f64,
        now_ms: i64,
    ) -> Option<RedeemedSession> {
        let claims = self.read(challenge, TokenKind::Challenge, CHALLENGE_TTL_MS, now_ms)?;
        let expected_difficulty = if claims.risk_score > 0.5 { 20 } else { 16 };
        let difficulty = claims.difficulty?;
        if claims.fingerprint_hash != fingerprint_hash
            || difficulty != expected_difficulty
            || (minimum_risk > 0.5 && difficulty < 20)
            || !verify_proof_of_work(challenge, nonce, difficulty)
        {
            return None;
        }
        let session_risk = claims.risk_score.max(minimum_risk);
        let session_claims = SignedClaims {
            kind: TokenKind::Session,
            session_id: claims.session_id.clone(),
            fingerprint_hash: fingerprint_hash.to_string(),
            issued_at: claims.issued_at,
            risk_score: session_risk,
            difficulty: None,
        };
        let token = self.sign(&session_claims);
        Some(RedeemedSession {
            token,
            session: SessionClaims {
                session_id: session_claims.session_id,
                fingerprint_hash: session_claims.fingerprint_hash,
                issued_at: session_claims.issued_at,
                risk_score: session_claims.risk_score,
            },
            expires_at: claims.issued_at + SESSION_TTL_MS,
        })
    }

    /// Redeems a solved PoW challenge into a session token using current UTC time.
    pub fn redeem(
        &self,
        challenge: &str,
        nonce: &str,
        fingerprint_hash: &str,
        minimum_risk: f64,
    ) -> Option<RedeemedSession> {
        self.redeem_at(
            challenge,
            nonce,
            fingerprint_hash,
            minimum_risk,
            Utc::now().timestamp_millis(),
        )
    }

    /// Verifies a session token for `fingerprint_hash` at `now_ms`.
    pub fn verify_at(
        &self,
        token: &str,
        fingerprint_hash: &str,
        now_ms: i64,
    ) -> Option<SessionClaims> {
        let claims = self.read(token, TokenKind::Session, SESSION_TTL_MS, now_ms)?;
        if claims.fingerprint_hash != fingerprint_hash {
            return None;
        }
        Some(SessionClaims {
            session_id: claims.session_id,
            fingerprint_hash: claims.fingerprint_hash,
            issued_at: claims.issued_at,
            risk_score: claims.risk_score,
        })
    }

    /// Verifies a session token for `fingerprint_hash` using current UTC time.
    pub fn verify(&self, token: &str, fingerprint_hash: &str) -> Option<SessionClaims> {
        self.verify_at(token, fingerprint_hash, Utc::now().timestamp_millis())
    }

    /// Derives a deterministic HMAC-tagged canary token for `fingerprint_hash`.
    pub fn canary(&self, fingerprint_hash: &str) -> String {
        let mut mac = HmacSha256::new_from_slice(&self.secret).expect("valid hmac key");
        mac.update(format!("canary:{fingerprint_hash}").as_bytes());
        let bytes = mac.finalize().into_bytes();
        format!("egcanary_{}", hex::encode(&bytes[..16]))
    }
}

/// Verifies `SHA256(challenge + ":" + nonce)` has at least `difficulty` leading zero bits.
pub fn verify_proof_of_work(challenge: &str, nonce: &str, difficulty: u32) -> bool {
    if !nonce_regex().is_match(nonce) || !(1..=24).contains(&difficulty) {
        return false;
    }
    let mut hasher = Sha256::new();
    hasher.update(challenge.as_bytes());
    hasher.update(b":");
    hasher.update(nonce.as_bytes());
    let hash = hasher.finalize();

    let full_bytes = (difficulty / 8) as usize;
    if hash[..full_bytes].iter().any(|&b| b != 0) {
        return false;
    }
    let rem = difficulty % 8;
    rem == 0 || (hash[full_bytes] >> (8 - rem)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "0123456789abcdef0123456789abcdef";
    const FP: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const FP2: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn solve_pow(challenge: &str, difficulty: u32) -> String {
        (0_u64..)
            .map(|i| i.to_string())
            .find(|candidate| verify_proof_of_work(challenge, candidate, difficulty))
            .expect("pow solution exists")
    }

    #[test]
    fn test_service_secret_validation_and_canary() {
        assert!(PowSessionService::new("too-short").is_err());
        let svc = PowSessionService::new(SECRET).unwrap();
        let c1 = svc.canary(FP);
        let c2 = svc.canary(FP);
        assert_eq!(c1, c2);
        assert!(c1.starts_with("egcanary_"));
        assert_eq!(c1.len(), "egcanary_".len() + 32);
    }

    #[test]
    fn test_verify_proof_of_work_edges() {
        assert!(!verify_proof_of_work("c", "", 8));
        assert!(!verify_proof_of_work("c", "bad!nonce", 8));
        assert!(!verify_proof_of_work("c", "1", 0));
        assert!(!verify_proof_of_work("c", "1", 25));

        let nonce8 = solve_pow("test-challenge", 8);
        assert!(verify_proof_of_work("test-challenge", &nonce8, 8));
        assert!(!verify_proof_of_work("other-challenge", &nonce8, 8));

        let nonce10 = solve_pow("test-challenge-10", 10);
        assert!(verify_proof_of_work("test-challenge-10", &nonce10, 10));
    }

    #[test]
    fn test_challenge_redeem_verify_lifecycle() {
        let svc = PowSessionService::new(SECRET).unwrap();
        let now = 1_700_000_000_000_i64;
        let sid = "11111111-1111-4111-8111-111111111111";

        let ch_low = svc.challenge_at(FP, 0.2, Some(sid), now);
        assert_eq!(ch_low.difficulty, 16);
        assert_eq!(ch_low.expires_at, now + CHALLENGE_TTL_MS);
        assert_eq!(ch_low.algorithm, "SHA-256");

        let ch_high = svc.challenge_at(FP, 0.8, Some(sid), now);
        assert_eq!(ch_high.difficulty, 20);

        // Domain separation: challenge cannot verify as session
        assert!(svc.verify_at(&ch_low.challenge, FP, now).is_none());

        // Solve low-risk challenge (difficulty 16)
        let nonce = solve_pow(&ch_low.challenge, 16);

        // Wrong fingerprint or minimumRisk > 0.5 fails
        assert!(
            svc.redeem_at(&ch_low.challenge, &nonce, FP2, 0.0, now)
                .is_none()
        );
        assert!(
            svc.redeem_at(&ch_low.challenge, &nonce, FP, 0.7, now)
                .is_none()
        );
        assert!(
            svc.redeem_at(&ch_low.challenge, "wrong", FP, 0.0, now)
                .is_none()
        );

        // Expired or future-dated challenge fails
        assert!(
            svc.redeem_at(&ch_low.challenge, &nonce, FP, 0.0, now + CHALLENGE_TTL_MS)
                .is_none()
        );
        assert!(
            svc.redeem_at(&ch_low.challenge, &nonce, FP, 0.0, now - 1)
                .is_none()
        );

        let redeemed = svc
            .redeem_at(&ch_low.challenge, &nonce, FP, 0.35, now + 1000)
            .unwrap();
        assert_eq!(redeemed.session.session_id, sid);
        assert_eq!(redeemed.session.risk_score, 0.35);
        assert_eq!(redeemed.expires_at, now + SESSION_TTL_MS);

        // Verify valid session
        let verified = svc.verify_at(&redeemed.token, FP, now + 5000).unwrap();
        assert_eq!(verified.session_id, sid);
        assert!(svc.verify_at(&redeemed.token, FP2, now + 5000).is_none());
        assert!(
            svc.verify_at(&redeemed.token, FP, now + SESSION_TTL_MS)
                .is_none()
        );

        // Malformed / oversized / invalid signature / invalid claims tokens
        let long = "a".repeat(2049);
        assert!(svc.verify_at(&long, FP, now).is_none());
        assert!(svc.verify_at("invalid", FP, now).is_none());
        let bad_b64_sig = format!("AAAA.{}", "a".repeat(43));
        assert!(svc.verify_at(&bad_b64_sig, FP, now).is_none());
        let bad_sig = format!("AAAA.{}", "A".repeat(43));
        assert!(svc.verify_at(&bad_sig, FP, now).is_none());

        // Valid HMAC over invalid base64 payload & invalid JSON payload
        let sign_raw = |p: &str| -> String {
            let mut mac = HmacSha256::new_from_slice(SECRET.as_bytes()).unwrap();
            mac.update(p.as_bytes());
            format!(
                "{p}.{}",
                URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
            )
        };
        assert!(svc.verify_at(&sign_raw("a"), FP, now).is_none());
        assert!(
            svc.verify_at(&sign_raw(&URL_SAFE_NO_PAD.encode(b"not-json")), FP, now)
                .is_none()
        );

        // Signed challenge missing difficulty field fails redeem
        let no_diff = svc.sign(&SignedClaims {
            kind: TokenKind::Challenge,
            session_id: sid.into(),
            fingerprint_hash: FP.into(),
            issued_at: now,
            risk_score: 0.2,
            difficulty: None,
        });
        assert!(svc.redeem_at(&no_diff, "0", FP, 0.0, now).is_none());

        // High-risk challenge (difficulty 20) redeems cleanly
        let high_nonce = solve_pow(&ch_high.challenge, 20);
        let high_redeemed = svc
            .redeem_at(&ch_high.challenge, &high_nonce, FP, 0.6, now + 100)
            .unwrap();
        assert_eq!(high_redeemed.session.risk_score, 0.8);

        // Signed token with invalid claim fields
        let bad_claims = svc.sign(&SignedClaims {
            kind: TokenKind::Session,
            session_id: "not-a-uuid".into(),
            fingerprint_hash: FP.into(),
            issued_at: now,
            risk_score: 0.2,
            difficulty: None,
        });
        assert!(svc.verify_at(&bad_claims, FP, now).is_none());

        // Signed challenge with tampered difficulty
        let tampered_diff = svc.sign(&SignedClaims {
            kind: TokenKind::Challenge,
            session_id: sid.into(),
            fingerprint_hash: FP.into(),
            issued_at: now,
            risk_score: 0.2,
            difficulty: Some(8),
        });
        let easy_nonce = solve_pow(&tampered_diff, 8);
        assert!(
            svc.redeem_at(&tampered_diff, &easy_nonce, FP, 0.0, now)
                .is_none()
        );

        // Current-time wrappers smoke test
        let live_ch = svc.challenge(FP, 0.1, None);
        assert_eq!(live_ch.difficulty, 16);
        assert!(svc.redeem(&live_ch.challenge, "0", FP, 0.0).is_none());
        assert!(svc.verify("bad.token", FP).is_none());
    }
}
