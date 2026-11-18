//! ETag generation and conditional `304 Not Modified` middleware (`src/middlewares/response-etag.ts`).

use axum::{
    body::Body,
    extract::Request,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::Next,
    response::Response,
};
use http_body_util::BodyExt;
use sha1::{Digest, Sha1};

use crate::middleware::anti_abuse::AntiAbuseCanaryResponse;

const RETAINED_304_HEADERS: &[header::HeaderName] = &[
    header::CACHE_CONTROL,
    header::CONTENT_LOCATION,
    header::DATE,
    header::ETAG,
    header::EXPIRES,
    header::VARY,
];

fn strip_weak(tag: &str) -> &str {
    tag.strip_prefix("W/").unwrap_or(tag)
}

fn etag_matches(etag: &str, if_none_match: &str) -> bool {
    let target = strip_weak(etag);
    if_none_match
        .split(',')
        .enumerate()
        .any(|(index, candidate)| {
            let candidate = if index == 0 {
                candidate
            } else {
                candidate.trim_start()
            };
            strip_weak(candidate) == target
        })
}

fn retain_304_headers(headers: &mut HeaderMap, etag_val: HeaderValue) {
    // Hono 4.12's Context.res copies existing headers except content-type. Its
    // ETag middleware then deletes headers while iterating the live, sorted
    // Headers list; deleting one skips the next entry. Preserve this observable
    // behavior until the Node origin changes, guarded by the HTTP oracle.
    headers.remove(header::CONTENT_TYPE);
    headers.insert(header::ETAG, etag_val);
    let mut names = headers.keys().cloned().collect::<Vec<_>>();
    names.sort_by(|a, b| a.as_str().cmp(b.as_str()));
    let mut index = 0;
    while index < names.len() {
        if !RETAINED_304_HEADERS.contains(&names[index]) {
            headers.remove(&names[index]);
            names.remove(index);
        }
        index += 1;
    }
}

fn is_skipped_path(path: &str) -> bool {
    path == "/catalog/hydrate" || path == "/v1/catalog/hydrate"
}

/// Applies ETag computation and `If-None-Match` validation with configurable weak/strong mode.
pub async fn response_etag_with_weak(weak: bool, req: Request<Body>, next: Next) -> Response {
    let path = req.uri().path().to_string();
    let req_canary = req
        .extensions()
        .get::<AntiAbuseCanaryResponse>()
        .is_some_and(|c| c.0);
    if req_canary || is_skipped_path(&path) {
        return next.run(req).await;
    }

    let if_none_match = req
        .headers()
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    let mut resp = next.run(req).await;

    if resp
        .extensions()
        .get::<AntiAbuseCanaryResponse>()
        .is_some_and(|c| c.0)
    {
        return resp;
    }

    let mut etag = resp
        .headers()
        .get(header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    if etag.is_none() {
        let (mut parts, body) = resp.into_parts();
        let Ok(collected) = body.collect().await else {
            return Response::from_parts(parts, Body::empty());
        };
        let bytes = collected.to_bytes();
        if !bytes.is_empty() {
            let digest = hex::encode(Sha1::digest(&bytes));
            let formatted = if weak {
                format!("W/\"{digest}\"")
            } else {
                format!("\"{digest}\"")
            };
            etag = Some(formatted);
        }
        parts.headers.remove(header::CONTENT_LENGTH);
        resp = Response::from_parts(parts, Body::from(bytes));
    }

    let Some(etag_str) = etag else {
        return resp;
    };
    let Ok(etag_val) = HeaderValue::from_str(&etag_str) else {
        return resp;
    };

    if if_none_match
        .as_deref()
        .is_some_and(|inm| etag_matches(&etag_str, inm))
    {
        let (mut parts, _) = resp.into_parts();
        parts.status = StatusCode::NOT_MODIFIED;
        retain_304_headers(&mut parts.headers, etag_val);
        return Response::from_parts(parts, Body::empty());
    }

    resp.headers_mut().insert(header::ETAG, etag_val);
    resp
}

/// Default strong-ETag Axum middleware matching `responseEtag` in `src/middlewares/response-etag.ts`.
pub async fn response_etag(req: Request<Body>, next: Next) -> Response {
    response_etag_with_weak(false, req, next).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, middleware, routing::get};
    use tower::ServiceExt;

    #[tokio::test]
    async fn computes_strong_and_weak_etags_and_handles_304() {
        let app = Router::new()
            .route(
                "/hello",
                get(|| async {
                    (
                        [
                            (header::CACHE_CONTROL, "public, max-age=60"),
                            (header::CONTENT_TYPE, "text/plain"),
                        ],
                        "hello world",
                    )
                }),
            )
            .route("/empty", get(|| async { (StatusCode::OK, "") }))
            .route(
                "/err",
                get(|| async { (StatusCode::NOT_FOUND, "not found") }),
            )
            .route(
                "/preset",
                get(|| async { ([(header::ETAG, "\"preset-1\"")], "body") }),
            )
            .route("/catalog/hydrate", get(|| async { "stream" }))
            .route("/v1/catalog/hydrate", get(|| async { "stream" }))
            .route(
                "/canary-ext",
                get(|| async {
                    let mut resp = Response::new(Body::from("canary"));
                    resp.extensions_mut().insert(AntiAbuseCanaryResponse(true));
                    resp
                }),
            )
            .layer(middleware::from_fn(response_etag));

        // Computes SHA-1 strong ETag on 200
        let r1 = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/hello")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r1.status(), StatusCode::OK);
        let etag = r1
            .headers()
            .get(header::ETAG)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert!(etag.starts_with('"') && etag.ends_with('"'));

        // If-None-Match matching strong or weak equivalent -> 304 Not Modified
        let r_304 = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/hello")
                    .header(header::IF_NONE_MATCH, format!("W/{etag}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_304.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(r_304.headers().get(header::ETAG).unwrap(), etag.as_str());
        assert_eq!(
            r_304.headers().get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=60"
        );
        assert!(r_304.headers().get(header::CONTENT_TYPE).is_none());
        assert!(
            r_304
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .is_empty()
        );

        // Mismatching If-None-Match -> 200
        let r_miss = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/hello")
                    .header(header::IF_NONE_MATCH, "\"other\"")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_miss.status(), StatusCode::OK);

        // Empty body -> no ETag
        let r_empty = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/empty")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(r_empty.headers().get(header::ETAG).is_none());

        // Hono also hashes error response bodies.
        let r_err = app
            .clone()
            .oneshot(Request::builder().uri("/err").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(r_err.status(), StatusCode::NOT_FOUND);
        assert!(r_err.headers().get(header::ETAG).is_some());

        // Preset ETag preserved
        let r_preset = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/preset")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            r_preset.headers().get(header::ETAG).unwrap(),
            "\"preset-1\""
        );

        // Skips /catalog/hydrate, /v1/catalog/hydrate, and response canary extension
        for uri in ["/catalog/hydrate", "/v1/catalog/hydrate", "/canary-ext"] {
            let skipped = app
                .clone()
                .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert!(skipped.headers().get(header::ETAG).is_none(), "uri={uri}");
        }

        // Skips when request has AntiAbuseCanaryResponse(true)
        let mut req_with_canary = Request::builder()
            .uri("/hello")
            .body(Body::empty())
            .unwrap();
        req_with_canary
            .extensions_mut()
            .insert(AntiAbuseCanaryResponse(true));
        let r_req_canary = app.oneshot(req_with_canary).await.unwrap();
        assert!(r_req_canary.headers().get(header::ETAG).is_none());

        // Weak ETag mode
        let weak_app = Router::new()
            .route("/hello", get(|| async { "hello world" }))
            .layer(middleware::from_fn(|req, next| {
                response_etag_with_weak(true, req, next)
            }));
        let r_weak = weak_app
            .oneshot(
                Request::builder()
                    .uri("/hello")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let weak_etag = r_weak
            .headers()
            .get(header::ETAG)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(weak_etag.starts_with("W/\""));
    }
}
