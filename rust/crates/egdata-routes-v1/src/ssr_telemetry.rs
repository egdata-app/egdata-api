//! Buffered first-party SSR usage reporting for the trusted gateway key.

use std::{sync::Arc, time::Instant};

use axum::{
    body::HttpBody,
    extract::{Request, State},
    middleware::Next,
    response::Response,
};
use egdata_core::v1::operations::v1_operations;
use serde_json::json;

use crate::helpers::{V1CacheTracker, V1RequestContext, scope_v1_cache_tracker};
use crate::state::AppState;

pub async fn record(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let telemetry = &state.ssr_telemetry;
    let ctx = req
        .extensions()
        .get::<V1RequestContext>()
        .expect("v1 context");
    let Some(key) = ctx.key.as_ref().filter(|key| key.key_id == telemetry.key) else {
        return next.run(req).await;
    };
    let started = Instant::now();
    let request_id = ctx.request_id.clone();
    let project = key.project_id.as_ref().unwrap_or(&telemetry.project);
    let path = req.uri().path();
    let method = req.method().clone();
    let operation = v1_operations().iter().find(|op| {
        (op.method.as_str() == method.as_str() || (method == "HEAD" && op.method.as_str() == "GET"))
            && super::path_matches(&op.path, path)
    });
    let mut event = json!({
        "requestId": request_id, "keyId": key.key_id, "projectId": project, "tier": "enterprise",
        "routeTemplate": operation.map_or(path, |op| op.path.as_str()),
        "operationId": operation.map(|op| &op.operation_id), "method": method.as_str(),
        "limitOutcome": "ok", "policyFamily": "ssr",
        "country": url::form_urlencoded::parse(req.uri().query().unwrap_or("").as_bytes())
            .find(|(k,_)| k == "country").map(|(_,v)| v.to_uppercase()).filter(|v| !v.is_empty()).unwrap_or_else(|| "XX".into()),
    });
    if let Some(owner) = &telemetry.owner {
        event["ownerEpicId"] = json!(owner);
    }
    let tracker = Arc::new(V1CacheTracker::default());
    let response = scope_v1_cache_tracker(tracker.clone(), next.run(req)).await;
    let latency = (started.elapsed().as_secs_f64() * 1000.).round() as u64;
    let status = response.status().as_u16();
    let header = |name| {
        response
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .filter(|s| !s.is_empty())
    };
    let cache_status = if status == 304 {
        "REVALIDATED"
    } else if let Some(explicit) = header("x-cache") {
        explicit
    } else {
        tracker.status().unwrap_or("SSR_DIRECT")
    };
    event["statusCode"] = json!(status);
    event["cacheStatus"] = json!(cache_status);
    event["errorCode"] = json!(if status >= 400 {
        format!("HTTP_{status}")
    } else {
        String::new()
    });
    event["latencyMs"] = json!(latency);
    event["upstreamMs"] = json!(latency);
    let response_bytes = header("content-length")
        .and_then(|v| v.parse::<u64>().ok())
        .or_else(|| response.body().size_hint().exact())
        .unwrap_or(0);
    event["responseBytes"] = json!(response_bytes);
    event["timestamp"] = json!((state.now)().timestamp_millis());
    telemetry.enqueue(event);
    telemetry.start_timer(&state.http, state.config.v1_worker_token.as_deref());
    response
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use std::{
        collections::BTreeMap,
        sync::Arc,
    };
    use tower::ServiceExt;

    #[tokio::test]
    async fn router_records_only_trusted_ssr_requests_and_accepts_console_keys() {
        let mut state =
            egdata_api_test_support::test_app_state(crate::state::ApiConfig {
                v1_worker_token: Some("worker".into()),
                v1_worker_auth_required: true,
                ..Default::default()
            });
        let telemetry = Arc::new(egdata_http_core::telemetry::SsrTelemetry::from_env(
            &BTreeMap::from([
                ("WEB_SSR_KEY_ID".into(), "key_website".into()),
                ("WEB_OWNER_EPIC_ID".into(), "owner".into()),
                (
                    "DEVS_TELEMETRY_URL".into(),
                    "https://example.test/usage".into(),
                ),
            ]),
        ));
        state.ssr_telemetry = telemetry.clone();
        let app = crate::router(&state).with_state(state);
        for (method, path, key, token, status) in [
            ("GET", "/v1/countries", "console_prj_a", "worker", 200),
            ("GET", "/v1/countries", "console_abc", "worker", 401),
            ("GET", "/v1/countries", "key_website", "other", 403),
            ("HEAD", "/v1/countries", "key_website", "worker", 200),
            (
                "GET",
                "/v1/unknown?country=gb",
                "key_website",
                "worker",
                404,
            ),
        ] {
            let mut req = axum::http::Request::builder()
                .method(method)
                .uri(path)
                .header("x-egdata-request-id", "req_telemetry")
                .header("x-egdata-key-id", key)
                .header("x-egdata-key-tier", "enterprise")
                .header("x-egdata-worker-token", token);
            if method == "HEAD" {
                req = req.header("x-egdata-key-project", "prj_one");
            }
            assert_eq!(
                app.clone()
                    .oneshot(req.body(Body::empty()).unwrap())
                    .await
                    .unwrap()
                    .status()
                    .as_u16(),
                status
            );
        }
        let entries = telemetry.events.lock().unwrap();
        assert_eq!(entries.len(), 2);
        let first = &entries[0];
        assert_eq!(first["method"], "HEAD");
        assert_eq!(first["projectId"], "prj_one");
        assert_eq!(first["operationId"], "listCountries");
        assert_eq!(first["requestId"], "req_telemetry");
        assert_eq!(first["ownerEpicId"], "owner");
        assert_eq!(first["country"], "XX");
        assert_eq!(first["cacheStatus"], "SSR_DIRECT");
        assert_eq!(first["limitOutcome"], "ok");
        assert_eq!(first["responseBytes"], 0);
        assert_eq!(first["upstreamMs"], first["latencyMs"]);
        let other = &entries[1];
        assert_eq!(other["statusCode"], 404);
        assert_eq!(other["errorCode"], "HTTP_404");
        assert_eq!(other["limitOutcome"], "ok");
        assert!(other["responseBytes"].as_u64().unwrap() > 0);
        assert_eq!(other["operationId"], serde_json::Value::Null);
        assert_eq!(other["country"], "GB");
        assert_eq!(other["routeTemplate"], "/v1/unknown");
        assert_eq!(other["projectId"], "prj_egdata_web");
    }

    #[tokio::test]
    async fn router_reports_redis_cache_hits_misses_revalidation_and_payload_sizes() {
        use axum::{Router, http::header, routing::get};

        let mut state = egdata_api_test_support::test_app_state(crate::state::ApiConfig {
            v1_worker_token: Some("worker".into()),
            v1_worker_auth_required: true,
            ..Default::default()
        });
        let telemetry = Arc::new(egdata_http_core::telemetry::SsrTelemetry::from_env(
            &BTreeMap::from([("WEB_SSR_KEY_ID".into(), "key_website".into())]),
        ));
        state.ssr_telemetry = telemetry.clone();
        let app = crate::router(&state).with_state(state.clone());

        let send = |router: axum::Router, uri: &str, inm: Option<String>| {
            let mut builder = axum::http::Request::builder()
                .uri(uri)
                .header("x-egdata-key-id", "key_website")
                .header("x-egdata-key-tier", "enterprise")
                .header("x-egdata-worker-token", "worker");
            if let Some(tag) = inm {
                builder = builder.header(header::IF_NONE_MATCH, tag);
            }
            router.oneshot(builder.body(Body::empty()).unwrap())
        };

        let countries = send(app.clone(), "/v1/countries", None).await.unwrap();
        assert_eq!(countries.status(), 200);
        let etag = countries.headers()[header::ETAG]
            .to_str()
            .unwrap()
            .to_owned();
        let countries_304 = send(app, "/v1/countries", Some(etag)).await.unwrap();
        assert_eq!(countries_304.status(), 304);

        let custom = Router::new()
            .route(
                "/v1/hit",
                get(|| async {
                    crate::helpers::record_v1_cache_lookup(true);
                    "ok"
                }),
            )
            .route(
                "/v1/miss",
                get(|| async {
                    crate::helpers::record_v1_cache_lookup(false);
                    "miss"
                }),
            )
            .route(
                "/v1/mixed",
                get(|| async {
                    crate::helpers::record_v1_cache_lookup(true);
                    crate::helpers::record_v1_cache_lookup(false);
                    "mix"
                }),
            )
            .route(
                "/v1/custom",
                get(|| async { ([("x-cache", "CUSTOM"), ("content-length", "4")], "body") }),
            )
            .route(
                "/v1/stream",
                get(|| async {
                    axum::response::Response::new(Body::from_stream(futures::stream::iter(vec![
                        Ok::<_, std::convert::Infallible>(axum::body::Bytes::from_static(b"chunk")),
                    ])))
                }),
            )
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                super::record,
            ))
            .layer(axum::middleware::from_fn_with_state(
                state,
                egdata_http_core::middleware::v1_context::v1_context,
            ));

        for uri in [
            "/v1/hit",
            "/v1/miss",
            "/v1/mixed",
            "/v1/custom",
            "/v1/stream",
        ] {
            let resp = send(custom.clone(), uri, None).await.unwrap();
            assert_eq!(resp.status(), 200, "{uri}");
        }

        let entries: Vec<_> = telemetry.events.lock().unwrap().iter().cloned().collect();
        assert_eq!(entries.len(), 7);
        assert_eq!(entries[0]["cacheStatus"], "SSR_DIRECT");
        assert!(entries[0]["responseBytes"].as_u64().unwrap() > 0);
        assert_eq!(entries[1]["statusCode"], 304);
        assert_eq!(entries[1]["cacheStatus"], "REVALIDATED");
        assert_eq!(entries[1]["responseBytes"], 0);
        assert_eq!(entries[2]["cacheStatus"], "HIT");
        assert_eq!(entries[2]["responseBytes"], 2);
        assert_eq!(entries[3]["cacheStatus"], "MISS");
        assert_eq!(entries[3]["responseBytes"], 4);
        assert_eq!(entries[4]["cacheStatus"], "MISS");
        assert_eq!(entries[4]["responseBytes"], 3);
        assert_eq!(entries[5]["cacheStatus"], "CUSTOM");
        assert_eq!(entries[5]["responseBytes"], 4);
        assert_eq!(entries[6]["cacheStatus"], "SSR_DIRECT");
        assert_eq!(entries[6]["responseBytes"], 0);
        for entry in &entries {
            assert_eq!(entry["limitOutcome"], "ok");
        }
    }
}
