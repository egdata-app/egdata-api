//! Shared Axum helpers for `/v1` handlers: Problem responses, envelopes, strict query, cache.

use std::collections::{BTreeMap, BTreeSet};

use axum::{
    body::Body,
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use bson::Bson;
use egdata_core::ports::ResponseCachePort;
use egdata_core::v1::serialization::node_json;
use egdata_core::v1::{
    PROBLEM_CONTENT_TYPE, ProblemDetail, ProblemError, ProblemIssue, problem_type,
};
use serde_json::{Value, json};

// JS Set and Array.includes compare object-valued Mongo fields by reference.
// Independent query results can only match on a primitive value.
#[derive(PartialEq, Eq, Hash)]
pub enum PrimitiveId<'a> {
    Missing,
    Null,
    Text(&'a str),
    Number(u64),
    Bool(bool),
}

pub fn primitive_id(value: Option<&Bson>) -> Option<PrimitiveId<'_>> {
    let number = match value {
        None => return Some(PrimitiveId::Missing),
        Some(Bson::Null | Bson::Undefined) => return Some(PrimitiveId::Null),
        Some(Bson::String(s) | Bson::Symbol(s)) => return Some(PrimitiveId::Text(s)),
        Some(Bson::Boolean(b)) => return Some(PrimitiveId::Bool(*b)),
        Some(Bson::Int32(n)) => f64::from(*n),
        Some(Bson::Int64(n)) if n.unsigned_abs() <= (1 << 53) => *n as f64,
        Some(Bson::Double(n)) => *n,
        _ => return None,
    };
    Some(PrimitiveId::Number(if number == 0.0 {
        0
    } else if number.is_nan() {
        f64::NAN.to_bits()
    } else {
        number.to_bits()
    }))
}

/// Per-request `/v1` context inserted by `v1_context` middleware.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V1RequestContext {
    pub request_id: String,
    pub key: Option<V1GatewayKey>,
}

/// Finish a read handler with the same envelope, request ID and errors as the v1 router.
pub fn read_response(
    request: &axum::extract::Request,
    result: Result<(Value, Value), ProblemError>,
) -> Response {
    read_envelope_response(
        request,
        result.map(|(data, meta)| json!({"data":data,"meta":meta})),
    )
}

/// A historical cached page can omit the data property entirely.
pub fn read_envelope_response(
    request: &axum::extract::Request,
    result: Result<Value, ProblemError>,
) -> Response {
    let id = request
        .extensions()
        .get::<V1RequestContext>()
        .map(|ctx| ctx.request_id.as_str());
    match result {
        Ok(envelope) => json_envelope_response(
            request.method(),
            request.uri().path(),
            id.unwrap_or_default(),
            envelope,
        ),
        Err(error) => problem_response(&error, request.uri().path(), id),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V1GatewayKey {
    pub key_id: String,
    pub tier: String,
    pub project_id: Option<String>,
}

pub const V1_CACHE_PREFIX: &str = "v1:";

pub fn v1_cache_key(operation: &str, parts: &BTreeMap<&str, Value>) -> String {
    let mut segments = Vec::with_capacity(parts.len());
    for (k, v) in parts {
        if v.is_null() {
            continue;
        }
        segments.push(format!("{k}={v}"));
    }
    if segments.is_empty() {
        format!("{V1_CACHE_PREFIX}{operation}:")
    } else {
        format!("{V1_CACHE_PREFIX}{operation}:{}", segments.join(":"))
    }
}

pub async fn v1_cache_get(cache: &dyn ResponseCachePort, key: &str) -> Option<Value> {
    match cache.get(key).await {
        Ok(Some(raw)) => serde_json::from_str::<Value>(&raw)
            .ok()
            .filter(|value| !value.is_null()),
        _ => None,
    }
}

pub async fn v1_cache_set(
    cache: &dyn ResponseCachePort,
    key: &str,
    value: &Value,
    ttl_seconds: u64,
) {
    let _ = cache.set(key, &node_json(value), ttl_seconds).await;
}

pub async fn cached_total(
    state: &crate::state::AppState,
    operation: &str,
    parts: &[(&str, Value)],
    ttl: u64,
    loader: impl Future<Output = Result<Value, ProblemError>>,
) -> Result<Value, ProblemError> {
    let key = v1_cache_key(
        &format!("{operation}.total"),
        &parts.iter().cloned().collect(),
    );
    if let Some(hit) = v1_cache_get(state.cache.as_ref(), &key).await {
        return Ok(hit);
    }
    let total = loader.await?;
    v1_cache_set(state.cache.as_ref(), &key, &total, ttl).await;
    Ok(total)
}

// Hono getPath applies decodeURI, preserving reserved delimiters and encoded
// percent signs. Invalid UTF-8 runs remain encoded (its tryDecode fallback).
fn hono_instance_path(path: &str) -> String {
    static ENCODED: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"(?:%[0-9A-Fa-f]{2})+").unwrap());
    let path = path.replace("%25", "%2525");
    ENCODED
        .replace_all(&path, |captures: &regex::Captures<'_>| {
            let run = &captures[0];
            let bytes = run
                .as_bytes()
                .chunks_exact(3)
                .map(|chunk| {
                    u8::from_str_radix(std::str::from_utf8(&chunk[1..]).unwrap(), 16).unwrap()
                })
                .collect::<Vec<_>>();
            if std::str::from_utf8(&bytes).is_err() {
                return run.to_owned();
            }
            let mut decoded = Vec::new();
            for (index, byte) in bytes.iter().enumerate() {
                if b";/?:@&=+$,#".contains(byte) {
                    decoded.extend_from_slice(&run.as_bytes()[index * 3..index * 3 + 3]);
                } else {
                    decoded.push(*byte);
                }
            }
            String::from_utf8(decoded).unwrap()
        })
        .into_owned()
}

/// Converts a `ProblemError` + request path + optional requestId into an RFC 9457 Axum response.
pub fn problem_response(
    err: &ProblemError,
    instance_path: &str,
    request_id: Option<&str>,
) -> Response {
    let status = StatusCode::from_u16(err.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let detail = ProblemDetail {
        problem_type: problem_type(&err.code),
        title: err.title.clone(),
        status: err.status,
        detail: err.detail.clone(),
        instance: Some(hono_instance_path(instance_path)),
        code: err.code.clone(),
        request_id: request_id.map(str::to_string),
        errors: err.errors.clone(),
    };
    let body = serde_json::to_string(&detail).unwrap_or_else(|_| "{}".to_string());
    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static("content-type"),
        HeaderValue::from_static(PROBLEM_CONTENT_TYPE),
    );
    headers.insert(
        HeaderName::from_static("cache-control"),
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(
        HeaderName::from_static("cdn-cache-control"),
        HeaderValue::from_static("no-store"),
    );
    headers.insert(
        HeaderName::from_static("cloudflare-cdn-cache-control"),
        HeaderValue::from_static("no-store"),
    );
    if let Some(req_id) = request_id
        && let Ok(val) = HeaderValue::from_str(req_id)
    {
        headers.insert(HeaderName::from_static("x-request-id"), val);
    }
    if let Some(extra) = &err.headers {
        for (k, v) in extra {
            if let (Ok(name), Ok(val)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(v),
            ) {
                headers.insert(name, val);
            }
        }
    }
    let mut resp = Response::new(Body::from(body));
    *resp.status_mut() = status;
    *resp.headers_mut() = headers;
    resp
}

pub fn json_success(
    method: &Method,
    path: &str,
    request_id: &str,
    data: Value,
    meta: Option<Value>,
) -> Response {
    json_envelope_response(
        method,
        path,
        request_id,
        json!({"data":data,"meta":meta.unwrap_or_else(||json!({}))}),
    )
}

/// Builds the success response after its endpoint-specific fields have been serialized.
pub fn json_envelope_response(
    method: &Method,
    path: &str,
    request_id: &str,
    envelope: Value,
) -> Response {
    let is_public = path == "/v1/health" || path == "/v1/open-api.json";
    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static("content-type"),
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    if let Ok(val) = HeaderValue::from_str(request_id) {
        headers.insert(HeaderName::from_static("x-request-id"), val);
    }
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    if is_public {
        headers.insert(
            HeaderName::from_static("cache-control"),
            HeaderValue::from_static("public, max-age=0, must-revalidate"),
        );
        headers.insert(
            HeaderName::from_static("cdn-cache-control"),
            HeaderValue::from_static("no-store"),
        );
    } else {
        headers.insert(
            HeaderName::from_static("cache-control"),
            HeaderValue::from_static("private, no-cache"),
        );
        headers.insert(
            HeaderName::from_static("cdn-cache-control"),
            HeaderValue::from_static("no-store"),
        );
        headers.insert(
            HeaderName::from_static("cloudflare-cdn-cache-control"),
            HeaderValue::from_static("no-store"),
        );
    }
    let body = if *method == Method::HEAD {
        Body::empty()
    } else {
        Body::from(node_json(&envelope))
    };
    let mut resp = Response::new(body);
    *resp.status_mut() = StatusCode::OK;
    *resp.headers_mut() = headers;
    resp
}

/// Validate the 200 UTF-16-unit search string and enum fields in Node schema order.
pub fn search_query_issues(
    params: &BTreeMap<String, String>,
    text_field: &str,
    enums: &[(&str, &[&str])],
) -> Vec<ProblemIssue> {
    let mut issues = Vec::new();
    let mut issue = |field: &str, code: &str, message: String| {
        issues.push(ProblemIssue {
            parameter: Some(field.into()),
            pointer: Some(format!("/{field}")),
            code: code.into(),
            message,
        })
    };
    if params
        .get(text_field)
        .is_some_and(|q| q.encode_utf16().count() > 200)
    {
        issue(
            text_field,
            "TOO_BIG",
            "Too big: expected string to have <=200 characters".into(),
        );
    }
    for &(field, options) in enums {
        if params
            .get(field)
            .is_some_and(|value| !options.contains(&value.as_str()))
        {
            let choices = options
                .iter()
                .map(|value| format!("\"{value}\""))
                .collect::<Vec<_>>()
                .join("|");
            issue(
                field,
                "INVALID_VALUE",
                format!("Invalid option: expected one of {choices}"),
            );
        }
    }
    issues
}

/// Parse a Hono-style query string and reject unknown keys.
pub fn parse_strict_query_uri(
    uri: &Uri,
    allowed_keys: &[&str],
) -> Result<BTreeMap<String, String>, ProblemError> {
    parse_validated_query(uri, allowed_keys, |_| Vec::new())
}

pub fn parse_validated_query(
    uri: &Uri,
    allowed_keys: &[&str],
    validate: impl FnOnce(&BTreeMap<String, String>) -> Vec<ProblemIssue>,
) -> Result<BTreeMap<String, String>, ProblemError> {
    let mut params = BTreeMap::new();
    let mut unknown = Vec::new();
    let allowed: BTreeSet<&str> = allowed_keys.iter().copied().collect();
    if let Some(query) = uri.query() {
        for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
            // Hono's query() keeps the first occurrence of a duplicate key.
            if params.contains_key(key.as_ref()) {
                continue;
            }
            if !allowed.contains(key.as_ref()) {
                unknown.push(key.to_string());
            }
            params.insert(key.into_owned(), value.into_owned());
        }
    }
    let mut issues = validate(&params);
    if !unknown.is_empty() {
        let label = if unknown.len() == 1 {
            "Unrecognized key"
        } else {
            "Unrecognized keys"
        };
        let keys = unknown
            .iter()
            .map(|key| format!("\"{key}\""))
            .collect::<Vec<_>>()
            .join(", ");
        issues.push(ProblemIssue {
            pointer: None,
            parameter: None,
            code: "UNRECOGNIZED_KEYS".into(),
            message: format!("{label}: {keys}"),
        });
    }
    if !issues.is_empty() {
        return Err(ProblemError::new(
            400,
            "INVALID_QUERY",
            "One or more query parameters are invalid or not supported.",
        )
        .with_errors(issues));
    }
    Ok(params)
}

pub struct V1ErrorResponse {
    pub error: ProblemError,
    pub path: String,
    pub request_id: Option<String>,
}

impl IntoResponse for V1ErrorResponse {
    fn into_response(self) -> Response {
        problem_response(&self.error, &self.path, self.request_id.as_deref())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use egdata_core::error::CoreError;
    use http_body_util::BodyExt;
    use tokio::sync::Mutex;

    struct MemCache(Mutex<BTreeMap<String, String>>);

    #[async_trait]
    impl ResponseCachePort for MemCache {
        async fn get(&self, key: &str) -> Result<Option<String>, CoreError> {
            Ok(self.0.lock().await.get(key).cloned())
        }
        async fn set(&self, key: &str, value: &str, _ttl: u64) -> Result<(), CoreError> {
            self.0
                .lock()
                .await
                .insert(key.to_string(), value.to_string());
            Ok(())
        }
        async fn del(&self, key: &str) -> Result<(), CoreError> {
            self.0.lock().await.remove(key);
            Ok(())
        }
        async fn ping(&self) -> Result<bool, CoreError> {
            Ok(true)
        }
    }

    #[tokio::test]
    async fn cache_helpers_and_keys() {
        let mut parts = BTreeMap::new();
        parts.insert("country", json!("US"));
        parts.insert("empty", Value::Null);
        parts.insert("locale", json!("en-US"));
        assert_eq!(
            v1_cache_key("offers.detail", &parts),
            r#"v1:offers.detail:country="US":locale="en-US""#
        );
        assert_eq!(v1_cache_key("stats", &BTreeMap::new()), "v1:stats:");

        let cache = MemCache(Mutex::new(BTreeMap::new()));
        assert!(v1_cache_get(&cache, "missing").await.is_none());
        v1_cache_set(&cache, "null", &Value::Null, 60).await;
        assert!(v1_cache_get(&cache, "null").await.is_none());
        for value in [json!(false), json!(0), json!(""), json!([])] {
            v1_cache_set(&cache, "falsey", &value, 60).await;
            assert_eq!(v1_cache_get(&cache, "falsey").await, Some(value));
        }
        v1_cache_set(&cache, "k", &json!({"ok": true}), 60).await;
        assert_eq!(v1_cache_get(&cache, "k").await, Some(json!({"ok": true})));
    }

    #[tokio::test]
    async fn problem_and_success_responses_match_headers() {
        let err = ProblemError::new(405, "METHOD_NOT_ALLOWED", "nope")
            .with_headers(BTreeMap::from([("Allow".into(), "GET, HEAD".into())]));
        let resp = V1ErrorResponse {
            error: err,
            path: "/v1/offers".into(),
            request_id: Some("req_123".into()),
        }
        .into_response();
        assert_eq!(resp.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            PROBLEM_CONTENT_TYPE
        );
        assert_eq!(resp.headers().get("allow").unwrap(), "GET, HEAD");
        assert_eq!(resp.headers().get("x-request-id").unwrap(), "req_123");

        let ok = json_success(
            &Method::GET,
            "/v1/offers",
            "req_1",
            json!([1, 16167389303.0, -0.0, 1e-7, 1e21]),
            None,
        );
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(
            ok.headers().get("cache-control").unwrap(),
            "private, no-cache"
        );
        let bytes = ok.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            bytes.as_ref(),
            br#"{"data":[1,16167389303,0,1e-7,1e+21],"meta":{}}"#
        );

        let head = json_success(
            &Method::HEAD,
            "/v1/health",
            "req_2",
            json!({"ok":true}),
            Some(json!({"v":1})),
        );
        assert_eq!(
            head.headers().get("cache-control").unwrap(),
            "public, max-age=0, must-revalidate"
        );
        let head_bytes = head.into_body().collect().await.unwrap().to_bytes();
        assert!(head_bytes.is_empty());
    }

    #[test]
    fn strict_query_uri_rejects_unknown_keys() {
        let uri: Uri = "/v1/offers?country=US&locale=en-US".parse().unwrap();
        let parsed = parse_strict_query_uri(&uri, &["country", "locale"]).unwrap();
        assert_eq!(parsed.get("country").unwrap(), "US");

        let bad: Uri = "/v1/offers?country=US&bogus=1".parse().unwrap();
        let err = parse_strict_query_uri(&bad, &["country"]).unwrap_err();
        assert_eq!(err.code, "INVALID_QUERY");
        assert_eq!(err.errors.as_ref().unwrap().len(), 1);
    }
}
