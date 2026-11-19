#[derive(Default)]
struct SandboxCache {
    values: Mutex<HashMap<String, String>>,
    gets: Mutex<Vec<String>>,
    sets: Mutex<Vec<(String, Value, u64)>>,
}
#[async_trait]
impl egdata_core::ports::ResponseCachePort for SandboxCache {
    async fn get(&self, key: &str) -> Result<Option<String>, CoreError> {
        self.gets.lock().unwrap().push(key.into());
        Ok(self.values.lock().unwrap().get(key).cloned())
    }
    async fn set(&self, key: &str, value: &str, ttl: u64) -> Result<(), CoreError> {
        self.values.lock().unwrap().insert(key.into(), value.into());
        self.sets
            .lock()
            .unwrap()
            .push((key.into(), serde_json::from_str(value).unwrap(), ttl));
        Ok(())
    }
    async fn del(&self, _: &str) -> Result<(), CoreError> {
        Ok(())
    }
    async fn ping(&self) -> Result<bool, CoreError> {
        Ok(true)
    }
}
fn sandbox_app(mongo: Arc<RecordingMongo>, cache: Arc<SandboxCache>) -> axum::Router {
    let mut state =
        crate::middleware::test_support::test_app_state(crate::state::ApiConfig::default());
    state.mongo = mongo;
    state.cache = cache;
    route_group("/v1").router.with_state(state)
}
fn sandbox_mongo() -> RecordingMongo {
    RecordingMongo {
        one_docs: HashMap::from([("sandboxes".into(), Some(doc! {"_id":"ns"}))]),
        ..Default::default()
    }
}
async fn sandbox_get(app: &axum::Router, uri: &str) -> (axum::http::StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    (response.status(), json_body(response).await)
}

#[tokio::test]
async fn sandbox_detail_and_item_reads_match_catalog_node_oracle() {
    let fixture: Vec<Value> = serde_json::from_str(include_str!(
        "../../../tests/fixtures/catalog-reads-http-node.json"
    ))
    .unwrap();
    for expected in fixture.iter().filter(|case| {
        case["request"]["path"]
            .as_str()
            .unwrap()
            .starts_with("/v1/sandboxes")
    }) {
        let name = expected["name"].as_str().unwrap();
        let input = &expected["input"];
        let mut one_docs = HashMap::new();
        one_docs.insert(
            "sandboxes".into(),
            input["sandbox"]
                .as_object()
                .map(|v| bson::to_document(v).unwrap()),
        );
        one_docs.insert(
            "namespaces".into(),
            input["namespace"]
                .as_object()
                .map(|v| bson::to_document(v).unwrap()),
        );
        one_docs.insert(
            "items".into(),
            input["item"]
                .as_object()
                .map(|v| bson::to_document(v).unwrap()),
        );
        let items = input["items"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|v| bson::to_document(v).unwrap())
            .collect();
        let docs = |key: &str| {
            input[key]
                .as_array()
                .into_iter()
                .flatten()
                .map(|v| bson::to_document(v).unwrap())
                .collect::<Vec<_>>()
        };
        let mongo = Arc::new(RecordingMongo {
            one_docs,
            many_by_collection: HashMap::from([
                ("items".into(), items),
                ("namespaces".into(), docs("namespaces")),
                ("offers".into(), docs("offers")),
                ("pricev2".into(), docs("prices")),
                ("assets".into(), docs("assets")),
                ("achievementsets".into(), docs("achievements")),
                ("builds".into(), docs("builds")),
            ]),
            aggregate_docs: docs("changelogs"),
            ..Default::default()
        });
        let app = sandbox_app(mongo.clone(), Arc::new(SandboxCache::default()));
        let mut request = Request::builder()
            .uri(expected["request"]["path"].as_str().unwrap())
            .body(Body::empty())
            .unwrap();
        request
            .extensions_mut()
            .insert(crate::v1::helpers::V1RequestContext {
                request_id: "req_node_oracle".into(),
                key: None,
            });
        let response = app.oneshot(request).await.unwrap();
        let actual = crate::v1::oracle_test_support::capture_response(response).await;
        assert_eq!(actual, expected["response"], "{name}");
        if name == "sandbox-items-filtered" {
            let calls = mongo.many_calls.lock().unwrap();
            let (collection, filter, options) = &calls[0];
            assert_eq!(collection, "items");
            assert_eq!(
                filter,
                &doc! {
                    "namespace":"sandbox-a",
                    "entitlementType":{"$in":["EXECUTABLE"]},
                    "releaseInfo":{"$elemMatch":{"platform":{"$in":["Windows"]}}},
                    "title":{"$regex":"Sandbox","$options":"i"},
                }
            );
            assert_eq!(options.limit, Some(21));
            assert_eq!(options.sort, Some(doc! {"lastModifiedDate":-1,"id":1}));
        }
        if name == "sandboxes-list-populated" {
            let calls = mongo.many_calls.lock().unwrap();
            let (collection, filter, options) = &calls[0];
            assert_eq!(collection, "namespaces");
            assert_eq!(filter, &Document::new());
            assert_eq!(options.limit, Some(6));
            assert_eq!(options.sort, Some(doc! {"_id":1}));
        }
    }
}

#[tokio::test]
async fn sandbox_node_cache_payloads_skip_loaders_and_do_not_refresh_ttl() {
    // Literal keys/payloads reflect the cached() calls in src/v1/routes/sandboxes.ts.
    let pagination = json!({"limit":20,"hasMore":false,"nextCursor":null});
    let cases = [
        (
            "/v1/sandboxes",
            "v1:sandboxes.list:limit=20",
            json!({"data":[{"_id":"ns"}],"pagination":pagination}),
            json!([{"_id":"ns"}]),
        ),
        (
            "/v1/sandboxes/ns",
            "v1:sandboxes.detail:sandboxId=\"ns\"",
            json!({"document":{"_id":"ns"},"source":"sandbox"}),
            json!({"_id":"ns"}),
        ),
        (
            "/v1/sandboxes/ns/items",
            "v1:sandboxes.items:limit=20:sandboxId=\"ns\"",
            json!({"data":[{"id":"i"}],"pagination":pagination}),
            json!([{"id":"i"}]),
        ),
        (
            "/v1/sandboxes/ns/offers",
            "v1:sandboxes.offers:limit=20:locale=\"en-US\":region=\"US\":sandboxId=\"ns\"",
            json!({"offers":[{"id":"o"}],"pagination":pagination,"localization":{}}),
            json!([{"id":"o"}]),
        ),
        (
            "/v1/sandboxes/ns/assets",
            "v1:sandboxes.assets:sandboxId=\"ns\"",
            json!([{"artifactId":"a","platform":"Windows"}]),
            json!([{"artifactId":"a","platform":"Windows"}]),
        ),
        (
            "/v1/sandboxes/ns/base-game",
            "v1:sandboxes.base-game:locale=\"en-US\":region=\"US\":sandboxId=\"ns\"",
            json!({"kind":"item","data":{"id":"i","isItem":true},"localization":{}}),
            json!({"id":"i","isItem":true}),
        ),
        (
            "/v1/sandboxes/ns/achievements",
            "v1:sandboxes.achievements:sandboxId=\"ns\"",
            json!([{"sandboxId":"ns"}]),
            json!([{"sandboxId":"ns"}]),
        ),
        (
            "/v1/sandboxes/ns/changelog",
            "v1:sandboxes.changelog:limit=20:sandboxId=\"ns\"",
            json!({"hits":[{"metadata":{"context":null}}],"pagination":pagination}),
            json!({"hits":[{"metadata":{"context":null}}]}),
        ),
        (
            "/v1/sandboxes/ns/builds",
            "v1:sandboxes.builds:limit=20:sandboxId=\"ns\"",
            json!({"data":[{"appName":"a"}],"pagination":pagination}),
            json!([{"appName":"a"}]),
        ),
        (
            "/v1/sandboxes/ns/stats",
            "v1:sandboxes.stats:sandboxId=\"ns\"",
            json!({"offers":7,"items":4,"assets":3,"builds":2,"achievements":1}),
            json!({"offers":7,"items":4,"assets":3,"builds":2,"achievements":1}),
        ),
    ];
    for (uri, key, payload, data) in cases {
        let mongo = Arc::new(sandbox_mongo());
        let cache = Arc::new(SandboxCache::default());
        let is_subresource = uri != "/v1/sandboxes" && uri != "/v1/sandboxes/ns";
        if is_subresource {
            cache.values.lock().unwrap().insert(
                "v1:sandboxes.exists:sandboxId=\"ns\"".into(),
                "true".into(),
            );
        }
        cache
            .values
            .lock()
            .unwrap()
            .insert(key.into(), payload.to_string());
        let (status, body) = sandbox_get(&sandbox_app(mongo.clone(), cache.clone()), uri).await;
        assert_eq!(status, 200, "{uri}: {body}");
        assert_eq!(body["data"], data, "{uri}");
        let expected_gets = if is_subresource {
            vec!["v1:sandboxes.exists:sandboxId=\"ns\"", key]
        } else {
            vec![key]
        };
        assert_eq!(*cache.gets.lock().unwrap(), expected_gets, "{uri}");
        assert!(cache.sets.lock().unwrap().is_empty(), "{uri}");
        assert!(mongo.many_calls.lock().unwrap().is_empty(), "{uri}");
        assert!(mongo.aggregate_calls.lock().unwrap().is_empty(), "{uri}");
        assert!(mongo.count_calls.lock().unwrap().is_empty(), "{uri}");
        assert!(mongo.one_calls.lock().unwrap().is_empty(), "{uri}");
    }
}

#[tokio::test]
async fn sandbox_stats_counts_virtual_assets_and_caches_the_source_shape() {
    let mongo = Arc::new(RecordingMongo {
        many_by_collection: HashMap::from([
            (
                "items".into(),
                vec![
                    doc! {"releaseInfo":[{"appId":"real","platform":["Windows"]},{"appId":"virtual","platform":["Windows","Mac",7]},{"appId":"virtual","platform":["Linux"]}]},
                ],
            ),
            (
                "assets".into(),
                vec![doc! {"artifactId":"real"}, doc! {"artifactId":"other"}],
            ),
            (
                "achievementsets".into(),
                vec![doc! {"achievements":[{},{}]}],
            ),
        ]),
        ..sandbox_mongo()
    });
    let cache = Arc::new(SandboxCache::default());
    let app = sandbox_app(mongo.clone(), cache.clone());
    let (status, body) = sandbox_get(&app, "/v1/sandboxes/ns/stats").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["data"],
        json!({"offers":0,"items":1,"assets":6,"builds":0,"achievements":2})
    );
    assert_eq!(
        mongo.count_calls.lock().unwrap()[1],
        ("builds".into(), doc! {"appName":{"$in":["real","virtual"]}})
    );
    let sets = cache.sets.lock().unwrap().clone();
    assert_eq!(
        sets,
        vec![
            (
                "v1:sandboxes.exists:sandboxId=\"ns\"".into(),
                json!(true),
                300
            ),
            (
                "v1:sandboxes.stats:sandboxId=\"ns\"".into(),
                body["data"].clone(),
                300
            )
        ]
    );
    let (_, again) = sandbox_get(&app, "/v1/sandboxes/ns/stats").await;
    assert_eq!(again["data"], body["data"]);
    assert_eq!(mongo.one_calls.lock().unwrap().len(), 1);
    assert_eq!(mongo.count_calls.lock().unwrap().len(), 2);
    assert_eq!(mongo.many_calls.lock().unwrap().len(), 3);
    assert_eq!(cache.sets.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn sandbox_assets_share_cache_across_pages_and_cache_existence() {
    let mongo = Arc::new(sandbox_mongo());
    let cache = Arc::new(SandboxCache::default());
    let rows = json!([
        {"artifactId":"a","platform":"Windows","updatedAt":"2025-01-01T00:00:00.000Z"},
        {"artifactId":"b","platform":"Windows","updatedAt":null},
        {"artifactId":null,"platform":"Windows","updatedAt":null}
    ]);
    cache.values.lock().unwrap().insert(
        "v1:sandboxes.assets:sandboxId=\"ns\"".into(),
        rows.to_string(),
    );
    let app = sandbox_app(mongo.clone(), cache.clone());
    let (_, first) = sandbox_get(&app, "/v1/sandboxes/ns/assets?limit=1").await;
    assert_eq!(first["data"], json!([rows[0]]));
    let cursor = first["meta"]["pagination"]["nextCursor"].as_str().unwrap();
    let (status, second) = sandbox_get(
        &app,
        &format!("/v1/sandboxes/ns/assets?limit=1&cursor={cursor}"),
    )
    .await;
    assert_eq!(status, 200, "{second}");
    assert_eq!(second["data"], json!([rows[1]]));
    assert_eq!(mongo.one_calls.lock().unwrap().len(), 1);
    assert!(mongo.many_calls.lock().unwrap().is_empty());
    assert_eq!(
        *cache.sets.lock().unwrap(),
        vec![(
            "v1:sandboxes.exists:sandboxId=\"ns\"".into(),
            json!(true),
            300
        )]
    );
    cache
        .values
        .lock()
        .unwrap()
        .remove("v1:sandboxes.exists:sandboxId=\"ns\"");
    let (status, _) = sandbox_get(
        &sandbox_app(Arc::new(RecordingMongo::default()), cache.clone()),
        "/v1/sandboxes/ns/assets",
    )
    .await;
    assert_eq!(status, 404);
    assert_eq!(cache.gets.lock().unwrap().len(), 5);
}

#[tokio::test]
async fn sandbox_hex_namespace_cursor_stays_a_string_and_bounds_fail_before_io() {
    let id = "507f1f77bcf86cd799439011";
    let mongo = Arc::new(RecordingMongo {
        many_docs: vec![doc! {"_id":id}, doc! {"_id":"z"}],
        ..Default::default()
    });
    let app = sandbox_app(mongo.clone(), Arc::new(SandboxCache::default()));
    let (_, first) = sandbox_get(&app, "/v1/sandboxes?limit=1").await;
    let cursor = first["meta"]["pagination"]["nextCursor"].as_str().unwrap();
    let (status, body) = sandbox_get(&app, &format!("/v1/sandboxes?limit=1&cursor={cursor}")).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        mongo.many_calls.lock().unwrap()[1].1,
        doc! {"$or":[{"_id":{"$gt":id}},{"_id":Bson::Null}]}
    );
    let (status, body) = sandbox_get(
        &app,
        &format!("/v1/sandboxes/ns/items?title={}", "a".repeat(201)),
    )
    .await;
    assert_eq!(status, 400);
    assert_eq!(body["errors"][0]["code"], "TOO_BIG");
    assert!(mongo.one_calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn sandbox_merged_assets_match_executed_node_helper_fixtures() {
    let fixtures: Vec<Value> =
        serde_json::from_str(include_str!("../../../tests/fixtures/sandbox-assets.json")).unwrap();
    for fixture in fixtures {
        let input = &fixture["input"];
        let docs = |key: &str| {
            input[key]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| bson::to_document(v).unwrap())
                .collect()
        };
        let mongo = Arc::new(RecordingMongo {
            many_by_collection: HashMap::from([
                ("items".into(), docs("items")),
                ("assets".into(), docs("assets")),
            ]),
            ..sandbox_mongo()
        });
        let cache = Arc::new(SandboxCache::default());
        let mut uri = "/v1/sandboxes/ns/assets?limit=100".to_owned();
        if let Some(platforms) = input["platforms"].as_array() {
            uri.push_str("&platform=");
            uri.push_str(
                &platforms
                    .iter()
                    .map(|v| v.as_str().unwrap())
                    .collect::<Vec<_>>()
                    .join(","),
            );
        }
        let (status, body) = sandbox_get(&sandbox_app(mongo.clone(), cache.clone()), &uri).await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["data"], fixture["output"], "{input}");
        assert_eq!(cache.sets.lock().unwrap()[0].2, 300);
        for query in fixture["queries"].as_array().unwrap() {
            let calls = mongo.many_calls.lock().unwrap();
            let call = calls
                .iter()
                .find(|c| c.0 == query["collection"].as_str().unwrap())
                .unwrap();
            assert_eq!(serde_json::to_value(&call.1).unwrap(), query["args"][0]);
            assert_eq!(
                serde_json::to_value(&call.2.projection).unwrap(),
                query["args"].get(1).cloned().unwrap_or(Value::Null)
            );
        }
    }
}

#[tokio::test]
async fn sandbox_changelog_reuses_context_cache_hydrates_rows_and_binds_bson_cursor() {
    let oid = bson::oid::ObjectId::parse_str("507f1f77bcf86cd799439011").unwrap();
    let mongo = Arc::new(RecordingMongo {
        aggregate_docs: vec![
            doc! {"_id":oid,"timestamp":bson::DateTime::from_millis(0),"metadata":{"contextType":"offer","contextId":"offer"}},
            doc! {"_id":bson::oid::ObjectId::new(),"timestamp":bson::DateTime::from_millis(0)},
        ],
        one_docs: HashMap::from([
            ("sandboxes".into(), Some(doc! {"_id":"ns"})),
            ("offers".into(), Some(doc! {"id":"offer","title":"Game"})),
        ]),
        ..Default::default()
    });
    let cache = Arc::new(SandboxCache::default());
    cache.values.lock().unwrap().insert(
        "v1:sandboxes.changelog.context:sandboxId=\"ns\"".into(),
        json!(["ns", "offer"]).to_string(),
    );
    let app = sandbox_app(mongo.clone(), cache.clone());
    let (status, first) = sandbox_get(&app, "/v1/sandboxes/ns/changelog?limit=1").await;
    assert_eq!(status, 200, "{first}");
    assert_eq!(
        first["data"]["hits"][0]["metadata"]["context"],
        json!({"id":"offer","title":"Game"})
    );
    assert!(mongo.many_calls.lock().unwrap().is_empty());
    assert_eq!(cache.sets.lock().unwrap()[0].2, 300);
    assert_eq!(cache.sets.lock().unwrap()[1].2, 60);
    let cursor = first["meta"]["pagination"]["nextCursor"].as_str().unwrap();
    let (status, second) = sandbox_get(
        &app,
        &format!("/v1/sandboxes/ns/changelog?limit=1&cursor={cursor}"),
    )
    .await;
    assert_eq!(status, 200, "{second}");
    let calls = mongo.aggregate_calls.lock().unwrap();
    assert_eq!(
        calls[0].1[0],
        doc! {"$match":{"metadata.contextId":{"$in":["ns","offer"]}}}
    );
    let filter = calls[1].1[0]
        .get_document("$match")
        .unwrap()
        .get_array("$and")
        .unwrap();
    let date = bson::DateTime::from_millis(0);
    assert_eq!(
        filter[1],
        Bson::Document(doc! {"$or":[
            {"timestamp":{"$lt":date}},
            {"timestamp":Bson::Null},
            {"$and":[{"timestamp":{"$eq":date}},{"_id":{"$lt":oid}}]},
            {"$and":[{"timestamp":{"$eq":date}},{"_id":Bson::Null}]}
        ]})
    );
}

#[test]
fn sandbox_build_summary_uses_nullish_fallbacks() {
    let summary = build_summary(
        &json!({"_id":"b","labelName":"Live-Windows","firstSeenAt":null,"createdAt":"2025-01-01","lastSeenAt":null,"updatedAt":"2025-01-02","sourceManifestHash":null,"hash":"hash","manifestStatus":null,"technologies":null}),
        None,
    );
    assert_eq!(summary["firstSeenAt"], "2025-01-01");
    assert_eq!(summary["lastSeenAt"], "2025-01-02");
    assert_eq!(summary["manifest"]["sourceHash"], "hash");
    assert_eq!(summary["manifest"]["status"], "legacy_unverified");
    assert_eq!(summary["technologies"], json!([]));
}

#[tokio::test]
async fn seller_node_cache_payloads_bypass_all_database_reads_and_writes() {
    let page = json!({"limit":20,"hasMore":false,"nextCursor":null});
    let cases = [
        (
            "/v1/sellers",
            "v1:sellers.list:",
            json!({"sellers":[{"id":"s","name":"Seller"}],"total":1}),
            json!([{"id":"s","name":"Seller"}]),
        ),
        (
            "/v1/sellers/s",
            "v1:sellers.offers:filters={\"offerType\":null,\"ignoredSandboxes\":[]}:id=\"s\":limit=20:locale=\"en-US\":region=\"US\"",
            json!({"offers":[{"id":"o"}],"pagination":page,"localization":{"localeStatus":"canonical"}}),
            json!([{"id":"o"}]),
        ),
        (
            "/v1/sellers/s/cover",
            "v1:sellers.cover:id=\"s\":locale=\"en-US\":region=\"US\"",
            json!({"offers":[{"id":"o"}],"localization":{"localeStatus":"canonical"}}),
            json!([{"id":"o"}]),
        ),
        (
            "/v1/sellers/s/stats",
            "v1:sellers.stats:id=\"s\"",
            json!({"offers":2,"items":3,"games":1,"freegames":0,"mobileFreeGames":0}),
            json!({"offers":2,"items":3,"games":1,"freegames":0,"mobileFreeGames":0}),
        ),
    ];
    for (uri, key, value, data) in cases {
        let mongo = Arc::new(RecordingMongo::default());
        let cache = Arc::new(SandboxCache::default());
        cache
            .values
            .lock()
            .unwrap()
            .insert(key.into(), value.to_string());
        let (status, body) = sandbox_get(&sandbox_app(mongo.clone(), cache.clone()), uri).await;
        assert_eq!(status, 200, "{uri}: {body}");
        assert_eq!(body["data"], data, "{uri}");
        if uri.ends_with("/s") || uri.ends_with("/cover") {
            assert_eq!(body["meta"]["localeStatus"], "canonical", "{uri}");
        }
        assert_eq!(*cache.gets.lock().unwrap(), vec![key], "{uri}");
        assert!(cache.sets.lock().unwrap().is_empty(), "{uri}");
        assert!(mongo.one_calls.lock().unwrap().is_empty(), "{uri}");
        assert!(mongo.many_calls.lock().unwrap().is_empty(), "{uri}");
        assert!(mongo.aggregate_calls.lock().unwrap().is_empty(), "{uri}");
        assert!(mongo.count_calls.lock().unwrap().is_empty(), "{uri}");
        assert!(mongo.distinct_calls.lock().unwrap().is_empty(), "{uri}");
    }
}

#[tokio::test]
async fn catalog_offers_normalize_missing_fields_before_localization() {
    for uri in [
        "/v1/sellers/s?locale=es-ES",
        "/v1/sellers/s/cover?locale=es-ES",
        "/v1/sandboxes/ns/offers?locale=es-ES",
        "/v1/sandboxes/ns/base-game?locale=es-ES",
    ] {
        let mongo = Arc::new(RecordingMongo {
            many_by_collection: HashMap::from([
                (
                    "offers".into(),
                    vec![doc! {"id":"o","namespace":"ns","title":"Base","seller":{"id":"s"}}],
                ),
                (
                    "egs_localizations".into(),
                    vec![
                        doc! {"entityType":"offer","entityId":"ns:o","locale":"es-ES","source":"epic","fetchedAt":"2025-01-01T00:00:00.000Z","data":{"title":"Juego","description":"Descripción localizada"}},
                    ],
                ),
            ]),
            ..sandbox_mongo()
        });
        let (status, body) =
            sandbox_get(&sandbox_app(mongo, Arc::new(SandboxCache::default())), uri).await;
        assert_eq!(status, 200, "{uri}: {body}");
        let offer = if uri.contains("base-game") {
            &body["data"]
        } else {
            &body["data"][0]
        };
        assert_eq!(offer["title"], "Juego", "{uri}");
        assert_eq!(offer["description"], "Descripción localizada", "{uri}");
        assert_eq!(offer["localeStatus"], "localized", "{uri}");
    }
}

#[tokio::test]
async fn item_bulk_offers_accepts_regional_query_before_reading_body() {
    let mongo = Arc::new(RecordingMongo::default());
    let cache = Arc::new(SandboxCache::default());
    cache.values.lock().unwrap().insert(
        "v1:items.bulkOffers:country=\"DE\":ids=[\"i\"]:locale=\"de-DE\":region=\"EURO\"".into(),
        json!({"data":{"i":null},"found":0}).to_string(),
    );
    let response = sandbox_app(mongo.clone(), cache.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/items/bulk/offers?country=DE&locale=de-DE")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"items":["i"]}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = json_body(response).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["meta"]["locale"], "de-DE");
    assert_eq!(body["data"], json!({"i":null}));
    assert!(cache.sets.lock().unwrap().is_empty());
    assert!(mongo.many_calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn seller_sandbox_edges_match_node_http_and_service_reads() {
    use futures::FutureExt;
    let mut failed = Vec::new();
    for source in [
        include_str!("../../../tests/fixtures/seller-edge-http-node.json"),
        include_str!("../../../tests/fixtures/sandbox-edge-http-node.json"),
    ] {
        let fixtures: Vec<Value> = serde_json::from_str(source).unwrap();
        for case in fixtures {
            let name = case["name"].clone();
            let one = json!([case]).to_string();
            let replay = crate::v1::mongo_read_oracle::replay_mongo_oracle(&one);
            if std::panic::AssertUnwindSafe(replay)
                .catch_unwind()
                .await
                .is_err()
            {
                failed.push(name);
            }
        }
    }
    assert!(failed.is_empty(), "Failed Node cases: {failed:?}");
}
#[tokio::test]
async fn malformed_cached_sandbox_context_does_not_overwrite_the_changelog_page() {
    let cache = Arc::new(SandboxCache::default());
    let context_key = v1_cache_key(
        "sandboxes.changelog.context",
        &BTreeMap::from([("sandboxId", json!("ns"))]),
    );
    cache
        .values
        .lock()
        .unwrap()
        .insert(context_key, json!({"unexpected": u64::MAX}).to_string());
    let app = sandbox_app(Arc::new(sandbox_mongo()), cache.clone());
    let (status, error) = sandbox_get(&app, "/v1/sandboxes/ns/changelog").await;
    assert_eq!(status, axum::http::StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(error["code"], "INTERNAL_ERROR");
    assert_eq!(
        *cache.sets.lock().unwrap(),
        vec![(
            "v1:sandboxes.exists:sandboxId=\"ns\"".into(),
            json!(true),
            300
        )]
    );
}

#[tokio::test]
async fn sandbox_existence_and_base_game_caching_behavior() {
    let mongo = Arc::new(RecordingMongo {
        one_docs: HashMap::from([("sandboxes".into(), Some(doc! {"_id": "ns"}))]),
        many_by_collection: HashMap::from([(
            "items".into(),
            vec![doc! {
                "id": "exe-1",
                "namespace": "ns",
                "entitlementType": "EXECUTABLE",
                "releaseInfo": [{"appId": "app-1"}],
            }],
        )]),
        ..Default::default()
    });
    let cache = Arc::new(SandboxCache::default());
    let app = sandbox_app(mongo.clone(), cache.clone());

    let (status, first) = sandbox_get(&app, "/v1/sandboxes/ns/base-game").await;
    assert_eq!(status, 200, "{first}");
    assert_eq!(first["data"]["id"], "exe-1");
    assert_eq!(first["data"]["isItem"], true);
    let sets = cache.sets.lock().unwrap().clone();
    assert_eq!(sets.len(), 2);
    assert_eq!(
        sets[0],
        (
            "v1:sandboxes.exists:sandboxId=\"ns\"".into(),
            json!(true),
            300
        )
    );
    assert_eq!(
        sets[1].0,
        "v1:sandboxes.base-game:locale=\"en-US\":region=\"US\":sandboxId=\"ns\""
    );
    assert_eq!(sets[1].2, 300);

    let one_calls_after_miss = mongo.one_calls.lock().unwrap().len();
    let many_calls_after_miss = mongo.many_calls.lock().unwrap().len();
    let (status, second) = sandbox_get(&app, "/v1/sandboxes/ns/base-game").await;
    assert_eq!(status, 200, "{second}");
    assert_eq!(second, first);
    assert_eq!(mongo.one_calls.lock().unwrap().len(), one_calls_after_miss);
    assert_eq!(
        mongo.many_calls.lock().unwrap().len(),
        many_calls_after_miss
    );
    assert_eq!(cache.sets.lock().unwrap().len(), 2);

    let empty_mongo = Arc::new(RecordingMongo::default());
    let missing_app = sandbox_app(empty_mongo.clone(), cache.clone());
    let (status, missing_first) = sandbox_get(&missing_app, "/v1/sandboxes/missing/base-game").await;
    assert_eq!(status, 404, "{missing_first}");
    assert_eq!(missing_first["code"], "SANDBOX_NOT_FOUND");
    assert_eq!(empty_mongo.one_calls.lock().unwrap().len(), 2);
    assert_eq!(
        cache.sets.lock().unwrap().last().unwrap(),
        &("v1:sandboxes.exists:sandboxId=\"missing\"".into(), json!(false), 60)
    );

    let (status, missing_second) = sandbox_get(&missing_app, "/v1/sandboxes/missing/base-game").await;
    assert_eq!(status, 404, "{missing_second}");
    assert_eq!(missing_second["code"], "SANDBOX_NOT_FOUND");
    assert_eq!(empty_mongo.one_calls.lock().unwrap().len(), 2);
    assert_eq!(cache.sets.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn sandbox_base_game_ssr_telemetry_reports_redis_hits_and_misses() {
    let cache = Arc::new(SandboxCache::default());
    let telemetry = Arc::new(crate::v1::ssr_telemetry::SsrTelemetry::from_env(
        &BTreeMap::from([("WEB_SSR_KEY_ID".into(), "key_website".into())]),
    ));
    let make_app = |mongo: Arc<RecordingMongo>| {
        let mut state =
            crate::middleware::test_support::test_app_state(crate::state::ApiConfig {
                v1_worker_token: Some("worker".into()),
                v1_worker_auth_required: true,
                ..Default::default()
            });
        state.ssr_telemetry = telemetry.clone();
        state.mongo = mongo;
        state.cache = cache.clone();
        crate::v1::router(&state).with_state(state)
    };

    let ok_app = make_app(Arc::new(RecordingMongo {
        one_docs: HashMap::from([("sandboxes".into(), Some(doc! {"_id": "ns"}))]),
        many_by_collection: HashMap::from([(
            "items".into(),
            vec![doc! {
                "id": "exe-1",
                "namespace": "ns",
                "entitlementType": "EXECUTABLE",
                "releaseInfo": [{"appId": "app-1"}],
            }],
        )]),
        ..Default::default()
    }));
    let empty_app = make_app(Arc::new(RecordingMongo {
        one_docs: HashMap::from([("sandboxes".into(), Some(doc! {"_id": "empty-ns"}))]),
        ..Default::default()
    }));
    let missing_app = make_app(Arc::new(RecordingMongo::default()));

    for (router, uri, expected_status) in [
        (&ok_app, "/v1/sandboxes/ns/base-game", 200),
        (&ok_app, "/v1/sandboxes/ns/base-game", 200),
        (&ok_app, "/v1/sandboxes/ns/base-game?country=DE", 200),
        (&empty_app, "/v1/sandboxes/empty-ns/base-game", 404),
        (&empty_app, "/v1/sandboxes/empty-ns/base-game", 404),
        (&missing_app, "/v1/sandboxes/missing-ns/base-game", 404),
        (&missing_app, "/v1/sandboxes/missing-ns/base-game", 404),
    ] {
        let resp = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(uri)
                    .header("x-egdata-key-id", "key_website")
                    .header("x-egdata-key-tier", "enterprise")
                    .header("x-egdata-worker-token", "worker")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), expected_status, "{uri}");
    }

    let entries = telemetry.recorded_events();
    assert_eq!(entries.len(), 7);
    let cache_statuses: Vec<&str> = entries
        .iter()
        .map(|e| e["cacheStatus"].as_str().unwrap())
        .collect();
    assert_eq!(
        cache_statuses,
        ["MISS", "HIT", "MISS", "MISS", "HIT", "MISS", "HIT"]
    );
    let status_codes: Vec<u64> = entries
        .iter()
        .map(|e| e["statusCode"].as_u64().unwrap())
        .collect();
    assert_eq!(status_codes, [200, 200, 200, 404, 404, 404, 404]);
    for entry in &entries {
        assert_eq!(entry["operationId"], "getSandboxBaseGame");
        assert_eq!(entry["limitOutcome"], "ok");
        assert!(entry["responseBytes"].as_u64().unwrap() > 0);
    }
}
