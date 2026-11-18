use super::*;
use async_trait::async_trait;
use egdata_core::{
    error::CoreError,
    ports::{EpicStorePort, MongoDocumentStream, ResponseCachePort},
};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

struct Replay {
    name: String,
    reads: Mutex<VecDeque<Value>>,
}

impl Replay {
    fn next(
        &self,
        method: &str,
        collection: &str,
        filter: Value,
        options: Value,
    ) -> Result<Value, CoreError> {
        let mut remaining = self.reads.lock().unwrap();
        let mut expected = remaining.pop_front().ok_or_else(|| {
            CoreError::Internal(format!("{} unexpected {method} {collection}", self.name))
        })?;
        let failed = expected
            .as_object_mut()
            .unwrap()
            .shift_remove("error")
            .is_some();
        let result = expected
            .as_object_mut()
            .unwrap()
            .shift_remove("result")
            .unwrap();
        // BSON relaxed Extended JSON omits zero milliseconds that JS Date.toISOString emits.
        expected["filter"] = Bson::try_from(expected["filter"].clone())
            .unwrap()
            .into_relaxed_extjson();
        assert_eq!(
            json!({"method":method,"collection":collection,"filter":filter,"options":options}),
            expected,
            "{}",
            self.name
        );
        if failed {
            return Err(CoreError::Internal("fixture database failure".into()));
        }
        Ok(result)
    }
}

fn as_document(value: &Value) -> Document {
    Bson::try_from(value.clone())
        .unwrap()
        .as_document()
        .unwrap()
        .clone()
}
fn as_rows(value: Value) -> Vec<Document> {
    value.as_array().unwrap().iter().map(as_document).collect()
}
fn filter(doc: Document) -> Value {
    Bson::Document(doc).into_relaxed_extjson()
}

#[async_trait]
impl MongoStorePort for Replay {
    async fn find_one(
        &self,
        collection: &str,
        query: Document,
        projection: Option<Document>,
    ) -> Result<Option<Document>, CoreError> {
        let mut opts = json!({});
        if let Some(projection) = projection {
            opts["projection"] = filter(projection);
        }
        let row = self.next("findOne", collection, filter(query), opts)?;
        Ok((!row.is_null()).then(|| as_document(&row)))
    }
    async fn find_many(
        &self,
        collection: &str,
        query: Document,
        options: MongoFindOptions,
    ) -> Result<Vec<Document>, CoreError> {
        let mut opts = json!({});
        if let Some(p) = options.projection {
            opts["projection"] = filter(p);
        }
        if let Some(p) = options.sort {
            opts["sort"] = filter(p);
        }
        if let Some(p) = options.limit {
            opts["limit"] = json!(p);
        }
        if let Some(p) = options.skip {
            opts["skip"] = json!(p);
        }
        Ok(as_rows(self.next(
            "find",
            collection,
            filter(query),
            opts,
        )?))
    }
    async fn aggregate(
        &self,
        collection: &str,
        pipeline: Vec<Document>,
    ) -> Result<Vec<Document>, CoreError> {
        Ok(as_rows(self.next(
            "aggregate",
            collection,
            Value::Array(pipeline.into_iter().map(filter).collect()),
            json!({}),
        )?))
    }
    async fn count_documents(&self, collection: &str, query: Document) -> Result<u64, CoreError> {
        Ok(self
            .next("count", collection, filter(query), json!({}))?
            .as_u64()
            .unwrap())
    }
    async fn find_stream(
        &self,
        _: &str,
        _: Document,
        _: MongoFindOptions,
    ) -> Result<MongoDocumentStream, CoreError> {
        Ok(Box::pin(futures::stream::empty()))
    }
    async fn distinct(&self, _: &str, _: &str, _: Document) -> Result<Vec<Bson>, CoreError> {
        Ok(vec![])
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

#[async_trait]
impl ResponseCachePort for Replay {
    async fn get(&self, _: &str) -> Result<Option<String>, CoreError> {
        Ok(None)
    }
    async fn set(&self, _: &str, _: &str, _: u64) -> Result<(), CoreError> {
        Ok(())
    }
    async fn del(&self, _: &str) -> Result<(), CoreError> {
        Ok(())
    }
    async fn ping(&self) -> Result<bool, CoreError> {
        Ok(true)
    }
}
#[async_trait]
impl EpicStorePort for Replay {
    async fn graphql(&self, _: &str, _: &Value) -> Result<Value, CoreError> {
        Ok(Value::Null)
    }
    async fn featured_games(&self) -> Result<Vec<Value>, CoreError> {
        Ok(vec![])
    }
}

#[tokio::test]
async fn offer_fields_propagate_each_database_failure() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../oracles/graphql-offers-node.json"
    ))
    .unwrap();
    for case in fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| case.get("error").is_none())
    {
        let trace = case["trace"].as_array().unwrap();
        for failed in 0..trace.len() {
            let mut steps = trace.clone();
            steps[failed]["error"] = json!(true);
            let replay = Arc::new(Replay {
                name: case["name"].as_str().unwrap().to_owned(),
                reads: Mutex::new(steps.into()),
            });
            let mut services = GraphqlServices::new(replay.clone(), replay.clone(), replay);
            services.now = || "2025-01-10T05:00:00Z".parse().unwrap();
            let err = crate::resolvers::resolve(
                case["parentType"].as_str().unwrap(),
                case["field"].as_str().unwrap(),
                &case["parent"],
                &case["args"],
                &services,
            )
            .await
            .unwrap_err();
            assert!(err.message.contains("fixture database failure"), "{err:?}");
        }
    }
}
#[tokio::test]
async fn offer_resolvers_node_oracle() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../oracles/graphql-offers-node.json"
    ))
    .unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let replay = Arc::new(Replay {
            name: case["name"].as_str().unwrap().into(),
            reads: Mutex::new(case["trace"].as_array().unwrap().clone().into()),
        });
        let mut services = GraphqlServices::new(replay.clone(), replay.clone(), replay.clone());
        services.now = || "2025-01-10T05:00:00Z".parse().unwrap();
        let result = resolve(
            case["parentType"].as_str().unwrap(),
            case["field"].as_str().unwrap(),
            &case["parent"],
            &case["args"],
            &services,
        )
        .await;
        let name = &replay.name;
        if let Some(expected) = case.get("error") {
            let error = result.unwrap_err();
            let extensions = error
                .extensions
                .map(|ext| json!(ext))
                .unwrap_or_else(|| json!({}));
            assert_eq!(
                json!({"message":error.message,"extensions":extensions}),
                *expected,
                "{name}"
            );
        } else {
            assert_eq!(result.unwrap().unwrap(), case["expected"], "{name}");
        }
        assert!(
            replay.reads.lock().unwrap().is_empty(),
            "{name} unused reads"
        );
    }

    // Exercise unused trait methods on Replay and edge cases in offers/discovery/relationships.
    let dummy = Arc::new(Replay {
        name: "dummy".into(),
        reads: Mutex::new(VecDeque::new()),
    });
    let error = dummy
        .next("find", "offers", json!({}), json!({}))
        .unwrap_err()
        .to_string();
    assert!(error.contains("dummy unexpected find offers"));

    assert!(
        dummy
            .find_stream("c", Document::new(), Default::default())
            .await
            .is_ok()
    );
    assert!(dummy.distinct("c", "f", Document::new()).await.is_ok());
    assert!(dummy.insert_one("c", Document::new()).await.is_ok());
    assert!(
        dummy
            .update_one("c", Document::new(), Document::new(), false)
            .await
            .is_ok()
    );
    assert!(dummy.delete_one("c", Document::new()).await.is_ok());
    assert!(MongoStorePort::ping(dummy.as_ref()).await.unwrap());
    assert!(
        ResponseCachePort::get(dummy.as_ref(), "k")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        ResponseCachePort::set(dummy.as_ref(), "k", "v", 1)
            .await
            .is_ok()
    );
    assert!(ResponseCachePort::del(dummy.as_ref(), "k").await.is_ok());
    assert!(ResponseCachePort::ping(dummy.as_ref()).await.unwrap());
    assert!(dummy.graphql("q", &Value::Null).await.is_ok());
    assert!(dummy.featured_games().await.unwrap().is_empty());

    // Direct unit checks for offers edge cases: projection without __selectedFields,
    // empty entity_ids localization, duplicate prices, sourceUpdatedAt metadata, internal_error.
    assert_eq!(
        offer_projection(&json!({})),
        doc! {"id": 1, "_id": 1, "namespace": 1}
    );
    assert_eq!(internal_error("boom").message, "boom");

    let empty_loc = localize_offers(dummy.as_ref(), vec![json!({"title": "No ID or NS"})], "es")
        .await
        .unwrap();
    assert_eq!(empty_loc.len(), 1);

    let loc_replay = Arc::new(Replay {
        name: "loc-meta-and-dup-prices".into(),
        reads: Mutex::new(
            vec![
                json!({
                    "method": "find",
                    "collection": "offers",
                    "filter": {},
                    "options": { "limit": 10, "skip": 0, "sort": { "lastModifiedDate": -1 } },
                    "result": [{ "id": "o1", "namespace": "ns1", "title": "Base" }]
                }),
                json!({
                    "method": "find",
                    "collection": "pricev2",
                    "filter": { "offerId": { "$in": ["o1"] }, "region": "US" },
                    "options": {},
                    "result": [
                        { "region": "US" },
                        { "offerId": "o1", "region": "US", "price": { "discount": 0 } },
                        { "offerId": "o1", "region": "US", "price": { "discount": 10 } }
                    ]
                }),
                json!({
                    "method": "find",
                    "collection": "egs_localizations",
                    "filter": { "entityType": "offer", "entityId": { "$in": ["ns1:o1"] }, "locale": "es" },
                    "options": {},
                    "result": [{
                        "entityType": "offer",
                        "entityId": "ns1:o1",
                        "locale": "es",
                        "source": "egs",
                        "data": { "title": "Localizado" },
                        "fetchedAt": "2025-01-01T00:00:00.000Z",
                        "sourceUpdatedAt": "2025-01-02T00:00:00.000Z"
                    }]
                }),
                json!({
                    "method": "count",
                    "collection": "offers",
                    "filter": {},
                    "options": {},
                    "result": 1
                }),
            ]
            .into(),
        ),
    });
    let loc_services =
        GraphqlServices::new(loc_replay.clone(), loc_replay.clone(), loc_replay.clone());
    let res = resolve(
        "Query",
        "offers",
        &Value::Null,
        &json!({"locale": "es"}),
        &loc_services,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(res["elements"][0]["title"], "Localizado");
    assert_eq!(
        res["elements"][0]["localization"]["sourceUpdatedAt"],
        "2025-01-02T00:00:00.000Z"
    );

    // Offer.ratings returns null when sandbox has no parent.
    let ratings_replay = Arc::new(Replay {
        name: "ratings-no-parent".into(),
        reads: Mutex::new(
            vec![json!({
                "method": "findOne",
                "collection": "sandboxes",
                "filter": { "_id": "ns-no-parent" },
                "options": {},
                "result": { "_id": "ns-no-parent" }
            })]
            .into(),
        ),
    });
    let ratings_services = GraphqlServices::new(
        ratings_replay.clone(),
        ratings_replay.clone(),
        ratings_replay.clone(),
    );
    assert_eq!(
        resolve(
            "Offer",
            "ratings",
            &json!({"namespace": "ns-no-parent"}),
            &json!({}),
            &ratings_services,
        )
        .await
        .unwrap(),
        Some(Value::Null)
    );

    // latestAchievements breaks cleanly when page 2 returns empty.
    let la_replay = Arc::new(Replay {
        name: "latest-achievements-empty-p2".into(),
        reads: Mutex::new(
            vec![
                json!({
                    "method": "find",
                    "collection": "offers",
                    "filter": {
                        "offerType": { "$in": ["BASE_GAME"] },
                        "tags.id": "19847",
                        "effectiveDate": { "$lte": { "$date": "2025-01-10T05:00:00Z" } }
                    },
                    "options": { "sort": { "effectiveDate": -1 }, "skip": 0, "limit": 15 },
                    "result": (0..15).map(|i| json!({"id": format!("o{i}"), "namespace": format!("ns{i}")})).collect::<Vec<_>>()
                }),
                json!({
                    "method": "find",
                    "collection": "achievementsets",
                    "filter": { "sandboxId": { "$in": (0..15).map(|i| format!("ns{i}")).collect::<Vec<_>>() }, "isBase": true },
                    "options": {},
                    "result": []
                }),
                json!({
                    "method": "find",
                    "collection": "pricev2",
                    "filter": { "offerId": { "$in": (0..15).map(|i| format!("o{i}")).collect::<Vec<_>>() }, "region": "US" },
                    "options": {},
                    "result": []
                }),
                json!({
                    "method": "find",
                    "collection": "offers",
                    "filter": {
                        "offerType": { "$in": ["BASE_GAME"] },
                        "tags.id": "19847",
                        "effectiveDate": { "$lte": { "$date": "2025-01-10T05:00:00Z" } }
                    },
                    "options": { "sort": { "effectiveDate": -1 }, "skip": 15, "limit": 15 },
                    "result": []
                }),
            ]
            .into(),
        ),
    });
    let mut la_services =
        GraphqlServices::new(la_replay.clone(), la_replay.clone(), la_replay.clone());
    la_services.now = || "2025-01-10T05:00:00Z".parse().unwrap();
    assert_eq!(
        resolve(
            "Query",
            "latestAchievements",
            &Value::Null,
            &json!({}),
            &la_services
        )
        .await
        .unwrap(),
        Some(json!([]))
    );
}
