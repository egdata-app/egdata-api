//! Shared application state and configuration for `egdata-api`.

use std::collections::BTreeMap;
use std::sync::Arc;

const DEFAULT_V1_PUBLIC_BASE_URL: &str = "https://api.egdata.app/v1";

use egdata_core::ports::{
    AbuseRiskStorePort, AbuseSummaryStorePort, AbuseTrialStorePort, CatalogHydrationResolverPort,
    DiscordPort, EpicStorePort, GaPort, JobApiPort, MeiliSearchPort, MongoStorePort,
    OgRendererPort, OpenSearchPort, PowCohortStorePort, RateLimitStorePort, ResponseCachePort,
    SessionVerifierPort, TelegramPort, VectorizePort, WebPushPort,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AntiAbuseMode {
    Off,
    Observe,
    Enforce,
}

impl AntiAbuseMode {
    pub fn parse(raw: Option<&str>) -> Result<Self, String> {
        match raw.map(str::trim).filter(|v| !v.is_empty()) {
            None | Some("off") => Ok(Self::Off),
            Some("observe") => Ok(Self::Observe),
            Some("enforce") => Ok(Self::Enforce),
            Some(other) => Err(format!("Invalid ANTI_ABUSE_MODE: {other}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RateLimitConfig {
    pub general_per_minute: u64,
    pub graphql_get_per_minute: u64,
    pub graphql_post_per_minute: u64,
    pub heavy_per_minute: u64,
    pub search_per_minute: u64,
    pub bulk_per_minute: u64,
    pub offers_list_per_minute: u64,
}

impl Default for RateLimitConfig {
    fn default() -> Self {
        Self {
            general_per_minute: 1200,
            graphql_get_per_minute: 1200,
            graphql_post_per_minute: 30,
            heavy_per_minute: 60,
            search_per_minute: 300,
            bulk_per_minute: 10,
            offers_list_per_minute: 5,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ApiConfig {
    pub port: u16,
    pub node_env: String,
    /// Match the Node origin Intl default locale when hosts differ.
    pub collation_locale: String,
    pub origin_auth_token: Option<String>,
    pub origin_auth_required: bool,
    pub origin_auth_host: String,
    pub v1_worker_token: Option<String>,
    pub v1_worker_auth_required: bool,
    pub v1_public_base_url: String,
    pub v1_cursor_secret: Option<String>,
    pub jwt_secret: String,
    pub cookie_secret: String,
    pub anti_abuse_mode: AntiAbuseMode,
    pub anti_abuse_secret: Option<String>,
    pub anti_abuse_edge_secret: Option<String>,
    pub anti_abuse_trust_bot_headers: bool,
    pub anti_abuse_canaries: bool,
    pub rate_limit_enabled: bool,
    pub rate_limits: RateLimitConfig,
    pub epic_client_id: Option<String>,
    pub epic_client_secret: Option<String>,
    pub discord_client_id: Option<String>,
    pub discord_client_secret: Option<String>,
    pub discord_redirect_uri: Option<String>,
    pub push_admin_api_key: Option<String>,
    pub push_user_api_key: Option<String>,
    pub vapid_public_key: Option<String>,
    pub cloudflare_account_id: Option<String>,
    pub cloudflare_images_token: Option<String>,
    pub google_jwks_url: Option<String>,
    pub google_client_id: Option<String>,
    pub admin_account_id: Option<String>,
    pub jwt_public_key_pem: Option<String>,
    pub vapid_private_key: Option<String>,
    pub graphql_introspection: bool,
}

impl Default for ApiConfig {
    fn default() -> Self {
        Self {
            port: 4001,
            node_env: "development".to_string(),
            collation_locale: sys_locale::get_locale().unwrap_or_else(|| "en-US".into()),
            origin_auth_token: None,
            origin_auth_required: false,
            origin_auth_host: "origin-api.egdata.app".to_string(),
            v1_worker_token: None,
            v1_worker_auth_required: false,
            v1_public_base_url: DEFAULT_V1_PUBLIC_BASE_URL.into(),
            v1_cursor_secret: Some("egdata-v1-local-cursor-secret-do-not-use-in-production".into()),
            jwt_secret: "test-jwt-secret".to_string(),
            cookie_secret: "your-32-char-secret-key".to_string(),
            anti_abuse_mode: AntiAbuseMode::Off,
            anti_abuse_secret: None,
            anti_abuse_edge_secret: None,
            anti_abuse_trust_bot_headers: false,
            anti_abuse_canaries: false,
            rate_limit_enabled: false,
            rate_limits: RateLimitConfig::default(),
            epic_client_id: None,
            epic_client_secret: None,
            discord_client_id: None,
            discord_client_secret: None,
            discord_redirect_uri: None,
            push_admin_api_key: None,
            push_user_api_key: None,
            vapid_public_key: None,
            cloudflare_account_id: None,
            cloudflare_images_token: None,
            google_jwks_url: None,
            google_client_id: None,
            admin_account_id: None,
            jwt_public_key_pem: None,
            vapid_private_key: None,
            graphql_introspection: true,
        }
    }
}

impl ApiConfig {
    pub fn from_env_map(env: &BTreeMap<String, String>) -> Result<Self, String> {
        let get = |key: &str| {
            env.get(key)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };
        let node_env = get("NODE_ENV").unwrap_or_else(|| "development".to_string());
        let port = get("PORT")
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(4001);
        let origin_auth_token = get("ORIGIN_AUTH_TOKEN");
        let origin_auth_required = get("ORIGIN_AUTH_REQUIRED").as_deref() == Some("true");
        let origin_auth_host = get("ORIGIN_AUTH_HOST")
            .unwrap_or_else(|| "origin-api.egdata.app".to_string())
            .to_ascii_lowercase()
            .trim_end_matches('.')
            .to_string();
        let v1_worker_token = get("V1_WORKER_TOKEN").or_else(|| origin_auth_token.clone());
        let v1_worker_auth_required = if node_env == "production" {
            true
        } else {
            match get("V1_WORKER_AUTH_REQUIRED").as_deref() {
                Some("true") => true,
                Some("false") => false,
                _ => v1_worker_token.is_some(),
            }
        };
        let anti_abuse_mode = AntiAbuseMode::parse(get("ANTI_ABUSE_MODE").as_deref())?;
        let anti_abuse_secret = env.get("ANTI_ABUSE_SECRET").cloned();
        if anti_abuse_mode != AntiAbuseMode::Off
            && anti_abuse_secret.as_deref().unwrap_or_default().len()
                < egdata_core::abuse::pow::PowSessionService::MIN_SECRET_BYTES
        {
            return Err("ANTI_ABUSE_SECRET must contain at least 32 bytes".into());
        }
        let rate_limit_enabled = match get("RATE_LIMIT_ENABLED").as_deref() {
            Some("false") => false,
            Some("true") => true,
            _ => node_env != "test",
        };
        let parse_limit_env = |key: &str, default: u64| {
            get(key)
                .and_then(|v| v.parse::<u64>().ok())
                .filter(|&v| v > 0)
                .unwrap_or(default)
        };
        let rate_limits = RateLimitConfig {
            general_per_minute: parse_limit_env("RATE_LIMIT_GENERAL_PER_MINUTE", 1200),
            graphql_get_per_minute: parse_limit_env("RATE_LIMIT_GRAPHQL_GET_PER_MINUTE", 1200),
            graphql_post_per_minute: parse_limit_env("RATE_LIMIT_GRAPHQL_POST_PER_MINUTE", 30),
            heavy_per_minute: parse_limit_env("RATE_LIMIT_HEAVY_PER_MINUTE", 60),
            search_per_minute: parse_limit_env("RATE_LIMIT_SEARCH_PER_MINUTE", 300),
            bulk_per_minute: parse_limit_env("RATE_LIMIT_BULK_PER_MINUTE", 10),
            offers_list_per_minute: parse_limit_env("RATE_LIMIT_OFFERS_LIST_PER_MINUTE", 5),
        };
        let graphql_introspection =
            node_env != "production" || get("GRAPHQL_INTROSPECTION").as_deref() == Some("true");

        let v1_cursor_secret = egdata_core::v1::cursor::resolve_cursor_secret(
            get("V1_CURSOR_SECRET").as_deref(),
            Some(&node_env),
            get("V1_CURSOR_DEV_SECRET").as_deref(),
        );
        let collation_locale = get("NODE_ICU_LOCALE")
            .or_else(sys_locale::get_locale)
            .unwrap_or_else(|| "en-US".into());
        collation_locale
            .parse::<icu_locale_core::Locale>()
            .map_err(|_| "NODE_ICU_LOCALE must be a valid BCP 47 locale".to_owned())?;
        Ok(Self {
            port,
            node_env,
            collation_locale,
            origin_auth_token,
            origin_auth_required,
            origin_auth_host,
            v1_worker_token,
            v1_worker_auth_required,
            v1_public_base_url: env
                .get("V1_PUBLIC_BASE_URL")
                .map(|value| egdata_core::v1::trim_js_whitespace(value))
                .filter(|value| !value.is_empty())
                .unwrap_or(DEFAULT_V1_PUBLIC_BASE_URL)
                .trim_end_matches('/')
                .to_owned(),
            v1_cursor_secret,
            jwt_secret: get("JWT_SECRET").unwrap_or_default(),
            cookie_secret: get("COOKIE_SECRET")
                .unwrap_or_else(|| "your-32-char-secret-key".to_string()),
            anti_abuse_mode,
            anti_abuse_secret,
            anti_abuse_edge_secret: get("ANTI_ABUSE_EDGE_SECRET"),
            anti_abuse_trust_bot_headers: get("ANTI_ABUSE_TRUST_BOT_HEADERS").as_deref()
                == Some("true"),
            anti_abuse_canaries: get("ANTI_ABUSE_CANARIES").as_deref() == Some("true"),
            rate_limit_enabled,
            rate_limits,
            epic_client_id: get("EPIC_CLIENT_ID"),
            epic_client_secret: get("EPIC_CLIENT_SECRET"),
            discord_client_id: get("DISCORD_CLIENT_ID"),
            discord_client_secret: get("DISCORD_CLIENT_SECRET"),
            discord_redirect_uri: get("DISCORD_REDIRECT_URI"),
            push_admin_api_key: get("PUSH_ADMIN_API_KEY"),
            push_user_api_key: get("PUSH_USER_API_KEY"),
            vapid_public_key: get("VAPID_PUBLIC_KEY"),
            cloudflare_account_id: get("CLOUDFLARE_ACCOUNT_ID"),
            cloudflare_images_token: get("CF_IMAGES_KEY")
                .or_else(|| get("CLOUDFLARE_IMAGES_TOKEN")),
            google_jwks_url: get("GOOGLE_JWKS_URL"),
            google_client_id: get("GOOGLE_CLIENT_ID"),
            admin_account_id: get("ADMIN_ACCOUNT_ID"),
            jwt_public_key_pem: get("JWT_PUBLIC_KEY").and_then(|val| {
                if val.contains("-----BEGIN") {
                    Some(val)
                } else {
                    std::fs::read_to_string(&val).ok()
                }
            }),
            vapid_private_key: get("VAPID_PRIVATE_KEY"),
            graphql_introspection,
        })
    }
}

#[derive(Clone)]
pub struct AppState {
    /// Wall clock for time-bound queries and signed cursors; replaceable in fixtures.
    pub now: fn() -> chrono::DateTime<chrono::Utc>,
    pub new_object_id: fn() -> bson::oid::ObjectId,
    pub config: Arc<ApiConfig>,
    pub mongo: Arc<dyn MongoStorePort>,
    pub cache: Arc<dyn ResponseCachePort>,
    /// Primary Redis for GraphQL persisted-query keys in the local cache namespace.
    pub graphql_cache: Arc<dyn ResponseCachePort>,
    /// Coordinates refreshes and reads shared cooldown status independently of the response cache.
    pub profile_refresh: Arc<dyn egdata_core::ports::ProfileRefreshPort>,
    /// Saved search IDs live under q: in shared Redis, even with a dedicated response cache.
    pub saved_queries: Arc<dyn ResponseCachePort>,
    pub rate_limit: Arc<dyn RateLimitStorePort>,
    pub abuse_risk: Arc<dyn AbuseRiskStorePort>,
    pub abuse_summary: Arc<dyn AbuseSummaryStorePort>,
    pub pow_cohorts: Arc<dyn PowCohortStorePort>,
    pub abuse_trial: Arc<dyn AbuseTrialStorePort>,
    pub session_verifier: Arc<dyn SessionVerifierPort>,
    pub meili: Arc<dyn MeiliSearchPort>,
    pub opensearch: Arc<dyn OpenSearchPort>,
    pub vectorize: Arc<dyn VectorizePort>,
    pub epic: Arc<dyn EpicStorePort>,
    pub job_api: Arc<dyn JobApiPort>,
    pub discord: Arc<dyn DiscordPort>,
    pub telegram: Arc<dyn TelegramPort>,
    pub ga: Arc<dyn GaPort>,
    pub web_push: Arc<dyn WebPushPort>,
    pub og: Arc<dyn OgRendererPort>,
    pub catalog_hydration: Arc<dyn CatalogHydrationResolverPort>,
    pub http: Arc<dyn egdata_core::ports::UpstreamHttpPort>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_secret_configuration_matches_node_resolution() {
        let mut env = BTreeMap::from([
            ("NODE_ENV".into(), "production".into()),
            ("V1_CURSOR_SECRET".into(), "short".into()),
        ]);
        assert!(
            ApiConfig::from_env_map(&env)
                .unwrap()
                .v1_cursor_secret
                .is_none()
        );
        let dev_secret = "d".repeat(32);
        env.insert("V1_CURSOR_DEV_SECRET".into(), format!(" {dev_secret} "));
        assert_eq!(
            ApiConfig::from_env_map(&env).unwrap().v1_cursor_secret,
            Some(dev_secret)
        );
        env.insert("NODE_ENV".into(), "test".into());
        assert_eq!(
            ApiConfig::from_env_map(&env)
                .unwrap()
                .v1_cursor_secret
                .as_deref(),
            Some(egdata_core::v1::cursor::DEV_SECRET)
        );
        let secret = "s".repeat(32);
        env.insert("V1_CURSOR_SECRET".into(), format!(" {secret} "));
        assert_eq!(
            ApiConfig::from_env_map(&env).unwrap().v1_cursor_secret,
            Some(secret)
        );
    }

    #[test]
    fn parses_anti_abuse_mode_and_config_env() {
        assert_eq!(AntiAbuseMode::parse(None).unwrap(), AntiAbuseMode::Off);
        assert_eq!(
            AntiAbuseMode::parse(Some("observe")).unwrap(),
            AntiAbuseMode::Observe
        );
        assert_eq!(
            AntiAbuseMode::parse(Some("enforce")).unwrap(),
            AntiAbuseMode::Enforce
        );
        assert!(AntiAbuseMode::parse(Some("invalid")).is_err());

        let def = ApiConfig::default();
        assert_eq!(def.port, 4001);
        assert!(!def.rate_limit_enabled);

        let mut env = BTreeMap::new();
        env.insert("NODE_ENV".into(), "production".into());
        env.insert("PORT".into(), "4005".into());
        env.insert("ORIGIN_AUTH_TOKEN".into(), "tok".into());
        env.insert("ORIGIN_AUTH_REQUIRED".into(), "true".into());
        env.insert("ANTI_ABUSE_MODE".into(), "enforce".into());
        assert!(
            ApiConfig::from_env_map(&env)
                .unwrap_err()
                .contains("ANTI_ABUSE_SECRET")
        );
        env.insert("ANTI_ABUSE_SECRET".into(), "test-key".repeat(4));
        env.insert("RATE_LIMIT_GENERAL_PER_MINUTE".into(), "999".into());
        env.insert("GRAPHQL_INTROSPECTION".into(), "true".into());
        let cfg = ApiConfig::from_env_map(&env).unwrap();
        assert_eq!(cfg.port, 4005);
        assert!(cfg.v1_worker_auth_required);
        assert!(cfg.rate_limit_enabled);
        assert_eq!(cfg.rate_limits.general_per_minute, 999);
        assert!(cfg.graphql_introspection);

        env.insert("NODE_ENV".into(), "development".into());
        env.insert("V1_WORKER_AUTH_REQUIRED".into(), "false".into());
        env.insert("RATE_LIMIT_ENABLED".into(), "false".into());
        let dev = ApiConfig::from_env_map(&env).unwrap();
        assert!(!dev.v1_worker_auth_required);
        assert!(!dev.rate_limit_enabled);

        env.insert("V1_WORKER_AUTH_REQUIRED".into(), "true".into());
        env.insert("RATE_LIMIT_ENABLED".into(), "true".into());
        let forced = ApiConfig::from_env_map(&env).unwrap();
        assert!(forced.v1_worker_auth_required);
        assert!(forced.rate_limit_enabled);
    }

    #[test]
    fn validates_explicit_node_collation_locale() {
        let mut env = BTreeMap::from([("NODE_ICU_LOCALE".into(), "es-ES".into())]);
        assert_eq!(
            ApiConfig::from_env_map(&env).unwrap().collation_locale,
            "es-ES"
        );
        env.insert("NODE_ICU_LOCALE".into(), "bad_locale!".into());
        assert!(ApiConfig::from_env_map(&env).is_err());
    }
}
