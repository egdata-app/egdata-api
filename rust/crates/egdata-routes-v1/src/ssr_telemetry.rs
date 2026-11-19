//! Buffered first-party SSR usage reporting for the trusted gateway key.

use std::time::Instant;

use axum::{
    extract::{Request, State},
    middleware::Next,
    response::Response,
};
use egdata_core::v1::operations::v1_operations;
use serde_json::json;

use crate::helpers::V1RequestContext;
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
        "limitOutcome": "allowed", "policyFamily": "ssr",
        "country": url::form_urlencoded::parse(req.uri().query().unwrap_or("").as_bytes())
            .find(|(k,_)| k == "country").map(|(_,v)| v.to_uppercase()).filter(|v| !v.is_empty()).unwrap_or_else(|| "XX".into()),
    });
    if let Some(owner) = &telemetry.owner {
        event["ownerEpicId"] = json!(owner);
    }
    let response = next.run(req).await;
    let latency = (started.elapsed().as_secs_f64() * 1000.).round() as u64;
    let status = response.status().as_u16();
    let header = |name| {
        response
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .filter(|s| !s.is_empty())
    };
    event["statusCode"] = json!(status);
    event["cacheStatus"] = json!(header("x-cache").unwrap_or("SSR_DIRECT"));
    event["errorCode"] = json!(if status >= 400 {
        format!("HTTP_{status}")
    } else {
        String::new()
    });
    event["latencyMs"] = json!(latency);
    event["upstreamMs"] = json!(latency);
    event["responseBytes"] = json!(header("content-length").unwrap_or("0").parse::<u64>().ok());
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
        assert_eq!(first["upstreamMs"], first["latencyMs"]);
        let other = &entries[1];
        assert_eq!(other["statusCode"], 404);
        assert_eq!(other["errorCode"], "HTTP_404");
        assert_eq!(other["operationId"], serde_json::Value::Null);
        assert_eq!(other["country"], "GB");
        assert_eq!(other["routeTemplate"], "/v1/unknown");
        assert_eq!(other["projectId"], "prj_egdata_web");
    }
}
