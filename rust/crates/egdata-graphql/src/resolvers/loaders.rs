//! Mongo-backed, request-scoped equivalents of `src/graphql/loaders.ts`.
use async_graphql::{
    Error, Result,
    dataloader::{DataLoader, HashMapCache, Loader},
};
use bson::doc;
use egdata_core::ports::MongoStorePort;
use egdata_core::v1::serialization::bson_to_serialized_json;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

#[derive(Clone, Copy, Debug)]
pub(super) enum Lookup {
    Item,
    SubItems,
    Build,
    Sandbox,
    Achievements,
    Assets,
    Price,
}
use Lookup::*;

impl Lookup {
    fn collection(self) -> (&'static str, &'static str) {
        match self {
            Item => ("items", "id"),
            SubItems => ("offersubitems", "_id"),
            Build => ("builds", "appName"),
            Sandbox => ("sandboxes", "_id"),
            Achievements => ("achievementsets", "sandboxId"),
            Assets => ("assets", "itemId"),
            Price => ("pricev2", "offerId"),
        }
    }
}

#[derive(Clone, Eq, PartialEq, Hash)]
struct Key {
    // Missing and null are distinct lookup keys in JavaScript. Both serialize
    // to BSON null in the MongoDB $in array.
    id: Option<Value>,
    region: Option<String>,
    // async-graphql collects pending keys in a hash set. Mongo receives keys in
    // registration order in Node, including repeated IDs for distinct price objects.
    ordinal: usize,
}

struct Batch {
    kind: Lookup,
    mongo: Arc<dyn MongoStorePort>,
    ordinals: Mutex<HashMap<Value, usize>>,
    next: AtomicUsize,
}

impl Batch {
    fn key(&self, id: Value) -> Key {
        let ordinal = *self
            .ordinals
            .lock()
            .unwrap()
            .entry(id.clone())
            .or_insert_with(|| self.next.fetch_add(1, Ordering::Relaxed));
        Key {
            id: Some(id),
            region: None,
            ordinal,
        }
    }
}

impl Loader<Key> for Batch {
    type Value = Value;
    type Error = String;
    async fn load(&self, keys: &[Key]) -> std::result::Result<HashMap<Key, Value>, String> {
        let mut keys = keys.to_vec();
        keys.sort_by_key(|k| k.ordinal);
        let (collection, field) = self.kind.collection();
        let mut filter = doc! {field:{"$in":keys.iter().map(|k| bson::to_bson(&k.id).unwrap_or(bson::Bson::Null)).collect::<Vec<_>>()}};
        if matches!(self.kind, Price) {
            let mut seen = HashSet::new();
            let regions = keys
                .iter()
                .filter_map(|k| k.region.as_deref())
                .filter(|v| seen.insert(*v))
                .collect::<Vec<_>>();
            filter.insert("region", doc! {"$in":regions});
        }
        let rows = self
            .mongo
            .find_many(collection, filter, Default::default())
            .await
            .map_err(|e| e.to_string())?;
        let mut grouped = HashMap::<Option<Value>, Vec<Value>>::new();
        for row in rows {
            let row = bson_to_serialized_json(&bson::Bson::Document(row));
            grouped
                .entry(row.get(field).cloned())
                .or_default()
                .push(row);
        }
        let mut results = HashMap::new();
        for key in keys {
            let group = grouped.get(&key.id).map(Vec::as_slice).unwrap_or_default();
            let value = match self.kind {
                Achievements | Assets => Value::Array(group.to_vec()),
                Price => group
                    .iter()
                    .find(|r| r["region"].as_str() == key.region.as_deref())
                    .cloned()
                    .unwrap_or(Value::Null),
                Build => {
                    let mut current = group.first();
                    for next in group.iter().skip(1) {
                        let timestamp = |r: &Value| {
                            let value = r.get("updatedAt")?;
                            match value {
                                Value::Null => Some(0),
                                Value::Bool(v) => Some(i64::from(*v)),
                                Value::Number(n) => {
                                    n.as_f64().filter(|n| n.abs() <= 8.64e15).map(|n| n as i64)
                                }
                                _ => egdata_core::v1::serialization::iso_or_null(value)
                                    .and_then(|text| {
                                        chrono::DateTime::parse_from_rfc3339(&text).ok()
                                    })
                                    .map(|date| date.timestamp_millis()),
                            }
                        };
                        if let Some(previous) = current
                            && let (Some(a), Some(b)) = (timestamp(next), timestamp(previous))
                            && a > b
                        {
                            current = Some(next);
                        }
                    }
                    current.cloned().unwrap_or(Value::Null)
                }
                _ => group.last().cloned().unwrap_or(Value::Null),
            };
            results.insert(key, value);
        }
        Ok(results)
    }
}

pub(super) struct Loaders([DataLoader<Batch, HashMapCache>; 7]);
impl Loaders {
    pub(super) fn new(mongo: Arc<dyn MongoStorePort>) -> Self {
        Self(
            [Item, SubItems, Build, Sandbox, Achievements, Assets, Price].map(|kind| {
                DataLoader::with_cache(
                    Batch {
                        kind,
                        mongo: mongo.clone(),
                        ordinals: Mutex::default(),
                        next: AtomicUsize::new(0),
                    },
                    tokio::spawn,
                    HashMapCache::default(),
                )
                .max_batch_size(usize::MAX)
            }),
        )
    }
    pub(super) async fn one(&self, kind: Lookup, id: &str) -> Result<Value> {
        self.one_value(kind, Value::String(id.to_owned())).await
    }

    pub(super) async fn one_value(&self, kind: Lookup, id: Value) -> Result<Value> {
        let loader = &self.0[kind as usize];
        let value = loader
            .load_one(loader.loader().key(id))
            .await
            .map_err(Error::new)?;
        Ok(value.unwrap_or(Value::Null))
    }
    pub(super) async fn many(&self, kind: Lookup, ids: &[String]) -> Result<Vec<Value>> {
        let loader = &self.0[kind as usize];
        let keys = ids
            .iter()
            .map(|id| loader.loader().key(Value::String(id.clone())))
            .collect::<Vec<_>>();
        let hits = loader.load_many(keys.clone()).await.map_err(Error::new)?;
        Ok(keys
            .iter()
            .map(|key| hits.get(key).cloned().unwrap_or(Value::Null))
            .collect())
    }
    pub(super) async fn price(&self, id: Option<&Value>, region: &str) -> Result<Value> {
        let loader = &self.0[Price as usize];
        let value = loader
            .load_one(Key {
                id: id.cloned(),
                region: Some(region.to_owned()),
                ordinal: loader.loader().next.fetch_add(1, Ordering::Relaxed),
            })
            .await
            .map_err(Error::new)?;
        Ok(value.unwrap_or(Value::Null))
    }
}
