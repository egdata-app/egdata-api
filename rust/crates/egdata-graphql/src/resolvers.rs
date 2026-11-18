//! Resolver implementations backed by the shared Mongo and cache ports.

use async_graphql::{Error, Result};
use bson::{Bson, Document, doc};
use egdata_core::{
    ports::{EpicStorePort, MongoFindOptions, MongoStorePort, ResponseCachePort},
    v1::serialization::bson_to_serialized_json,
};
use serde_json::{Value, json};
use std::sync::Arc;

mod loaders;
mod offers;
mod profile;
mod relationships;
mod sandbox;

/// Dependencies and request-scoped resolver state for GraphQL execution.
pub struct GraphqlServices {
    pub mongo: Arc<dyn MongoStorePort>,
    pub cache: Arc<dyn ResponseCachePort>,
    loaders: loaders::Loaders,
    profile_cache: profile::ProfileRequestCache,
    pub epic: Arc<dyn EpicStorePort>,
    pub now: fn() -> chrono::DateTime<chrono::Utc>,
}

impl GraphqlServices {
    pub fn new(
        mongo: Arc<dyn MongoStorePort>,
        cache: Arc<dyn ResponseCachePort>,
        epic: Arc<dyn EpicStorePort>,
    ) -> Self {
        Self {
            loaders: loaders::Loaders::new(mongo.clone()),
            profile_cache: Default::default(),
            mongo,
            cache,
            epic,
            now: chrono::Utc::now,
        }
    }

    async fn rows(
        &self,
        collection: &str,
        filter: Document,
        options: MongoFindOptions,
    ) -> Result<Vec<Value>> {
        Ok(self
            .mongo
            .find_many(collection, filter, options)
            .await?
            .iter()
            .map(as_json)
            .collect())
    }

    async fn one(&self, collection: &str, filter: Document) -> Result<Option<Value>> {
        Ok(self
            .mongo
            .find_one(collection, filter, None)
            .await?
            .as_ref()
            .map(as_json))
    }
}

/// Resolve a custom GraphQL field. `None` delegates to GraphQL's default
/// property resolver. A resolved field with no document returns JSON null.
pub async fn resolve(
    parent_type: &str,
    field: &str,
    parent: &Value,
    args: &Value,
    services: &GraphqlServices,
) -> Result<Option<Value>> {
    if parent_type == "Profile" || (parent_type == "Query" && field == "profile") {
        // A profile may aggregate several Mongo queries. Keep that future off
        // the stack of every other field in a nested GraphQL selection.
        return Box::pin(profile::resolve(parent_type, field, parent, args, services)).await;
    }
    if let Some(result) = offers::resolve(parent_type, field, parent, args, services).await? {
        return Ok(Some(result));
    }
    let result = match (parent_type, field) {
        ("Query", "build") => {
            let id = arg_string(args, "id")?;
            let oid = object_id(id)?;
            services
                .mongo
                .find_one("builds", doc! {"_id": oid}, None)
                .await?
                .map(|document| as_json(&document))
        }
        ("Query", "builds") => {
            let (limit, _page, skip) = pagination(args, 10, 100);
            let sort_by = match args.get("sortBy") {
                None => "createdAt",
                Some(value) => value.as_str().unwrap_or("null"),
            };
            let sort_dir = if args.get("sortDir").and_then(Value::as_str) == Some("asc") {
                1
            } else {
                -1
            };
            let rows = services
                .mongo
                .find_many(
                    "builds",
                    Document::new(),
                    MongoFindOptions {
                        sort: Some(doc! {sort_by: sort_dir}),
                        skip: Some(skip),
                        limit: Some(limit as i64),
                        ..Default::default()
                    },
                )
                .await?;
            Some(Value::Array(rows.iter().map(as_json).collect()))
        }
        ("Query", "item") => {
            let id = arg_string(args, "id")?;
            services
                .mongo
                .find_one("items", doc! {"id": {"$eq": id}}, Some(projection(args)))
                .await?
                .map(|document| as_json(&document))
        }
        ("Query", "items") => {
            let (limit, page, skip) = pagination(args, 10, 100);
            let rows = services
                .mongo
                .find_many(
                    "items",
                    Document::new(),
                    MongoFindOptions {
                        sort: Some(doc! {"lastModifiedDate": -1}),
                        skip: Some(skip),
                        limit: Some(limit as i64),
                        ..Default::default()
                    },
                )
                .await?;
            let total = services
                .mongo
                .count_documents("items", Document::new())
                .await?;
            Some(
                json!({"elements": rows.iter().map(as_json).collect::<Vec<_>>(), "total": total, "page": page, "limit": limit}),
            )
        }
        ("Query", "sandbox") => {
            let id = arg_string(args, "id")?;
            services
                .mongo
                .find_one("namespaces", doc! {"_id": {"$eq": id}}, None)
                .await?
                .map(|document| as_json(&document))
        }
        ("Query", "sandboxes") => {
            let (limit, page, skip) = pagination(args, 10, 100);
            let rows = services
                .mongo
                .find_many(
                    "namespaces",
                    Document::new(),
                    MongoFindOptions {
                        skip: Some(skip),
                        limit: Some(limit as i64),
                        ..Default::default()
                    },
                )
                .await?;
            let total = services
                .mongo
                .count_documents("namespaces", Document::new())
                .await?;
            Some(
                json!({"elements": rows.iter().map(as_json).collect::<Vec<_>>(), "total": total, "page": page, "limit": limit}),
            )
        }
        ("Query", "events") => {
            let rows = services
                .mongo
                .find_many(
                    "tags",
                    doc! {"groupName": "event", "status": "ACTIVE"},
                    MongoFindOptions::default(),
                )
                .await?;
            Some(Value::Array(rows.iter().map(as_json).collect()))
        }
        ("Query", "changelog") => {
            let id = arg_string(args, "id")?;
            let oid = object_id(id)?;
            services
                .mongo
                .find_one("changelogs_v2", doc! {"_id": oid}, None)
                .await?
                .map(|document| as_json(&document))
        }
        ("Build", "downloadSizeBytes" | "installedSizeBytes") => {
            if let Some(value) = parent.get(field) {
                Some(value.clone())
            } else {
                let platform = parent
                    .get("labelName")
                    .and_then(Value::as_str)
                    .and_then(|v| v.split('-').nth(1))
                    .filter(|v| !v.is_empty());
                match (platform, parent.get("appName").and_then(Value::as_str)) {
                    (Some(platform), Some(app)) => services
                        .mongo
                        .find_one(
                            "assets",
                            doc! {"artifactId": app, "platform": platform},
                            None,
                        )
                        .await?
                        .and_then(|d| d.get(field).map(bson_to_serialized_json))
                        .map(|value| {
                            if js_truthy(&value) {
                                value
                            } else {
                                Value::Null
                            }
                        }),
                    _ => Some(Value::Null),
                }
            }
        }
        ("Build", "items") => {
            let app = parent.get("appName").and_then(Value::as_str).unwrap_or("");
            let rows = services
                .mongo
                .find_many(
                    "items",
                    doc! {"releaseInfo.appId": app},
                    MongoFindOptions::default(),
                )
                .await?;
            Some(Value::Array(rows.iter().map(as_json).collect()))
        }
        ("Build", "files") => {
            let manifest = parent.get("hash").and_then(Value::as_str).unwrap_or("");
            let mut filter = doc! {"manifestHash": manifest};
            let q = args
                .get("q")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty());
            let extensions = args
                .get("extension")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty());
            let extension_pattern =
                extensions.map(|value| value.split(',').collect::<Vec<_>>().join("|"));
            let regex =
                |pattern: String| doc! {"$regex": bson::Regex {pattern, options: "i".into()}};
            match (q, extension_pattern.as_deref()) {
                (Some(q), Some(ext)) => {
                    filter.insert(
                        "$and",
                        vec![
                            doc! {"fileName": regex(q.to_owned())},
                            doc! {"fileName": regex(format!(r"\.({ext})$"))},
                        ],
                    );
                }
                (Some(q), None) => {
                    filter.insert("fileName", regex(q.to_owned()));
                }
                (None, Some(ext)) => {
                    filter.insert("fileName", regex(format!(r"\.({ext})$")));
                }
                _ => {}
            }
            let (limit, page, skip) = pagination(args, 25, 100);
            let sort = args.get("sort").map_or(Some("depth"), Value::as_str);
            let dir = if args.get("dir").is_none_or(|v| v == "asc") {
                1
            } else {
                -1
            };
            let sort_doc = match sort {
                Some("depth") => doc! {"depth": dir, "fileName": dir},
                Some("fileName") => doc! {"fileName": dir},
                Some("fileSize") => doc! {"fileSize": dir},
                _ => Document::new(),
            };
            let rows = services
                .mongo
                .find_many(
                    "files",
                    filter.clone(),
                    MongoFindOptions {
                        sort: Some(sort_doc),
                        skip: Some(skip),
                        limit: Some(limit as i64),
                        ..Default::default()
                    },
                )
                .await?;
            let total = services.mongo.count_documents("files", filter).await?;
            Some(
                json!({"elements": rows.iter().map(as_json).collect::<Vec<_>>(), "total": total, "page": page, "limit": limit}),
            )
        }
        ("Build", "installOptions") => {
            let manifest = parent.get("hash").and_then(Value::as_str).unwrap_or("");
            let filter = doc! {"manifestHash": manifest, "installTags": {"$exists": true, "$not": {"$size": 0}}};
            let rows = services
                .mongo
                .find_many("files", filter, MongoFindOptions::default())
                .await?;
            let mut totals = serde_json::Map::<String, Value>::new();
            for row in rows {
                let size = as_json(&row)["fileSize"].as_f64().unwrap_or_default();
                for tag in row
                    .get_array("installTags")
                    .into_iter()
                    .flatten()
                    .filter_map(Bson::as_str)
                {
                    let entry = totals
                        .entry(tag.to_owned())
                        .or_insert_with(|| json!({"files": 0, "size": 0}));
                    let object = entry.as_object_mut().expect("option totals are objects");
                    object.insert(
                        "files".into(),
                        json!(object["files"].as_u64().unwrap_or_default() + 1),
                    );
                    object.insert(
                        "size".into(),
                        json!(object["size"].as_f64().unwrap_or_default() + size),
                    );
                }
            }
            Some(Value::Object(totals))
        }
        ("Sandbox", "items") => {
            let id = parent.get("_id").and_then(Value::as_str).unwrap_or("");
            let (limit, page, skip) = pagination(args, 10, 100);
            let filter = doc! {"namespace": id};
            let rows = services
                .mongo
                .find_many(
                    "items",
                    filter.clone(),
                    MongoFindOptions {
                        sort: Some(doc! {"lastModifiedDate": -1}),
                        skip: Some(skip),
                        limit: Some(limit as i64),
                        ..Default::default()
                    },
                )
                .await?;
            let total = services.mongo.count_documents("items", filter).await?;
            Some(
                json!({"elements": rows.iter().map(as_json).collect::<Vec<_>>(), "total": total, "page": page, "limit": limit}),
            )
        }
        ("Item", "assets") => {
            let id = arg_string(parent, "id")?;
            Some(services.loaders.one(loaders::Lookup::Assets, id).await?)
        }
        ("Item", "builds") => {
            let ids = relationships::ids(relationships::array(&parent["releaseInfo"]), "appId")
                .into_iter()
                .filter(|id| !id.is_empty())
                .take(100)
                .collect::<Vec<_>>();
            Some(Value::Array(
                services.loaders.many(loaders::Lookup::Build, &ids).await?,
            ))
        }
        ("Changelog", "document") => Some(relationships::document(parent, args, services).await?),
        ("Item", "offers" | "mainOffer") => {
            Some(relationships::item_offers(field, parent, args, services).await?)
        }
        ("Item" | "Offer" | "Sandbox", "changelog") => {
            Some(relationships::changelog(parent_type, parent, args, services).await?)
        }
        ("Sandbox", "offers" | "assets" | "builds" | "stats" | "baseGame" | "achievements")
        | ("Query", "sandboxHub") => Some(sandbox::resolve(field, parent, args, services).await?),
        _ => return Ok(None),
    };
    Ok(Some(result.unwrap_or(Value::Null)))
}

fn object_id(text: &str) -> Result<bson::oid::ObjectId> {
    bson::oid::ObjectId::parse_str(text).map_err(|_| {
        Error::new("input must be a 24 character hex string, 12 byte Uint8Array, or an integer")
    })
}

fn as_json(doc: &Document) -> Value {
    bson_to_serialized_json(&Bson::Document(doc.clone()))
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value
            .as_f64()
            .is_some_and(|number| number != 0.0 && !number.is_nan()),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}

fn projection(args: &Value) -> Document {
    let mut fields = Document::new();
    if let Some(selected) = args.get("__selectedFields").and_then(Value::as_array) {
        for field in selected.iter().filter_map(Value::as_str) {
            fields.insert(field, 1);
        }
    }
    fields.insert("id", 1);
    fields.insert("_id", 1);
    fields
}

fn arg_string<'a>(args: &'a Value, name: &str) -> Result<&'a str> {
    args.get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| Error::new(format!("Missing string argument {name}")))
}

fn pagination(args: &Value, fallback: usize, max: usize) -> (usize, usize, u64) {
    fn clamp(v: Option<&Value>, default: usize, max: usize) -> usize {
        v.and_then(Value::as_f64)
            .filter(|n| n.is_finite())
            .map(|n| (n.trunc() as i64).clamp(1, max as i64) as usize)
            .unwrap_or(default)
    }
    let limit = clamp(args.get("limit"), fallback, max);
    let page = clamp(args.get("page"), 1, 10_000);
    (limit, page, ((page - 1) * limit) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use egdata_core::{error::CoreError, ports::MongoDocumentStream};

    #[derive(Default)]
    struct Store {
        fail_method: Option<&'static str>,
        reads: std::sync::Mutex<Vec<Value>>,
        trace: Option<std::sync::Mutex<Vec<Value>>>,
    }

    impl Store {
        fn replay(&self, call: Value) -> std::result::Result<Option<Value>, CoreError> {
            if self
                .fail_method
                .is_some_and(|method| call["method"] == method)
            {
                return Err(CoreError::Internal("fixture database failure".into()));
            }
            let Some(trace) = self.trace.as_ref() else {
                return Ok(None);
            };
            let mut trace = trace.lock().unwrap();
            let index = trace
                .iter()
                .position(|row| row["call"] == call)
                .ok_or_else(|| {
                    CoreError::Internal(format!("unexpected call {call}; outstanding: {trace:?}"))
                })?;
            let hit = trace.remove(index);
            if hit["error"] == true {
                return Err(CoreError::Internal("fixture database failure".into()));
            }
            Ok(Some(hit["result"].clone()))
        }
    }

    fn raw_bson(value: &Bson) -> Value {
        match value {
            Bson::Document(document) => Value::Object(
                document
                    .iter()
                    .map(|(key, value)| (key.clone(), raw_bson(value)))
                    .collect(),
            ),
            Bson::Array(values) => Value::Array(values.iter().map(raw_bson).collect()),
            Bson::RegularExpression(r) => {
                json!({"$regularExpression":{"pattern":r.pattern,"options":r.options}})
            }
            scalar => egdata_core::v1::serialization::bson_to_serialized_json(scalar),
        }
    }

    #[async_trait::async_trait]
    impl MongoStorePort for Store {
        async fn find_one(
            &self,
            collection: &str,
            filter: Document,
            projection: Option<Document>,
        ) -> std::result::Result<Option<Document>, CoreError> {
            let mut options = json!({});
            if let Some(p) = &projection {
                options["projection"] = raw_bson(&Bson::Document(p.clone()));
            }
            if let Some(value)=self.replay(json!({"method":"one","collection":collection,"filter":raw_bson(&Bson::Document(filter.clone())),"options":options}))?{
                return Ok((!value.is_null()).then(||bson::to_document(&value).unwrap()));
            }
            self.reads.lock().expect("trace mutex").push(json!({
                "collection": collection,
                "filter": raw_bson(&Bson::Document(filter.clone())),
                "projection": projection.map(|value| raw_bson(&Bson::Document(value))),
            }));
            Ok(match collection {
                "builds" => Some(
                    doc! {"_id": bson::oid::ObjectId::parse_str("64b000000000000000000001").unwrap(), "appName":"app-1"},
                ),
                "changelogs_v2" => Some(
                    doc! {"_id": bson::oid::ObjectId::parse_str("64b000000000000000000002").unwrap(), "metadata": {"contextId":"item-1"}},
                ),
                "items" => Some(doc! {"id":"item-1", "title":"Example"}),
                _ => None,
            })
        }
        async fn find_many(
            &self,
            collection: &str,
            filter: Document,
            options: MongoFindOptions,
        ) -> std::result::Result<Vec<Document>, CoreError> {
            let mut opts = json!({});
            if let Some(p) = options.projection {
                opts["projection"] = raw_bson(&Bson::Document(p));
            }
            if let Some(s) = options.sort {
                opts["sort"] = raw_bson(&Bson::Document(s));
            }
            if let Some(limit) = options.limit {
                opts["limit"] = json!(limit);
            }
            if let Some(skip) = options.skip {
                opts["skip"] = json!(skip);
            }
            if let Some(rows)=self.replay(json!({"method":"many","collection":collection,"filter":raw_bson(&Bson::Document(filter)),"options":opts}))?{
                return Ok(rows.as_array().unwrap().iter().map(|v|bson::to_document(v).unwrap()).collect());
            }
            Ok(vec![])
        }
        async fn find_stream(
            &self,
            _collection: &str,
            _filter: Document,
            _options: MongoFindOptions,
        ) -> std::result::Result<MongoDocumentStream, CoreError> {
            Ok(Box::pin(futures::stream::empty()))
        }
        async fn aggregate(
            &self,
            _collection: &str,
            _pipeline: Vec<Document>,
        ) -> std::result::Result<Vec<Document>, CoreError> {
            Ok(vec![])
        }
        async fn count_documents(
            &self,
            collection: &str,
            filter: Document,
        ) -> std::result::Result<u64, CoreError> {
            Ok(self
                .replay(json!({"method":"count","collection":collection,"filter":raw_bson(&Bson::Document(filter)),"options":{}}))?
                .and_then(|v| v.as_u64())
                .unwrap_or(0))
        }
        async fn distinct(
            &self,
            _: &str,
            _: &str,
            _: Document,
        ) -> std::result::Result<Vec<Bson>, CoreError> {
            Ok(vec![])
        }
        async fn insert_one(&self, _: &str, _: Document) -> std::result::Result<(), CoreError> {
            Ok(())
        }
        async fn update_one(
            &self,
            _: &str,
            _: Document,
            _: Document,
            _: bool,
        ) -> std::result::Result<u64, CoreError> {
            Ok(0)
        }
        async fn delete_one(&self, _: &str, _: Document) -> std::result::Result<u64, CoreError> {
            Ok(0)
        }
        async fn ping(&self) -> std::result::Result<bool, CoreError> {
            Ok(true)
        }
    }

    struct Cache;
    #[async_trait::async_trait]
    impl ResponseCachePort for Store {
        async fn get(&self, key: &str) -> std::result::Result<Option<String>, CoreError> {
            Ok(self
                .replay(json!({"method":"get","key":key}))?
                .and_then(|v| v.as_str().map(str::to_owned)))
        }
        async fn set(
            &self,
            key: &str,
            value: &str,
            ttl: u64,
        ) -> std::result::Result<(), CoreError> {
            self.replay(json!({"method":"set","key":key,"value":serde_json::from_str::<Value>(value).unwrap(),"mode":"EX","ttl":ttl}))?;
            Ok(())
        }
        async fn del(&self, _: &str) -> std::result::Result<(), CoreError> {
            Ok(())
        }
        async fn ping(&self) -> std::result::Result<bool, CoreError> {
            Ok(true)
        }
    }
    #[async_trait::async_trait]
    impl EpicStorePort for Cache {
        async fn graphql(&self, _: &str, _: &Value) -> std::result::Result<Value, CoreError> {
            Ok(Value::Null)
        }
        async fn featured_games(&self) -> std::result::Result<Vec<Value>, CoreError> {
            Ok(vec![])
        }
    }
    #[async_trait::async_trait]
    impl ResponseCachePort for Cache {
        async fn get(&self, _key: &str) -> std::result::Result<Option<String>, CoreError> {
            Ok(None)
        }
        async fn set(
            &self,
            _key: &str,
            _value: &str,
            _ttl_seconds: u64,
        ) -> std::result::Result<(), CoreError> {
            Ok(())
        }
        async fn del(&self, _key: &str) -> std::result::Result<(), CoreError> {
            Ok(())
        }
        async fn ping(&self) -> std::result::Result<bool, CoreError> {
            Ok(true)
        }
    }

    #[tokio::test]
    async fn catalog_and_build_fields_surface_failed_reads() {
        let parent = json!({"id":"i","_id":"s","appName":"a","labelName":"Live-Win32","hash":"hash","releaseInfo":[{"appId":"a"}]});
        let args = json!({"id":"64b000000000000000000001"});
        for (method, fields) in [
            (
                "one",
                &[
                    ("Query", "build"),
                    ("Query", "item"),
                    ("Query", "sandbox"),
                    ("Query", "changelog"),
                    ("Build", "downloadSizeBytes"),
                ][..],
            ),
            (
                "many",
                &[
                    ("Query", "builds"),
                    ("Query", "items"),
                    ("Query", "sandboxes"),
                    ("Query", "events"),
                    ("Build", "items"),
                    ("Build", "files"),
                    ("Build", "installOptions"),
                    ("Sandbox", "items"),
                    ("Item", "assets"),
                    ("Item", "builds"),
                ][..],
            ),
            (
                "count",
                &[
                    ("Query", "items"),
                    ("Query", "sandboxes"),
                    ("Build", "files"),
                    ("Sandbox", "items"),
                ][..],
            ),
        ] {
            let services = GraphqlServices::new(
                Arc::new(Store {
                    fail_method: Some(method),
                    ..Default::default()
                }),
                Arc::new(Cache),
                Arc::new(Cache),
            );
            for &(ty, field) in fields {
                let result = resolve(ty, field, &parent, &args, &services)
                    .await
                    .unwrap_err();
                assert!(
                    result.message.contains("fixture database failure"),
                    "{ty}.{field} {result:?}"
                );
            }
        }
        let services =
            GraphqlServices::new(Arc::new(Store::default()), Arc::new(Cache), Arc::new(Cache));
        for (ty, field) in [
            ("Query", "offer"),
            ("Query", "event"),
            ("Query", "build"),
            ("Query", "item"),
            ("Query", "sandbox"),
            ("Query", "changelog"),
            ("Item", "assets"),
            ("Query", "sandboxHub"),
        ] {
            let error = resolve(ty, field, &Value::Null, &json!({}), &services)
                .await
                .unwrap_err();
            assert_eq!(error.message, "Missing string argument id");
        }
        assert!(
            resolve(
                "Query",
                "changelog",
                &Value::Null,
                &json!({"id":"invalid"}),
                &services
            )
            .await
            .is_err()
        );
    }

    #[test]
    fn unexpected_read_reports_the_call_and_expected_trace() {
        let store = Store {
            trace: Some(std::sync::Mutex::new(vec![
                json!({"call":{"method":"one"}}),
            ])),
            ..Default::default()
        };
        let error = store
            .replay(json!({"method":"many"}))
            .unwrap_err()
            .to_string();
        assert!(error.contains("many") && error.contains("one"));
    }

    #[tokio::test]
    async fn invalid_locales_on_linked_fields_return_validation_errors() {
        let backend = Arc::new(Store::default());
        let services = GraphqlServices::new(backend.clone(), Arc::new(Cache), Arc::new(Cache));
        let args = json!({"locale":"bad!","id":"sandbox"});
        for (ty, field) in [
            ("Changelog", "document"),
            ("Item", "offers"),
            ("Sandbox", "offers"),
            ("Sandbox", "baseGame"),
            ("Query", "sandboxHub"),
        ] {
            let error = resolve(
                ty,
                field,
                &json!({"_id":"sandbox","id":"offer"}),
                &args,
                &services,
            )
            .await
            .unwrap_err();
            assert_eq!(
                error.extensions.unwrap().get("code"),
                Some(&async_graphql::Value::from("BAD_USER_INPUT"))
            );
        }
        assert!(backend.reads.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn relationship_fields_propagate_each_failed_read() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../../oracles/graphql-relationships-node.json"
        ))
        .unwrap();
        let schema = crate::schema::build_schema(true).unwrap();
        for case in cases {
            let trace = case["trace"].as_array().unwrap();
            for failed in 0..trace.len() {
                let mut steps = trace.clone();
                steps[failed]["error"] = json!(true);
                let store = Arc::new(Store {
                    trace: Some(std::sync::Mutex::new(steps)),
                    ..Default::default()
                });
                let services = GraphqlServices::new(store.clone(), store, Arc::new(Cache));
                if let Some(query) = case["query"].as_str() {
                    let result = schema
                        .execute(async_graphql::Request::new(query).data(Arc::new(services)))
                        .await;
                    assert!(
                        result
                            .errors
                            .iter()
                            .any(|err| err.message.contains("fixture database failure"))
                    );
                } else {
                    let field = |parent| {
                        resolve(
                            case["parentType"].as_str().unwrap(),
                            case["field"].as_str().unwrap(),
                            parent,
                            &case["args"],
                            &services,
                        )
                    };
                    let error = if let Some(parents) = case["parents"].as_array() {
                        futures::future::try_join_all(parents.iter().map(field))
                            .await
                            .unwrap_err()
                    } else {
                        field(&case["parent"]).await.unwrap_err()
                    };
                    assert!(
                        error.message.contains("fixture database failure"),
                        "{error:?}"
                    );
                }
            }
        }
    }

    #[tokio::test]
    async fn graphql_relationships_node_oracle() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../../oracles/graphql-relationships-node.json"
        ))
        .unwrap();
        let schema = crate::schema::build_schema(true).unwrap();
        for case in cases {
            let name = &case["name"];
            let store = Arc::new(Store {
                trace: Some(std::sync::Mutex::new(
                    case["trace"].as_array().unwrap().clone(),
                )),
                ..Default::default()
            });
            let services = GraphqlServices::new(store.clone(), store.clone(), Arc::new(Cache));
            if let Some(query) = case["query"].as_str() {
                let response = schema
                    .execute(async_graphql::Request::new(query).data(Arc::new(services)))
                    .await;
                assert!(response.errors.is_empty(), "{name} {:?}", response.errors);
                let data =
                    egdata_core::v1::serialization::node_json(&response.data.into_json().unwrap());
                assert_eq!(
                    serde_json::from_str::<Value>(&data).unwrap(),
                    case["expected"],
                    "{name}"
                );
                assert!(
                    store.trace.as_ref().unwrap().lock().unwrap().is_empty(),
                    "{name} unread trace"
                );
                continue;
            }
            let resolve_one = |parent| {
                resolve(
                    case["parentType"].as_str().unwrap(),
                    case["field"].as_str().unwrap(),
                    parent,
                    &case["args"],
                    &services,
                )
            };
            let actual = if let Some(parents) = case["parents"].as_array() {
                let batch = futures::future::try_join_all(parents.iter().map(&resolve_one))
                    .await
                    .unwrap();
                json!([batch, resolve_one(&case["repeat"]).await.unwrap()])
            } else {
                resolve_one(&case["parent"]).await.unwrap().unwrap()
            };
            let actual: Value =
                serde_json::from_str(&egdata_core::v1::serialization::node_json(&actual)).unwrap();
            assert_eq!(actual, case["expected"], "{name}");
            assert!(
                store.trace.as_ref().unwrap().lock().unwrap().is_empty(),
                "{name} unread trace"
            );
        }
    }

    #[tokio::test]
    async fn schema_executes_populated_item_query() {
        let schema = crate::schema::build_schema(true).expect("schema builds");
        let services = Arc::new(GraphqlServices::new(
            Arc::new(Store::default()),
            Arc::new(Cache),
            Arc::new(Cache),
        ));
        let response = schema
            .execute(
                async_graphql::Request::new("{ item(id: \"item-1\") { id title } }").data(services),
            )
            .await;
        assert_eq!(
            response.into_result().expect("query succeeds").data,
            async_graphql::value!({"item":{"id":"item-1","title":"Example"}})
        );
    }

    #[tokio::test]
    async fn replays_node_item_resolver_fixture() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../../oracles/graphql-resolvers-node.json"))
                .expect("Node fixture parses");
        for case in fixture["cases"].as_array().unwrap() {
            let field = &case["field"];
            let store = Arc::new(Store::default());
            let services = GraphqlServices::new(store.clone(), Arc::new(Cache), Arc::new(Cache));
            let actual = resolve(
                case["parentType"].as_str().unwrap(),
                case["field"].as_str().unwrap(),
                &case["parent"],
                &case["args"],
                &services,
            )
            .await
            .expect("resolver succeeds")
            .unwrap_or(Value::Null);
            assert_eq!(actual, case["expected"], "{field} result");
            assert_eq!(
                *store.reads.lock().unwrap(),
                case["reads"].as_array().unwrap().to_vec(),
                "{field} Mongo reads"
            );
        }
    }

    #[tokio::test]
    async fn resolvers_cover_remaining_branches_errors_and_sandbox_edge_cases() {
        let store = Arc::new(Store::default());
        let services = GraphqlServices::new(store.clone(), Arc::new(Cache), Arc::new(Cache));

        // Delegation to profile & offers, events, builds defaults, invalid ObjectId, Build.items & Build.files variants.
        assert_eq!(
            resolve(
                "Query",
                "profile",
                &Value::Null,
                &json!({"id": "missing"}),
                &services
            )
            .await
            .unwrap(),
            Some(Value::Null)
        );
        assert_eq!(
            resolve(
                "Query",
                "offer",
                &Value::Null,
                &json!({"id": "missing"}),
                &services
            )
            .await
            .unwrap(),
            Some(Value::Null)
        );
        assert_eq!(
            resolve("Query", "events", &Value::Null, &json!({}), &services)
                .await
                .unwrap(),
            Some(json!([]))
        );
        assert_eq!(
            resolve(
                "Query",
                "builds",
                &Value::Null,
                &json!({"sortDir": "asc"}),
                &services
            )
            .await
            .unwrap(),
            Some(json!([]))
        );
        assert!(
            resolve(
                "Query",
                "build",
                &Value::Null,
                &json!({"id": "bad-oid"}),
                &services
            )
            .await
            .is_err()
        );
        assert_eq!(
            resolve(
                "Build",
                "items",
                &json!({"appName": "app-1"}),
                &json!({}),
                &services
            )
            .await
            .unwrap(),
            Some(json!([]))
        );
        assert_eq!(
            resolve(
                "Build",
                "downloadSizeBytes",
                &json!({}),
                &json!({}),
                &services
            )
            .await
            .unwrap(),
            Some(Value::Null)
        );
        // Asset with falsy downloadSizeBytes (0) maps to Value::Null.
        let falsy_store = Arc::new(Store {
            trace: Some(std::sync::Mutex::new(vec![json!({
                "call": {
                    "method": "one",
                    "collection": "assets",
                    "filter": { "artifactId": "app-1", "platform": "Win32" },
                    "options": {}
                },
                "result": { "artifactId": "app-1", "downloadSizeBytes": 0 }
            })])),
            ..Default::default()
        });
        let falsy_services = GraphqlServices::new(falsy_store, Arc::new(Cache), Arc::new(Cache));
        assert_eq!(
            resolve(
                "Build",
                "downloadSizeBytes",
                &json!({"appName": "app-1", "labelName": "Live-Win32"}),
                &json!({}),
                &falsy_services,
            )
            .await
            .unwrap(),
            Some(Value::Null)
        );
        for args in [
            json!({"q": "pak", "extension": "ucas", "sort": "fileName", "dir": "desc"}),
            json!({"q": "pak", "sort": "fileSize", "dir": "desc"}),
            json!({"extension": "exe,dll", "sort": "other"}),
        ] {
            assert!(
                resolve("Build", "files", &json!({"hash": "h1"}), &args, &services)
                    .await
                    .is_ok()
            );
        }
        assert_eq!(projection(&json!({})), doc! {"id": 1, "_id": 1});

        // Loaders empty Achievements / Assets / Sandbox.
        assert_eq!(
            services
                .loaders
                .one(loaders::Lookup::Achievements, "missing")
                .await
                .unwrap(),
            json!([])
        );
        assert_eq!(
            services
                .loaders
                .one(loaders::Lookup::Sandbox, "missing")
                .await
                .unwrap(),
            Value::Null
        );

        // Sandbox unknown field returns Null.
        assert_eq!(
            sandbox::resolve("unknown", &json!({"_id": "s1"}), &json!({}), &services)
                .await
                .unwrap(),
            Value::Null
        );

        // Relationships: Changelog.document non-offer inline & contextType item/asset/unknown.
        assert_eq!(
            relationships::document(
                &json!({"document": {"id": "i1", "title": "Item"}}),
                &json!({}),
                &services,
            )
            .await
            .unwrap(),
            json!({"id": "i1", "title": "Item"})
        );
        assert_eq!(
            relationships::document(
                &json!({"metadata": {"contextType": "item", "contextId": "item-1"}}),
                &json!({}),
                &services,
            )
            .await
            .unwrap(),
            json!({"id": "item-1", "title": "Example"})
        );
        assert_eq!(
            relationships::document(
                &json!({"metadata": {"contextType": "unknown", "contextId": "x"}}),
                &json!({}),
                &services,
            )
            .await
            .unwrap(),
            Value::Null
        );

        // Exercise remaining trait stubs on test mocks.
        assert!(
            store
                .find_stream("c", Document::new(), Default::default())
                .await
                .is_ok()
        );
        assert!(store.aggregate("c", vec![]).await.is_ok());
        assert!(store.distinct("c", "f", Document::new()).await.is_ok());
        assert!(store.insert_one("c", Document::new()).await.is_ok());
        assert!(
            store
                .update_one("c", Document::new(), Document::new(), false)
                .await
                .is_ok()
        );
        assert!(store.delete_one("c", Document::new()).await.is_ok());
        assert!(MongoStorePort::ping(store.as_ref()).await.unwrap());
        assert!(store.del("k").await.is_ok());
        assert!(ResponseCachePort::ping(store.as_ref()).await.unwrap());
        assert!(Cache.graphql("q", &Value::Null).await.is_ok());
        assert!(Cache.featured_games().await.is_ok());
        assert!(Cache.del("k").await.is_ok());
        assert!(Cache.ping().await.unwrap());
    }
}
