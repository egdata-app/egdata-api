//! Edge cache headers middleware (`src/middlewares/edge-cache.ts`).

use std::sync::OnceLock;

use axum::{
    body::Body,
    extract::Request,
    http::{HeaderName, HeaderValue, Method, StatusCode, header},
    middleware::Next,
    response::Response,
};
use regex::Regex;

use crate::middleware::cors::append_vary_token;

const SKIP_EXACT: &[&str] = &[
    "/",
    "/health",
    "/ping",
    "/robots.txt",
    "/open-api.json",
    "/doc",
    "/ui",
];

const SKIP_PREFIXES: &[&str] = &[
    "/auth",
    "/accounts",
    "/admin",
    "/users",
    "/users-service",
    "/push",
    "/launcher",
    "/catalog",
    "/offers/regen",
    "/items/regen",
    "/search/natural-language",
    "/graphql",
];

struct StaticRule {
    browser: &'static str,
    cdn: &'static str,
}

const RULE_AUTOCOMPLETE: StaticRule = StaticRule {
    browser: "public, max-age=60, s-maxage=60",
    cdn: "public, max-age=60",
};
const RULE_HOMEPAGE: StaticRule = StaticRule {
    browser: "public, max-age=60, s-maxage=300",
    cdn: "public, max-age=300",
};
const RULE_COUNTRIES_REGIONS: StaticRule = StaticRule {
    browser: "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400",
    cdn: "public, max-age=86400, stale-while-revalidate=604800",
};
const RULE_FREE_GAMES_STATS: StaticRule = StaticRule {
    browser: "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400",
    cdn: "public, max-age=86400, stale-while-revalidate=604800",
};
const RULE_TAGS_GENRES: StaticRule = StaticRule {
    browser: "public, max-age=300, s-maxage=3600, stale-while-revalidate=3600",
    cdn: "public, max-age=3600, stale-while-revalidate=86400",
};
const RULE_SELLERS_LIST: StaticRule = StaticRule {
    browser: "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400",
    cdn: "public, max-age=3600, stale-while-revalidate=86400",
};
const RULE_OFFERS_FEATURED: StaticRule = StaticRule {
    browser: "public, max-age=300, s-maxage=3600, stale-while-revalidate=3600",
    cdn: "public, max-age=3600, stale-while-revalidate=86400",
};
const RULE_CATALOG_RESOURCES: StaticRule = StaticRule {
    browser: "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
    cdn: "public, max-age=300, stale-while-revalidate=3600",
};
const RULE_PROFILES: StaticRule = StaticRule {
    browser: "public, max-age=60, s-maxage=300, stale-while-revalidate=300",
    cdn: "public, max-age=300, stale-while-revalidate=3600",
};
const RULE_SEARCH_V2: StaticRule = StaticRule {
    browser: "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
    cdn: "public, max-age=300, stale-while-revalidate=3600",
};

fn private_cc_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)(?:^|,)\s*(?:private|no-store|no-cache)\s*(?:,|$)").expect("valid regex")
    })
}

fn catalog_resources_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^/(?:offers|items|builds|changelist|free-games|collections|franchises|promotions|sandboxes|sellers|game-awards|multisearch)(?:/|$)")
            .expect("valid regex")
    })
}

fn matches_public_profile_path(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("/profiles/") else {
        return false;
    };
    if rest == "me" || rest.starts_with("me/") {
        return false;
    }
    let mut parts = rest.split('/');
    let first = parts.next().unwrap_or("");
    let second = parts.next();
    if !first.is_empty() && matches!(second, Some("refresh" | "information" | "refresh-status")) {
        return false;
    }
    true
}

fn find_rule(path: &str) -> Option<&'static StaticRule> {
    match path {
        "/autocomplete" => Some(&RULE_AUTOCOMPLETE),
        "/stats/homepage" => Some(&RULE_HOMEPAGE),
        "/countries" | "/regions" => Some(&RULE_COUNTRIES_REGIONS),
        "/free-games/stats" => Some(&RULE_FREE_GAMES_STATS),
        "/tags" | "/search/tags" | "/offers/genres" => Some(&RULE_TAGS_GENRES),
        "/sellers" => Some(&RULE_SELLERS_LIST),
        "/offers/top-sellers" | "/offers/top-wishlisted" | "/offers/featured-discounts" => {
            Some(&RULE_OFFERS_FEATURED)
        }
        _ if catalog_resources_regex().is_match(path) => Some(&RULE_CATALOG_RESOURCES),
        _ if matches_public_profile_path(path) => Some(&RULE_PROFILES),
        "/search/v2/search" => Some(&RULE_SEARCH_V2),
        _ => None,
    }
}

fn is_skipped_path(path: &str) -> bool {
    if SKIP_EXACT.contains(&path) {
        return true;
    }
    if SKIP_PREFIXES
        .iter()
        .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")))
    {
        return true;
    }
    if path.ends_with("/og") || path.ends_with("/og.webp") || path.ends_with("sitemap.xml") {
        return true;
    }
    if path.ends_with("/ownership") || path.ends_with("/permissions") {
        return true;
    }
    false
}

fn has_country_query(query: Option<&str>) -> bool {
    query.is_some_and(|q| url::form_urlencoded::parse(q.as_bytes()).any(|(k, _)| k == "country"))
}

/// Axum middleware applying shared CDN/browser cache headers (`edgeCacheHeaders`).
pub async fn edge_cache_headers(req: Request<Body>, next: Next) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let has_country = has_country_query(req.uri().query());

    let mut resp = next.run(req).await;

    if path == "/search/v2/search" {
        resp.headers_mut().insert(
            HeaderName::from_static("deprecation"),
            HeaderValue::from_static("true"),
        );
        resp.headers_mut().insert(
            header::LINK,
            HeaderValue::from_static("<https://devs.egdata.app>; rel=\"successor-version\""),
        );
    }

    if method == Method::GET {
        append_vary_token(resp.headers_mut(), "Accept-Encoding");
        if path == "/stats/homepage" && !has_country {
            append_vary_token(resp.headers_mut(), "Cookie");
        }
    }

    if method != Method::GET || resp.status() != StatusCode::OK {
        return resp;
    }
    if is_skipped_path(&path) || resp.headers().contains_key(header::SET_COOKIE) {
        return resp;
    }
    if resp
        .headers()
        .get(header::CACHE_CONTROL)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|cc| private_cc_regex().is_match(cc))
    {
        return resp;
    }

    if let Some(rule) = find_rule(&path) {
        resp.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static(rule.browser),
        );
        resp.headers_mut().insert(
            HeaderName::from_static("cdn-cache-control"),
            HeaderValue::from_static(rule.cdn),
        );
    }

    resp
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, middleware, routing::get};
    use tower::ServiceExt;

    async fn ok_handler() -> &'static str {
        "ok"
    }

    fn test_app() -> Router {
        Router::new()
            .route("/", get(ok_handler))
            .route("/health", get(ok_handler))
            .route("/autocomplete", get(ok_handler))
            .route("/stats/homepage", get(ok_handler))
            .route("/countries", get(ok_handler))
            .route("/regions", get(ok_handler))
            .route("/free-games/stats", get(ok_handler))
            .route("/tags", get(ok_handler))
            .route("/search/tags", get(ok_handler))
            .route("/offers/genres", get(ok_handler))
            .route("/sellers", get(ok_handler))
            .route("/offers/top-sellers", get(ok_handler))
            .route("/offers/1234", get(ok_handler))
            .route("/offers/1234/og", get(ok_handler))
            .route("/offers/1234/og.webp", get(ok_handler))
            .route("/offers-sitemap.xml", get(ok_handler))
            .route("/items/1234/ownership", get(ok_handler))
            .route("/offers/1234/permissions", get(ok_handler))
            .route("/offers/regen", get(ok_handler))
            .route("/profiles/abc", get(ok_handler))
            .route("/profiles/me", get(ok_handler))
            .route("/profiles/me/games", get(ok_handler))
            .route("/profiles/abc/refresh", get(ok_handler))
            .route("/profiles/abc/information", get(ok_handler))
            .route("/profiles/abc/refresh-status", get(ok_handler))
            .route("/search/v2/search", get(ok_handler))
            .route("/unmatched", get(ok_handler))
            .route(
                "/with-cookie",
                get(|| async { ([(header::SET_COOKIE, "a=b")], "ok") }),
            )
            .route(
                "/with-private",
                get(|| async { ([(header::CACHE_CONTROL, "private, no-store")], "ok") }),
            )
            .route(
                "/not-found",
                get(|| async { (StatusCode::NOT_FOUND, "missing") }),
            )
            .layer(middleware::from_fn(edge_cache_headers))
    }

    #[tokio::test]
    async fn applies_exact_rules_and_vary_headers() {
        let app = test_app();

        let cases = [
            (
                "/autocomplete",
                RULE_AUTOCOMPLETE.browser,
                RULE_AUTOCOMPLETE.cdn,
            ),
            (
                "/stats/homepage?country=US",
                RULE_HOMEPAGE.browser,
                RULE_HOMEPAGE.cdn,
            ),
            (
                "/countries",
                RULE_COUNTRIES_REGIONS.browser,
                RULE_COUNTRIES_REGIONS.cdn,
            ),
            (
                "/regions",
                RULE_COUNTRIES_REGIONS.browser,
                RULE_COUNTRIES_REGIONS.cdn,
            ),
            (
                "/free-games/stats",
                RULE_FREE_GAMES_STATS.browser,
                RULE_FREE_GAMES_STATS.cdn,
            ),
            ("/tags", RULE_TAGS_GENRES.browser, RULE_TAGS_GENRES.cdn),
            (
                "/search/tags",
                RULE_TAGS_GENRES.browser,
                RULE_TAGS_GENRES.cdn,
            ),
            (
                "/offers/genres",
                RULE_TAGS_GENRES.browser,
                RULE_TAGS_GENRES.cdn,
            ),
            ("/sellers", RULE_SELLERS_LIST.browser, RULE_SELLERS_LIST.cdn),
            (
                "/offers/top-sellers",
                RULE_OFFERS_FEATURED.browser,
                RULE_OFFERS_FEATURED.cdn,
            ),
            (
                "/offers/1234",
                RULE_CATALOG_RESOURCES.browser,
                RULE_CATALOG_RESOURCES.cdn,
            ),
            ("/profiles/abc", RULE_PROFILES.browser, RULE_PROFILES.cdn),
            (
                "/search/v2/search",
                RULE_SEARCH_V2.browser,
                RULE_SEARCH_V2.cdn,
            ),
        ];

        for (uri, browser, cdn) in cases {
            let resp = app
                .clone()
                .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::OK, "uri={uri}");
            assert_eq!(resp.headers().get(header::CACHE_CONTROL).unwrap(), browser);
            assert_eq!(resp.headers().get("cdn-cache-control").unwrap(), cdn);
            assert_eq!(resp.headers().get(header::VARY).unwrap(), "Accept-Encoding");
            if uri == "/search/v2/search" {
                assert_eq!(resp.headers().get("deprecation").unwrap(), "true");
                assert_eq!(
                    resp.headers().get(header::LINK).unwrap(),
                    "<https://devs.egdata.app>; rel=\"successor-version\""
                );
            } else {
                assert!(resp.headers().get("deprecation").is_none());
            }
        }

        // /stats/homepage without country adds Cookie to Vary
        let hp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/stats/homepage")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            hp.headers().get(header::VARY).unwrap(),
            "Accept-Encoding, Cookie"
        );
    }

    #[tokio::test]
    async fn skips_protected_private_non_get_non_200_and_unmatched() {
        let app = test_app();

        for uri in [
            "/",
            "/health",
            "/offers/1234/og",
            "/offers/1234/og.webp",
            "/offers-sitemap.xml",
            "/items/1234/ownership",
            "/offers/1234/permissions",
            "/offers/regen",
            "/profiles/me",
            "/profiles/me/games",
            "/profiles/abc/refresh",
            "/profiles/abc/information",
            "/profiles/abc/refresh-status",
            "/unmatched",
            "/with-cookie",
            "/not-found",
        ] {
            let resp = app
                .clone()
                .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert!(
                resp.headers().get("cdn-cache-control").is_none(),
                "expected no cdn-cache-control for {uri}"
            );
        }

        let priv_resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/with-private")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            priv_resp.headers().get(header::CACHE_CONTROL).unwrap(),
            "private, no-store"
        );
        assert!(priv_resp.headers().get("cdn-cache-control").is_none());

        let post_resp = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/autocomplete")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(post_resp.headers().get(header::VARY).is_none());
        assert!(post_resp.headers().get("cdn-cache-control").is_none());
    }
}
