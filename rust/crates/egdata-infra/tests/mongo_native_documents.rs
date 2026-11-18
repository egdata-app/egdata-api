use bson::{Bson, Document, RawDocumentBuf, doc, oid::ObjectId};
use egdata_core::ports::MongoStorePort;
use egdata_infra::{
    catalog_mongo::{CatalogMongoDataSource, MongoDatabaseSource},
    mongo::{MongoConfig, connect_mongo},
    port_adapters::MongoStoreAdapter,
};
use futures::TryStreamExt;

#[tokio::test]
async fn every_mongo_read_preserves_native_tags_and_literal_documents() {
    let Ok(url) = std::env::var("EGDATA_TEST_MONGO") else {
        return;
    };
    let config = MongoConfig {
        url,
        database_name: format!("native_documents_fixture_{}", ObjectId::new().to_hex()),
        ca_path: std::env::var("EGDATA_TEST_MONGO_CA").unwrap().into(),
        cert_path: std::env::var("EGDATA_TEST_MONGO_CERT").unwrap().into(),
    };
    let (_client, db) = connect_mongo(&config).await.unwrap();
    let adapter = MongoStoreAdapter::new(db.clone());
    let catalog = MongoDatabaseSource::new(db.clone());
    let mut differences = Vec::new();
    let collection = "archive";
    for (index, entry) in [
        Bson::Document(doc! {"$date":"2024-01-01"}),
        Bson::Document(doc! {"$date":"2024-01-01T00:00:00.000Z"}),
        Bson::Document(doc! {"$oid":"64e000000000000000000001"}),
        Bson::DateTime(bson::DateTime::from_millis(1234)),
        Bson::ObjectId(ObjectId::parse_str("64e000000000000000000001").unwrap()),
    ]
    .into_iter()
    .enumerate()
    {
        let filter = doc! {"_id":index as i32};
        let expected = doc! {"_id":index as i32,"entry":&entry};
        db.collection::<RawDocumentBuf>(collection)
            .insert_one(RawDocumentBuf::from_document(&expected).unwrap())
            .await
            .unwrap();
        let stream = adapter
            .find_stream(collection, filter.clone(), Default::default())
            .await
            .unwrap();
        let pipeline = vec![doc! {"$match":&filter}];
        let rows: Vec<(&str, Result<Vec<Document>, String>)> = vec![
            (
                "find_one",
                adapter
                    .find_one(collection, filter.clone(), None)
                    .await
                    .map(|v| v.into_iter().collect())
                    .map_err(|e| e.to_string()),
            ),
            (
                "find_one_with_options",
                adapter
                    .find_one_with_options(collection, filter.clone(), Default::default())
                    .await
                    .map(|v| v.into_iter().collect())
                    .map_err(|e| e.to_string()),
            ),
            (
                "find_many",
                adapter
                    .find_many(collection, filter.clone(), Default::default())
                    .await
                    .map_err(|e| e.to_string()),
            ),
            (
                "find_many_with_raw_page",
                adapter
                    .find_many_with_raw_page(
                        collection,
                        filter.clone(),
                        doc! {"skip": f64::NAN, "limit": f64::NAN},
                    )
                    .await
                    .map_err(|e| e.to_string()),
            ),
            (
                "find_stream",
                stream.try_collect().await.map_err(|e| e.to_string()),
            ),
            (
                "aggregate",
                adapter
                    .aggregate(collection, pipeline.clone())
                    .await
                    .map_err(|e| e.to_string()),
            ),
            (
                "aggregate_with_options",
                adapter
                    .aggregate_with_options(collection, pipeline, Default::default())
                    .await
                    .map_err(|e| e.to_string()),
            ),
            (
                "catalog_one",
                catalog
                    .find_one(collection, filter.clone())
                    .await
                    .map(|v| v.into_iter().collect())
                    .map_err(|e| e.to_string()),
            ),
            (
                "catalog_limited",
                catalog
                    .find_limited(collection, filter.clone(), 1)
                    .await
                    .map_err(|e| e.to_string()),
            ),
        ];
        for (method, actual) in rows {
            if actual.as_deref() != Ok(std::slice::from_ref(&expected)) {
                differences.push(format!("{method} {entry:?}: {actual:?}"));
            }
        }
        let distinct = adapter.distinct(collection, "entry", filter).await;
        if distinct.as_ref().ok().map(Vec::as_slice) != Some(std::slice::from_ref(&entry)) {
            differences.push(format!("distinct {entry:?}: {distinct:?}"));
        }
    }
    db.drop().await.unwrap();
    assert!(differences.is_empty(), "{}", differences.join("\n"));
}
