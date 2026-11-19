//! Trusted `/v1` request context and cache policy middleware (`src/v1/request-context.ts`).

use std::sync::OnceLock;

use axum::{
    body::Body,
    extract::{Request, State},
    http::{HeaderName, HeaderValue, Method, StatusCode, header},
    middleware::Next,
    response::Response,
};
use egdata_core::v1::ProblemError;
use regex::Regex;
use uuid::Uuid;

use crate::{
    middleware::origin_auth::sha256_secure_eq,
    state::{ApiConfig, AppState},
    v1_helpers::{V1GatewayKey, V1RequestContext, problem_response},
};

/// Internal gateway headers stripped before `/v1` route handlers execute.
pub const INTERNAL_HEADERS: &[&str] = &[
    "x-egdata-key-id",
    "x-egdata-key-tier",
    "x-egdata-key-project",
    "x-egdata-worker-token",
    "x-egdata-authenticated",
    "x-egdata-request-id",
    "x-egdata-origin-token",
    "x-request-id",
];

/// Public `/v1` subpaths that do not require API key context.
pub const PUBLIC_V1_PATHS: &[&str] = &["/health", "/open-api.json"];

fn request_id_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z0-9_-]{8,80}$").expect("valid regex"))
}

fn key_id_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(?:key|console)_[A-Za-z0-9_-]{4,80}$").expect("valid regex"))
}

fn cache_control_private_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)private|no-store|no-cache").expect("valid regex"))
}

pub fn relative_v1_path(path: &str) -> &str {
    if path == "/v1" {
        "/"
    } else if let Some(rest) = path.strip_prefix("/v1/") {
        // Slice starting at the `/` before the rest of the path.
        let _ = rest;
        &path[3..]
    } else {
        path
    }
}

pub fn is_public_v1_path(path: &str) -> bool {
    PUBLIC_V1_PATHS.contains(&relative_v1_path(path))
}

fn header_str(req: &Request<Body>, name: &str) -> String {
    req.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}

fn set_request_id_header(resp: &mut Response, request_id: &str) {
    if let Ok(val) = HeaderValue::from_str(request_id) {
        resp.headers_mut()
            .insert(HeaderName::from_static("x-request-id"), val);
    }
}

/// Core `/v1` request context middleware parameterized by [`ApiConfig`].
pub async fn v1_context_with_config(
    config: &ApiConfig,
    mut req: Request<Body>,
    next: Next,
) -> Response {
    let supplied_worker_token = header_str(&req, "x-egdata-worker-token");
    let supplied_request_id = req
        .headers()
        .get("x-egdata-request-id")
        .or_else(|| req.headers().get("x-request-id"))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let supplied_key_id = header_str(&req, "x-egdata-key-id");
    let supplied_tier = header_str(&req, "x-egdata-key-tier");
    let supplied_project_id = header_str(&req, "x-egdata-key-project");

    for &name in INTERNAL_HEADERS {
        req.headers_mut().remove(name);
    }

    let worker_token = config
        .v1_worker_token
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let request_id = if request_id_regex().is_match(&supplied_request_id)
        && worker_token.is_none_or(|wt| sha256_secure_eq(&supplied_worker_token, wt))
    {
        supplied_request_id
    } else {
        format!("req_{}", Uuid::new_v4())
    };

    let path = req.uri().path().to_string();
    if req.method() == Method::OPTIONS || is_public_v1_path(&path) {
        req.extensions_mut().insert(V1RequestContext {
            request_id: request_id.clone(),
            key: None,
        });
        let mut resp = next.run(req).await;
        set_request_id_header(&mut resp, &request_id);
        return resp;
    }

    if config.v1_worker_auth_required {
        let Some(wt) = worker_token else {
            let err = ProblemError::new(
                503,
                "WORKER_AUTH_NOT_CONFIGURED",
                "The API origin cannot verify Worker provenance. The request was not processed.",
            );
            return problem_response(&err, &path, Some(&request_id));
        };
        if !sha256_secure_eq(&supplied_worker_token, wt) {
            let err = ProblemError::new(
                403,
                "UNTRUSTED_WORKER",
                "This v1 endpoint is only available through the authenticated API gateway.",
            );
            return problem_response(&err, &path, Some(&request_id));
        }
    }

    if !key_id_regex().is_match(&supplied_key_id) {
        let err = ProblemError::new(
            401,
            "MISSING_KEY_CONTEXT",
            "The request did not include a verified API key identity. Use the egdata API gateway.",
        );
        return problem_response(&err, &path, Some(&request_id));
    }

    let tier = supplied_tier.to_ascii_lowercase();
    if !matches!(tier.as_str(), "free" | "pro" | "scale" | "enterprise") {
        let err = ProblemError::new(
            403,
            "INVALID_KEY_CONTEXT",
            "The API key tier asserted by the gateway is not recognized.",
        );
        return problem_response(&err, &path, Some(&request_id));
    }

    req.extensions_mut().insert(V1RequestContext {
        request_id: request_id.clone(),
        key: Some(V1GatewayKey {
            key_id: supplied_key_id,
            tier,
            project_id: if supplied_project_id.is_empty() {
                None
            } else {
                Some(supplied_project_id)
            },
        }),
    });

    let mut resp = next.run(req).await;
    set_request_id_header(&mut resp, &request_id);
    resp
}

/// Axum middleware establishing the trusted `/v1` request context from [`AppState`].
pub async fn v1_context(State(state): State<AppState>, req: Request<Body>, next: Next) -> Response {
    v1_context_with_config(&state.config, req, next).await
}

/// Axum middleware enforcing `/v1` cache policy headers (`v1CachePolicy`).
pub async fn v1_cache_policy(req: Request<Body>, next: Next) -> Response {
    let path = req.uri().path().to_string();
    let mut resp = next.run(req).await;

    if resp.status().as_u16() >= 500 || resp.status() == StatusCode::TOO_MANY_REQUESTS {
        return resp;
    }

    if is_public_v1_path(&path) {
        let headers = resp.headers_mut();
        headers.insert(
            HeaderName::from_static("cdn-cache-control"),
            HeaderValue::from_static("no-store"),
        );
        headers.insert(
            HeaderName::from_static("x-content-type-options"),
            HeaderValue::from_static("nosniff"),
        );
        return resp;
    }

    let existing_cc = resp
        .headers()
        .get(header::CACHE_CONTROL)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    if existing_cc
        .as_deref()
        .is_none_or(|cc| !cache_control_private_regex().is_match(cc))
    {
        resp.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, no-cache"),
        );
    }

    let headers = resp.headers_mut();
    headers.insert(
        HeaderName::from_static("cdn-cache-control"),
        HeaderValue::from_static("no-store"),
    );
    headers.insert(
        HeaderName::from_static("cloudflare-cdn-cache-control"),
        HeaderValue::from_static("no-store"),
    );
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    resp
}

#[cfg(test)]
mod tests {
    use super::*;
    use egdata_api_test_support::test_app_state;
    use axum::{Extension, Json, Router, middleware, routing::get};
    use http_body_util::BodyExt;
    use serde_json::json;
    use tower::ServiceExt;

    async fn echo_ctx(
        Extension(ctx): Extension<V1RequestContext>,
        req: Request<Body>,
    ) -> Json<serde_json::Value> {
        let leaked = INTERNAL_HEADERS
            .iter()
            .filter(|&&h| req.headers().contains_key(h))
            .copied()
            .collect::<Vec<_>>();
        Json(json!({
            "requestId": ctx.request_id,
            "keyId": ctx.key.as_ref().map(|k| k.key_id.clone()),
            "tier": ctx.key.as_ref().map(|k| k.tier.clone()),
            "projectId": ctx.key.as_ref().and_then(|k| k.project_id.clone()),
            "leaked": leaked,
        }))
    }

    fn v1_app(config: ApiConfig) -> Router {
        let state = test_app_state(config);
        Router::new()
            .route("/v1", get(echo_ctx))
            .route("/v1/health", get(echo_ctx))
            .route("/v1/open-api.json", get(echo_ctx))
            .route("/v1/offers", get(echo_ctx).options(echo_ctx))
            .route("/offers", get(echo_ctx))
            .layer(middleware::from_fn(v1_cache_policy))
            .layer(middleware::from_fn_with_state(state, v1_context))
    }

    #[test]
    fn relative_path_matches_ts_behavior() {
        assert_eq!(relative_v1_path("/v1"), "/");
        assert_eq!(relative_v1_path("/v1/health"), "/health");
        assert_eq!(relative_v1_path("/health"), "/health");
        assert!(is_public_v1_path("/v1/health"));
        assert!(is_public_v1_path("/v1/open-api.json"));
        assert!(!is_public_v1_path("/v1"));
        assert!(!is_public_v1_path("/v1/offers"));
    }

    #[tokio::test]
    async fn enforces_worker_and_key_context_and_propagates_request_id() {
        // 1. Worker auth required, token missing -> 503 WORKER_AUTH_NOT_CONFIGURED
        let uncfg = ApiConfig {
            v1_worker_token: None,
            v1_worker_auth_required: true,
            ..Default::default()
        };
        let resp = v1_app(uncfg)
            .oneshot(
                Request::builder()
                    .uri("/v1/offers")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(resp.headers().get("x-request-id").is_some());
        let body: serde_json::Value =
            serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(body["code"], "WORKER_AUTH_NOT_CONFIGURED");

        // 2. Worker auth required, wrong token -> 403 UNTRUSTED_WORKER (and supplied request-id ignored)
        let cfg = ApiConfig {
            v1_worker_token: Some("worker-secret".into()),
            v1_worker_auth_required: true,
            ..Default::default()
        };
        let app = v1_app(cfg);
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/offers")
                    .header("x-egdata-worker-token", "bad")
                    .header("x-egdata-request-id", "req_custom_123456")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        let req_id = resp
            .headers()
            .get("x-request-id")
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert!(req_id.starts_with("req_"));
        assert_ne!(req_id, "req_custom_123456");
        let body: serde_json::Value =
            serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(body["code"], "UNTRUSTED_WORKER");

        // 3. Valid worker, invalid key id -> 401 MISSING_KEY_CONTEXT
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/offers")
                    .header("x-egdata-worker-token", "worker-secret")
                    .header("x-request-id", "req_valid_123456")
                    .header("x-egdata-key-id", "bad")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            resp.headers().get("x-request-id").unwrap(),
            "req_valid_123456"
        );
        let body: serde_json::Value =
            serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(body["code"], "MISSING_KEY_CONTEXT");

        // 4. Valid worker, valid key id, invalid tier -> 403 INVALID_KEY_CONTEXT
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/offers")
                    .header("x-egdata-worker-token", "worker-secret")
                    .header("x-egdata-key-id", "key_abc123")
                    .header("x-egdata-key-tier", "gold")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        let body: serde_json::Value =
            serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(body["code"], "INVALID_KEY_CONTEXT");

        // 5. Valid worker, key id, tier (mixed case), project -> 200 + headers stripped + cache policy
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/offers")
                    .header("x-egdata-worker-token", "worker-secret")
                    .header("x-egdata-origin-token", "should-strip")
                    .header("x-egdata-authenticated", "1")
                    .header("x-egdata-request-id", "req_trace_9999")
                    .header("x-egdata-key-id", "key_abc123")
                    .header("x-egdata-key-tier", "PRO")
                    .header("x-egdata-key-project", "proj_1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get("x-request-id").unwrap(),
            "req_trace_9999"
        );
        assert_eq!(
            resp.headers().get(header::CACHE_CONTROL).unwrap(),
            "private, no-cache"
        );
        assert_eq!(resp.headers().get("cdn-cache-control").unwrap(), "no-store");
        assert_eq!(
            resp.headers().get("cloudflare-cdn-cache-control").unwrap(),
            "no-store"
        );
        assert_eq!(
            resp.headers().get("x-content-type-options").unwrap(),
            "nosniff"
        );
        let body: serde_json::Value =
            serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(body["keyId"], "key_abc123");
        assert_eq!(body["tier"], "pro");
        assert_eq!(body["projectId"], "proj_1");
        assert_eq!(body["leaked"], json!([]));

        // 6. Public paths and OPTIONS bypass worker/key auth
        for (method, uri) in [
            (Method::GET, "/v1/health"),
            (Method::GET, "/v1/open-api.json"),
            (Method::OPTIONS, "/v1/offers"),
        ] {
            let resp = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(uri)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::OK);
            assert_eq!(resp.headers().get("cdn-cache-control").unwrap(), "no-store");
            assert_eq!(
                resp.headers().get("x-content-type-options").unwrap(),
                "nosniff"
            );
            let body: serde_json::Value =
                serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes())
                    .unwrap();
            assert!(body["keyId"].is_null());
        }

        // 7. Worker auth disabled, empty projectId becomes null, relative non-/v1 path
        let no_worker_cfg = ApiConfig {
            v1_worker_token: None,
            v1_worker_auth_required: false,
            ..Default::default()
        };
        let resp = v1_app(no_worker_cfg)
            .oneshot(
                Request::builder()
                    .uri("/offers")
                    .header("x-request-id", "req_local_12345")
                    .header("x-egdata-key-id", "key_local1")
                    .header("x-egdata-key-tier", "free")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body: serde_json::Value =
            serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(body["requestId"], "req_local_12345");
        assert!(body["projectId"].is_null());
    }

    #[tokio::test]
    async fn v1_cache_policy_skips_429_5xx_and_preserves_existing_private_cc() {
        let app = Router::new()
            .route(
                "/v1/500",
                get(|| async { (StatusCode::INTERNAL_SERVER_ERROR, "err") }),
            )
            .route(
                "/v1/429",
                get(|| async { (StatusCode::TOO_MANY_REQUESTS, "slow") }),
            )
            .route(
                "/v1/private",
                get(|| async {
                    (
                        [(header::CACHE_CONTROL, "private, max-age=30")],
                        "custom-cc",
                    )
                }),
            )
            .route(
                "/v1/public-cc",
                get(|| async { ([(header::CACHE_CONTROL, "public, max-age=60")], "override") }),
            )
            .layer(middleware::from_fn(v1_cache_policy));

        for uri in ["/v1/500", "/v1/429"] {
            let resp = app
                .clone()
                .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert!(resp.headers().get("x-content-type-options").is_none());
        }

        let priv_resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/private")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            priv_resp.headers().get(header::CACHE_CONTROL).unwrap(),
            "private, max-age=30"
        );
        assert_eq!(
            priv_resp
                .headers()
                .get("cloudflare-cdn-cache-control")
                .unwrap(),
            "no-store"
        );

        let ov_resp = app
            .oneshot(
                Request::builder()
                    .uri("/v1/public-cc")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            ov_resp.headers().get(header::CACHE_CONTROL).unwrap(),
            "private, no-cache"
        );
    }
}
