//! Concrete `egdata_core::ports` trait implementations bridging core domain ports to `egdata-infra` adapters.

use std::collections::{BTreeMap, HashMap};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use bson::{Bson, Document, doc};
use futures::{StreamExt, TryStreamExt};
use mongodb::Database;
use mongodb::options::{Collation, CountOptions, FindOneOptions, FindOptions, UpdateOptions};
use reqwest::Method;
use serde_json::{Map, Value, json};

use egdata_core::abuse::{AbuseEvent as CoreAbuseEvent, AbuseResource as CoreAbuseResource};
use egdata_core::error::CoreError;
use egdata_core::ports::{
    AbuseRiskStorePort, AbuseRiskWindow, AbuseSummaryRow, AbuseSummaryStorePort,
    AbuseTrialStorePort, AcceptedJobSubmission, CatalogHydrationResolverPort, DiscordPort,
    EpicStorePort, GaPort, GaTrackEvent, JobApiJobType as CoreJobApiJobType, JobApiPort,
    MeiliSearchPort, MeiliSearchQuery, MeiliSearchResult, MongoFindOptions, MongoStorePort,
    OgImageFormat as CoreOgImageFormat, OgRendererPort, OpenSearchPort, PowCohortStorePort,
    PowCohortUpdate, RateLimitHit, RateLimitStorePort, ResponseCachePort, SessionVerifierPort,
    TelegramPort, UpstreamHttpPort, UpstreamHttpRequest, UpstreamHttpResponse,
    VectorizeOfferMatch as CoreVectorizeOfferMatch, VectorizePort, VerifiedSession, WebPushPort,
};

use crate::auth_pg::{BetterAuthSession, BetterAuthVerifier, SessionRepository};
use crate::catalog_mongo::{
    CatalogHydrationRequest, CatalogMongoDataSource, MongoCatalogHydrationResolver,
};
use crate::epic_client::EpicStoreClient;
use crate::job_api::{
    JobApiBatchOptions, JobApiClient, JobApiJobType as InfraJobApiJobType, JobApiRequestOptions,
};
use crate::mongo::{native_document, native_documents};
use crate::notifications::{
    DiscordRestClient, GaClient, GaSession, GaTrackOptions, NotificationError, PushSendOutcome,
    PushSubscriptionKeys, PushSubscriptionTarget, TelegramBotService, VapidWebPushClient,
    WebPushDispatcher,
};
use crate::og_renderer::{
    OgImageFormat as InfraOgImageFormat, fetch_og_cover, og_cover_bytes_are_renderable,
    render_editorial_html, render_html_to_image, render_html_to_image_with_image_bytes,
};
use crate::redis_store::{
    AbuseEvent as InfraAbuseEvent, AbuseResource as InfraAbuseResource, CohortUpdate,
    RedisCohortStore, RedisRateLimitStore, RedisRiskStore, RedisStoreError, RedisSummaryStore,
    RedisTrialStore, ResponseCache, SummaryRow, next_unique_id,
};
use crate::search_clients::{MeilisearchClient, OpenSearchClient, VectorizeClient};

fn internal_error(error: impl std::fmt::Display) -> CoreError {
    CoreError::Internal(error.to_string())
}

// mongodb 3.10's retryable-read predicate is private. Use the same network
// failures and server codes for the raw distinct command.
fn retryable_read(error: &mongodb::error::Error) -> bool {
    use mongodb::error::ErrorKind;
    match error.kind.as_ref() {
        ErrorKind::Io(_) | ErrorKind::ConnectionPoolCleared { .. } => true,
        ErrorKind::Command(command) => matches!(
            command.code,
            11600 | 11602 | 10107 | 13435 | 13436 | 189 | 91 | 7 | 6 | 89 | 9001 | 134 | 262
        ),
        _ => false,
    }
}

fn distinct_values(mut reply: Document) -> Result<Vec<Bson>, CoreError> {
    match reply.remove("values") {
        Some(Bson::Array(values)) => Ok(values),
        _ => Err(internal_error(
            "MongoDB distinct response is missing its values array",
        )),
    }
}

fn mongo_collation(value: Option<Document>) -> Result<Option<Collation>, CoreError> {
    value
        .map(bson::from_document)
        .transpose()
        .map_err(|error| CoreError::InvalidInput(error.to_string()))
}

fn vectorize_core_error(error: crate::search_clients::SearchClientError) -> CoreError {
    match error {
        crate::search_clients::SearchClientError::VectorizeConfiguration(message) => {
            CoreError::InvalidInput(message)
        }
        crate::search_clients::SearchClientError::CloudflareVectorize { message, .. } => {
            CoreError::Upstream(message)
        }
        other => CoreError::Internal(other.to_string()),
    }
}

fn current_epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn core_err_from_redis(err: RedisStoreError) -> CoreError {
    match err {
        RedisStoreError::InvalidConfig(msg) => CoreError::InvalidInput(msg),
        other => CoreError::Internal(other.to_string()),
    }
}

/// Concrete `MongoStorePort` adapter backed by `mongodb::Database`.
#[derive(Clone)]
pub struct MongoStoreWithReadPolicy<const RETRY_READS: bool> {
    pub db: Database,
}

/// Default MongoDB retryable reads, preserving the original adapter constructor and fields.
pub type MongoStoreAdapter = MongoStoreWithReadPolicy<true>;

impl MongoStoreAdapter {
    pub fn new(db: Database) -> Self {
        Self { db }
    }

    pub fn configured(db: Database, retry_reads: bool) -> std::sync::Arc<dyn MongoStorePort> {
        if retry_reads {
            std::sync::Arc::new(Self::new(db))
        } else {
            std::sync::Arc::new(MongoStoreWithReadPolicy::<false> { db })
        }
    }
}

impl<const RETRY_READS: bool> MongoStoreWithReadPolicy<RETRY_READS> {
    async fn update(
        &self,
        collection: &str,
        filter: Document,
        update: Document,
        upsert: bool,
    ) -> Result<mongodb::results::UpdateResult, CoreError> {
        let opts = UpdateOptions::builder().upsert(upsert).build();
        self.db
            .collection::<Document>(collection)
            .update_one(filter, update)
            .with_options(opts)
            .await
            .map_err(internal_error)
    }
}

#[async_trait]
impl<const RETRY_READS: bool> MongoStorePort for MongoStoreWithReadPolicy<RETRY_READS> {
    async fn find_one(
        &self,
        collection: &str,
        filter: Document,
        projection: Option<Document>,
    ) -> Result<Option<Document>, CoreError> {
        self.find_one_with_options(
            collection,
            filter,
            MongoFindOptions {
                projection,
                ..Default::default()
            },
        )
        .await
    }

    async fn find_one_with_options(
        &self,
        collection: &str,
        filter: Document,
        options: MongoFindOptions,
    ) -> Result<Option<Document>, CoreError> {
        let opts = FindOneOptions::builder()
            .projection(options.projection)
            .sort(options.sort)
            .collation(mongo_collation(options.collation)?)
            .skip(options.skip)
            .build();
        self.db
            .collection::<bson::RawDocumentBuf>(collection)
            .find_one(filter)
            .with_options(opts)
            .await
            .and_then(|doc| doc.map(native_document).transpose())
            .map_err(internal_error)
    }

    async fn find_many(
        &self,
        collection: &str,
        filter: Document,
        options: MongoFindOptions,
    ) -> Result<Vec<Document>, CoreError> {
        let opts = FindOptions::builder()
            .projection(options.projection)
            .sort(options.sort)
            .collation(mongo_collation(options.collation)?)
            .skip(options.skip)
            .limit(options.limit)
            .build();
        let cursor = self
            .db
            .collection::<Document>(collection)
            .find(filter)
            .with_options(opts)
            .await
            .map_err(internal_error)?;
        native_documents(cursor)
            .try_collect()
            .await
            .map_err(internal_error)
    }

    async fn find_many_with_raw_page(
        &self,
        collection: &str,
        filter: Document,
        options: Document,
    ) -> Result<Vec<Document>, CoreError> {
        let mut command = doc! {"find": collection, "filter": filter};
        command.extend(options);
        if let Some(concern) = self.db.read_concern() {
            command.insert(
                "readConcern",
                bson::to_bson(concern).map_err(internal_error)?,
            );
        }
        let options = mongodb::options::RunCursorCommandOptions::builder()
            .selection_criteria(self.db.selection_criteria().cloned())
            .build();
        let execute = || {
            self.db
                .run_cursor_command(command.clone())
                .with_options(options.clone())
        };
        let cursor = match execute().await {
            Err(error) if RETRY_READS && retryable_read(&error) => execute().await,
            result => result,
        }
        .map_err(internal_error)?;
        native_documents(cursor)
            .try_collect()
            .await
            .map_err(internal_error)
    }

    async fn find_stream(
        &self,
        collection: &str,
        filter: Document,
        options: MongoFindOptions,
    ) -> Result<egdata_core::ports::MongoDocumentStream, CoreError> {
        let opts = FindOptions::builder()
            .projection(options.projection)
            .sort(options.sort)
            .collation(mongo_collation(options.collation)?)
            .skip(options.skip)
            .limit(options.limit)
            .batch_size(256)
            .build();
        let cursor = self
            .db
            .collection::<Document>(collection)
            .find(filter)
            .with_options(opts)
            .await
            .map_err(internal_error)?;
        Ok(native_documents(cursor).map_err(internal_error).boxed())
    }

    async fn aggregate(
        &self,
        collection: &str,
        pipeline: Vec<Document>,
    ) -> Result<Vec<Document>, CoreError> {
        self.aggregate_with_options(collection, pipeline, Default::default())
            .await
    }

    async fn aggregate_with_options(
        &self,
        collection: &str,
        pipeline: Vec<Document>,
        options: egdata_core::ports::MongoAggregateOptions,
    ) -> Result<Vec<Document>, CoreError> {
        let cursor = self
            .db
            .collection::<Document>(collection)
            .aggregate(pipeline)
            .with_options(
                mongodb::options::AggregateOptions::builder()
                    .allow_disk_use(options.allow_disk_use)
                    .collation(mongo_collation(options.collation)?)
                    .max_time(options.max_time_ms.map(std::time::Duration::from_millis))
                    .build(),
            )
            .await
            .map_err(internal_error)?;
        native_documents(cursor)
            .try_collect()
            .await
            .map_err(internal_error)
    }

    async fn count_documents(&self, collection: &str, filter: Document) -> Result<u64, CoreError> {
        self.db
            .collection::<Document>(collection)
            .count_documents(filter)
            .await
            .map_err(internal_error)
    }

    async fn count_documents_with_options(
        &self,
        collection: &str,
        filter: Document,
        options: Option<Document>,
    ) -> Result<u64, CoreError> {
        let mut options = options.unwrap_or_default();
        if let Some(max_time) = options.remove("maxTimeMS") {
            options.insert("maxTime", max_time);
        }
        let options: CountOptions = bson::from_document(options)
            .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
        self.db
            .collection::<Document>(collection)
            .count_documents(filter)
            .with_options(options)
            .await
            .map_err(internal_error)
    }

    async fn distinct(
        &self,
        collection: &str,
        field: &str,
        filter: Document,
    ) -> Result<Vec<Bson>, CoreError> {
        // Collection::distinct decodes the reply as Vec<Bson> through Serde
        // and can reinterpret literal Extended JSON. run_command preserves its wire tags.
        let mut command = doc! {"distinct":collection, "key":field,"query":filter};
        if let Some(concern) = self.db.read_concern() {
            command.insert(
                "readConcern",
                bson::to_bson(concern).map_err(internal_error)?,
            );
        }
        let options = mongodb::options::RunCommandOptions::builder()
            .selection_criteria(self.db.selection_criteria().cloned())
            .build();
        let execute = || {
            self.db
                .run_command(command.clone())
                .with_options(options.clone())
        };
        let reply = match execute().await {
            Err(error) if RETRY_READS && retryable_read(&error) => execute().await,
            result => result,
        }
        .map_err(internal_error)?;
        distinct_values(reply)
    }

    async fn insert_one(&self, collection: &str, doc: Document) -> Result<(), CoreError> {
        self.db
            .collection::<Document>(collection)
            .insert_one(doc)
            .await
            .map_err(internal_error)?;
        Ok(())
    }

    async fn update_one(
        &self,
        collection: &str,
        filter: Document,
        update: Document,
        upsert: bool,
    ) -> Result<u64, CoreError> {
        let res = self.update(collection, filter, update, upsert).await?;
        Ok(res.modified_count + u64::from(res.upserted_id.is_some()))
    }

    async fn upsert_one_returning_id(
        &self,
        collection: &str,
        filter: Document,
        update: Document,
    ) -> Result<Option<Bson>, CoreError> {
        Ok(self
            .update(collection, filter, update, true)
            .await?
            .upserted_id)
    }

    async fn delete_one(&self, collection: &str, filter: Document) -> Result<u64, CoreError> {
        let res = self
            .db
            .collection::<Document>(collection)
            .delete_one(filter)
            .await
            .map_err(internal_error)?;
        Ok(res.deleted_count)
    }

    async fn ping(&self) -> Result<bool, CoreError> {
        let res = self
            .db
            .run_command(doc! { "ping": 1 })
            .await
            .map_err(internal_error)?;
        Ok(res.get("ok").is_some())
    }
}

#[async_trait]
impl ResponseCachePort for ResponseCache {
    async fn get(&self, key: &str) -> Result<Option<String>, CoreError> {
        ResponseCache::get(self, key)
            .await
            .map_err(core_err_from_redis)
    }

    async fn set(&self, key: &str, value: &str, ttl_seconds: u64) -> Result<(), CoreError> {
        ResponseCache::set(self, key, value, ttl_seconds)
            .await
            .map(|_| ())
            .map_err(core_err_from_redis)
    }

    async fn del(&self, key: &str) -> Result<(), CoreError> {
        ResponseCache::del(self, key)
            .await
            .map_err(core_err_from_redis)
    }

    async fn consume(&self, key: &str) -> Result<bool, CoreError> {
        ResponseCache::consume(self, key)
            .await
            .map_err(core_err_from_redis)
    }

    async fn ping(&self) -> Result<bool, CoreError> {
        ResponseCache::ping(self).await.map_err(core_err_from_redis)
    }
}

#[async_trait]
impl RateLimitStorePort for RedisRateLimitStore {
    async fn increment(
        &self,
        namespace: &str,
        key: &str,
        window_ms: u64,
    ) -> Result<RateLimitHit, CoreError> {
        let now_ms = current_epoch_ms();
        let info = self.increment_with(namespace, key, window_ms, now_ms).await;
        let ttl_ms = info
            .reset_time_ms
            .map(|reset| (reset - now_ms).max(0))
            .unwrap_or(0);
        Ok(RateLimitHit {
            total_hits: info.total_hits,
            ttl_ms,
        })
    }
}

fn core_resource_to_infra(res: &CoreAbuseResource) -> InfraAbuseResource {
    InfraAbuseResource {
        route: res.route.clone(),
        page: res.page.map(i64::from),
        item_id: res.item_id.clone(),
        limit: res.limit.map(i64::from),
        search: res.search,
        title_hash: res.title_hash.clone(),
        hydration_id: res.hydration_id.clone(),
        hydration_route: res.hydration_route.clone(),
        cache_hit: res.cache_hit,
    }
}

fn infra_resource_to_core(res: &InfraAbuseResource) -> CoreAbuseResource {
    CoreAbuseResource {
        route: res.route.clone(),
        page: res.page.and_then(|p| u32::try_from(p).ok()),
        item_id: res.item_id.clone(),
        limit: res.limit.and_then(|l| u32::try_from(l).ok()),
        search: res.search,
        title_hash: res.title_hash.clone(),
        hydration_id: res.hydration_id.clone(),
        hydration_route: res.hydration_route.clone(),
        cache_hit: res.cache_hit,
    }
}

fn core_event_to_infra(event: &CoreAbuseEvent) -> InfraAbuseEvent {
    InfraAbuseEvent {
        route: event.resource.route.clone(),
        page: event.resource.page.map(i64::from),
        item_id: event.resource.item_id.clone(),
        limit: event.resource.limit.map(i64::from),
        search: event.resource.search,
        title_hash: event.resource.title_hash.clone(),
        hydration_id: event.resource.hydration_id.clone(),
        hydration_route: event.resource.hydration_route.clone(),
        cache_hit: event.resource.cache_hit,
        at: event.at,
        deep: event.deep,
        support: event.support,
        resources: event
            .resources
            .as_ref()
            .map(|list| list.iter().map(core_resource_to_infra).collect()),
        mismatch: event.mismatch,
        trap: event.trap,
        method: event.method.clone(),
    }
}

fn infra_event_to_core(event: InfraAbuseEvent) -> CoreAbuseEvent {
    CoreAbuseEvent {
        resource: CoreAbuseResource {
            route: event.route,
            page: event.page.and_then(|p| u32::try_from(p).ok()),
            item_id: event.item_id,
            limit: event.limit.and_then(|l| u32::try_from(l).ok()),
            search: event.search,
            title_hash: event.title_hash,
            hydration_id: event.hydration_id,
            hydration_route: event.hydration_route,
            cache_hit: event.cache_hit,
        },
        at: event.at,
        deep: event.deep,
        support: event.support,
        resources: event
            .resources
            .map(|list| list.iter().map(infra_resource_to_core).collect()),
        mismatch: event.mismatch,
        trap: event.trap,
        method: event.method,
    }
}

#[async_trait]
impl AbuseRiskStorePort for RedisRiskStore {
    async fn append(
        &self,
        key: &str,
        event: &CoreAbuseEvent,
    ) -> Result<AbuseRiskWindow, CoreError> {
        let infra_event = core_event_to_infra(event);
        let member_id = next_unique_id();
        let res = RedisRiskStore::append(self, key, &infra_event, &member_id)
            .await
            .map_err(core_err_from_redis)?;
        Ok(AbuseRiskWindow {
            events: res.events.into_iter().map(infra_event_to_core).collect(),
            trapped: res.trapped,
        })
    }
}

#[async_trait]
impl AbuseSummaryStorePort for RedisSummaryStore {
    async fn write(&self, rows: &[AbuseSummaryRow]) -> Result<(), CoreError> {
        let converted: Vec<SummaryRow> = rows
            .iter()
            .map(|row| SummaryRow {
                minute: row.minute,
                values: row
                    .values
                    .iter()
                    .map(|(k, v)| (k.clone(), *v))
                    .collect::<HashMap<_, _>>(),
            })
            .collect();
        RedisSummaryStore::write(self, &converted, &next_unique_id())
            .await
            .map_err(core_err_from_redis)
    }
}

#[async_trait]
impl PowCohortStorePort for RedisCohortStore {
    async fn write(&self, rows: &[PowCohortUpdate]) -> Result<(), CoreError> {
        let converted: Vec<CohortUpdate> = rows
            .iter()
            .map(|r| CohortUpdate {
                day: r.day,
                id: r.id.clone(),
                first_challenge: r.first_challenge,
                last_challenge: r.last_challenge,
                last_puzzle: r.last_puzzle,
                last_solve: r.last_solve,
            })
            .collect();
        RedisCohortStore::write(self, &converted)
            .await
            .map_err(core_err_from_redis)
    }

    async fn read_day(&self, day: i64) -> Result<BTreeMap<String, String>, CoreError> {
        let map = RedisCohortStore::read_day(self, day)
            .await
            .map_err(core_err_from_redis)?;
        Ok(map.into_iter().collect())
    }
}

#[async_trait]
impl AbuseTrialStorePort for RedisTrialStore {
    async fn get_trial_raw(&self) -> Result<Option<String>, CoreError> {
        self.get_raw().await.map_err(core_err_from_redis)
    }
}

fn session_to_verified(session: BetterAuthSession) -> VerifiedSession {
    let mut claims = BTreeMap::new();
    claims.insert("email".into(), Value::String(session.user.email));
    claims.insert("name".into(), Value::String(session.user.name));
    claims.insert(
        "emailVerified".into(),
        Value::Bool(session.user.email_verified),
    );
    claims.insert("sessionId".into(), Value::String(session.session.id));
    claims.insert(
        "expiresAt".into(),
        Value::String(session.session.expires_at.to_rfc3339()),
    );
    VerifiedSession {
        subject: session.user.id,
        claims,
    }
}

#[async_trait]
impl<R: SessionRepository + 'static> SessionVerifierPort for BetterAuthVerifier<R> {
    async fn verify_epic_session(
        &self,
        cookie: &str,
    ) -> Result<Option<VerifiedSession>, CoreError> {
        let Some(session) = self
            .get_session(Some(cookie), false)
            .await
            .map_err(internal_error)?
        else {
            return Ok(None);
        };
        let Some(id) = self
            .linked_epic_account(&session)
            .await
            .map_err(internal_error)?
        else {
            return Ok(None);
        };
        let mut verified = session_to_verified(session);
        verified.claims.insert("epicAccountId".into(), id.into());
        Ok(Some(verified))
    }
    async fn verify_token(&self, token: &str) -> Result<Option<VerifiedSession>, CoreError> {
        let session = self
            .get_session(Some(token), false)
            .await
            .map_err(internal_error)?;
        Ok(session.map(session_to_verified))
    }
}

#[async_trait]
impl MeiliSearchPort for MeilisearchClient {
    async fn search(
        &self,
        index: &str,
        query: &MeiliSearchQuery,
    ) -> Result<MeiliSearchResult, CoreError> {
        let mut body = Map::new();
        body.insert("q".into(), Value::String(query.q.clone()));
        if let Some(limit) = query.limit {
            body.insert("limit".into(), Value::Number(limit.into()));
        }
        if let Some(offset) = query.offset {
            body.insert("offset".into(), Value::Number(offset.into()));
        }
        if let Some(filter) = &query.filter {
            body.insert("filter".into(), Value::String(filter.clone()));
        }
        if let Some(sort) = &query.sort {
            body.insert(
                "sort".into(),
                Value::Array(sort.iter().cloned().map(Value::String).collect()),
            );
        }
        let resp = MeilisearchClient::search(self, index, &Value::Object(body))
            .await
            .map_err(internal_error)?;
        serde_json::from_value(resp).map_err(internal_error)
    }
}

#[async_trait]
impl OpenSearchPort for OpenSearchClient {
    async fn search(&self, index: &str, body: &Value) -> Result<Value, CoreError> {
        let idx = (!index.is_empty()).then_some(index);
        OpenSearchClient::search(self, idx, body)
            .await
            .map_err(internal_error)
    }
}

#[async_trait]
impl VectorizePort for VectorizeClient {
    async fn query_natural_language(
        &self,
        query: &str,
        top_k: usize,
    ) -> Result<Vec<CoreVectorizeOfferMatch>, CoreError> {
        let matches = self
            .query_offers_with_natural_language(query, top_k)
            .await
            .map_err(vectorize_core_error)?;
        Ok(matches
            .into_iter()
            .map(|m| CoreVectorizeOfferMatch {
                id: m.id,
                score: m.score,
                metadata: m.metadata.map(|map| map.into_iter().collect()),
            })
            .collect())
    }
}

#[async_trait]
impl EpicStorePort for EpicStoreClient {
    async fn token_account(&self, token: &str) -> Result<Option<String>, CoreError> {
        Ok(self.token_info_account(token).await)
    }
    async fn graphql(&self, query: &str, variables: &Value) -> Result<Value, CoreError> {
        self.graphql_raw(query, variables)
            .await
            .map_err(internal_error)
    }

    async fn get_user(&self, account_id: &str) -> Result<Option<Value>, CoreError> {
        Ok(EpicStoreClient::get_user(self, account_id).await)
    }

    async fn featured_games(&self) -> Result<Vec<Value>, CoreError> {
        self.featured_offer_documents()
            .await
            .map_err(internal_error)
    }
}

fn map_job_type(job_type: CoreJobApiJobType) -> InfraJobApiJobType {
    match job_type {
        CoreJobApiJobType::OfferRegen => InfraJobApiJobType::OfferRegen,
        CoreJobApiJobType::ItemRegen => InfraJobApiJobType::ItemRegen,
        CoreJobApiJobType::AchievementRefresh => InfraJobApiJobType::AchievementRefresh,
    }
}

#[async_trait]
impl JobApiPort for JobApiClient {
    async fn submit(
        &self,
        job_type: CoreJobApiJobType,
        payload: &Value,
        request_id: Option<&str>,
    ) -> Result<AcceptedJobSubmission, CoreError> {
        let opts = JobApiRequestOptions {
            request_id: request_id.map(str::to_string),
            ..JobApiRequestOptions::default()
        };
        let accepted = self
            .submit_request(map_job_type(job_type), payload, &opts)
            .await
            .map_err(internal_error)?;
        Ok(AcceptedJobSubmission {
            job_id: accepted.job_id,
            workflow_id: accepted.workflow_id,
            status_url: accepted.status_url,
            deduplicated: accepted.deduplicated,
        })
    }

    async fn submit_batch(
        &self,
        job_type: CoreJobApiJobType,
        payloads: &[Value],
        request_id: Option<&str>,
    ) -> Result<Vec<AcceptedJobSubmission>, CoreError> {
        let opts = JobApiBatchOptions {
            request_options: JobApiRequestOptions {
                request_id: request_id.map(str::to_string),
                ..JobApiRequestOptions::default()
            },
            ..JobApiBatchOptions::default()
        };
        let accepted = JobApiClient::submit_batch(self, map_job_type(job_type), payloads, &opts)
            .await
            .map_err(internal_error)?;
        Ok(accepted
            .into_iter()
            .map(|a| AcceptedJobSubmission {
                job_id: a.job_id,
                workflow_id: a.workflow_id,
                status_url: a.status_url,
                deduplicated: a.deduplicated,
            })
            .collect())
    }
}

#[async_trait]
impl DiscordPort for DiscordRestClient {
    async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, CoreError> {
        let http_method = Method::from_bytes(method.as_bytes())
            .map_err(|e| CoreError::InvalidInput(format!("Invalid HTTP method: {e}")))?;
        DiscordRestClient::request(self, http_method, path, body)
            .await
            .map_err(internal_error)
    }
}

#[async_trait]
impl TelegramPort for TelegramBotService {
    async fn send_message(&self, message: &str) -> Result<(), CoreError> {
        self.try_send_message(message).await.map_err(internal_error)
    }
}

#[async_trait]
impl GaPort for GaClient {
    async fn send_measurement(&self, body: &Value) -> Result<(), CoreError> {
        self.try_send_measurement(body).await.map_err(ga_error)
    }
    async fn track(&self, event: &GaTrackEvent) -> Result<(), CoreError> {
        let opts = GaTrackOptions {
            event: event.event.clone(),
            location: event.location.clone(),
            params: event
                .params
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            session: GaSession {
                id: event.session_id.clone(),
                started_at: event.session_started_at,
                last_active_at: event.session_last_active_at,
            },
            user_id: event.user_id.clone(),
        };
        self.try_track(&opts).await.map_err(ga_error)
    }
}

fn ga_error(error: NotificationError) -> CoreError {
    match error {
        NotificationError::Configuration(msg) => CoreError::InvalidInput(msg),
        other => CoreError::Internal(other.to_string()),
    }
}

#[async_trait]
impl WebPushPort for VapidWebPushClient {
    async fn send_notification(
        &self,
        subscription: &Value,
        payload: &[u8],
    ) -> Result<(), CoreError> {
        let obj = subscription
            .as_object()
            .ok_or_else(|| CoreError::InvalidInput("Subscription must be a JSON object".into()))?;
        let id = obj
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let endpoint = obj
            .get("endpoint")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| CoreError::InvalidInput("Missing subscription endpoint".into()))?
            .to_string();
        let keys = obj
            .get("keys")
            .and_then(Value::as_object)
            .ok_or_else(|| CoreError::InvalidInput("Missing subscription keys".into()))?;
        let p256dh = keys
            .get("p256dh")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| CoreError::InvalidInput("Missing p256dh key".into()))?
            .to_string();
        let auth = keys
            .get("auth")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| CoreError::InvalidInput("Missing auth key".into()))?
            .to_string();

        let target = PushSubscriptionTarget {
            id,
            endpoint,
            keys: PushSubscriptionKeys { p256dh, auth },
        };
        match WebPushDispatcher::send_notification(self, &target, payload).await {
            PushSendOutcome::Sent { .. } => Ok(()),
            PushSendOutcome::Expired { .. } => {
                Err(CoreError::NotFound("Push subscription expired".into()))
            }
            PushSendOutcome::Failed { error, .. } => Err(CoreError::Internal(error)),
        }
    }
}

/// Concrete `OgRendererPort` adapter powered by native `takumi`.
#[derive(Debug, Default, Clone, Copy)]
pub struct TakumiOgRenderer;

impl TakumiOgRenderer {
    pub fn new() -> Self {
        Self
    }

    fn image_http() -> &'static reqwest::Client {
        static HTTP: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
        HTTP.get_or_init(reqwest::Client::new)
    }
}

#[async_trait]
impl OgRendererPort for TakumiOgRenderer {
    async fn render_editorial(
        &self,
        html: &str,
        template: egdata_core::ports::EditorialOgTemplate,
    ) -> Result<Vec<u8>, CoreError> {
        render_editorial_html(html, template, Self::image_http())
            .await
            .map_err(internal_error)
    }
    async fn render_image(
        &self,
        html: &str,
        width: u32,
        height: u32,
        format: CoreOgImageFormat,
    ) -> Result<Vec<u8>, CoreError> {
        let infra_fmt = match format {
            CoreOgImageFormat::Png => InfraOgImageFormat::Png,
            CoreOgImageFormat::Webp => InfraOgImageFormat::Webp,
        };
        render_html_to_image(html, (width, height), infra_fmt, HashMap::new())
            .map_err(internal_error)
    }

    async fn render_image_with_cover(
        &self,
        html_with_cover: &str,
        html_without_cover: &str,
        cover_url: Option<&str>,
        width: u32,
        height: u32,
        format: CoreOgImageFormat,
    ) -> Result<Vec<u8>, CoreError> {
        let infra_fmt = match format {
            CoreOgImageFormat::Png => InfraOgImageFormat::Png,
            CoreOgImageFormat::Webp => InfraOgImageFormat::Webp,
        };
        if let Some(bytes) = fetch_og_cover(cover_url, Self::image_http())
            .await
            .filter(|bytes| og_cover_bytes_are_renderable(bytes))
        {
            let images = cover_url
                .map(|url| vec![(std::sync::Arc::<str>::from(url), bytes)])
                .unwrap_or_default();
            return render_html_to_image_with_image_bytes(
                html_with_cover,
                (width, height),
                infra_fmt,
                images,
            )
            .map_err(internal_error);
        }
        render_html_to_image(
            html_without_cover,
            (width, height),
            infra_fmt,
            HashMap::new(),
        )
        .map_err(internal_error)
    }
}

#[async_trait]
impl<S: CatalogMongoDataSource + 'static> CatalogHydrationResolverPort
    for MongoCatalogHydrationResolver<S>
{
    async fn resolve(&self, request: &Value) -> Result<Vec<Value>, CoreError> {
        let parsed: CatalogHydrationRequest = serde_json::from_value(request.clone())
            .map_err(|e| CoreError::InvalidInput(format!("Invalid hydration request: {e}")))?;
        let mut lines = Vec::with_capacity(parsed.identifiers.len());
        for identifier in parsed.identifiers.clone() {
            let root_result =
                MongoCatalogHydrationResolver::resolve(self, identifier, &parsed).await;
            lines.push(json!(root_result));
        }
        Ok(lines)
    }
}

/// Concrete [`UpstreamHttpPort`] backed by `reqwest::Client`.
#[derive(Clone, Default)]
pub struct ReqwestUpstreamHttpClient {
    http: reqwest::Client,
}

impl ReqwestUpstreamHttpClient {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl UpstreamHttpPort for ReqwestUpstreamHttpClient {
    async fn send(&self, request: UpstreamHttpRequest) -> Result<UpstreamHttpResponse, CoreError> {
        let method = Method::from_bytes(request.method.as_bytes()).map_err(|_| {
            CoreError::InvalidInput(format!("Invalid HTTP method: {}", request.method))
        })?;
        let mut builder = self.http.request(method, &request.url);
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        if let Some(file) = request.multipart_file {
            let part = reqwest::multipart::Part::bytes(file.bytes)
                .file_name(file.filename)
                .mime_str(&file.content_type)
                .map_err(|e| CoreError::InvalidInput(e.to_string()))?;
            let form = reqwest::multipart::Form::new().part(file.field_name, part);
            builder = builder.multipart(form);
        } else if let Some(body) = request.body {
            builder = builder.body(body);
        }
        let response = builder
            .send()
            .await
            .map_err(|e| CoreError::Upstream(e.to_string()))?;
        let status = response.status().as_u16();
        let body = response
            .bytes()
            .await
            .map_err(|e| CoreError::Upstream(e.to_string()))?
            .to_vec();
        Ok(UpstreamHttpResponse { status, body })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_error_kind(actual: CoreError, variant: fn(String) -> CoreError) {
        assert_eq!(
            std::mem::discriminant(&actual),
            std::mem::discriminant(&variant(String::new())),
            "{actual}"
        );
    }

    #[test]
    fn vectorize_adapter_preserves_configuration_and_cloudflare_error_kinds() {
        assert!(matches!(
            vectorize_core_error(crate::search_clients::SearchClientError::VectorizeConfiguration("missing token".into())),
            CoreError::InvalidInput(message) if message == "missing token"
        ));
        assert!(matches!(
            vectorize_core_error(crate::search_clients::SearchClientError::CloudflareVectorize { message: "upstream failed".into(), status: Some(503) }),
            CoreError::Upstream(message) if message == "upstream failed"
        ));
    }
    use std::sync::{Arc, Mutex};

    use base64::{
        Engine as _,
        engine::general_purpose::{STANDARD as BASE64_STANDARD, URL_SAFE_NO_PAD},
    };
    use bson::{Document, doc};
    use chrono::{TimeZone, Utc};
    use hmac::{Hmac, Mac};
    use mongodb::Client as MongoClient;
    use redis::Value as RedisValue;
    use sha2::Sha256;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn takumi_og_renderer_fetches_cover_once_and_falls_back_without_cover() {
        let cover = include_bytes!("../../egdata-api/tests/fixtures/og-parity-cover.png");
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let body = cover.to_vec();
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0u8; 1024];
                let n = socket.read(&mut request).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&request[..n]);
                let response = if request.starts_with("GET /cover ") {
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    )
                } else {
                    "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        .to_string()
                };
                let _ = socket.write_all(response.as_bytes()).await;
                if request.starts_with("GET /cover ") {
                    let _ = socket.write_all(&body).await;
                }
            }
        });
        let renderer = TakumiOgRenderer::new();
        let with_cover = format!(
            "<div style='width:40px;height:40px;overflow:hidden'><img src='http://{addr}/cover' style='width:40px;height:40px;object-fit:cover'/></div>"
        );
        let without_cover = "<div style='width:40px;height:40px;background:#00162D'></div>";
        let rendered = OgRendererPort::render_image_with_cover(
            &renderer,
            &with_cover,
            without_cover,
            Some(&format!("http://{addr}/cover")),
            40,
            40,
            CoreOgImageFormat::Png,
        )
        .await
        .unwrap();
        assert!(rendered.starts_with(b"\x89PNG"));
        let fallback = OgRendererPort::render_image_with_cover(
            &renderer,
            &with_cover,
            without_cover,
            Some(&format!("http://{addr}/missing")),
            40,
            40,
            CoreOgImageFormat::Png,
        )
        .await
        .unwrap();
        server.await.unwrap();
        assert!(fallback.starts_with(b"\x89PNG"));
        assert_ne!(
            rendered, fallback,
            "failed fetch must render canonical no-cover HTML"
        );
    }
    use web_push::{WebPushClient, WebPushError, WebPushMessage, request_builder};

    use crate::auth_pg::{AuthSessionRecord, AuthUserRecord};
    use crate::catalog_mongo::{CatalogMongoError, MongoDatabaseSource};
    use crate::job_api::JobApiClientConfig;
    use crate::mongo::MongoConfig;
    use crate::notifications::VapidConfig;
    use crate::redis_store::{RedisBackend, RedisStoreError};
    use crate::search_clients::{MeilisearchConfig, OpenSearchConfig, VectorizeConfig};

    type HmacSha256 = Hmac<Sha256>;

    struct FixtureListener {
        address: std::net::SocketAddr,
        stop: tokio::sync::oneshot::Sender<()>,
        task: tokio::task::JoinHandle<()>,
    }
    impl FixtureListener {
        async fn start<H, F>(mut accept: H) -> Self
        where
            H: FnMut(tokio::net::TcpStream) -> F + Send + 'static,
            F: std::future::Future<Output = ()> + Send + 'static,
        {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let (stop, mut shutdown) = tokio::sync::oneshot::channel();
            let task = tokio::spawn(async move {
                loop {
                    let socket = tokio::select! {
                        _=&mut shutdown=>break,
                        result=listener.accept()=>result.unwrap().0,
                    };
                    tokio::spawn(accept(socket));
                }
            });
            Self {
                address,
                stop,
                task,
            }
        }
        async fn stop(self) {
            self.stop.send(()).unwrap();
            self.task.await.unwrap();
        }
    }

    // The current MongoDB driver uses OP_MSG, including for the handshake.
    async fn spawn_mock_mongo_server(fail_commands: bool) -> (String, FixtureListener) {
        let distinct_calls =
            std::sync::Arc::new(std::sync::Mutex::new(HashMap::<String, i32>::new()));
        let fixture=FixtureListener::start(move |mut socket| {
          let distinct_calls = distinct_calls.clone();
          async move {
                    let mut hdr=[0;16];
                    while socket.read_exact(&mut hdr).await.is_ok() {
                        let msg_len = i32::from_le_bytes(hdr[0..4].try_into().unwrap()) as usize;
                        let req_id = i32::from_le_bytes(hdr[4..8].try_into().unwrap());
                        let op_code = i32::from_le_bytes(hdr[12..16].try_into().unwrap());
                        let mut payload = vec![0u8; msg_len - 16];
                        socket.read_exact(&mut payload).await.unwrap();

                        assert_eq!(op_code, 2013);
                        let cmd_doc =
                            Document::from_reader(&mut std::io::Cursor::new(&payload[5..]))
                                .unwrap();
                        let reply_doc = if cmd_doc.contains_key("hello")
                            || cmd_doc.contains_key("ismaster")
                            || cmd_doc.contains_key("isMaster")
                        {
                            doc! {
                                "ok": 1.0,
                                "isWritablePrimary": true,
                                "maxBsonObjectSize": 16_777_216_i32,
                                "maxMessageSizeBytes": 48_000_000_i32,
                                "maxWriteBatchSize": 100_000_i32,
                                "minWireVersion": 0_i32,
                                "maxWireVersion": 21_i32,
                            }
                        } else if cmd_doc.contains_key("getMore") {
                            doc! {"ok":0.,"errmsg":"fixture cursor stopped","code":43}
                        } else if cmd_doc.get_str("find") == Ok("paged")
                            || cmd_doc.get_str("aggregate") == Ok("paged")
                        {
                            doc! {"ok":1.,"cursor":{"id":17_i64,"ns":"egdata.paged","firstBatch":[{"id":"first"}]}}
                        } else if fail_commands {
                            doc! { "ok": 0.0, "errmsg": "forced failure", "code": 1_i32 }
                        } else if cmd_doc.get_str("find") == Ok("options_probe") {
                            doc! { "ok": 1.0, "cursor": {
                                "id": 0_i64, "ns": "egdata.options_probe", "firstBatch": [cmd_doc]
                            }}
                        } else if cmd_doc.contains_key("find") || cmd_doc.contains_key("aggregate")
                        {
                            doc! {
                                "ok": 1.0,
                                "cursor": {
                                    "id": 0_i64,
                                    "ns": "egdata.offers",
                                    "firstBatch": [{ "id": "o1", "namespace": "ns1", "title": "Game", "n": 2_i64 }]
                                }
                            }
                        } else if cmd_doc.contains_key("distinct") {
                            let name = cmd_doc.get_str("distinct").unwrap();
                            let mut counts = distinct_calls.lock().unwrap();
                            let count = counts.entry(name.to_owned()).or_default();
                            *count += 1;
                            match name {
                                "retry-once" | "no-retry" if *count == 1 => doc!{"ok":0.0,"code":134,"errmsg":"fixture read concern unavailable"},
                                "retry-once" | "no-retry" | "single-reply" => doc!{"ok":1.0,"values":[{"$date":"2024-01-01"},*count]},
                                "no-values" => doc!{"ok":1.0},
                                _ => doc! { "ok": 1.0, "values": ["v1", "v2"] },
                            }
                        } else if cmd_doc.contains_key("update") {
                            doc! { "ok": 1.0, "n": 1_i32, "nModified": 1_i32 }
                        } else {
                            doc! { "ok": 1.0, "n": 1_i32 }
                        };

                        let mut doc_bytes = Vec::new();
                        reply_doc.to_writer(&mut doc_bytes).unwrap();
                        let mut resp = Vec::new();
                        let total_len = (16 + 5 + doc_bytes.len()) as i32;
                        resp.extend_from_slice(&total_len.to_le_bytes());
                        resp.extend_from_slice(&1_i32.to_le_bytes());
                        resp.extend_from_slice(&req_id.to_le_bytes());
                        resp.extend_from_slice(&2013_i32.to_le_bytes()); // OP_MSG
                        resp.extend_from_slice(&0_u32.to_le_bytes());
                        resp.push(0); // section kind 0
                        resp.extend_from_slice(&doc_bytes);
                        socket.write_all(&resp).await.unwrap();
                    }
        }}).await;
        (
            format!("mongodb://{}/?directConnection=true", fixture.address),
            fixture,
        )
    }

    #[derive(Default)]
    struct PortMockRedis {
        kv: Mutex<HashMap<String, String>>,
        hash: Mutex<HashMap<String, String>>,
        fail: Mutex<bool>,
    }

    #[async_trait]
    impl RedisBackend for PortMockRedis {
        async fn get(&self, key: &str) -> Result<Option<String>, RedisStoreError> {
            if *self.fail.lock().unwrap() {
                return Err(RedisStoreError::UnexpectedResponse("fail".into()));
            }
            Ok(self.kv.lock().unwrap().get(key).cloned())
        }
        async fn set_ex(&self, key: &str, value: &str, _ttl: u64) -> Result<bool, RedisStoreError> {
            if *self.fail.lock().unwrap() {
                return Err(RedisStoreError::UnexpectedResponse("fail".into()));
            }
            self.kv
                .lock()
                .unwrap()
                .insert(key.to_string(), value.to_string());
            Ok(true)
        }
        async fn set_px(
            &self,
            key: &str,
            value: &str,
            _ttl: u64,
            nx: bool,
        ) -> Result<bool, RedisStoreError> {
            let mut values = self.kv.lock().unwrap();
            if nx && values.contains_key(key) {
                return Ok(false);
            }
            values.insert(key.to_string(), value.to_string());
            Ok(true)
        }
        async fn decr(&self, key: &str) -> Result<i64, RedisStoreError> {
            let mut values = self.kv.lock().unwrap();
            let previous = values
                .get(key)
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(0);
            values.insert(key.into(), (previous - 1).to_string());
            Ok(previous - 1)
        }
        async fn del(&self, key: &str) -> Result<usize, RedisStoreError> {
            if *self.fail.lock().unwrap() {
                return Err(RedisStoreError::UnexpectedResponse("fail".into()));
            }
            Ok(usize::from(self.kv.lock().unwrap().remove(key).is_some()))
        }
        async fn pttl(&self, _key: &str) -> Result<i64, RedisStoreError> {
            Ok(5000)
        }
        async fn hgetall(&self, _key: &str) -> Result<HashMap<String, String>, RedisStoreError> {
            if *self.fail.lock().unwrap() {
                return Err(RedisStoreError::UnexpectedResponse("fail".into()));
            }
            Ok(self.hash.lock().unwrap().clone())
        }
        async fn ping(&self) -> Result<bool, RedisStoreError> {
            if *self.fail.lock().unwrap() {
                return Err(RedisStoreError::UnexpectedResponse("fail".into()));
            }
            Ok(true)
        }
        async fn eval_script(
            &self,
            script: &str,
            _keys: &[&str],
            args: &[&str],
        ) -> Result<RedisValue, RedisStoreError> {
            if *self.fail.lock().unwrap() {
                return Err(RedisStoreError::UnexpectedResponse("fail".into()));
            }
            if script == crate::redis_store::INCREMENT_SCRIPT {
                return Ok(RedisValue::Array(vec![
                    RedisValue::Int(1),
                    RedisValue::Int(5000),
                ]));
            }
            let events = if script == crate::redis_store::APPEND_WINDOW_SCRIPT {
                vec![RedisValue::BulkString(args[0].as_bytes().to_vec())]
            } else {
                Vec::new()
            };
            Ok(RedisValue::Array(vec![
                RedisValue::Array(events),
                RedisValue::Int(0),
            ]))
        }
    }

    struct MockSessionRepo(Option<BetterAuthSession>);

    #[async_trait]
    impl SessionRepository for MockSessionRepo {
        async fn linked_epic_account(
            &self,
            _session: &BetterAuthSession,
        ) -> Result<Option<String>, crate::auth_pg::AuthPgError> {
            Ok(Some("linked-epic".into()))
        }

        async fn find_session_by_token(
            &self,
            _token: &str,
        ) -> Result<Option<BetterAuthSession>, crate::auth_pg::AuthPgError> {
            Ok(self.0.clone())
        }
    }

    struct MockMongoCatalogSource;

    #[async_trait]
    impl CatalogMongoDataSource for MockMongoCatalogSource {
        async fn find_one(
            &self,
            _c: &str,
            _f: Document,
        ) -> Result<Option<Document>, CatalogMongoError> {
            if _c == "items" && _f.get_str("id") == Ok("fixture") {
                Ok(Some(doc! {"id":"fixture","namespace":"sandbox"}))
            } else {
                Ok(None)
            }
        }
        async fn find_limited(
            &self,
            _c: &str,
            _f: Document,
            _l: i64,
        ) -> Result<Vec<Document>, CatalogMongoError> {
            Ok(vec![])
        }
        async fn create_index(
            &self,
            _c: &str,
            _k: Document,
            _n: &str,
            _b: bool,
        ) -> Result<(), CatalogMongoError> {
            Ok(())
        }
    }

    struct MockPushTransport(&'static str);

    #[async_trait]
    impl WebPushClient for MockPushTransport {
        async fn send(&self, _m: WebPushMessage) -> Result<(), WebPushError> {
            match self.0 {
                "ok" => Ok(()),
                "gone" => request_builder::parse_response(410u16.try_into().unwrap(), Vec::new()),
                _ => Err(WebPushError::InvalidResponse),
            }
        }
    }

    async fn spawn_http_router<F>(handler: F) -> (String, FixtureListener)
    where
        F: Fn(String, String, String) -> (u16, String) + Send + Sync + 'static,
    {
        let handler = Arc::new(handler);
        let server=FixtureListener::start(move |mut socket|{
            let handler=handler.clone();
            async move {
                    let mut buf = vec![0u8; 32768];
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let first = req.lines().next().unwrap_or_default().to_string();
                    let mut parts = first.split_whitespace();
                    let method = parts.next().unwrap_or("GET").to_string();
                    let path = parts.next().unwrap_or("/").to_string();
                    let body = req.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
                    let (status, resp_body) = handler(method, path, body);
                    let resp = format!(
                        "HTTP/1.1 {status} Status\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{resp_body}",
                        resp_body.len()
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
            }
        }).await;
        (format!("http://{}", server.address), server)
    }

    #[tokio::test]
    async fn mongo_store_adapter_and_mongo_db_source_against_mock_wire_server() {
        let (uri, server) = spawn_mock_mongo_server(false).await;
        let client = MongoClient::with_uri_str(&uri).await.unwrap();
        let db = client.database("egdata");

        // Cover `mongodb+srv://` branch of `MongoConfig::connection_uri`
        let srv_cfg = MongoConfig {
            url: "mongodb+srv://cluster.example.mongodb.net/egdata".into(),
            ca_path: "/tmp/ca.pem".into(),
            cert_path: "/tmp/cert.pem".into(),
            database_name: "egdata".into(),
        };
        assert_eq!(
            srv_cfg.connection_uri(),
            "mongodb+srv://cluster.example.mongodb.net/egdata"
        );

        let adapter = MongoStoreAdapter::new(db.clone());
        for (collection, calls) in [("single-reply", 1), ("retry-once", 2)] {
            let values = adapter
                .distinct(collection, "value", doc! {})
                .await
                .unwrap();
            assert_eq!(
                values,
                [
                    Bson::Document(doc! {"$date":"2024-01-01"}),
                    Bson::Int32(calls)
                ]
            );
        }
        let single_attempt = MongoStoreAdapter::configured(db.clone(), false);
        assert!(
            single_attempt
                .distinct("no-retry", "value", doc! {})
                .await
                .is_err()
        );
        assert!(
            adapter
                .distinct("no-values", "value", doc! {})
                .await
                .is_err()
        );
        assert!(
            adapter
                .find_many("paged", doc! {}, Default::default())
                .await
                .unwrap_err()
                .to_string()
                .contains("fixture cursor stopped")
        );
        assert!(
            adapter
                .aggregate("paged", vec![])
                .await
                .unwrap_err()
                .to_string()
                .contains("fixture cursor stopped")
        );
        let mut cursor = adapter
            .find_stream("paged", doc! {}, Default::default())
            .await
            .unwrap();
        assert_eq!(
            cursor.try_next().await.unwrap().unwrap().get_str("id"),
            Ok("first")
        );
        assert!(
            cursor
                .try_next()
                .await
                .unwrap_err()
                .to_string()
                .contains("fixture cursor stopped")
        );
        assert!(adapter.count_documents_with_options("offers",doc!{},Some(doc!{"maxTimeMS":300_i64,"collation":{"locale":"en","numericOrdering":true}})).await.is_ok());
        assert_error_kind(
            (adapter
                .count_documents_with_options("offers", doc! {}, Some(doc! {"collation":"invalid"}))
                .await)
                .unwrap_err(),
            CoreError::InvalidInput,
        );
        for read in [
            adapter
                .find_many(
                    "offers",
                    doc! {},
                    MongoFindOptions {
                        collation: Some(doc! {"locale":12}),
                        ..Default::default()
                    },
                )
                .await
                .map(|_| ()),
            adapter
                .find_one_with_options(
                    "offers",
                    doc! {},
                    MongoFindOptions {
                        collation: Some(doc! {"locale":12}),
                        ..Default::default()
                    },
                )
                .await
                .map(|_| ()),
            adapter
                .find_stream(
                    "offers",
                    doc! {},
                    MongoFindOptions {
                        collation: Some(doc! {"locale":12}),
                        ..Default::default()
                    },
                )
                .await
                .map(|_| ()),
            adapter
                .aggregate_with_options(
                    "offers",
                    vec![],
                    egdata_core::ports::MongoAggregateOptions {
                        collation: Some(doc! {"locale":12}),
                        ..Default::default()
                    },
                )
                .await
                .map(|_| ()),
        ] {
            assert_error_kind((read).unwrap_err(), CoreError::InvalidInput);
        }
        let options = doc! {"skip":f64::NAN,"limit":2147483648_f64,"singleBatch":true,"sort":{"timestamp":-1},"collation":{"locale":"en","strength":1}};
        let wire = adapter
            .find_many_with_raw_page("options_probe", doc! {"id":"raw"}, options)
            .await
            .unwrap()
            .remove(0);
        assert!(wire.get_f64("skip").unwrap().is_nan());
        assert_eq!(wire.get_f64("limit"), Ok(2147483648.));
        assert_eq!(wire.get_bool("singleBatch"), Ok(true));
        assert_eq!(wire.get_document("filter"), Ok(&doc! {"id":"raw"}));
        assert_eq!(wire.get_document("sort"), Ok(&doc! {"timestamp":-1}));
        assert_eq!(
            wire.get_document("collation"),
            Ok(&doc! {"locale":"en","strength":1})
        );
        assert!(
            adapter
                .find_many_with_raw_page("paged", doc! {}, doc! {"limit":f64::NAN})
                .await
                .unwrap_err()
                .to_string()
                .contains("fixture cursor stopped")
        );
        let sorted_read = adapter
            .find_one_with_options(
                "options_probe",
                doc! {"offerId":"a"},
                MongoFindOptions {
                    sort: Some(doc! {"updatedAt":-1}),
                    projection: Some(doc! {"price":1}),
                    collation: Some(doc! {"locale":"en","strength":1}),
                    skip: Some(2),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            sorted_read.get_document("filter").unwrap(),
            &doc! {"offerId":"a"}
        );
        assert_eq!(
            sorted_read.get_document("sort").unwrap(),
            &doc! {"updatedAt":-1}
        );
        assert_eq!(
            sorted_read.get_document("projection").unwrap(),
            &doc! {"price":1}
        );
        assert_eq!(
            sorted_read.get_document("collation").unwrap(),
            &doc! {"locale":"en","strength":1}
        );
        assert_eq!(sorted_read.get_i64("skip"), Ok(2));
        assert!(MongoStorePort::ping(&adapter).await.unwrap());
        assert!(
            MongoStorePort::find_one(&adapter, "offers", doc! {}, None)
                .await
                .unwrap()
                .is_some()
        );
        let many = MongoStorePort::find_many(
            &adapter,
            "offers",
            doc! {},
            MongoFindOptions {
                projection: Some(doc! { "id": 1 }),
                sort: Some(doc! { "id": 1 }),
                collation: None,
                skip: Some(0),
                limit: Some(10),
            },
        )
        .await
        .unwrap();
        assert_eq!(many.len(), 1);
        let streamed = MongoStorePort::find_stream(
            &adapter,
            "offers",
            doc! {},
            MongoFindOptions {
                projection: Some(doc! {"id":1}),
                sort: Some(doc! {"id":1}),
                collation: None,
                skip: Some(0),
                limit: Some(10),
            },
        )
        .await
        .unwrap()
        .try_collect::<Vec<_>>()
        .await
        .unwrap();
        assert_eq!(streamed, many);
        assert_eq!(
            MongoStorePort::aggregate(&adapter, "offers", vec![doc! { "$match": {} }])
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            MongoStorePort::count_documents(&adapter, "offers", doc! {})
                .await
                .unwrap(),
            2
        );
        assert_eq!(
            MongoStorePort::distinct(&adapter, "offers", "id", doc! {})
                .await
                .unwrap()
                .len(),
            2
        );
        MongoStorePort::insert_one(&adapter, "offers", doc! { "id": "x" })
            .await
            .unwrap();
        assert_eq!(
            MongoStorePort::update_one(
                &adapter,
                "offers",
                doc! {},
                doc! { "$set": { "a": 1 } },
                true
            )
            .await
            .unwrap(),
            1
        );
        assert_eq!(
            MongoStorePort::delete_one(&adapter, "offers", doc! {})
                .await
                .unwrap(),
            1
        );

        // Cover MongoDatabaseSource success paths from catalog_mongo.rs
        let catalog_src = MongoDatabaseSource::new(db);
        assert!(
            catalog_src
                .find_one("offers", doc! {})
                .await
                .unwrap()
                .is_some()
        );
        assert_eq!(
            catalog_src
                .find_limited("offers", doc! {}, 5)
                .await
                .unwrap()
                .len(),
            1
        );
        catalog_src
            .create_index("offers", doc! { "id": 1 }, "idx_id", true)
            .await
            .unwrap();

        // Error path against failing Mongo wire server
        let (err_uri, error_server) = spawn_mock_mongo_server(true).await;
        let err_client = MongoClient::with_uri_str(&err_uri).await.unwrap();
        let err_adapter = MongoStoreAdapter::new(err_client.database("egdata"));
        assert!(MongoStorePort::ping(&err_adapter).await.is_err());
        assert!(
            err_adapter
                .find_one_with_options("offers", doc! {}, Default::default())
                .await
                .is_err()
        );
        assert!(
            err_adapter
                .count_documents_with_options("offers", doc! {}, None)
                .await
                .is_err()
        );
        assert!(
            err_adapter
                .find_many_with_raw_page("offers", doc! {}, doc! {"limit":f64::NAN})
                .await
                .is_err()
        );
        assert!(
            MongoStorePort::find_stream(
                &err_adapter,
                "offers",
                doc! {},
                MongoFindOptions::default()
            )
            .await
            .is_err()
        );
        assert!(
            MongoStorePort::find_one(&err_adapter, "offers", doc! {}, None)
                .await
                .is_err()
        );
        assert!(
            MongoStorePort::find_many(&err_adapter, "offers", doc! {}, MongoFindOptions::default())
                .await
                .is_err()
        );
        assert!(
            MongoStorePort::aggregate(&err_adapter, "offers", vec![])
                .await
                .is_err()
        );
        assert!(
            MongoStorePort::count_documents(&err_adapter, "offers", doc! {})
                .await
                .is_err()
        );
        assert!(
            MongoStorePort::distinct(&err_adapter, "offers", "id", doc! {})
                .await
                .is_err()
        );
        assert!(
            MongoStorePort::insert_one(&err_adapter, "offers", doc! {})
                .await
                .is_err()
        );
        assert!(
            MongoStorePort::update_one(
                &err_adapter,
                "offers",
                doc! {},
                doc! { "$set": { "a": 1 } },
                false
            )
            .await
            .is_err()
        );
        assert!(
            MongoStorePort::delete_one(&err_adapter, "offers", doc! {})
                .await
                .is_err()
        );
        drop(cursor);
        client.shutdown().immediate(true).await;
        err_client.shutdown().immediate(true).await;
        server.stop().await;
        error_server.stop().await;
    }

    #[tokio::test]
    async fn redis_and_auth_and_catalog_port_adapters() {
        let backend = Arc::new(PortMockRedis::default());
        let cache = ResponseCache::new("response:v2:", false, backend.clone());
        ResponseCachePort::set(&cache, "k1", "v1", 60)
            .await
            .unwrap();
        assert_eq!(
            ResponseCachePort::get(&cache, "k1")
                .await
                .unwrap()
                .as_deref(),
            Some("v1")
        );
        assert!(ResponseCachePort::ping(&cache).await.unwrap());
        assert!(ResponseCachePort::consume(&cache, "k1").await.unwrap());
        assert!(!ResponseCachePort::consume(&cache, "k1").await.unwrap());
        ResponseCachePort::del(&cache, "k1").await.unwrap();
        assert_eq!(ResponseCachePort::get(&cache, "k1").await.unwrap(), None);

        let limiter = RedisRateLimitStore::new(60_000, "api", backend.clone());
        let hit = RateLimitStorePort::increment(&limiter, "ns", "ip1", 60_000)
            .await
            .unwrap();
        assert_eq!(hit.total_hits, 1);
        let key = limiter.key("counter");
        assert!(backend.set_px(&key, "2", 5000, true).await.unwrap());
        assert!(!backend.set_px(&key, "3", 5000, true).await.unwrap());
        limiter.decrement("counter", 0).await;
        assert_eq!(limiter.get("counter", 0).await.unwrap().total_hits, 1);

        let risk = RedisRiskStore::new(backend.clone());
        let core_ev = CoreAbuseEvent {
            resource: CoreAbuseResource {
                route: "/offers".into(),
                page: Some(1),
                limit: Some(10),
                ..Default::default()
            },
            at: 1000,
            deep: true,
            support: false,
            resources: Some(vec![CoreAbuseResource {
                route: "/offers".into(),
                page: Some(2),
                limit: Some(5),
                ..Default::default()
            }]),
            mismatch: 0.0,
            trap: None,
            method: Some("GET".into()),
        };
        let risk_win = AbuseRiskStorePort::append(&risk, "fp1", &core_ev)
            .await
            .unwrap();
        assert!(!risk_win.trapped);
        assert_eq!(risk_win.events, vec![core_ev.clone()]);

        let summary = RedisSummaryStore::new(backend.clone());
        let mut vals = BTreeMap::new();
        vals.insert("k".into(), 1);
        AbuseSummaryStorePort::write(
            &summary,
            &[AbuseSummaryRow {
                minute: 1,
                values: vals,
            }],
        )
        .await
        .unwrap();

        let cohort = RedisCohortStore::new(backend.clone());
        backend
            .hash
            .lock()
            .unwrap()
            .insert("id1".into(), "{}".into());
        PowCohortStorePort::write(
            &cohort,
            &[PowCohortUpdate {
                day: 1,
                id: "id1".into(),
                first_challenge: 1,
                last_challenge: 1,
                last_puzzle: 0,
                last_solve: 0,
            }],
        )
        .await
        .unwrap();
        assert_eq!(
            PowCohortStorePort::read_day(&cohort, 1)
                .await
                .unwrap()
                .len(),
            1
        );

        let trial = RedisTrialStore::new(backend.clone());
        assert!(
            AbuseTrialStorePort::get_trial_raw(&trial)
                .await
                .unwrap()
                .is_none()
        );

        // Error mapping on Redis failure
        *backend.fail.lock().unwrap() = true;
        assert!(ResponseCachePort::get(&cache, "k1").await.is_err());
        assert!(
            ResponseCachePort::set(&cache, "k1", "v1", 60)
                .await
                .is_err()
        );
        assert!(ResponseCachePort::del(&cache, "k1").await.is_err());
        assert!(ResponseCachePort::consume(&cache, "k1").await.is_err());
        assert!(ResponseCachePort::ping(&cache).await.is_err());
        assert!(
            AbuseRiskStorePort::append(&risk, "fp1", &core_ev)
                .await
                .is_err()
        );
        assert!(
            AbuseSummaryStorePort::write(
                &summary,
                &[AbuseSummaryRow {
                    minute: 1,
                    values: BTreeMap::new()
                }]
            )
            .await
            .is_err()
        );
        assert!(PowCohortStorePort::read_day(&cohort, 1).await.is_err());
        assert!(AbuseTrialStorePort::get_trial_raw(&trial).await.is_err());
        assert_error_kind(
            core_err_from_redis(RedisStoreError::InvalidConfig("bad".into())),
            CoreError::InvalidInput,
        );

        // SessionVerifierPort
        let dt = Utc.with_ymd_and_hms(2026, 12, 1, 0, 0, 0).unwrap();
        let sess = BetterAuthSession {
            session: AuthSessionRecord {
                id: "s1".into(),
                expires_at: dt,
                token: "tok".into(),
                created_at: dt,
                updated_at: dt,
                ip_address: None,
                user_agent: None,
                user_id: "u1".into(),
            },
            user: AuthUserRecord {
                id: "u1".into(),
                name: "Alice".into(),
                email: "a@b.c".into(),
                email_verified: true,
                image: None,
                created_at: dt,
                updated_at: dt,
            },
        };
        let mut mac = HmacSha256::new_from_slice(b"secret").unwrap();
        mac.update(b"tok");
        let sig = BASE64_STANDARD.encode(mac.finalize().into_bytes());
        let verifier = BetterAuthVerifier::new("secret", MockSessionRepo(Some(sess)));
        let verified = SessionVerifierPort::verify_token(
            &verifier,
            &format!("better-auth.session_token=tok.{sig}"),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(verified.subject, "u1");
        let verified = verifier
            .verify_epic_session(&format!("better-auth.session_token=tok.{sig}"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(verified.claims["epicAccountId"], "linked-epic");
        assert!(verifier.verify_epic_session("").await.unwrap().is_none());

        // CatalogHydrationResolverPort
        crate::catalog_mongo::ensure_catalog_hydration_indexes(&MockMongoCatalogSource)
            .await
            .unwrap();
        let resolver = MongoCatalogHydrationResolver::new(MockMongoCatalogSource);
        assert!(
            CatalogHydrationResolverPort::resolve(&resolver, &json!({}))
                .await
                .is_err()
        );
        let lines = CatalogHydrationResolverPort::resolve(
            &resolver,
            &json!({
                "schemaVersion": 2,
                "identifiers": [{ "type": "item", "namespace": "ns", "id": "i1" }],
                "knownRoots": [],
                "knownRecords": []
            }),
        )
        .await
        .unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["status"], "not-found");
        let offers=CatalogHydrationResolverPort::resolve(&resolver,&json!({"schemaVersion":2,"identifiers":[{"type":"item","namespace":"sandbox","id":"fixture"}],"knownRoots":[],"knownRecords":[]})).await.unwrap();
        assert_eq!(offers.len(), 1);
    }

    #[tokio::test]
    async fn search_epic_job_notifications_and_og_port_adapters() {
        let (base,service_server) = spawn_http_router(|method, path, body| {
            if path == "/indexes/offers/search" && method == "POST" {
                (200, r#"{"hits":[{"id":"o1"}],"estimatedTotalHits":1,"processingTimeMs":2}"#.into())
            } else if path == "/egdata.offers/_search" {
                (200, r#"{"hits":{"hits":[]}}"#.into())
            } else if path.contains("/ai/run/") {
                (200, r#"{"success":true,"result":{"data":[[0.1,0.2]]}}"#.into())
            } else if path.contains("/vectorize/v2/indexes/") {
                (200, r#"{"success":true,"result":{"matches":[{"id":"o1","score":0.9,"metadata":{"a":1}}]}}"#.into())
            } else if path == "/graphql" {
                (200, r#"{"data":{"ok":true,"PlayerProfile":{"playerProfile":{"displayName":"Fixture"}}}}"#.into())
            } else if path=="/featured" {
                (200,r#"{"data":{"Storefront":{"storefrontModulesPaginated":{"modules":[{"id":"new-carousel-definitive","slides":[{"offer":{"id":"game","namespace":"fixture"}}]}]}}}}"#.into())
            } else if path == "/v1/jobs/offer-regens" || path == "/v1/jobs/item-regens" || path == "/v1/jobs/achievement-refreshes" {
                let jid = format!("api-offer-regen-{}", "a".repeat(64));
                (202, json!({"jobId": jid, "workflowId": jid, "statusUrl": "/s", "deduplicated": false}).to_string())
            } else if path == "/users/@me" {
                (200, r#"{"id":"bot"}"#.into())
            } else if path == "/bottg/sendMessage" {
                (200, r#"{"ok":true}"#.into())
            } else if path.starts_with("/mp/raw?") {
                assert_eq!(method, "POST");
                assert_eq!(path, "/mp/raw?measurement_id=G-1&api_secret=sec");
                assert_eq!(serde_json::from_str::<Value>(&body).unwrap(), json!({"events":[{"params":{"engagement_time_msec":null,"session_id":false}}],"user_id":47}));
                (204, String::new())
            } else if path.starts_with("/mp/collect") {
                (204, String::new())
            } else {
                (500, "err".into())
            }
        })
        .await;

        let meili = MeilisearchClient::new(MeilisearchConfig {
            host: base.clone(),
            api_key: "".into(),
        });
        let meili_res = MeiliSearchPort::search(
            &meili,
            "offers",
            &MeiliSearchQuery {
                q: "alan".into(),
                limit: Some(10),
                offset: Some(0),
                filter: Some("id = 1".into()),
                sort: Some(vec!["id:asc".into()]),
            },
        )
        .await
        .unwrap();
        assert_eq!(meili_res.hits.len(), 1);

        let os = OpenSearchClient::new(OpenSearchConfig {
            node: base.clone(),
            username: None,
            password: None,
        });
        assert!(
            OpenSearchPort::search(&os, "egdata.offers", &json!({}))
                .await
                .is_ok()
        );

        let vec = VectorizeClient::new(VectorizeConfig {
            account_id: "acc".into(),
            api_token: "tok".into(),
            index_name: "idx".into(),
            api_base: base.clone(),
            timeout_ms: 5000,
        })
        .unwrap();
        let hits = VectorizePort::query_natural_language(&vec, "cozy", 3)
            .await
            .unwrap();
        assert_eq!(hits[0].id, "o1");

        let epic = EpicStoreClient::with_urls(
            format!("{base}/graphql"),
            format!("{base}/featured"),
            format!("{base}/me"),
            reqwest::Client::new(),
        );
        assert_eq!(
            EpicStorePort::graphql(&epic, "query {}", &json!({}))
                .await
                .unwrap()["data"]["ok"],
            true
        );

        assert_eq!(
            EpicStorePort::get_user(&epic, "fixture")
                .await
                .unwrap()
                .unwrap()["displayName"],
            "Fixture"
        );
        assert_eq!(
            EpicStorePort::featured_games(&epic).await.unwrap(),
            vec![json!({"namespace":"fixture","id":"game"})]
        );

        let job = JobApiClient::new(JobApiClientConfig {
            base_url: base.clone(),
            key_id: "k1".into(),
            secret: "s".repeat(32),
        });
        assert!(
            JobApiPort::submit(
                &job,
                CoreJobApiJobType::OfferRegen,
                &json!({}),
                Some("req1")
            )
            .await
            .is_ok()
        );
        assert!(
            JobApiPort::submit(&job, CoreJobApiJobType::ItemRegen, &json!({}), None)
                .await
                .is_ok()
        );
        assert!(
            JobApiPort::submit(
                &job,
                CoreJobApiJobType::AchievementRefresh,
                &json!({}),
                None
            )
            .await
            .is_ok()
        );
        assert_eq!(
            JobApiPort::submit_batch(
                &job,
                CoreJobApiJobType::OfferRegen,
                &[json!({})],
                Some("r1")
            )
            .await
            .unwrap()
            .len(),
            1
        );

        let discord = DiscordRestClient::with_base_url(&base, "tok", reqwest::Client::new());
        assert_eq!(
            DiscordPort::request(&discord, "GET", "/users/@me", None)
                .await
                .unwrap()["id"],
            "bot"
        );
        assert!(
            DiscordPort::request(&discord, "BAD METHOD", "/users/@me", None)
                .await
                .is_err()
        );

        let tg = TelegramBotService::with_base_url(&base, "tg", "chat", reqwest::Client::new());
        TelegramPort::send_message(&tg, "hello").await.unwrap();

        let ga = GaClient::with_url(
            format!("{base}/mp/collect"),
            "G-1",
            Some("sec".into()),
            reqwest::Client::new(),
        );
        let mut params = BTreeMap::new();
        params.insert("k".into(), json!("v"));
        GaPort::track(
            &ga,
            &GaTrackEvent {
                event: "view".into(),
                location: "/".into(),
                params,
                session_id: "s1".into(),
                session_started_at: 1,
                session_last_active_at: 2,
                user_id: "u1".into(),
            },
        )
        .await
        .unwrap();

        let ga_bad = GaClient::with_url(
            "not-a-url",
            "G-1",
            Some("sec".into()),
            reqwest::Client::new(),
        );
        let raw_client = GaClient::with_url(
            format!("{base}/mp/raw"),
            "G-1",
            Some("sec".into()),
            reqwest::Client::new(),
        );
        GaPort::send_measurement(
            &raw_client,
            &json!({"events":[{"params":{"engagement_time_msec":null,"session_id":false}}],"user_id":47}),
        )
        .await
        .unwrap();
        assert_error_kind(
            (GaPort::track(
                &ga_bad,
                &GaTrackEvent {
                    event: "view".into(),
                    location: "/".into(),
                    params: BTreeMap::new(),
                    session_id: "s1".into(),
                    session_started_at: 1,
                    session_last_active_at: 2,
                    user_id: "u1".into(),
                },
            )
            .await)
                .unwrap_err(),
            CoreError::InvalidInput,
        );

        let ga_fail = GaClient::with_url(
            format!("{base}/fail"),
            "G-1",
            Some("sec".into()),
            reqwest::Client::new(),
        );
        assert_error_kind(
            (GaPort::track(
                &ga_fail,
                &GaTrackEvent {
                    event: "view".into(),
                    location: "/".into(),
                    params: BTreeMap::new(),
                    session_id: "s1".into(),
                    session_started_at: 1,
                    session_last_active_at: 2,
                    user_id: "u1".into(),
                },
            )
            .await)
                .unwrap_err(),
            CoreError::Internal,
        );

        let (failed, outage_server) =
            spawn_http_router(|_, _, _| (503, r#"{"error":"outage"}"#.into())).await;
        let job_fail = JobApiClient::new(JobApiClientConfig {
            base_url: failed.clone(),
            key_id: "fixture".into(),
            secret: "s".repeat(32),
        });
        assert!(
            JobApiPort::submit(&job_fail, CoreJobApiJobType::OfferRegen, &json!({}), None)
                .await
                .is_err()
        );
        assert!(
            JobApiPort::submit_batch(&job_fail, CoreJobApiJobType::ItemRegen, &[json!({})], None)
                .await
                .is_err()
        );
        let discord_fail =
            DiscordRestClient::with_base_url(&failed, "fixture", reqwest::Client::new());
        assert!(
            DiscordPort::request(&discord_fail, "GET", "/user", None)
                .await
                .is_err()
        );
        let telegram_fail =
            TelegramBotService::with_base_url(&failed, "fixture", "test", reqwest::Client::new());
        assert!(
            TelegramPort::send_message(&telegram_fail, "test")
                .await
                .is_err()
        );
        let epic_fail =
            EpicStoreClient::with_urls(&failed, &failed, &failed, reqwest::Client::new());
        let remote = EpicStorePort::graphql(&epic_fail, "query {}", &json!({}))
            .await
            .unwrap();
        assert_eq!(remote["error"], "outage");
        let bad_epic =
            EpicStoreClient::with_urls("invalid", "invalid", "invalid", reqwest::Client::new());
        assert!(
            EpicStorePort::graphql(&bad_epic, "query {}", &json!({}))
                .await
                .is_err()
        );
        assert!(EpicStorePort::featured_games(&epic_fail).await.is_err());
        let os_fail = OpenSearchClient::new(OpenSearchConfig {
            node: failed.clone(),
            username: None,
            password: None,
        });
        assert!(
            OpenSearchPort::search(&os_fail, "index", &json!({}))
                .await
                .is_err()
        );
        let meili_fail = MeilisearchClient::new(MeilisearchConfig {
            host: failed.clone(),
            api_key: "fixture".into(),
        });
        assert!(
            MeiliSearchPort::search(&meili_fail, "index", &MeiliSearchQuery::default())
                .await
                .is_err()
        );
        let vec_error = vectorize_core_error(
            crate::search_clients::SearchClientError::Configuration("fixture".into()),
        );
        assert_error_kind(vec_error, CoreError::Internal);

        let mut pub_bytes = vec![0x04u8];
        pub_bytes.extend_from_slice(&[
            0x6b, 0x17, 0xd1, 0xf2, 0xe1, 0x2c, 0x42, 0x47, 0xf8, 0xbc, 0xe6, 0xe5, 0x63, 0xa4,
            0x40, 0xf2, 0x77, 0x03, 0x7d, 0x81, 0x2d, 0xeb, 0x33, 0xa0, 0xf4, 0xa1, 0x39, 0x45,
            0xd8, 0x98, 0xc2, 0x96, 0x4f, 0xe3, 0x42, 0xe2, 0xfe, 0x1a, 0x7f, 0x9b, 0x8e, 0xe7,
            0xeb, 0x4a, 0x7c, 0x0f, 0x9e, 0x16, 0x2b, 0xce, 0x33, 0x57, 0x6b, 0x31, 0x5e, 0xce,
            0xcb, 0xb6, 0x40, 0x68, 0x37, 0xbf, 0x51, 0xf5,
        ]);
        let sub_json = json!({
            "endpoint": "https://updates.push.services.mozilla.com/wpush/v1/abc",
            "keys": {
                "p256dh": URL_SAFE_NO_PAD.encode(&pub_bytes),
                "auth": URL_SAFE_NO_PAD.encode([1u8; 16])
            }
        });
        let vapid = VapidConfig {
            public_key: "pub".into(),
            private_key: "IQ9Ur0ykXoHS9gzfYX0aBjy9lvdrjx_PFUXmie9YRcY".into(),
            subject: "mailto:ops@egdata.app".into(),
        };
        let push_ok =
            VapidWebPushClient::with_client(vapid.clone(), Arc::new(MockPushTransport("ok")));
        WebPushPort::send_notification(&push_ok, &sub_json, b"{}")
            .await
            .unwrap();
        let push_gone =
            VapidWebPushClient::with_client(vapid.clone(), Arc::new(MockPushTransport("gone")));
        assert_error_kind(
            (WebPushPort::send_notification(&push_gone, &sub_json, b"{}").await).unwrap_err(),
            CoreError::NotFound,
        );
        let push_err = VapidWebPushClient::with_client(vapid, Arc::new(MockPushTransport("err")));
        assert_error_kind(
            (WebPushPort::send_notification(&push_err, &sub_json, b"{}").await).unwrap_err(),
            CoreError::Internal,
        );
        assert!(
            WebPushPort::send_notification(&push_ok, &json!(null), b"{}")
                .await
                .is_err()
        );

        for (invalid, detail) in [
            (json!({}), "Missing subscription endpoint"),
            (json!({"endpoint":"fixture"}), "Missing subscription keys"),
            (
                json!({"endpoint":"fixture","keys":{}}),
                "Missing p256dh key",
            ),
            (
                json!({"endpoint":"fixture","keys":{"p256dh":"fixture"}}),
                "Missing auth key",
            ),
        ] {
            let error = WebPushPort::send_notification(&push_ok, &invalid, b"{}")
                .await
                .unwrap_err();
            assert_eq!(error.to_string(), detail);
        }
        let og = TakumiOgRenderer::new();
        let editorial = og
            .render_editorial(
                "<div>Fixture</div>",
                egdata_core::ports::EditorialOgTemplate::Collection,
            )
            .await
            .unwrap();
        assert!(editorial.starts_with(b"\x89PNG"));
        let png =
            OgRendererPort::render_image(&og, "<div>hi</div>", 100, 50, CoreOgImageFormat::Png)
                .await
                .unwrap();
        assert!(png.starts_with(b"\x89PNG"));
        let webp =
            OgRendererPort::render_image(&og, "<div>hi</div>", 100, 50, CoreOgImageFormat::Webp)
                .await
                .unwrap();
        assert_eq!(&webp[0..4], b"RIFF");

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let srv = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut buf = [0u8; 4096];
                let _ = tokio::io::AsyncReadExt::read(&mut stream, &mut buf).await;
                let resp = "HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n{\"ok\":1}\n";
                tokio::io::AsyncWriteExt::write_all(&mut stream, resp.as_bytes())
                    .await
                    .unwrap();
            }
        });
        let http = ReqwestUpstreamHttpClient::new();
        let res = UpstreamHttpPort::send(
            &http,
            UpstreamHttpRequest {
                method: "POST".into(),
                url: format!("http://{addr}/test"),
                headers: BTreeMap::from([("x-test".into(), "1".into())]),
                body: Some(b"hello".to_vec()),
                multipart_file: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(res.status, 200);
        let mp_res = UpstreamHttpPort::send(
            &http,
            UpstreamHttpRequest {
                method: "POST".into(),
                url: format!("http://{addr}/upload"),
                headers: BTreeMap::new(),
                body: None,
                multipart_file: Some(egdata_core::ports::UpstreamHttpMultipartFile {
                    field_name: "file".into(),
                    filename: "test.png".into(),
                    content_type: "image/png".into(),
                    bytes: vec![1, 2, 3],
                }),
            },
        )
        .await
        .unwrap();
        assert_eq!(mp_res.status, 200);
        assert!(
            UpstreamHttpPort::send(
                &http,
                UpstreamHttpRequest {
                    method: "BAD METHOD".into(),
                    url: format!("http://{addr}/bad"),
                    headers: BTreeMap::new(),
                    body: None,
                    multipart_file: None,
                },
            )
            .await
            .is_err()
        );
        let request = UpstreamHttpRequest {
            method: "GET".into(),
            url: "invalid".into(),
            headers: Default::default(),
            body: None,
            multipart_file: None,
        };
        assert_error_kind(
            (http.send(request.clone()).await).unwrap_err(),
            CoreError::Upstream,
        );
        let part = egdata_core::ports::UpstreamHttpMultipartFile {
            field_name: "file".into(),
            filename: "file".into(),
            content_type: "not a mime".into(),
            bytes: Vec::new(),
        };
        assert_error_kind(
            (http
                .send(UpstreamHttpRequest {
                    multipart_file: Some(part),
                    ..request.clone()
                })
                .await)
                .unwrap_err(),
            CoreError::InvalidInput,
        );
        let truncated = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = truncated.local_addr().unwrap();
        let truncated_task = tokio::spawn(async move {
            let (mut socket, _) = truncated.accept().await.unwrap();
            let mut headers =
                tokio::io::AsyncBufReadExt::lines(tokio::io::BufReader::new(&mut socket));
            assert_eq!(
                headers.next_line().await.unwrap().unwrap(),
                "GET / HTTP/1.1"
            );
            while !headers.next_line().await.unwrap().unwrap().is_empty() {}
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nhello",
                )
                .await
                .unwrap();
        });
        assert_error_kind(
            (http
                .send(UpstreamHttpRequest {
                    url: format!("http://{addr}/"),
                    ..request
                })
                .await)
                .unwrap_err(),
            CoreError::Upstream,
        );
        truncated_task.await.unwrap();
        srv.await.unwrap();
        service_server.stop().await;
        outage_server.stop().await;
    }
}
