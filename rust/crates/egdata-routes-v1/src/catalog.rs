//! Catalog metadata and bounded, per-root NDJSON hydration.
pub use egdata_http_core::shared::catalog::*;

use super::{
    RouteGroup,
    helpers::{json_success, parse_strict_query_uri},
};
use axum::{
    extract::Request,
    response::Response,
};
use egdata_core::{
    countries::{COUNTRIES, REGIONS},
    v1::regional_params,
};
use serde_json::json;
use std::collections::BTreeMap;


pub fn route_group(prefix: &str) -> RouteGroup {
    RouteGroup::new(prefix)
        .get("/countries", countries)
        .get("/regions", regions)
        .get("/region", region)
        .post("/catalog/hydrate", hydrate)
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








#[cfg(test)]
mod tests {
    use super::*;
    use crate::{test_support::test_app_state, state::ApiConfig};
    use async_trait::async_trait;
    use egdata_core::{error::CoreError, ports::CatalogHydrationResolverPort};
    use http_body_util::BodyExt;
    use axum::{body::Body, http::{StatusCode, header}};
    use egdata_infra::catalog_mongo::catalog_hydration_root_key;
    use serde_json::Value;
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;

    #[derive(Default)]
    struct Resolver {
        calls: Mutex<Vec<Value>>,
    }

    #[tokio::test]
    async fn regional_http_matches_node_oracle() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../egdata-api/tests/fixtures/regions-http-node.json"))
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
            let actual = egdata_api_test_support::capture_response(response).await;
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
        crate::router(&state).with_state(state)
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
            "../../egdata-api/tests/fixtures/hydration-http-node.json"
        ))
        .unwrap();
        let legacy: Vec<Value> = serde_json::from_str(include_str!(
            "../../egdata-api/tests/fixtures/legacy-hydration-http-node.json"
        ))
        .unwrap();
        for case in cases.into_iter().chain(legacy) {
            let resolver = Arc::new(OracleResolver::default());
            let mut state = test_app_state(ApiConfig::default());
            state.catalog_hydration = resolver.clone();
            state.now = || "2026-11-17T12:00:00Z".parse().unwrap();
            let input = &case["request"];
            let app = if input["path"] == "/catalog/hydrate" {
                egdata_api::runtime::application(state)
            } else {
                crate::router(&state).with_state(state)
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
            let actual = egdata_api_test_support::capture_response(response).await;
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
