//! CORS middleware (`src/middlewares/cors.ts`).

use axum::{
    body::Body,
    extract::Request,
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::Next,
    response::Response,
};
use url::Url;

const EXACT_ALLOWED_ORIGINS: &[&str] = &[
    "https://egdata.app",
    "http://localhost:5173",
    "http://localhost:3000",
    "http://localhost:4000",
    "https://egdata-370475041422.us-central1.run.app",
    "https://store.epicgames.com",
];

const ALLOW_HEADERS: &str = "Content-Type,Authorization,apollographql-client-name,apollographql-client-version,apollo-require-preflight,x-api-key,x-egdata-session";
const ALLOW_METHODS: &str = "GET,HEAD,PUT,POST,DELETE,PATCH";
const EXPOSE_HEADERS: &str = "Cache-Control,CDN-Cache-Control,ETag,X-Total-Count,X-Cache,X-Route-Template,X-Egdata-Mitigation,Retry-After,Server-Timing,RateLimit,RateLimit-Policy";

/// Validates whether `origin` is permitted for CORS (`allowedCorsOrigin`).
pub fn allowed_cors_origin(origin: &str) -> Option<&str> {
    if EXACT_ALLOWED_ORIGINS.contains(&origin) {
        return Some(origin);
    }
    let parsed = Url::parse(origin).ok()?;
    if parsed.origin().ascii_serialization() != origin
        || parsed.scheme() != "https"
        || parsed.port().is_some()
    {
        return None;
    }
    let host = parsed.host_str()?;
    if host == "egdata.app" || host.ends_with(".egdata.app") {
        Some(origin)
    } else {
        None
    }
}

pub(crate) fn append_vary_token(headers: &mut HeaderMap, token: &str) {
    let existing = headers
        .get_all(header::VARY)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .collect::<Vec<_>>()
        .join(", ");
    if existing.is_empty() {
        if let Ok(val) = HeaderValue::from_str(token) {
            headers.insert(header::VARY, val);
        }
        return;
    }
    let already_present = existing
        .split(',')
        .map(str::trim)
        .any(|item| item.eq_ignore_ascii_case(token));
    if !already_present && let Ok(val) = HeaderValue::from_str(&format!("{existing}, {token}")) {
        headers.insert(header::VARY, val);
    }
}

fn apply_common_cors_headers(headers: &mut HeaderMap, allow_origin: Option<&str>) {
    if let Some(origin) = allow_origin
        && let Ok(val) = HeaderValue::from_str(origin)
    {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, val);
    }
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
        HeaderValue::from_static("true"),
    );
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static(EXPOSE_HEADERS),
    );
}

/// Axum middleware applying `apiCors()` policy matching Hono's `cors` middleware.
pub async fn api_cors(req: Request<Body>, next: Next) -> Response {
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let allow_origin = allowed_cors_origin(&origin).map(str::to_string);

    if req.method() == Method::OPTIONS {
        let mut resp = Response::new(Body::empty());
        *resp.status_mut() = StatusCode::NO_CONTENT;
        let headers = resp.headers_mut();
        apply_common_cors_headers(headers, allow_origin.as_deref());
        append_vary_token(headers, "Origin");
        headers.insert(
            header::ACCESS_CONTROL_MAX_AGE,
            HeaderValue::from_static("600"),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static(ALLOW_METHODS),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static(ALLOW_HEADERS),
        );
        append_vary_token(headers, "Access-Control-Request-Headers");
        headers.remove(header::CONTENT_LENGTH);
        headers.remove(header::CONTENT_TYPE);
        return resp;
    }

    let mut resp = next.run(req).await;
    apply_common_cors_headers(resp.headers_mut(), allow_origin.as_deref());
    append_vary_token(resp.headers_mut(), "Origin");
    resp
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, middleware, routing::get};
    use tower::ServiceExt;

    #[test]
    fn allowed_origin_validation_matches_ts() {
        for ok in [
            "https://egdata.app",
            "https://api.egdata.app",
            "https://staging.api.egdata.app",
            "http://localhost:5173",
            "http://localhost:3000",
            "http://localhost:4000",
            "https://egdata-370475041422.us-central1.run.app",
            "https://store.epicgames.com",
        ] {
            assert_eq!(allowed_cors_origin(ok), Some(ok), "expected {ok} allowed");
        }

        for bad in [
            "",
            "not-a-url",
            "http://egdata.app",
            "http://sub.egdata.app",
            "https://egdata.app:8443",
            "https://sub.egdata.app:8443",
            "https://egdata.app/",
            "https://egdata.app/path",
            "https://user:pass@egdata.app",
            "https://evil-egdata.app",
            "https://egdata.app.evil.com",
        ] {
            assert_eq!(allowed_cors_origin(bad), None, "expected {bad} rejected");
        }
    }

    #[tokio::test]
    async fn cors_handles_preflight_and_actual_requests() {
        let app = Router::new()
            .route(
                "/test",
                get(|| async { ([(header::VARY, "Accept-Encoding")], "ok") }),
            )
            .layer(middleware::from_fn(api_cors));

        // Preflight from allowed subdomain
        let preflight = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::OPTIONS)
                    .uri("/test")
                    .header(header::ORIGIN, "https://next.egdata.app")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(preflight.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            preflight
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .unwrap(),
            "https://next.egdata.app"
        );
        assert_eq!(
            preflight
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_CREDENTIALS)
                .unwrap(),
            "true"
        );
        assert_eq!(
            preflight
                .headers()
                .get(header::ACCESS_CONTROL_MAX_AGE)
                .unwrap(),
            "600"
        );
        assert_eq!(
            preflight
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_METHODS)
                .unwrap(),
            ALLOW_METHODS
        );
        assert_eq!(
            preflight
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_HEADERS)
                .unwrap(),
            ALLOW_HEADERS
        );
        assert_eq!(
            preflight
                .headers()
                .get(header::ACCESS_CONTROL_EXPOSE_HEADERS)
                .unwrap(),
            EXPOSE_HEADERS
        );
        let vary = preflight
            .headers()
            .get(header::VARY)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(vary.contains("Origin"));
        assert!(vary.contains("Access-Control-Request-Headers"));

        // Actual GET from disallowed origin -> no Allow-Origin, still exposes & Vary: Accept-Encoding, Origin
        let disallowed = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/test")
                    .header(header::ORIGIN, "https://evil.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(disallowed.status(), StatusCode::OK);
        assert!(
            disallowed
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .is_none()
        );
        assert_eq!(
            disallowed
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_CREDENTIALS)
                .unwrap(),
            "true"
        );
        assert_eq!(
            disallowed.headers().get(header::VARY).unwrap(),
            "Accept-Encoding, Origin"
        );

        // Append vary when Origin is already present is idempotent
        let mut hm = HeaderMap::new();
        hm.insert(header::VARY, HeaderValue::from_static("Origin"));
        append_vary_token(&mut hm, "origin");
        assert_eq!(hm.get(header::VARY).unwrap(), "Origin");
    }
}
