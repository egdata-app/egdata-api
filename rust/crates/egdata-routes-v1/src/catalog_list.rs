//! Item, seller, and sandbox catalog listing endpoints.
pub use egdata_http_core::shared::builds::build_summary;

use super::RouteGroup;
use super::helpers::{
    V1ErrorResponse, V1RequestContext, json_success, parse_strict_query_uri, v1_cache_get,
    v1_cache_key, v1_cache_set,
};
use crate::state::AppState;
use axum::{
    extract::{Path, Request, State},
    http::Uri,
    response::{IntoResponse, Response},
};
use bson::{Bson, Document, doc};
use egdata_core::{
    ports::MongoFindOptions,
    v1::{
        CursorBinding, CursorSortValue, MongoSortField, NullsOrder, ProblemError, ProblemIssue,
        SortDirection, bson_to_serialized_json, iso_or_null, mongo_keyset_filter, mongo_sort_spec,
        page_meta, parse_pagination_map, regional_params, require_id_param, serialize_offer,
        serialize_seller, serialize_value, trim_page,
    },
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};

#[allow(clippy::large_enum_variant)] // Built once per request and immediately moved into a spawned read.
pub(super) enum PageRead {
    Find(Document, MongoFindOptions),
    Aggregate(Vec<Document>),
}

/// Run the page and its independently cached count like Promise.all. Dropping
/// the other JoinHandle on error lets an already-started read or cache fill finish.
pub(super) async fn counted_page(
    state: &AppState,
    operation: &str,
    parts: &[(&str, Value)],
    ttl: u64,
    collection: &'static str,
    base_filter: Option<Document>,
    read: PageRead,
) -> Result<(Vec<Document>, Value), ProblemError> {
    let mongo = state.mongo.clone();
    let page = tokio::spawn(async move {
        match read {
            PageRead::Find(filter, options) => mongo.find_many(collection, filter, options).await,
            PageRead::Aggregate(pipeline) => mongo.aggregate(collection, pipeline).await,
        }
        .map_err(|_| super::system::internal_error())
    });
    let state = state.clone();
    let operation = operation.to_owned();
    let parts: Vec<_> = parts
        .iter()
        .map(|(key, value)| (key.to_string(), value.clone()))
        .collect();
    let count = tokio::spawn(async move {
        let parts: Vec<_> = parts
            .iter()
            .map(|(key, value)| (key.as_str(), value.clone()))
            .collect();
        if let Some(filter) = base_filter {
            super::counts::documents(&state, &operation, &parts, ttl, collection, filter).await
        } else {
            super::helpers::cached_total(
                &state,
                &operation,
                &parts,
                ttl,
                std::future::ready(Ok(json!(0))),
            )
            .await
        }
    });
    tokio::try_join!(
        async { page.await.map_err(|_| super::system::internal_error())? },
        async { count.await.map_err(|_| super::system::internal_error())? }
    )
}

const OFFER_ORDERING: &str = "lastModifiedDate:desc,id:asc";
fn item_sort() -> [MongoSortField; 2] {
    [
        MongoSortField::new("lastModifiedDate", SortDirection::Desc, NullsOrder::Last),
        MongoSortField::new("id", SortDirection::Asc, NullsOrder::Last),
    ]
}
fn changelog_sort() -> [MongoSortField; 2] {
    [
        MongoSortField::new("timestamp", SortDirection::Desc, NullsOrder::Last),
        MongoSortField::new("_id", SortDirection::Desc, NullsOrder::Last),
    ]
}
static ITEM_SORT: std::sync::LazyLock<[MongoSortField; 2]> = std::sync::LazyLock::new(item_sort);
static CHANGELOG_SORT: std::sync::LazyLock<[MongoSortField; 2]> =
    std::sync::LazyLock::new(changelog_sort);

pub fn route_group(prefix: &str) -> RouteGroup {
    items::route_group(prefix)
        .merge(sellers::route_group(prefix))
        .merge(sandboxes::route_group(prefix))
}

fn req_id(ctx: Option<&V1RequestContext>) -> String {
    ctx.map(|c| c.request_id.clone()).unwrap_or_default()
}
fn error(error: ProblemError, uri: &Uri, id: String) -> Response {
    V1ErrorResponse {
        error,
        path: uri.path().into(),
        request_id: (!id.is_empty()).then_some(id),
    }
    .into_response()
}
fn query(uri: &Uri, keys: &[&str], id: String) -> Result<BTreeMap<String, String>, Box<Response>> {
    parse_strict_query_uri(uri, keys).map_err(|e| Box::new(error(e, uri, id)))
}
fn internal(uri: &Uri, id: String) -> Response {
    error(
        ProblemError::new(
            500,
            "INTERNAL_ERROR",
            "The API could not complete the request. Retry later and include the request ID when contacting support.",
        ),
        uri,
        id,
    )
}
fn merge_metadata(mut base: Value, extra: Value) -> Value {
    if let (Some(dst), Some(src)) = (base.as_object_mut(), extra.as_object()) {
        dst.extend(src.clone());
    }
    base
}
fn bjson(d: Document) -> Value {
    bson_to_serialized_json(&Bson::Document(d))
}
fn filter_after(
    sort: &[MongoSortField],
    tuple: &[CursorSortValue],
) -> Result<Document, ProblemError> {
    let bson: Vec<Bson> = tuple
        .iter()
        .enumerate()
        .map(|(index, v)| {
            cursor_sort_bson(v, sort.get(index).map_or("", |field| field.field.as_str()))
        })
        .collect();
    mongo_keyset_filter(sort, &bson)
}
fn cursor_sort_bson(v: &CursorSortValue, field: &str) -> Bson {
    match v {
        CursorSortValue::Null => Bson::Null,
        CursorSortValue::String(s)
            if ["lastModifiedDate", "timestamp", "updatedAt", "creationDate"].contains(&field) =>
        {
            // The Node routes always construct a Date. The BSON driver writes
            // an invalid Date as zero milliseconds when encoding the filter.
            Bson::DateTime(
                crate::offer_price_history::cursor_date(s)
                    .map(bson::DateTime::from_chrono)
                    .unwrap_or_else(|| bson::DateTime::from_millis(0)),
            )
        }
        CursorSortValue::String(s) if field == "_id" => bson::oid::ObjectId::parse_str(s)
            .map(Bson::ObjectId)
            .unwrap_or_else(|_| Bson::String(s.clone())),
        CursorSortValue::String(s) => Bson::String(s.clone()),
        CursorSortValue::Number(n) => n
            .as_i64()
            .map(Bson::Int64)
            .or_else(|| n.as_f64().map(Bson::Double))
            .unwrap_or(Bson::Null),
    }
}
fn binding(
    operation: &str,
    filters: Option<BTreeMap<String, Value>>,
    ordering: &str,
    country: &str,
    locale: &str,
    limit: u32,
) -> CursorBinding {
    CursorBinding {
        operation: operation.into(),
        filters,
        ordering: ordering.into(),
        country: country.into(),
        locale: locale.into(),
        limit,
    }
}
fn decode_for(
    state: &AppState,
    token: &str,
    bind: &CursorBinding,
) -> Result<Vec<CursorSortValue>, ProblemError> {
    egdata_core::v1::decode_cursor_with(
        token,
        bind,
        state.config.v1_cursor_secret.as_deref(),
        (state.now)().timestamp_millis(),
    )
}
fn encode_for(
    state: &AppState,
    bind: &CursorBinding,
    last: &[CursorSortValue],
) -> Result<String, ProblemError> {
    let filter_order: &[&str] = match bind.operation.as_str() {
        "sellers.offers" => &["offerType", "ignoredSandboxes"],
        "sandboxes.items" => &[
            "sandboxId",
            "entitlementType",
            "status",
            "platforms",
            "title",
        ],
        "sandboxes.offers" => &["sandboxId", "offerType", "title"],
        "sandboxes.builds" | "sandboxes.assets" => &["sandboxId", "platforms"],
        _ => &[],
    };
    egdata_core::v1::encode_cursor_with_filter_order(
        bind,
        last,
        state.config.v1_cursor_secret.as_deref(),
        (state.now)().timestamp_millis(),
        filter_order,
    )
}
fn obj(items: impl IntoIterator<Item = (String, Value)>) -> BTreeMap<String, Value> {
    items.into_iter().collect()
}
fn page_result<T>(rows: Vec<T>, limit: u32) -> (Vec<T>, bool) {
    let page = trim_page(rows, limit as usize);
    (page.items, page.has_more)
}
fn json_docs(docs: Vec<Document>) -> Vec<Value> {
    docs.into_iter().map(bjson).collect()
}

#[path = "catalog_list/items.rs"]
mod items;
#[path = "catalog_list/sandboxes.rs"]
mod sandboxes;

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use axum::body::Body;
    use egdata_core::{error::CoreError, ports::MongoStorePort};
    use http_body_util::BodyExt;
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;

    #[derive(Default)]
    struct RecordingMongo {
        many_docs: Vec<Document>,
        many_by_collection: HashMap<String, Vec<Document>>,
        one_docs: HashMap<String, Option<Document>>,
        many_calls: Mutex<Vec<(String, Document, MongoFindOptions)>>,
        one_calls: Mutex<Vec<(String, Document, Option<Document>)>>,
        distinct_values: Vec<Bson>,
        distinct_calls: Mutex<Vec<(String, String, Document)>>,
        count_calls: Mutex<Vec<(String, Document)>>,
        aggregate_calls: Mutex<Vec<(String, Vec<Document>)>>,
        aggregate_docs: Vec<Document>,
    }
    #[async_trait]
    impl MongoStorePort for RecordingMongo {
        async fn find_one(
            &self,
            c: &str,
            f: Document,
            p: Option<Document>,
        ) -> Result<Option<Document>, CoreError> {
            self.one_calls
                .lock()
                .unwrap()
                .push((c.into(), f.clone(), p));
            Ok(self.one_docs.get(c).cloned().unwrap_or(None))
        }
        async fn find_many(
            &self,
            c: &str,
            f: Document,
            o: MongoFindOptions,
        ) -> Result<Vec<Document>, CoreError> {
            self.many_calls.lock().unwrap().push((c.into(), f, o));
            Ok(self
                .many_by_collection
                .get(c)
                .cloned()
                .unwrap_or_else(|| self.many_docs.clone()))
        }
        async fn aggregate(&self, c: &str, p: Vec<Document>) -> Result<Vec<Document>, CoreError> {
            self.aggregate_calls.lock().unwrap().push((c.into(), p));
            Ok(self.aggregate_docs.clone())
        }
        async fn count_documents(&self, c: &str, f: Document) -> Result<u64, CoreError> {
            self.count_calls.lock().unwrap().push((c.into(), f));
            Ok(match c {
                "items" | "offers" | "builds" => self
                    .many_by_collection
                    .get(c)
                    .map_or(0, |rows| rows.len() as u64),
                "changelogs_v2" => self.aggregate_docs.len() as u64,
                _ => 0,
            })
        }
        async fn distinct(&self, c: &str, f: &str, d: Document) -> Result<Vec<Bson>, CoreError> {
            self.distinct_calls
                .lock()
                .unwrap()
                .push((c.into(), f.into(), d));
            Ok(self.distinct_values.clone())
        }
        async fn insert_one(&self, _: &str, _: Document) -> Result<(), CoreError> {
            Ok(())
        }
        async fn update_one(
            &self,
            _: &str,
            _: Document,
            _: Document,
            _: bool,
        ) -> Result<u64, CoreError> {
            Ok(0)
        }
        async fn delete_one(&self, _: &str, _: Document) -> Result<u64, CoreError> {
            Ok(0)
        }
        async fn ping(&self) -> Result<bool, CoreError> {
            Ok(true)
        }
    }
    fn app(mongo: Arc<RecordingMongo>) -> axum::Router {
        let mut state =
            egdata_api_test_support::test_app_state(crate::state::ApiConfig::default());
        state.mongo = mongo;
        route_group("/v1").router.with_state(state)
    }
    async fn json_body(response: Response) -> Value {
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
    }

    include!("catalog_list/sandbox_parity_tests.rs");

    #[tokio::test]
    async fn sellers_list_reads_distinct_seller_fields_and_reports_sorted_count() {
        let mongo = Arc::new(RecordingMongo {
            distinct_values: vec![
                bson::to_bson(&json!({"id":"s2","name":"Zulu"})).unwrap(),
                bson::to_bson(&json!({"id":"s1","name":"Alpha"})).unwrap(),
            ],
            ..Default::default()
        });
        let response = app(mongo.clone())
            .oneshot(
                Request::builder()
                    .uri("/v1/sellers")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = json_body(response).await;
        assert_eq!(body["data"][0]["id"], "s1");
        assert_eq!(body["meta"]["count"], 2);
        assert_eq!(
            mongo.distinct_calls.lock().unwrap().as_slice(),
            &[("offers".into(), "seller".into(), Document::new())]
        );
    }

    #[tokio::test]
    async fn seller_offer_filters_region_and_cursor_metadata_match_the_query() {
        let mongo = Arc::new(RecordingMongo {
            many_docs: vec![
                doc! {"id":"offer-a","seller":{"id":"seller-a","name":"Seller"},"offerType":"BASE_GAME","namespace":"ns","title":"Game","lastModifiedDate":bson::DateTime::from_millis(10)},
            ],
            ..Default::default()
        });
        let response=app(mongo.clone()).oneshot(Request::builder().uri("/v1/sellers/seller-a?limit=1&country=US&locale=en-US&offerType=BASE_GAME&ignoredSandboxes=ns-old").body(Body::empty()).unwrap()).await.unwrap();
        let body = json_body(response).await;
        assert_eq!(body["data"][0]["id"], "offer-a");
        assert_eq!(body["meta"]["country"], "US");
        let call = mongo
            .many_calls
            .lock()
            .unwrap()
            .iter()
            .find(|c| c.0 == "offers")
            .cloned()
            .unwrap();
        assert_eq!(call.1.get_str("seller.id").unwrap(), "seller-a");
        assert_eq!(call.1.get_str("offerType").unwrap(), "BASE_GAME");
        assert_eq!(
            call.1
                .get_document("namespace")
                .unwrap()
                .get_array("$nin")
                .unwrap(),
            &vec![Bson::String("ns-old".into())]
        );
        assert!(call.1.get_document("region").is_err());
        assert_eq!(call.2.sort, Some(doc! {"lastModifiedDate":-1,"id":1}));
        assert_eq!(call.2.limit, Some(2));
    }

    #[tokio::test]
    async fn sandbox_list_binds_cursor_and_queries_namespace_keyset_page() {
        let mongo = Arc::new(RecordingMongo {
            many_docs: vec![doc! {"_id":"ns-a"}, doc! {"_id":"ns-b"}],
            ..Default::default()
        });
        let app = app(mongo.clone());
        let first = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/sandboxes?limit=1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = json_body(first).await;
        assert_eq!(body["data"][0]["_id"], "ns-a");
        let cursor = body["meta"]["pagination"]["nextCursor"]
            .as_str()
            .unwrap()
            .to_string();
        let second = app
            .oneshot(
                Request::builder()
                    .uri(format!("/v1/sandboxes?limit=1&cursor={cursor}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(second.status(), axum::http::StatusCode::OK);
        let calls = mongo.many_calls.lock().unwrap();
        assert_eq!(calls[0].0, "namespaces");
        assert_eq!(calls[0].2.sort, Some(doc! {"_id":1}));
        assert_eq!(calls[0].2.limit, Some(2));
        assert_eq!(
            calls[1].1,
            doc! {"$or":[{"_id":{"$gt":"ns-a"}},{"_id":Bson::Null}]}
        );
    }

    #[tokio::test]
    async fn sandbox_item_filters_are_applied_before_keyset_pagination() {
        let mongo = Arc::new(RecordingMongo {
            many_docs: vec![
                doc! {"id":"it-1","namespace":"ns","title":"Test title","entitlementType":"GAME","status":"ACTIVE","lastModifiedDate":bson::DateTime::from_millis(1),"releaseInfo":[{"platform":["Windows"]}]},
            ],
            one_docs: HashMap::from([("namespaces".into(), Some(doc! {"_id":"ns"}))]),
            ..Default::default()
        });
        let response=app(mongo.clone()).oneshot(Request::builder().uri("/v1/sandboxes/ns/items?limit=5&entitlementType=GAME&status=ACTIVE&platforms=Windows&title=Test").body(Body::empty()).unwrap()).await.unwrap();
        let body = json_body(response).await;
        assert_eq!(body["data"][0]["id"], "it-1");
        let call = mongo
            .many_calls
            .lock()
            .unwrap()
            .iter()
            .find(|c| c.0 == "items")
            .cloned()
            .unwrap();
        assert_eq!(call.1.get_str("namespace").unwrap(), "ns");
        assert_eq!(
            call.1
                .get_document("entitlementType")
                .unwrap()
                .get_array("$in")
                .unwrap(),
            &vec![Bson::String("GAME".into())]
        );
        assert_eq!(
            call.1
                .get_document("status")
                .unwrap()
                .get_array("$in")
                .unwrap(),
            &vec![Bson::String("ACTIVE".into())]
        );
        assert_eq!(
            call.1
                .get_document("releaseInfo")
                .unwrap()
                .get_document("$elemMatch")
                .unwrap()
                .get_document("platform")
                .unwrap()
                .get_array("$in")
                .unwrap(),
            &vec![Bson::String("Windows".into())]
        );
        assert_eq!(
            call.1
                .get_document("title")
                .unwrap()
                .get_str("$regex")
                .unwrap(),
            "Test"
        );
        assert_eq!(call.2.limit, Some(6));
    }

    #[tokio::test]
    async fn sandbox_assets_merge_virtual_releases_and_filter_platform_before_cursor_page() {
        let mongo = Arc::new(RecordingMongo {
            one_docs: HashMap::from([("namespaces".into(), Some(doc! {"_id":"ns"}))]),
            many_by_collection: HashMap::from([
                (
                    "assets".into(),
                    vec![
                        doc! {"_id":"asset-1","namespace":"ns","artifactId":"stored","platform":"Windows","updatedAt":bson::DateTime::from_millis(100)},
                    ],
                ),
                (
                    "items".into(),
                    vec![
                        doc! {"id":"it-1","namespace":"ns","title":"Game","releaseInfo":[{"appId":"virtual","platform":["Windows","Mac"]}]},
                    ],
                ),
            ]),
            ..Default::default()
        });
        let app = app(mongo.clone());
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/sandboxes/ns/assets?limit=1&platform=Windows")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = json_body(response).await;
        assert_eq!(body["data"][0]["artifactId"], "stored");
        assert_eq!(body["meta"]["pagination"]["hasMore"], true);
        let cursor = body["meta"]["pagination"]["nextCursor"].as_str().unwrap();
        let second = app
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/v1/sandboxes/ns/assets?limit=1&platform=Windows&cursor={cursor}"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let second = json_body(second).await;
        assert_eq!(second["data"][0]["artifactId"], "virtual");
        assert_eq!(second["data"][0]["platform"], "Windows");
        let calls = mongo.many_calls.lock().unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c.0 == "assets" && c.1 == doc! {"namespace":{"$eq":"ns"}})
        );
        assert!(calls.iter().any(|c| c.0 == "items"
            && c.2.projection == Some(doc! {"id":1,"namespace":1,"releaseInfo":1,"title":1})));
    }

    #[tokio::test]
    async fn missing_sandbox_detail_uses_sandbox_then_namespace_and_returns_not_found() {
        let mongo = Arc::new(RecordingMongo::default());
        let response = app(mongo.clone())
            .oneshot(
                Request::builder()
                    .uri("/v1/sandboxes/missing")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::NOT_FOUND);
        let body = json_body(response).await;
        assert_eq!(body["code"], "SANDBOX_NOT_FOUND");
        let calls = mongo.one_calls.lock().unwrap();
        assert_eq!(
            calls.iter().map(|c| c.0.as_str()).collect::<Vec<_>>(),
            vec!["sandboxes", "namespaces"]
        );
        assert_eq!(calls[0].1, doc! {"_id":{"$eq":"missing"}});
    }
}
#[path = "catalog_list/sellers.rs"]
mod sellers;
