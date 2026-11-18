//! Mongo-backed, request-scoped equivalents of `src/graphql/loaders.ts`.
use async_graphql::{Error, Result};
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
    time::Duration,
};
use tokio::sync::oneshot;

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

impl Batch {
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

type WaiterTx = oneshot::Sender<std::result::Result<HashMap<Key, Value>, String>>;

struct BatchQueue {
    cache: HashMap<Key, Value>,
    pending: HashSet<Key>,
    waiters: Vec<(HashSet<Key>, WaiterTx)>,
    scheduled: bool,
}

struct BatchLoaderInner {
    batch: Batch,
    queue: Mutex<BatchQueue>,
}

impl BatchLoaderInner {
    async fn flush(&self) {
        let (pending, waiters) = {
            let mut queue = self.queue.lock().unwrap();
            queue.scheduled = false;
            (
                std::mem::take(&mut queue.pending),
                std::mem::take(&mut queue.waiters),
            )
        };
        let keys: Vec<Key> = pending.into_iter().collect();
        match self.batch.load(&keys).await {
            Ok(values) => {
                {
                    let mut queue = self.queue.lock().unwrap();
                    for (k, v) in &values {
                        queue.cache.insert(k.clone(), v.clone());
                    }
                }
                for (waiter_keys, tx) in waiters {
                    let mut out = HashMap::with_capacity(waiter_keys.len());
                    for k in waiter_keys {
                        if let Some(v) = values.get(&k) {
                            out.insert(k, v.clone());
                        }
                    }
                    let _ = tx.send(Ok(out));
                }
            }
            Err(err) => {
                for (_, tx) in waiters {
                    let _ = tx.send(Err(err.clone()));
                }
            }
        }
    }
}

struct BatchLoader {
    inner: Arc<BatchLoaderInner>,
}

impl BatchLoader {
    fn new(batch: Batch) -> Self {
        Self {
            inner: Arc::new(BatchLoaderInner {
                batch,
                queue: Mutex::new(BatchQueue {
                    cache: HashMap::new(),
                    pending: HashSet::new(),
                    waiters: Vec::new(),
                    scheduled: false,
                }),
            }),
        }
    }

    fn loader(&self) -> &Batch {
        &self.inner.batch
    }

    async fn load_one(&self, key: Key) -> Result<Option<Value>> {
        let mut values = self.load_many(std::iter::once(key.clone())).await?;
        Ok(values.remove(&key))
    }

    async fn load_many<I>(&self, keys: I) -> Result<HashMap<Key, Value>>
    where
        I: IntoIterator<Item = Key>,
    {
        let (cached_hits, rx, should_spawn) = {
            let mut queue = self.inner.queue.lock().unwrap();
            let mut cached_hits = HashMap::new();
            let mut needed = HashSet::new();
            for key in keys {
                if let Some(value) = queue.cache.get(&key) {
                    cached_hits.insert(key, value.clone());
                } else {
                    needed.insert(key);
                }
            }
            if needed.is_empty() {
                return Ok(cached_hits);
            }
            let should_spawn = !queue.scheduled;
            queue.scheduled = true;
            queue.pending.extend(needed.iter().cloned());
            let (tx, rx) = oneshot::channel();
            queue.waiters.push((needed, tx));
            (cached_hits, rx, should_spawn)
        };

        if should_spawn {
            let inner = Arc::clone(&self.inner);
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(1)).await;
                inner.flush().await;
            });
        }

        let loaded = rx
            .await
            .expect("dataloader batch task always sends")
            .map_err(Error::new)?;
        let mut merged = cached_hits;
        merged.extend(loaded);
        Ok(merged)
    }
}

pub(super) struct Loaders([BatchLoader; 7]);
impl Loaders {
    pub(super) fn new(mongo: Arc<dyn MongoStorePort>) -> Self {
        Self(
            [Item, SubItems, Build, Sandbox, Achievements, Assets, Price].map(|kind| {
                BatchLoader::new(Batch {
                    kind,
                    mongo: mongo.clone(),
                    ordinals: Mutex::default(),
                    next: AtomicUsize::new(0),
                })
            }),
        )
    }
    pub(super) async fn one(&self, kind: Lookup, id: &str) -> Result<Value> {
        self.one_value(kind, Value::String(id.to_owned())).await
    }

    pub(super) async fn one_value(&self, kind: Lookup, id: Value) -> Result<Value> {
        let loader = &self.0[kind as usize];
        let value = loader.load_one(loader.loader().key(id)).await?;
        Ok(value.unwrap_or(Value::Null))
    }
    pub(super) async fn many(&self, kind: Lookup, ids: &[String]) -> Result<Vec<Value>> {
        let loader = &self.0[kind as usize];
        let keys = ids
            .iter()
            .map(|id| loader.loader().key(Value::String(id.clone())))
            .collect::<Vec<_>>();
        let hits = loader.load_many(keys.clone()).await?;
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
            .await?;
        Ok(value.unwrap_or(Value::Null))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use bson::Document;
    use egdata_core::error::CoreError;
    use egdata_core::ports::MongoFindOptions;
    use serde_json::json;

    struct StubMongo {
        rows: Vec<Document>,
        fail: bool,
        calls: AtomicUsize,
    }

    #[async_trait]
    impl MongoStorePort for StubMongo {
        async fn find_one(
            &self,
            _: &str,
            _: Document,
            _: Option<Document>,
        ) -> std::result::Result<Option<Document>, CoreError> {
            Ok(None)
        }
        async fn find_many(
            &self,
            _: &str,
            _: Document,
            _: MongoFindOptions,
        ) -> std::result::Result<Vec<Document>, CoreError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.fail {
                return Err(CoreError::Internal("mongo down".into()));
            }
            Ok(self.rows.clone())
        }
        async fn aggregate(
            &self,
            _: &str,
            _: Vec<Document>,
        ) -> std::result::Result<Vec<Document>, CoreError> {
            Ok(vec![])
        }
        async fn count_documents(
            &self,
            _: &str,
            _: Document,
        ) -> std::result::Result<u64, CoreError> {
            Ok(0)
        }
        async fn distinct(
            &self,
            _: &str,
            _: &str,
            _: Document,
        ) -> std::result::Result<Vec<bson::Bson>, CoreError> {
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

    #[tokio::test]
    async fn batch_loader_coalesces_caches_handles_empty_and_errors() {
        let mongo = Arc::new(StubMongo {
            rows: vec![doc! { "id": "i1", "title": "Game 1" }],
            fail: false,
            calls: AtomicUsize::new(0),
        });
        let loaders = Loaders::new(mongo.clone());

        // Empty batch returns immediately without spawning or hitting Mongo.
        assert!(loaders.many(Lookup::Item, &[]).await.unwrap().is_empty());
        assert_eq!(mongo.calls.load(Ordering::SeqCst), 0);

        // Concurrent requests within the same tick coalesce into one Mongo call.
        let (r1, r2) = tokio::join!(
            loaders.one(Lookup::Item, "i1"),
            loaders.one(Lookup::Item, "missing")
        );
        assert_eq!(r1.unwrap(), json!({ "id": "i1", "title": "Game 1" }));
        assert_eq!(r2.unwrap(), Value::Null);
        assert_eq!(mongo.calls.load(Ordering::SeqCst), 1);

        // Subsequent request for "i1" hits the in-memory request cache.
        let r3 = loaders.one(Lookup::Item, "i1").await.unwrap();
        assert_eq!(r3, json!({ "id": "i1", "title": "Game 1" }));
        assert_eq!(mongo.calls.load(Ordering::SeqCst), 1);

        // Error from Mongo propagates to all waiting callers.
        let failing = Arc::new(StubMongo {
            rows: vec![],
            fail: true,
            calls: AtomicUsize::new(0),
        });
        let failing_loaders = Loaders::new(failing);
        let (e1, e2) = tokio::join!(
            failing_loaders.one(Lookup::Item, "a"),
            failing_loaders.one(Lookup::Item, "b")
        );
        assert!(e1.is_err());
        assert!(e2.is_err());

        // Exercise unused trait methods on StubMongo.
        assert!(mongo.ping().await.unwrap());
        assert!(mongo.find_one("c", doc! {}, None).await.unwrap().is_none());
        assert!(mongo.aggregate("c", vec![]).await.unwrap().is_empty());
        assert_eq!(mongo.count_documents("c", doc! {}).await.unwrap(), 0);
        assert!(mongo.distinct("c", "f", doc! {}).await.unwrap().is_empty());
        mongo.insert_one("c", doc! {}).await.unwrap();
        assert_eq!(mongo.update_one("c", doc! {}, doc! {}, false).await.unwrap(), 0);
        assert_eq!(mongo.delete_one("c", doc! {}).await.unwrap(), 0);
    }
}
