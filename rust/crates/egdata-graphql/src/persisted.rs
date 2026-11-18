//! Apollo Automatic Persisted Queries (APQ) helpers matching
//! `src/graphql/apq.ts` and `src/graphql/persisted-queries.ts`.

use async_graphql::indexmap::IndexMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use egdata_core::ports::ResponseCachePort;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

pub const APQ_PREFIX: &str = "egdata:graphql:apq:";
pub const APQ_TTL_SECONDS: u64 = 30 * 24 * 60 * 60;
pub const APQ_MEMORY_MAX_ENTRIES: usize = 2_000;
pub const APQ_REDIS_OUTAGE_BACKOFF: Duration = Duration::from_secs(30);
pub const APQ_REDIS_COMMAND_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, PartialEq)]
pub struct PersistedQueryRequest {
    pub method: String,
    /// Raw URL query string, including or excluding the leading `?`.
    pub search: String,
    pub body: Option<Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PersistedQueryError {
    pub status: u16,
    pub message: &'static str,
    pub code: &'static str,
}

impl PersistedQueryError {
    pub fn response_body(&self) -> Value {
        json!({
            "errors": [{
                "message": self.message,
                "extensions": {"code": self.code}
            }]
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PersistedQueryOutcome {
    pub request: PersistedQueryRequest,
    pub error: Option<PersistedQueryError>,
}

#[derive(Default)]
struct MemoryStore {
    entries: IndexMap<String, String>,
}

impl MemoryStore {
    fn get(&self, hash: &str) -> Option<String> {
        self.entries.get(hash).cloned()
    }

    fn insert(&mut self, hash: String, query: String) {
        // Node's Map updates insertion order on a write. A read does not
        // refresh an entry's position in the eviction queue.
        self.entries.shift_remove(&hash);
        self.entries.insert(hash, query);
        if self.entries.len() > APQ_MEMORY_MAX_ENTRIES {
            self.entries.shift_remove_index(0);
        }
    }
}

/// Redis-backed APQ store with the same insertion-order fallback and outage backoff
/// as the Node implementation. Redis failures are deliberately fail-open.
pub struct PersistedQueryStore {
    cache: Arc<dyn ResponseCachePort>,
    memory: Mutex<MemoryStore>,
    redis_unavailable_until: Mutex<Option<Instant>>,
}

impl PersistedQueryStore {
    pub fn new(cache: Arc<dyn ResponseCachePort>) -> Self {
        Self {
            cache,
            memory: Mutex::new(MemoryStore::default()),
            redis_unavailable_until: Mutex::new(None),
        }
    }

    pub async fn get(&self, hash: &str) -> Option<String> {
        if let Ok(memory) = self.memory.lock()
            && let Some(value) = memory.get(hash).filter(|value| !value.is_empty())
        {
            return Some(value);
        }
        if !self.redis_available() {
            return None;
        }

        match tokio::time::timeout(
            APQ_REDIS_COMMAND_TIMEOUT,
            self.cache.get(&persisted_query_key(hash)),
        )
        .await
        {
            Ok(Ok(Some(value))) => {
                if !value.is_empty() {
                    self.remember(hash, &value);
                }
                Some(value)
            }
            Ok(Ok(None)) => None,
            Ok(Err(_)) | Err(_) => {
                self.mark_redis_unavailable();
                None
            }
        }
    }

    pub async fn store(&self, hash: &str, query: &str) {
        self.remember(hash, query);
        if !self.redis_available() {
            return;
        }
        let stored = tokio::time::timeout(
            APQ_REDIS_COMMAND_TIMEOUT,
            self.cache
                .set(&persisted_query_key(hash), query, APQ_TTL_SECONDS),
        )
        .await;
        if !matches!(stored, Ok(Ok(()))) {
            self.mark_redis_unavailable();
        }
    }

    fn remember(&self, hash: &str, query: &str) {
        if let Ok(mut memory) = self.memory.lock() {
            memory.insert(hash.to_owned(), query.to_owned());
        }
    }

    fn redis_available(&self) -> bool {
        self.redis_unavailable_until
            .lock()
            .map(|until| until.is_none_or(|time| Instant::now() >= time))
            .unwrap_or(false)
    }

    fn mark_redis_unavailable(&self) {
        if let Ok(mut until) = self.redis_unavailable_until.lock() {
            *until = Some(Instant::now() + APQ_REDIS_OUTAGE_BACKOFF);
        }
    }
}

pub fn persisted_query_key(hash: &str) -> String {
    format!("{APQ_PREFIX}{hash}")
}

pub fn hash_query(query: &str) -> String {
    let digest = Sha256::digest(query.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn is_valid_persisted_query_hash(value: &Value) -> bool {
    value.as_str().is_some_and(|value| {
        value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

/// Applies APQ lookup, validation, and storage before the GraphQL executor.
pub async fn apply_persisted_query(
    store: &PersistedQueryStore,
    mut request: PersistedQueryRequest,
) -> PersistedQueryOutcome {
    let extension = get_persisted_extension(request.body.as_ref(), &request.search);
    let Some(extension) = extension else {
        return PersistedQueryOutcome {
            request,
            error: None,
        };
    };

    if extension.get("version").and_then(Value::as_f64) != Some(1.0) {
        return failure(
            request,
            200,
            "Unsupported persisted query version.",
            "PERSISTED_QUERY_NOT_SUPPORTED",
        );
    }

    let hash_value = extension.get("sha256Hash").unwrap_or(&Value::Null);
    if !is_valid_persisted_query_hash(hash_value) {
        return failure(
            request,
            400,
            "Invalid persisted query sha256Hash.",
            "PERSISTED_QUERY_HASH_MISMATCH",
        );
    }
    let hash = hash_value.as_str().unwrap_or_default().to_ascii_lowercase();
    let query = get_request_query(request.body.as_ref(), &request.search);

    if let Some(query) = query.filter(|query| !query.is_empty()) {
        if hash_query(&query) != hash {
            return failure(
                request,
                400,
                "provided sha does not match query",
                "PERSISTED_QUERY_HASH_MISMATCH",
            );
        }
        if query.len() <= crate::validation::MAX_QUERY_BYTES {
            store.store(&hash, &query).await;
        }
        return PersistedQueryOutcome {
            request,
            error: None,
        };
    }

    let Some(stored) = store.get(&hash).await.filter(|value| !value.is_empty()) else {
        return failure(
            request,
            200,
            "PersistedQueryNotFound",
            "PERSISTED_QUERY_NOT_FOUND",
        );
    };
    if request.method.eq_ignore_ascii_case("GET") {
        request.search = set_query_param(&request.search, "query", &stored);
    } else {
        let mut body = request
            .body
            .take()
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        body.insert("query".to_owned(), Value::String(stored));
        request.body = Some(Value::Object(body));
    }
    PersistedQueryOutcome {
        request,
        error: None,
    }
}

fn failure(
    request: PersistedQueryRequest,
    status: u16,
    message: &'static str,
    code: &'static str,
) -> PersistedQueryOutcome {
    PersistedQueryOutcome {
        request,
        error: Some(PersistedQueryError {
            status,
            message,
            code,
        }),
    }
}

fn get_persisted_extension(body: Option<&Value>, search: &str) -> Option<Map<String, Value>> {
    if let Some(extension) = body
        .and_then(Value::as_object)
        .and_then(|body| body.get("extensions"))
        .and_then(Value::as_object)
        .and_then(|extensions| extensions.get("persistedQuery"))
        .and_then(Value::as_object)
    {
        return Some(extension.clone());
    }
    let extensions = query_param(search, "extensions")?;
    let parsed: Value = serde_json::from_str(&extensions).ok()?;
    parsed
        .as_object()?
        .get("persistedQuery")?
        .as_object()
        .cloned()
}

fn get_request_query(body: Option<&Value>, search: &str) -> Option<String> {
    body.and_then(Value::as_object)
        .and_then(|body| body.get("query"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| query_param(search, "query"))
}

fn query_param(search: &str, key: &str) -> Option<String> {
    strip_search_marker(search)
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| pair.split_once('=').unwrap_or((pair, "")))
        .find_map(|(candidate, value)| {
            (decode_form_component(candidate) == key).then(|| decode_form_component(value))
        })
}

fn set_query_param(search: &str, key: &str, value: &str) -> String {
    let raw_search = strip_search_marker(search);
    let mut found = false;
    let mut pairs: Vec<(String, String)> = if raw_search.is_empty() {
        Vec::new()
    } else {
        raw_search
            .split('&')
            .filter(|part| !part.is_empty())
            .map(|part| {
                let (key, value) = part.split_once('=').unwrap_or((part, ""));
                (decode_form_component(key), decode_form_component(value))
            })
            .filter_map(|(name, old_value)| {
                if name != key {
                    Some((name, old_value))
                } else if !found {
                    found = true;
                    Some((name, value.to_owned()))
                } else {
                    None
                }
            })
            .collect()
    };
    if !found {
        pairs.push((key.to_owned(), value.to_owned()));
    }
    format!(
        "?{}",
        pairs
            .iter()
            .map(|(key, value)| format!(
                "{}={}",
                encode_form_component(key),
                encode_form_component(value)
            ))
            .collect::<Vec<_>>()
            .join("&")
    )
}

fn decode_form_component(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                if let (Some(high), Some(low)) =
                    (hex_digit(bytes[index + 1]), hex_digit(bytes[index + 2]))
                {
                    decoded.push((high << 4) | low);
                    index += 3;
                } else {
                    decoded.push(bytes[index]);
                    index += 1;
                }
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn encode_form_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'*' | b'-' | b'.' | b'_') {
            encoded.push(byte as char);
        } else if byte == b' ' {
            encoded.push('+');
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn strip_search_marker(search: &str) -> &str {
    search.strip_prefix('?').unwrap_or(search)
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use egdata_core::error::CoreError;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    #[derive(Default)]
    struct TestCache {
        values: Mutex<HashMap<String, String>>,
        fail: AtomicBool,
        gets: AtomicUsize,
        writes: Mutex<Vec<(String, u64)>>,
    }

    #[async_trait]
    impl ResponseCachePort for TestCache {
        async fn get(&self, key: &str) -> Result<Option<String>, CoreError> {
            self.gets.fetch_add(1, Ordering::SeqCst);
            if self.fail.load(Ordering::SeqCst) {
                return Err(CoreError::Internal("cache unavailable".into()));
            }
            Ok(self.values.lock().unwrap().get(key).cloned())
        }

        async fn set(&self, key: &str, value: &str, ttl_seconds: u64) -> Result<(), CoreError> {
            self.writes
                .lock()
                .unwrap()
                .push((key.to_owned(), ttl_seconds));
            if self.fail.load(Ordering::SeqCst) {
                return Err(CoreError::Internal("cache unavailable".into()));
            }
            self.values
                .lock()
                .unwrap()
                .insert(key.to_owned(), value.to_owned());
            Ok(())
        }

        async fn del(&self, key: &str) -> Result<(), CoreError> {
            self.values.lock().unwrap().remove(key);
            Ok(())
        }

        async fn ping(&self) -> Result<bool, CoreError> {
            Ok(!self.fail.load(Ordering::SeqCst))
        }
    }

    fn body(query: Option<&str>, version: Value, hash: Value) -> PersistedQueryRequest {
        let mut body = json!({
            "extensions": {"persistedQuery": {"version": version, "sha256Hash": hash}},
            "variables": {"id": "offer-1"}
        });
        if let Some(query) = query {
            body["query"] = Value::String(query.into());
        }
        PersistedQueryRequest {
            method: "POST".into(),
            search: String::new(),
            body: Some(body),
        }
    }

    #[tokio::test]
    async fn unavailable_memory_cache_falls_back_to_redis() {
        let cache = Arc::new(TestCache::default());
        let store = Arc::new(PersistedQueryStore::new(cache.clone()));
        let worker = store.clone();
        assert!(
            std::thread::spawn(move || {
                let _guard = worker.memory.lock().unwrap();
                panic!("simulate unavailable memory cache");
            })
            .join()
            .is_err()
        );
        store.store("hash", "document").await;
        assert_eq!(store.get("hash").await.as_deref(), Some("document"));
        let worker = store.clone();
        assert!(
            std::thread::spawn(move || {
                let _guard = worker.redis_unavailable_until.lock().unwrap();
                panic!("simulate unavailable outage state");
            })
            .join()
            .is_err()
        );
        store.mark_redis_unavailable();
        assert!(store.get("hash").await.is_none());
    }

    #[tokio::test]
    async fn ignores_invalid_extensions_and_empty_stored_documents() {
        for extensions in ["garbage", "[]", "{}", r#"{"persistedQuery":null}"#] {
            assert_eq!(
                get_persisted_extension(None, &format!("extensions={extensions}")),
                None
            );
        }
        assert_eq!(
            get_request_query(None, "query&query=second"),
            Some(String::new())
        );
        assert_eq!(set_query_param("&&x&&", "query", "doc"), "?x=&query=doc");

        let cache = Arc::new(TestCache::default());
        let store = PersistedQueryStore::new(cache.clone());
        let hash = hash_query("{events{id}}");
        cache
            .values
            .lock()
            .unwrap()
            .insert(persisted_query_key(&hash), String::new());
        let response = apply_persisted_query(&store, body(None, json!(1), json!(hash))).await;
        assert_eq!(response.error.unwrap().code, "PERSISTED_QUERY_NOT_FOUND");
        assert!(!store.memory.lock().unwrap().entries.contains_key(&hash));
    }

    #[test]
    fn memory_reads_preserve_node_map_eviction_order() {
        let mut memory = MemoryStore::default();
        for n in 0..APQ_MEMORY_MAX_ENTRIES {
            memory.insert(n.to_string(), format!("q{n}"));
        }
        assert_eq!(memory.get("0").as_deref(), Some("q0"));
        memory.insert("1".into(), "rewritten".into());
        memory.insert("new".into(), "new".into());
        assert!(memory.get("0").is_none());
        assert_eq!(memory.get("1").as_deref(), Some("rewritten"));
    }

    #[tokio::test]
    async fn stores_hash_lookup_key_ttl_and_rewrites_get_using_cache() {
        let cache = Arc::new(TestCache::default());
        let store = PersistedQueryStore::new(cache.clone());
        let query = "query Offer($id: ID!) { offer(id: $id) { id title } }";
        let hash = hash_query(query);

        let stored = apply_persisted_query(
            &store,
            body(
                Some(query),
                Value::from(1),
                Value::String(hash.to_ascii_uppercase()),
            ),
        )
        .await;
        assert!(stored.error.is_none());
        assert_eq!(
            cache.writes.lock().unwrap().as_slice(),
            &[(persisted_query_key(&hash), APQ_TTL_SECONDS)]
        );

        let lookup = PersistedQueryRequest {
            method: "GET".into(),
            search: format!(
                "?extensions={}&variables=%7B%22id%22%3A%22offer-1%22%7D",
                encode_form_component(
                    &json!({"persistedQuery":{"version":1,"sha256Hash":hash}}).to_string()
                )
            ),
            body: None,
        };
        let found = apply_persisted_query(&store, lookup).await;
        assert!(found.error.is_none());
        assert_eq!(
            query_param(&found.request.search, "query").as_deref(),
            Some(query)
        );
        assert_eq!(
            query_param(&found.request.search, "variables").as_deref(),
            Some(r#"{"id":"offer-1"}"#)
        );
        assert!(found.request.search.ends_with(
            "&query=query+Offer%28%24id%3A+ID%21%29+%7B+offer%28id%3A+%24id%29+%7B+id+title+%7D+%7D"
        ));
    }

    #[tokio::test]
    async fn emits_apollo_protocol_errors_and_hashes_utf8_exactly() {
        let cache = Arc::new(TestCache::default());
        let store = PersistedQueryStore::new(cache.clone());
        let query = "query { offer(id: \"café\") { id } }";
        let hash = hash_query(query);
        assert_eq!(hash.len(), 64);
        assert!(hash.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(
            hash_query("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );

        let mismatch = apply_persisted_query(
            &store,
            body(Some(query), Value::from(1), Value::String("0".repeat(64))),
        )
        .await;
        assert_eq!(
            mismatch.error,
            Some(PersistedQueryError {
                status: 400,
                message: "provided sha does not match query",
                code: "PERSISTED_QUERY_HASH_MISMATCH"
            })
        );

        let unsupported = apply_persisted_query(
            &store,
            body(Some(query), Value::from(2), Value::String(hash.clone())),
        )
        .await;
        assert_eq!(
            unsupported.error.as_ref().map(|error| error.status),
            Some(200)
        );
        assert_eq!(
            unsupported.error.as_ref().map(|error| error.code),
            Some("PERSISTED_QUERY_NOT_SUPPORTED")
        );

        let invalid_hash = apply_persisted_query(
            &store,
            body(None, Value::from(1), Value::String("invalid".into())),
        )
        .await;
        assert_eq!(
            invalid_hash.error.as_ref().map(|error| error.status),
            Some(400)
        );

        let missing =
            apply_persisted_query(&store, body(None, Value::from(1), Value::String(hash))).await;
        assert_eq!(missing.error.as_ref().map(|error| error.status), Some(200));
        assert_eq!(
            missing.error.as_ref().map(|error| error.code),
            Some("PERSISTED_QUERY_NOT_FOUND")
        );
        assert_eq!(cache.writes.lock().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn redis_failure_uses_memory_fallback_and_backs_off() {
        let cache = Arc::new(TestCache::default());
        cache.fail.store(true, Ordering::SeqCst);
        let store = PersistedQueryStore::new(cache.clone());
        let query = "query { offer { id } }";
        let hash = hash_query(query);
        let stored = apply_persisted_query(
            &store,
            body(Some(query), Value::from(1), Value::String(hash.clone())),
        )
        .await;
        assert!(stored.error.is_none());
        assert_eq!(cache.gets.load(Ordering::SeqCst), 0);

        cache.fail.store(false, Ordering::SeqCst);
        let found =
            apply_persisted_query(&store, body(None, Value::from(1), Value::String(hash))).await;
        assert!(found.error.is_none());
        assert_eq!(cache.gets.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn covers_apq_edge_cases_lru_eviction_redis_hits_and_url_helpers() {
        let cache = Arc::new(TestCache::default());
        assert!(cache.ping().await.unwrap());
        cache.set("k", "v", 10).await.unwrap();
        cache.del("k").await.unwrap();

        let store = PersistedQueryStore::new(cache.clone());
        let query = "query { events { id } }";
        let hash = hash_query(query);

        // No extension -> pass through unchanged.
        let passthrough = apply_persisted_query(
            &store,
            PersistedQueryRequest {
                method: "GET".into(),
                search: "?query=%7B+events+%7B+id+%7D+%7D".into(),
                body: None,
            },
        )
        .await;
        assert!(passthrough.error.is_none());

        // Seed Redis directly (bypassing memory) to hit Redis fetch + memory populate.
        cache
            .values
            .lock()
            .unwrap()
            .insert(persisted_query_key(&hash), query.to_owned());
        let from_redis = apply_persisted_query(
            &store,
            PersistedQueryRequest {
                method: "POST".into(),
                search: String::new(),
                body: Some(json!({
                    "extensions": { "persistedQuery": { "version": 1, "sha256Hash": hash } }
                })),
            },
        )
        .await;
        assert!(from_redis.error.is_none());
        assert_eq!(
            from_redis.request.body.unwrap()["query"],
            Value::String(query.into())
        );

        // Oversized query with matching sha is NOT persisted in store.
        let big_query = format!(
            "query {{ events {{ id }} }} # {}",
            "a".repeat(crate::validation::MAX_QUERY_BYTES)
        );
        let big_hash = hash_query(&big_query);
        let big_res = apply_persisted_query(
            &store,
            body(
                Some(&big_query),
                Value::from(1),
                Value::String(big_hash.clone()),
            ),
        )
        .await;
        assert!(big_res.error.is_none());
        assert!(store.get(&big_hash).await.is_none());

        // Redis failure during get marks backoff and skips subsequent store/get calls.
        cache.fail.store(true, Ordering::SeqCst);
        assert!(store.get("0".repeat(64).as_str()).await.is_none());
        store.store("1".repeat(64).as_str(), "query { a }").await;
        assert!(store.get("2".repeat(64).as_str()).await.is_none());

        // MemoryStore insertion-order eviction when exceeding APQ_MEMORY_MAX_ENTRIES.
        for idx in 0..=APQ_MEMORY_MAX_ENTRIES {
            store.remember(&format!("h{idx:062}"), &format!("q{idx}"));
        }
        assert_eq!(
            store.memory.lock().unwrap().entries.len(),
            APQ_MEMORY_MAX_ENTRIES
        );
        assert!(
            store
                .memory
                .lock()
                .unwrap()
                .get(&format!("h{:062}", 0))
                .is_none()
        );

        // PersistedQueryError response_body helper.
        let err = PersistedQueryError {
            status: 400,
            message: "bad",
            code: "CODE",
        };
        assert_eq!(
            err.response_body(),
            json!({"errors": [{"message": "bad", "extensions": {"code": "CODE"}}]})
        );

        // URL query parameter helpers: empty search, replacing & deduplicating query param, invalid %XX.
        assert_eq!(set_query_param("", "query", "{ a }"), "?query=%7B+a+%7D");
        assert_eq!(
            set_query_param("?query=old&foo=bar&query=dup", "query", "new"),
            "?query=new&foo=bar"
        );
        assert_eq!(decode_form_component("a+b%20%ZZ%2a%2A"), "a b %ZZ**");
        assert_eq!(hex_digit(b'f'), Some(15));
        assert_eq!(hex_digit(b'F'), Some(15));
        assert_eq!(hex_digit(b'Z'), None);
    }
}
