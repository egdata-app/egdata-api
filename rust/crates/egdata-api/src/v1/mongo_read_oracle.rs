//! Replay reads at the same Mongo and Redis boundaries as the Node fixture.
use super::{oracle_test_support::capture_response, router};
use crate::{middleware::test_support::test_app_state, state::ApiConfig};
use async_trait::async_trait;
use axum::{body::Body, http::Request};
use bson::{Bson, Document};
use egdata_core::{
    error::CoreError,
    ports::{MongoFindOptions, MongoStorePort, ResponseCachePort},
};
use egdata_infra::bson_json::bson_doc_to_js_json;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

#[derive(Default)]
pub(crate) struct RecordedReads {
    name: String,
    remaining: Mutex<Vec<Value>>,
    release_read: tokio::sync::Notify,
    read_resumed: tokio::sync::Notify,
    drained: tokio::sync::Notify,
}

// The current giveaway route loads desktop and mobile offers concurrently in Node.
// Each offer's history and item reads still depend on its own earlier lookups.
fn giveaway_lookup_id(call: &Value) -> Option<&str> {
    let query = &call["query"];
    match (call["collection"].as_str()?, call["method"].as_str()?) {
        ("offers", "one") | ("freegames", "many") => query["id"].as_str(),
        ("pricev2" | "mobile-freebies", "one") => query["offerId"].as_str(),
        ("offersubitems", "many") => query["_id"].as_str(),
        ("items", "many") => query.pointer("/$or/1/linkedOffers")?.as_str(),
        _ => None,
    }
}

impl RecordedReads {
    pub(crate) fn from_case(case: &Value) -> Self {
        Self {
            name: case["name"].as_str().unwrap().into(),
            remaining: Mutex::new(case["trace"].as_array().unwrap().clone()),
            ..Default::default()
        }
    }

    async fn wait_for_gate(&self, entry: &Value) {
        if entry["releaseAfterResponse"] == true {
            self.release_read.notified().await;
            self.read_resumed.notify_one();
        }
        if entry["yieldBeforeReturn"] == true {
            tokio::task::yield_now().await;
        }
    }

    async fn gated_response<F: std::future::Future>(
        &self,
        request: F,
        remaining: Option<usize>,
    ) -> F::Output {
        let Some(remaining) = remaining else {
            return request.await;
        };
        let timeout = std::time::Duration::from_secs(5);
        let response = tokio::time::timeout(timeout, request)
            .await
            .expect("the HTTP error must precede the held read");
        assert_eq!(
            self.remaining.lock().unwrap().len(),
            remaining,
            "{} pending follow-ups",
            self.name
        );
        self.release_read.notify_one();
        tokio::time::timeout(timeout, self.read_resumed.notified())
            .await
            .expect("the held read must continue after the error");
        if remaining > 0 {
            tokio::time::timeout(timeout, self.drained.notified())
                .await
                .expect("the sibling follow-ups must finish");
        }
        response
    }
    pub(crate) fn assert_finished(&self) {
        assert!(
            self.remaining.lock().unwrap().is_empty(),
            "{} missing service calls",
            self.name
        );
    }
    fn replay(&self, call: Value) -> Result<Value, CoreError> {
        Self::result(self.take_entry(call))
    }
    fn take_entry(&self, call: Value) -> Value {
        let mut remaining = self.remaining.lock().unwrap();
        let index = remaining
            .iter()
            .position(|entry| entry["call"] == call)
            .unwrap_or_else(|| {
                panic!(
                    "{}: unexpected {call}; expected {:?}",
                    self.name,
                    remaining.first().map(|e| &e["call"])
                )
            });
        let entry = remaining.remove(index);
        if remaining.is_empty() {
            self.drained.notify_one();
        }
        // Independent joins can resolve in a different order. Reads within either
        // platform's requirements chain, and Redis operations, remain ordered.
        if index > 0 && (self.name == "GraphQL profile" || self.name.starts_with("v1 profile ")) {
            // The profile implementations launch independent service reads concurrently.
            // Redis reads and writes for an individual key must still be ordered.
            if let Some(key) = call.get("key") {
                assert!(
                    remaining[..index]
                        .iter()
                        .all(|entry| entry["call"].get("key") != Some(key)),
                    "out-of-order profile cache key {key}"
                );
            }
        } else if index > 0
            && (self.name == "free-games-current-populated"
                || self.name.starts_with("v1 giveaway concurrent "))
        {
            let id = giveaway_lookup_id(&call).expect("expected an offer enrichment read");
            assert!(
                remaining[..index].iter().all(
                    |entry| giveaway_lookup_id(&entry["call"]).is_some_and(|prior| prior != id)
                ),
                "giveaway read out of order for {id}"
            );
        } else if index > 0 {
            assert_eq!(index, 1, "{} read order", self.name);
            let pending = &remaining[0]["call"];
            let price_join = call["method"] == "many"
                && pending["method"] == "many"
                && matches!(
                    (call["collection"].as_str(), pending["collection"].as_str()),
                    (Some("pricev2"), Some("offers")) | (Some("offers"), Some("pricev2"))
                );
            let platform_join = [pending, &call]
                .iter()
                .all(|c| c["method"] == "one" && c["collection"] == "offer_requirements")
                && matches!(
                    (
                        pending["query"]["platform"].as_str(),
                        call["query"]["platform"].as_str()
                    ),
                    (Some("windows"), Some("macos")) | (Some("macos"), Some("windows"))
                );
            let counted_page = matches!(
                (call["method"].as_str(), pending["method"].as_str()),
                (Some("many"), Some("count")) | (Some("count"), Some("many"))
            ) && call["collection"] == pending["collection"]
                && call["query"] == pending["query"];
            assert!(
                price_join || platform_join || counted_page,
                "{} read order: {call} before {pending}",
                self.name
            );
        }
        // Mongo compound sort priority depends on insertion order.
        if call["method"] == "many" {
            assert_eq!(
                call["options"]["sort"].to_string(),
                entry["call"]["options"]["sort"].to_string(),
                "{} sort order",
                self.name
            );
        } else if call["method"] == "aggregate" {
            for (stage, expected) in call["query"]
                .as_array()
                .unwrap()
                .iter()
                .zip(entry["call"]["query"].as_array().unwrap())
            {
                assert_eq!(
                    stage["$sort"].to_string(),
                    expected["$sort"].to_string(),
                    "{} pipeline sort order",
                    self.name
                );
            }
        }
        entry
    }
    fn result(entry: Value) -> Result<Value, CoreError> {
        if entry["error"] == true {
            Err(CoreError::Internal("fixture read failed".into()))
        } else {
            Ok(entry["result"].clone())
        }
    }
    fn mongo(
        &self,
        collection: &str,
        method: &str,
        query: Value,
        options: Value,
    ) -> Result<Value, CoreError> {
        self.replay(
            json!({ "collection":collection,"method":method,"query":query,"options":options }),
        )
    }
}

#[async_trait]
impl egdata_core::ports::OpenSearchPort for RecordedReads {
    async fn search(&self, index: &str, body: &Value) -> Result<Value, CoreError> {
        self.replay(json!({"service":"opensearch","method":"search","index":index,"body":body}))
    }
}

#[async_trait]
impl egdata_core::ports::GaPort for RecordedReads {
    async fn send_measurement(&self, body: &Value) -> Result<(), CoreError> {
        self.replay(json!({"service": "ga", "method": "collect", "body": body}))?;
        Ok(())
    }
    async fn track(&self, event: &egdata_core::ports::GaTrackEvent) -> Result<(), CoreError> {
        self.replay(json!({"service":"ga","method":"track","event":{
            "event":event.event,"location":event.location,"params":event.params,"userId":event.user_id,
            "session":{"id":event.session_id,"startedAt":event.session_started_at,"lastActiveAt":event.session_last_active_at}
        }}))?;
        Ok(())
    }
}

fn fixture_bson(value: &Bson) -> Value {
    match value {
        Bson::DateTime(date) => {
            json!({"$date":egdata_infra::bson_json::bson_datetime_to_iso_string(*date)})
        }
        Bson::ObjectId(id) => json!({"$oid":id.to_hex()}),
        Bson::Int64(n) if egdata_core::v1::serialization::node_bson_long(*n).is_object() => {
            json!({"$numberLong":n.to_string()})
        }
        Bson::RegularExpression(regex) => {
            json!({"$regularExpression":{"pattern":regex.pattern,"options":regex.options}})
        }
        Bson::Double(n) if !n.is_finite() => {
            json!({"$numberDouble":egdata_core::v1::query::format_js_number(*n)})
        }
        Bson::Double(n) => {
            serde_json::from_str(&egdata_core::v1::query::format_js_number(*n)).unwrap()
        }
        Bson::Document(doc) => fixture_doc(doc),
        Bson::Array(items) => Value::Array(items.iter().map(fixture_bson).collect()),
        other => egdata_infra::bson_json::bson_to_js_json(other),
    }
}
fn fixture_doc(doc: &Document) -> Value {
    Value::Object(
        doc.iter()
            .map(|(k, v)| (k.clone(), fixture_bson(v)))
            .collect(),
    )
}
fn result_doc(value: &Value) -> Document {
    Bson::try_from(value.clone())
        .unwrap()
        .as_document()
        .unwrap()
        .clone()
}
fn rows(value: Value) -> Vec<Document> {
    value.as_array().unwrap().iter().map(result_doc).collect()
}
fn find_options(opt: MongoFindOptions) -> Value {
    let mut options = json!({});
    if let Some(v) = opt.sort {
        options["sort"] = bson_doc_to_js_json(&v);
    }
    if let Some(v) = opt.projection {
        options["projection"] = bson_doc_to_js_json(&v);
    }
    if let Some(v) = opt.limit {
        options["limit"] = json!(v);
    }
    if let Some(v) = opt.skip {
        options["skip"] = json!(v);
    }
    if let Some(v) = opt.collation {
        options["collation"] = bson_doc_to_js_json(&v);
    }
    options
}

#[async_trait]
impl MongoStorePort for RecordedReads {
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
        opt: MongoFindOptions,
    ) -> Result<Option<Document>, CoreError> {
        let entry=self.take_entry(json!({"collection":collection,"method":"one","query":fixture_doc(&filter),"options":find_options(opt)}));
        self.wait_for_gate(&entry).await;
        let value = Self::result(entry)?;
        Ok((!value.is_null()).then(|| result_doc(&value)))
    }
    async fn find_many(
        &self,
        collection: &str,
        filter: Document,
        opt: MongoFindOptions,
    ) -> Result<Vec<Document>, CoreError> {
        let entry = self.take_entry(json!({
            "collection":collection, "method":"many", "query":fixture_doc(&filter), "options":find_options(opt),
        }));
        self.wait_for_gate(&entry).await;
        Ok(rows(Self::result(entry)?))
    }
    async fn find_many_with_raw_page(
        &self,
        collection: &str,
        filter: Document,
        options: Document,
    ) -> Result<Vec<Document>, CoreError> {
        Ok(rows(self.mongo(
            collection,
            "many",
            fixture_doc(&filter),
            fixture_doc(&options),
        )?))
    }
    async fn find_stream(
        &self,
        collection: &str,
        filter: Document,
        opt: MongoFindOptions,
    ) -> Result<egdata_core::ports::MongoDocumentStream, CoreError> {
        let recorded = rows(self.mongo(
            collection,
            "stream",
            fixture_doc(&filter),
            find_options(opt),
        )?);
        Ok(Box::pin(futures::stream::iter(
            recorded.into_iter().map(Ok),
        )))
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
        let stages = pipeline.iter().map(fixture_doc).collect();
        Ok(rows(self.mongo(
            collection,
            "aggregate",
            Value::Array(stages),
            {
                let mut record = json!({});
                if let Some(v) = options.allow_disk_use {
                    record["allowDiskUse"] = json!(v);
                }
                if let Some(v) = options.collation {
                    record["collation"] = fixture_doc(&v);
                }
                if let Some(v) = options.max_time_ms {
                    record["maxTimeMS"] = json!(v);
                }
                record
            },
        )?))
    }
    async fn count_documents(&self, collection: &str, filter: Document) -> Result<u64, CoreError> {
        let mut query = fixture_doc(&filter);
        if self.name.starts_with("legacy stats")
            && let Ok(dates) = filter.get_document("creationDate")
        {
            use chrono::{DateTime, Datelike, Local, Utc};
            let years = ["$gte", "$lt"].map(|key| {
                let date = DateTime::<Utc>::from_timestamp_millis(
                    dates.get_datetime(key).unwrap().timestamp_millis(),
                )
                .unwrap()
                .with_timezone(&Local);
                assert_eq!(
                    date.format("%m-%d %H:%M:%S%.3f").to_string(),
                    "01-01 00:00:00.000"
                );
                date.year()
            });
            query = json!({"localYears":years});
        }
        Ok(self
            .mongo(collection, "count", query, json!({}))?
            .as_u64()
            .unwrap())
    }
    async fn count_documents_with_options(
        &self,
        collection: &str,
        filter: Document,
        options: Option<Document>,
    ) -> Result<u64, CoreError> {
        let result = self.mongo(
            collection,
            "count",
            fixture_doc(&filter),
            fixture_doc(&options.unwrap_or_default()),
        )?;
        Ok(result.as_u64().unwrap())
    }
    async fn distinct(
        &self,
        collection: &str,
        field: &str,
        filter: Document,
    ) -> Result<Vec<Bson>, CoreError> {
        Ok(self
            .mongo(
                collection,
                "distinct",
                fixture_doc(&filter),
                json!({"field":field}),
            )?
            .as_array()
            .unwrap()
            .iter()
            .cloned()
            .map(|v| Bson::try_from(v).unwrap())
            .collect())
    }
    async fn insert_one(&self, collection: &str, document: Document) -> Result<(), CoreError> {
        self.mongo(collection, "insert", fixture_doc(&document), json!({}))?;
        Ok(())
    }
    async fn update_one(
        &self,
        collection: &str,
        filter: Document,
        update: Document,
        upsert: bool,
    ) -> Result<u64, CoreError> {
        let mut options = json!({"update":fixture_doc(&update)});
        if upsert {
            options["upsert"] = true.into();
        }
        Ok(
            self.mongo(collection, "update", fixture_doc(&filter), options)?["modifiedCount"]
                .as_u64()
                .unwrap(),
        )
    }
    async fn upsert_one_returning_id(
        &self,
        collection: &str,
        filter: Document,
        update: Document,
    ) -> Result<Option<Bson>, CoreError> {
        let result = self.mongo(
            collection,
            "update",
            fixture_doc(&filter),
            json!({"update":fixture_doc(&update),"upsert":true}),
        )?;
        Ok(result
            .get("upsertedId")
            .filter(|id| !id.is_null())
            .cloned()
            .map(|id| Bson::try_from(id).unwrap()))
    }
    async fn delete_one(&self, collection: &str, filter: Document) -> Result<u64, CoreError> {
        Ok(
            self.mongo(collection, "delete", fixture_doc(&filter), json!({}))?["deletedCount"]
                .as_u64()
                .unwrap(),
        )
    }
    async fn ping(&self) -> Result<bool, CoreError> {
        Ok(self
            .replay(json!({"method":"ping","service":"mongo"}))?
            .as_bool()
            .unwrap())
    }
}

#[async_trait]
impl egdata_core::ports::JobApiPort for RecordedReads {
    async fn submit(
        &self,
        job_type: egdata_core::ports::JobApiJobType,
        payload: &Value,
        request_id: Option<&str>,
    ) -> Result<egdata_core::ports::AcceptedJobSubmission, CoreError> {
        let result=self.replay(json!({"service":"job","method":"submit","jobType":job_type,"payload":payload,"requestId":request_id}))?;
        Ok(serde_json::from_value(result).unwrap())
    }
    async fn submit_batch(
        &self,
        job_type: egdata_core::ports::JobApiJobType,
        payloads: &[Value],
        request_id: Option<&str>,
    ) -> Result<Vec<egdata_core::ports::AcceptedJobSubmission>, CoreError> {
        let result=self.replay(json!({"service":"job","method":"submitBatch","jobType":job_type,"payloads":payloads,"requestId":request_id}))?;
        Ok(serde_json::from_value(result).unwrap())
    }
}

#[async_trait]
impl ResponseCachePort for RecordedReads {
    async fn get(&self, key: &str) -> Result<Option<String>, CoreError> {
        let entry = self.take_entry(json!({"method":"get","key":key}));
        if let Some(raw) = entry["rawResult"].as_str() {
            return Ok(Some(raw.into()));
        }
        let hit = Self::result(entry)?;
        if self.name == "GraphQL profile" {
            return Ok(hit["rawCache"].as_str().map(str::to_owned));
        }
        if (self.name.starts_with("legacy-profile-raw-cache-")
            || self.name.starts_with("legacy-build-raw-cache-"))
            && let Some(raw) = hit["rawCache"].as_str()
        {
            return Ok(Some(raw.to_owned()));
        }
        if self.name.starts_with("state code ") || self.name == "state storage unavailable" {
            return Ok(hit.as_str().map(str::to_owned));
        }
        Ok((!hit.is_null()).then(|| hit.to_string()))
    }
    async fn set(&self, key: &str, payload: &str, ttl: u64) -> Result<(), CoreError> {
        let mut call = json!({"method":"set","key":key,"ttl":ttl});
        if !payload.is_empty() {
            call["payload"] = serde_json::from_str::<Value>(payload).unwrap();
        }
        self.replay(call)?;
        Ok(())
    }
    async fn del(&self, _: &str) -> Result<(), CoreError> {
        unreachable!()
    }
    async fn ping(&self) -> Result<bool, CoreError> {
        Ok(self
            .replay(json!({"method":"ping","service":"redis"}))?
            .as_bool()
            .unwrap())
    }
}

#[async_trait]
impl egdata_core::ports::EpicStorePort for RecordedReads {
    async fn token_account(&self, token: &str) -> Result<Option<String>, CoreError> {
        let account = self.replay(json!({"method":"epicTokenInfo","token":token}))?;
        Ok(account.as_str().map(str::to_owned))
    }
    async fn get_user(&self, account_id: &str) -> Result<Option<Value>, CoreError> {
        let user = self.replay(json!({"method":"epicUser","id":account_id}))?;
        Ok((!user.is_null()).then_some(user))
    }
    async fn graphql(&self, _: &str, _: &Value) -> Result<Value, CoreError> {
        unreachable!()
    }
    async fn featured_games(&self) -> Result<Vec<Value>, CoreError> {
        let result = self.replay(json!({"method":"featuredGames"}))?;
        Ok(result.as_array().unwrap().clone())
    }
}

#[async_trait]
impl egdata_core::ports::ProfileRefreshPort for RecordedReads {
    async fn request(&self, id: &str, ttl_ms: i64) -> Result<(), CoreError> {
        self.replay(json!({"method":"profileRefresh","id":id,"ttlMs":ttl_ms}))?;
        Ok(())
    }
    async fn status(&self, id: &str) -> Result<Option<String>, CoreError> {
        let value=self.replay(json!({"service":"primaryRedis","method":"get","key":format!("refresh-achievements:{id}")}))?;
        if self.name.starts_with("legacy-profile-raw-status-") {
            return Ok(value["rawCache"].as_str().map(str::to_owned));
        }
        Ok((!value.is_null()).then(|| value.to_string()))
    }
}

#[async_trait]
impl egdata_core::ports::SessionVerifierPort for RecordedReads {
    async fn verify_token(
        &self,
        cookie: &str,
    ) -> Result<Option<egdata_core::ports::VerifiedSession>, CoreError> {
        let user = self.replay(json!({"method":"session","cookie":cookie}))?;
        Ok(user
            .as_object()
            .map(|claims| egdata_core::ports::VerifiedSession {
                subject: claims["id"].as_str().unwrap().into(),
                claims: claims.clone().into_iter().collect(),
            }))
    }
}

#[tokio::test]
async fn collection_positions_http_node_oracle() {
    replay_mongo_oracle(include_str!(
        "../../tests/fixtures/collection-positions-http-node.json"
    ))
    .await;
}

#[tokio::test]
async fn collections_promotions_http_node_oracle() {
    replay_mongo_oracle(include_str!(
        "../../tests/fixtures/collections-promotions-http-node.json"
    ))
    .await;
}

#[tokio::test]
async fn offer_price_history_http_node_oracle() {
    replay_mongo_oracle(include_str!(
        "../../tests/fixtures/offer-price-history-http-node.json"
    ))
    .await;
}

pub(super) async fn replay_mongo_oracle(fixture: &str) {
    let cases: Vec<Value> = serde_json::from_str(fixture).unwrap();
    for case in cases {
        let reads = Arc::new(RecordedReads {
            name: case["name"].as_str().unwrap().into(),
            remaining: Mutex::new(case["trace"].as_array().unwrap().clone()),
            ..Default::default()
        });
        let mut state = test_app_state(ApiConfig {
            v1_cursor_secret: (case["cursorSecret"] != false).then(|| {
                case["cursorSecret"]
                    .as_str()
                    .unwrap_or("deterministic-collection-cursor-secret-for-oracle")
                    .into()
            }),
            v1_worker_token: Some("oracle-worker".into()),
            ..Default::default()
        });
        state.now = || "2026-11-17T00:00:00Z".parse().unwrap();
        state.mongo = reads.clone();
        state.cache = reads.clone();
        state.epic = reads.clone();
        let app = router(&state).with_state(state);
        let mut request = Request::builder()
            .method(case["request"]["method"].as_str().unwrap_or("GET"))
            .uri(case["request"]["path"].as_str().unwrap())
            .header("x-egdata-key-id", "key_oracle")
            .header("x-egdata-key-tier", "free")
            .header("x-request-id", "req_node_oracle")
            .header("x-egdata-worker-token", "oracle-worker");
        if let Some(content_type) = case["request"]["contentType"].as_str() {
            request = request.header("content-type", content_type);
        }
        let body = case["request"]["rawBody"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let request = request.body(Body::from(body)).unwrap();
        let remaining = case["remainingReadsAfterResponse"]
            .as_u64()
            .map(|n| n as usize);
        let actual = capture_response(
            reads
                .gated_response(app.oneshot(request), remaining)
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(actual, case["response"], "{}", reads.name);
        if case["failedRead"] != true {
            assert!(
                reads.remaining.lock().unwrap().is_empty(),
                "{} missing reads",
                reads.name
            );
        }
    }
}

/// Exercise a legacy route through the same middleware and service calls as a real request.
pub(crate) async fn replay_legacy_oracle(fixture: &str) {
    let cases: Vec<Value> = serde_json::from_str(fixture).unwrap();
    for case in cases {
        let reads = Arc::new(RecordedReads::from_case(&case));
        let mut state = test_app_state(ApiConfig::default());
        state.saved_queries = reads.clone();
        state.job_api = reads.clone();
        state.opensearch = reads.clone();
        state.profile_refresh = reads.clone();
        state.epic = reads.clone();
        if reads.name.starts_with("legacy-profile-") {
            state.session_verifier = reads.clone();
        }
        state.now = || "2026-11-17T00:00:00Z".parse().unwrap();
        state.ga = reads.clone();
        state.mongo = reads.clone();
        state.cache = reads.clone();
        let app = crate::runtime::application(state);
        let source = &case["request"];
        let mut builder = Request::builder()
            .method(source["method"].as_str().unwrap())
            .uri(source["path"].as_str().unwrap());
        if let Some(headers) = source["headers"].as_object() {
            for (k, v) in headers {
                builder = builder.header(k, v.as_str().unwrap());
            }
        }
        let body = if let Some(bytes) = source.get("rawBodyBytes") {
            Body::from(serde_json::from_value::<Vec<u8>>(bytes.clone()).unwrap())
        } else if let Some(raw) = source["rawBody"].as_str() {
            Body::from(raw.to_string())
        } else {
            source
                .get("body")
                .map(|body| Body::from(body.to_string()))
                .unwrap_or_default()
        };
        let request = app.oneshot(builder.body(body).unwrap());
        let response = reads
            .gated_response(
                request,
                (case["releaseReadAfterResponse"] == true).then_some(1),
            )
            .await
            .unwrap();
        if let Some(headers) = case["additionalHeaders"].as_object() {
            for (name, expected) in headers {
                assert_eq!(
                    response.headers().get(name).map(|v| v.to_str().unwrap()),
                    expected.as_str(),
                    "{} {name}",
                    reads.name
                );
            }
        }
        assert_eq!(
            capture_response(response).await,
            case["response"],
            "{}",
            reads.name
        );
        reads.assert_finished();
    }
}

#[tokio::test]
async fn graphql_transport_http_node_oracle() {
    replay_graphql(
        "GraphQL HTTP",
        include_str!("../../tests/fixtures/graphql-transport-node.json"),
    )
    .await
}

#[tokio::test]
async fn graphql_output_http_node_oracle() {
    replay_graphql(
        "GraphQL HTTP",
        include_str!("../../tests/fixtures/graphql-output-node.json"),
    )
    .await
}

#[tokio::test]
async fn graphql_profile_http_node_oracle() {
    replay_graphql(
        "GraphQL profile",
        include_str!("../../tests/fixtures/graphql-profile-node.json"),
    )
    .await
}

async fn replay_graphql(name: &str, fixture: &str) {
    use http_body_util::BodyExt;
    let cases: Vec<Value> = serde_json::from_str(fixture).unwrap();
    let reads = Arc::new(RecordedReads {
        name: name.into(),
        ..Default::default()
    });
    let mut state = test_app_state(ApiConfig::default());
    state.mongo = reads.clone();
    if name == "GraphQL profile" {
        state.cache = reads.clone();
        state.epic = reads.clone();
    }
    let app = crate::runtime::application(state);
    let mut differences = Vec::new();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        *reads.remaining.lock().unwrap() = case["trace"].as_array().unwrap().clone();
        let source = &case["request"];
        let mut request = Request::builder()
            .method(source["method"].as_str().unwrap())
            .uri(source["path"].as_str().unwrap());
        for (key, v) in source["headers"].as_object().unwrap() {
            if let Some(values) = v.as_array() {
                for value in values {
                    request = request.header(key, value.as_str().unwrap());
                }
            } else {
                request = request.header(key, v.as_str().unwrap());
            }
        }
        let body = source
            .get("body")
            .map(|v| Body::from(v.to_string()))
            .unwrap_or_default();
        let resp = app
            .clone()
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap();
        let (parts, body) = resp.into_parts();
        let actual = String::from_utf8(body.collect().await.unwrap().to_bytes().to_vec()).unwrap();
        let expected = case["response"]["body"].as_str().unwrap();
        if actual != expected {
            differences.push(format!("{name} body: {actual:?}, expected {expected:?}"));
        }
        let expected_status = case["response"]["status"].as_u64().unwrap() as u16;
        if parts.status.as_u16() != expected_status {
            differences.push(format!(
                "{name} status: {}, expected {expected_status}",
                parts.status
            ));
        }
        for key in [
            "content-type",
            "etag",
            "cache-control",
            "cdn-cache-control",
            "vary",
            "allow",
            "x-route-template",
        ] {
            let actual = parts.headers.get(key).and_then(|v| v.to_str().ok());
            let expected = case["response"]["headers"][key].as_str();
            if actual != expected {
                differences.push(format!("{name} {key}: {actual:?}, expected {expected:?}"));
            }
        }
        assert!(
            reads.remaining.lock().unwrap().is_empty(),
            "{name} missing reads"
        );
    }
    assert!(differences.is_empty(), "{}", differences.join("\n"));
}
