//! Shared test doubles for middleware unit tests.

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

use crate::state::{ApiConfig, AppState};

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
        now: chrono::Utc::now,
        new_object_id: bson::oid::ObjectId::new,
        config: Arc::new(config),
        mongo: stub.clone(),
        cache: stub.clone(),
        saved_queries: stub.clone(),
        graphql_cache: stub.clone(),
        profile_refresh: Arc::new(crate::middleware::test_support::StubPorts),
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
