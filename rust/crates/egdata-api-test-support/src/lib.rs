//! Shared test doubles for API unit tests.

mod capture;

pub use capture::capture_response;

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use bson::{Bson, Document};
use egdata_core::abuse::AbuseEvent;
use egdata_core::error::CoreError;
use egdata_core::ports::{
    AbuseRiskStorePort, AbuseRiskWindow, AbuseSummaryRow, AbuseSummaryStorePort,
    AbuseTrialStorePort, AcceptedJobSubmission, CatalogHydrationResolverPort, DiscordPort,
    EpicStorePort, GaPort, GaTrackEvent, JobApiJobType, JobApiPort, MeiliSearchPort,
    MeiliSearchQuery, MeiliSearchResult, MongoFindOptions, MongoStorePort, OgImageFormat,
    OgRendererPort, OpenSearchPort, PowCohortStorePort, PowCohortUpdate, RateLimitHit,
    RateLimitStorePort, ResponseCachePort, SessionVerifierPort, TelegramPort, VectorizeOfferMatch,
    VectorizePort, VerifiedSession, WebPushPort,
};
use serde_json::{Value, json};

use egdata_api_state::state::{ApiConfig, AppState};

/// No-op implementation of every port.
pub struct StubPorts;

#[async_trait]
impl egdata_core::ports::ProfileRefreshPort for StubPorts {
    async fn request(&self, _: &str, _: i64) -> Result<(), CoreError> {
        Ok(())
    }
    async fn status(&self, _: &str) -> Result<Option<String>, CoreError> {
        Ok(None)
    }
}

#[async_trait]
impl MongoStorePort for StubPorts {
    async fn find_one(
        &self,
        _c: &str,
        _f: Document,
        _p: Option<Document>,
    ) -> Result<Option<Document>, CoreError> {
        Ok(None)
    }
    async fn find_many(
        &self,
        _c: &str,
        _f: Document,
        _o: MongoFindOptions,
    ) -> Result<Vec<Document>, CoreError> {
        Ok(vec![])
    }
    async fn aggregate(&self, _c: &str, _p: Vec<Document>) -> Result<Vec<Document>, CoreError> {
        Ok(vec![])
    }
    async fn count_documents(&self, _c: &str, _f: Document) -> Result<u64, CoreError> {
        Ok(0)
    }
    async fn distinct(&self, _c: &str, _f: &str, _d: Document) -> Result<Vec<Bson>, CoreError> {
        Ok(vec![])
    }
    async fn insert_one(&self, _c: &str, _d: Document) -> Result<(), CoreError> {
        Ok(())
    }
    async fn update_one(
        &self,
        _c: &str,
        _f: Document,
        _u: Document,
        _up: bool,
    ) -> Result<u64, CoreError> {
        Ok(0)
    }
    async fn delete_one(&self, _c: &str, _f: Document) -> Result<u64, CoreError> {
        Ok(0)
    }
    async fn ping(&self) -> Result<bool, CoreError> {
        Ok(true)
    }
}

#[async_trait]
impl ResponseCachePort for StubPorts {
    async fn get(&self, _k: &str) -> Result<Option<String>, CoreError> {
        Ok(None)
    }
    async fn set(&self, _k: &str, _v: &str, _t: u64) -> Result<(), CoreError> {
        Ok(())
    }
    async fn del(&self, _k: &str) -> Result<(), CoreError> {
        Ok(())
    }
    async fn ping(&self) -> Result<bool, CoreError> {
        Ok(true)
    }
}

#[async_trait]
impl RateLimitStorePort for StubPorts {
    async fn increment(&self, _n: &str, _k: &str, w: u64) -> Result<RateLimitHit, CoreError> {
        Ok(RateLimitHit {
            total_hits: 1,
            ttl_ms: w as i64,
        })
    }
}

#[async_trait]
impl AbuseRiskStorePort for StubPorts {
    async fn append(&self, _k: &str, e: &AbuseEvent) -> Result<AbuseRiskWindow, CoreError> {
        Ok(AbuseRiskWindow {
            events: vec![e.clone()],
            trapped: false,
        })
    }
}

#[async_trait]
impl AbuseSummaryStorePort for StubPorts {
    async fn write(&self, _r: &[AbuseSummaryRow]) -> Result<(), CoreError> {
        Ok(())
    }
}

#[async_trait]
impl PowCohortStorePort for StubPorts {
    async fn write(&self, _r: &[PowCohortUpdate]) -> Result<(), CoreError> {
        Ok(())
    }
    async fn read_day(&self, _d: i64) -> Result<BTreeMap<String, String>, CoreError> {
        Ok(BTreeMap::new())
    }
}

#[async_trait]
impl AbuseTrialStorePort for StubPorts {
    async fn get_trial_raw(&self) -> Result<Option<String>, CoreError> {
        Ok(None)
    }
}

#[async_trait]
impl SessionVerifierPort for StubPorts {
    async fn verify_token(&self, _t: &str) -> Result<Option<VerifiedSession>, CoreError> {
        Ok(None)
    }
}

#[async_trait]
impl MeiliSearchPort for StubPorts {
    async fn search(
        &self,
        _i: &str,
        _q: &MeiliSearchQuery,
    ) -> Result<MeiliSearchResult, CoreError> {
        Ok(MeiliSearchResult::default())
    }
}

#[async_trait]
impl OpenSearchPort for StubPorts {
    async fn search(&self, _i: &str, _b: &Value) -> Result<Value, CoreError> {
        Ok(json!({}))
    }
}

#[async_trait]
impl VectorizePort for StubPorts {
    async fn query_natural_language(
        &self,
        _q: &str,
        _k: usize,
    ) -> Result<Vec<VectorizeOfferMatch>, CoreError> {
        Ok(vec![])
    }
}

#[async_trait]
impl EpicStorePort for StubPorts {
    async fn graphql(&self, _q: &str, _v: &Value) -> Result<Value, CoreError> {
        Ok(json!({}))
    }

    async fn featured_games(&self) -> Result<Vec<Value>, CoreError> {
        Ok(vec![])
    }
}

#[async_trait]
impl JobApiPort for StubPorts {
    async fn submit(
        &self,
        _j: JobApiJobType,
        _p: &Value,
        _r: Option<&str>,
    ) -> Result<AcceptedJobSubmission, CoreError> {
        Ok(AcceptedJobSubmission {
            job_id: "1".into(),
            workflow_id: "1".into(),
            status_url: String::new(),
            deduplicated: false,
        })
    }
    async fn submit_batch(
        &self,
        _j: JobApiJobType,
        _p: &[Value],
        _r: Option<&str>,
    ) -> Result<Vec<AcceptedJobSubmission>, CoreError> {
        Ok(vec![])
    }
}

#[async_trait]
impl DiscordPort for StubPorts {
    async fn request(&self, _m: &str, _p: &str, _b: Option<&Value>) -> Result<Value, CoreError> {
        Ok(json!({}))
    }
}

#[async_trait]
impl TelegramPort for StubPorts {
    async fn send_message(&self, _m: &str) -> Result<(), CoreError> {
        Ok(())
    }
}

#[async_trait]
impl GaPort for StubPorts {
    async fn send_measurement(&self, _: &Value) -> Result<(), CoreError> {
        Ok(())
    }
    async fn track(&self, _e: &GaTrackEvent) -> Result<(), CoreError> {
        Ok(())
    }
}

#[async_trait]
impl WebPushPort for StubPorts {
    async fn send_notification(&self, _s: &Value, _p: &[u8]) -> Result<(), CoreError> {
        Ok(())
    }
}

#[async_trait]
impl OgRendererPort for StubPorts {
    async fn render_image(
        &self,
        _h: &str,
        _w: u32,
        _ht: u32,
        _f: OgImageFormat,
    ) -> Result<Vec<u8>, CoreError> {
        Ok(vec![])
    }
}

#[async_trait]
impl CatalogHydrationResolverPort for StubPorts {
    async fn resolve(&self, _r: &Value) -> Result<Vec<Value>, CoreError> {
        Ok(vec![])
    }
}

#[async_trait]
impl egdata_core::ports::UpstreamHttpPort for StubPorts {
    async fn send(
        &self,
        _request: egdata_core::ports::UpstreamHttpRequest,
    ) -> Result<egdata_core::ports::UpstreamHttpResponse, CoreError> {
        Ok(egdata_core::ports::UpstreamHttpResponse {
            status: 200,
            body: b"{}".to_vec(),
        })
    }
}

/// In-memory fixed-window counter; `fail = true` makes every call error (simulated Redis outage).
#[derive(Clone)]
pub struct MockRateLimitStore {
    fail: bool,
    counts: Arc<Mutex<HashMap<String, u64>>>,
}

impl MockRateLimitStore {
    pub fn new(fail: bool) -> Self {
        Self {
            fail,
            counts: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[async_trait]
impl RateLimitStorePort for MockRateLimitStore {
    async fn increment(
        &self,
        namespace: &str,
        key: &str,
        window_ms: u64,
    ) -> Result<RateLimitHit, CoreError> {
        if self.fail {
            return Err(CoreError::Internal("redis unavailable".into()));
        }
        let mut counts = self.counts.lock().expect("rate limit mock poisoned");
        let entry = counts.entry(format!("{namespace}:{key}")).or_insert(0);
        *entry += 1;
        Ok(RateLimitHit {
            total_hits: *entry,
            ttl_ms: window_ms as i64,
        })
    }
}

pub fn test_app_state(config: ApiConfig) -> AppState {
    test_app_state_with_rate_limit(config, Arc::new(StubPorts))
}

pub fn test_app_state_with_rate_limit(
    config: ApiConfig,
    rate_limit: Arc<dyn RateLimitStorePort>,
) -> AppState {
    let stub = Arc::new(StubPorts);
    AppState {
        ssr_telemetry: Arc::new(egdata_api_state::telemetry::SsrTelemetry::from_env(
            &Default::default(),
        )),
        now: chrono::Utc::now,
        new_object_id: bson::oid::ObjectId::new,
        config: Arc::new(config),
        mongo: stub.clone(),
        cache: stub.clone(),
        saved_queries: stub.clone(),
        graphql_cache: stub.clone(),
        profile_refresh: Arc::new(StubPorts),
        rate_limit,
        abuse_risk: stub.clone(),
        abuse_summary: stub.clone(),
        pow_cohorts: stub.clone(),
        abuse_trial: stub.clone(),
        session_verifier: stub.clone(),
        meili: stub.clone(),
        opensearch: stub.clone(),
        vectorize: stub.clone(),
        epic: stub.clone(),
        job_api: stub.clone(),
        discord: stub.clone(),
        telegram: stub.clone(),
        ga: stub.clone(),
        web_push: stub.clone(),
        og: stub.clone(),
        catalog_hydration: stub.clone(),
        http: stub,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use egdata_core::ports::{ProfileRefreshPort, UpstreamHttpPort, UpstreamHttpRequest};

    #[tokio::test]
    async fn stub_ports_and_rate_limit_mock_defaults() {
        let stub = StubPorts;
        ProfileRefreshPort::request(&stub, "acct", 1).await.unwrap();
        assert_eq!(ProfileRefreshPort::status(&stub, "acct").await.unwrap(), None);

        assert_eq!(MongoStorePort::find_one(&stub, "c", Document::new(), None).await.unwrap(), None);
        assert!(MongoStorePort::find_many(&stub, "c", Document::new(), MongoFindOptions::default()).await.unwrap().is_empty());
        assert!(MongoStorePort::aggregate(&stub, "c", vec![]).await.unwrap().is_empty());
        assert_eq!(MongoStorePort::count_documents(&stub, "c", Document::new()).await.unwrap(), 0);
        assert!(MongoStorePort::distinct(&stub, "c", "f", Document::new()).await.unwrap().is_empty());
        MongoStorePort::insert_one(&stub, "c", Document::new()).await.unwrap();
        assert_eq!(MongoStorePort::update_one(&stub, "c", Document::new(), Document::new(), false).await.unwrap(), 0);
        assert_eq!(MongoStorePort::delete_one(&stub, "c", Document::new()).await.unwrap(), 0);
        assert!(MongoStorePort::ping(&stub).await.unwrap());

        assert_eq!(ResponseCachePort::get(&stub, "k").await.unwrap(), None);
        ResponseCachePort::set(&stub, "k", "v", 1).await.unwrap();
        ResponseCachePort::del(&stub, "k").await.unwrap();
        assert!(ResponseCachePort::ping(&stub).await.unwrap());

        assert_eq!(RateLimitStorePort::increment(&stub, "ns", "k", 1000).await.unwrap().total_hits, 1);
        let event: AbuseEvent = serde_json::from_value(json!({
            "route": "/",
            "at": 0,
            "deep": false,
            "support": false,
            "mismatch": 0.0,
        }))
        .unwrap();
        assert!(!AbuseRiskStorePort::append(&stub, "k", &event).await.unwrap().trapped);
        AbuseSummaryStorePort::write(&stub, &[]).await.unwrap();
        PowCohortStorePort::write(&stub, &[]).await.unwrap();
        assert!(PowCohortStorePort::read_day(&stub, 0).await.unwrap().is_empty());
        assert_eq!(AbuseTrialStorePort::get_trial_raw(&stub).await.unwrap(), None);
        assert!(SessionVerifierPort::verify_token(&stub, "t").await.unwrap().is_none());
        assert_eq!(MeiliSearchPort::search(&stub, "idx", &MeiliSearchQuery::default()).await.unwrap().hits.len(), 0);
        assert_eq!(OpenSearchPort::search(&stub, "idx", &json!({})).await.unwrap(), json!({}));
        assert!(VectorizePort::query_natural_language(&stub, "q", 1).await.unwrap().is_empty());
        assert_eq!(EpicStorePort::graphql(&stub, "", &json!({})).await.unwrap(), json!({}));
        assert!(EpicStorePort::featured_games(&stub).await.unwrap().is_empty());
        assert_eq!(JobApiPort::submit(&stub, JobApiJobType::OfferRegen, &json!({}), None).await.unwrap().job_id, "1");
        assert!(JobApiPort::submit_batch(&stub, JobApiJobType::OfferRegen, &[], None).await.unwrap().is_empty());
        assert_eq!(DiscordPort::request(&stub, "GET", "/", None).await.unwrap(), json!({}));
        TelegramPort::send_message(&stub, "hi").await.unwrap();
        GaPort::send_measurement(&stub, &json!({})).await.unwrap();
        GaPort::track(
            &stub,
            &GaTrackEvent {
                event: "e".into(),
                location: "/".into(),
                params: BTreeMap::new(),
                session_id: "s".into(),
                session_started_at: 0,
                session_last_active_at: 0,
                user_id: "u".into(),
            },
        )
        .await
        .unwrap();
        WebPushPort::send_notification(&stub, &json!({}), b"").await.unwrap();
        assert!(OgRendererPort::render_image(&stub, "", 1, 1, OgImageFormat::Png).await.unwrap().is_empty());
        assert!(CatalogHydrationResolverPort::resolve(&stub, &json!({})).await.unwrap().is_empty());
        let resp = UpstreamHttpPort::send(
            &stub,
            UpstreamHttpRequest {
                method: "GET".into(),
                url: "https://example.test".into(),
                headers: BTreeMap::new(),
                body: None,
                multipart_file: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(resp.status, 200);

        let mock = MockRateLimitStore::new(false);
        assert_eq!(mock.increment("ns", "k", 1000).await.unwrap().total_hits, 1);
        assert_eq!(mock.increment("ns", "k", 1000).await.unwrap().total_hits, 2);
        let failing = MockRateLimitStore::new(true);
        assert!(failing.increment("ns", "k", 1000).await.is_err());

        let _ = test_app_state(ApiConfig::default());
    }
}
