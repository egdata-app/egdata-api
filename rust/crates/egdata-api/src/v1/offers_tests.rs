use super::*;
use crate::{middleware::test_support::test_app_state, state::ApiConfig};
use async_trait::async_trait;
use axum::{body::Body, http::StatusCode};
use egdata_core::{
    error::CoreError,
    ports::{MongoStorePort, ResponseCachePort},
};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

#[tokio::test]
async fn interrupted_bulk_body_returns_malformed_json_without_a_read() {
    let store = Arc::new(Store::default());
    let stream = futures::stream::once(async {
        Err::<axum::body::Bytes, _>(std::io::Error::other("connection interrupted"))
    });
    let request = Request::post("/v1/offers/slugs")
        .header("x-egdata-key-id", "key_test1234")
        .header("x-egdata-key-tier", "free")
        .header("content-type", "application/json")
        .body(Body::from_stream(stream))
        .unwrap();
    let response = app(store.clone()).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).unwrap()["code"],
        "MALFORMED_JSON"
    );
    assert!(store.finds.lock().unwrap().is_empty());
}

#[tokio::test]
async fn bulk_and_discovery_http_edges_match_node() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../tests/fixtures/offer-discovery-edges-http-node.json"
    ))
    .unwrap();
    let mut runs = tokio::task::JoinSet::new();
    for case in cases {
        runs.spawn(async move {
            let fixture = json!([case]).to_string();
            super::super::mongo_read_oracle::replay_mongo_oracle(&fixture).await;
        });
    }
    let mut failures = Vec::new();
    while let Some(result) = runs.join_next().await {
        if let Err(error) = result {
            failures.push(error.to_string());
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[derive(Default)]
struct Store {
    rows: HashMap<String, Vec<Document>>,
    singles: HashMap<String, Document>,
    failures: HashSet<String>,
    finds: Mutex<Vec<(String, Document, MongoFindOptions)>>,
    pipelines: Mutex<Vec<Vec<Document>>>,
    cache: Mutex<HashMap<String, String>>,
}
#[async_trait]
impl MongoStorePort for Store {
    async fn find_one(
        &self,
        c: &str,
        f: Document,
        p: Option<Document>,
    ) -> Result<Option<Document>, CoreError> {
        self.finds.lock().unwrap().push((
            c.into(),
            f,
            MongoFindOptions {
                projection: p,
                ..Default::default()
            },
        ));
        if self.failures.contains(c) {
            return Err(CoreError::Internal("private database error".into()));
        }
        Ok(self.singles.get(c).cloned())
    }
    async fn find_many(
        &self,
        c: &str,
        f: Document,
        o: MongoFindOptions,
    ) -> Result<Vec<Document>, CoreError> {
        self.finds.lock().unwrap().push((c.into(), f, o));
        if self.failures.contains(c) {
            return Err(CoreError::Internal("private database error".into()));
        }
        Ok(self.rows.get(c).cloned().unwrap_or_default())
    }
    async fn aggregate(&self, c: &str, p: Vec<Document>) -> Result<Vec<Document>, CoreError> {
        self.pipelines.lock().unwrap().push(p);
        if self.failures.contains(c) {
            return Err(CoreError::Internal("private database error".into()));
        }
        Ok(self.rows.get(c).cloned().unwrap_or_default())
    }
    async fn count_documents(&self, _: &str, _: Document) -> Result<u64, CoreError> {
        panic!("unexpected count")
    }
    async fn distinct(&self, _: &str, _: &str, _: Document) -> Result<Vec<Bson>, CoreError> {
        panic!("unexpected distinct")
    }
    async fn insert_one(&self, _: &str, _: Document) -> Result<(), CoreError> {
        panic!("read route wrote data")
    }
    async fn update_one(
        &self,
        _: &str,
        _: Document,
        _: Document,
        _: bool,
    ) -> Result<u64, CoreError> {
        panic!("read route wrote data")
    }
    async fn delete_one(&self, _: &str, _: Document) -> Result<u64, CoreError> {
        panic!("read route wrote data")
    }
    async fn ping(&self) -> Result<bool, CoreError> {
        Ok(true)
    }
}
#[async_trait]
impl ResponseCachePort for Store {
    async fn get(&self, k: &str) -> Result<Option<String>, CoreError> {
        Ok(self.cache.lock().unwrap().get(k).cloned())
    }
    async fn set(&self, k: &str, v: &str, _: u64) -> Result<(), CoreError> {
        self.cache.lock().unwrap().insert(k.into(), v.into());
        Ok(())
    }
    async fn del(&self, k: &str) -> Result<(), CoreError> {
        self.cache.lock().unwrap().remove(k);
        Ok(())
    }
    async fn ping(&self) -> Result<bool, CoreError> {
        Ok(true)
    }
}
fn app(store: Arc<Store>) -> axum::Router {
    app_at(store, chrono::Utc::now)
}
fn app_at(store: Arc<Store>, now: fn() -> chrono::DateTime<chrono::Utc>) -> axum::Router {
    let mut state = test_app_state(ApiConfig::default());
    state.now = now;
    state.config = Arc::new(ApiConfig {
        v1_cursor_secret: Some("test-cursor-secret-that-is-at-least-32-chars".into()),
        ..ApiConfig::default()
    });
    state.mongo = store.clone();
    state.cache = store;
    super::super::router(&state).with_state(state)
}
async fn call(app: axum::Router, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let (status, _, body) = call_full(app, uri, body).await;
    (status, body)
}
async fn call_full(
    app: axum::Router,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, axum::http::HeaderMap, Value) {
    let mut request = Request::builder()
        .uri(uri)
        .header("x-egdata-key-id", "key_test1234")
        .header("x-egdata-key-tier", "free")
        .header("x-request-id", "req_node_oracle");
    let body = if let Some(body) = body {
        request = request
            .method("POST")
            .header("content-type", "application/json");
        Body::from(body.to_string())
    } else {
        Body::empty()
    };
    let response = app.oneshot(request.body(body).unwrap()).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, headers, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn node_http_oracle_replays_registered_offer_cases() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../../tests/fixtures/offers-http-node.json")).unwrap();
    for case in cases {
        let request = &case["request"];
        let path = request["path"].as_str().unwrap();
        let mut store = Store::default();
        if case["name"] == "events" || case["name"] == "genres-populated" {
            let tag_field = if case["name"] == "events" {
                "events"
            } else {
                "genres"
            };
            store.rows.insert(
                "tags".into(),
                case["input"][tag_field]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| bson::to_document(v).unwrap())
                    .collect(),
            );
        }
        if let Some(rows) = case["input"]["positions"].as_array() {
            store.rows.insert(
                "game_positions".into(),
                rows.iter().map(|v| bson::to_document(v).unwrap()).collect(),
            );
        }
        if let Some(event) = case["input"].get("event").filter(|value| value.is_object()) {
            store
                .singles
                .insert("tags".into(), bson::to_document(event).unwrap());
        }
        if let Some(rows) = case["input"]["aggregateOffers"].as_array() {
            store.rows.insert(
                "offers".into(),
                rows.iter().map(|v| bson::to_document(v).unwrap()).collect(),
            );
        }
        if let Some(rows) = case["input"]["achievements"].as_array() {
            store.rows.insert(
                "achievementsets".into(),
                rows.iter().map(|v| bson::to_document(v).unwrap()).collect(),
            );
        }
        if let Some(rows) = case["input"]["offers"].as_array() {
            store.rows.insert(
                "offers".into(),
                rows.iter().map(|v| bson::to_document(v).unwrap()).collect(),
            );
        }
        if let Some(rows) = case["input"]["prices"].as_array() {
            store.rows.insert(
                "pricev2".into(),
                rows.iter().map(|v| bson::to_document(v).unwrap()).collect(),
            );
        }
        if case["name"]
            .as_str()
            .is_some_and(|name| name.starts_with("localized-"))
        {
            store.singles.insert(
                "offers".into(),
                bson::to_document(&case["input"]["offer"]).unwrap(),
            );
            store.rows.insert(
                "pricev2".into(),
                case["input"]["prices"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| bson::to_document(v).unwrap())
                    .collect(),
            );
            store.rows.insert(
                "egs_localizations".into(),
                case["input"]["localizations"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| bson::to_document(v).unwrap())
                    .collect(),
            );
        }
        if case["name"] == "priced-us-list-cache-hit"
            || case["name"] == "priced-us-list-malformed-cache"
        {
            let key = v1_cache_key(
                "offers.list",
                &BTreeMap::from([
                    ("region", json!("US")),
                    ("locale", json!("en-US")),
                    ("limit", json!(20)),
                    ("cursor", Value::Null),
                    ("filters", json!({})),
                ]),
            );
            store.cache.lock().unwrap().insert(
                key,
                case["input"]["cachePayload"].as_str().unwrap().to_owned(),
            );
        }
        let store = Arc::new(store);
        let mut builder = Request::builder()
            .method(request["method"].as_str().unwrap_or("GET"))
            .uri(path)
            .header("x-egdata-key-id", "key_test1234")
            .header("x-egdata-key-tier", "free")
            .header("x-request-id", "req_node_oracle");
        let body = if request["body"].is_object() {
            builder = builder.header("content-type", "application/json");
            Body::from(request["body"].to_string())
        } else {
            Body::empty()
        };
        let response = app_at(store.clone(), || {
            chrono::DateTime::parse_from_rfc3339("2026-11-17T18:00:00.000Z")
                .unwrap()
                .with_timezone(&chrono::Utc)
        })
        .oneshot(builder.body(body).unwrap())
        .await
        .unwrap();
        let actual = crate::v1::oracle_test_support::capture_response(response).await;
        assert_eq!(actual, case["response"], "{}", case["name"]);
        if case["name"] == "priced-us-list-cache-hit" {
            assert!(store.finds.lock().unwrap().is_empty());
        }
        if case["name"] == "localized-gb-detail-price-ineligible" {
            assert!(
                store
                    .finds
                    .lock()
                    .unwrap()
                    .iter()
                    .all(|(collection, _, _)| collection != "pricev2")
            );
        }
    }
}
fn offer(id: &str) -> Document {
    doc! {"id":id,"namespace":"ns","title":"Original","lastModifiedDate":bson::DateTime::parse_rfc3339_str("2026-01-02T00:00:00Z").unwrap(),"releaseDate":bson::DateTime::parse_rfc3339_str("2026-01-01T00:00:00Z").unwrap()}
}

#[tokio::test]
async fn list_trims_before_hydration_binds_cursors_and_reuses_node_cache_shape() {
    let mut store = Store::default();
    store
        .rows
        .insert("offers".into(), vec![offer("one"), offer("two")]);
    store.rows.insert("pricev2".into(),vec![doc!{"offerId":"one","region":"US","price":{"originalPrice":100,"discountPrice":80,"discount":20},"currencyCode":"USD"}]);
    let store = Arc::new(store);
    let router = app(store.clone());
    let (status, body) = call(router.clone(), "/v1/offers?limit=1", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"].as_array().unwrap().len(), 1);
    assert_eq!(body["data"][0]["id"], "one");
    assert_eq!(body["meta"]["pagination"]["hasMore"], true);
    let cursor = body["meta"]["pagination"]["nextCursor"].as_str().unwrap();
    {
        let finds = store.finds.lock().unwrap();
        assert_eq!(finds[0].2.limit, Some(2));
        assert_eq!(finds[0].2.sort, Some(doc! {"lastModifiedDate":-1,"id":1}));
        assert_eq!(finds[1].1, doc! {"offerId":{"$in":["one"]},"region":"US"});
    }
    let before = store.finds.lock().unwrap().len();
    let (_, cached) = call(router.clone(), "/v1/offers?limit=1", None).await;
    assert_eq!(cached["data"], body["data"]);
    assert_eq!(store.finds.lock().unwrap().len(), before);
    let payload: Value =
        serde_json::from_str(store.cache.lock().unwrap().values().next().unwrap()).unwrap();
    assert!(payload.get("offers").is_some());
    assert_eq!(payload["cacheTtl"], 60);
    assert!(payload.get("elements").is_none());
    let (status, _) = call(
        router.clone(),
        &format!("/v1/offers?limit=1&cursor={cursor}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    {
        let finds = store.finds.lock().unwrap();
        assert_eq!(
            finds[before].1,
            mongo_keyset_filter(
                &date_sort("lastModifiedDate", SortDirection::Desc),
                &[
                    Bson::DateTime(
                        bson::DateTime::parse_rfc3339_str("2026-01-02T00:00:00Z").unwrap()
                    ),
                    Bson::String("one".into())
                ]
            )
            .unwrap()
        );
    }
    let (status, body) = call(router, &format!("/v1/offers?limit=2&cursor={cursor}"), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "CURSOR_MISMATCH");
}

#[tokio::test]
async fn list_reads_node_produced_cache_without_mongo() {
    let store = Arc::new(Store::default());
    let key = v1_cache_key(
        "offers.list",
        &BTreeMap::from([
            ("region", json!("US")),
            ("locale", json!("en-US")),
            ("limit", json!(20)),
            ("filters", json!({})),
        ]),
    );
    store.cache.lock().unwrap().insert(key,json!({"offers":[{"id":"node"}],"pagination":{"limit":20,"hasMore":false,"nextCursor":null},"localization":{"locale":"en-US"},"cacheTtl":60}).to_string());
    let (status, body) = call(app(store.clone()), "/v1/offers", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"][0]["id"], "node");
    assert!(store.finds.lock().unwrap().is_empty());
}

#[tokio::test]
async fn detail_uses_whitelist_precedence_and_latest_price_query() {
    for (whitelist, blacklist, eligible) in [
        (json!(["US"]), json!(["US"]), true),
        (json!(["ES"]), json!([]), false),
        (json!([]), json!(["US"]), false),
        (json!([]), json!([]), true),
    ] {
        let mut store = Store::default();
        let mut row = offer("one");
        row.insert("countriesWhitelist", bson::to_bson(&whitelist).unwrap());
        row.insert("countriesBlacklist", bson::to_bson(&blacklist).unwrap());
        store.singles.insert("offers".into(), row);
        let store = Arc::new(store);
        let (status, body) = call(app(store.clone()), "/v1/offers/one", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["data"]["id"], "one");
        let finds = store.finds.lock().unwrap();
        let price = finds.iter().find(|f| f.0 == "pricev2");
        assert_eq!(price.is_some(), eligible);
        if let Some(price) = price {
            assert_eq!(price.2.sort, Some(doc! {"updatedAt":-1}));
            assert_eq!(price.2.limit, Some(1));
        }
    }
}

#[tokio::test]
async fn bulk_validates_trims_deduplicates_and_resolves_all_slug_fields() {
    let mut store = Store::default();
    store.rows.insert("offers".into(),vec![doc!{"id":"a","namespace":"ns","customAttributes":[{"key":"slug","value":"game/home"}]}]);
    let store = Arc::new(store);
    let router = app(store.clone());
    let (status, body) = call(
        router.clone(),
        "/v1/offers/exists",
        Some(json!({"offers":[" a ","a","b"]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["data"],
        json!({"existingOffers":["a"],"nonExistingOffers":["b"]})
    );
    assert_eq!(body["meta"]["requested"], 2);
    {
        let finds = store.finds.lock().unwrap();
        assert_eq!(finds[0].1, doc! {"id":{"$in":["a","b"]}});
        assert_eq!(finds[0].2.projection, Some(doc! {"id":1,"_id":0}));
    }
    let (_, body) = call(
        router.clone(),
        "/v1/offers/slugs",
        Some(json!({"slugs":[" game ","missing","game"]})),
    )
    .await;
    assert_eq!(
        body["data"],
        json!([{"slug":"game","id":"a","namespace":"ns"},{"slug":"missing","id":null,"namespace":null},{"slug":"game","id":"a","namespace":"ns"}])
    );
    assert_eq!(body["meta"]["found"], 2);
    for (endpoint, value) in [
        ("slugs", json!({"slugs":[]})),
        ("slugs", json!({"slugs":["a"],"unknown":true})),
        ("slugs", json!({"slugs":["😀".repeat(151)]})),
        ("exists", json!({"offers":[""]})),
        ("exists", json!({"offers":[42]})),
    ] {
        let (status, body) = call(
            router.clone(),
            &format!("/v1/offers/{endpoint}"),
            Some(value),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["code"], "INVALID_BODY");
    }
}

#[tokio::test]
async fn errors_are_sanitized_and_cached_null_does_not_hide_new_offer() {
    let store = Arc::new(Store::default());
    let router = app(store.clone());
    for endpoint in ["/v1/offers/nope", "/v1/offers/events/nope"] {
        let (status, _) = call(router.clone(), endpoint, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
    let (_, body) = call(router.clone(), "/v1/offers/nope", None).await;
    assert_eq!(body["code"], "OFFER_NOT_FOUND");
    assert_eq!(
        store
            .finds
            .lock()
            .unwrap()
            .iter()
            .filter(|f| f.0 == "offers")
            .count(),
        2
    );
    for endpoint in [
        "/v1/offers?unknown=x",
        "/v1/offers?limit=101",
        "/v1/offers?cursor=bad",
        "/v1/offers?country=BAD",
        "/v1/offers/events?locale=en-US",
    ] {
        let (status, _) = call(router.clone(), endpoint, None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{endpoint}");
    }
    let mut store = Store::default();
    store.failures.insert("offers".into());
    let (status, body) = call(app(Arc::new(store)), "/v1/offers", None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body["code"], "INTERNAL_ERROR");
    assert!(!body.to_string().contains("private database"));
}

#[tokio::test]
async fn discovery_routes_use_source_collections_and_filters() {
    let store = Arc::new(Store::default());
    let router = app(store.clone());
    for path in [
        "events",
        "upcoming",
        "latest-released",
        "genres",
        "top-wishlisted",
        "top-sellers",
        "featured-discounts",
        "latest-achievements",
    ] {
        let (status, body) = call(router.clone(), &format!("/v1/offers/{path}"), None).await;
        assert_eq!(status, StatusCode::OK, "{path}: {body}");
        assert_eq!(body["data"], json!([]));
    }
    let finds = store.finds.lock().unwrap();
    assert!(
        finds
            .iter()
            .any(|f| f.0 == "tags" && f.1 == doc! {"groupName":"event","status":"ACTIVE"})
    );
    assert!(finds.iter().any(|f| {
        f.0 == "offers"
            && f.1
                .get_document("releaseDate")
                .is_ok_and(|d| d.contains_key("$gt") && d.contains_key("$lt"))
    }));
    assert!(
        finds
            .iter()
            .any(|f| f.0 == "game_positions" && f.1.get_str("collectionId") == Ok("top-sellers"))
    );
    assert!(
        finds
            .iter()
            .any(|f| f.0 == "achievementsets" && f.1.get_bool("isBase") == Ok(true))
    );
}

#[tokio::test]
async fn event_pipeline_paginates_discount_and_preserves_title() {
    let mut store = Store::default();
    store
        .singles
        .insert("tags".into(), doc! {"id":"event","name":"Sale"});
    let mut a = offer("one");
    a.insert("sortDiscount", 50);
    store.rows.insert("offers".into(), vec![a, offer("two")]);
    let store = Arc::new(store);
    let router = app(store.clone());
    let (status, body) = call(router.clone(), "/v1/offers/events/event?limit=1", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["meta"]["title"], "Sale");
    let cursor = body["meta"]["pagination"]["nextCursor"].as_str().unwrap();
    let (status, _) = call(
        router,
        &format!("/v1/offers/events/event?limit=1&cursor={cursor}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let pipelines = store.pipelines.lock().unwrap();
    assert_eq!(
        pipelines[0][1]
            .get_document("$lookup")
            .unwrap()
            .get_str("from"),
        Ok("pricev2")
    );
    assert_eq!(
        pipelines[1][4],
        doc! {"$match":{"$or":[{"sortDiscount":{"$lt":50_i64}},{"sortDiscount":50_i64,"id":{"$gt":"one"}},{"sortDiscount":Bson::Null}]}}
    );
}

#[tokio::test]
async fn localized_detail_and_genre_preserve_projection_and_image_metadata() {
    let mut store = Store::default();
    let mut row = offer("one");
    row.insert(
        "keyImages",
        vec![
            doc! {"type":"Thumbnail","url":"thumb"},
            doc! {"type":"OfferImageTall","url":"tall","width":100},
        ],
    );
    store.singles.insert("offers".into(), row.clone());
    store.rows.insert("offers".into(), vec![row]);
    store
        .rows
        .insert("tags".into(), vec![doc! {"id":"genre","name":"Action"}]);
    store.rows.insert("egs_localizations".into(),vec![doc!{"entityType":"offer","entityId":"ns:one","locale":"es-ES","source":"epic","fetchedAt":bson::DateTime::parse_rfc3339_str("2026-01-01T00:00:00Z").unwrap(),"data":{"title":"Traducido","description":"Localized description"}}]);
    let store = Arc::new(store);
    let router = app(store.clone());
    let (status, body) = call(router.clone(), "/v1/offers/one?locale=es-ES", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["title"], "Traducido");
    assert_eq!(body["data"]["description"], "Localized description");
    assert_eq!(body["meta"]["localeStatus"], "localized");
    let (status, body) = call(router, "/v1/offers/genres?locale=es-ES", None).await;
    assert_eq!(status, StatusCode::OK);
    let genre = &body["data"][0]["offers"][0];
    assert_eq!(genre["title"], "Traducido");
    assert!(genre.get("namespace").is_none());
    assert!(genre.get("description").is_none());
    assert_eq!(
        genre["image"],
        json!({"type":"OfferImageTall","url":"tall","width":100})
    );
    assert!(
        store
            .finds
            .lock()
            .unwrap()
            .iter()
            .any(|f| f.0 == "egs_localizations"
                && f.1
                    == doc! {"entityType":"offer","entityId":{"$in":["ns:one"]},"locale":"es-ES"})
    );
}

#[tokio::test]
async fn ranked_lists_preserve_position_order_and_skip_missing_offers() {
    let mut store = Store::default();
    store.rows.insert(
        "game_positions".into(),
        vec![
            doc! {"offerId":"two","position":1},
            doc! {"offerId":"missing","position":2},
            doc! {"offerId":"one","position":3},
        ],
    );
    store
        .rows
        .insert("offers".into(), vec![offer("one"), offer("two")]);
    let store = Arc::new(store);
    let (status, body) = call(app(store.clone()), "/v1/offers/top-sellers?limit=3", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"][0]["id"], "two");
    assert_eq!(body["data"][0]["position"], 1);
    assert_eq!(body["data"][1]["id"], "one");
    assert_eq!(body["data"][1]["position"], 3);
    assert_eq!(body["meta"]["pagination"]["hasMore"], false);
    let finds = store.finds.lock().unwrap();
    assert_eq!(finds[0].2.sort, Some(doc! {"position":1,"offerId":1}));
    assert_eq!(finds[1].1, doc! {"id":{"$in":["two","missing","one"]}});
}

#[tokio::test]
async fn featured_intersects_prices_and_positions_and_sorts_result() {
    let mut store = Store::default();
    store.rows.insert(
        "game_positions".into(),
        vec![
            doc! {"offerId":"two","position":1},
            doc! {"offerId":"one","position":3},
            doc! {"offerId":"no-price","position":2},
        ],
    );
    store.rows.insert(
        "offers".into(),
        vec![offer("one"), offer("no-price"), offer("two")],
    );
    store.rows.insert(
        "pricev2".into(),
        vec![
            doc! {"offerId":"one","price":{"discount":10}},
            doc! {"offerId":"two","price":{"discount":20}},
        ],
    );
    let store = Arc::new(store);
    let (status, body) = call(app(store.clone()), "/v1/offers/featured-discounts", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["meta"]["count"], 2);
    assert_eq!(body["data"][0]["id"], "two");
    assert_eq!(body["data"][1]["id"], "one");
    assert_eq!(body["data"][0]["position"], 1);
    assert!(
        store
            .finds
            .lock()
            .unwrap()
            .iter()
            .any(|f| f.0 == "pricev2" && f.1.get_document("price.discount") == Ok(&doc! {"$gt":0}))
    );
}

#[tokio::test]
async fn achievements_tolerate_optional_service_failure_but_not_offer_failure() {
    let mut store = Store::default();
    store.rows.insert("offers".into(), vec![offer("one")]);
    store.rows.insert(
        "achievementsets".into(),
        vec![doc! {"sandboxId":"ns","isBase":true,"count":5}],
    );
    store.failures.insert("pricev2".into());
    let (status, body) = call(app(Arc::new(store)), "/v1/offers/latest-achievements", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"][0]["achievements"]["count"], 5);
    assert_eq!(body["data"][0]["price"], Value::Null);
    let mut store = Store::default();
    store.rows.insert("offers".into(), vec![offer("one")]);
    store.failures.insert("achievementsets".into());
    let (status, body) = call(app(Arc::new(store)), "/v1/offers/latest-achievements", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"], json!([]));
}

#[tokio::test]
async fn bulk_content_type_and_json_errors_use_problem_envelope() {
    let store = Arc::new(Store::default());
    let router = app(store.clone());
    for (ctype, payload, status, code) in [
        ("text/plain", "{}", 415, "UNSUPPORTED_MEDIA_TYPE"),
        ("application/json", "{", 400, "MALFORMED_JSON"),
    ] {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/offers/exists")
                    .header("x-egdata-key-id", "key_test1234")
                    .header("x-egdata-key-tier", "free")
                    .header("content-type", ctype)
                    .body(Body::from(payload))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), status);
        assert_eq!(
            response.headers()["content-type"],
            "application/problem+json"
        );
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body["code"], code);
    }
    assert!(store.finds.lock().unwrap().is_empty());
}
