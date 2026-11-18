//! Unversioned HTTP routes and their anonymous middleware stack.
mod builds;
mod catalog;
mod common;
mod offer_discovery;
mod offer_history;
mod offer_prices;
mod offer_relations;
mod offers;
mod profiles;
mod search;
mod sitemaps;
mod stats;
mod system;
mod top_reads;
pub(crate) use common::spread;
pub(crate) use top_reads::resolve_changelog_context_safely;
mod account_admin;
mod auth;
mod og_editorial;
mod root_and_ops;
use crate::{
    middleware::{
        edge_cache::edge_cache_headers,
        rate_limit::{RateLimitTier, general_rate_limit, rate_limit_tier},
        request_logger::request_debug_logger,
        response_etag::response_etag,
        route_template::route_template,
    },
    state::AppState,
};
use axum::{
    Router,
    body::Body,
    extract::Request,
    handler::Handler,
    http::{StatusCode, header},
    middleware::{self, Next},
    response::Response,
    routing::{MethodRouter, any, delete, get, patch, post, put},
};
use egdata_core::v1::serialization::node_json;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// Legacy route collector that wraps each path in `any(...)` (`AllowHeader::Skip`)
/// so unmatched HTTP methods match Hono's plain `404 Not Found` without `Allow`.
pub(super) struct Routes {
    prefix: String,
    methods: BTreeMap<String, MethodRouter<AppState>>,
    pub operations: BTreeMap<(String, String), String>,
}

impl Routes {
    pub(super) fn new(prefix: &str) -> Self {
        Self {
            prefix: prefix.into(),
            methods: BTreeMap::new(),
            operations: BTreeMap::new(),
        }
    }

    #[track_caller]
    fn insert_method(mut self, verb: &str, path: &str, mr: MethodRouter<AppState>) -> Self {
        let full = format!("{}{path}", self.prefix);
        self.operations.insert(
            (verb.into(), full.clone()),
            crate::openapi::registration_source(),
        );
        let merged = match self.methods.remove(&full) {
            Some(existing) => existing.merge(mr),
            None => mr,
        };
        self.methods.insert(full, merged);
        self
    }

    #[track_caller]
    pub(super) fn get<T: 'static>(self, path: &str, handler: impl Handler<T, AppState>) -> Self {
        self.insert_method("GET", path, get(handler))
    }

    #[track_caller]
    pub(super) fn post<T: 'static>(self, path: &str, handler: impl Handler<T, AppState>) -> Self {
        self.insert_method("POST", path, post(handler))
    }

    #[track_caller]
    pub(super) fn put<T: 'static>(self, path: &str, handler: impl Handler<T, AppState>) -> Self {
        self.insert_method("PUT", path, put(handler))
    }

    #[allow(dead_code)]
    #[track_caller]
    pub(super) fn patch<T: 'static>(self, path: &str, handler: impl Handler<T, AppState>) -> Self {
        self.insert_method("PATCH", path, patch(handler))
    }

    #[allow(dead_code)]
    #[track_caller]
    pub(super) fn delete<T: 'static>(self, path: &str, handler: impl Handler<T, AppState>) -> Self {
        self.insert_method("DELETE", path, delete(handler))
    }

    pub(super) fn merge(mut self, other: Self) -> Self {
        for (path, mr) in other.methods {
            let merged = match self.methods.remove(&path) {
                Some(existing) => existing.merge(mr),
                None => mr,
            };
            self.methods.insert(path, merged);
        }
        self.operations.extend(other.operations);
        self
    }

    fn into_router(self, state: &AppState) -> Router<AppState> {
        let mut router = Router::new();
        for (path, mr) in self.methods {
            let bound = mr.fallback(not_found).with_state(state.clone());
            router = router.route(&path, hono_methods(bound));
        }
        router
    }
}

// Axum normally synthesizes Allow on its method fallback. Hono returns an ordinary 404.
fn hono_methods(bound: MethodRouter<()>) -> MethodRouter<AppState> {
    any(move |req: Request| {
        let svc = bound.clone();
        async move {
            let mut response = svc.call(req, ()).await;
            if response.extensions().get::<HonoFallback>().is_some() {
                response.headers_mut().remove(header::ALLOW);
            }
            response
        }
    })
}

fn ordinary_routes() -> Routes {
    system::routes()
        .merge(sitemaps::routes())
        .merge(stats::routes())
        .merge(builds::routes())
        .merge(catalog::routes())
        .merge(offers::routes())
        .merge(offer_history::routes())
        .merge(offer_discovery::routes())
        .merge(offer_prices::routes())
        .merge(offer_relations::routes())
        .merge(search::routes())
        .merge(profiles::routes())
        .merge(top_reads::routes())
        .merge(og_editorial::routes())
        .merge(root_and_ops::routes())
        .merge(account_admin::routes())
        .merge(auth::routes())
}

fn challenge_route() -> Routes {
    Routes::new("").post("/auth/challenge", crate::middleware::anti_abuse::challenge)
}

pub(crate) fn registration_sources() -> BTreeMap<(String, String), String> {
    ordinary_routes().merge(challenge_route()).operations
}

pub(crate) fn inventory() -> Value {
    let contract = crate::openapi::build_legacy_document();
    let mut documented = BTreeSet::new();
    for (path, item) in contract["paths"].as_object().unwrap() {
        for (method, operation) in item.as_object().unwrap() {
            if operation.get("operationId").is_some() {
                documented.insert((method.to_ascii_uppercase(), path.to_string()));
            }
        }
    }
    let registered: BTreeSet<_> = registration_sources().into_keys().collect();
    let format_route = |(method, path): &(String, String)| format!("{method} {path}");
    serde_json::json!({"documented":documented.len(),"implemented":registered.intersection(&documented).count(),
        "missingHandlers":documented.difference(&registered).map(format_route).collect::<Vec<_>>(),
        "additionalRoutes":registered.difference(&documented).map(format_route).collect::<Vec<_>>()})
}

pub(crate) fn router(state: &AppState) -> Router<AppState> {
    let mut ordinary = ordinary_routes()
        .into_router(state)
        .fallback(not_found)
        .method_not_allowed_fallback(not_found)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            specific_rate_limit,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            general_rate_limit,
        ))
        .layer(middleware::from_fn(edge_cache_headers))
        .layer(middleware::from_fn(route_template))
        .layer(middleware::from_fn(request_debug_logger))
        .layer(middleware::from_fn(response_etag));
    // Only the registered POST short-circuits. Other methods traverse the ordinary
    // fallback, including its ETag and anonymous quota middleware, just as in Hono.
    for (path, methods) in challenge_route().methods {
        let fallback = ordinary.clone().with_state(state.clone());
        let bound = methods.fallback_service(fallback).with_state(state.clone());
        ordinary = ordinary.route(&path, hono_methods(bound));
    }
    ordinary.layer(middleware::from_fn_with_state(
        state.clone(),
        crate::middleware::anti_abuse::middleware,
    ))
}

#[derive(Clone)]
struct HonoFallback;

pub(crate) async fn fallback_headers(req: Request, next: Next) -> Response {
    let mut response = next.run(req).await;
    if response.extensions().get::<HonoFallback>().is_some() {
        response.headers_mut().remove(header::ALLOW);
    }
    response
}

async fn not_found() -> Response {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .extension(HonoFallback)
        .header(header::CONTENT_TYPE, "text/plain; charset=UTF-8")
        .body(Body::from("404 Not Found"))
        .unwrap()
}

async fn specific_rate_limit(
    state: axum::extract::State<AppState>,
    req: Request,
    next: Next,
) -> Response {
    let path = req.uri().path();
    let segments = path.trim_start_matches('/').split('/').collect::<Vec<_>>();
    let tier = match segments.as_slice() {
        ["search", "v2", "search"] => RateLimitTier::Search,
        ["catalog", ..] | ["builds", "resolve-launcher-records"] => RateLimitTier::Bulk,
        ["offers"] if req.method() == axum::http::Method::GET => RateLimitTier::OffersList,
        ["search", "natural-language"]
        | ["search", _, "count"]
        | ["multisearch" | "profiles" | "sellers", ..]
        | ["offers" | "sandboxes", _, "og" | "og.webp"]
        | ["game-awards" | "free-games", "og"]
        | ["collections", _, _, "og"] => RateLimitTier::Heavy,
        _ => return next.run(req).await,
    };
    rate_limit_tier(state, tier, req, next).await
}

pub(super) fn json_response(status: StatusCode, value: &Value) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(node_json(value)))
        .unwrap()
}

pub(super) fn internal_error() -> Response {
    Response::builder()
        .status(StatusCode::INTERNAL_SERVER_ERROR)
        .header(header::CONTENT_TYPE, "text/plain; charset=UTF-8")
        .body(Body::from("Internal Server Error"))
        .unwrap()
}

#[cfg(test)]
#[tokio::test]
async fn legacy_challenge_http_node_oracle() {
    use crate::middleware::test_support::test_app_state;
    use crate::state::{AntiAbuseMode, ApiConfig};
    use crate::v1::oracle_test_support::capture_response;
    use tower::ServiceExt;

    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../tests/fixtures/legacy-challenge-http-node.json"
    ))
    .unwrap();
    for case in cases {
        let mode = if case["mode"] == "off" {
            AntiAbuseMode::Off
        } else {
            AntiAbuseMode::Enforce
        };
        let state = test_app_state(ApiConfig {
            anti_abuse_mode: mode,
            anti_abuse_secret: Some("fixture-only-secret-for-handshake-comparison".into()),
            ..Default::default()
        });
        let app = crate::runtime::application(state);
        let req = Request::builder()
            .method(case["request"]["method"].as_str().unwrap())
            .uri("/auth/challenge")
            .body(Body::from(
                case["request"]["rawBody"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
            ))
            .unwrap();
        let before = chrono::Utc::now().timestamp_millis();
        let mut actual = capture_response(app.oneshot(req).await.unwrap()).await;
        let after = chrono::Utc::now().timestamp_millis();
        if actual["status"] == 200 {
            assert!(actual["body"]["challenge"].as_str().unwrap().len() > 32);
            actual["body"]["challenge"] = serde_json::json!("<issued challenge>");
            let lifetime = case["response"]["body"]["expiresAt"].as_i64().unwrap();
            let expiry = actual["body"]["expiresAt"].as_i64().unwrap();
            assert!((before + lifetime..=after + lifetime).contains(&expiry));
            actual["body"]["expiresAt"] = serde_json::json!(lifetime);
        }
        assert_eq!(actual, case["response"], "{}", case["name"]);
    }
}
