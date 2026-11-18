//! Catalog metadata and bounded, per-root NDJSON hydration.

use super::{
    RouteGroup,
    helpers::{V1RequestContext, json_success, parse_strict_query_uri, problem_response},
};
use crate::state::AppState;
use axum::{
    body::{Body, Bytes, to_bytes},
    extract::{Request, State},
    http::{StatusCode, header},
    response::Response,
};
use chrono::{SecondsFormat, Utc};
use egdata_core::{
    countries::{COUNTRIES, REGIONS},
    v1::{ProblemError, regional_params, require_json_content_type},
};
use egdata_infra::catalog_mongo::{
    CatalogHydrationIdentifier, CatalogHydrationRequest, catalog_hydration_root_key,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    convert::Infallible,
    sync::Arc,
};

pub(crate) const MAX_REQUEST_BYTES: usize = 256 * 1024;
const MAX_LINE_BYTES: usize = 2 * 1024 * 1024;

pub fn route_group(prefix: &str) -> RouteGroup {
    RouteGroup::new(prefix)
        .get("/countries", countries)
        .get("/regions", regions)
        .get("/region", region)
        .post("/catalog/hydrate", hydrate)
}

fn context(request: &Request) -> &V1RequestContext {
    request.extensions().get().expect("v1 context")
}

fn error_response(request: &Request, error: &ProblemError) -> Response {
    problem_response(
        error,
        request.uri().path(),
        Some(&context(request).request_id),
    )
}

async fn countries(request: Request) -> Response {
    if let Err(error) = parse_strict_query_uri(request.uri(), &[]) {
        return error_response(&request, &error);
    }
    json_success(
        request.method(),
        request.uri().path(),
        &context(&request).request_id,
        json!(COUNTRIES),
        Some(json!({"count": COUNTRIES.len()})),
    )
}

async fn regions(request: Request) -> Response {
    if let Err(error) = parse_strict_query_uri(request.uri(), &[]) {
        return error_response(&request, &error);
    }
    let regions: BTreeMap<_, _> = REGIONS.iter().copied().collect();
    json_success(
        request.method(),
        request.uri().path(),
        &context(&request).request_id,
        json!(regions),
        Some(json!({"count": regions.len()})),
    )
}

async fn region(request: Request) -> Response {
    let query = match parse_strict_query_uri(request.uri(), &["country"]) {
        Ok(query) => query,
        Err(error) => return error_response(&request, &error),
    };
    let params = match regional_params(query.get("country").map(String::as_str), None) {
        Ok(params) => params,
        Err(error) => return error_response(&request, &error),
    };
    let (_, info) = REGIONS
        .iter()
        .find(|(code, _)| *code == params.region)
        .expect("known region");
    let region = json!({
        "code": params.region,
        "currencyCode": info.currency_code,
        "description": info.description,
        "countries": info.countries,
    });
    json_success(
        request.method(),
        request.uri().path(),
        &context(&request).request_id,
        json!({"region": region}),
        None,
    )
}

fn bounded(value: &str, max: usize) -> bool {
    !egdata_core::v1::trim_js_whitespace(value).is_empty() && value.encode_utf16().count() <= max
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Match the Node boundary validator, including normalization before duplicate checks.
pub fn parse_hydration_request(mut value: Value) -> Option<CatalogHydrationRequest> {
    if value.get("schemaVersion")?.as_f64()? != 2.0 {
        return None;
    }
    value["schemaVersion"] = json!(2);
    let request: CatalogHydrationRequest = serde_json::from_value(value).ok()?;
    if request.identifiers.is_empty()
        || request.identifiers.len() > 25
        || request.known_roots.len() > 25
        || request.known_records.len() > 5000
    {
        return None;
    }
    let mut identifiers = HashSet::new();
    for identifier in &request.identifiers {
        let valid = match identifier {
            CatalogHydrationIdentifier::Item { namespace, id } => {
                bounded(namespace, 256) && bounded(id, 256)
            }
            CatalogHydrationIdentifier::Asset {
                namespace,
                artifact_id,
                platform,
            } => bounded(namespace, 256) && bounded(artifact_id, 256) && bounded(platform, 64),
            CatalogHydrationIdentifier::ReleaseApp {
                namespace,
                app_id,
                platform,
            } => bounded(namespace, 256) && bounded(app_id, 256) && bounded(platform, 64),
        };
        if !valid || !identifiers.insert(catalog_hydration_root_key(identifier)) {
            return None;
        }
    }
    let mut roots = HashSet::new();
    for root in &request.known_roots {
        if !bounded(&root.root_key, 4096)
            || !valid_hash(&root.graph_hash)
            || !roots.insert(&root.root_key)
        {
            return None;
        }
    }
    let mut records = HashSet::new();
    for record in &request.known_records {
        if !bounded(&record.record_key, 4096)
            || !valid_hash(&record.sha256)
            || !records.insert(&record.record_key)
        {
            return None;
        }
    }
    Some(request)
}

fn root_error(
    identifier: &CatalogHydrationIdentifier,
    code: &str,
    message: &str,
    now: chrono::DateTime<Utc>,
) -> Value {
    json!({"schemaVersion": 2, "rootKey": catalog_hydration_root_key(identifier), "identifier": identifier,
        "hydratedAt": now.to_rfc3339_opts(SecondsFormat::Millis, true), "status": "error",
        "error": {"code": code, "message": message}})
}

fn too_large() -> ProblemError {
    ProblemError::new(
        413,
        "CATALOG_HYDRATION_TOO_LARGE",
        "The catalog hydration request is too large (maximum 256 KiB).",
    )
}

async fn hydrate(State(state): State<AppState>, request: Request) -> Response {
    if let Err(error) = require_json_content_type(
        request
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|h| h.to_str().ok()),
    ) {
        return error_response(&request, &error);
    }
    if request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.parse::<f64>().ok())
        .is_some_and(|len| len.is_finite() && len > MAX_REQUEST_BYTES as f64)
    {
        return error_response(&request, &too_large());
    }
    let path = request.uri().path().to_string();
    let request_id = context(&request).request_id.clone();
    let body = match to_bytes(request.into_body(), MAX_REQUEST_BYTES).await {
        Ok(body) => body,
        Err(_) => return problem_response(&too_large(), &path, Some(&request_id)),
    };
    let value = match serde_json::from_slice::<Value>(&body) {
        Ok(value) => value,
        Err(_) => {
            return problem_response(
                &ProblemError::new(
                    400,
                    "CATALOG_HYDRATION_INVALID_REQUEST",
                    "The catalog hydration request is not valid JSON.",
                ),
                &path,
                Some(&request_id),
            );
        }
    };
    let Some(hydration) = parse_hydration_request(value) else {
        return problem_response(
            &ProblemError::new(
                400,
                "CATALOG_HYDRATION_INVALID_REQUEST",
                "The catalog hydration request is invalid.",
            ),
            &path,
            Some(&request_id),
        );
    };
    hydration_response(state, hydration)
}

pub(crate) fn hydration_response(state: AppState, hydration: CatalogHydrationRequest) -> Response {
    // Resolve only the root being polled. Dropping the response cancels pending
    // work and never starts subsequent roots; no task or channel outlives it.
    let stream = futures::stream::unfold(
        (state.catalog_hydration, Arc::new(hydration), 0),
        move |(resolver, request, index)| async move {
            let identifier = request.identifiers.get(index)?;
            let one_root = json!({"schemaVersion": 2, "identifiers": [identifier],
                "knownRoots": request.known_roots, "knownRecords": request.known_records});
            let result = match resolver.resolve(&one_root).await {
                Ok(mut rows) if rows.len() == 1 => rows.remove(0),
                _ => root_error(
                    identifier,
                    "CATALOG_ROOT_RESOLUTION_FAILED",
                    "This catalog root could not be hydrated.",
                    (state.now)(),
                ),
            };
            let mut line = egdata_core::v1::serialization::node_json(&result);
            line.push('\n');
            if line.len() > MAX_LINE_BYTES {
                line = format!(
                    "{}\n",
                    root_error(
                        identifier,
                        "CATALOG_ROOT_TOO_LARGE",
                        "This catalog root exceeds the hydration limit.",
                        (state.now)(),
                    )
                );
            }
            Some((
                Ok::<_, Infallible>(Bytes::from(line)),
                (resolver, request, index + 1),
            ))
        },
    );
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        "application/x-ndjson; charset=utf-8".parse().unwrap(),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{middleware::test_support::test_app_state, state::ApiConfig, v1};
    use async_trait::async_trait;
    use egdata_core::{error::CoreError, ports::CatalogHydrationResolverPort};
    use http_body_util::BodyExt;
    use std::sync::Mutex;
    use tower::ServiceExt;

    #[derive(Default)]
    struct Resolver {
        calls: Mutex<Vec<Value>>,
    }

    #[tokio::test]
    async fn regional_http_matches_node_oracle() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../tests/fixtures/regions-http-node.json"))
                .unwrap();
        let app = app(Arc::new(Resolver::default()));
        for case in cases {
            let input = &case["request"];
            let mut request = Request::builder()
                .uri(input["path"].as_str().unwrap())
                .method(input["method"].as_str().unwrap())
                .header("x-egdata-key-id", "key_oracle")
                .header("x-egdata-key-tier", "free")
                .header("x-request-id", "req_node_oracle");
            if let Some(headers) = input["headers"].as_object() {
                for (name, value) in headers {
                    request = request.header(name, value.as_str().unwrap());
                }
            }
            let response = app
                .clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            let actual = crate::v1::oracle_test_support::capture_response(response).await;
            assert_eq!(actual, case["response"], "{}", case["name"]);
        }
    }
    #[async_trait]
    impl CatalogHydrationResolverPort for Resolver {
        async fn resolve(&self, request: &Value) -> Result<Vec<Value>, CoreError> {
            self.calls.lock().unwrap().push(request.clone());
            let identifier = &request["identifiers"][0];
            match identifier["id"].as_str().unwrap() {
                "fail" => Err(CoreError::Internal("private database detail".into())),
                "large" => Ok(vec![json!({"data": "x".repeat(MAX_LINE_BYTES)})]),
                _ => Ok(vec![
                    json!({"status": "not-found", "identifier": identifier}),
                ]),
            }
        }
    }

    fn payload(ids: &[&str]) -> Value {
        json!({"schemaVersion": 2, "identifiers": ids.iter().map(|id|
            json!({"type": "item", "namespace": "ns", "id": id})).collect::<Vec<_>>(),
            "knownRoots": [], "knownRecords": []})
    }

    fn app(resolver: Arc<Resolver>) -> axum::Router {
        let mut state = test_app_state(ApiConfig::default());
        state.catalog_hydration = resolver;
        v1::router(&state).with_state(state)
    }

    fn post() -> axum::http::request::Builder {
        Request::builder()
            .method("POST")
            .uri("/v1/catalog/hydrate")
            .header("x-egdata-key-id", "key_test1234")
            .header("x-egdata-key-tier", "free")
    }

    #[derive(Default)]
    struct OracleResolver(Mutex<Vec<Value>>);

    #[async_trait]
    impl CatalogHydrationResolverPort for OracleResolver {
        async fn resolve(&self, request: &Value) -> Result<Vec<Value>, CoreError> {
            let identifier = &request["identifiers"][0];
            self.0.lock().unwrap().push(json!({"identifier":identifier,"knownRoots":request["knownRoots"],"knownRecords":request["knownRecords"]}));
            let root =
                catalog_hydration_root_key(&serde_json::from_value(identifier.clone()).unwrap());
            let mut result = json!({"schemaVersion":2,"rootKey":root,"identifier":identifier,"hydratedAt":"2026-11-17T12:00:00.000Z"});
            match identifier["id"].as_str() {
                Some("fail") => return Err(CoreError::Internal("fixture resolver failure".into())),
                Some("large") => result["data"] = json!("x".repeat(MAX_LINE_BYTES)),
                _ => {
                    if let Some(known) = request["knownRoots"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|entry| entry["rootKey"] == root)
                    {
                        result["status"] = json!("unchanged");
                        result["graphHash"] = known["graphHash"].clone();
                    } else {
                        result["status"] = json!("not-found");
                    }
                }
            }
            Ok(vec![result])
        }
    }

    #[tokio::test]
    async fn hydration_http_matches_node_oracle() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../tests/fixtures/hydration-http-node.json"
        ))
        .unwrap();
        let legacy: Vec<Value> = serde_json::from_str(include_str!(
            "../../tests/fixtures/legacy-hydration-http-node.json"
        ))
        .unwrap();
        for case in cases.into_iter().chain(legacy) {
            let resolver = Arc::new(OracleResolver::default());
            let mut state = test_app_state(ApiConfig::default());
            state.catalog_hydration = resolver.clone();
            state.now = || "2026-11-17T12:00:00Z".parse().unwrap();
            let input = &case["request"];
            let app = if input["path"] == "/catalog/hydrate" {
                crate::runtime::application(state)
            } else {
                v1::router(&state).with_state(state)
            };
            let mut req = if input["path"] == "/catalog/hydrate" {
                Request::builder().method("POST").uri("/catalog/hydrate")
            } else {
                post().header("x-request-id", "req_node_oracle")
            };
            for (key, value) in input["headers"].as_object().unwrap() {
                req = req.header(key, value.as_str().unwrap());
            }
            let response = app
                .oneshot(
                    req.body(Body::from(input["raw"].as_str().unwrap().to_owned()))
                        .unwrap(),
                )
                .await
                .unwrap();
            let actual = crate::v1::oracle_test_support::capture_response(response).await;
            assert_eq!(actual, case["response"], "{}", case["name"]);
            assert_eq!(
                json!(*resolver.0.lock().unwrap()),
                case["calls"],
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn validator_rejects_duplicates_bounds_and_bad_hashes_and_normalizes_extra_fields() {
        assert!(parse_hydration_request(payload(&["one"])).is_some());
        assert!(parse_hydration_request(payload(&[])).is_none());
        assert!(parse_hydration_request(payload(&["one", " ONE "])).is_none());
        assert!(parse_hydration_request(payload(&[" "])).is_none());
        assert!(parse_hydration_request(payload(&[&"x".repeat(257)])).is_none());
        assert!(parse_hydration_request(payload(&[&"😀".repeat(129)])).is_none());
        let mut valid = payload(&["one"]);
        valid["identifiers"][0]["ignored"] = json!(true);
        let parsed = parse_hydration_request(valid).unwrap();
        assert!(
            serde_json::to_value(parsed).unwrap()["identifiers"][0]
                .get("ignored")
                .is_none()
        );
        let mut variants = Vec::new();
        for field in ["identifiers", "knownRoots", "knownRecords"] {
            let mut bad = payload(&["one"]);
            bad.as_object_mut().unwrap().remove(field);
            variants.push(bad);
        }
        let mut bad = payload(&["one"]);
        bad["schemaVersion"] = json!(1);
        variants.push(bad);
        let mut bad = payload(&["one"]);
        bad["identifiers"] = json!([{"type": "other", "namespace": "ns", "id": "one"}]);
        variants.push(bad);
        for hash in ["a".repeat(63), "A".repeat(64), "g".repeat(64)] {
            let mut bad = payload(&["one"]);
            bad["knownRoots"] = json!([{"rootKey": "root", "graphHash": hash}]);
            variants.push(bad);
        }
        let root = json!({"rootKey": "root", "graphHash": "a".repeat(64)});
        let record = json!({"recordKey": "record", "sha256": "b".repeat(64)});
        let mut bad = payload(&["one"]);
        bad["knownRoots"] = json!([root, root]);
        variants.push(bad);
        let mut bad = payload(&["one"]);
        bad["knownRecords"] = json!([record, record]);
        variants.push(bad);
        let mut bad = payload(&["one"]);
        bad["knownRecords"] = json!(vec![record; 5001]);
        variants.push(bad);
        let mut bad = payload(&["one"]);
        bad["identifiers"] = json!(vec![
            json!({"type": "item", "namespace": "ns", "id": "one"});
            26
        ]);
        variants.push(bad);
        for bad in variants {
            assert!(parse_hydration_request(bad).is_none());
        }
        for identifier in [
            json!({"type":"asset", "namespace":"ns", "artifactId":"artifact", "platform":"Windows"}),
            json!({"type":"release-app", "namespace":"ns", "appId":"app", "platform":"Windows"}),
        ] {
            let mut valid = payload(&["one"]);
            valid["identifiers"] = json!([identifier]);
            assert!(parse_hydration_request(valid.clone()).is_some());
            valid["identifiers"][0]["platform"] = json!("x".repeat(65));
            assert!(parse_hydration_request(valid).is_none());
        }
    }

    #[tokio::test]
    async fn request_errors_are_problem_json_and_do_not_invoke_the_resolver() {
        let resolver = Arc::new(Resolver::default());
        let app = app(resolver.clone());
        for (content_type, body, declared, status, code) in [
            (None, "{}".into(), None, 415, "UNSUPPORTED_MEDIA_TYPE"),
            (
                Some("text/plain"),
                "{}".into(),
                None,
                415,
                "UNSUPPORTED_MEDIA_TYPE",
            ),
            (
                Some("application/json"),
                "{".into(),
                None,
                400,
                "CATALOG_HYDRATION_INVALID_REQUEST",
            ),
            (
                Some("application/json"),
                "{}".into(),
                None,
                400,
                "CATALOG_HYDRATION_INVALID_REQUEST",
            ),
            (
                Some("application/json"),
                "{}".into(),
                Some("262145"),
                413,
                "CATALOG_HYDRATION_TOO_LARGE",
            ),
            (
                Some("application/json"),
                "x".repeat(MAX_REQUEST_BYTES + 1),
                None,
                413,
                "CATALOG_HYDRATION_TOO_LARGE",
            ),
        ] {
            let mut request = post();
            if let Some(content_type) = content_type {
                request = request.header(header::CONTENT_TYPE, content_type);
            }
            if let Some(declared) = declared {
                request = request.header(header::CONTENT_LENGTH, declared);
            }
            let response = app
                .clone()
                .oneshot(request.body(Body::from(body)).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), status);
            assert_eq!(
                response.headers()[header::CONTENT_TYPE],
                "application/problem+json"
            );
            let error: Value =
                serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                    .unwrap();
            assert_eq!(error["code"], code);
        }
        assert!(resolver.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn streams_each_root_without_etag_and_stops_when_the_body_is_dropped() {
        let resolver = Arc::new(Resolver::default());
        let app = app(resolver.clone());
        let response = app
            .oneshot(
                post()
                    .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
                    .body(Body::from(payload(&["first", "second"]).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "application/x-ndjson; charset=utf-8"
        );
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "private, no-store"
        );
        assert!(!response.headers().contains_key(header::ETAG));
        assert!(
            resolver.calls.lock().unwrap().is_empty(),
            "middleware must not eagerly buffer the stream"
        );
        let mut body = response.into_body();
        let first = body.frame().await.unwrap().unwrap().into_data().unwrap();
        assert!(first.ends_with(b"\n"));
        assert_eq!(
            serde_json::from_slice::<Value>(&first).unwrap()["identifier"]["id"],
            "first"
        );
        drop(body);
        assert_eq!(
            resolver.calls.lock().unwrap().len(),
            1,
            "the second root must never start after disconnect"
        );
    }

    #[tokio::test]
    async fn root_failures_and_oversized_lines_do_not_abort_subsequent_roots() {
        let resolver = Arc::new(Resolver::default());
        let response = app(resolver.clone())
            .oneshot(
                post()
                    .header(header::CONTENT_TYPE, "application/vnd.test+json")
                    .body(Body::from(payload(&["fail", "large", "last"]).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let lines: Vec<Value> = std::str::from_utf8(&body)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0]["error"]["code"], "CATALOG_ROOT_RESOLUTION_FAILED");
        assert_eq!(lines[1]["error"]["code"], "CATALOG_ROOT_TOO_LARGE");
        assert_eq!(lines[1]["rootKey"], "item:ns:large");
        assert_eq!(lines[2]["identifier"]["id"], "last");
        assert!(
            !std::str::from_utf8(&body)
                .unwrap()
                .contains("private database detail")
        );
        let calls = resolver.calls.lock().unwrap();
        assert_eq!(calls.len(), 3);
        assert!(
            calls
                .iter()
                .all(|call| call["identifiers"].as_array().unwrap().len() == 1)
        );
    }
}
