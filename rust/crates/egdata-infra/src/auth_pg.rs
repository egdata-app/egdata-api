//! Better-Auth session verification against cookie cache and Neon Postgres (`src/utils/auth.ts`).

use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD as BASE64_STANDARD, URL_SAFE_NO_PAD as BASE64_URL_NO_PAD},
};
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use sqlx::{PgPool, Row, postgres::PgPoolOptions};
use thiserror::Error;

type HmacSha256 = Hmac<Sha256>;

const SESSION_TOKEN_COOKIE: &str = "better-auth.session_token";
const SECURE_SESSION_TOKEN_COOKIE: &str = "__Secure-better-auth.session_token";
const ALT_SESSION_TOKEN_COOKIE: &str = "better-auth-session_token";
const SECURE_ALT_SESSION_TOKEN_COOKIE: &str = "__Secure-better-auth-session_token";

const SESSION_DATA_COOKIE: &str = "better-auth.session_data";
const SECURE_SESSION_DATA_COOKIE: &str = "__Secure-better-auth.session_data";

/// Errors returned by Better-Auth Postgres configuration and session lookup.
#[derive(Debug, Error)]
pub enum AuthPgError {
    #[error("{0} is required")]
    MissingEnv(&'static str),
    #[error("Invalid BETTER_AUTH_SECRETS configuration")]
    InvalidSecretList,
    #[error("Invalid session database configuration")]
    InvalidConnectionUri,
    #[error("postgres error: {0}")]
    Sqlx(#[from] sqlx::Error),
}

/// Configuration for Better-Auth Postgres and cookie verification (`src/utils/auth.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthPgConfig {
    pub connection_uri: String,
    pub secret: String,
    pub cookie_cache_max_age_secs: u64,
}

impl AuthPgConfig {
    /// Loads the database URI and the signing key selected by Better Auth.
    pub fn from_env_lookup<F>(mut get_env: F) -> Result<Self, AuthPgError>
    where
        F: FnMut(&str) -> Option<String>,
    {
        let connection_uri = get_env("NEON_CONNECTION_URI")
            .filter(|v| !v.is_empty())
            .ok_or(AuthPgError::MissingEnv("NEON_CONNECTION_URI"))?;
        let secret = if let Some(list) = get_env("BETTER_AUTH_SECRETS").filter(|v| !v.is_empty()) {
            active_cookie_secret(&list)?
        } else {
            get_env("BETTER_AUTH_SECRET")
                .filter(|v| !v.is_empty())
                .or_else(|| get_env("AUTH_SECRET").filter(|v| !v.is_empty()))
                .ok_or(AuthPgError::MissingEnv("BETTER_AUTH_SECRET"))?
        };

        Ok(Self {
            connection_uri,
            secret,
            cookie_cache_max_age_secs: 5 * 60,
        })
    }
}

// Better Auth signs session cookies with the first configured key. The Node
// process validates the entire version list before accepting sessions.
fn active_cookie_secret(list: &str) -> Result<String, AuthPgError> {
    use egdata_core::v1::query::trim_js_whitespace;
    let mut versions = HashSet::new();
    let mut active = None;
    for entry in list.split(',') {
        let (version, value) = trim_js_whitespace(entry)
            .split_once(':')
            .ok_or(AuthPgError::InvalidSecretList)?;
        let unsigned = version.strip_prefix(['+', '-']).unwrap_or(version);
        let length = unsigned.bytes().take_while(u8::is_ascii_digit).count();
        let version_number = unsigned[..length]
            .parse::<f64>()
            .map_err(|_| AuthPgError::InvalidSecretList)?;
        // parseInt(String(version), 10) must still reproduce the version.
        // JavaScript switches to exponent notation at 1e21.
        if (version.starts_with('-') && version_number != 0.0)
            || version_number >= 1e21
            || !versions.insert(version_number.to_bits())
        {
            return Err(AuthPgError::InvalidSecretList);
        }
        let value = trim_js_whitespace(value);
        if value.is_empty() {
            return Err(AuthPgError::InvalidSecretList);
        }
        active.get_or_insert(value);
    }
    active
        .map(str::to_owned)
        .ok_or(AuthPgError::InvalidSecretList)
}

/// Connects a `sqlx::PgPool` to Neon Postgres.
pub async fn connect_auth_pool(config: &AuthPgConfig) -> Result<PgPool, AuthPgError> {
    PgPoolOptions::new()
        .max_connections(5)
        .connect(&config.connection_uri)
        .await
        .map_err(Into::into)
}

/// As in Node's pg.Pool, session requests open connections on demand.
pub fn lazy_auth_pool(config: &AuthPgConfig) -> Result<PgPool, AuthPgError> {
    Ok(PgPoolOptions::new()
        .max_connections(5)
        .connect_lazy(&config.connection_uri)?)
}

/// Verified Better-Auth session record (`session` table).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSessionRecord {
    pub id: String,
    pub expires_at: DateTime<Utc>,
    pub token: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub ip_address: Option<String>,
    pub user_agent: Option<String>,
    pub user_id: String,
}

/// Verified Better-Auth user record (`user` table).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthUserRecord {
    pub id: String,
    pub name: String,
    pub email: String,
    pub email_verified: bool,
    pub image: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Combined Better-Auth session + user payload returned by `auth.api.getSession`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BetterAuthSession {
    pub session: AuthSessionRecord,
    pub user: AuthUserRecord,
}

/// Parses an HTTP `Cookie` header into a map of cookie names to percent-decoded values.
pub fn parse_cookies(cookie_header: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for part in cookie_header.split(';') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let Some((raw_name, raw_val)) = part.split_once('=') else {
            continue;
        };
        let name = raw_name.trim();
        if name.is_empty() || map.contains_key(name) {
            continue;
        }
        let mut val = raw_val.trim();
        if val.len() >= 2 && val.starts_with('"') && val.ends_with('"') {
            val = &val[1..val.len() - 1];
        }
        map.insert(name.to_string(), percent_decode(val));
    }
    map
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2]))
        {
            out.push((hi << 4) | lo);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| input.to_string())
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Extracts the raw `better-auth.session_token` cookie value (preferring `__Secure-` or non-secure).
pub fn extract_session_token_cookie(cookies: &HashMap<String, String>) -> Option<&str> {
    [
        SESSION_TOKEN_COOKIE,
        SECURE_SESSION_TOKEN_COOKIE,
        ALT_SESSION_TOKEN_COOKIE,
        SECURE_ALT_SESSION_TOKEN_COOKIE,
    ]
    .into_iter()
    .find_map(|name| cookies.get(name).map(String::as_str))
}

/// Extracts `better-auth.session_data` (including chunked `.0`, `.1`, ... cookies).
pub fn extract_session_data_cookie(cookies: &HashMap<String, String>) -> Option<String> {
    for base in [SECURE_SESSION_DATA_COOKIE, SESSION_DATA_COOKIE] {
        if let Some(val) = cookies.get(base) {
            return Some(val.clone());
        }
        let prefix = format!("{base}.");
        let mut chunks: Vec<(usize, &str)> = cookies
            .iter()
            .filter_map(|(name, val)| {
                let suffix = name.strip_prefix(&prefix)?;
                let idx = suffix.parse::<usize>().ok()?;
                Some((idx, val.as_str()))
            })
            .collect();
        if !chunks.is_empty() {
            chunks.sort_by_key(|(idx, _)| *idx);
            return Some(chunks.into_iter().map(|(_, v)| v).collect::<String>());
        }
    }
    None
}

/// Verifies a Better-Auth signed `session_token` cookie (`{token}.{44-char base64 HMAC-SHA256}`).
pub fn verify_session_token_cookie(raw_value: &str, secret: &str) -> Option<String> {
    if secret.is_empty() {
        return None;
    }
    let decoded = percent_decode(raw_value);
    let dot_idx = decoded.rfind('.')?;
    let token = &decoded[..dot_idx];
    let signature_b64 = &decoded[dot_idx + 1..];
    if token.is_empty() || signature_b64.len() != 44 || !signature_b64.ends_with('=') {
        return None;
    }
    let sig_bytes = BASE64_STANDARD.decode(signature_b64).ok()?;
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(token.as_bytes());
    mac.verify_slice(&sig_bytes).ok()?;
    Some(token.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompactSessionDataPayload {
    session: serde_json::Map<String, serde_json::Value>,
    expires_at: i64,
    signature: String,
}

/// Verifies Better-Auth's compact `session_data` cookie cache (5-min `maxAge`, HMAC-SHA256 `base64urlnopad`).
pub fn verify_session_data_cookie(
    raw_value: &str,
    secret: &str,
    now_ms: i64,
) -> Option<BetterAuthSession> {
    if secret.is_empty() {
        return None;
    }
    let bytes = BASE64_URL_NO_PAD.decode(percent_decode(raw_value)).ok()?;
    let envelope: CompactSessionDataPayload = serde_json::from_slice(&bytes).ok()?;
    if envelope.expires_at <= now_ms {
        return None;
    }
    let signature = BASE64_URL_NO_PAD.decode(&envelope.signature).ok()?;
    let mut claims = serde_json::Value::Object(envelope.session);
    claims["expiresAt"] = envelope.expires_at.into();
    // Verify exactly the structured session fields used below, using Better Auth's JSON.stringify order.
    let message = egdata_core::v1::serialization::node_json(&claims);
    if !verify_hmac_bytes(secret, message.as_bytes(), &signature) {
        return None;
    }
    let session: BetterAuthSession = serde_json::from_value(claims).ok()?;
    if session.session.expires_at.timestamp_millis() <= now_ms
        || session.session.user_id != session.user.id
    {
        return None;
    }
    Some(session)
}

fn verify_hmac_bytes(secret: &str, message: &[u8], signature: &[u8]) -> bool {
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(message);
    mac.verify_slice(signature).is_ok()
}

/// Async repository abstraction for Postgres session lookup.
#[async_trait]
pub trait SessionRepository: Send + Sync {
    async fn find_session_by_token(
        &self,
        token: &str,
    ) -> Result<Option<BetterAuthSession>, AuthPgError>;
    async fn linked_epic_account(
        &self,
        _session: &BetterAuthSession,
    ) -> Result<Option<String>, AuthPgError> {
        Ok(None)
    }
}

/// Neon Postgres implementation of [`SessionRepository`].
#[derive(Clone)]
pub struct PgSessionRepository {
    pool: Option<PgPool>,
}

impl PgSessionRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool: Some(pool) }
    }

    /// pg.Pool does not parse a connection URI until a lookup needs a connection.
    pub fn from_config(config: &AuthPgConfig) -> Self {
        Self {
            pool: lazy_auth_pool(config).ok(),
        }
    }

    fn pool(&self) -> Result<&PgPool, AuthPgError> {
        self.pool.as_ref().ok_or(AuthPgError::InvalidConnectionUri)
    }
}

#[async_trait]
impl SessionRepository for PgSessionRepository {
    async fn linked_epic_account(
        &self,
        session: &BetterAuthSession,
    ) -> Result<Option<String>, AuthPgError> {
        // The frontend registers its Better Auth OAuth provider under "epic".
        // An email address can change independently of the provider's account ID.
        let rows: Vec<String> = sqlx::query_scalar(
            r#"
            SELECT DISTINCT a."accountId" FROM "account" a
            INNER JOIN "session" s ON s."userId" = a."userId"
            WHERE s."token" = $1 AND s."userId" = $2 AND s."expiresAt" > NOW()
              AND a."providerId" = 'epic' AND a."accountId" <> ''
            LIMIT 2
        "#,
        )
        .bind(&session.session.token)
        .bind(&session.user.id)
        .fetch_all(self.pool()?)
        .await?;
        Ok(match rows.as_slice() {
            [id] => Some(id.clone()),
            _ => None,
        })
    }
    async fn find_session_by_token(
        &self,
        token: &str,
    ) -> Result<Option<BetterAuthSession>, AuthPgError> {
        let row = sqlx::query(
            r#"
            SELECT
              s."id" AS session_id,
              s."expiresAt" AS session_expires_at,
              s."token" AS session_token,
              s."createdAt" AS session_created_at,
              s."updatedAt" AS session_updated_at,
              s."ipAddress" AS session_ip_address,
              s."userAgent" AS session_user_agent,
              s."userId" AS session_user_id,
              u."id" AS user_id,
              u."name" AS user_name,
              u."email" AS user_email,
              u."emailVerified" AS user_email_verified,
              u."image" AS user_image,
              u."createdAt" AS user_created_at,
              u."updatedAt" AS user_updated_at
            FROM "session" s
            INNER JOIN "user" u ON u."id" = s."userId"
            WHERE s."token" = $1 AND s."expiresAt" > NOW()
            LIMIT 1
            "#,
        )
        .bind(token)
        .fetch_optional(self.pool()?)
        .await?;

        let Some(row) = row else {
            return Ok(None);
        };

        Ok(Some(BetterAuthSession {
            session: AuthSessionRecord {
                id: row.try_get("session_id")?,
                expires_at: row.try_get("session_expires_at")?,
                token: row.try_get("session_token")?,
                created_at: row.try_get("session_created_at")?,
                updated_at: row.try_get("session_updated_at")?,
                ip_address: row.try_get("session_ip_address")?,
                user_agent: row.try_get("session_user_agent")?,
                user_id: row.try_get("session_user_id")?,
            },
            user: AuthUserRecord {
                id: row.try_get("user_id")?,
                name: row.try_get("user_name")?,
                email: row.try_get("user_email")?,
                email_verified: row.try_get("user_email_verified")?,
                image: row.try_get("user_image")?,
                created_at: row.try_get("user_created_at")?,
                updated_at: row.try_get("user_updated_at")?,
            },
        }))
    }
}

/// Verifies Better-Auth sessions from HTTP `Cookie` headers using cookie cache first, then Postgres.
pub struct BetterAuthVerifier<R: SessionRepository> {
    secret: String,
    repo: R,
}

impl<R: SessionRepository> BetterAuthVerifier<R> {
    pub fn new(secret: impl Into<String>, repo: R) -> Self {
        Self {
            secret: secret.into(),
            repo,
        }
    }

    pub async fn linked_epic_account(
        &self,
        session: &BetterAuthSession,
    ) -> Result<Option<String>, AuthPgError> {
        self.repo.linked_epic_account(session).await
    }

    pub async fn get_session(
        &self,
        cookie_header: Option<&str>,
        disable_cookie_cache: bool,
    ) -> Result<Option<BetterAuthSession>, AuthPgError> {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        self.get_session_at(cookie_header, disable_cookie_cache, now_ms)
            .await
    }

    pub async fn get_session_at(
        &self,
        cookie_header: Option<&str>,
        disable_cookie_cache: bool,
        now_ms: i64,
    ) -> Result<Option<BetterAuthSession>, AuthPgError> {
        let Some(header) = cookie_header else {
            return Ok(None);
        };
        let cookies = parse_cookies(header);
        let Some(raw_token) = extract_session_token_cookie(&cookies) else {
            return Ok(None);
        };
        let Some(token) = verify_session_token_cookie(raw_token, &self.secret) else {
            return Ok(None);
        };

        if !disable_cookie_cache
            && let Some(raw_data) = extract_session_data_cookie(&cookies)
            && let Some(cached) = verify_session_data_cookie(&raw_data, &self.secret, now_ms)
            && cached.session.token == token
        {
            return Ok(Some(cached));
        }

        self.repo.find_session_by_token(&token).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct MockSessionRepo {
        calls: AtomicUsize,
        result: Option<BetterAuthSession>,
    }

    #[async_trait]
    impl SessionRepository for MockSessionRepo {
        async fn find_session_by_token(
            &self,
            token: &str,
        ) -> Result<Option<BetterAuthSession>, AuthPgError> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            Ok(self.result.clone().filter(|s| s.session.token == token))
        }
    }

    fn sign_token_cookie(token: &str, secret: &str) -> String {
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(token.as_bytes());
        let sig = BASE64_STANDARD.encode(mac.finalize().into_bytes());
        format!("{token}.{sig}")
    }

    fn sample_session(token: &str) -> BetterAuthSession {
        let dt = Utc.with_ymd_and_hms(2026, 12, 1, 0, 0, 0).unwrap();
        let created = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
        BetterAuthSession {
            session: AuthSessionRecord {
                id: "sess_1".into(),
                expires_at: dt,
                token: token.into(),
                created_at: created,
                updated_at: created,
                ip_address: Some("127.0.0.1".into()),
                user_agent: Some("Mozilla/5.0".into()),
                user_id: "user_1".into(),
            },
            user: AuthUserRecord {
                id: "user_1".into(),
                name: "Alice".into(),
                email: "alice@example.com".into(),
                email_verified: true,
                image: None,
                created_at: created,
                updated_at: created,
            },
        }
    }

    fn build_compact_cookie(
        session: &BetterAuthSession,
        secret: &str,
        expires_at_ms: i64,
    ) -> String {
        let inner = serde_json::json!({
            "session": session.session,
            "user": session.user,
            "updatedAt": 1_700_000_000_000_i64,
            "version": "1",
        });
        let inner_str = serde_json::to_string(&inner).unwrap();
        let to_sign = format!(
            "{},\"expiresAt\":{expires_at_ms}}}",
            &inner_str[..inner_str.len() - 1]
        );
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(to_sign.as_bytes());
        let sig = BASE64_URL_NO_PAD.encode(mac.finalize().into_bytes());
        let envelope = format!(
            "{{\"session\":{inner_str},\"expiresAt\":{expires_at_ms},\"signature\":\"{sig}\"}}"
        );
        BASE64_URL_NO_PAD.encode(envelope.as_bytes())
    }

    #[test]
    fn config_env_validation() {
        let cases: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../../egdata-api/tests/fixtures/session-config-node.json"
        ))
        .unwrap();
        for case in cases {
            let config = AuthPgConfig::from_env_lookup(|key| {
                if key == "NEON_CONNECTION_URI" {
                    return Some("postgresql://localhost/fixture".into());
                }
                case["input"][key].as_str().map(str::to_owned)
            });
            assert_eq!(
                config.ok().as_ref().map(|c| c.secret.as_str()),
                case["secret"].as_str()
            );
        }
        let mut env: HashMap<String, String> = HashMap::new();
        assert!(matches!(
            AuthPgConfig::from_env_lookup(|k| env.get(k).cloned()),
            Err(AuthPgError::MissingEnv("NEON_CONNECTION_URI"))
        ));
        env.insert(
            "NEON_CONNECTION_URI".into(),
            "postgres://user:pass@host/db".into(),
        );
        assert!(matches!(
            AuthPgConfig::from_env_lookup(|k| env.get(k).cloned()),
            Err(AuthPgError::MissingEnv("BETTER_AUTH_SECRET"))
        ));
        env.insert("AUTH_SECRET".into(), "fallback-secret".into());
        let cfg = AuthPgConfig::from_env_lookup(|k| env.get(k).cloned()).unwrap();
        assert_eq!(cfg.secret, "fallback-secret");
        assert_eq!(cfg.cookie_cache_max_age_secs, 300);

        env.insert("BETTER_AUTH_SECRET".into(), "primary-secret".into());
        let cfg2 = AuthPgConfig::from_env_lookup(|k| env.get(k).cloned()).unwrap();
        assert_eq!(cfg2.secret, "primary-secret");
    }

    #[test]
    fn cookie_parsing_and_token_verification() {
        let secret = "super-secret-key-at-least-32-bytes";
        let signed = sign_token_cookie("tok_abc", secret);
        assert_eq!(
            verify_session_token_cookie(&signed, secret).as_deref(),
            Some("tok_abc")
        );
        let encoded = format!(
            "tok_abc.{}",
            signed
                .split('.')
                .nth(1)
                .unwrap()
                .replace('+', "%2B")
                .replace('=', "%3D")
        );
        assert_eq!(
            verify_session_token_cookie(&encoded, secret).as_deref(),
            Some("tok_abc")
        );
        assert!(verify_session_token_cookie("no-dot", secret).is_none());
        assert!(verify_session_token_cookie(".sig", secret).is_none());
        assert!(verify_session_token_cookie("tok_abc.short", secret).is_none());
        let wrong_sig = sign_token_cookie("tok_abc", "wrong-secret");
        assert!(verify_session_token_cookie(&wrong_sig, secret).is_none());

        let parsed = parse_cookies(
            " ; bad; __Secure-better-auth.session_token=\"val%2f1%zz\"; __Secure-better-auth.session_token=ignored",
        );
        assert_eq!(
            parsed
                .get("__Secure-better-auth.session_token")
                .map(String::as_str),
            Some("val/1%zz")
        );
        assert_eq!(extract_session_token_cookie(&parsed), Some("val/1%zz"));
    }

    #[test]
    fn compact_session_data_cookie_verification_and_chunks() {
        let secret = "super-secret-key-at-least-32-bytes";
        let sess = sample_session("tok_123");
        let now_ms = Utc
            .with_ymd_and_hms(2026, 6, 1, 0, 0, 0)
            .unwrap()
            .timestamp_millis();
        let cache_exp = now_ms + 300_000;
        let cookie_val = build_compact_cookie(&sess, secret, cache_exp);

        let verified = verify_session_data_cookie(&cookie_val, secret, now_ms).unwrap();
        assert_eq!(verified.user.email, "alice@example.com");

        // Expired cache cookie -> None
        assert!(verify_session_data_cookie(&cookie_val, secret, cache_exp + 1).is_none());
        // Expired inner session -> None
        let past_sess_ms = Utc
            .with_ymd_and_hms(2027, 1, 1, 0, 0, 0)
            .unwrap()
            .timestamp_millis();
        let cookie_val_future_exp = build_compact_cookie(&sess, secret, past_sess_ms + 1000);
        assert!(verify_session_data_cookie(&cookie_val_future_exp, secret, past_sess_ms).is_none());
        // Tampered signature -> None
        assert!(verify_session_data_cookie(&cookie_val, "other-secret", now_ms).is_none());
        // Invalid base64 / JSON -> None
        assert!(verify_session_data_cookie("!!!", secret, now_ms).is_none());
        assert!(
            verify_session_data_cookie(&BASE64_URL_NO_PAD.encode(b"{"), secret, now_ms).is_none()
        );

        // Chunked cookie assembly
        let mid = cookie_val.len() / 2;
        let mut cookies = HashMap::new();
        cookies.insert(
            "better-auth.session_data.1".into(),
            cookie_val[mid..].into(),
        );
        cookies.insert(
            "better-auth.session_data.0".into(),
            cookie_val[..mid].into(),
        );
        let reassembled = extract_session_data_cookie(&cookies).unwrap();
        assert_eq!(reassembled, cookie_val);

        let mut mismatched = sess.clone();
        mismatched.session.user_id = "other".into();
        assert!(
            verify_session_data_cookie(
                &build_compact_cookie(&mismatched, secret, cache_exp),
                secret,
                now_ms
            )
            .is_none()
        );
    }

    #[tokio::test]
    async fn verifier_uses_cookie_cache_then_falls_back_to_repo() {
        let secret = "super-secret-key-at-least-32-bytes";
        let token = "tok_xyz";
        let sess = sample_session(token);
        let now_ms = Utc
            .with_ymd_and_hms(2026, 6, 1, 0, 0, 0)
            .unwrap()
            .timestamp_millis();
        let token_cookie = sign_token_cookie(token, secret);
        let data_cookie = build_compact_cookie(&sess, secret, now_ms + 300_000);

        let repo = MockSessionRepo {
            calls: AtomicUsize::new(0),
            result: Some(sess.clone()),
        };
        let verifier = BetterAuthVerifier::new(secret, repo);

        assert!(verifier.get_session(None, false).await.unwrap().is_none());
        assert!(
            verifier
                .get_session(Some("foo=bar"), false)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            verifier
                .get_session(Some("better-auth.session_token=bad.sig"), false)
                .await
                .unwrap()
                .is_none()
        );

        let header = format!(
            "better-auth.session_token={token_cookie}; better-auth.session_data={data_cookie}"
        );
        let cached = verifier
            .get_session_at(Some(&header), false, now_ms)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(cached.session.id, "sess_1");
        assert_eq!(verifier.repo.calls.load(Ordering::Relaxed), 0);

        // disable_cookie_cache bypasses cookie cache and hits repo
        let from_repo = verifier
            .get_session_at(Some(&header), true, now_ms)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(from_repo.user.id, "user_1");
        assert_eq!(verifier.repo.calls.load(Ordering::Relaxed), 1);

        // Without cookie cache, hits repo
        let token_only = format!("better-auth.session_token={token_cookie}");
        assert!(
            verifier
                .get_session(Some(&token_only), false)
                .await
                .unwrap()
                .is_some()
        );
        assert_eq!(verifier.repo.calls.load(Ordering::Relaxed), 2);
        let unrelated =
            build_compact_cookie(&sample_session("other-token"), secret, now_ms + 300_000);
        let header = format!(
            "better-auth.session_token={token_cookie}; better-auth.session_data={unrelated}"
        );
        let checked = verifier
            .get_session_at(Some(&header), false, now_ms)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(checked.session.token, token);
        assert_eq!(verifier.repo.calls.load(Ordering::Relaxed), 3);
    }

    #[tokio::test]
    async fn malformed_pg_uri_defers_the_error_until_a_database_read() {
        let secret = "fixture-session-signing-secret";
        let cfg = AuthPgConfig {
            connection_uri: "postgresql://fixture:private@127.0.0.1:invalid/db".into(),
            secret: secret.into(),
            cookie_cache_max_age_secs: 300,
        };
        let verifier = BetterAuthVerifier::new(secret, PgSessionRepository::from_config(&cfg));
        let signed = sign_token_cookie("tok", secret);
        let header = format!("better-auth.session_token={signed}");
        assert!(verifier.get_session(None, false).await.unwrap().is_none());
        assert!(matches!(
            verifier.get_session(Some(&header), false).await,
            Err(AuthPgError::InvalidConnectionUri)
        ));
        assert!(matches!(
            verifier.linked_epic_account(&sample_session("tok")).await,
            Err(AuthPgError::InvalidConnectionUri)
        ));
    }

    #[tokio::test]
    async fn connect_auth_pool_and_pg_repo_handle_unreachable_db() {
        let cfg = AuthPgConfig {
            connection_uri: "postgres://invalid:invalid@127.0.0.1:1/egdata".into(),
            secret: "secret".into(),
            cookie_cache_max_age_secs: 300,
        };
        assert!(connect_auth_pool(&cfg).await.is_err());

        let lazy_pool = PgPoolOptions::new()
            .acquire_timeout(std::time::Duration::from_millis(50))
            .connect_lazy(&cfg.connection_uri)
            .unwrap();
        let repo = PgSessionRepository::new(lazy_pool);
        assert!(repo.find_session_by_token("tok").await.is_err());
        assert!(
            repo.linked_epic_account(&sample_session("tok"))
                .await
                .is_err()
        );
    }
}
