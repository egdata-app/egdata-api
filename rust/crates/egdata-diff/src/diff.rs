//! Differential oracle engine comparing Node (:4000) and Rust (:4001) responses.

use std::collections::{BTreeMap, BTreeSet};

use http::HeaderMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DEFAULT_COMPARED_HEADERS: &[&str] = &[
    "content-type",
    "cache-control",
    "cdn-cache-control",
    "allow",
    "etag",
    "x-route-template",
];

pub const DEFAULT_IGNORED_JSON_KEYS: &[&str] = &["requestId", "executionMs", "durationMs"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiffCase {
    pub name: String,
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub body: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffMismatch {
    pub case_name: String,
    pub category: String,
    pub detail: String,
}

pub fn extract_compared_headers(headers: &HeaderMap, names: &[&str]) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for &name in names {
        if let Some(val) = headers.get(name).and_then(|v| v.to_str().ok()) {
            out.insert(name.to_ascii_lowercase(), val.to_string());
        }
    }
    out
}

pub fn strip_volatile_json(value: &Value, ignored_keys: &BTreeSet<String>) -> Value {
    match value {
        Value::Object(map) => {
            let mut next = serde_json::Map::new();
            for (k, v) in map {
                if ignored_keys.contains(k) {
                    continue;
                }
                next.insert(k.clone(), strip_volatile_json(v, ignored_keys));
            }
            Value::Object(next)
        }
        Value::Array(arr) => Value::Array(
            arr.iter()
                .map(|v| strip_volatile_json(v, ignored_keys))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Check the validator against the bytes each origin actually served before normalizing
/// a route-specific measurement. Preserve status, result data, and validator strength.
pub fn normalize_timed_response(path: &str, response: &mut RecordedResponse) {
    use sha1::{Digest, Sha1};
    enum Measurement {
        Health,
        Search,
    }
    let measurement = match path {
        "/v1/health" if matches!(response.status, 200 | 503) => Measurement::Health,
        "/v1/search"
        | "/v1/free-games/search"
        | "/v1/search/changelog"
        | "/v1/multisearch/offers"
        | "/v1/multisearch/items"
        | "/v1/multisearch/sellers"
            if response.status == 200 =>
        {
            Measurement::Search
        }
        _ => return,
    };
    let Ok(mut body) = serde_json::from_slice::<Value>(&response.body) else {
        return;
    };
    if serde_json::to_vec(&body).expect("serializable JSON response") != response.body {
        return;
    }
    let duration = |v: &Value| v.as_u64().is_some_and(|n| n < (1_u64 << 53));
    let etag = response.headers.get("etag");
    let weak = etag.is_some_and(|value| value.starts_with("W/"));
    let tag = |bytes: &[u8]| {
        format!(
            "{}\"{:x}\"",
            if weak { "W/" } else { "" },
            Sha1::digest(bytes)
        )
    };
    if etag.is_some_and(|value| *value != tag(&response.body)) {
        return;
    }
    match measurement {
        Measurement::Health => {
            let Some(services) = body.pointer_mut("/data/services") else {
                return;
            };
            for name in ["redis", "mongodb"] {
                let service = &mut services[name];
                match (service["status"].as_str(), &service["latencyMs"]) {
                    (Some("ok"), millis) if duration(millis) => {
                        service["latencyMs"] = Value::from(0)
                    }
                    (Some("error"), Value::Null) if service.get("latencyMs").is_some() => (),
                    _ => return,
                }
            }
        }
        Measurement::Search => {
            let Some(took) = body.pointer_mut("/meta/result/tookMs") else {
                return;
            };
            if !duration(took) {
                return;
            }
            *took = Value::from(0);
        }
    }
    response.body = serde_json::to_vec(&body).expect("serializable JSON response");
    if etag.is_some() {
        response.headers.insert("etag".into(), tag(&response.body));
    }
}

pub fn compare_responses(
    case_name: &str,
    node: &RecordedResponse,
    rust: &RecordedResponse,
    compared_headers: &[&str],
    ignored_json_keys: &[&str],
) -> Vec<DiffMismatch> {
    let mut mismatches = Vec::new();

    if node.status != rust.status {
        mismatches.push(DiffMismatch {
            case_name: case_name.to_string(),
            category: "status".to_string(),
            detail: format!("node={} rust={}", node.status, rust.status),
        });
    }

    for &hdr in compared_headers {
        let key = hdr.to_ascii_lowercase();
        let n_val = node.headers.get(&key);
        let r_val = rust.headers.get(&key);
        if n_val != r_val {
            mismatches.push(DiffMismatch {
                case_name: case_name.to_string(),
                category: format!("header:{key}"),
                detail: format!("node={n_val:?} rust={r_val:?}"),
            });
        }
    }

    let ignored: BTreeSet<String> = ignored_json_keys.iter().map(|s| (*s).to_string()).collect();
    match (
        serde_json::from_slice::<Value>(&node.body),
        serde_json::from_slice::<Value>(&rust.body),
    ) {
        (Ok(n_json), Ok(r_json)) => {
            let n_clean = strip_volatile_json(&n_json, &ignored);
            let r_clean = strip_volatile_json(&r_json, &ignored);
            if n_clean != r_clean {
                mismatches.push(DiffMismatch {
                    case_name: case_name.to_string(),
                    category: "json_body".to_string(),
                    detail: format!("node={n_clean} rust={r_clean}"),
                });
            }
        }
        _ => {
            if node.body != rust.body {
                mismatches.push(DiffMismatch {
                    case_name: case_name.to_string(),
                    category: "raw_body".to_string(),
                    detail: format!("node_len={} rust_len={}", node.body.len(), rust.body.len()),
                });
            }
        }
    }

    mismatches
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::{HeaderName, HeaderValue};

    #[test]
    fn health_only_normalizes_successful_timings_and_valid_etags() {
        use sha1::{Digest, Sha1};
        let mut response = RecordedResponse {
            status: 503, headers: BTreeMap::new(),
            body: br#"{"data":{"services":{"redis":{"status":"ok","latencyMs":17},"mongodb":{"status":"error","latencyMs":null}}}}"#.to_vec(),
        };
        for weak in ["", "W/"] {
            let mut valid = response.clone();
            valid.headers.insert(
                "etag".into(),
                format!("{weak}\"{:x}\"", Sha1::digest(&valid.body)),
            );
            normalize_timed_response("/v1/health", &mut valid);
            assert!(String::from_utf8_lossy(&valid.body).contains("\"latencyMs\":0"));
            assert_eq!(
                valid.headers["etag"],
                format!("{weak}\"{:x}\"", Sha1::digest(valid.body))
            );
        }
        response.headers.insert("etag".into(), "malformed".into());
        let original = response.clone();
        normalize_timed_response("/v1/health", &mut response);
        assert_eq!(response, original);
        response.headers.clear();
        normalize_timed_response("/v1/health", &mut response);
        assert_ne!(response.body, original.body);
        for bytes in [r#"{"data":{"services":{}}}"#, "{}", "bad"] {
            response.body = bytes.as_bytes().to_vec();
            normalize_timed_response("/v1/health", &mut response);
            assert_eq!(response.body, bytes.as_bytes());
        }
    }

    #[test]
    fn search_normalizes_only_the_engine_duration_on_the_search_route() {
        let mut missing = RecordedResponse {
            status: 200,
            headers: BTreeMap::new(),
            body: br#"{"meta":{"result":{"total":0}}}"#.to_vec(),
        };
        let original = missing.clone();
        normalize_timed_response("/v1/search", &mut missing);
        assert_eq!(missing, original);
        for (status, bytes) in [
            (500, r#"{"meta":{"result":{"tookMs":5}}}"#),
            (200, r#"{ "meta":{"result":{"tookMs":5}}}"#),
        ] {
            let mut response = RecordedResponse {
                status,
                headers: BTreeMap::new(),
                body: bytes.as_bytes().to_vec(),
            };
            normalize_timed_response("/v1/search/changelog", &mut response);
            assert_eq!(response.body, bytes.as_bytes());
        }
        for (path, value, expected) in [
            ("/v1/search", "24", "0"),
            ("/v1/free-games/search", "4", "0"),
            ("/v1/search/changelog", "3", "0"),
            ("/v1/multisearch/offers", "5", "0"),
            ("/v1/multisearch/items", "11", "0"),
            ("/v1/multisearch/sellers", "6", "0"),
            ("/v1/offers", "24", "24"),
            ("/v1/search", "null", "null"),
            ("/v1/search", "9007199254740992", "9007199254740992"),
        ] {
            let mut response = RecordedResponse {
                status: 200,
                headers: BTreeMap::new(),
                body: format!(
                    r#"{{"data":[{{"tookMs":99}}],"meta":{{"result":{{"tookMs":{value}}}}}}}"#
                )
                .into_bytes(),
            };
            normalize_timed_response(path, &mut response);
            let result: Value = serde_json::from_slice(&response.body).unwrap();
            assert_eq!(
                result.pointer("/meta/result/tookMs").unwrap().to_string(),
                expected
            );
            assert_eq!(result["data"][0]["tookMs"], 99);
        }
    }

    #[test]
    fn strips_volatile_fields_and_passes_equal_json() {
        let mut h_node = HeaderMap::new();
        h_node.insert(
            HeaderName::from_static("content-type"),
            HeaderValue::from_static("application/json; charset=utf-8"),
        );
        let node = RecordedResponse {
            status: 200,
            headers: extract_compared_headers(&h_node, DEFAULT_COMPARED_HEADERS),
            body: br#"{"data":{"id":"1"},"requestId":"req_a"}"#.to_vec(),
        };
        let rust = RecordedResponse {
            status: 200,
            headers: extract_compared_headers(&h_node, DEFAULT_COMPARED_HEADERS),
            body: br#"{"data":{"id":"1"},"requestId":"req_b"}"#.to_vec(),
        };
        let mismatches = compare_responses(
            "offer-detail",
            &node,
            &rust,
            DEFAULT_COMPARED_HEADERS,
            DEFAULT_IGNORED_JSON_KEYS,
        );
        assert!(mismatches.is_empty());
    }

    #[test]
    fn reports_status_header_json_and_raw_mismatches() {
        let node = RecordedResponse {
            status: 200,
            headers: BTreeMap::from([("etag".into(), "\"a\"".into())]),
            body: br#"{"items":[1,2]}"#.to_vec(),
        };
        let rust = RecordedResponse {
            status: 404,
            headers: BTreeMap::from([("etag".into(), "\"b\"".into())]),
            body: br#"{"items":[1,3]}"#.to_vec(),
        };
        let m = compare_responses(
            "mismatch-json",
            &node,
            &rust,
            DEFAULT_COMPARED_HEADERS,
            DEFAULT_IGNORED_JSON_KEYS,
        );
        assert_eq!(m.len(), 3);
        assert_eq!(m[0].category, "status");
        assert_eq!(m[1].category, "header:etag");
        assert_eq!(m[2].category, "json_body");

        let raw_a = RecordedResponse {
            status: 200,
            headers: BTreeMap::new(),
            body: b"abc".to_vec(),
        };
        let raw_b = RecordedResponse {
            status: 200,
            headers: BTreeMap::new(),
            body: b"abcd".to_vec(),
        };
        let raw_m = compare_responses(
            "mismatch-raw",
            &raw_a,
            &raw_b,
            DEFAULT_COMPARED_HEADERS,
            DEFAULT_IGNORED_JSON_KEYS,
        );
        assert_eq!(raw_m.len(), 1);
        assert_eq!(raw_m[0].category, "raw_body");

        let raw_eq = compare_responses(
            "equal-raw",
            &raw_a,
            &raw_a,
            DEFAULT_COMPARED_HEADERS,
            DEFAULT_IGNORED_JSON_KEYS,
        );
        assert!(raw_eq.is_empty());
    }
}
