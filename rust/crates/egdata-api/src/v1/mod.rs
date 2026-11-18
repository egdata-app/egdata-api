//! Versioned routing, registered-operation inventory and common HTTP behavior.

pub mod build_launcher;
pub mod builds;
pub mod catalog;
pub mod catalog_discovery;
pub mod catalog_list;
pub(crate) mod collation;
pub mod collections;
pub(crate) mod counts;
pub mod free_games;
pub mod helpers;
mod item_serialization;
#[cfg(test)]
pub(crate) mod mongo_read_oracle;
pub mod offer_details;
pub mod offer_insights;
pub mod offer_metadata;
pub(crate) mod offer_price_history;
pub mod offer_prices;
pub mod offer_regional_price;
pub mod offer_relations;
pub mod offers;
pub mod og;
#[cfg(test)]
pub(crate) mod oracle_test_support;
pub mod profiles;
pub mod promotions;
pub mod search;
pub(crate) mod ssr_telemetry;
pub mod system;

use crate::{
    middleware::{
        response_etag::response_etag,
        v1_context::{v1_cache_policy, v1_context},
    },
    state::AppState,
};
use axum::{
    Router,
    body::Body,
    extract::Request,
    handler::Handler,
    http::{Method, StatusCode, header},
    middleware::{self, Next},
    response::Response,
    routing::{get, post, put},
};
use egdata_core::v1::{ProblemError, operations::v1_operations};
use helpers::{V1RequestContext, problem_response};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

/// Registration and inventory share one source, so the parity report cannot
/// accidentally count metadata entries as implemented HTTP handlers.
pub struct RouteGroup {
    pub router: Router<AppState>,
    prefix: String,
    pub operations: BTreeMap<(String, String), String>,
}

impl RouteGroup {
    pub fn new(prefix: &str) -> Self {
        Self {
            router: Router::new(),
            prefix: prefix.into(),
            operations: BTreeMap::new(),
        }
    }

    #[track_caller]
    pub fn get<T: 'static>(mut self, path: &str, handler: impl Handler<T, AppState>) -> Self {
        let path = format!("{}{path}", self.prefix);
        self.operations.insert(
            ("GET".into(), path.clone()),
            crate::openapi::registration_source(),
        );
        self.router = self.router.route(&path, get(handler));
        self
    }

    #[track_caller]
    pub fn post<T: 'static>(mut self, path: &str, handler: impl Handler<T, AppState>) -> Self {
        let path = format!("{}{path}", self.prefix);
        self.operations.insert(
            ("POST".into(), path.clone()),
            crate::openapi::registration_source(),
        );
        self.router = self.router.route(&path, post(handler));
        self
    }

    #[track_caller]
    pub fn put<T: 'static>(mut self, path: &str, handler: impl Handler<T, AppState>) -> Self {
        let path = format!("{}{path}", self.prefix);
        self.operations.insert(
            ("PUT".into(), path.clone()),
            crate::openapi::registration_source(),
        );
        self.router = self.router.route(&path, put(handler));
        self
    }

    pub(crate) fn merge(mut self, other: Self) -> Self {
        self.router = self.router.merge(other.router);
        self.operations.extend(other.operations);
        self
    }
}

pub(crate) fn routes() -> RouteGroup {
    RouteGroup::new("/v1")
        .get("/open-api.json", openapi_document)
        .merge(system::route_group("/v1"))
        .merge(og::route_group("/v1"))
        .merge(catalog::route_group("/v1"))
        .merge(catalog_discovery::route_group("/v1"))
        .merge(collections::route_group("/v1"))
        .merge(free_games::route_group("/v1"))
        .merge(promotions::route_group("/v1"))
        .merge(profiles::route_group("/v1"))
        .merge(offers::route_group("/v1"))
        .merge(offer_prices::route_group("/v1"))
        .merge(offer_details::route_group("/v1"))
        .merge(offer_insights::route_group("/v1"))
        .merge(offer_metadata::route_group("/v1"))
        .merge(offer_relations::route_group("/v1"))
        .merge(builds::route_group("/v1"))
        .merge(build_launcher::route_group("/v1"))
        .merge(search::route_group("/v1"))
        .merge(catalog_list::route_group("/v1"))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationCoverage {
    pub implemented: usize,
    pub documented: usize,
    pub missing_handlers: Vec<String>,
    pub undocumented_handlers: Vec<String>,
}

pub fn operation_coverage() -> OperationCoverage {
    let registered: BTreeSet<_> = routes().operations.into_keys().collect();
    let documented: BTreeMap<_, _> = v1_operations()
        .iter()
        .map(|op| {
            (
                (op.method.as_str().to_owned(), op.path.clone()),
                op.operation_id.clone(),
            )
        })
        .collect();
    OperationCoverage {
        implemented: registered.len(),
        documented: documented.len(),
        missing_handlers: documented
            .iter()
            .filter(|(key, _)| !registered.contains(*key))
            .map(|(_, id)| id.clone())
            .collect(),
        undocumented_handlers: registered
            .iter()
            .filter(|key| !documented.contains_key(*key))
            .map(|(method, path)| format!("{method} {path}"))
            .collect(),
    }
}

pub fn router(state: &AppState) -> Router<AppState> {
    routes()
        .router
        .route("/v1", axum::routing::any(fallback))
        .route("/v1/", axum::routing::any(fallback))
        .route("/v1/{*unmatched}", axum::routing::any(fallback))
        .method_not_allowed_fallback(fallback)
        .layer(middleware::from_fn(preflight))
        .layer(middleware::from_fn(v1_cache_policy))
        .layer(middleware::from_fn(response_etag))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            ssr_telemetry::record,
        ))
        .layer(middleware::from_fn_with_state(state.clone(), v1_context))
}

async fn openapi_document(request: Request) -> Response {
    let ctx = request
        .extensions()
        .get::<V1RequestContext>()
        .expect("v1 context");
    if let Err(error) = helpers::parse_strict_query_uri(request.uri(), &[]) {
        return problem_response(&error, request.uri().path(), Some(&ctx.request_id));
    }
    let mut response = Response::new(Body::from(crate::openapi::build_v1_document().to_string()));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "public, max-age=60".parse().unwrap());
    response
}

fn path_matches(template: &str, path: &str) -> bool {
    let template: Vec<_> = template.split('/').collect();
    let segments: Vec<_> = path.split('/').collect();
    template.len() == segments.len()
        && template.iter().zip(segments).all(|(expected, actual)| {
            if expected.starts_with('{') && expected.ends_with('}') {
                !actual.is_empty()
            } else {
                *expected == actual
            }
        })
}

async fn fallback(request: Request) -> Response {
    let path = request.uri().path();
    let mut allowed = Vec::new();
    for operation in v1_operations()
        .iter()
        .filter(|op| path_matches(&op.path, path))
    {
        for method in if operation.method.as_str() == "GET" {
            vec!["GET", "HEAD"]
        } else {
            vec!["POST"]
        } {
            if !allowed.contains(&method) {
                allowed.push(method);
            }
        }
    }
    let error = if allowed.is_empty() || allowed.contains(&request.method().as_str()) {
        ProblemError::new(
            404,
            "NOT_FOUND",
            "No version 1 operation exists at this path.",
        )
    } else {
        ProblemError::new(
            405,
            "METHOD_NOT_ALLOWED",
            format!(
                "The {} method is not supported for {path}.",
                request.method()
            ),
        )
        .with_headers(BTreeMap::from([("Allow".into(), allowed.join(", "))]))
    };
    let context = request.extensions().get::<V1RequestContext>();
    problem_response(&error, path, context.map(|ctx| ctx.request_id.as_str()))
}

async fn preflight(request: Request, next: Next) -> Response {
    if request.method() != Method::OPTIONS {
        return next.run(request).await;
    }
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::NO_CONTENT;
    let headers = response.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        "GET, HEAD, POST, OPTIONS".parse().unwrap(),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        "X-API-Key, Authorization, Content-Type, If-None-Match, X-Request-Id"
            .parse()
            .unwrap(),
    );
    headers.insert(header::ACCESS_CONTROL_MAX_AGE, "600".parse().unwrap());
    headers.insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    if let Some(origin) = request.headers().get(header::ORIGIN) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.clone());
        headers.insert(header::VARY, "Origin".parse().unwrap());
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{middleware::test_support::test_app_state, state::ApiConfig};
    use http_body_util::BodyExt;
    use serde_json::{Value, json};
    use tower::ServiceExt;

    fn app() -> Router {
        let state = test_app_state(ApiConfig::default());
        router(&state).with_state(state)
    }

    pub(super) fn request(method: &str, path: &str) -> axum::http::request::Builder {
        Request::builder()
            .method(method)
            .uri(path)
            .header("x-egdata-key-id", "key_test1234")
            .header("x-egdata-key-tier", "free")
            .header("x-request-id", "req_router_test")
    }

    async fn json_body(response: Response) -> Value {
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
    }

    #[test]
    fn all_documented_operations_have_registered_handlers() {
        let coverage = operation_coverage();
        assert!(
            coverage.undocumented_handlers.is_empty(),
            "{:?}",
            coverage.undocumented_handlers
        );
        assert_eq!(coverage.documented, 154);
        assert_eq!(coverage.implemented, coverage.documented);
        assert!(coverage.missing_handlers.is_empty());
    }

    #[tokio::test]
    async fn public_contract_health_and_private_metadata_are_mounted_at_v1() {
        let app = app();
        for path in ["/v1/health", "/v1/open-api.json"] {
            let response = app
                .clone()
                .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers()[header::CACHE_CONTROL],
                "public, max-age=60"
            );
            assert_eq!(response.headers()["cdn-cache-control"], "no-store");
            assert!(response.headers().contains_key("x-request-id"));
            let body = json_body(response).await;
            if path.ends_with(".json") {
                assert_eq!(body, crate::openapi::build_v1_document());
            } else {
                assert_eq!(body["data"]["status"], "ok");
            }
        }
        let unauthenticated = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/countries")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);
        for (path, count) in [("/v1/countries", 251), ("/v1/regions", 52)] {
            let response = app
                .clone()
                .oneshot(request("GET", path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers()["cloudflare-cdn-cache-control"],
                "no-store"
            );
            assert_eq!(json_body(response).await["meta"]["count"], count);
        }
        let response = app
            .oneshot(
                request("GET", "/v1/region?country=gb&country=US")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(json_body(response).await["data"]["region"]["code"], "GB");
    }

    #[tokio::test]
    async fn dispatch_errors_preflights_heads_and_private_etags_match_v1_protocol() {
        let app = app();
        for (method, path, status, code) in [
            ("GET", "/v1/missing", 404, "NOT_FOUND"),
            ("POST", "/v1/countries", 405, "METHOD_NOT_ALLOWED"),
            ("POST", "/v1/assets/id", 405, "METHOD_NOT_ALLOWED"),
            ("GET", "/v1/region?country=XX", 400, "INVALID_COUNTRY"),
            ("GET", "/v1/open-api.json?z=1&a=2", 400, "INVALID_QUERY"),
        ] {
            let response = app
                .clone()
                .oneshot(request(method, path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), status, "{method} {path}");
            assert_eq!(
                response.headers()["content-type"],
                "application/problem+json"
            );
            assert_eq!(response.headers()["x-request-id"], "req_router_test");
            if status == 405 {
                assert_eq!(response.headers()[header::ALLOW], "GET, HEAD");
            }
            let body = json_body(response).await;
            assert_eq!(body["instance"], path.split('?').next().unwrap());
            assert_eq!(body["code"], code);
            if code == "INVALID_QUERY" {
                assert_eq!(
                    body["errors"],
                    json!([{"code": "UNRECOGNIZED_KEYS", "message": "Unrecognized keys: \"z\", \"a\""}])
                );
            }
        }
        let preflight = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("OPTIONS")
                    .uri("/v1/anything")
                    .header("origin", "https://example.test")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(preflight.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            preflight.headers()[header::ACCESS_CONTROL_ALLOW_METHODS],
            "GET, HEAD, POST, OPTIONS"
        );
        assert_eq!(
            preflight.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            "https://example.test"
        );
        assert!(preflight.headers().contains_key("x-request-id"));
        let get = app
            .clone()
            .oneshot(request("GET", "/v1/countries").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let etag = get.headers()[header::ETAG].clone();
        let cached = app
            .clone()
            .oneshot(
                request("GET", "/v1/countries")
                    .header(header::IF_NONE_MATCH, etag)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(cached.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(cached.headers()[header::CACHE_CONTROL], "private, no-cache");
        assert_eq!(cached.headers()["x-request-id"], "req_router_test");
        assert!(
            cached
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .is_empty()
        );
        let head = app
            .oneshot(
                request("HEAD", "/v1/countries")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(head.status(), StatusCode::OK);
        assert!(
            head.into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .is_empty()
        );
    }

    // SHA-1 digests of JSON.stringify envelopes emitted by the checked-in
    // TypeScript countries/regions data. These also catch object-order drift.
    #[tokio::test]
    async fn metadata_etags_match_node_serialization() {
        for (path, digest) in [
            ("/v1/countries", "d9f5dda859c16f5e2fe5e31068c1a3a00dfeb42a"),
            ("/v1/regions", "dc9df9c363938b7d82ba3b4d067f8762db7daef1"),
            (
                "/v1/region?country=GB",
                "bf796de4101aaccad7ff219c21801a00bf6af36d",
            ),
        ] {
            let response = app()
                .oneshot(request("GET", path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(
                response.headers()[header::ETAG],
                format!("\"{digest}\""),
                "{path}"
            );
        }
    }

    #[tokio::test]
    async fn production_worker_provenance_is_checked_before_dispatch() {
        let state = test_app_state(ApiConfig {
            v1_worker_auth_required: true,
            v1_worker_token: Some("worker-secret".into()),
            ..Default::default()
        });
        let app = router(&state).with_state(state);
        let denied = app
            .clone()
            .oneshot(request("GET", "/v1/countries").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
        let allowed = app
            .oneshot(
                request("GET", "/v1/countries")
                    .header("x-egdata-worker-token", "worker-secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(allowed.status(), StatusCode::OK);
    }
}
