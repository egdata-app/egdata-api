//! Redis connection configuration, response cache, Lua script stores, and in-memory fallbacks.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use egdata_core::v1::trim_js_whitespace;
use indexmap::IndexMap;
use redis::aio::{ConnectionLike, ConnectionManager, MultiplexedConnection};
use redis::{RedisError, Script, Value as RedisValue};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::sync::{Notify, watch};
use tracing::warn;

/// Default prefix for cached HTTP responses (`src/clients/response-cache.ts`).
pub const DEFAULT_RESPONSE_CACHE_PREFIX: &str = "response:v2:";

/// Rate-limit key prefix (`src/middlewares/rate-limit.ts`).
pub const RATE_LIMIT_PREFIX: &str = "egdata:ratelimit:";

/// Redis outage circuit-breaker duration in milliseconds.
pub const REDIS_OUTAGE_BACKOFF_MS: i64 = 30_000;

/// Abuse model version (`src/services/abuse-version.ts`).
pub const ABUSE_VERSION: u32 = 2;

/// Risk state Redis key prefix (`src/services/abuse-version.ts`).
pub const RISK_PREFIX: &str = "egdata:abuse:v2:";

/// Summary bucket Redis key prefix (`src/services/abuse-observation.ts`).
pub const SUMMARY_PREFIX: &str = "egdata:abuse:summary:v2:";

/// Summary bucket TTL in seconds (`src/services/abuse-observation.ts`).
pub const SUMMARY_TTL_SECONDS: i64 = 86_400;

/// PoW cohort Redis key prefix (`src/services/pow-cohorts.ts`).
pub const COHORT_PREFIX: &str = "egdata:abuse:pow-cohorts:v1:";

/// Maximum cohort entries per UTC day (`src/services/pow-cohorts.ts`).
pub const COHORT_LIMIT: usize = 10_000;

/// PoW cohort waiting period in ms (`src/services/pow-cohorts.ts`).
pub const COHORT_WAIT_MS: i64 = 300_000;

/// Abuse trial Redis switch key (`src/services/abuse-trial.ts`).
pub const TRIAL_KEY: &str = "egdata:abuse:trial:v2";

/// GraphQL APQ Redis key prefix (`src/graphql/persisted-queries.ts`).
pub const APQ_PREFIX: &str = "egdata:graphql:apq:";

/// GraphQL APQ Redis TTL (30 days, `src/graphql/persisted-queries.ts`).
pub const APQ_TTL_SECONDS: u64 = 30 * 24 * 60 * 60;

/// GraphQL APQ in-memory LRU capacity (`src/graphql/persisted-queries.ts`).
pub const APQ_MEMORY_MAX_ENTRIES: usize = 2_000;

/// Fixed-window rate limit Lua script (`src/middlewares/rate-limit.ts`).
pub const INCREMENT_SCRIPT: &str = r#"
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("PTTL", KEYS[1])
return {current, ttl}
"#;

/// Atomic sliding-window abuse script (`src/services/abuse-scorer.ts`).
pub const APPEND_WINDOW_SCRIPT: &str = r#"
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local event = cjson.decode(ARGV[1])
-- Use arrival time, not worker processing time (queueing must not manufacture
-- robotic intervals). Clamp future clock skew; hosts should use NTP.
event.at = math.min(event.at, now)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - 60000)
if event.at > now - 60000 then
  redis.call('ZADD', KEYS[1], event.at, ARGV[2] .. '|' .. cjson.encode(event))
end
redis.call('ZREMRANGEBYRANK', KEYS[1], 0, -129)
redis.call('PEXPIRE', KEYS[1], 60000)
if event.trap then redis.call('SET', KEYS[2], '1', 'PX', 600000) end
return {redis.call('ZRANGE', KEYS[1], 0, -1), redis.call('EXISTS', KEYS[2])}
"#;

/// Idempotent abuse observation summary script (`src/services/abuse-observation.ts`).
pub const SUMMARY_SCRIPT: &str = r#"
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then return 0 end
local values = cjson.decode(ARGV[2])
for field, value in pairs(values) do redis.call('HINCRBY', KEYS[1], field, value) end
redis.call('HSET', KEYS[1], ARGV[1], 1)
redis.call('EXPIREAT', KEYS[1], ARGV[3])
return 1
"#;

/// Idempotent PoW cohort funnel script (`src/services/pow-cohorts.ts`).
pub const COHORT_SCRIPT: &str = r#"
local rows = cjson.decode(ARGV[1])
for _, row in ipairs(rows) do
  local raw = redis.call('HGET', KEYS[1], row.id)
  if not raw and tonumber(redis.call('HGET', KEYS[1], '__count') or '0') >= tonumber(ARGV[3]) then
    redis.call('HSET', KEYS[1], '__capacityReached', '1')
  else
    local state = raw and cjson.decode(raw) or {firstChallenge=0,lastChallenge=0,lastPuzzle=0,lastSolve=0}
    if row.firstChallenge > 0 and (state.firstChallenge == 0 or row.firstChallenge < state.firstChallenge) then
      state.firstChallenge = row.firstChallenge
    end
    for _, field in ipairs({'lastChallenge','lastPuzzle','lastSolve'}) do
      state[field] = math.max(state[field], row[field])
    end
    redis.call('HSET', KEYS[1], row.id, cjson.encode(state))
    if not raw then redis.call('HINCRBY', KEYS[1], '__count', 1) end
    local at = math.max(row.lastChallenge, row.lastPuzzle, row.lastSolve)
    local first = tonumber(redis.call('HGET', KEYS[1], '__firstObservedAt') or '0')
    if first == 0 or at < first then redis.call('HSET', KEYS[1], '__firstObservedAt', at) end
    local last = tonumber(redis.call('HGET', KEYS[1], '__lastObservedAt') or '0')
    redis.call('HSET', KEYS[1], '__lastObservedAt', math.max(last, at))
  end
end
redis.call('EXPIREAT', KEYS[1], ARGV[2])
return 1
"#;

/// Errors returned by Redis configuration or store operations.
#[derive(Debug, Error)]
pub enum RedisStoreError {
    #[error("REDISPORT must resolve to a TCP port between 0 and 65535")]
    InvalidSharedPort,
    #[error("{0}")]
    InvalidConfig(String),
    #[error("redis error: {0}")]
    Redis(#[from] RedisError),
    #[error("unexpected redis response: {0}")]
    UnexpectedResponse(String),
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
}

/// Shared Redis connection settings (`src/clients/redis.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedisConfig {
    pub host: String,
    pub port: u16,
    pub tls: bool,
    pub username: Option<String>,
    pub password: Option<String>,
    pub connect_timeout_ms: Option<u64>,
    pub command_timeout_ms: Option<u64>,
}

impl RedisConfig {
    fn client(&self) -> Result<redis::Client, RedisError> {
        use redis::IntoConnectionInfo;
        // ioredis passes the literal host to the socket. Do not let URL syntax
        // in an environment value select another host, database or query option.
        let mut info = (self.host.clone(), self.port).into_connection_info()?;
        if self.tls {
            info = info.set_addr(redis::ConnectionAddr::TcpTls {
                host: self.host.clone(),
                port: self.port,
                insecure: false,
                tls_params: None,
            });
        }
        let mut settings = redis::RedisConnectionInfo::default();
        if let Some(name) = &self.username {
            settings = settings.set_username(name);
        }
        if let Some(password) = &self.password {
            settings = settings.set_password(password);
        }
        redis::Client::open(info.set_redis_settings(settings))
    }

    /// Builds shared Redis config from environment variables (`REDISHOST`, `REDISPORT`, `REDISTLS`, `REDISUSER`, `REDISPASSWORD`).
    pub fn from_env_lookup<F>(mut get_env: F) -> Result<Self, RedisStoreError>
    where
        F: FnMut(&str) -> Option<String>,
    {
        let host = get_env("REDISHOST")
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "127.0.0.1".to_string());
        let port_str = get_env("REDISPORT")
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "6379".to_string());
        // The shared client passes parseInt(value) to ioredis. Unlike the
        // dedicated cache it accepts a numeric prefix, optional sign and hex.
        let digits = trim_js_whitespace(&port_str);
        let (negative, digits) = match digits.as_bytes().first() {
            Some(b'-') => (true, &digits[1..]),
            Some(b'+') => (false, &digits[1..]),
            _ => (false, digits),
        };
        let (radix, digits) = digits
            .strip_prefix("0x")
            .or_else(|| digits.strip_prefix("0X"))
            .map_or((10, digits), |v| (16, v));
        let len = digits
            .bytes()
            .take_while(|b| (*b as char).is_digit(radix))
            .count();
        let port = u16::from_str_radix(&digits[..len], radix)
            .ok()
            .filter(|n| !negative || *n == 0)
            .ok_or(RedisStoreError::InvalidSharedPort)?;
        let tls = get_env("REDISTLS").as_deref() == Some("true");
        let username = get_env("REDISUSER").filter(|value| !value.is_empty());
        let password = get_env("REDISPASSWORD").filter(|value| !value.is_empty());

        Ok(Self {
            host,
            port,
            tls,
            username,
            password,
            connect_timeout_ms: None,
            command_timeout_ms: None,
        })
    }

    /// Formats a `redis://` or `rediss://` connection URL.
    pub fn connection_url(&self) -> String {
        let scheme = if self.tls { "rediss" } else { "redis" };
        let host = if self.host.parse::<std::net::Ipv6Addr>().is_ok() {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        };
        // Redis decodes userinfo as percent-encoded UTF-8. Encode each component
        // independently so slashes, @, colons and literal percent signs survive.
        let encode = |value: &str| {
            percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC)
                .to_string()
        };
        let mut auth = self.username.as_deref().map(encode).unwrap_or_default();
        if let Some(password) = &self.password {
            auth.push(':');
            auth.push_str(&encode(password));
        }
        if !auth.is_empty() {
            auth.push('@');
        }
        format!("{scheme}://{auth}{host}:{}", self.port)
    }
}

/// Dedicated or shared response cache configuration (`src/clients/response-cache.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponseCacheConfig {
    pub prefix: String,
    pub dedicated: Option<RedisConfig>,
}

impl ResponseCacheConfig {
    /// Validates `RESPONSE_CACHE_PREFIX` and `CACHE_REDIS_*` variables identically to `src/clients/response-cache.ts`.
    pub fn from_env_lookup<F>(mut get_env: F) -> Result<Self, RedisStoreError>
    where
        F: FnMut(&str) -> Option<String>,
    {
        let prefix = normalize_non_empty(get_env("RESPONSE_CACHE_PREFIX"))
            .unwrap_or_else(|| DEFAULT_RESPONSE_CACHE_PREFIX.to_string());
        let host = normalize_non_empty(get_env("CACHE_REDIS_HOST"));
        let port_raw = get_env("CACHE_REDIS_PORT");
        let user_raw = get_env("CACHE_REDIS_USER");
        let pass_raw = get_env("CACHE_REDIS_PASSWORD");
        let tls_raw = get_env("CACHE_REDIS_TLS");

        let Some(host) = host else {
            let any_configured = [&port_raw, &user_raw, &pass_raw, &tls_raw]
                .into_iter()
                .any(|v| {
                    v.as_deref()
                        .is_some_and(|s| !trim_js_whitespace(s).is_empty())
                });
            if any_configured {
                return Err(RedisStoreError::InvalidConfig(
                    "CACHE_REDIS_HOST is required for a dedicated response cache".into(),
                ));
            }
            return Ok(Self {
                prefix,
                dedicated: None,
            });
        };

        let port_value = normalize_non_empty(port_raw).unwrap_or_else(|| "6379".to_string());
        let port = parse_port(&port_value).map_err(|_| {
            RedisStoreError::InvalidConfig(
                "CACHE_REDIS_PORT must be an integer between 1 and 65535".into(),
            )
        })?;
        let tls_value = normalize_non_empty(tls_raw).unwrap_or_else(|| "false".to_string());
        let tls = match tls_value.as_str() {
            "true" => true,
            "false" => false,
            _ => {
                return Err(RedisStoreError::InvalidConfig(
                    "CACHE_REDIS_TLS must be true or false".into(),
                ));
            }
        };

        Ok(Self {
            prefix,
            dedicated: Some(RedisConfig {
                host,
                port,
                tls,
                username: user_raw.filter(|value| !value.is_empty()),
                password: pass_raw.filter(|value| !value.is_empty()),
                connect_timeout_ms: Some(1_000),
                command_timeout_ms: Some(1_500),
            }),
        })
    }
}

/// Select one complete telemetry endpoint, matching telemetryRedisOptions in Node.
pub fn telemetry_config(
    mut get: impl FnMut(&str) -> Option<String>,
) -> Result<RedisConfig, RedisStoreError> {
    fn port(raw: &str, variable: &str) -> Result<u16, RedisStoreError> {
        let number = egdata_core::v1::serialization::js_string_number(raw);
        if number.fract() == 0. && (1.0..=65535.0).contains(&number) {
            Ok(number as u16)
        } else {
            Err(RedisStoreError::InvalidConfig(format!(
                "{variable} must be an integer between 1 and 65535"
            )))
        }
    }
    for prefix in ["ANTI_ABUSE_REDIS", "CACHE_REDIS"] {
        let mut field = |suffix: &str| get(&format!("{prefix}_{suffix}")).filter(|s| !s.is_empty());
        let host = normalize_non_empty(field("HOST"));
        let port_raw = field("PORT");
        let username = field("USER");
        let password = field("PASSWORD");
        let tls_raw = field("TLS");
        let Some(host) = host else {
            if [&port_raw, &username, &password, &tls_raw]
                .into_iter()
                .flatten()
                .any(|s| !trim_js_whitespace(s).is_empty())
            {
                return Err(RedisStoreError::InvalidConfig(format!(
                    "{prefix}_HOST is required"
                )));
            }
            continue;
        };
        let port = port(
            port_raw.as_deref().unwrap_or("6379"),
            &format!("{prefix}_PORT"),
        )?;
        let tls = match tls_raw.as_deref().unwrap_or("false") {
            "true" => true,
            "false" => false,
            _ => {
                return Err(RedisStoreError::InvalidConfig(format!(
                    "{prefix}_TLS must be true or false"
                )));
            }
        };
        return Ok(RedisConfig {
            host,
            port,
            tls,
            username,
            password,
            connect_timeout_ms: Some(500),
            command_timeout_ms: Some(500),
        });
    }
    let mut field = |name: &str| get(name).filter(|s| !s.is_empty());
    // Node validates a dedicated telemetry port, but passes Number(REDISPORT)
    // directly to ioredis when using the shared endpoint.
    let raw = field("REDISPORT").unwrap_or_else(|| "6379".into());
    let port = egdata_core::v1::serialization::js_string_number(&raw);
    if port.fract() != 0. || !(0.0..=65535.0).contains(&port) {
        return Err(RedisStoreError::InvalidSharedPort);
    }
    Ok(RedisConfig {
        host: field("REDISHOST").unwrap_or_else(|| "127.0.0.1".into()),
        port: port as u16,
        username: field("REDISUSER"),
        password: field("REDISPASSWORD"),
        tls: field("REDISTLS").as_deref() == Some("true"),
        connect_timeout_ms: Some(500),
        command_timeout_ms: Some(500),
    })
}

/// Observation is best-effort. The optional telemetry host may be offline at origin startup.
pub fn lazy_telemetry_backend(
    cfg: &RedisConfig,
) -> Result<ConnectionManagerBackend, RedisStoreError> {
    optional_backend(cfg, Duration::from_millis(500), Duration::from_millis(500))
}

/// A dedicated response cache is optional and reconnects after an outage.
pub fn lazy_response_cache_backend(
    cfg: &RedisConfig,
) -> Result<ConnectionManagerBackend, RedisStoreError> {
    optional_backend(
        cfg,
        Duration::from_millis(cfg.connect_timeout_ms.unwrap_or(1000)),
        Duration::from_millis(cfg.command_timeout_ms.unwrap_or(1500)),
    )
}

// ioredis uses enableOfflineQueue=false on these connections. Only publish
// a socket after authentication/handshake; callers never wait for a reconnect.
fn optional_backend(
    cfg: &RedisConfig,
    connect_timeout: Duration,
    response_timeout: Duration,
) -> Result<ConnectionManagerBackend, RedisStoreError> {
    let client = cfg.client()?;
    let options = redis::AsyncConnectionConfig::new()
        .set_connection_timeout(Some(connect_timeout))
        .set_response_timeout(Some(response_timeout));
    let (sender, receiver) = watch::channel(None);
    tokio::spawn(async move {
        let mut retry_ms = 50;
        loop {
            let result = tokio::select! {
                _ = sender.closed() => return,
                result = client.get_multiplexed_async_connection_with_config(&options) => result,
            };
            if let Ok(connection) = result {
                let lost = Arc::new(Notify::new());
                sender.send_replace(Some((connection, Arc::clone(&lost))));
                tokio::select! {
                    _ = lost.notified() => {},
                    _ = sender.closed() => return,
                }
                sender.send_replace(None);
                retry_ms = 50;
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(retry_ms)) => {},
                _ = sender.closed() => return,
            }
            retry_ms = (retry_ms + 50).min(2000);
        }
    });
    Ok(ConnectionManagerBackend {
        connections: BackendConnections::Optional(receiver),
    })
}

fn normalize_non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|v| trim_js_whitespace(&v).to_string())
        .filter(|v| !v.is_empty())
}

fn parse_port(value: &str) -> Result<u16, ()> {
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err(());
    }
    let port: u16 = value.parse().map_err(|_| ())?;
    if port == 0 {
        return Err(());
    }
    Ok(port)
}

/// Shared commands wait for Redis to come online. The HTTP origin can start
/// serving routes that do not need Redis while the connection is unavailable.
pub fn shared_redis_backend(
    config: &RedisConfig,
) -> Result<ConnectionManagerBackend, RedisStoreError> {
    let client = config.client()?;
    let options = redis::aio::ConnectionManagerConfig::new()
        .set_connection_timeout(Some(Duration::from_secs(10)))
        .set_response_timeout(None)
        .set_min_delay(Duration::from_millis(50))
        .set_max_delay(Duration::from_secs(2))
        .set_number_of_retries(usize::MAX);
    Ok(ConnectionManagerBackend {
        connections: BackendConnections::Managed {
            connection: ConnectionManager::new_lazy_with_config(client, options)?,
            queue_reads: true,
        },
    })
}

/// A permanently invalid TCP port puts ioredis into its closed state. Other
/// services and the HTTP listener still start; all commands on this client fail.
pub fn shared_redis_from_env(
    get: impl FnMut(&str) -> Option<String>,
) -> Result<ConnectionManagerBackend, RedisStoreError> {
    backend_from_config(RedisConfig::from_env_lookup(get), shared_redis_backend)
}

pub fn telemetry_from_env(
    get: impl FnMut(&str) -> Option<String>,
) -> Result<ConnectionManagerBackend, RedisStoreError> {
    backend_from_config(telemetry_config(get), lazy_telemetry_backend)
}

fn backend_from_config(
    config: Result<RedisConfig, RedisStoreError>,
    connect: fn(&RedisConfig) -> Result<ConnectionManagerBackend, RedisStoreError>,
) -> Result<ConnectionManagerBackend, RedisStoreError> {
    match config {
        Ok(config) => connect(&config),
        Err(RedisStoreError::InvalidSharedPort) => Ok(ConnectionManagerBackend {
            connections: BackendConnections::Closed,
        }),
        Err(error) => Err(error),
    }
}

/// Connects a `redis::aio::ConnectionManager` from `RedisConfig`.
pub async fn connect_redis_manager(
    config: &RedisConfig,
) -> Result<ConnectionManager, RedisStoreError> {
    let client = config.client()?;
    Ok(ConnectionManager::new_with_config(client, manager_options(config)).await?)
}

fn manager_options(config: &RedisConfig) -> redis::aio::ConnectionManagerConfig {
    let mut manager_config = redis::aio::ConnectionManagerConfig::new();
    if let Some(ms) = config.connect_timeout_ms {
        manager_config = manager_config.set_connection_timeout(Some(Duration::from_millis(ms)));
    }
    if let Some(ms) = config.command_timeout_ms {
        manager_config = manager_config.set_response_timeout(Some(Duration::from_millis(ms)));
    }
    manager_config
}

/// Abstraction over async Redis commands & Lua script evaluation for production and unit testing.
#[async_trait]
pub trait RedisBackend: Send + Sync {
    async fn get(&self, key: &str) -> Result<Option<String>, RedisStoreError>;
    async fn set_ex(
        &self,
        key: &str,
        value: &str,
        ttl_seconds: u64,
    ) -> Result<bool, RedisStoreError>;
    async fn set_px(
        &self,
        key: &str,
        value: &str,
        ttl_ms: u64,
        only_if_absent: bool,
    ) -> Result<bool, RedisStoreError>;
    async fn decr(&self, key: &str) -> Result<i64, RedisStoreError>;
    async fn del(&self, key: &str) -> Result<usize, RedisStoreError>;
    async fn pttl(&self, key: &str) -> Result<i64, RedisStoreError>;
    async fn hgetall(&self, key: &str) -> Result<HashMap<String, String>, RedisStoreError>;
    async fn ping(&self) -> Result<bool, RedisStoreError>;
    async fn eval_script(
        &self,
        script: &str,
        keys: &[&str],
        args: &[&str],
    ) -> Result<RedisValue, RedisStoreError>;
}

/// Live `redis::aio::ConnectionManager` implementation of [`RedisBackend`].
#[derive(Clone)]
pub struct ConnectionManagerBackend {
    connections: BackendConnections,
}

#[derive(Clone)]
enum BackendConnections {
    Closed,
    Managed {
        connection: ConnectionManager,
        queue_reads: bool,
    },
    Optional(watch::Receiver<Option<(MultiplexedConnection, Arc<Notify>)>>),
}

#[derive(Clone, Copy)]
enum Request<'a> {
    Read(&'a redis::Cmd),
    Command(&'a redis::Cmd),
    Script(&'a redis::ScriptInvocation<'a>),
}

impl Request<'_> {
    async fn send<T: redis::FromRedisValue>(
        self,
        connection: &mut (impl ConnectionLike + Send),
    ) -> redis::RedisResult<T> {
        match self {
            Self::Read(command) | Self::Command(command) => command.query_async(connection).await,
            Self::Script(script) => script.invoke_async(connection).await,
        }
    }
}

impl ConnectionManagerBackend {
    pub fn new(manager: ConnectionManager) -> Self {
        Self {
            connections: BackendConnections::Managed {
                connection: manager,
                queue_reads: false,
            },
        }
    }

    async fn execute<T: redis::FromRedisValue>(
        &self,
        request: Request<'_>,
    ) -> Result<T, RedisStoreError> {
        match &self.connections {
            BackendConnections::Closed => Err(RedisStoreError::Redis(
                std::io::Error::new(std::io::ErrorKind::NotConnected, "Connection is closed.")
                    .into(),
            )),
            BackendConnections::Managed {
                connection,
                queue_reads,
            } => loop {
                let response = request.send(&mut connection.clone()).await;
                // With RESP2, the first command following an idle socket close
                // detects the loss. The manager has started reconnecting when
                // this error arrives; queue observational reads on that connection.
                if *queue_reads
                    && matches!(request, Request::Read(_))
                    && response
                        .as_ref()
                        .is_err_and(RedisError::is_unrecoverable_error)
                {
                    continue;
                }
                return Ok(response?);
            },
            BackendConnections::Optional(ready) => {
                let (mut connection, lost) = ready.borrow().clone().ok_or_else(|| {
                    RedisError::from(std::io::Error::new(
                        std::io::ErrorKind::NotConnected,
                        "Redis offline queue is disabled",
                    ))
                })?;
                let response = request.send(&mut connection).await;
                if response
                    .as_ref()
                    .is_err_and(RedisError::is_unrecoverable_error)
                {
                    lost.notify_one();
                }
                Ok(response?)
            }
        }
    }

    async fn query<T: redis::FromRedisValue>(
        &self,
        command: &redis::Cmd,
    ) -> Result<T, RedisStoreError> {
        self.execute(Request::Command(command)).await
    }
}

#[async_trait]
impl RedisBackend for ConnectionManagerBackend {
    async fn get(&self, key: &str) -> Result<Option<String>, RedisStoreError> {
        self.execute(Request::Read(redis::cmd("GET").arg(key)))
            .await
    }

    async fn set_ex(
        &self,
        key: &str,
        value: &str,
        ttl_seconds: u64,
    ) -> Result<bool, RedisStoreError> {
        let reply: Option<String> = self
            .query(
                redis::cmd("SET")
                    .arg(key)
                    .arg(value)
                    .arg("EX")
                    .arg(ttl_seconds),
            )
            .await?;
        Ok(reply.as_deref() == Some("OK"))
    }

    async fn set_px(
        &self,
        key: &str,
        value: &str,
        ttl_ms: u64,
        only_if_absent: bool,
    ) -> Result<bool, RedisStoreError> {
        let mut command = redis::cmd("SET");
        command.arg(key).arg(value).arg("PX").arg(ttl_ms);
        if only_if_absent {
            command.arg("NX");
        }
        let reply: Option<String> = self.query(&command).await?;
        Ok(reply.as_deref() == Some("OK"))
    }

    async fn decr(&self, key: &str) -> Result<i64, RedisStoreError> {
        self.query(redis::cmd("DECRBY").arg(key).arg(1)).await
    }

    async fn del(&self, key: &str) -> Result<usize, RedisStoreError> {
        self.query(redis::cmd("DEL").arg(key)).await
    }

    async fn pttl(&self, key: &str) -> Result<i64, RedisStoreError> {
        self.execute(Request::Read(redis::cmd("PTTL").arg(key)))
            .await
    }

    async fn hgetall(&self, key: &str) -> Result<HashMap<String, String>, RedisStoreError> {
        self.execute(Request::Read(redis::cmd("HGETALL").arg(key)))
            .await
    }

    async fn ping(&self) -> Result<bool, RedisStoreError> {
        let pong: String = self.execute(Request::Read(&redis::cmd("PING"))).await?;
        Ok(pong.eq_ignore_ascii_case("PONG"))
    }

    async fn eval_script(
        &self,
        script: &str,
        keys: &[&str],
        args: &[&str],
    ) -> Result<RedisValue, RedisStoreError> {
        let compiled = Script::new(script);
        let mut invocation = compiled.prepare_invoke();
        for key in keys {
            invocation.key(*key);
        }
        for arg in args {
            invocation.arg(*arg);
        }
        self.execute(Request::Script(&invocation)).await
    }
}

/// Versioned response cache matching `src/clients/response-cache.ts`.
pub struct ResponseCache {
    prefix: String,
    fail_open: bool,
    backend: Arc<dyn RedisBackend>,
}

impl ResponseCache {
    pub fn new(prefix: impl Into<String>, fail_open: bool, backend: Arc<dyn RedisBackend>) -> Self {
        Self {
            prefix: prefix.into(),
            fail_open,
            backend,
        }
    }

    pub fn versioned_key(&self, key: &str) -> String {
        format!("{}{}", self.prefix, key)
    }

    pub async fn get(&self, key: &str) -> Result<Option<String>, RedisStoreError> {
        let full_key = self.versioned_key(key);
        match self.backend.get(&full_key).await {
            Ok(val) => Ok(val),
            Err(err) if self.fail_open => {
                warn!("Response cache get failed: {err}");
                Ok(None)
            }
            Err(err) => Err(err),
        }
    }

    pub async fn set(
        &self,
        key: &str,
        value: &str,
        ttl_seconds: u64,
    ) -> Result<bool, RedisStoreError> {
        let full_key = self.versioned_key(key);
        match self.backend.set_ex(&full_key, value, ttl_seconds).await {
            Ok(ok) => Ok(ok),
            Err(err) if self.fail_open => {
                warn!("Response cache set failed: {err}");
                Ok(false)
            }
            Err(err) => Err(err),
        }
    }

    pub async fn del(&self, key: &str) -> Result<(), RedisStoreError> {
        let full_key = self.versioned_key(key);
        match self.backend.del(&full_key).await {
            Ok(_) => Ok(()),
            Err(err) if self.fail_open => {
                warn!("Response cache del failed: {err}");
                Ok(())
            }
            Err(err) => Err(err),
        }
    }

    pub async fn consume(&self, key: &str) -> Result<bool, RedisStoreError> {
        Ok(self.backend.del(&self.versioned_key(key)).await? != 0)
    }

    pub async fn ping(&self) -> Result<bool, RedisStoreError> {
        match self.backend.ping().await {
            Ok(ok) => Ok(ok),
            Err(err) if self.fail_open => {
                warn!("Response cache ping failed: {err}");
                Ok(false)
            }
            Err(err) => Err(err),
        }
    }
}

/// Fixed-window rate limit counter state (`src/middlewares/rate-limit.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RateLimitInfo {
    pub total_hits: u64,
    pub reset_time_ms: Option<i64>,
}

#[derive(Debug, Default)]
struct MemoryRateLimitStore {
    entries: Mutex<HashMap<String, (u64, i64)>>,
    next_sweep_ms: AtomicI64,
}

impl MemoryRateLimitStore {
    fn increment(&self, key: &str, window_ms: u64, now_ms: i64) -> RateLimitInfo {
        let mut guard = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let window_i64 = i64::try_from(window_ms).unwrap_or(i64::MAX);
        // Expired clients must leave the fallback even if their IP never returns.
        if now_ms >= self.next_sweep_ms.load(Ordering::Relaxed) {
            guard.retain(|_, (_, expires_at)| *expires_at > now_ms);
            self.next_sweep_ms.store(
                now_ms.saturating_add(window_i64.clamp(1_000, 60_000)),
                Ordering::Relaxed,
            );
        }
        let expires_at = now_ms.saturating_add(window_i64);
        let entry = guard.entry(key.to_string()).or_insert((0, expires_at));
        if now_ms >= entry.1 {
            *entry = (0, expires_at);
        }
        entry.0 += 1;
        RateLimitInfo {
            total_hits: entry.0,
            reset_time_ms: Some(entry.1),
        }
    }

    fn decrement(&self, key: &str, now_ms: i64) {
        let mut guard = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = guard.get_mut(key) {
            if now_ms >= entry.1 {
                guard.remove(key);
            } else {
                entry.0 = entry.0.saturating_sub(1);
            }
        }
    }

    fn reset_key(&self, key: &str) {
        let mut guard = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        guard.remove(key);
    }

    fn get(&self, key: &str, now_ms: i64) -> Option<RateLimitInfo> {
        let mut guard = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(&(hits, expires_at)) = guard.get(key) {
            if now_ms >= expires_at {
                guard.remove(key);
                return None;
            }
            return Some(RateLimitInfo {
                total_hits: hits,
                reset_time_ms: Some(expires_at),
            });
        }
        None
    }
}

/// Redis-backed fixed-window rate limiter with 30s outage circuit-breaker and in-memory fallback (`src/middlewares/rate-limit.ts`).
pub struct RedisRateLimitStore {
    window_ms: u64,
    namespace: String,
    backend: Arc<dyn RedisBackend>,
    unavailable_until_ms: AtomicI64,
    fallback: MemoryRateLimitStore,
}

impl RedisRateLimitStore {
    pub fn new(
        window_ms: u64,
        namespace: impl Into<String>,
        backend: Arc<dyn RedisBackend>,
    ) -> Self {
        Self {
            window_ms,
            namespace: namespace.into(),
            backend,
            unavailable_until_ms: AtomicI64::new(0),
            fallback: MemoryRateLimitStore::default(),
        }
    }

    pub fn key(&self, client_key: &str) -> String {
        format!("{RATE_LIMIT_PREFIX}{}:{client_key}", self.namespace)
    }

    fn use_redis(&self, now_ms: i64) -> bool {
        now_ms >= self.unavailable_until_ms.load(Ordering::Relaxed)
    }

    fn mark_unavailable(&self, now_ms: i64) {
        self.unavailable_until_ms
            .store(now_ms + REDIS_OUTAGE_BACKOFF_MS, Ordering::Relaxed);
    }

    pub async fn increment(&self, client_key: &str, now_ms: i64) -> RateLimitInfo {
        self.increment_with(&self.namespace, client_key, self.window_ms, now_ms)
            .await
    }

    pub async fn increment_with(
        &self,
        namespace: &str,
        client_key: &str,
        window_ms: u64,
        now_ms: i64,
    ) -> RateLimitInfo {
        let mem_key = format!("{namespace}:{client_key}");
        if !self.use_redis(now_ms) {
            return self.fallback.increment(&mem_key, window_ms, now_ms);
        }
        let full_key = format!("{RATE_LIMIT_PREFIX}{namespace}:{client_key}");
        let window_arg = window_ms.to_string();
        match self
            .backend
            .eval_script(INCREMENT_SCRIPT, &[&full_key], &[&window_arg])
            .await
            .and_then(parse_two_ints)
        {
            Ok((hits, ttl)) => RateLimitInfo {
                total_hits: u64::try_from(hits.max(0)).unwrap_or(0),
                reset_time_ms: (ttl > 0).then_some(now_ms + ttl),
            },
            Err(err) => {
                warn!("Rate limit Redis unavailable; using local fallback: {err}");
                self.mark_unavailable(now_ms);
                self.fallback.increment(&mem_key, window_ms, now_ms)
            }
        }
    }

    pub async fn decrement(&self, client_key: &str, now_ms: i64) {
        let mem_key = format!("{}:{client_key}", self.namespace);
        if !self.use_redis(now_ms) {
            self.fallback.decrement(&mem_key, now_ms);
            return;
        }
        let full_key = self.key(client_key);
        if let Err(err) = self.backend.decr(&full_key).await {
            warn!("Rate limit Redis decrement failed; using local fallback: {err}");
            self.mark_unavailable(now_ms);
            self.fallback.decrement(&mem_key, now_ms);
        }
    }

    pub async fn reset_key(&self, client_key: &str, now_ms: i64) {
        let mem_key = format!("{}:{client_key}", self.namespace);
        if !self.use_redis(now_ms) {
            self.fallback.reset_key(&mem_key);
            return;
        }
        let full_key = self.key(client_key);
        if let Err(err) = self.backend.del(&full_key).await {
            warn!("Rate limit Redis reset failed; using local fallback: {err}");
            self.mark_unavailable(now_ms);
            self.fallback.reset_key(&mem_key);
        }
    }

    pub async fn get(&self, client_key: &str, now_ms: i64) -> Option<RateLimitInfo> {
        let mem_key = format!("{}:{client_key}", self.namespace);
        if !self.use_redis(now_ms) {
            return self.fallback.get(&mem_key, now_ms);
        }
        let full_key = self.key(client_key);
        match futures::try_join!(self.backend.get(&full_key), self.backend.pttl(&full_key)) {
            Ok((Some(val), ttl)) => {
                let hits = val.parse::<u64>().unwrap_or(0);
                Some(RateLimitInfo {
                    total_hits: hits,
                    reset_time_ms: (ttl > 0).then_some(now_ms + ttl),
                })
            }
            Ok((None, _)) => None,
            Err(err) => {
                warn!("Rate limit Redis get failed; using local fallback: {err}");
                self.mark_unavailable(now_ms);
                self.fallback.get(&mem_key, now_ms)
            }
        }
    }
}

fn parse_two_ints(value: RedisValue) -> Result<(i64, i64), RedisStoreError> {
    match value {
        RedisValue::Array(items) if items.len() == 2 => {
            let a = redis_value_to_i64(&items[0])?;
            let b = redis_value_to_i64(&items[1])?;
            Ok((a, b))
        }
        other => Err(RedisStoreError::UnexpectedResponse(format!(
            "expected [int, int], got {other:?}"
        ))),
    }
}

fn redis_value_to_i64(value: &RedisValue) -> Result<i64, RedisStoreError> {
    match value {
        RedisValue::Int(i) => Ok(*i),
        RedisValue::BulkString(bytes) => String::from_utf8_lossy(bytes)
            .parse::<i64>()
            .map_err(|e| RedisStoreError::UnexpectedResponse(e.to_string())),
        RedisValue::SimpleString(s) => s
            .parse::<i64>()
            .map_err(|e| RedisStoreError::UnexpectedResponse(e.to_string())),
        other => Err(RedisStoreError::UnexpectedResponse(format!(
            "expected integer, got {other:?}"
        ))),
    }
}

fn redis_value_to_string(value: &RedisValue) -> Result<String, RedisStoreError> {
    match value {
        RedisValue::BulkString(bytes) => Ok(String::from_utf8_lossy(bytes).into_owned()),
        RedisValue::SimpleString(s) => Ok(s.clone()),
        other => Err(RedisStoreError::UnexpectedResponse(format!(
            "expected string, got {other:?}"
        ))),
    }
}

/// Returns `(events_key, trap_key)` using Redis Cluster hash tags (`src/services/abuse-version.ts`).
pub fn risk_redis_keys(key: &str) -> (String, String) {
    (
        format!("{RISK_PREFIX}{{{key}}}:events"),
        format!("{RISK_PREFIX}{{{key}}}:trap"),
    )
}

/// Abuse telemetry resource (`src/services/abuse-scorer.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AbuseResource {
    pub route: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hydration_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hydration_route: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_hit: Option<bool>,
}

// Redis Lua cjson represents both an empty array and an empty object as {}.
fn redis_event_resources<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Vec<AbuseResource>>, D::Error> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct EmptyObject {}
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Resources {
        List(Vec<AbuseResource>),
        Empty(EmptyObject),
    }
    Ok(
        Option::<Resources>::deserialize(d)?.map(|resources| match resources {
            Resources::List(values) => values,
            Resources::Empty(_) => vec![],
        }),
    )
}

/// Abuse telemetry event (`src/services/abuse-scorer.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AbuseEvent {
    pub route: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hydration_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hydration_route: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_hit: Option<bool>,
    pub at: i64,
    pub deep: bool,
    pub support: bool,
    #[serde(
        default,
        deserialize_with = "redis_event_resources",
        skip_serializing_if = "Option::is_none"
    )]
    pub resources: Option<Vec<AbuseResource>>,
    pub mismatch: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trap: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
}

/// Result returned by [`RedisRiskStore::append`].
#[derive(Debug, Clone, PartialEq)]
pub struct RiskAppendResult {
    pub events: Vec<AbuseEvent>,
    pub trapped: bool,
}

/// Redis sliding-window risk store (`src/services/abuse-scorer.ts`) with local fallback on error.
pub struct RedisRiskStore {
    backend: Arc<dyn RedisBackend>,
    fallback_windows: Mutex<HashMap<String, Vec<AbuseEvent>>>,
    fallback_traps: Mutex<HashMap<String, i64>>,
}

impl RedisRiskStore {
    pub fn new(backend: Arc<dyn RedisBackend>) -> Self {
        Self {
            backend,
            fallback_windows: Mutex::new(HashMap::new()),
            fallback_traps: Mutex::new(HashMap::new()),
        }
    }

    pub async fn append(
        &self,
        key: &str,
        event: &AbuseEvent,
        member_id: &str,
    ) -> Result<RiskAppendResult, RedisStoreError> {
        let (events_key, trap_key) = risk_redis_keys(key);
        let payload = serde_json::to_string(event)?;
        let res = self
            .backend
            .eval_script(
                APPEND_WINDOW_SCRIPT,
                &[&events_key, &trap_key],
                &[&payload, member_id],
            )
            .await?;
        parse_append_window_result(res)
    }

    /// Appends using Redis when available, falling back to a bounded 60s local window on Redis failure.
    pub async fn append_with_fallback(
        &self,
        key: &str,
        event: AbuseEvent,
        member_id: &str,
        now_ms: i64,
    ) -> RiskAppendResult {
        if let Ok(result) = self.append(key, &event, member_id).await {
            return result;
        }
        let mut traps = self
            .fallback_traps
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if event.trap == Some(true) {
            traps.insert(key.to_string(), now_ms + 600_000);
        }
        let trapped = traps.get(key).is_some_and(|&exp| exp > now_ms);
        drop(traps);

        let mut windows = self
            .fallback_windows
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let list = windows.entry(key.to_string()).or_default();
        list.push(event);
        list.retain(|entry| entry.at > now_ms - 60_000);
        list.sort_by_key(|entry| entry.at);
        if list.len() > 128 {
            let excess = list.len() - 128;
            list.drain(0..excess);
        }
        RiskAppendResult {
            events: list.clone(),
            trapped,
        }
    }
}

fn parse_append_window_result(value: RedisValue) -> Result<RiskAppendResult, RedisStoreError> {
    let RedisValue::Array(items) = value else {
        return Err(RedisStoreError::UnexpectedResponse(format!(
            "expected [rows, trapped], got {value:?}"
        )));
    };
    if items.len() != 2 {
        return Err(RedisStoreError::UnexpectedResponse(format!(
            "expected 2-element array, got {}",
            items.len()
        )));
    }
    let RedisValue::Array(rows) = &items[0] else {
        return Err(RedisStoreError::UnexpectedResponse(format!(
            "expected rows array, got {:?}",
            items[0]
        )));
    };
    let trapped = redis_value_to_i64(&items[1])? == 1;
    let mut events = Vec::with_capacity(rows.len());
    for row in rows {
        let s = redis_value_to_string(row)?;
        let json_part = s.find('|').map(|idx| &s[idx + 1..]).unwrap_or(s.as_str());
        let parsed: AbuseEvent = serde_json::from_str(json_part)?;
        events.push(parsed);
    }
    Ok(RiskAppendResult { events, trapped })
}

/// Minute bucket summary row (`src/services/abuse-observation.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SummaryRow {
    pub minute: i64,
    pub values: HashMap<String, i64>,
}

/// Redis store for abuse observation summaries (`src/services/abuse-observation.ts`).
pub struct RedisSummaryStore {
    backend: Arc<dyn RedisBackend>,
}

impl RedisSummaryStore {
    pub fn new(backend: Arc<dyn RedisBackend>) -> Self {
        Self { backend }
    }

    pub async fn write(&self, rows: &[SummaryRow], batch_id: &str) -> Result<(), RedisStoreError> {
        let batch_field = format!("__batch:{batch_id}");
        for row in rows {
            let key = format!("{SUMMARY_PREFIX}{}", row.minute);
            let values_json = serde_json::to_string(&row.values)?;
            let expire_at = (row.minute * 60 + 60 + SUMMARY_TTL_SECONDS).to_string();
            self.backend
                .eval_script(
                    SUMMARY_SCRIPT,
                    &[&key],
                    &[&batch_field, &values_json, &expire_at],
                )
                .await?;
        }
        Ok(())
    }
}

/// PoW cohort funnel row (`src/services/pow-cohorts.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CohortUpdate {
    pub day: i64,
    pub id: String,
    pub first_challenge: i64,
    pub last_challenge: i64,
    pub last_puzzle: i64,
    pub last_solve: i64,
}

/// Redis store for PoW cohort funnels (`src/services/pow-cohorts.ts`).
pub struct RedisCohortStore {
    backend: Arc<dyn RedisBackend>,
}

impl RedisCohortStore {
    pub fn new(backend: Arc<dyn RedisBackend>) -> Self {
        Self { backend }
    }

    pub async fn write(&self, rows: &[CohortUpdate]) -> Result<(), RedisStoreError> {
        let mut days: IndexMap<i64, Vec<&CohortUpdate>> = IndexMap::new();
        for row in rows {
            days.entry(row.day).or_default().push(row);
        }
        for (day, group) in days {
            let key = format!("{COHORT_PREFIX}{day}");
            let expire_at = ((day + 2) * 86_400).to_string();
            let limit = COHORT_LIMIT.to_string();
            for chunk in group.chunks(128) {
                let payload = serde_json::to_string(chunk)?;
                self.backend
                    .eval_script(COHORT_SCRIPT, &[&key], &[&payload, &expire_at, &limit])
                    .await?;
            }
        }
        Ok(())
    }

    pub async fn read_day(&self, day: i64) -> Result<HashMap<String, String>, RedisStoreError> {
        let key = format!("{COHORT_PREFIX}{day}");
        self.backend.hgetall(&key).await
    }
}

/// Redis-backed reader for the operator-only abuse trial switch (`TRIAL_KEY`).
pub struct RedisTrialStore {
    backend: Arc<dyn RedisBackend>,
}

impl RedisTrialStore {
    pub fn new(backend: Arc<dyn RedisBackend>) -> Self {
        Self { backend }
    }

    pub async fn get_raw(&self) -> Result<Option<String>, RedisStoreError> {
        self.backend.get(TRIAL_KEY).await
    }
}

/// Scoped abuse trial route (`src/services/abuse-trial.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AbuseTrialRoute {
    #[serde(rename = "offer-details")]
    OfferDetails,
    #[serde(rename = "catalog-search")]
    CatalogSearch,
}

/// Operator-only abuse trial switch payload (`src/services/abuse-trial.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AbuseTrial {
    pub id: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub fingerprints: Vec<String>,
    pub route: AbuseTrialRoute,
}

/// Validates and parses an [`AbuseTrial`] JSON payload identically to `parseTrial` in `src/services/abuse-trial.ts`.
pub fn parse_trial(raw: Option<&str>, now_ms: i64) -> Option<AbuseTrial> {
    let raw = raw?;
    if raw.is_empty() || raw.len() > 4096 {
        return None;
    }
    let trial: AbuseTrial = serde_json::from_str(raw).ok()?;
    if !is_valid_trial_id(&trial.id)
        || trial.created_at > now_ms
        || trial.expires_at <= now_ms
        || trial.expires_at <= trial.created_at
        || trial.expires_at - trial.created_at > 900_000
    {
        return None;
    }
    if trial.fingerprints.is_empty()
        || trial.fingerprints.len() > 10
        || !trial.fingerprints.iter().all(|f| is_lower_hex_64(f))
    {
        return None;
    }
    Some(trial)
}

fn is_valid_trial_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn is_lower_hex_64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Reads and validates the abuse trial switch from Redis (`TRIAL_KEY`), failing open (`None`) on errors.
pub async fn read_abuse_trial(backend: &dyn RedisBackend, now_ms: i64) -> Option<AbuseTrial> {
    let raw = backend.get(TRIAL_KEY).await.ok()?;
    parse_trial(raw.as_deref(), now_ms)
}

/// Computes the Redis key for an APQ SHA-256 hash (`src/graphql/persisted-queries.ts`).
pub fn persisted_query_key(hash: &str) -> String {
    format!("{APQ_PREFIX}{hash}")
}

/// Computes the lowercase hex SHA-256 digest of a GraphQL query string.
pub fn hash_query(query: &str) -> String {
    hex::encode(Sha256::digest(query.as_bytes()))
}

/// Validates that `value` is a 64-character hex string.
pub fn is_valid_persisted_query_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

struct PersistedMemoryCache {
    capacity: usize,
    entries: IndexMap<String, String>,
}

impl PersistedMemoryCache {
    fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            entries: IndexMap::new(),
        }
    }

    fn get(&self, hash: &str) -> Option<&str> {
        self.entries.get(hash).map(String::as_str)
    }

    fn put(&mut self, hash: String, query: String) {
        if self.entries.contains_key(&hash) {
            self.entries.shift_remove(&hash);
        } else if self.entries.len() >= self.capacity {
            self.entries.shift_remove_index(0);
        }
        self.entries.insert(hash, query);
    }
}

/// GraphQL APQ store with 2000 entries evicted in registration order and 30s Redis outage fallback.
pub struct PersistedQueryStore {
    memory: Mutex<PersistedMemoryCache>,
    backend: Arc<dyn RedisBackend>,
    unavailable_until_ms: AtomicI64,
}

impl PersistedQueryStore {
    pub fn new(backend: Arc<dyn RedisBackend>) -> Self {
        Self::with_capacity(backend, APQ_MEMORY_MAX_ENTRIES)
    }

    pub fn with_capacity(backend: Arc<dyn RedisBackend>, capacity: usize) -> Self {
        Self {
            memory: Mutex::new(PersistedMemoryCache::new(capacity)),
            backend,
            unavailable_until_ms: AtomicI64::new(0),
        }
    }

    fn remember(&self, hash: &str, query: &str) {
        let mut cache = self.memory.lock().unwrap_or_else(|e| e.into_inner());
        cache.put(hash.to_string(), query.to_string());
    }

    fn is_redis_available(&self, now_ms: i64) -> bool {
        now_ms >= self.unavailable_until_ms.load(Ordering::Relaxed)
    }

    fn mark_unavailable(&self, now_ms: i64) {
        self.unavailable_until_ms
            .store(now_ms + REDIS_OUTAGE_BACKOFF_MS, Ordering::Relaxed);
    }

    pub async fn get(&self, hash: &str, now_ms: i64) -> Option<String> {
        {
            let cache = self.memory.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(found) = cache.get(hash).filter(|query| !query.is_empty()) {
                return Some(found.to_string());
            }
        }
        if !self.is_redis_available(now_ms) {
            return None;
        }
        match self.backend.get(&persisted_query_key(hash)).await {
            Ok(Some(stored)) => {
                if !stored.is_empty() {
                    self.remember(hash, &stored);
                }
                Some(stored)
            }
            Ok(None) => None,
            Err(err) => {
                warn!("GraphQL persisted-query Redis unavailable: {err}");
                self.mark_unavailable(now_ms);
                None
            }
        }
    }

    pub async fn store(&self, hash: &str, query: &str, now_ms: i64) {
        self.remember(hash, query);
        if !self.is_redis_available(now_ms) {
            return;
        }
        if let Err(err) = self
            .backend
            .set_ex(&persisted_query_key(hash), query, APQ_TTL_SECONDS)
            .await
        {
            warn!("GraphQL persisted-query Redis store failed: {err}");
            self.mark_unavailable(now_ms);
        }
    }
}

/// Node uses one UUID for each event member or summary batch marker.
pub fn next_unique_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;

    type ScriptCall = (String, Vec<String>, Vec<String>);

    #[derive(Default)]
    struct MockRedis {
        kv: Mutex<HashMap<String, String>>,
        ttls: Mutex<HashMap<String, i64>>,
        fail_all: Mutex<bool>,
        script_calls: Mutex<Vec<ScriptCall>>,
        script_response: Mutex<Option<Result<RedisValue, RedisStoreError>>>,
    }

    impl MockRedis {
        fn set_fail(&self, fail: bool) {
            *self.fail_all.lock().unwrap() = fail;
        }

        fn is_failing(&self) -> bool {
            *self.fail_all.lock().unwrap()
        }
    }

    #[async_trait]
    impl RedisBackend for MockRedis {
        async fn get(&self, key: &str) -> Result<Option<String>, RedisStoreError> {
            if self.is_failing() {
                return Err(RedisStoreError::UnexpectedResponse("forced failure".into()));
            }
            Ok(self.kv.lock().unwrap().get(key).cloned())
        }

        async fn set_ex(
            &self,
            key: &str,
            value: &str,
            ttl_seconds: u64,
        ) -> Result<bool, RedisStoreError> {
            if self.is_failing() {
                return Err(RedisStoreError::UnexpectedResponse("forced failure".into()));
            }
            self.kv
                .lock()
                .unwrap()
                .insert(key.to_string(), value.to_string());
            self.ttls
                .lock()
                .unwrap()
                .insert(key.to_string(), (ttl_seconds * 1000) as i64);
            Ok(true)
        }

        async fn set_px(
            &self,
            key: &str,
            value: &str,
            ttl_ms: u64,
            only_if_absent: bool,
        ) -> Result<bool, RedisStoreError> {
            if self.is_failing() {
                return Err(RedisStoreError::UnexpectedResponse("forced failure".into()));
            }
            let mut kv = self.kv.lock().unwrap();
            if only_if_absent && kv.contains_key(key) {
                return Ok(false);
            }
            kv.insert(key.to_string(), value.to_string());
            self.ttls
                .lock()
                .unwrap()
                .insert(key.to_string(), ttl_ms as i64);
            Ok(true)
        }

        async fn decr(&self, key: &str) -> Result<i64, RedisStoreError> {
            if self.is_failing() {
                return Err(RedisStoreError::UnexpectedResponse("forced failure".into()));
            }
            let mut kv = self.kv.lock().unwrap();
            let val = kv.get(key).and_then(|s| s.parse::<i64>().ok()).unwrap_or(0) - 1;
            kv.insert(key.to_string(), val.to_string());
            Ok(val)
        }

        async fn del(&self, key: &str) -> Result<usize, RedisStoreError> {
            if self.is_failing() {
                return Err(RedisStoreError::UnexpectedResponse("forced failure".into()));
            }
            let removed = self.kv.lock().unwrap().remove(key).is_some();
            self.ttls.lock().unwrap().remove(key);
            Ok(usize::from(removed))
        }

        async fn pttl(&self, key: &str) -> Result<i64, RedisStoreError> {
            if self.is_failing() {
                return Err(RedisStoreError::UnexpectedResponse("forced failure".into()));
            }
            Ok(*self.ttls.lock().unwrap().get(key).unwrap_or(&-2))
        }

        async fn hgetall(&self, _key: &str) -> Result<HashMap<String, String>, RedisStoreError> {
            if self.is_failing() {
                return Err(RedisStoreError::UnexpectedResponse("forced failure".into()));
            }
            Ok(HashMap::new())
        }

        async fn ping(&self) -> Result<bool, RedisStoreError> {
            if self.is_failing() {
                return Err(RedisStoreError::UnexpectedResponse("forced failure".into()));
            }
            Ok(true)
        }

        async fn eval_script(
            &self,
            script: &str,
            keys: &[&str],
            args: &[&str],
        ) -> Result<RedisValue, RedisStoreError> {
            self.script_calls.lock().unwrap().push((
                script.to_string(),
                keys.iter().map(|s| s.to_string()).collect(),
                args.iter().map(|s| s.to_string()).collect(),
            ));
            if self.is_failing() {
                return Err(RedisStoreError::UnexpectedResponse("forced failure".into()));
            }
            if let Some(custom) = self.script_response.lock().unwrap().take() {
                return custom;
            }
            if script == INCREMENT_SCRIPT {
                let key = keys[0];
                let window_ms: i64 = args[0].parse().unwrap();
                let mut kv = self.kv.lock().unwrap();
                let next = kv.get(key).and_then(|v| v.parse::<i64>().ok()).unwrap_or(0) + 1;
                kv.insert(key.to_string(), next.to_string());
                let mut ttls = self.ttls.lock().unwrap();
                let ttl = *ttls.entry(key.to_string()).or_insert(window_ms);
                return Ok(RedisValue::Array(vec![
                    RedisValue::Int(next),
                    RedisValue::Int(ttl),
                ]));
            }
            Ok(RedisValue::Int(1))
        }
    }

    #[test]
    fn redis_config_and_response_cache_validation() {
        let mut env: HashMap<String, String> = HashMap::new();
        let cfg = RedisConfig::from_env_lookup(|k| env.get(k).cloned()).unwrap();
        assert_eq!(cfg.host, "127.0.0.1");
        assert_eq!(cfg.port, 6379);
        assert!(!cfg.tls);
        assert_eq!(cfg.connection_url(), "redis://127.0.0.1:6379");

        env.insert("REDISPORT".into(), "-1".into());
        assert!(RedisConfig::from_env_lookup(|k| env.get(k).cloned()).is_err());

        env.insert("REDISPORT".into(), "6380".into());
        env.insert("REDISTLS".into(), "true".into());
        env.insert("REDISUSER".into(), "alice".into());
        env.insert("REDISPASSWORD".into(), "secret".into());
        let tls_cfg = RedisConfig::from_env_lookup(|k| env.get(k).cloned()).unwrap();
        assert_eq!(
            tls_cfg.connection_url(),
            "rediss://alice:secret@127.0.0.1:6380"
        );

        let no_user = RedisConfig {
            username: None,
            ..tls_cfg.clone()
        };
        assert_eq!(no_user.connection_url(), "rediss://:secret@127.0.0.1:6380");
        let no_pass = RedisConfig {
            password: None,
            ..tls_cfg
        };
        assert_eq!(no_pass.connection_url(), "rediss://alice@127.0.0.1:6380");

        let mut telemetry = HashMap::from([
            ("REDISPASSWORD", "shared secret"),
            ("CACHE_REDIS_HOST", "cache.local"),
            ("ANTI_ABUSE_REDIS_HOST", "::1"),
            ("ANTI_ABUSE_REDIS_USER", "monitor@host"),
            ("ANTI_ABUSE_REDIS_PASSWORD", "  %a/#?:@ pass  "),
        ]);
        let selected = telemetry_config(|key| telemetry.get(key).map(|v| v.to_string())).unwrap();
        let client = selected.client().unwrap();
        let settings = client.get_connection_info().redis_settings();
        assert_eq!(settings.username(), Some("monitor@host"));
        assert_eq!(settings.password(), Some("  %a/#?:@ pass  "));
        assert_eq!(selected.host, "::1");
        let literal_host = RedisConfig {
            host: "literal/4?protocol=resp3".into(),
            tls: true,
            ..selected.clone()
        };
        let client = literal_host.client().unwrap();
        assert!(matches!(client.get_connection_info().addr(),
            redis::ConnectionAddr::TcpTls { host, port: 6379, insecure: false, .. } if host == "literal/4?protocol=resp3"));
        telemetry.remove("ANTI_ABUSE_REDIS_HOST");
        assert!(telemetry_config(|key| telemetry.get(key).map(|v| v.to_string())).is_err());
        telemetry.retain(|key, _| !key.starts_with("ANTI_ABUSE_REDIS"));
        let cache = telemetry_config(|key| telemetry.get(key).map(|v| v.to_string())).unwrap();
        assert_eq!(cache.host, "cache.local");
        assert!(cache.password.is_none());
        telemetry.remove("CACHE_REDIS_HOST");
        let shared = telemetry_config(|key| telemetry.get(key).map(|v| v.to_string())).unwrap();
        assert_eq!(shared.password.as_deref(), Some("shared secret"));

        let empty: HashMap<String, String> = HashMap::new();
        let shared = ResponseCacheConfig::from_env_lookup(|k| empty.get(k).cloned()).unwrap();
        assert_eq!(shared.prefix, "response:v2:");
        assert!(shared.dedicated.is_none());

        let mut bad_dedicated: HashMap<String, String> = HashMap::new();
        bad_dedicated.insert("CACHE_REDIS_PORT".into(), "6379".into());
        assert!(ResponseCacheConfig::from_env_lookup(|k| bad_dedicated.get(k).cloned()).is_err());

        let mut bad_port: HashMap<String, String> = HashMap::new();
        bad_port.insert("CACHE_REDIS_HOST".into(), "cache.internal".into());
        bad_port.insert("CACHE_REDIS_PORT".into(), "abc".into());
        assert!(ResponseCacheConfig::from_env_lookup(|k| bad_port.get(k).cloned()).is_err());

        let mut bad_tls: HashMap<String, String> = HashMap::new();
        bad_tls.insert("CACHE_REDIS_HOST".into(), "cache.internal".into());
        bad_tls.insert("CACHE_REDIS_TLS".into(), "yes".into());
        assert!(ResponseCacheConfig::from_env_lookup(|k| bad_tls.get(k).cloned()).is_err());

        let mut valid_dedicated: HashMap<String, String> = HashMap::new();
        valid_dedicated.insert("RESPONSE_CACHE_PREFIX".into(), "response:v3:".into());
        valid_dedicated.insert("CACHE_REDIS_HOST".into(), "cache.internal".into());
        valid_dedicated.insert("CACHE_REDIS_PORT".into(), "6380".into());
        valid_dedicated.insert("CACHE_REDIS_TLS".into(), "true".into());
        let valid =
            ResponseCacheConfig::from_env_lookup(|k| valid_dedicated.get(k).cloned()).unwrap();
        assert_eq!(valid.prefix, "response:v3:");
        let ded = valid.dedicated.unwrap();
        assert_eq!(ded.connect_timeout_ms, Some(1_000));
        assert_eq!(ded.command_timeout_ms, Some(1_500));
        assert!(ded.tls);

        let mut false_tls = valid_dedicated;
        false_tls.insert("CACHE_REDIS_TLS".into(), "false".into());
        assert!(
            !ResponseCacheConfig::from_env_lookup(|k| false_tls.get(k).cloned())
                .unwrap()
                .dedicated
                .unwrap()
                .tls
        );
    }

    #[test]
    fn mixed_fallback_windows_release_inactive_clients() {
        let store = MemoryRateLimitStore::default();
        for i in 0..1024 {
            store.increment(&format!("brief:{i}"), 1000, 100);
        }
        store.increment("long", 60_000, 100);
        assert_eq!(store.increment("new", 1000, 1101).total_hits, 1);
        assert_eq!(store.entries.lock().unwrap().len(), 2);
        assert_eq!(store.get("long", 1101).unwrap().total_hits, 1);
        // Reusing a shorter window before the next sweep starts a fresh counter.
        store.increment("brief-reused", 30, 1110);
        assert_eq!(store.increment("brief-reused", 30, 1140).total_hits, 1);
    }

    #[tokio::test]
    async fn response_cache_fail_open_and_strict_modes() {
        let backend = Arc::new(MockRedis::default());
        let dedicated = ResponseCache::new("response:v2:", true, backend.clone());
        assert!(
            dedicated
                .set("offer:1", "{\"id\":\"1\"}", 60)
                .await
                .unwrap()
        );
        assert_eq!(
            dedicated.get("offer:1").await.unwrap().as_deref(),
            Some("{\"id\":\"1\"}")
        );

        backend.set_fail(true);
        assert_eq!(dedicated.get("offer:1").await.unwrap(), None);
        assert!(!dedicated.set("offer:1", "x", 60).await.unwrap());
        dedicated.del("offer:1").await.unwrap();
        assert!(!dedicated.ping().await.unwrap());
        assert!(backend.hgetall("h").await.is_err());
        assert!(backend.ping().await.is_err());

        backend.set_fail(false);
        assert!(dedicated.ping().await.unwrap());
        assert!(backend.hgetall("h").await.unwrap().is_empty());
        backend.set_fail(true);

        let shared = ResponseCache::new("response:v2:", false, backend);
        assert!(shared.get("offer:1").await.is_err());
        assert!(shared.set("offer:1", "x", 60).await.is_err());
    }

    #[tokio::test]
    async fn rate_limit_store_redis_and_30s_outage_fallback() {
        let backend = Arc::new(MockRedis::default());
        let store = RedisRateLimitStore::new(60_000, "general", backend.clone());

        let first = store.increment("1.2.3.4", 1_000).await;
        assert_eq!(first.total_hits, 1);
        assert_eq!(first.reset_time_ms, Some(61_000));
        assert_eq!(store.get("1.2.3.4", 1_100).await.unwrap().total_hits, 1);
        assert!(store.get("missing", 1_100).await.is_none());

        store.decrement("1.2.3.4", 1_200).await;
        assert_eq!(store.get("1.2.3.4", 1_250).await.unwrap().total_hits, 0);
        store.reset_key("1.2.3.4", 1_300).await;
        assert!(store.get("1.2.3.4", 1_350).await.is_none());

        // Trigger outage -> switches to fallback for 30_000 ms
        backend.set_fail(true);
        let fb1 = store.increment("1.2.3.4", 2_000).await;
        assert_eq!(fb1.total_hits, 1);
        assert_eq!(fb1.reset_time_ms, Some(62_000));

        // While within 30s outage window, even if backend recovers, fallback is used
        backend.set_fail(false);
        let fb2 = store.increment("1.2.3.4", 3_000).await;
        assert_eq!(fb2.total_hits, 2);
        store.decrement("1.2.3.4", 3_100).await;
        assert_eq!(store.get("1.2.3.4", 3_200).await.unwrap().total_hits, 1);
        store.reset_key("1.2.3.4", 3_300).await;
        assert!(store.get("1.2.3.4", 3_400).await.is_none());

        // Window expiry resets in-memory fallback (with outage still active)
        backend.set_fail(true);
        assert_eq!(store.increment("9.9.9.9", 75_000).await.total_hits, 1);
        assert!(store.get("9.9.9.9", 140_000).await.is_none());
        assert_eq!(store.increment("9.9.9.9", 140_000).await.total_hits, 1);
        assert_eq!(store.increment("9.9.9.9", 210_000).await.total_hits, 1);
        store.decrement("9.9.9.9", 280_000).await;
        assert!(store.get("9.9.9.9", 280_000).await.is_none());

        // After outage expires, Redis is used again; test failures on decr/reset/get
        store.decrement("x", 280_000).await;
        store.reset_key("x", 320_000).await;
        assert!(store.get("x", 360_000).await.is_none());
    }

    #[tokio::test]
    async fn abuse_scripts_and_trial_and_apq() {
        let backend = Arc::new(MockRedis::default());
        assert_eq!(
            risk_redis_keys("fp1"),
            (
                "egdata:abuse:v2:{fp1}:events".to_string(),
                "egdata:abuse:v2:{fp1}:trap".to_string()
            )
        );

        let ev = AbuseEvent {
            route: "/offers/abc".into(),
            page: Some(1),
            item_id: None,
            limit: None,
            search: None,
            title_hash: None,
            hydration_id: None,
            hydration_route: None,
            cache_hit: None,
            at: 10_000,
            deep: true,
            support: false,
            resources: None,
            mismatch: 0.0,
            trap: Some(true),
            method: Some("GET".into()),
        };
        let row_str = format!("uuid-1|{}", serde_json::to_string(&ev).unwrap());
        *backend.script_response.lock().unwrap() = Some(Ok(RedisValue::Array(vec![
            RedisValue::Array(vec![RedisValue::BulkString(row_str.into_bytes())]),
            RedisValue::Int(1),
        ])));
        let risk_store = RedisRiskStore::new(backend.clone());
        let res = risk_store.append("fp1", &ev, "uuid-1").await.unwrap();
        assert!(res.trapped);
        assert_eq!(res.events.len(), 1);

        // Error parsing branches + fallback window
        *backend.script_response.lock().unwrap() = Some(Ok(RedisValue::Int(0)));
        assert!(risk_store.append("fp1", &ev, "u").await.is_err());
        *backend.script_response.lock().unwrap() =
            Some(Ok(RedisValue::Array(vec![RedisValue::Int(0)])));
        assert!(risk_store.append("fp1", &ev, "u").await.is_err());
        *backend.script_response.lock().unwrap() = Some(Ok(RedisValue::Array(vec![
            RedisValue::Int(0),
            RedisValue::Int(0),
        ])));
        assert!(risk_store.append("fp1", &ev, "u").await.is_err());

        backend.set_fail(true);
        for i in 0..130 {
            let mut e = ev.clone();
            e.at = 20_000 + i;
            let fb = risk_store
                .append_with_fallback("fp1", e, "m", 20_000 + i)
                .await;
            assert!(fb.trapped);
            assert!(fb.events.len() <= 128);
        }
        backend.set_fail(false);
        *backend.script_response.lock().unwrap() = Some(Ok(RedisValue::Array(vec![
            RedisValue::Array(vec![]),
            RedisValue::Int(0),
        ])));
        assert!(
            !risk_store
                .append_with_fallback("fp1", ev, "m", 25_000)
                .await
                .trapped
        );

        // Summary store
        let summary = RedisSummaryStore::new(backend.clone());
        let mut values = HashMap::new();
        values.insert("observe|/offers|GET|serve|requests".into(), 3);
        summary
            .write(
                &[SummaryRow {
                    minute: 100,
                    values,
                }],
                "b1",
            )
            .await
            .unwrap();

        // Cohort store (with >128 chunking)
        let cohorts = RedisCohortStore::new(backend.clone());
        let updates: Vec<CohortUpdate> = (0..130)
            .map(|i| CohortUpdate {
                day: 20_000,
                id: format!("id-{i}"),
                first_challenge: 100,
                last_challenge: 100,
                last_puzzle: 0,
                last_solve: 0,
            })
            .collect();
        cohorts.write(&updates).await.unwrap();

        // Trial parser & reader
        backend.set_fail(false);
        assert!(backend.set_px("px1", "v", 1000, true).await.unwrap());
        assert!(!backend.set_px("px1", "v", 1000, true).await.unwrap());
        assert!(backend.set_px("px1", "v2", 1000, false).await.unwrap());
        let fp = "a".repeat(64);
        let valid_trial = serde_json::json!({
            "id": "trial-1",
            "createdAt": 1_000,
            "expiresAt": 10_000,
            "fingerprints": [fp],
            "route": "offer-details"
        })
        .to_string();
        assert!(parse_trial(Some(&valid_trial), 5_000).is_some());
        assert!(parse_trial(None, 5_000).is_none());
        assert!(parse_trial(Some("{"), 5_000).is_none());
        assert!(parse_trial(Some(&"x".repeat(4097)), 5_000).is_none());
        assert!(parse_trial(Some(&valid_trial), 10_000).is_none());
        let bad_fp = serde_json::json!({
            "id": "trial-1",
            "createdAt": 1_000,
            "expiresAt": 10_000,
            "fingerprints": ["short"],
            "route": "catalog-search"
        })
        .to_string();
        assert!(parse_trial(Some(&bad_fp), 5_000).is_none());
        backend.set_ex(TRIAL_KEY, &valid_trial, 60).await.unwrap();
        assert!(read_abuse_trial(backend.as_ref(), 5_000).await.is_some());

        // Persisted query store
        let q = "query { offers { id } }";
        let h = hash_query(q);
        assert!(is_valid_persisted_query_hash(&h));
        assert!(!is_valid_persisted_query_hash("bad"));
        let _default_apq = PersistedQueryStore::new(backend.clone());
        let apq = PersistedQueryStore::with_capacity(backend.clone(), 2);
        assert!(apq.get(&h, 1_000).await.is_none());
        apq.store(&h, q, 1_000).await;
        assert_eq!(apq.get(&h, 1_100).await.as_deref(), Some(q));

        // Evict from memory and fetch from Redis
        let h2 = hash_query("query { b }");
        let h3 = hash_query("query { c }");
        apq.store(&h2, "query { b }", 1_200).await;
        apq.store(&h3, "query { c }", 1_300).await;
        apq.store(&h3, "query { c_updated }", 1_350).await;
        assert_eq!(apq.get(&h3, 1_360).await.as_deref(), Some("query { c_updated }"));
        assert_eq!(apq.get(&h, 1_400).await.as_deref(), Some(q));

        // Redis outage fallback in APQ
        backend.set_fail(true);
        assert!(backend.set_px("px1", "v", 1000, true).await.is_err());
        let h4 = hash_query("query { d }");
        assert!(apq.get(&h4, 2_000).await.is_none());
        assert!(apq.get(&h4, 3_000).await.is_none());
        apq.store(&h4, "query { d }", 3_500).await;
        apq.store(&h4, "query { d }", 40_000).await;
        assert!(!next_unique_id().is_empty());
    }

    #[test]
    fn redis_value_conversion_helpers() {
        assert_eq!(redis_value_to_i64(&RedisValue::Int(7)).unwrap(), 7);
        assert_eq!(
            redis_value_to_i64(&RedisValue::BulkString(b"42".to_vec())).unwrap(),
            42
        );
        assert_eq!(
            redis_value_to_i64(&RedisValue::SimpleString("9".into())).unwrap(),
            9
        );
        assert!(redis_value_to_i64(&RedisValue::Nil).is_err());
        assert_eq!(
            redis_value_to_string(&RedisValue::SimpleString("OK".into())).unwrap(),
            "OK"
        );
        assert!(redis_value_to_string(&RedisValue::Nil).is_err());
        assert!(parse_two_ints(RedisValue::Nil).is_err());
    }

    #[tokio::test]
    async fn live_connection_manager_backend_against_mock_resp_server() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let (read_half, mut write_half) = socket.split();
            let mut reader = BufReader::new(read_half);
            let mut line = String::new();
            let mut evalsha_seen = false;
            while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                let count: usize = line[1..].trim().parse().unwrap();
                let mut parts = Vec::with_capacity(count);
                for _ in 0..count {
                    line.clear();
                    reader.read_line(&mut line).await.unwrap();
                    let len: usize = line[1..].trim().parse().unwrap();
                    let mut buf = vec![0u8; len + 2];
                    tokio::io::AsyncReadExt::read_exact(&mut reader, &mut buf)
                        .await
                        .unwrap();
                    parts.push(String::from_utf8_lossy(&buf[..len]).to_string());
                }
                line.clear();
                let cmd = parts[0].to_ascii_uppercase();
                let eval_sha = Script::new(INCREMENT_SCRIPT).get_hash().to_string();
                let script_load_reply =
                    format!("${}\r\n{eval_sha}\r\n", eval_sha.len()).into_bytes();
                let reply: Vec<u8> = match cmd.as_str() {
                    "GET" => b"$3\r\nval\r\n".to_vec(),
                    "DECR" | "DECRBY" => b":4\r\n".to_vec(),
                    "DEL" => b":1\r\n".to_vec(),
                    "PTTL" => b":5000\r\n".to_vec(),
                    "HGETALL" => b"*2\r\n$1\r\na\r\n$1\r\nb\r\n".to_vec(),
                    "PING" => b"+PONG\r\n".to_vec(),
                    "SCRIPT" => script_load_reply,
                    "EVALSHA" => {
                        if !evalsha_seen {
                            evalsha_seen = true;
                            b"-NOSCRIPT No matching script.\r\n".to_vec()
                        } else {
                            b"*2\r\n:1\r\n:60000\r\n".to_vec()
                        }
                    }
                    _ => b"+OK\r\n".to_vec(),
                };
                let _ = write_half.write_all(&reply).await;
            }
        });

        let cfg = RedisConfig {
            host: addr.ip().to_string(),
            port: addr.port(),
            tls: false,
            username: None,
            password: None,
            connect_timeout_ms: Some(2_000),
            command_timeout_ms: Some(2_000),
        };
        let manager = connect_redis_manager(&cfg).await.unwrap();
        let backend = ConnectionManagerBackend::new(manager);

        assert!(backend.set_ex("k", "v", 60).await.unwrap());
        assert!(backend.set_px("k", "v", 60_000, true).await.unwrap());
        assert!(backend.set_px("k", "v", 60_000, false).await.unwrap());
        assert_eq!(backend.get("k").await.unwrap().as_deref(), Some("val"));
        assert_eq!(backend.decr("k").await.unwrap(), 4);
        assert_eq!(backend.del("k").await.unwrap(), 1);
        assert_eq!(backend.pttl("k").await.unwrap(), 5000);
        assert_eq!(
            backend
                .hgetall("k")
                .await
                .unwrap()
                .get("a")
                .map(String::as_str),
            Some("b")
        );
        assert!(backend.ping().await.unwrap());
        let eval_res = backend
            .eval_script(INCREMENT_SCRIPT, &["k"], &["60000"])
            .await
            .unwrap();
        assert_eq!(parse_two_ints(eval_res).unwrap(), (1, 60000));

        drop(backend);
        server.abort();
    }
}
