//! Signed, operation-bound opaque cursor pagination tokens for `/v1`.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::Utc;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

use super::errors::{ProblemError, bad_request, service_unavailable};

type HmacSha256 = Hmac<Sha256>;

/// Current cursor token payload version.
pub const CURSOR_VERSION: u8 = 1;
/// Maximum cursor age in milliseconds (24 hours).
pub const MAX_AGE_MS: i64 = 24 * 60 * 60 * 1000;
/// Allowed future clock skew in milliseconds (5 minutes).
pub const FUTURE_SKEW_MS: i64 = 5 * 60 * 1000;
/// Fallback secret used only when `NODE_ENV=test`.
pub const DEV_SECRET: &str = "egdata-v1-local-cursor-secret-do-not-use-in-production";

/// Scalar sort value encoded in a keyset cursor tuple.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CursorSortValue {
    Null,
    Number(Number),
    String(String),
}

impl CursorSortValue {
    /// Creates a numeric sort value from an `i64`.
    pub fn from_i64(value: i64) -> Self {
        Self::Number(Number::from(value))
    }

    /// Creates a numeric sort value from a finite `f64`, or `Null` if non-finite.
    pub fn from_f64(value: f64) -> Self {
        Number::from_f64(value).map_or(Self::Null, Self::Number)
    }

    /// Returns true when the sort value is `Null`.
    pub fn is_null(&self) -> bool {
        matches!(self, Self::Null)
    }

    /// Returns the string slice if this is a `String` variant.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(s) => Some(s.as_str()),
            _ => None,
        }
    }

    /// Returns the `i64` representation if this is a `Number` representable as `i64`.
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Self::Number(n) => n.as_i64(),
            _ => None,
        }
    }

    /// Returns the `f64` representation if this is a `Number`.
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Self::Number(n) => n.as_f64(),
            _ => None,
        }
    }
}

impl From<&str> for CursorSortValue {
    fn from(value: &str) -> Self {
        Self::String(value.to_string())
    }
}

impl From<String> for CursorSortValue {
    fn from(value: String) -> Self {
        Self::String(value)
    }
}

impl From<i64> for CursorSortValue {
    fn from(value: i64) -> Self {
        Self::from_i64(value)
    }
}

impl From<Option<String>> for CursorSortValue {
    fn from(value: Option<String>) -> Self {
        match value {
            Some(s) => Self::String(s),
            None => Self::Null,
        }
    }
}

/// Ordered keyset sort tuple carried inside a cursor token.
pub type CursorSortTuple = Vec<CursorSortValue>;

/// Request parameters bound into a cursor token to prevent cross-query reuse.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorBinding {
    pub operation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filters: Option<BTreeMap<String, Value>>,
    pub ordering: String,
    pub country: String,
    pub locale: String,
    pub limit: u32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CursorPayload<T> {
    v: u8,
    operation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    filters: Option<Map<String, Value>>,
    filter_hash: String,
    ordering: String,
    country: String,
    locale: String,
    limit: u32,
    iat: i64,
    last: Vec<T>,
}

/// Resolves the HMAC secret from process environment variables.
pub fn resolve_cursor_secret(
    v1_cursor_secret: Option<&str>,
    node_env: Option<&str>,
    v1_cursor_dev_secret: Option<&str>,
) -> Option<String> {
    if let Some(configured) = v1_cursor_secret.map(str::trim).filter(|s| s.len() >= 32) {
        return Some(configured.to_string());
    }
    if node_env == Some("test") {
        return Some(DEV_SECRET.to_string());
    }
    if let Some(dev_secret) = v1_cursor_dev_secret
        .map(str::trim)
        .filter(|s| s.len() >= 32)
    {
        return Some(dev_secret.to_string());
    }
    None
}

/// Reads cursor secret configuration from `std::env`.
pub fn cursor_secret_from_env() -> Option<String> {
    let primary = std::env::var("V1_CURSOR_SECRET").ok();
    let node_env = std::env::var("NODE_ENV").ok();
    let dev = std::env::var("V1_CURSOR_DEV_SECRET").ok();
    resolve_cursor_secret(primary.as_deref(), node_env.as_deref(), dev.as_deref())
}

fn require_secret(secret: Option<&str>) -> Result<&str, ProblemError> {
    secret.filter(|s| !s.is_empty()).ok_or_else(|| {
        service_unavailable(
            "CURSOR_NOT_CONFIGURED",
            "Cursor pagination is not configured on this API origin.",
        )
    })
}

fn sign_payload(payload: &str, secret: &str) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key size");
    mac.update(payload.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn verify_payload_signature(payload: &str, signature: &[u8], secret: &str) -> bool {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key size");
    mac.update(payload.as_bytes());
    mac.verify_slice(signature).is_ok()
}

fn canonicalize(value: &Value, depth: usize) -> Value {
    if depth > 20 {
        return Value::Null;
    }
    match value {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|entry| canonicalize(entry, depth + 1))
                .collect(),
        ),
        Value::Object(map) => {
            let sorted: BTreeMap<&str, Value> = map
                .iter()
                .map(|(k, v)| (k.as_str(), canonicalize(v, depth + 1)))
                .collect();
            let mut out = Map::new();
            for (k, v) in sorted {
                out.insert(k.to_string(), v);
            }
            Value::Object(out)
        }
        _ => value.clone(),
    }
}

/// Produces the canonical SHA-256 hex digest for bound cursor filters.
pub fn normalize_filters(filters: Option<&BTreeMap<String, Value>>) -> String {
    let root = match filters {
        Some(map) => {
            let mut obj = Map::new();
            for (k, v) in map {
                obj.insert(k.clone(), v.clone());
            }
            Value::Object(obj)
        }
        None => Value::Object(Map::new()),
    };
    let canonical = canonicalize(&root, 0);
    let serialized = super::serialization::node_json(&canonical);
    let digest = Sha256::digest(serialized.as_bytes());
    hex::encode(digest)
}

/// Encodes a cursor token using an explicit secret and timestamp.
pub fn encode_cursor_with(
    binding: &CursorBinding,
    last: &[CursorSortValue],
    secret: Option<&str>,
    now_ms: i64,
) -> Result<String, ProblemError> {
    encode_cursor_with_filter_order(binding, last, secret, now_ms, &[])
}

/// Node signs the original JSON object order, but hashes the canonicalized filters.
pub fn encode_cursor_with_filter_order(
    binding: &CursorBinding,
    last: &[CursorSortValue],
    secret: Option<&str>,
    now_ms: i64,
    keys: &[&str],
) -> Result<String, ProblemError> {
    encode_ordered_cursor(binding, last, secret, now_ms, keys)
}

/// Signs the OpenSearch sort values without changing the types returned by the index.
pub fn encode_search_cursor(
    binding: &CursorBinding,
    last: &[Value],
    secret: Option<&str>,
    now_ms: i64,
    keys: &[&str],
) -> Result<String, ProblemError> {
    encode_ordered_cursor(binding, last, secret, now_ms, keys)
}

fn encode_ordered_cursor<T: Serialize + Clone>(
    binding: &CursorBinding,
    last: &[T],
    secret: Option<&str>,
    now_ms: i64,
    keys: &[&str],
) -> Result<String, ProblemError> {
    let secret = require_secret(secret)?;
    let filters = binding.filters.as_ref().map(|original| {
        let mut remaining = original.clone();
        let mut ordered = Map::new();
        for &key in keys {
            if let Some(value) = remaining.remove(key) {
                ordered.insert(key.to_owned(), value);
            }
        }
        ordered.extend(remaining);
        ordered
    });
    let payload = CursorPayload {
        v: CURSOR_VERSION,
        operation: binding.operation.clone(),
        filters,
        filter_hash: normalize_filters(binding.filters.as_ref()),
        ordering: binding.ordering.clone(),
        country: binding.country.clone(),
        locale: binding.locale.clone(),
        limit: binding.limit,
        iat: now_ms,
        last: last.to_vec(),
    };
    let json = super::serialization::node_json(
        &serde_json::to_value(&payload).expect("cursor payload is serializable"),
    );
    let body = URL_SAFE_NO_PAD.encode(json.as_bytes());
    let sig = sign_payload(&body, secret);
    Ok(format!("{body}.{}", URL_SAFE_NO_PAD.encode(sig)))
}

/// Encodes a cursor token using environment configuration and current UTC time.
pub fn encode_cursor(
    binding: &CursorBinding,
    last: &[CursorSortValue],
) -> Result<String, ProblemError> {
    let secret = cursor_secret_from_env();
    encode_cursor_with(
        binding,
        last,
        secret.as_deref(),
        Utc::now().timestamp_millis(),
    )
}

/// Verifies and decodes a cursor token using an explicit secret and timestamp.
pub fn decode_cursor_with(
    raw: &str,
    binding: &CursorBinding,
    secret: Option<&str>,
    now_ms: i64,
) -> Result<CursorSortTuple, ProblemError> {
    decode_signed_cursor(raw, binding, secret, now_ms)
}

/// Verifies a search cursor and preserves the JSON types used in search_after.
pub fn decode_search_cursor(
    raw: &str,
    binding: &CursorBinding,
    secret: Option<&str>,
    now_ms: i64,
) -> Result<Vec<Value>, ProblemError> {
    decode_signed_cursor(raw, binding, secret, now_ms)
}

fn decode_signed_cursor<T: serde::de::DeserializeOwned>(
    raw: &str,
    binding: &CursorBinding,
    secret: Option<&str>,
    now_ms: i64,
) -> Result<Vec<T>, ProblemError> {
    let mut parts = raw.trim().split('.');
    let body = parts.next().unwrap_or("");
    let signature = parts.next().unwrap_or("");
    let extra = parts.next();

    if body.is_empty() || signature.is_empty() || extra.is_some() {
        return Err(bad_request(
            "INVALID_CURSOR",
            "The cursor is malformed. Use the `nextCursor` value from a previous response.",
            None,
        ));
    }

    let secret = require_secret(secret)?;
    let supplied = URL_SAFE_NO_PAD.decode(signature).map_err(|_| {
        bad_request(
            "INVALID_CURSOR",
            "The cursor signature is invalid. Use the `nextCursor` value from a previous response.",
            None,
        )
    })?;

    if supplied.len() != 32 || !verify_payload_signature(body, &supplied, secret) {
        return Err(bad_request(
            "INVALID_CURSOR",
            "The cursor signature is invalid. Use the `nextCursor` value from a previous response.",
            None,
        ));
    }

    let decoded = URL_SAFE_NO_PAD.decode(body).map_err(|_| {
        bad_request(
            "INVALID_CURSOR",
            "The cursor is malformed. Use the `nextCursor` value from a previous response.",
            None,
        )
    })?;

    let payload: CursorPayload<T> = serde_json::from_slice(&decoded).map_err(|_| {
        bad_request(
            "INVALID_CURSOR",
            "The cursor is malformed. Use the `nextCursor` value from a previous response.",
            None,
        )
    })?;

    if payload.v != CURSOR_VERSION {
        return Err(bad_request(
            "INVALID_CURSOR",
            "The cursor is not supported by this API version.",
            None,
        ));
    }

    if now_ms - payload.iat > MAX_AGE_MS {
        return Err(bad_request(
            "EXPIRED_CURSOR",
            "The cursor expired after 24 hours. Restart pagination from the first page.",
            None,
        ));
    }

    if now_ms < payload.iat - FUTURE_SKEW_MS {
        return Err(bad_request(
            "INVALID_CURSOR",
            "The cursor issue time is invalid.",
            None,
        ));
    }

    let mismatch = payload.operation != binding.operation
        || payload.ordering != binding.ordering
        || payload.country != binding.country
        || payload.locale != binding.locale
        || payload.limit != binding.limit
        || payload.filter_hash != normalize_filters(binding.filters.as_ref());

    if mismatch {
        return Err(bad_request(
            "CURSOR_MISMATCH",
            "The cursor was issued for a different operation, filter set, ordering, country, locale, or page size. Restart pagination with the new parameters.",
            None,
        ));
    }

    Ok(payload.last)
}

/// Verifies and decodes a cursor token using environment configuration and current UTC time.
pub fn decode_cursor(raw: &str, binding: &CursorBinding) -> Result<CursorSortTuple, ProblemError> {
    let secret = cursor_secret_from_env();
    decode_cursor_with(
        raw,
        binding,
        secret.as_deref(),
        Utc::now().timestamp_millis(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TEST_SECRET: &str = "0123456789abcdef0123456789abcdef";

    fn sample_binding() -> CursorBinding {
        let mut filters = BTreeMap::new();
        filters.insert("b".into(), json!({"z": 1, "a": 2}));
        filters.insert("a".into(), json!(["x", "y"]));
        CursorBinding {
            operation: "listOffers".into(),
            filters: Some(filters),
            ordering: "lastModifiedDate:desc,id:asc".into(),
            country: "US".into(),
            locale: "en-US".into(),
            limit: 20,
        }
    }

    #[test]
    fn absent_filter_keys_do_not_change_a_signed_cursor() {
        let binding = sample_binding();
        let baseline = encode_cursor_with(&binding, &[], Some(TEST_SECRET), 7).unwrap();
        let ordered =
            encode_cursor_with_filter_order(&binding, &[], Some(TEST_SECRET), 7, &["absent", "a"])
                .unwrap();
        assert_eq!(ordered, baseline);
    }

    #[test]
    fn test_resolve_cursor_secret() {
        assert_eq!(resolve_cursor_secret(Some("  short  "), None, None), None);
        assert_eq!(
            resolve_cursor_secret(Some(&format!("  {TEST_SECRET}  ")), None, None),
            Some(TEST_SECRET.to_string())
        );
        assert_eq!(
            resolve_cursor_secret(None, Some("test"), None),
            Some(DEV_SECRET.to_string())
        );
        assert_eq!(
            resolve_cursor_secret(None, Some("production"), Some(TEST_SECRET)),
            Some(TEST_SECRET.to_string())
        );
        assert_eq!(
            resolve_cursor_secret(None, Some("production"), Some("too-short")),
            None
        );
    }

    #[test]
    fn test_cursor_sort_value_helpers() {
        let null_val = CursorSortValue::from(None::<String>);
        assert!(null_val.is_null());
        assert_eq!(null_val.as_str(), None);
        assert_eq!(null_val.as_i64(), None);
        assert_eq!(null_val.as_f64(), None);

        let str_val = CursorSortValue::from("abc");
        assert!(!str_val.is_null());
        assert_eq!(str_val.as_str(), Some("abc"));
        let owned_str = CursorSortValue::from(Some("def".to_string()));
        assert_eq!(owned_str.as_str(), Some("def"));
        let from_string = CursorSortValue::from("ghi".to_string());
        assert_eq!(from_string.as_str(), Some("ghi"));

        let int_val = CursorSortValue::from(42_i64);
        assert_eq!(int_val.as_i64(), Some(42));
        assert_eq!(int_val.as_f64(), Some(42.0));

        let float_val = CursorSortValue::from_f64(1.5);
        assert_eq!(float_val.as_f64(), Some(1.5));
        assert!(CursorSortValue::from_f64(f64::NAN).is_null());
    }

    #[test]
    fn test_canonical_filter_hashing() {
        let mut f1 = BTreeMap::new();
        f1.insert("x".into(), json!({"b": 2, "a": 1}));
        let mut f2 = BTreeMap::new();
        f2.insert("x".into(), json!({"a": 1, "b": 2}));
        assert_eq!(normalize_filters(Some(&f1)), normalize_filters(Some(&f2)));

        // Deeply nested value > depth 20 clamps to null
        let mut deep = json!(1);
        for _ in 0..25 {
            deep = json!({ "nested": deep });
        }
        let mut f_deep = BTreeMap::new();
        f_deep.insert("deep".into(), deep);
        assert_eq!(normalize_filters(Some(&f_deep)).len(), 64);
        assert_eq!(normalize_filters(None).len(), 64);
    }

    #[test]
    fn test_encode_decode_roundtrip_and_errors() {
        let binding = sample_binding();
        let now = 1_700_000_000_000_i64;
        let tuple = vec![
            CursorSortValue::from("2025-01-01T00:00:00.000Z"),
            CursorSortValue::from(42_i64),
            CursorSortValue::Null,
        ];

        // Missing secret -> 503 CURSOR_NOT_CONFIGURED
        let no_secret_err = encode_cursor_with(&binding, &tuple, None, now).unwrap_err();
        assert_eq!(no_secret_err.status, 503);
        assert_eq!(no_secret_err.code, "CURSOR_NOT_CONFIGURED");

        let token = encode_cursor_with(&binding, &tuple, Some(TEST_SECRET), now).unwrap();
        let decoded = decode_cursor_with(&token, &binding, Some(TEST_SECRET), now + 1000).unwrap();
        assert_eq!(decoded, tuple);

        // Malformed tokens
        for bad in ["", "onlyone", "a.b.c", ".sig", "body."] {
            let err = decode_cursor_with(bad, &binding, Some(TEST_SECRET), now).unwrap_err();
            assert_eq!(err.code, "INVALID_CURSOR");
        }

        // Missing secret on decode
        let err = decode_cursor_with(&token, &binding, None, now).unwrap_err();
        assert_eq!(err.code, "CURSOR_NOT_CONFIGURED");

        // Invalid signature encoding / length / mismatch
        let err = decode_cursor_with("abc.!!!", &binding, Some(TEST_SECRET), now).unwrap_err();
        assert_eq!(err.code, "INVALID_CURSOR");
        let short_sig = format!("abc.{}", URL_SAFE_NO_PAD.encode(b"short"));
        let err = decode_cursor_with(&short_sig, &binding, Some(TEST_SECRET), now).unwrap_err();
        assert_eq!(err.code, "INVALID_CURSOR");

        let wrong_secret_token = encode_cursor_with(
            &binding,
            &tuple,
            Some("ffffffffffffffffffffffffffffffff"),
            now,
        )
        .unwrap();
        let err =
            decode_cursor_with(&wrong_secret_token, &binding, Some(TEST_SECRET), now).unwrap_err();
        assert_eq!(err.code, "INVALID_CURSOR");

        // Valid signature over non-base64 body
        let bad_b64_sig = sign_payload("not!base64", TEST_SECRET);
        let bad_b64_token = format!("not!base64.{}", URL_SAFE_NO_PAD.encode(bad_b64_sig));
        assert_eq!(
            decode_cursor_with(&bad_b64_token, &binding, Some(TEST_SECRET), now)
                .unwrap_err()
                .code,
            "INVALID_CURSOR"
        );

        // Valid signature over non-JSON body
        let bad_json_body = URL_SAFE_NO_PAD.encode(b"not-json");
        let sig = sign_payload(&bad_json_body, TEST_SECRET);
        let bad_json_token = format!("{bad_json_body}.{}", URL_SAFE_NO_PAD.encode(sig));
        let err =
            decode_cursor_with(&bad_json_token, &binding, Some(TEST_SECRET), now).unwrap_err();
        assert_eq!(err.code, "INVALID_CURSOR");

        // Unsupported version
        let v2_payload = serde_json::to_vec(&json!({
            "v": 2,
            "operation": "listOffers",
            "filterHash": normalize_filters(binding.filters.as_ref()),
            "ordering": binding.ordering,
            "country": binding.country,
            "locale": binding.locale,
            "limit": binding.limit,
            "iat": now,
            "last": []
        }))
        .unwrap();
        let v2_body = URL_SAFE_NO_PAD.encode(v2_payload);
        let v2_sig = sign_payload(&v2_body, TEST_SECRET);
        let v2_token = format!("{v2_body}.{}", URL_SAFE_NO_PAD.encode(v2_sig));
        let err = decode_cursor_with(&v2_token, &binding, Some(TEST_SECRET), now).unwrap_err();
        assert_eq!(err.code, "INVALID_CURSOR");

        // Expired cursor (> 24h)
        let err = decode_cursor_with(&token, &binding, Some(TEST_SECRET), now + MAX_AGE_MS + 1)
            .unwrap_err();
        assert_eq!(err.code, "EXPIRED_CURSOR");

        // Future skew (> 5m)
        let err = decode_cursor_with(
            &token,
            &binding,
            Some(TEST_SECRET),
            now - FUTURE_SKEW_MS - 1,
        )
        .unwrap_err();
        assert_eq!(err.code, "INVALID_CURSOR");

        // Binding mismatches
        let mut different_op = binding.clone();
        different_op.operation = "other".into();
        assert_eq!(
            decode_cursor_with(&token, &different_op, Some(TEST_SECRET), now)
                .unwrap_err()
                .code,
            "CURSOR_MISMATCH"
        );

        let mut different_limit = binding.clone();
        different_limit.limit = 50;
        assert_eq!(
            decode_cursor_with(&token, &different_limit, Some(TEST_SECRET), now)
                .unwrap_err()
                .code,
            "CURSOR_MISMATCH"
        );
    }

    #[test]
    fn test_env_wrappers() {
        let binding = sample_binding();
        let tuple = vec![CursorSortValue::from("id-1")];
        let _ = cursor_secret_from_env();
        let _ = encode_cursor(&binding, &tuple);
        assert_eq!(
            decode_cursor("malformed", &binding).unwrap_err().code,
            "INVALID_CURSOR"
        );
    }
}
