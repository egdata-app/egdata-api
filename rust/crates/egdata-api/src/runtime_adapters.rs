//! Production adapter construction for the local API runtime.

use std::{collections::BTreeMap, sync::Arc, time::Duration};

use crate::state::{ApiConfig, AppState};
use async_trait::async_trait;
use egdata_core::{
    error::CoreError,
    ports::{
        AcceptedJobSubmission, DiscordPort, JobApiJobType, JobApiPort, OpenSearchPort,
        SessionVerifierPort, VectorizeOfferMatch, VectorizePort, VerifiedSession, WebPushPort,
    },
};
use egdata_infra::{
    auth_pg::{AuthPgConfig, BetterAuthVerifier, PgSessionRepository},
    catalog_mongo::{MongoCatalogHydrationResolver, MongoDatabaseSource},
    epic_client::EpicStoreClient,
    job_api::{JobApiClient, JobApiClientConfig},
    mongo::{MongoConfig, connect_mongo_with_read_policy},
    notifications::{
        DiscordRestClient, GaClient, TelegramBotService, VapidConfig, VapidWebPushClient,
    },
    port_adapters::{MongoStoreAdapter, ReqwestUpstreamHttpClient, TakumiOgRenderer},
    redis_store::{
        RedisBackend, RedisCohortStore, RedisRateLimitStore, RedisRiskStore, RedisSummaryStore,
        RedisTrialStore, ResponseCache, ResponseCacheConfig, shared_redis_from_env,
    },
    search_clients::{
        MeilisearchClient, MeilisearchConfig, OpenSearchClient, OpenSearchConfig, VectorizeClient,
        VectorizeConfig,
    },
};

struct UnconfiguredSessionVerifier;

struct Unavailable {
    service: &'static str,
}
impl Unavailable {
    fn error(&self) -> CoreError {
        CoreError::InvalidInput(format!("{} is not configured", self.service))
    }
}

#[async_trait]
impl SessionVerifierPort for UnconfiguredSessionVerifier {
    async fn verify_token(&self, _token: &str) -> Result<Option<VerifiedSession>, CoreError> {
        Err(CoreError::InvalidInput(
            "Session verification is not configured".into(),
        ))
    }
}

#[async_trait]
impl OpenSearchPort for Unavailable {
    async fn search(&self, _: &str, _: &serde_json::Value) -> Result<serde_json::Value, CoreError> {
        Err(self.error())
    }
}
#[async_trait]
impl VectorizePort for Unavailable {
    async fn query_natural_language(
        &self,
        _: &str,
        _: usize,
    ) -> Result<Vec<VectorizeOfferMatch>, CoreError> {
        Err(self.error())
    }
}
#[async_trait]
impl JobApiPort for Unavailable {
    async fn submit(
        &self,
        _: JobApiJobType,
        _: &serde_json::Value,
        _: Option<&str>,
    ) -> Result<AcceptedJobSubmission, CoreError> {
        Err(self.error())
    }
    async fn submit_batch(
        &self,
        _: JobApiJobType,
        _: &[serde_json::Value],
        _: Option<&str>,
    ) -> Result<Vec<AcceptedJobSubmission>, CoreError> {
        Err(self.error())
    }
}
#[async_trait]
impl DiscordPort for Unavailable {
    async fn request(
        &self,
        _: &str,
        _: &str,
        _: Option<&serde_json::Value>,
    ) -> Result<serde_json::Value, CoreError> {
        Err(self.error())
    }
}
#[async_trait]
impl WebPushPort for Unavailable {
    async fn send_notification(&self, _: &serde_json::Value, _: &[u8]) -> Result<(), CoreError> {
        Err(self.error())
    }
}

fn opt(env: &BTreeMap<String, String>, key: &str) -> Option<String> {
    env.get(key)
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Connect required data stores and construct concrete service adapters. Optional services
/// without credentials are represented by clients that fail their operation explicitly.
pub async fn build_state(env: &BTreeMap<String, String>) -> anyhow::Result<AppState> {
    build_state_for_listener(env, true).await
}

pub(crate) async fn build_state_for_listener(
    env: &BTreeMap<String, String>,
    loopback: bool,
) -> anyhow::Result<AppState> {
    let get = |key: &str| env.get(key).cloned();
    let api = Arc::new(
        ApiConfig::from_env_map(env).map_err(|_| anyhow::anyhow!("Invalid API configuration"))?,
    );

    let redis: Arc<dyn RedisBackend> = Arc::new(
        shared_redis_from_env(&get).map_err(|_| anyhow::anyhow!("Invalid Redis configuration"))?,
    );
    let cache_cfg = ResponseCacheConfig::from_env_lookup(&get)?;
    let telemetry: Arc<dyn RedisBackend> =
        if api.anti_abuse_mode == crate::state::AntiAbuseMode::Off {
            redis.clone()
        } else {
            Arc::new(egdata_infra::redis_store::telemetry_from_env(&get)?)
        };
    // Node constructs and validates the cache and telemetry clients before awaiting MongoDB.
    let mongo_config = MongoConfig::from_env_lookup(&get)?;
    let (_mongo_client, db, retry_reads) = tokio::time::timeout(
        Duration::from_secs(25),
        connect_mongo_with_read_policy(&mongo_config),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Timed out connecting to MongoDB"))?
    .map_err(|_| anyhow::anyhow!("Failed to connect to MongoDB"))?;
    let mongo = MongoStoreAdapter::configured(db.clone(), retry_reads);

    let cache_fail_open = cache_cfg.dedicated.is_some();
    let cache_backend: Arc<dyn egdata_infra::redis_store::RedisBackend> =
        if let Some(cfg) = cache_cfg.dedicated {
            Arc::new(egdata_infra::redis_store::lazy_response_cache_backend(
                &cfg,
            )?)
        } else {
            redis.clone()
        };
    // APQ uses the primary Redis connection, even with a dedicated response cache.
    // Scope registrations made by the loopback origin to its configured cache prefix.
    let graphql_cache = Arc::new(ResponseCache::new(
        if loopback {
            cache_cfg.prefix.as_str()
        } else {
            ""
        },
        false,
        redis.clone(),
    ));
    let cache = Arc::new(ResponseCache::new(
        cache_cfg.prefix,
        cache_fail_open,
        cache_backend,
    ));
    let saved_queries = Arc::new(ResponseCache::new("q:", false, redis.clone()));
    let rate_limit = Arc::new(RedisRateLimitStore::new(60_000, "api", redis.clone()));
    let abuse_risk = Arc::new(RedisRiskStore::new(telemetry.clone()));
    let abuse_summary = Arc::new(RedisSummaryStore::new(telemetry.clone()));
    let pow_cohorts = Arc::new(RedisCohortStore::new(telemetry.clone()));
    let abuse_trial = Arc::new(RedisTrialStore::new(telemetry.clone()));

    let session_verifier: Arc<dyn SessionVerifierPort> = match AuthPgConfig::from_env_lookup(&get) {
        Ok(config) => {
            let repository = PgSessionRepository::from_config(&config);
            Arc::new(BetterAuthVerifier::new(config.secret, repository))
        }
        Err(egdata_infra::auth_pg::AuthPgError::MissingEnv(_)) => {
            Arc::new(UnconfiguredSessionVerifier)
        }
        Err(e) => return Err(e.into()),
    };

    let get = |key: &str| env.get(key).cloned();
    let opensearch = OpenSearchConfig::from_env_lookup(&get)
        .ok()
        .map(OpenSearchClient::new);
    let vectorize = VectorizeConfig::from_env_lookup(&get)
        .ok()
        .and_then(|cfg| VectorizeClient::new(cfg).ok());
    let vapid = VapidConfig::from_env_lookup(&get)
        .ok()
        .map(VapidWebPushClient::new);
    let job_api = JobApiClientConfig::from_env_lookup(&get)
        .ok()
        .map(JobApiClient::new);
    let discord = opt(env, "DISCORD_BOT_TOKEN").map(DiscordRestClient::new);
    let telegram = TelegramBotService::from_env_lookup(&get);
    let meili = MeilisearchClient::new(MeilisearchConfig::from_env_lookup(&get));
    let epic = EpicStoreClient::new();
    let ga = GaClient::from_env_lookup(&get);
    let og = TakumiOgRenderer::new();
    let source = MongoDatabaseSource::new(db.clone());
    if !loopback {
        egdata_infra::catalog_mongo::ensure_catalog_hydration_indexes(&source)
            .await
            .map_err(|_| anyhow::anyhow!("Could not ensure catalog hydration indexes"))?;
    }
    let catalog_hydration =
        MongoCatalogHydrationResolver::new_with_locale(source, &api.collation_locale)
            .map_err(|_| anyhow::anyhow!("Invalid catalog collation locale"))?;

    let state = AppState {
        ssr_telemetry: Arc::new(egdata_api_state::telemetry::SsrTelemetry::from_env(env)),
        now: chrono::Utc::now,
        new_object_id: bson::oid::ObjectId::new,
        config: api,
        mongo,
        cache,
        saved_queries,
        graphql_cache,
        profile_refresh: Arc::new(egdata_infra::job_api::ProfileRefreshService {
            redis,
            jobs: job_api.clone(),
        }),
        rate_limit,
        abuse_risk,
        abuse_summary,
        pow_cohorts,
        abuse_trial,
        session_verifier,
        meili: Arc::new(meili),
        opensearch: opensearch
            .map(|x| Arc::new(x) as Arc<dyn OpenSearchPort>)
            .unwrap_or_else(|| {
                Arc::new(Unavailable {
                    service: "OpenSearch",
                })
            }),
        vectorize: vectorize
            .map(|x| Arc::new(x) as Arc<dyn VectorizePort>)
            .unwrap_or_else(|| {
                Arc::new(Unavailable {
                    service: "Vectorize",
                })
            }),
        epic: Arc::new(epic),
        job_api: job_api
            .map(|x| Arc::new(x) as Arc<dyn JobApiPort>)
            .unwrap_or_else(|| Arc::new(Unavailable { service: "Job API" })),
        discord: discord
            .map(|x| Arc::new(x) as Arc<dyn DiscordPort>)
            .unwrap_or_else(|| Arc::new(Unavailable { service: "Discord" })),
        telegram: Arc::new(telegram),
        ga: Arc::new(ga),
        web_push: vapid
            .map(|x| Arc::new(x) as Arc<dyn WebPushPort>)
            .unwrap_or_else(|| {
                Arc::new(Unavailable {
                    service: "Web Push",
                })
            }),
        og: Arc::new(og),
        catalog_hydration: Arc::new(catalog_hydration),
        http: Arc::new(ReqwestUpstreamHttpClient::new()),
    };
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use egdata_core::ports::{
        DiscordPort, JobApiPort, OpenSearchPort, SessionVerifierPort, VectorizePort, WebPushPort,
    };
    use serde_json::json;

    fn disposable_config(redis_endpoint: &url::Url) -> BTreeMap<String, String> {
        BTreeMap::from([
            ("NODE_ENV".into(), "production".into()),
            ("NODE_ICU_LOCALE".into(), "en-US".into()),
            (
                "MONGO_URL".into(),
                std::env::var("EGDATA_TEST_MONGO").unwrap(),
            ),
            (
                "MONGO_CA".into(),
                std::env::var("EGDATA_TEST_MONGO_CA").unwrap(),
            ),
            (
                "MONGO_CERT".into(),
                std::env::var("EGDATA_TEST_MONGO_CERT").unwrap(),
            ),
            (
                "REDISHOST".into(),
                redis_endpoint.host_str().unwrap().into(),
            ),
            (
                "REDISPORT".into(),
                redis_endpoint.port().unwrap().to_string(),
            ),
            (
                "NEON_CONNECTION_URI".into(),
                std::env::var("EGDATA_TEST_PG").unwrap(),
            ),
            (
                "BETTER_AUTH_SECRET".into(),
                "disposable-session-secret".into(),
            ),
            ("RESPONSE_CACHE_PREFIX".into(), "fixture:http:".into()),
        ])
    }

    #[tokio::test]
    #[ignore = "requires disposable X.509 MongoDB, Redis, Postgres and authenticated OpenSearch"]
    async fn configured_origin_authenticates_to_search_and_records_telemetry() {
        let redis = url::Url::parse(&std::env::var("EGDATA_TEST_REDIS").unwrap()).unwrap();
        let mut config = disposable_config(&redis);
        let search = std::env::var("EGDATA_TEST_OPENSEARCH").unwrap();
        config.extend([
            ("OPENSEARCH_URL".into(), search.clone()),
            ("OPENSEARCH_USERNAME".into(), "admin".into()),
            (
                "OPENSEARCH_PASSWORD".into(),
                "Fixture-Only-Search-42!".into(),
            ),
            ("ANTI_ABUSE_MODE".into(), "observe".into()),
            (
                "ANTI_ABUSE_SECRET".into(),
                "disposable-test-secret-for-cohort-telemetry".into(),
            ),
        ]);
        let state = build_state(&config).await.unwrap();
        let name = format!("origin-{}", uuid::Uuid::new_v4().simple());
        use base64::Engine as _;
        let credentials =
            base64::engine::general_purpose::STANDARD.encode("admin:Fixture-Only-Search-42!");
        let seeded = state
            .http
            .send(egdata_core::ports::UpstreamHttpRequest {
                method: "PUT".into(),
                url: format!("{search}/{name}/_doc/rank?refresh=true"),
                headers: BTreeMap::from([
                    ("Authorization".into(), format!("Basic {credentials}")),
                    ("Content-Type".into(), "application/json".into()),
                ]),
                body: Some(br#"{"title":"Test game"}"#.to_vec()),
                multipart_file: None,
            })
            .await
            .unwrap();
        assert_eq!(seeded.status, 201);
        let result = state
            .opensearch
            .search(&name, &json!({"query":{"match":{"title":"game"}}}))
            .await
            .unwrap();
        assert_eq!(result["hits"]["hits"][0]["_id"], "rank");
        let now = chrono::Utc::now().timestamp();
        let day = now.div_euclid(86_400);
        state
            .pow_cohorts
            .write(&[egdata_core::ports::PowCohortUpdate {
                day,
                id: name.clone(),
                first_challenge: now,
                last_challenge: now,
                last_puzzle: 0,
                last_solve: 0,
            }])
            .await
            .unwrap();
        assert!(
            state
                .pow_cohorts
                .read_day(day)
                .await
                .unwrap()
                .contains_key(&name)
        );

        config.insert(
            "OPENSEARCH_PASSWORD".into(),
            "incorrect-fixture-password".into(),
        );
        let denied = build_state(&config).await.unwrap();
        let error = denied
            .opensearch
            .search(&name, &json!({}))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("401"));
        assert!(denied.mongo.ping().await.unwrap());
    }

    #[tokio::test]
    #[ignore = "requires disposable X.509 MongoDB, Redis and Postgres"]
    async fn deployed_origin_uses_shared_apq_keys_and_provisions_indexes() {
        use redis::AsyncCommands;
        let redis_url = std::env::var("EGDATA_TEST_REDIS").unwrap();
        let redis_endpoint = url::Url::parse(&redis_url).unwrap();
        let config = disposable_config(&redis_endpoint);
        let state = build_state_for_listener(&config, false).await.unwrap();
        let mut redis = redis::Client::open(redis_url)
            .unwrap()
            .get_multiplexed_async_connection()
            .await
            .unwrap();
        let key = format!("egdata:graphql:apq:{}", uuid::Uuid::new_v4().simple());
        state
            .graphql_cache
            .set(&key, "{ __typename }", 120)
            .await
            .unwrap();
        assert_eq!(
            redis.get::<_, String>(&key).await.unwrap(),
            "{ __typename }"
        );
        let local = build_state(&config).await.unwrap();
        assert_eq!(local.graphql_cache.get(&key).await.unwrap(), None);
        local
            .graphql_cache
            .set(&key, "local query", 120)
            .await
            .unwrap();
        assert_eq!(
            redis
                .get::<_, String>(format!("fixture:http:{key}"))
                .await
                .unwrap(),
            "local query"
        );

        // The Node shared Redis client propagates errors. Its dedicated response cache treats them as misses.
        let invalid_key = format!("wrong-type:{}", uuid::Uuid::new_v4().simple());
        let _: usize = redis
            .hset(format!("fixture:http:{invalid_key}"), "field", "value")
            .await
            .unwrap();
        assert!(state.cache.get(&invalid_key).await.is_err());
        let mut dedicated = config.clone();
        dedicated.insert(
            "CACHE_REDIS_HOST".into(),
            redis_endpoint.host_str().unwrap().into(),
        );
        dedicated.insert(
            "CACHE_REDIS_PORT".into(),
            redis_endpoint.port().unwrap().to_string(),
        );
        assert_eq!(
            build_state(&dedicated)
                .await
                .unwrap()
                .cache
                .get(&invalid_key)
                .await
                .unwrap(),
            None
        );

        // The optional cache can be down while both stores used by /v1/health remain healthy.
        let unresponsive = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        dedicated.insert(
            "CACHE_REDIS_PORT".into(),
            unresponsive.local_addr().unwrap().port().to_string(),
        );
        let degraded = build_state(&dedicated).await.unwrap();
        assert!(degraded.saved_queries.ping().await.unwrap());
        assert!(degraded.mongo.ping().await.unwrap());
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), degraded.cache.get("unavailable"))
                .await
                .unwrap()
                .unwrap(),
            None
        );

        // Like Node, public routes can start while the private session store is unavailable.
        let mut no_session_database = config.clone();
        no_session_database.insert(
            "NEON_CONNECTION_URI".into(),
            format!(
                "postgresql://fixture@127.0.0.1:{}/fixture",
                unresponsive.local_addr().unwrap().port()
            ),
        );
        let public_origin = build_state(&no_session_database).await.unwrap();
        assert!(public_origin.mongo.ping().await.unwrap());
        assert!(public_origin.saved_queries.ping().await.unwrap());
        no_session_database.insert("BETTER_AUTH_SECRETS".into(), "invalid-list".into());
        let error = build_state(&no_session_database).await.err().unwrap();
        assert_eq!(
            error.to_string(),
            "Invalid BETTER_AUTH_SECRETS configuration"
        );

        // The administrative index command must tolerate catalog indexes created at server startup.
        for _ in 0..2 {
            crate::operations::run(crate::operations::Command::EnsureV1Indexes, &config)
                .await
                .unwrap();
        }
        let (_, db) = egdata_infra::mongo::connect_mongo(
            &MongoConfig::from_env_lookup(|k| config.get(k).cloned()).unwrap(),
        )
        .await
        .unwrap();
        let asset_indexes = db
            .collection::<bson::Document>("assets")
            .list_index_names()
            .await
            .unwrap();
        assert!(asset_indexes.iter().any(|s| s == "catalog_asset_identity"));
    }

    #[tokio::test]
    async fn missing_mongo_configuration_is_reported_without_connecting() {
        let error = match build_state(&BTreeMap::new()).await {
            Ok(_) => panic!("missing Mongo configuration unexpectedly succeeded"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("MONGO_URL is required"));
        assert!(!error.to_string().contains("mongodb://"));
    }

    #[tokio::test]
    #[ignore = "requires disposable X.509 MongoDB"]
    async fn required_startup_failures_are_sanitized_and_optional_ports_remain_usable() {
        let config = BTreeMap::from([
            (
                "MONGO_URL".into(),
                std::env::var("EGDATA_TEST_MONGO").unwrap(),
            ),
            (
                "MONGO_CA".into(),
                std::env::var("EGDATA_TEST_MONGO_CA").unwrap(),
            ),
            (
                "MONGO_CERT".into(),
                std::env::var("EGDATA_TEST_MONGO_CERT").unwrap(),
            ),
            ("REDISPORT".into(), "not-a-number".into()),
            ("NODE_ICU_LOCALE".into(), "en-US".into()),
        ]);
        let mut invalid = config.clone();
        invalid.insert(
            "MONGO_URL".into(),
            "mongodb://fixture:private@127.0.0.1:invalid/db".into(),
        );
        let error = build_state(&invalid).await.err().unwrap();
        assert_eq!(error.to_string(), "Failed to connect to MongoDB");

        let mut invalid = config.clone();
        invalid.insert(
            "NEON_CONNECTION_URI".into(),
            "postgresql://fixture:private@127.0.0.1:invalid/db".into(),
        );
        invalid.insert(
            "BETTER_AUTH_SECRET".into(),
            "disposable-session-secret".into(),
        );
        let state = build_state(&invalid).await.unwrap();
        assert!(
            state
                .session_verifier
                .verify_token("unsigned")
                .await
                .unwrap()
                .is_none()
        );

        let state = build_state(&config).await.unwrap();
        assert!(state.mongo.ping().await.unwrap());
        assert!(state.saved_queries.ping().await.is_err());
        assert!(state.cache.set("discarded", "value", 1).await.is_err());
        assert!(
            state
                .session_verifier
                .verify_token("token")
                .await
                .unwrap_err()
                .to_string()
                .contains("not configured")
        );
        assert!(
            state
                .opensearch
                .search("offers", &json!({}))
                .await
                .unwrap_err()
                .to_string()
                .contains("OpenSearch is not configured")
        );
    }

    #[tokio::test]
    async fn unconfigured_optional_ports_fail_explicitly() {
        let unavailable = Unavailable {
            service: "Vectorize",
        };
        let error = unavailable
            .query_natural_language("game", 3)
            .await
            .unwrap_err();
        assert!(
            matches!(error, CoreError::InvalidInput(ref msg) if msg == "Vectorize is not configured")
        );

        assert!(
            unavailable
                .search("offers", &json!({}))
                .await
                .unwrap_err()
                .to_string()
                .contains("Vectorize")
        );
        assert!(
            unavailable
                .submit(JobApiJobType::OfferRegen, &json!({}), None)
                .await
                .unwrap_err()
                .to_string()
                .contains("Vectorize")
        );
        assert!(
            unavailable
                .submit_batch(JobApiJobType::OfferRegen, &[], None)
                .await
                .unwrap_err()
                .to_string()
                .contains("Vectorize")
        );
        assert!(
            unavailable
                .request("GET", "/", None)
                .await
                .unwrap_err()
                .to_string()
                .contains("Vectorize")
        );
        assert!(
            unavailable
                .send_notification(&json!({}), &[])
                .await
                .unwrap_err()
                .to_string()
                .contains("Vectorize")
        );
        assert!(
            UnconfiguredSessionVerifier
                .verify_token("token")
                .await
                .unwrap_err()
                .to_string()
                .contains("not configured")
        );
    }
}
