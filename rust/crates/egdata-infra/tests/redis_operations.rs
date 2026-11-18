use egdata_infra::redis_store::*;
use redis::AsyncCommands;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::Arc;

#[test]
fn shared_and_dedicated_connection_options_match_node() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../egdata-api/tests/fixtures/redis-connection-config-node.json"
    ))
    .unwrap();
    let as_json = |config: RedisConfig| json!({"host":config.host,"port":config.port,"tls":config.tls,"username":config.username,"password":config.password});
    for case in cases {
        let env = |key: &str| case["input"][key].as_str().map(str::to_owned);
        let shared = RedisConfig::from_env_lookup(env);
        if case["shared"]["port"]
            .as_u64()
            .is_some_and(|port| port <= u16::MAX.into())
        {
            assert_eq!(as_json(shared.unwrap()), case["shared"]);
        } else {
            assert!(matches!(shared, Err(RedisStoreError::InvalidSharedPort)));
        }
        let actual = match ResponseCacheConfig::from_env_lookup(env) {
            Ok(config) => {
                json!({"dedicated":config.dedicated.map(as_json),"key":format!("{}test",config.prefix)})
            }
            Err(err) => json!({"error":err.to_string()}),
        };
        assert_eq!(actual, case["cache"], "{}", case["input"]);
    }
}

#[test]
fn telemetry_endpoint_selection_matches_node() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../egdata-api/tests/fixtures/redis-telemetry-config-node.json"
    ))
    .unwrap();
    for case in cases {
        let input = &case["input"];
        let output = match telemetry_config(|key| input[key].as_str().map(str::to_owned)) {
            Ok(config) => {
                json!({"host":config.host,"port":config.port,"username":config.username,"password":config.password,"tls":config.tls})
            }
            Err(RedisStoreError::InvalidSharedPort) => {
                assert!(case["output"]["port"].is_number() || case["output"]["port"].is_string());
                assert!(
                    case["output"]["port"]
                        .as_u64()
                        .is_none_or(|port| port > u16::MAX.into())
                );
                continue;
            }
            Err(err) => json!({"error":err.to_string()}),
        };
        assert_eq!(output, case["output"], "{input}");
    }
}

async fn fixture() -> (redis::aio::ConnectionManager, Arc<ConnectionManagerBackend>) {
    let uri = std::env::var("EGDATA_TEST_REDIS").expect("disposable Redis URI");
    let manager = redis::Client::open(uri)
        .unwrap()
        .get_connection_manager()
        .await
        .unwrap();
    (
        manager.clone(),
        Arc::new(ConnectionManagerBackend::new(manager)),
    )
}

#[tokio::test]
#[ignore = "requires disposable Redis"]
async fn optional_cache_and_telemetry_reauthenticate_after_disconnect() {
    use std::time::Duration;
    let url = url::Url::parse(&std::env::var("EGDATA_TEST_REDIS").unwrap()).unwrap();
    let (mut admin, _) = fixture().await;
    let user = format!("recovery-{}", bson::oid::ObjectId::new().to_hex());
    let key = format!("{user}:v2:probe");
    let password = " temporary:/@% Redis password ";
    let config = RedisConfig {
        host: url.host_str().unwrap().to_owned(),
        port: url.port().unwrap(),
        tls: false,
        username: Some(user.clone()),
        password: Some(password.into()),
        connect_timeout_ms: Some(1000),
        command_timeout_ms: Some(1500),
    };
    let cache = ResponseCache::new(
        format!("{user}:v2:"),
        true,
        Arc::new(lazy_response_cache_backend(&config).unwrap()),
    );
    let telemetry = lazy_telemetry_backend(&config).unwrap();
    let shared = shared_redis_backend(&config).unwrap();
    let pending = shared.ping();
    tokio::pin!(pending);
    assert!(
        tokio::time::timeout(Duration::from_millis(50), &mut pending)
            .await
            .is_err()
    );
    assert_eq!(cache.get("probe").await.unwrap(), None);
    assert!(!cache.set("probe", "offline", 60).await.unwrap());
    assert!(telemetry.ping().await.is_err());
    redis::cmd("ACL")
        .arg("SETUSER")
        .arg(&user)
        .arg("on")
        .arg(format!(">{password}"))
        .arg("~*")
        .arg("+@all")
        .exec_async(&mut admin)
        .await
        .unwrap();
    async fn wait_ready(cache: &ResponseCache, telemetry: &ConnectionManagerBackend) {
        tokio::time::timeout(Duration::from_secs(8), async {
            while !cache.ping().await.unwrap() || !telemetry.ping().await.unwrap_or(false) {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
    }
    wait_ready(&cache, &telemetry).await;
    assert!(
        tokio::time::timeout(Duration::from_secs(8), pending)
            .await
            .unwrap()
            .unwrap()
    );
    assert!(cache.set("probe", "connected", 60).await.unwrap());
    assert_eq!(
        telemetry.get(&key).await.unwrap().as_deref(),
        Some("connected")
    );
    redis::cmd("ACL")
        .arg("SETUSER")
        .arg(&user)
        .arg("off")
        .exec_async(&mut admin)
        .await
        .unwrap();
    let killed: i64 = redis::cmd("CLIENT")
        .arg("KILL")
        .arg("USER")
        .arg(&user)
        .query_async(&mut admin)
        .await
        .unwrap();
    assert_eq!(killed, 3);
    let interrupted = shared.get(&key);
    tokio::pin!(interrupted);
    assert!(
        tokio::time::timeout(Duration::from_millis(50), &mut interrupted)
            .await
            .is_err()
    );
    assert!(!cache.ping().await.unwrap());
    assert!(telemetry.ping().await.is_err());
    assert_eq!(cache.get("probe").await.unwrap(), None);
    assert!(!cache.set("probe", "lost", 60).await.unwrap());
    redis::cmd("ACL")
        .arg("SETUSER")
        .arg(&user)
        .arg("on")
        .exec_async(&mut admin)
        .await
        .unwrap();
    wait_ready(&cache, &telemetry).await;
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(8), interrupted)
            .await
            .unwrap()
            .unwrap()
            .as_deref(),
        Some("connected")
    );
    assert_eq!(
        cache.get("probe").await.unwrap().as_deref(),
        Some("connected")
    );
    assert!(
        telemetry
            .set_px(&key, "updated", 1000, false)
            .await
            .unwrap()
    );
    assert!(cache.consume("probe").await.unwrap());
    drop((cache, telemetry));
    redis::cmd("ACL")
        .arg("DELUSER")
        .arg(&user)
        .exec_async(&mut admin)
        .await
        .unwrap();
}

async fn key_state(conn: &mut redis::aio::ConnectionManager, keys: &[String]) -> Vec<Value> {
    let mut out = Vec::new();
    for key in keys {
        let kind: String = redis::cmd("TYPE").arg(key).query_async(conn).await.unwrap();
        match kind.as_str() {
            "none" => out.push(Value::Null),
            "string" => {
                out.push(json!({"type":"string","value":conn.get::<_,String>(key).await.unwrap()}))
            }
            "hash" => {
                let raw: HashMap<String, String> = conn.hgetall(key).await.unwrap();
                let mut values = Map::new();
                for (field, value) in raw {
                    let stored = if value.starts_with('{') {
                        serde_json::from_str(&value).unwrap()
                    } else {
                        Value::String(value)
                    };
                    values.insert(
                        if field.starts_with("__batch:") {
                            "batch".into()
                        } else {
                            field
                        },
                        stored,
                    );
                }
                let expiry: i64 = redis::cmd("EXPIRETIME")
                    .arg(key)
                    .query_async(conn)
                    .await
                    .unwrap();
                out.push(json!({"type":"hash","values":values,"expireAt":expiry}));
            }
            _ => panic!("unexpected type {kind}"),
        }
    }
    out
}

#[tokio::test]
#[ignore = "requires disposable Redis"]
async fn lua_partial_writes_retries_and_absolute_expiry_match_node() {
    let (mut manager, backend) = fixture().await;
    let sums = RedisSummaryStore::new(backend.clone());
    let cohorts = RedisCohortStore::new(backend);
    let day = 40000i64;
    let minute = day * 1440;
    let keys = [
        format!("{COHORT_PREFIX}{day}"),
        format!("{COHORT_PREFIX}{}", day + 1),
        format!("{SUMMARY_PREFIX}{minute}"),
        format!("{SUMMARY_PREFIX}{}", minute + 1),
    ];
    manager.del::<_, usize>(&keys).await.unwrap();
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../egdata-api/tests/fixtures/redis-operations-node.json"
    ))
    .unwrap();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        if name.starts_with("cohort") {
            let rows = serde_json::from_value::<Vec<CohortUpdate>>(case["rows"].clone()).unwrap();
            if name.ends_with("partial") {
                manager
                    .set::<_, _, ()>(&keys[0], "wrong-type")
                    .await
                    .unwrap();
                assert!(
                    cohorts
                        .write(&rows)
                        .await
                        .unwrap_err()
                        .to_string()
                        .contains("WRONGTYPE")
                );
            } else {
                manager.del::<_, usize>(&keys[0]).await.unwrap();
                cohorts.write(&rows).await.unwrap();
            }
        } else {
            let rows: Vec<_> = case["sums"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| SummaryRow {
                    minute: r["minute"].as_i64().unwrap(),
                    values: serde_json::from_value(r["values"].clone()).unwrap(),
                })
                .collect();
            if name.ends_with("partial") {
                manager
                    .set::<_, _, ()>(&keys[3], "wrong-type")
                    .await
                    .unwrap();
                assert!(
                    sums.write(&rows, "fixture")
                        .await
                        .unwrap_err()
                        .to_string()
                        .contains("WRONGTYPE")
                );
            } else {
                manager.del::<_, usize>(&keys[3]).await.unwrap();
                sums.write(&rows, "fixture").await.unwrap();
            }
        }
        assert_eq!(
            json!(key_state(&mut manager, &keys).await),
            case["state"],
            "{name}"
        );
    }
    manager.del::<_, usize>(&keys).await.unwrap();
}

#[tokio::test]
#[ignore = "requires disposable Redis"]
async fn separate_replicas_apply_cache_policy_and_preserve_expiry_after_command_errors() {
    let (mut manager, backend) = fixture().await;
    let (_, peer) = fixture().await;
    let prefix = format!("fixture:{}:", uuid::Uuid::new_v4());
    let strict = ResponseCache::new(prefix.clone(), false, backend.clone());
    let tolerant = ResponseCache::new(prefix.clone(), true, peer.clone());
    let key = format!("{prefix}record");
    manager
        .hset::<_, _, _, usize>(&key, "field", "wrong-type")
        .await
        .unwrap();
    assert!(strict.get("record").await.is_err());
    assert_eq!(tolerant.get("record").await.unwrap(), None);
    assert!(strict.set("record", "original", 30).await.unwrap());
    assert!(!tolerant.set("record", "replacement", 0).await.unwrap());
    assert_eq!(
        strict.get("record").await.unwrap().as_deref(),
        Some("original")
    );
    assert!((1..=30_000).contains(&peer.pttl(&key).await.unwrap()));
    let (a, b) = tokio::join!(strict.consume("record"), tolerant.consume("record"));
    assert_ne!(a.unwrap(), b.unwrap());

    let limiter = RedisRateLimitStore::new(60_000, prefix, backend);
    let limit_key = limiter.key("client");
    manager
        .hset::<_, _, _, usize>(&limit_key, "field", "wrong-type")
        .await
        .unwrap();
    assert_eq!(limiter.increment("client", 1000).await.total_hits, 1);
    manager.del::<_, usize>(&limit_key).await.unwrap();
    assert_eq!(limiter.increment("client", 1001).await.total_hits, 2);
    assert!(peer.get(&limit_key).await.unwrap().is_none());
    assert_eq!(limiter.increment("client", 31_001).await.total_hits, 1);
    assert_eq!(peer.get(&limit_key).await.unwrap().as_deref(), Some("1"));
    peer.del(&limit_key).await.unwrap();
}

#[tokio::test]
#[ignore = "requires disposable Redis"]
async fn persisted_queries_follow_node_insertion_order_and_refresh_empty_cached_rows() {
    let (_, backend) = fixture().await;
    let apq = PersistedQueryStore::with_capacity(backend.clone(), 2);
    let prefix = uuid::Uuid::new_v4().to_string();
    let [a, b, c] = ["a", "b", "c"].map(|name| hash_query(&format!("{prefix}:{name}")));
    apq.store(&a, "first", 0).await;
    apq.store(&b, "second", 0).await;
    assert_eq!(apq.get(&a, 0).await.as_deref(), Some("first"));
    backend
        .set_ex(&persisted_query_key(&a), "new from another replica", 30)
        .await
        .unwrap();
    apq.store(&c, "third", 0).await;
    assert_eq!(
        apq.get(&a, 0).await.as_deref(),
        Some("new from another replica")
    );
    apq.store(&c, "", 0).await;
    backend
        .set_ex(&persisted_query_key(&c), "replaced", 30)
        .await
        .unwrap();
    assert_eq!(apq.get(&c, 0).await.as_deref(), Some("replaced"));
    let ttl = backend.pttl(&persisted_query_key(&b)).await.unwrap();
    assert!((0..=(APQ_TTL_SECONDS * 1000) as i64).contains(&ttl));
    for hash in [a, b, c] {
        backend.del(&persisted_query_key(&hash)).await.unwrap();
    }
}

#[tokio::test]
#[ignore = "requires disposable Redis"]
async fn risk_window_reads_empty_lua_arrays_and_enforces_ttls_across_peers() {
    let (mut conn, backend) = fixture().await;
    let (_, peer) = fixture().await;
    let key = uuid::Uuid::new_v4().to_string();
    let (window, trap) = risk_redis_keys(&key);
    let now = chrono::Utc::now().timestamp_millis();
    let event:AbuseEvent=serde_json::from_value(json!({"route":"/fixture","at":now-5_000,"deep":false,"support":true,"mismatch":0,"resources":[],"trap":true})).unwrap();
    let result = RedisRiskStore::new(backend)
        .append(&key, &event, "first")
        .await
        .unwrap();
    assert!(result.trapped);
    assert_eq!(result.events, vec![event.clone()]);
    let members: Vec<String> = conn.zrange(&window, 0, -1).await.unwrap();
    let (id, raw) = members[0].split_once('|').unwrap();
    assert_eq!(id, "first");
    assert_eq!(
        serde_json::from_str::<Value>(raw).unwrap()["resources"],
        json!({})
    );
    assert!((1..=60_000).contains(&peer.pttl(&window).await.unwrap()));
    assert!((1..=600_000).contains(&peer.pttl(&trap).await.unwrap()));
    let stale = AbuseEvent {
        at: now - 120_000,
        trap: Some(false),
        ..event.clone()
    };
    let shared = RedisRiskStore::new(peer.clone())
        .append(&key, &stale, "stale")
        .await
        .unwrap();
    assert!(shared.trapped);
    assert_eq!(shared.events, vec![event]);
    peer.del(&window).await.unwrap();
    peer.del(&trap).await.unwrap();
}
