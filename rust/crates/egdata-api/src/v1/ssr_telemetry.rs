//! Buffered first-party SSR usage reporting for the trusted gateway key.

use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

use axum::{
    body::HttpBody,
    extract::{Request, State},
    middleware::Next,
    response::Response,
};
use egdata_core::{
    ports::{UpstreamHttpPort, UpstreamHttpRequest},
    v1::operations::v1_operations,
};
use serde_json::{Value, json};

use super::helpers::{V1CacheTracker, V1RequestContext, scope_v1_cache_tracker};
use crate::state::AppState;

const CAPACITY: usize = 2000;
const PERIOD: Duration = Duration::from_secs(10);

pub(crate) struct SsrTelemetry {
    key: String,
    project: String,
    owner: Option<String>,
    endpoint: String,
    events: Mutex<VecDeque<Value>>,
    timer: OnceLock<()>,
}

impl SsrTelemetry {
    pub(crate) fn from_env(env: &BTreeMap<String, String>) -> Self {
        let get = |key: &str| env.get(key).filter(|s| !s.is_empty()).map(String::as_str);
        Self {
            key: get("WEB_SSR_KEY_ID").unwrap_or("key_egdata_web_ssr").into(),
            project: get("WEB_PROJECT_ID").unwrap_or("prj_egdata_web").into(),
            owner: env.get("WEB_OWNER_EPIC_ID").cloned(),
            endpoint: get("DEVS_TELEMETRY_URL")
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    format!(
                        "{}/_internal/telemetry",
                        get("DASHBOARD_ORIGIN").unwrap_or("https://devs.egdata.app")
                    )
                }),
            events: Mutex::default(),
            timer: OnceLock::new(),
        }
    }

    fn enqueue(&self, event: Value) {
        let mut events = self.events.lock().unwrap();
        if events.len() == CAPACITY {
            events.pop_front();
        }
        events.push_back(event);
    }

    fn start_timer(self: &Arc<Self>, http: &Arc<dyn UpstreamHttpPort>, token: Option<&str>) {
        self.timer.get_or_init(|| {
            let weak = Arc::downgrade(self);
            let http = http.clone();
            let token = token.unwrap_or_default().to_owned();
            tokio::spawn(async move {
                let mut timer =
                    tokio::time::interval_at(tokio::time::Instant::now() + PERIOD, PERIOD);
                timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    timer.tick().await;
                    let Some(queue) = weak.upgrade() else { break };
                    queue.flush(http.as_ref(), &token).await;
                }
            });
        });
    }

    // The timer is the sole consumer. New requests can queue events while this batch is in flight.
    async fn flush(&self, http: &dyn UpstreamHttpPort, token: &str) {
        let mut batch = std::mem::take(&mut *self.events.lock().unwrap());
        if batch.is_empty() {
            return;
        }
        let request = UpstreamHttpRequest {
            method: "POST".into(),
            url: self.endpoint.clone(),
            headers: BTreeMap::from([
                ("Content-Type".into(), "application/json".into()),
                ("Authorization".into(), format!("Bearer {token}")),
                ("x-egdata-worker-token".into(), token.into()),
            ]),
            body: Some(serde_json::to_vec(&json!({"events": batch})).unwrap()),
            multipart_file: None,
        };
        match http.send(request).await {
            Ok(response) if (200..300).contains(&response.status) => return,
            Ok(response) => tracing::warn!(status = response.status, "SSR telemetry flush failed"),
            Err(_) => tracing::warn!("SSR telemetry transport failed"),
        }
        let mut events = self.events.lock().unwrap();
        batch.append(&mut events);
        batch.drain(..batch.len().saturating_sub(CAPACITY));
        *events = batch;
    }

    #[cfg(test)]
    pub(crate) fn recorded_events(&self) -> Vec<Value> {
        self.events.lock().unwrap().iter().cloned().collect()
    }
}

pub(super) async fn record(State(state): State<AppState>, req: Request, next: Next) -> Response {
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
    use super::*;
    use async_trait::async_trait;
    use axum::body::Body;
    use egdata_core::{error::CoreError, ports::UpstreamHttpResponse};
    use tower::ServiceExt;

    struct Receiver {
        queue: Arc<SsrTelemetry>,
        requests: Mutex<Vec<UpstreamHttpRequest>>,
    }

    #[async_trait]
    impl UpstreamHttpPort for Receiver {
        async fn send(
            &self,
            request: UpstreamHttpRequest,
        ) -> Result<UpstreamHttpResponse, CoreError> {
            let mut calls = self.requests.lock().unwrap();
            calls.push(request);
            match calls.len() {
                1 => {
                    self.queue.enqueue(json!("in-flight"));
                    Err(CoreError::InvalidInput("fixture transport error".into()))
                }
                2 => Ok(UpstreamHttpResponse {
                    status: 503,
                    body: vec![],
                }),
                _ => Ok(UpstreamHttpResponse {
                    status: 204,
                    body: vec![],
                }),
            }
        }
    }

    #[tokio::test]
    async fn failed_batches_keep_the_newest_events_and_retry_with_gateway_credentials() {
        let queue = Arc::new(SsrTelemetry::from_env(&BTreeMap::from([(
            "DASHBOARD_ORIGIN".into(),
            "https://example.test".into(),
        )])));
        let receiver = Receiver {
            queue: queue.clone(),
            requests: Mutex::default(),
        };
        queue.flush(&receiver, "token").await;
        for n in 0..=CAPACITY {
            queue.enqueue(json!(n));
        }
        for _ in 0..3 {
            queue.flush(&receiver, "token").await;
        }
        assert!(queue.events.lock().unwrap().is_empty());
        let requests = receiver.requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        let req = &requests[1];
        assert_eq!(req.method, "POST");
        assert_eq!(req.url, "https://example.test/_internal/telemetry");
        assert_eq!(req.headers["Authorization"], "Bearer token");
        assert_eq!(req.headers["x-egdata-worker-token"], "token");
        assert_eq!(req.headers["Content-Type"], "application/json");
        let batch: Value = serde_json::from_slice(req.body.as_ref().unwrap()).unwrap();
        assert_eq!(batch["events"].as_array().unwrap().len(), CAPACITY);
        assert_eq!(batch["events"][0], 2);
        assert_eq!(batch["events"][CAPACITY - 1], "in-flight");
        assert_eq!(req.body, requests[2].body);
    }

    #[tokio::test]
    async fn router_records_only_trusted_ssr_requests_and_accepts_console_keys() {
        let mut state = crate::middleware::test_support::test_app_state(crate::state::ApiConfig {
            v1_worker_token: Some("worker".into()),
            v1_worker_auth_required: true,
            ..Default::default()
        });
        let telemetry = Arc::new(SsrTelemetry::from_env(&BTreeMap::from([
            ("WEB_SSR_KEY_ID".into(), "key_website".into()),
            ("WEB_OWNER_EPIC_ID".into(), "owner".into()),
            (
                "DEVS_TELEMETRY_URL".into(),
                "https://example.test/usage".into(),
            ),
        ])));
        state.ssr_telemetry = telemetry.clone();
        assert_eq!(telemetry.endpoint, "https://example.test/usage");
        let app = super::super::router(&state).with_state(state);
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
            let mut req = Request::builder()
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
        assert_eq!(other["operationId"], Value::Null);
        assert_eq!(other["country"], "GB");
        assert_eq!(other["routeTemplate"], "/v1/unknown");
        assert_eq!(other["projectId"], "prj_egdata_web");
    }

    #[tokio::test]
    async fn router_reports_redis_cache_hits_misses_revalidation_and_payload_sizes() {
        use axum::{Router, http::header, routing::get};

        let mut state = crate::middleware::test_support::test_app_state(crate::state::ApiConfig {
            v1_worker_token: Some("worker".into()),
            v1_worker_auth_required: true,
            ..Default::default()
        });
        let telemetry = Arc::new(SsrTelemetry::from_env(&BTreeMap::from([(
            "WEB_SSR_KEY_ID".into(),
            "key_website".into(),
        )])));
        state.ssr_telemetry = telemetry.clone();
        let app = super::super::router(&state).with_state(state.clone());

        let send = |router: axum::Router, uri: &str, inm: Option<String>| {
            let mut builder = Request::builder()
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
                    super::super::helpers::record_v1_cache_lookup(true);
                    "ok"
                }),
            )
            .route(
                "/v1/miss",
                get(|| async {
                    super::super::helpers::record_v1_cache_lookup(false);
                    "miss"
                }),
            )
            .route(
                "/v1/mixed",
                get(|| async {
                    super::super::helpers::record_v1_cache_lookup(true);
                    super::super::helpers::record_v1_cache_lookup(false);
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
                    Response::new(Body::from_stream(futures::stream::iter(vec![
                        Ok::<_, std::convert::Infallible>(axum::body::Bytes::from_static(b"chunk")),
                    ])))
                }),
            )
            .layer(axum::middleware::from_fn_with_state(state.clone(), record))
            .layer(axum::middleware::from_fn_with_state(
                state,
                crate::middleware::v1_context::v1_context,
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

        let entries = telemetry.recorded_events();
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
