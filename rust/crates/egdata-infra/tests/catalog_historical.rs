use bson::{Bson, Document, doc};
use egdata_core::catalog::{sha256_hex, stable_json};
use egdata_infra::{
    catalog_mongo::{
        CatalogHydrationRequest, MongoCatalogHydrationResolver, MongoDatabaseSource,
        ensure_catalog_hydration_indexes,
    },
    mongo::{MongoConfig, connect_mongo_with_options},
};
use mongodb::event::{EventHandler, command::CommandEvent};
use mongodb::options::{AuthMechanism, Tls};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

fn disposable_config() -> MongoConfig {
    MongoConfig {
        url: std::env::var("EGDATA_TEST_MONGO").unwrap(),
        ca_path: std::env::var("EGDATA_TEST_MONGO_CA").unwrap().into(),
        cert_path: std::env::var("EGDATA_TEST_MONGO_CERT").unwrap().into(),
        database_name: "egdata".into(),
    }
}

#[tokio::test]
#[ignore = "requires disposable X.509 MongoDB"]
async fn historical_catalog_and_wire_reads_match_node() {
    let cfg = disposable_config();
    let mut options = cfg.client_options().await.unwrap();
    let trace = Arc::new(Mutex::new(Vec::new()));
    let capture = Arc::clone(&trace);
    options.command_event_handler = Some(EventHandler::callback(move |event| {
        if let CommandEvent::Started(ev) = event
            && ev.command_name == "find"
        {
            let query = egdata_infra::bson_json::bson_doc_to_js_json(&ev.command);
            capture.lock().unwrap().push(
                json!({"collection":query["find"],"filter":query["filter"],"limit":query["limit"]}),
            );
        }
    }));
    let name = format!("catalog_fixture_{}", bson::oid::ObjectId::new());
    let (client, db) = connect_mongo_with_options(options, &name).await.unwrap();
    let data: Vec<Value> = serde_json::from_str(include_str!(
        "../../egdata-api/tests/fixtures/catalog-historical-mongo-node.json"
    ))
    .unwrap();
    let scenario = &data[0];
    let fixture_dir =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures");
    async fn insert(db: &mongodb::Database, collection: &str, rows: Vec<Value>) {
        let docs = rows
            .into_iter()
            .map(|r| match Bson::try_from(r).unwrap() {
                Bson::Document(doc) => doc,
                _ => panic!("fixture row must be a document"),
            })
            .collect::<Vec<_>>();
        db.collection::<Document>(collection)
            .insert_many(docs)
            .await
            .unwrap();
    }
    for collection in ["items", "offers"] {
        let file =
            std::fs::read(fixture_dir.join(format!("egdata.{collection}.SeaQA.json"))).unwrap();
        insert(&db, collection, serde_json::from_slice(&file).unwrap()).await;
    }
    for (collection, rows) in scenario["tables"].as_object().unwrap() {
        insert(&db, collection, rows.as_array().unwrap().clone()).await;
    }
    let source = MongoDatabaseSource::new(db.clone());
    ensure_catalog_hydration_indexes(&source).await.unwrap();
    let resolver = MongoCatalogHydrationResolver::new_with_locale(source, "en-US").unwrap();
    let mut mismatches = Vec::new();
    for case in scenario["cases"].as_array().unwrap() {
        let id = serde_json::from_value(case["identifier"].clone()).unwrap();
        let req = CatalogHydrationRequest {
            schema_version: 2,
            identifiers: vec![],
            known_roots: case
                .get("knownRoots")
                .map(|v| serde_json::from_value(v.clone()).unwrap())
                .unwrap_or_default(),
            known_records: case
                .get("knownRecords")
                .map(|v| serde_json::from_value(v.clone()).unwrap())
                .unwrap_or_default(),
        };
        trace.lock().unwrap().clear();
        let mut res = serde_json::to_value(resolver.resolve(id, &req).await).unwrap();
        let time = res.as_object_mut().unwrap().remove("hydratedAt").unwrap();
        chrono::DateTime::parse_from_rfc3339(time.as_str().unwrap()).unwrap();
        let q = Value::Array(std::mem::take(&mut *trace.lock().unwrap()));
        let query = sha256_hex(&stable_json(&q));
        let payload = sha256_hex(&stable_json(&res));
        if case["status"] != res["status"]
            || case["queryDigest"] != query
            || case["rootDigest"] != payload
        {
            mismatches.push(format!(
                "{}: status {} vs {}, query match {}, root match {}",
                case["identifier"],
                res["status"],
                case["status"],
                case["queryDigest"] == query,
                case["rootDigest"] == payload
            ));
        }
    }
    db.drop().await.unwrap();
    client.shutdown().await;
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

#[tokio::test]
async fn mongo_driver_configuration_matches_node() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../egdata-api/tests/fixtures/mongo-driver-config-node.json"
    ))
    .unwrap();
    for case in cases {
        let expected = &case["output"];
        let config = MongoConfig::from_env_lookup(|k| case["input"][k].as_str().map(str::to_owned));
        if let Some(err) = expected["error"].as_str() {
            assert_eq!(config.unwrap_err().to_string(), err);
            continue;
        }
        let c = config.unwrap();
        let driver = &expected["driver"];
        let opts = &driver["opts"];
        assert_eq!(c.connection_uri(), driver["uri"]);
        assert_eq!(c.database_name, expected["database"]);
        assert_eq!(c.ca_path.to_str(), opts["tlsCAFile"].as_str());
        assert_eq!(c.cert_path.to_str(), opts["tlsCertificateKeyFile"].as_str());
        if c.url.starts_with("mongodb://") {
            let parsed = c.client_options().await.unwrap();
            assert_eq!(matches!(parsed.tls, Some(Tls::Enabled(_))), opts["tls"]);
            let cred = parsed.credential.unwrap();
            assert_eq!(
                cred.mechanism.as_ref().map(AuthMechanism::as_str),
                opts["authMechanism"].as_str()
            );
            assert_eq!(cred.source.as_deref(), opts["authSource"].as_str());
        }
    }
}

#[tokio::test]
#[ignore = "requires disposable X.509 MongoDB"]
async fn x509_connection_selects_an_authenticated_server_before_returning() {
    let cfg = disposable_config();
    let (client, db) = egdata_infra::mongo::connect_mongo(&cfg).await.unwrap();
    assert_eq!(db.name(), "egdata");
    client.shutdown().await;
    let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = free.local_addr().unwrap();
    drop(free);
    let dead = MongoConfig {
        url: format!("mongodb://{address}/?serverSelectionTimeoutMS=200"),
        ..cfg
    };
    assert!(
        egdata_infra::mongo::connect_mongo(&dead).await.is_err(),
        "unavailable server accepted"
    );
}

#[tokio::test]
#[ignore = "requires disposable X.509 MongoDB"]
async fn delayed_asset_cursor_failure_discards_partial_graph() {
    let mut options = disposable_config().client_options().await.unwrap();
    let batches = Arc::new(Mutex::new(Vec::new()));
    let capture = Arc::clone(&batches);
    options.command_event_handler = Some(EventHandler::callback(move |event| {
        if let CommandEvent::Started(ev) = event {
            let is_asset_read = ev.command.get_str("find") == Ok("assets");
            let is_asset_batch =
                ev.command_name == "getMore" && ev.command.get_str("collection") == Ok("assets");
            if is_asset_read || is_asset_batch {
                capture.lock().unwrap().push(ev.command_name);
            }
        }
    }));
    let (client, db) = connect_mongo_with_options(
        options,
        &format!("catalog_fixture_{}", bson::oid::ObjectId::new()),
    )
    .await
    .unwrap();
    db.collection::<Document>("items")
        .insert_one(doc! {"namespace":"Legacy","id":"page","title":"Paged assets"})
        .await
        .unwrap();
    db.collection::<Document>("raw_assets").insert_many((0..130).map(|i|doc!{"namespace":"Legacy","itemId":"page","artifactId":format!("artifact-{i}"),"platform":"Windows","sizeParts":if i==129 {0}else{1}})).await.unwrap();
    db.run_command(doc!{"create":"assets","viewOn":"raw_assets","pipeline":[{"$addFields":{"downloadSizeBytes":{"$divide":[2,"$sizeParts"]}}}]}).await.unwrap();
    let oracle: Vec<Value> = serde_json::from_str(include_str!(
        "../../egdata-api/tests/fixtures/catalog-asset-cursor-failure-node.json"
    ))
    .unwrap();
    let expected = &oracle[0];
    let identifier = serde_json::from_value(expected["result"]["identifier"].clone()).unwrap();
    let request = CatalogHydrationRequest {
        schema_version: 2,
        identifiers: vec![],
        known_roots: vec![],
        known_records: vec![],
    };
    let mut result = serde_json::to_value(
        MongoCatalogHydrationResolver::new(MongoDatabaseSource::new(db.clone()))
            .resolve(identifier, &request)
            .await,
    )
    .unwrap();
    let time = result
        .as_object_mut()
        .unwrap()
        .remove("hydratedAt")
        .unwrap();
    chrono::DateTime::parse_from_rfc3339(time.as_str().unwrap()).unwrap();
    db.drop().await.unwrap();
    client.shutdown().await;
    assert_eq!(result, expected["result"]);
    assert_eq!(json!(&*batches.lock().unwrap()), expected["batches"]);
}
