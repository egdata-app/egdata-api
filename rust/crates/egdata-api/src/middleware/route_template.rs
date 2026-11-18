//! Route template normalization middleware (`src/middlewares/route-template.ts`).

use std::sync::OnceLock;

use axum::{
    body::Body,
    extract::Request,
    http::{HeaderName, HeaderValue},
    middleware::Next,
    response::Response,
};
use regex::Regex;

fn numeric_id_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\d{4,}$").expect("valid regex"))
}

fn uuid_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b",
        )
        .expect("valid regex")
    })
}

fn seller_id_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\bo-[a-z0-9]{20,}\b").expect("valid regex"))
}

fn hex_id_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\b[0-9a-f]{24,32}\b").expect("valid regex"))
}

/// Normalizes document/seller/UUID/numeric identifiers in `path` (`routeTemplateForPath`).
pub fn route_template_for_path(path: &str) -> String {
    path.split('/')
        .map(|segment| {
            if segment.is_empty() {
                return String::new();
            }
            if numeric_id_regex().is_match(segment) {
                return "{id}".to_string();
            }
            let with_uuid = uuid_regex().replace_all(segment, "{uuid}");
            let with_seller = seller_id_regex().replace_all(&with_uuid, "{sellerId}");
            hex_id_regex()
                .replace_all(&with_seller, "{id}")
                .into_owned()
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Axum middleware attaching `X-Route-Template` unless already present on the response.
pub async fn route_template(req: Request<Body>, next: Next) -> Response {
    let path = req.uri().path().to_string();
    let mut resp = next.run(req).await;

    if resp.headers().contains_key("x-route-template") {
        return resp;
    }

    if let Ok(val) = HeaderValue::from_str(&route_template_for_path(&path)) {
        resp.headers_mut()
            .insert(HeaderName::from_static("x-route-template"), val);
    }
    resp
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, middleware, routing::get};
    use tower::ServiceExt;

    #[test]
    fn normalizes_segments_matching_ts() {
        assert_eq!(
            route_template_for_path("/offers/014812a6932f45bebfa6313ee17ddac0/og"),
            "/offers/{id}/og"
        );
        assert_eq!(
            route_template_for_path("/sellers/o-1234567890abcdefghij"),
            "/sellers/{sellerId}"
        );
        assert_eq!(route_template_for_path("/builds/123456"), "/builds/{id}");
        assert_eq!(route_template_for_path("/builds/123"), "/builds/123");
        assert_eq!(
            route_template_for_path("/events/550e8400-e29b-41d4-a716-446655440000"),
            "/events/{uuid}"
        );
        assert_eq!(
            route_template_for_path("/items/507f1f77bcf86cd799439011"),
            "/items/{id}"
        );
        assert_eq!(route_template_for_path("/"), "/");
    }

    #[tokio::test]
    async fn middleware_sets_and_respects_existing_header() {
        let app = Router::new()
            .route(
                "/offers/014812a6932f45bebfa6313ee17ddac0/og",
                get(|| async { "ok" }),
            )
            .route(
                "/custom",
                get(|| async { ([("x-route-template", "/fixed")], "ok") }),
            )
            .layer(middleware::from_fn(route_template));

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/offers/014812a6932f45bebfa6313ee17ddac0/og")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            resp.headers().get("x-route-template").unwrap(),
            "/offers/{id}/og"
        );

        let custom = app
            .oneshot(
                Request::builder()
                    .uri("/custom")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(custom.headers().get("x-route-template").unwrap(), "/fixed");
    }
}
