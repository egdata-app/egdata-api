//! Worker-to-origin authentication middleware (`src/middlewares/origin-auth.ts`).

use axum::{
    Json,
    body::Body,
    extract::{Request, State},
    http::{HeaderName, HeaderValue, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::state::{ApiConfig, AppState};

const GATEWAY_IDENTITY_HEADERS: &[&str] = &[
    "x-egdata-authenticated",
    "x-egdata-key-id",
    "x-egdata-key-tier",
    "x-egdata-key-project",
];

/// Request extension recording whether the Worker gateway verified client authentication.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrustedGatewayAuthenticated(pub bool);

/// Constant-time equality over fixed-length SHA-256 digests.
pub(crate) fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// SHA-256 constant-time string comparison matching `createHash("sha256")` + `timingSafeEqual`.
pub(crate) fn sha256_secure_eq(a: &str, b: &str) -> bool {
    let left = Sha256::digest(a.as_bytes());
    let right = Sha256::digest(b.as_bytes());
    constant_time_eq(&left, &right)
}

fn extract_hostname(req: &Request<Body>) -> String {
    let raw = req
        .uri()
        .host()
        .or_else(|| {
            req.headers()
                .get(header::HOST)
                .and_then(|v| v.to_str().ok())
                .map(|host| {
                    if let Some(rest) = host.strip_prefix('[') {
                        rest.split(']').next().unwrap_or(host)
                    } else {
                        host.split(':').next().unwrap_or(host)
                    }
                })
        })
        .unwrap_or("");
    raw.to_ascii_lowercase().trim_end_matches('.').to_string()
}

fn no_store_headers(resp: &mut Response) {
    let headers = resp.headers_mut();
    headers.insert(
        header::CACHE_CONTROL,
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
}

/// Core origin authentication check parameterized by [`ApiConfig`].
pub async fn origin_auth_with_config(
    config: &ApiConfig,
    mut req: Request<Body>,
    next: Next,
) -> Response {
    let expected = config
        .origin_auth_token
        .as_deref()
        .filter(|t| !t.is_empty())
        .map(|t| Sha256::digest(t.as_bytes()));
    let origin_host = config
        .origin_auth_host
        .to_ascii_lowercase()
        .trim_end_matches('.')
        .to_string();

    let supplied = req
        .headers()
        .get("x-egdata-origin-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    // Keep this infrastructure credential away from downstream handlers/loggers.
    req.headers_mut().remove("x-egdata-origin-token");

    let token_valid = expected.as_ref().is_some_and(|exp| {
        !supplied.is_empty() && constant_time_eq(exp, &Sha256::digest(supplied.as_bytes()))
    });

    if !token_valid {
        for &name in GATEWAY_IDENTITY_HEADERS {
            req.headers_mut().remove(name);
        }
        req.extensions_mut()
            .insert(TrustedGatewayAuthenticated(false));
    } else {
        let authed = req
            .headers()
            .get("x-egdata-authenticated")
            .and_then(|v| v.to_str().ok())
            == Some("1");
        req.extensions_mut()
            .insert(TrustedGatewayAuthenticated(authed));
    }

    let hostname = extract_hostname(&req);
    if !config.origin_auth_required && hostname != origin_host {
        return next.run(req).await;
    }

    if !token_valid {
        let (status, code, message) = if expected.is_some() {
            (
                StatusCode::FORBIDDEN,
                "ORIGIN_ACCESS_DENIED",
                "Use the public API gateway at https://api.egdata.app.",
            )
        } else {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "ORIGIN_NOT_CONFIGURED",
                "The API origin is not configured.",
            )
        };
        let mut resp = (
            status,
            Json(json!({
                "error": {
                    "code": code,
                    "message": message,
                }
            })),
        )
            .into_response();
        no_store_headers(&mut resp);
        return resp;
    }

    next.run(req).await
}

/// Axum middleware enforcing Worker-to-origin authentication from [`AppState`].
pub async fn origin_auth(
    State(state): State<AppState>,
    req: Request<Body>,
    next: Next,
) -> Response {
    origin_auth_with_config(&state.config, req, next).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::middleware::test_support::test_app_state;
    use axum::{Extension, Router, middleware, routing::get};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    async fn echo_headers(
        Extension(trusted): Extension<TrustedGatewayAuthenticated>,
        req: Request<Body>,
    ) -> impl IntoResponse {
        let headers: Vec<(&str, Option<String>)> = [
            "x-egdata-origin-token",
            "x-egdata-authenticated",
            "x-egdata-key-id",
            "x-egdata-key-tier",
            "x-egdata-key-project",
        ]
        .into_iter()
        .map(|k| {
            (
                k,
                req.headers()
                    .get(k)
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string),
            )
        })
        .collect();
        Json(json!({
            "trusted": trusted.0,
            "originToken": headers[0].1,
            "authed": headers[1].1,
            "keyId": headers[2].1,
            "tier": headers[3].1,
            "project": headers[4].1,
        }))
    }

    fn app_with(config: ApiConfig) -> Router {
        let state = test_app_state(config);
        Router::new()
            .route("/test", get(echo_headers))
            .layer(middleware::from_fn_with_state(state, origin_auth))
    }

    #[test]
    fn constant_time_helpers_cover_lengths() {
        assert!(!constant_time_eq(b"ab", b"abc"));
        assert!(!constant_time_eq(b"ab", b"ac"));
        assert!(constant_time_eq(b"ab", b"ab"));
        assert!(sha256_secure_eq("secret", "secret"));
        assert!(!sha256_secure_eq("secret", "other"));
    }

    #[tokio::test]
    async fn strips_headers_and_allows_unprotected_host_when_not_required() {
        let cfg = ApiConfig {
            origin_auth_token: Some("origin-secret".into()),
            origin_auth_required: false,
            origin_auth_host: "origin-api.egdata.app.".into(),
            ..Default::default()
        };
        let app = app_with(cfg);

        // Invalid token on non-origin host: allowed through, headers stripped, trusted=false
        let req = Request::builder()
            .uri("/test")
            .header("host", "localhost:4001")
            .header("x-egdata-origin-token", "wrong")
            .header("x-egdata-authenticated", "1")
            .header("x-egdata-key-id", "key_12345")
            .header("x-egdata-key-tier", "pro")
            .header("x-egdata-key-project", "proj")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body: serde_json::Value =
            serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(body["trusted"], false);
        assert!(body["originToken"].is_null());
        assert!(body["authed"].is_null());
        assert!(body["keyId"].is_null());
        assert!(body["tier"].is_null());
        assert!(body["project"].is_null());

        // Valid token on non-origin host with authed=1: keeps identity headers, strips origin token
        let req = Request::builder()
            .uri("/test")
            .header("host", "[::1]:4001")
            .header("x-egdata-origin-token", "origin-secret")
            .header("x-egdata-authenticated", "1")
            .header("x-egdata-key-id", "key_12345")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body: serde_json::Value =
            serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(body["trusted"], true);
        assert!(body["originToken"].is_null());
        assert_eq!(body["keyId"], "key_12345");
    }

    #[tokio::test]
    async fn blocks_protected_host_or_when_required() {
        // Configured token -> 403 ORIGIN_ACCESS_DENIED on protected host
        let cfg = ApiConfig {
            origin_auth_token: Some("origin-secret".into()),
            origin_auth_required: false,
            origin_auth_host: "origin-api.egdata.app".into(),
            ..Default::default()
        };
        let app = app_with(cfg);

        let blocked = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/test")
                    .header("host", "ORIGIN-API.EGDATA.APP.:443")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(blocked.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            blocked.headers().get(header::CACHE_CONTROL).unwrap(),
            "private, no-store"
        );
        assert_eq!(
            blocked.headers().get("cdn-cache-control").unwrap(),
            "no-store"
        );
        assert_eq!(
            blocked
                .headers()
                .get("cloudflare-cdn-cache-control")
                .unwrap(),
            "no-store"
        );
        let json: serde_json::Value =
            serde_json::from_slice(&blocked.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(json["error"]["code"], "ORIGIN_ACCESS_DENIED");

        // Valid token succeeds on protected host (x-egdata-authenticated != "1" -> trusted=false)
        let ok = app
            .oneshot(
                Request::builder()
                    .uri("https://origin-api.egdata.app/test")
                    .header("x-egdata-origin-token", "origin-secret")
                    .header("x-egdata-authenticated", "0")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(ok.status(), StatusCode::OK);
        let ok_json: serde_json::Value =
            serde_json::from_slice(&ok.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(ok_json["trusted"], false);

        // Missing/empty token when required -> 503 ORIGIN_NOT_CONFIGURED
        let unconfigured = ApiConfig {
            origin_auth_token: Some(String::new()),
            origin_auth_required: true,
            ..Default::default()
        };
        let unconfigured_resp = app_with(unconfigured)
            .oneshot(Request::builder().uri("/test").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(unconfigured_resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        let uncfg_json: serde_json::Value = serde_json::from_slice(
            &unconfigured_resp
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes(),
        )
        .unwrap();
        assert_eq!(uncfg_json["error"]["code"], "ORIGIN_NOT_CONFIGURED");
    }
}
