//! Distributed fixed-window rate limiting middleware (`src/middlewares/rate-limit.ts`).

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicI64, Ordering},
    },
};

use axum::{
    Json,
    body::Body,
    extract::{Request, State},
    http::{HeaderName, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use chrono::Utc;
use egdata_core::ports::{RateLimitHit, RateLimitStorePort};
use serde_json::json;

use crate::{
    middleware::origin_auth::TrustedGatewayAuthenticated,
    state::{ApiConfig, AppState},
};

const WINDOW_MS: u64 = 60_000;
const WINDOW_SECONDS: u64 = 60;
const REDIS_COOLDOWN_MS: i64 = 30_000;

/// Rate limit tiers matching `src/middlewares/rate-limit.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateLimitTier {
    General,
    GraphqlGet,
    GraphqlPost,
    Heavy,
    Search,
    Bulk,
    OffersList,
}

impl RateLimitTier {
    /// Redis namespace for this tier.
    pub const fn namespace(self) -> &'static str {
        match self {
            Self::General => "general",
            Self::GraphqlGet => "graphql-get",
            Self::GraphqlPost => "graphql-post",
            Self::Heavy => "heavy",
            Self::Search => "search",
            Self::Bulk => "bulk",
            Self::OffersList => "offers-list",
        }
    }

    /// Configured per-minute request limit from [`ApiConfig`].
    pub fn limit(self, config: &ApiConfig) -> u64 {
        match self {
            Self::General => config.rate_limits.general_per_minute,
            Self::GraphqlGet => config.rate_limits.graphql_get_per_minute,
            Self::GraphqlPost => config.rate_limits.graphql_post_per_minute,
            Self::Heavy => config.rate_limits.heavy_per_minute,
            Self::Search => config.rate_limits.search_per_minute,
            Self::Bulk => config.rate_limits.bulk_per_minute,
            Self::OffersList => config.rate_limits.offers_list_per_minute,
        }
    }

    /// Human-readable 429 error message matching TypeScript.
    pub fn message(self, limit: u64) -> String {
        match self {
            Self::General => "Too many requests. Please retry shortly.".to_string(),
            Self::GraphqlGet => {
                "GraphQL is temporarily rate limited. Please retry shortly.".to_string()
            }
            Self::GraphqlPost => {
                "GraphQL POST is temporarily rate limited. Please use GET with persisted queries."
                    .to_string()
            }
            Self::Heavy => {
                "This endpoint is temporarily rate limited. Please retry shortly.".to_string()
            }
            Self::Search => "Search is temporarily rate limited. Please retry shortly.".to_string(),
            Self::Bulk => "Bulk requests are rate limited. Please retry shortly.".to_string(),
            Self::OffersList => format!(
                "The offers list is limited to {limit} requests per minute. Use /search/v2/search for catalogue queries."
            ),
        }
    }
}

/// In-process fixed-window fallback used when Redis is unavailable.
#[derive(Debug, Default)]
pub struct LocalRateLimitFallback {
    unavailable_until_ms: AtomicI64,
    buckets: Mutex<HashMap<String, (u64, i64)>>,
}

impl LocalRateLimitFallback {
    /// Creates an empty fallback store.
    pub fn new() -> Self {
        Self::default()
    }

    fn is_redis_available(&self, now_ms: i64) -> bool {
        now_ms >= self.unavailable_until_ms.load(Ordering::Relaxed)
    }

    fn mark_redis_unavailable(&self, now_ms: i64) {
        self.unavailable_until_ms
            .store(now_ms + REDIS_COOLDOWN_MS, Ordering::Relaxed);
    }

    fn increment_local(&self, namespace: &str, key: &str, now_ms: i64) -> RateLimitHit {
        let full_key = format!("{namespace}:{key}");
        let mut guard = self
            .buckets
            .lock()
            .expect("rate limit fallback mutex poisoned");
        let window_i64 = WINDOW_MS as i64;
        let entry = guard.entry(full_key).or_insert((0, now_ms + window_i64));
        if entry.1 <= now_ms {
            entry.0 = 0;
            entry.1 = now_ms + window_i64;
        }
        entry.0 += 1;
        RateLimitHit {
            total_hits: entry.0,
            ttl_ms: (entry.1 - now_ms).max(1),
        }
    }
}

fn shared_fallback() -> &'static Arc<LocalRateLimitFallback> {
    static FALLBACK: OnceLock<Arc<LocalRateLimitFallback>> = OnceLock::new();
    FALLBACK.get_or_init(|| Arc::new(LocalRateLimitFallback::new()))
}

/// Extracts client IP key matching `clientKey` in `src/middlewares/rate-limit.ts`.
pub fn client_key(req: &Request<Body>) -> String {
    let header_non_empty = |name: &str| -> Option<String> {
        req.headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };

    if let Some(cf) = header_non_empty("cf-connecting-ip") {
        return cf;
    }
    if let Some(xff) = req
        .headers()
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|raw| raw.split(',').next())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return xff.to_string();
    }
    if let Some(real_ip) = header_non_empty("x-real-ip") {
        return real_ip;
    }
    "unknown".to_string()
}

/// Returns `true` when the request bypasses anonymous rate limiting (`skipCheapRequests`).
pub fn should_skip_rate_limit(req: &Request<Body>) -> bool {
    if req
        .extensions()
        .get::<TrustedGatewayAuthenticated>()
        .is_some_and(|t| t.0)
    {
        return true;
    }
    let method = req.method();
    if method == Method::OPTIONS || method == Method::HEAD {
        return true;
    }
    let path = req.uri().path();
    matches!(path, "/health" | "/ping" | "/robots.txt") || path.ends_with("sitemap.xml")
}

/// Evaluates and enforces rate limiting using `store` and `fallback` at timestamp `now_ms`.
pub async fn evaluate_rate_limit(
    config: &ApiConfig,
    store: &dyn RateLimitStorePort,
    fallback: &LocalRateLimitFallback,
    tier: RateLimitTier,
    now_ms: i64,
    req: Request<Body>,
    next: Next,
) -> Response {
    if !config.rate_limit_enabled || should_skip_rate_limit(&req) {
        return next.run(req).await;
    }

    let key = client_key(&req);
    let namespace = tier.namespace();
    let limit = tier.limit(config);

    let hit = if fallback.is_redis_available(now_ms) {
        match store.increment(namespace, &key, WINDOW_MS).await {
            Ok(hit) => hit,
            Err(_) => {
                fallback.mark_redis_unavailable(now_ms);
                fallback.increment_local(namespace, &key, now_ms)
            }
        }
    } else {
        fallback.increment_local(namespace, &key, now_ms)
    };

    let remaining = limit.saturating_sub(hit.total_hits);
    let reset_seconds = if hit.ttl_ms > 0 {
        (hit.ttl_ms as u64).div_ceil(1000)
    } else {
        WINDOW_SECONDS
    };
    let policy_val = format!("{limit};w={WINDOW_SECONDS}");
    let ratelimit_val = format!("limit={limit}, remaining={remaining}, reset={reset_seconds}");

    let mut resp = if hit.total_hits > limit {
        let retry_after = reset_seconds.max(1);
        let mut r = (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({
                "error": {
                    "code": "RATE_LIMITED",
                    "message": tier.message(limit),
                    "retryAfter": retry_after,
                }
            })),
        )
            .into_response();
        if let Ok(val) = HeaderValue::from_str(&retry_after.to_string()) {
            r.headers_mut()
                .insert(HeaderName::from_static("retry-after"), val);
        }
        r
    } else {
        next.run(req).await
    };

    if let Ok(val) = HeaderValue::from_str(&policy_val) {
        resp.headers_mut()
            .insert(HeaderName::from_static("ratelimit-policy"), val);
    }
    if let Ok(val) = HeaderValue::from_str(&ratelimit_val) {
        resp.headers_mut()
            .insert(HeaderName::from_static("ratelimit"), val);
    }
    resp
}

/// Middleware handler for a specific [`RateLimitTier`].
pub async fn rate_limit_tier(
    State(state): State<AppState>,
    tier: RateLimitTier,
    req: Request<Body>,
    next: Next,
) -> Response {
    evaluate_rate_limit(
        &state.config,
        state.rate_limit.as_ref(),
        shared_fallback(),
        tier,
        Utc::now().timestamp_millis(),
        req,
        next,
    )
    .await
}

/// General anonymous rate limiter.
pub async fn general_rate_limit(
    state: State<AppState>,
    req: Request<Body>,
    next: Next,
) -> Response {
    rate_limit_tier(state, RateLimitTier::General, req, next).await
}

/// GraphQL GET rate limiter.
pub async fn graphql_get_rate_limit(
    state: State<AppState>,
    req: Request<Body>,
    next: Next,
) -> Response {
    rate_limit_tier(state, RateLimitTier::GraphqlGet, req, next).await
}

/// GraphQL POST rate limiter.
pub async fn graphql_post_rate_limit(
    state: State<AppState>,
    req: Request<Body>,
    next: Next,
) -> Response {
    rate_limit_tier(state, RateLimitTier::GraphqlPost, req, next).await
}

/// GraphQL rate limiter dispatching GET vs POST tiers (`graphqlRateLimit`).
pub async fn graphql_rate_limit(
    state: State<AppState>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let tier = if req.method() == Method::GET {
        RateLimitTier::GraphqlGet
    } else {
        RateLimitTier::GraphqlPost
    };
    rate_limit_tier(state, tier, req, next).await
}

/// Heavy detail/image route rate limiter.
pub async fn heavy_rate_limit(state: State<AppState>, req: Request<Body>, next: Next) -> Response {
    rate_limit_tier(state, RateLimitTier::Heavy, req, next).await
}

/// Search route rate limiter.
pub async fn search_rate_limit(state: State<AppState>, req: Request<Body>, next: Next) -> Response {
    rate_limit_tier(state, RateLimitTier::Search, req, next).await
}

/// Bulk catalog/launcher resolution rate limiter.
pub async fn bulk_rate_limit(state: State<AppState>, req: Request<Body>, next: Next) -> Response {
    rate_limit_tier(state, RateLimitTier::Bulk, req, next).await
}

/// Public offers list rate limiter.
pub async fn offers_list_rate_limit(
    state: State<AppState>,
    req: Request<Body>,
    next: Next,
) -> Response {
    rate_limit_tier(state, RateLimitTier::OffersList, req, next).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use egdata_api_test_support::{MockRateLimitStore, test_app_state_with_rate_limit};
    use crate::state::RateLimitConfig;
    use axum::{Router, middleware, routing::get};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    #[test]
    fn tier_metadata_and_client_key_extraction() {
        let cfg = ApiConfig::default();
        assert_eq!(RateLimitTier::General.namespace(), "general");
        assert_eq!(RateLimitTier::GraphqlGet.namespace(), "graphql-get");
        assert_eq!(RateLimitTier::GraphqlPost.namespace(), "graphql-post");
        assert_eq!(RateLimitTier::Heavy.namespace(), "heavy");
        assert_eq!(RateLimitTier::Search.namespace(), "search");
        assert_eq!(RateLimitTier::Bulk.namespace(), "bulk");
        assert_eq!(RateLimitTier::OffersList.namespace(), "offers-list");

        assert_eq!(RateLimitTier::General.limit(&cfg), 1200);
        assert_eq!(RateLimitTier::GraphqlGet.limit(&cfg), 1200);
        assert_eq!(RateLimitTier::GraphqlPost.limit(&cfg), 30);
        assert_eq!(RateLimitTier::Heavy.limit(&cfg), 60);
        assert_eq!(RateLimitTier::Search.limit(&cfg), 300);
        assert_eq!(RateLimitTier::Bulk.limit(&cfg), 10);
        assert_eq!(RateLimitTier::OffersList.limit(&cfg), 5);

        assert!(
            RateLimitTier::OffersList
                .message(5)
                .contains("5 requests per minute")
        );
        assert!(!RateLimitTier::General.message(1200).is_empty());
        assert!(!RateLimitTier::GraphqlGet.message(1200).is_empty());
        assert!(!RateLimitTier::GraphqlPost.message(30).is_empty());
        assert!(!RateLimitTier::Heavy.message(60).is_empty());
        assert!(!RateLimitTier::Search.message(300).is_empty());
        assert!(!RateLimitTier::Bulk.message(10).is_empty());

        let r_cf = Request::builder()
            .header("cf-connecting-ip", "1.1.1.1")
            .header("x-forwarded-for", "2.2.2.2")
            .body(Body::empty())
            .unwrap();
        assert_eq!(client_key(&r_cf), "1.1.1.1");

        let r_xff = Request::builder()
            .header("x-forwarded-for", " 2.2.2.2 , 3.3.3.3 ")
            .header("x-real-ip", "4.4.4.4")
            .body(Body::empty())
            .unwrap();
        assert_eq!(client_key(&r_xff), "2.2.2.2");

        let r_real = Request::builder()
            .header("x-real-ip", "4.4.4.4")
            .body(Body::empty())
            .unwrap();
        assert_eq!(client_key(&r_real), "4.4.4.4");

        let r_none = Request::builder().body(Body::empty()).unwrap();
        assert_eq!(client_key(&r_none), "unknown");
    }

    #[tokio::test]
    async fn enforces_limits_sets_headers_and_skips_exempt_requests() {
        let store = Arc::new(MockRateLimitStore::new(false));
        let cfg = ApiConfig {
            rate_limit_enabled: true,
            rate_limits: RateLimitConfig {
                offers_list_per_minute: 2,
                graphql_get_per_minute: 2,
                graphql_post_per_minute: 1,
                general_per_minute: 10,
                heavy_per_minute: 10,
                search_per_minute: 10,
                bulk_per_minute: 10,
            },
            ..Default::default()
        };
        let state = test_app_state_with_rate_limit(cfg, store);

        let app = Router::new()
            .route("/offers", get(|| async { "ok" }))
            .route("/health", get(|| async { "ok" }))
            .route("/offers-sitemap.xml", get(|| async { "ok" }))
            .route(
                "/offers",
                axum::routing::options(|| async { "ok" }).head(|| async { "ok" }),
            )
            .layer(middleware::from_fn_with_state(
                state.clone(),
                offers_list_rate_limit,
            ));

        // 1st request -> 200, remaining=1
        let r1 = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/offers")
                    .header("cf-connecting-ip", "10.0.0.1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r1.status(), StatusCode::OK);
        assert_eq!(r1.headers().get("ratelimit-policy").unwrap(), "2;w=60");
        assert!(
            r1.headers()
                .get("ratelimit")
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("limit=2, remaining=1, reset=")
        );

        // 2nd request -> 200, remaining=0
        let r2 = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/offers")
                    .header("cf-connecting-ip", "10.0.0.1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r2.status(), StatusCode::OK);

        // 3rd request -> 429 RATE_LIMITED
        let r3 = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/offers")
                    .header("cf-connecting-ip", "10.0.0.1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r3.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(r3.headers().get("retry-after").is_some());
        let body: serde_json::Value =
            serde_json::from_slice(&r3.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(body["error"]["code"], "RATE_LIMITED");
        assert!(body["error"]["retryAfter"].as_u64().unwrap() >= 1);

        // Exempt requests (health, sitemap, OPTIONS, HEAD, TrustedGatewayAuthenticated(true))
        for (method, uri) in [
            (Method::GET, "/health"),
            (Method::GET, "/offers-sitemap.xml"),
            (Method::OPTIONS, "/offers"),
            (Method::HEAD, "/offers"),
        ] {
            let skipped = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(uri)
                        .header("cf-connecting-ip", "10.0.0.1")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(skipped.status(), StatusCode::OK);
            assert!(skipped.headers().get("ratelimit").is_none());
        }

        let mut trusted_req = Request::builder()
            .uri("/offers")
            .header("cf-connecting-ip", "10.0.0.1")
            .body(Body::empty())
            .unwrap();
        trusted_req
            .extensions_mut()
            .insert(TrustedGatewayAuthenticated(true));
        let trusted_resp = app.oneshot(trusted_req).await.unwrap();
        assert_eq!(trusted_resp.status(), StatusCode::OK);
        assert!(trusted_resp.headers().get("ratelimit").is_none());
    }

    #[tokio::test]
    async fn redis_error_trips_circuit_breaker_and_uses_local_fallback() {
        let store = MockRateLimitStore::new(true);
        let cfg = ApiConfig {
            rate_limit_enabled: true,
            rate_limits: RateLimitConfig {
                bulk_per_minute: 1,
                ..Default::default()
            },
            ..Default::default()
        };

        // Direct evaluation with controlled clock for window reset and cooldown
        let fb = Arc::new(LocalRateLimitFallback::new());
        let app_direct =
            Router::new()
                .route("/bulk", get(|| async { "ok" }))
                .layer(middleware::from_fn(
                    move |req: Request<Body>, next: Next| {
                        let store = store.clone();
                        let cfg = cfg.clone();
                        let fb = fb.clone();
                        async move {
                            let now = req
                                .headers()
                                .get("x-test-now")
                                .and_then(|v| v.to_str().ok())
                                .and_then(|s| s.parse::<i64>().ok())
                                .unwrap_or(100_000);
                            evaluate_rate_limit(
                                &cfg,
                                &store,
                                &fb,
                                RateLimitTier::Bulk,
                                now,
                                req,
                                next,
                            )
                            .await
                        }
                    },
                ));

        // Hit 1 at t=100_000 -> Redis errors, fallback increments to 1 (OK)
        let r1 = app_direct
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/bulk")
                    .header("x-test-now", "100000")
                    .header("cf-connecting-ip", "9.9.9.9")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r1.status(), StatusCode::OK);

        // Hit 2 at t=105_000 (within 30s cooldown, skips Redis) -> 429 from fallback
        let r2 = app_direct
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/bulk")
                    .header("x-test-now", "105000")
                    .header("cf-connecting-ip", "9.9.9.9")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r2.status(), StatusCode::TOO_MANY_REQUESTS);

        // Hit 3 at t=170_000 (past 60s window & 30s cooldown) -> fallback window resets -> 200
        let r3 = app_direct
            .oneshot(
                Request::builder()
                    .uri("/bulk")
                    .header("x-test-now", "170000")
                    .header("cf-connecting-ip", "9.9.9.9")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r3.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn named_tier_wrappers_and_disabled_mode_work() {
        let store = Arc::new(MockRateLimitStore::new(false));
        let disabled_state = test_app_state_with_rate_limit(
            ApiConfig {
                rate_limit_enabled: false,
                ..Default::default()
            },
            store.clone(),
        );
        let disabled_app = Router::new().route("/x", get(|| async { "ok" })).layer(
            middleware::from_fn_with_state(disabled_state, general_rate_limit),
        );
        let r_dis = disabled_app
            .oneshot(Request::builder().uri("/x").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(r_dis.status(), StatusCode::OK);
        assert!(r_dis.headers().get("ratelimit").is_none());

        let enabled_state = test_app_state_with_rate_limit(
            ApiConfig {
                rate_limit_enabled: true,
                ..Default::default()
            },
            store,
        );
        let gql_app = Router::new()
            .route("/graphql", get(|| async { "ok" }).post(|| async { "ok" }))
            .layer(middleware::from_fn_with_state(
                enabled_state.clone(),
                graphql_rate_limit,
            ));
        let gql_get = gql_app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/graphql")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            gql_get.headers().get("ratelimit-policy").unwrap(),
            "1200;w=60"
        );
        let gql_post = gql_app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/graphql")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            gql_post.headers().get("ratelimit-policy").unwrap(),
            "30;w=60"
        );

        let base = Router::new().route("/t", get(|| async { "ok" }));
        for (app, expected_policy) in [
            (
                base.clone().layer(middleware::from_fn_with_state(
                    enabled_state.clone(),
                    graphql_get_rate_limit,
                )),
                "1200;w=60",
            ),
            (
                base.clone().layer(middleware::from_fn_with_state(
                    enabled_state.clone(),
                    graphql_post_rate_limit,
                )),
                "30;w=60",
            ),
            (
                base.clone().layer(middleware::from_fn_with_state(
                    enabled_state.clone(),
                    heavy_rate_limit,
                )),
                "60;w=60",
            ),
            (
                base.clone().layer(middleware::from_fn_with_state(
                    enabled_state.clone(),
                    search_rate_limit,
                )),
                "300;w=60",
            ),
            (
                base.clone().layer(middleware::from_fn_with_state(
                    enabled_state.clone(),
                    bulk_rate_limit,
                )),
                "10;w=60",
            ),
        ] {
            let resp = app
                .oneshot(Request::builder().uri("/t").body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(
                resp.headers().get("ratelimit-policy").unwrap(),
                expected_policy
            );
        }
    }
}
