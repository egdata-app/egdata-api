//! Buffered first-party SSR usage reporting for the trusted gateway key.

use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

use egdata_core::ports::{UpstreamHttpPort, UpstreamHttpRequest};
use serde_json::{Value, json};

const CAPACITY: usize = 2000;
const PERIOD: Duration = Duration::from_secs(10);

pub struct SsrTelemetry {
    pub key: String,
    pub project: String,
    pub owner: Option<String>,
    pub endpoint: String,
    pub events: Mutex<VecDeque<Value>>,
    timer: OnceLock<()>,
}

impl SsrTelemetry {
    pub fn from_env(env: &BTreeMap<String, String>) -> Self {
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

    pub fn enqueue(&self, event: Value) {
        let mut events = self.events.lock().unwrap();
        if events.len() == CAPACITY {
            events.pop_front();
        }
        events.push_back(event);
    }

    pub fn start_timer(
        self: &Arc<Self>,
        http: &Arc<dyn UpstreamHttpPort>,
        token: Option<&str>,
    ) {
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
    pub async fn flush(&self, http: &dyn UpstreamHttpPort, token: &str) {
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use egdata_core::{error::CoreError, ports::UpstreamHttpResponse};

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
}
