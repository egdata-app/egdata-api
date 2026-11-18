//! Async I/O port traits decoupling `egdata-core` / `egdata-graphql` / `egdata-api` from `egdata-infra`.

use async_trait::async_trait;
use bson::{Bson, Document};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

use crate::abuse::AbuseEvent;
use crate::error::CoreError;

/// Shared Redis response cache port.
#[async_trait]
pub trait ResponseCachePort: Send + Sync {
    async fn get(&self, key: &str) -> Result<Option<String>, CoreError>;
    async fn set(&self, key: &str, value: &str, ttl_seconds: u64) -> Result<(), CoreError>;
    async fn del(&self, key: &str) -> Result<(), CoreError>;
    /// Atomically remove a one-time marker and report whether this call consumed it.
    async fn consume(&self, _key: &str) -> Result<bool, CoreError> {
        Err(CoreError::Internal(
            "Atomic cache consumption unavailable".into(),
        ))
    }
    async fn ping(&self) -> Result<bool, CoreError>;
}

/// Rate limit increment outcome returned by `RateLimitStorePort`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RateLimitHit {
    pub total_hits: u64,
    pub ttl_ms: i64,
}

/// Distributed fixed-window rate limit counter store.
#[async_trait]
pub trait RateLimitStorePort: Send + Sync {
    async fn increment(
        &self,
        namespace: &str,
        key: &str,
        window_ms: u64,
    ) -> Result<RateLimitHit, CoreError>;
}

/// Sliding-window telemetry response returned by `AbuseRiskStorePort`.
#[derive(Debug, Clone, PartialEq)]
pub struct AbuseRiskWindow {
    pub events: Vec<AbuseEvent>,
    pub trapped: bool,
}

/// Shared anti-abuse sliding-window and canary-trap store.
#[async_trait]
pub trait AbuseRiskStorePort: Send + Sync {
    async fn append(&self, key: &str, event: &AbuseEvent) -> Result<AbuseRiskWindow, CoreError>;
}

/// Minute-bucketed anti-abuse summary counters row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AbuseSummaryRow {
    pub minute: i64,
    pub values: BTreeMap<String, i64>,
}

/// Persists minute-bucketed anti-abuse summary counters.
#[async_trait]
pub trait AbuseSummaryStorePort: Send + Sync {
    async fn write(&self, rows: &[AbuseSummaryRow]) -> Result<(), CoreError>;
}

/// Daily Proof-of-Work cohort funnel state update.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PowCohortUpdate {
    pub day: i64,
    pub id: String,
    pub first_challenge: i64,
    pub last_challenge: i64,
    pub last_puzzle: i64,
    pub last_solve: i64,
}

/// Persists and reads daily PoW cohort funnel hashes.
#[async_trait]
pub trait PowCohortStorePort: Send + Sync {
    async fn write(&self, rows: &[PowCohortUpdate]) -> Result<(), CoreError>;
    async fn read_day(&self, day: i64) -> Result<BTreeMap<String, String>, CoreError>;
}

/// Reads the operator-controlled anti-abuse trial configuration from Redis.
#[async_trait]
pub trait AbuseTrialStorePort: Send + Sync {
    async fn get_trial_raw(&self) -> Result<Option<String>, CoreError>;
}

/// Profile refresh requests use the job coordinator's shared Redis cooldown.
#[async_trait]
pub trait ProfileRefreshPort: Send + Sync {
    async fn status(&self, account_id: &str) -> Result<Option<String>, CoreError>;
    async fn request(&self, account_id: &str, ttl_ms: i64) -> Result<(), CoreError>;
}

/// Authenticated JWT user identity extracted by `SessionVerifierPort`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedSession {
    pub subject: String,
    pub claims: BTreeMap<String, Value>,
}

/// Verifies bearer JWTs or session tokens.
#[async_trait]
pub trait SessionVerifierPort: Send + Sync {
    async fn verify_token(&self, token: &str) -> Result<Option<VerifiedSession>, CoreError>;
    /// Only linked Epic OAuth accounts can authorize mutations scoped to an Epic identity.
    async fn verify_epic_session(
        &self,
        cookie: &str,
    ) -> Result<Option<VerifiedSession>, CoreError> {
        Ok(self.verify_token(cookie).await?.filter(|session| {
            session
                .claims
                .get("epicAccountId")
                .and_then(Value::as_str)
                .is_some_and(|id| !id.is_empty())
        }))
    }
}

/// Options for MongoDB `find_many` queries.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MongoFindOptions {
    pub projection: Option<Document>,
    pub sort: Option<Document>,
    pub collation: Option<Document>,
    pub skip: Option<u64>,
    pub limit: Option<i64>,
}

/// MongoDB aggregate command options used by the legacy catalog and profile API.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MongoAggregateOptions {
    pub allow_disk_use: Option<bool>,
    pub collation: Option<Document>,
    pub max_time_ms: Option<u64>,
}

/// Owned lazy Mongo cursor. Consumers retain only the records they need; dropping
/// the stream drops the driver cursor and schedules its normal cleanup.
pub type MongoDocumentStream = futures::stream::BoxStream<'static, Result<Document, CoreError>>;

#[async_trait]
/// Generic MongoDB document store port for reads, aggregations, counts, distincts, and writes.
pub trait MongoStorePort: Send + Sync {
    async fn find_one(
        &self,
        collection: &str,
        filter: Document,
        projection: Option<Document>,
    ) -> Result<Option<Document>, CoreError>;

    async fn find_one_with_options(
        &self,
        collection: &str,
        filter: Document,
        options: MongoFindOptions,
    ) -> Result<Option<Document>, CoreError> {
        if options.sort.is_none() && options.skip.is_none() && options.collation.is_none() {
            return self.find_one(collection, filter, options.projection).await;
        }
        let rows = self
            .find_many(
                collection,
                filter,
                MongoFindOptions {
                    limit: Some(1),
                    ..options
                },
            )
            .await?;
        Ok(rows.into_iter().next())
    }

    async fn find_many(
        &self,
        collection: &str,
        filter: Document,
        options: MongoFindOptions,
    ) -> Result<Vec<Document>, CoreError>;

    /// Preserve unrepresentable Node numeric find options (NaN, overflow or negative skip).
    async fn find_many_with_raw_page(
        &self,
        _collection: &str,
        _filter: Document,
        _options: Document,
    ) -> Result<Vec<Document>, CoreError> {
        Err(CoreError::Internal(
            "Native numeric find pagination is unavailable.".into(),
        ))
    }

    /// Open a lazy sorted cursor. Stores must implement streaming explicitly;
    /// buffering `find_many` is deliberately not used as a fallback.
    async fn find_stream(
        &self,
        _collection: &str,
        _filter: Document,
        _options: MongoFindOptions,
    ) -> Result<MongoDocumentStream, CoreError> {
        Err(CoreError::Internal(
            "Streaming Mongo reads are not implemented by this store.".into(),
        ))
    }

    async fn aggregate(
        &self,
        collection: &str,
        pipeline: Vec<Document>,
    ) -> Result<Vec<Document>, CoreError>;

    async fn aggregate_with_options(
        &self,
        collection: &str,
        pipeline: Vec<Document>,
        options: MongoAggregateOptions,
    ) -> Result<Vec<Document>, CoreError> {
        if options != MongoAggregateOptions::default() {
            return Err(CoreError::Internal(
                "Mongo aggregation options are unavailable".into(),
            ));
        }
        self.aggregate(collection, pipeline).await
    }

    async fn count_documents(&self, collection: &str, filter: Document) -> Result<u64, CoreError>;

    async fn count_documents_with_options(
        &self,
        collection: &str,
        filter: Document,
        _options: Option<Document>,
    ) -> Result<u64, CoreError> {
        self.count_documents(collection, filter).await
    }

    async fn distinct(
        &self,
        collection: &str,
        field: &str,
        filter: Document,
    ) -> Result<Vec<Bson>, CoreError>;

    async fn insert_one(&self, collection: &str, doc: Document) -> Result<(), CoreError>;

    async fn update_one(
        &self,
        collection: &str,
        filter: Document,
        update: Document,
        upsert: bool,
    ) -> Result<u64, CoreError>;

    /// Returns Mongo's upserted identifier only when this operation inserted a row.
    async fn upsert_one_returning_id(
        &self,
        _collection: &str,
        _filter: Document,
        _update: Document,
    ) -> Result<Option<Bson>, CoreError> {
        Err(CoreError::Internal(
            "Mongo upsert identifiers are unavailable".into(),
        ))
    }

    async fn delete_one(&self, collection: &str, filter: Document) -> Result<u64, CoreError>;

    async fn ping(&self) -> Result<bool, CoreError>;
}

/// MeiliSearch query parameters.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeiliSearchQuery {
    pub q: String,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
    pub filter: Option<String>,
    pub sort: Option<Vec<String>>,
}

/// MeiliSearch search response payload.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeiliSearchResult {
    pub hits: Vec<Value>,
    pub estimated_total_hits: Option<u64>,
    pub processing_time_ms: Option<u64>,
}

/// MeiliSearch search engine port.
#[async_trait]
pub trait MeiliSearchPort: Send + Sync {
    async fn search(
        &self,
        index: &str,
        query: &MeiliSearchQuery,
    ) -> Result<MeiliSearchResult, CoreError>;
}

/// OpenSearch analytics/catalog search port.
#[async_trait]
pub trait OpenSearchPort: Send + Sync {
    async fn search(&self, index: &str, body: &Value) -> Result<Value, CoreError>;
}

/// Matched offer returned by Cloudflare Vectorize natural-language search.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VectorizeOfferMatch {
    pub id: String,
    pub score: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<BTreeMap<String, Value>>,
}

/// Natural-language embedding & Cloudflare Vectorize query port.
#[async_trait]
pub trait VectorizePort: Send + Sync {
    async fn query_natural_language(
        &self,
        query: &str,
        top_k: usize,
    ) -> Result<Vec<VectorizeOfferMatch>, CoreError>;
}

/// Epic Games Store upstream GraphQL client port.
#[async_trait]
pub trait EpicStorePort: Send + Sync {
    /// Returns an account only when Epic confirms an active access token.
    async fn token_account(&self, _token: &str) -> Result<Option<String>, CoreError> {
        Ok(None)
    }
    async fn graphql(&self, query: &str, variables: &Value) -> Result<Value, CoreError>;
    /// Resolves a public player profile using the same null-on-upstream-failure
    /// behavior as the canonical `getUser` client helper.
    async fn get_user(&self, account_id: &str) -> Result<Option<Value>, CoreError> {
        let query = "query playerProfile($epicAccountId: String!) { PlayerProfile { playerProfile(epicAccountId: $epicAccountId) { epicAccountId displayName avatar { small medium large } } } }";
        let response = self
            .graphql(query, &serde_json::json!({"epicAccountId":account_id}))
            .await?;
        Ok(response
            .pointer("/data/PlayerProfile/playerProfile")
            .or_else(|| response.pointer("/PlayerProfile/playerProfile"))
            .filter(|value| !value.is_null())
            .cloned())
    }
    async fn featured_games(&self) -> Result<Vec<Value>, CoreError>;
}

/// Supported asynchronous Job API submission types.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum JobApiJobType {
    #[serde(rename = "offer-regen")]
    OfferRegen,
    #[serde(rename = "item-regen")]
    ItemRegen,
    #[serde(rename = "achievement-refresh")]
    AchievementRefresh,
}

/// Durable acceptance receipt returned by the external Job API.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptedJobSubmission {
    pub job_id: String,
    pub workflow_id: String,
    pub status_url: String,
    pub deduplicated: bool,
}

/// Signed HMAC Job API submission port.
#[async_trait]
pub trait JobApiPort: Send + Sync {
    async fn submit(
        &self,
        job_type: JobApiJobType,
        payload: &Value,
        request_id: Option<&str>,
    ) -> Result<AcceptedJobSubmission, CoreError>;

    async fn submit_batch(
        &self,
        job_type: JobApiJobType,
        payloads: &[Value],
        request_id: Option<&str>,
    ) -> Result<Vec<AcceptedJobSubmission>, CoreError>;
}

/// Discord REST API client port.
#[async_trait]
pub trait DiscordPort: Send + Sync {
    async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, CoreError>;
}

/// Telegram bot notification port.
#[async_trait]
pub trait TelegramPort: Send + Sync {
    async fn send_message(&self, message: &str) -> Result<(), CoreError>;
}

/// Google Analytics Measurement Protocol tracking event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GaTrackEvent {
    pub event: String,
    pub location: String,
    pub params: BTreeMap<String, Value>,
    pub session_id: String,
    pub session_started_at: i64,
    pub session_last_active_at: i64,
    pub user_id: String,
}

/// Google Analytics Measurement Protocol port.
#[async_trait]
pub trait GaPort: Send + Sync {
    async fn track(&self, event: &GaTrackEvent) -> Result<(), CoreError>;
    async fn send_measurement(&self, body: &Value) -> Result<(), CoreError>;
}

/// Web Push notification dispatch port.
#[async_trait]
pub trait WebPushPort: Send + Sync {
    async fn send_notification(
        &self,
        subscription: &Value,
        payload: &[u8],
    ) -> Result<(), CoreError>;
}

/// Output image format for OpenGraph image rendering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OgImageFormat {
    Png,
    Webp,
}

/// Native editorial images use the original Satori viewport and Resvg output width.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditorialOgTemplate {
    FreeGames,
    Collection,
    GameAwards,
}

impl EditorialOgTemplate {
    pub fn layout_width(self) -> u32 {
        match self {
            Self::FreeGames => 1300,
            _ => 1200,
        }
    }
    pub fn output_width(self) -> u32 {
        match self {
            Self::FreeGames => 1400,
            Self::Collection => 2800,
            Self::GameAwards => 1200,
        }
    }
}

/// HTML-to-image OpenGraph renderer port.
#[async_trait]
pub trait OgRendererPort: Send + Sync {
    async fn render_editorial(
        &self,
        html: &str,
        template: EditorialOgTemplate,
    ) -> Result<Vec<u8>, CoreError> {
        self.render_image(html, template.layout_width(), 630, OgImageFormat::Png)
            .await
    }
    async fn render_image(
        &self,
        html: &str,
        width: u32,
        height: u32,
        format: OgImageFormat,
    ) -> Result<Vec<u8>, CoreError>;

    async fn render_image_with_cover(
        &self,
        html_with_cover: &str,
        html_without_cover: &str,
        cover_url: Option<&str>,
        width: u32,
        height: u32,
        format: OgImageFormat,
    ) -> Result<Vec<u8>, CoreError> {
        let _ = (html_without_cover, cover_url);
        self.render_image(html_with_cover, width, height, format)
            .await
    }
}

/// Resolves `/v1/catalog/hydrate` requests into ordered NDJSON root lines.
#[async_trait]
pub trait CatalogHydrationResolverPort: Send + Sync {
    async fn resolve(&self, request: &Value) -> Result<Vec<Value>, CoreError>;
}

/// Optional multipart file field for `UpstreamHttpRequest`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpstreamHttpMultipartFile {
    pub field_name: String,
    pub filename: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

/// Outbound HTTP request dispatched via [`UpstreamHttpPort`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpstreamHttpRequest {
    pub method: String,
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub body: Option<Vec<u8>>,
    pub multipart_file: Option<UpstreamHttpMultipartFile>,
}

/// Outbound HTTP response returned by [`UpstreamHttpPort`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpstreamHttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

/// Generic outbound HTTP port for external OAuth, Cloudflare Images, and Epic catalog/fulfillment calls.
#[async_trait]
pub trait UpstreamHttpPort: Send + Sync {
    async fn send(&self, request: UpstreamHttpRequest) -> Result<UpstreamHttpResponse, CoreError>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use bson::doc;
    use serde_json::json;

    struct MockPorts;

    #[async_trait]
    impl ResponseCachePort for MockPorts {
        async fn get(&self, key: &str) -> Result<Option<String>, CoreError> {
            Ok(Some(key.to_string()))
        }
        async fn set(&self, _k: &str, _v: &str, _ttl: u64) -> Result<(), CoreError> {
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
    impl RateLimitStorePort for MockPorts {
        async fn increment(
            &self,
            _ns: &str,
            _k: &str,
            window_ms: u64,
        ) -> Result<RateLimitHit, CoreError> {
            Ok(RateLimitHit {
                total_hits: 1,
                ttl_ms: window_ms as i64,
            })
        }
    }

    #[async_trait]
    impl AbuseRiskStorePort for MockPorts {
        async fn append(
            &self,
            _key: &str,
            event: &AbuseEvent,
        ) -> Result<AbuseRiskWindow, CoreError> {
            Ok(AbuseRiskWindow {
                events: vec![event.clone()],
                trapped: false,
            })
        }
    }

    #[async_trait]
    impl AbuseSummaryStorePort for MockPorts {
        async fn write(&self, _rows: &[AbuseSummaryRow]) -> Result<(), CoreError> {
            Ok(())
        }
    }

    #[async_trait]
    impl PowCohortStorePort for MockPorts {
        async fn write(&self, _rows: &[PowCohortUpdate]) -> Result<(), CoreError> {
            Ok(())
        }
        async fn read_day(&self, _day: i64) -> Result<BTreeMap<String, String>, CoreError> {
            Ok(BTreeMap::new())
        }
    }

    #[async_trait]
    impl AbuseTrialStorePort for MockPorts {
        async fn get_trial_raw(&self) -> Result<Option<String>, CoreError> {
            Ok(None)
        }
    }

    #[async_trait]
    impl SessionVerifierPort for MockPorts {
        async fn verify_token(&self, token: &str) -> Result<Option<VerifiedSession>, CoreError> {
            Ok(Some(VerifiedSession {
                subject: token.to_string(),
                claims: BTreeMap::new(),
            }))
        }
    }

    #[async_trait]
    impl MongoStorePort for MockPorts {
        async fn find_one(
            &self,
            _c: &str,
            _f: Document,
            _p: Option<Document>,
        ) -> Result<Option<Document>, CoreError> {
            Ok(Some(doc! { "ok": 1 }))
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
        async fn distinct(
            &self,
            _c: &str,
            _field: &str,
            _f: Document,
        ) -> Result<Vec<Bson>, CoreError> {
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
            Ok(1)
        }
        async fn delete_one(&self, _c: &str, _f: Document) -> Result<u64, CoreError> {
            Ok(1)
        }
        async fn ping(&self) -> Result<bool, CoreError> {
            Ok(true)
        }
    }

    #[async_trait]
    impl MeiliSearchPort for MockPorts {
        async fn search(
            &self,
            _index: &str,
            _query: &MeiliSearchQuery,
        ) -> Result<MeiliSearchResult, CoreError> {
            Ok(MeiliSearchResult::default())
        }
    }

    #[async_trait]
    impl OpenSearchPort for MockPorts {
        async fn search(&self, _index: &str, _body: &Value) -> Result<Value, CoreError> {
            Ok(json!({ "hits": { "hits": [] } }))
        }
    }

    #[async_trait]
    impl VectorizePort for MockPorts {
        async fn query_natural_language(
            &self,
            _query: &str,
            _top_k: usize,
        ) -> Result<Vec<VectorizeOfferMatch>, CoreError> {
            Ok(vec![VectorizeOfferMatch {
                id: "offer-1".into(),
                score: 0.9,
                metadata: None,
            }])
        }
    }

    #[async_trait]
    impl EpicStorePort for MockPorts {
        async fn graphql(&self, _q: &str, variables: &Value) -> Result<Value, CoreError> {
            let player = variables
                .get("epicAccountId")
                .map(|id| json!({"epicAccountId": id}));
            Ok(json!({ "data": {"PlayerProfile": {"playerProfile": player}} }))
        }
        async fn featured_games(&self) -> Result<Vec<Value>, CoreError> {
            Ok(Vec::new())
        }
    }

    #[async_trait]
    impl JobApiPort for MockPorts {
        async fn submit(
            &self,
            _job_type: JobApiJobType,
            _payload: &Value,
            _request_id: Option<&str>,
        ) -> Result<AcceptedJobSubmission, CoreError> {
            Ok(AcceptedJobSubmission {
                job_id: "job-1".into(),
                workflow_id: "job-1".into(),
                status_url: "/jobs/job-1".into(),
                deduplicated: false,
            })
        }
        async fn submit_batch(
            &self,
            job_type: JobApiJobType,
            payloads: &[Value],
            request_id: Option<&str>,
        ) -> Result<Vec<AcceptedJobSubmission>, CoreError> {
            let mut out = Vec::with_capacity(payloads.len());
            for p in payloads {
                out.push(self.submit(job_type, p, request_id).await?);
            }
            Ok(out)
        }
    }

    #[async_trait]
    impl DiscordPort for MockPorts {
        async fn request(
            &self,
            _method: &str,
            _path: &str,
            _body: Option<&Value>,
        ) -> Result<Value, CoreError> {
            Ok(json!({}))
        }
    }

    #[async_trait]
    impl TelegramPort for MockPorts {
        async fn send_message(&self, _message: &str) -> Result<(), CoreError> {
            Ok(())
        }
    }

    #[async_trait]
    impl GaPort for MockPorts {
        async fn send_measurement(&self, _: &Value) -> Result<(), CoreError> {
            Ok(())
        }
        async fn track(&self, _event: &GaTrackEvent) -> Result<(), CoreError> {
            Ok(())
        }
    }

    #[async_trait]
    impl WebPushPort for MockPorts {
        async fn send_notification(&self, _sub: &Value, _payload: &[u8]) -> Result<(), CoreError> {
            Ok(())
        }
    }

    #[async_trait]
    impl OgRendererPort for MockPorts {
        async fn render_image(
            &self,
            _html: &str,
            _w: u32,
            _h: u32,
            format: OgImageFormat,
        ) -> Result<Vec<u8>, CoreError> {
            Ok(match format {
                OgImageFormat::Png => vec![137, 80, 78, 71],
                OgImageFormat::Webp => vec![82, 73, 70, 70],
            })
        }
    }

    #[async_trait]
    impl CatalogHydrationResolverPort for MockPorts {
        async fn resolve(&self, _req: &Value) -> Result<Vec<Value>, CoreError> {
            Ok(vec![json!({"rootKey": "item:ns:id"})])
        }
    }

    #[async_trait]
    impl UpstreamHttpPort for MockPorts {
        async fn send(
            &self,
            _request: UpstreamHttpRequest,
        ) -> Result<UpstreamHttpResponse, CoreError> {
            Ok(UpstreamHttpResponse {
                status: 200,
                body: b"{}".to_vec(),
            })
        }
    }

    #[tokio::test]
    async fn test_all_ports_traits() {
        let mock = MockPorts;
        assert!(ResponseCachePort::consume(&mock, "one-time").await.is_err());
        assert!(
            mock.find_many_with_raw_page("offers", doc! {}, doc! {"limit":f64::NAN})
                .await
                .is_err()
        );
        assert!(
            mock.upsert_one_returning_id("tokens", doc! {}, doc! {})
                .await
                .is_err()
        );
        assert!(
            mock.find_stream("offers", doc! {}, MongoFindOptions::default())
                .await
                .is_err()
        );
        assert!(
            mock.aggregate_with_options("offers", vec![], MongoAggregateOptions::default())
                .await
                .unwrap()
                .is_empty()
        );
        let options = MongoAggregateOptions {
            allow_disk_use: Some(true),
            ..Default::default()
        };
        assert!(
            mock.aggregate_with_options("offers", vec![], options)
                .await
                .is_err()
        );
        assert_eq!(mock.token_account("unknown").await.unwrap(), None);
        assert_eq!(
            mock.get_user("fixture-player").await.unwrap(),
            Some(json!({"epicAccountId": "fixture-player"}))
        );
        assert!(mock.featured_games().await.unwrap().is_empty());
        assert_eq!(
            ResponseCachePort::get(&mock, "k").await.unwrap(),
            Some("k".into())
        );
        ResponseCachePort::set(&mock, "k", "v", 60).await.unwrap();
        ResponseCachePort::del(&mock, "k").await.unwrap();
        assert!(ResponseCachePort::ping(&mock).await.unwrap());

        let hit = RateLimitStorePort::increment(&mock, "api", "ip", 60_000)
            .await
            .unwrap();
        assert_eq!(hit.total_hits, 1);

        let ev = AbuseEvent {
            resource: Default::default(),
            at: 1000,
            deep: false,
            support: true,
            resources: None,
            mismatch: 0.0,
            trap: None,
            method: None,
        };
        assert!(
            !AbuseRiskStorePort::append(&mock, "k", &ev)
                .await
                .unwrap()
                .trapped
        );
        AbuseSummaryStorePort::write(&mock, &[]).await.unwrap();
        PowCohortStorePort::write(&mock, &[]).await.unwrap();
        assert!(
            PowCohortStorePort::read_day(&mock, 1)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            AbuseTrialStorePort::get_trial_raw(&mock)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            SessionVerifierPort::verify_token(&mock, "sub")
                .await
                .unwrap()
                .unwrap()
                .subject,
            "sub"
        );

        assert!(
            MongoStorePort::find_one(&mock, "offers", doc! {}, None)
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            MongoStorePort::find_many(&mock, "offers", doc! {}, MongoFindOptions::default())
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            MongoStorePort::aggregate(&mock, "offers", vec![])
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            MongoStorePort::count_documents(&mock, "offers", doc! {})
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            mock.count_documents_with_options("offers", doc! {}, None)
                .await
                .unwrap(),
            0
        );
        assert!(
            MongoStorePort::distinct(&mock, "offers", "id", doc! {})
                .await
                .unwrap()
                .is_empty()
        );
        MongoStorePort::insert_one(&mock, "offers", doc! {})
            .await
            .unwrap();
        assert_eq!(
            MongoStorePort::update_one(&mock, "offers", doc! {}, doc! {}, false)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            MongoStorePort::delete_one(&mock, "offers", doc! {})
                .await
                .unwrap(),
            1
        );
        assert!(MongoStorePort::ping(&mock).await.unwrap());

        let ms = MeiliSearchPort::search(&mock, "offers", &MeiliSearchQuery::default())
            .await
            .unwrap();
        assert!(ms.hits.is_empty());
        let os = OpenSearchPort::search(&mock, "egdata.offers", &json!({}))
            .await
            .unwrap();
        assert!(os["hits"]["hits"].is_array());
        let vec = VectorizePort::query_natural_language(&mock, "rpg", 5)
            .await
            .unwrap();
        assert_eq!(vec[0].id, "offer-1");
        assert!(
            EpicStorePort::graphql(&mock, "query {}", &json!({}))
                .await
                .is_ok()
        );

        let job_batch =
            JobApiPort::submit_batch(&mock, JobApiJobType::OfferRegen, &[json!({})], None)
                .await
                .unwrap();
        assert_eq!(job_batch.len(), 1);
        assert!(
            DiscordPort::request(&mock, "GET", "/users/@me", None)
                .await
                .is_ok()
        );
        TelegramPort::send_message(&mock, "hi").await.unwrap();
        GaPort::send_measurement(&mock, &json!({"events": []}))
            .await
            .unwrap();
        GaPort::track(
            &mock,
            &GaTrackEvent {
                event: "view".into(),
                location: "/".into(),
                params: BTreeMap::new(),
                session_id: "s".into(),
                session_started_at: 1,
                session_last_active_at: 2,
                user_id: "u".into(),
            },
        )
        .await
        .unwrap();
        WebPushPort::send_notification(&mock, &json!({}), b"hi")
            .await
            .unwrap();
        assert_eq!(
            OgRendererPort::render_image(&mock, "<div/>", 1200, 630, OgImageFormat::Png)
                .await
                .unwrap(),
            vec![137, 80, 78, 71]
        );
        assert_eq!(
            OgRendererPort::render_image(&mock, "<div/>", 1200, 630, OgImageFormat::Webp)
                .await
                .unwrap(),
            vec![82, 73, 70, 70]
        );
        assert_eq!(
            CatalogHydrationResolverPort::resolve(&mock, &json!({}))
                .await
                .unwrap()
                .len(),
            1
        );
        let http_res = UpstreamHttpPort::send(
            &mock,
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
        assert_eq!(http_res.status, 200);
    }
}
