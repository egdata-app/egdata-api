//! Discord REST v10, Telegram Bot, Google Analytics Measurement Protocol, and VAPID Web Push clients.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use thiserror::Error;
use tracing::{error, warn};
use url::Url;
use web_push::{
    ContentEncoding, HyperWebPushClient, SubscriptionInfo, VapidSignatureBuilder, WebPushClient,
    WebPushError, WebPushMessageBuilder,
};

pub const DISCORD_API_BASE: &str = "https://discord.com/api/v10";
pub const TELEGRAM_API_BASE: &str = "https://api.telegram.org";
pub const GA_MEASUREMENT_ID_DEFAULT: &str = "G-HB0VNVBEDQ";
pub const GA_COLLECT_URL: &str = "https://www.google-analytics.com/mp/collect";

/// Shared error type for notification and analytics clients.
#[derive(Debug, Error)]
pub enum NotificationError {
    #[error("{0}")]
    Configuration(String),
    #[error("HTTP {status}: {body}")]
    HttpStatus { status: u16, body: String },
    #[error("http error: {0}")]
    Transport(#[from] reqwest::Error),
    #[error("json decode error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("web push error: {0}")]
    WebPush(String),
}

/// Discord REST v10 client (`src/clients/discord.ts`).
#[derive(Clone)]
pub struct DiscordRestClient {
    base_url: String,
    bot_token: String,
    http: Client,
}

impl DiscordRestClient {
    pub fn from_env_lookup<F>(mut get_env: F) -> Result<Self, NotificationError>
    where
        F: FnMut(&str) -> Option<String>,
    {
        let token = get_env("DISCORD_BOT_TOKEN")
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .ok_or_else(|| {
                NotificationError::Configuration("DISCORD_BOT_TOKEN is required".into())
            })?;
        Ok(Self::new(token))
    }

    pub fn new(bot_token: impl Into<String>) -> Self {
        Self::with_base_url(DISCORD_API_BASE, bot_token, Client::new())
    }

    pub fn with_base_url(
        base_url: impl Into<String>,
        bot_token: impl Into<String>,
        http: Client,
    ) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            bot_token: bot_token.into(),
            http,
        }
    }

    pub async fn request(
        &self,
        method: Method,
        route: &str,
        body: Option<&Value>,
    ) -> Result<Value, NotificationError> {
        let normalized_route = if route.starts_with('/') {
            route.to_string()
        } else {
            format!("/{route}")
        };
        let url = format!("{}{normalized_route}", self.base_url);
        let mut req = self
            .http
            .request(method, &url)
            .header("Authorization", format!("Bot {}", self.bot_token));
        if let Some(payload) = body {
            req = req.json(payload);
        }
        let resp = req.send().await?;
        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            return Err(NotificationError::HttpStatus {
                status: status.as_u16(),
                body: text,
            });
        }
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        Ok(serde_json::from_str(&text)?)
    }

    pub async fn get(&self, route: &str) -> Result<Value, NotificationError> {
        self.request(Method::GET, route, None).await
    }

    pub async fn post(&self, route: &str, body: &Value) -> Result<Value, NotificationError> {
        self.request(Method::POST, route, Some(body)).await
    }

    pub async fn put(&self, route: &str, body: &Value) -> Result<Value, NotificationError> {
        self.request(Method::PUT, route, Some(body)).await
    }

    pub async fn patch(&self, route: &str, body: &Value) -> Result<Value, NotificationError> {
        self.request(Method::PATCH, route, Some(body)).await
    }

    pub async fn delete(&self, route: &str) -> Result<Value, NotificationError> {
        self.request(Method::DELETE, route, None).await
    }
}

/// Telegram Bot notification client (`src/clients/telegram.ts`).
#[derive(Clone)]
pub struct TelegramBotService {
    base_url: String,
    token: String,
    pub chat_id: String,
    http: Client,
}

impl TelegramBotService {
    pub fn from_env_lookup<F>(mut get_env: F) -> Self
    where
        F: FnMut(&str) -> Option<String>,
    {
        let token = get_env("TELEGRAM_TOKEN").unwrap_or_default();
        let chat_id = get_env("TELEGRAM_CHAT_ID").unwrap_or_default();
        Self::new(token, chat_id)
    }

    pub fn new(token: impl Into<String>, chat_id: impl Into<String>) -> Self {
        Self::with_base_url(TELEGRAM_API_BASE, token, chat_id, Client::new())
    }

    pub fn with_base_url(
        base_url: impl Into<String>,
        token: impl Into<String>,
        chat_id: impl Into<String>,
        http: Client,
    ) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            token: token.into(),
            chat_id: chat_id.into(),
            http,
        }
    }

    /// Sends a Telegram message and logs any error without propagating (matching `src/clients/telegram.ts`).
    pub async fn send_message(&self, message: &str) {
        if let Err(err) = self.try_send_message(message).await {
            error!("error while sending log message: {err}");
        }
    }

    pub async fn try_send_message(&self, message: &str) -> Result<(), NotificationError> {
        let url = format!("{}/bot{}/sendMessage", self.base_url, self.token);
        let resp = self
            .http
            .post(&url)
            .json(&json!({
                "chat_id": self.chat_id,
                "text": message,
            }))
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(NotificationError::HttpStatus {
                status: status.as_u16(),
                body,
            });
        }
        Ok(())
    }
}

/// Session timing metadata for GA4 Measurement Protocol (`src/clients/ga.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GaSession {
    pub id: String,
    pub started_at: i64,
    pub last_active_at: i64,
}

/// Event tracking payload for [`GaClient::track`] (`src/clients/ga.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GaTrackOptions {
    pub event: String,
    pub location: String,
    pub params: HashMap<String, Value>,
    pub session: GaSession,
    pub user_id: String,
}

/// Google Analytics 4 Measurement Protocol client (`src/clients/ga.ts`).
#[derive(Clone)]
pub struct GaClient {
    collect_url: String,
    id: String,
    secret: Option<String>,
    http: Client,
}

impl GaClient {
    pub fn from_env_lookup<F>(mut get_env: F) -> Self
    where
        F: FnMut(&str) -> Option<String>,
    {
        let secret = get_env("GA_SECRET").filter(|v| !v.trim().is_empty());
        Self::new(GA_MEASUREMENT_ID_DEFAULT, secret)
    }

    pub fn new(id: impl Into<String>, secret: Option<String>) -> Self {
        Self::with_url(GA_COLLECT_URL, id, secret, Client::new())
    }

    pub fn with_url(
        collect_url: impl Into<String>,
        id: impl Into<String>,
        secret: Option<String>,
        http: Client,
    ) -> Self {
        Self {
            collect_url: collect_url.into(),
            id: id.into(),
            secret: secret.filter(|s| !s.is_empty()),
            http,
        }
    }

    /// Tracks an event, returning silently when `GA_SECRET` is unset and logging HTTP failures (`src/clients/ga.ts`).
    pub async fn track(&self, opts: &GaTrackOptions) {
        if let Err(err) = self.try_track(opts).await {
            error!("{err}");
        }
    }

    /// Tracks an event and returns an error if the HTTP request fails or returns non-2xx.
    pub async fn try_track(&self, opts: &GaTrackOptions) -> Result<(), NotificationError> {
        let mut event_params = Map::new();
        event_params.insert("page_location".into(), Value::String(opts.location.clone()));
        for (k, v) in &opts.params {
            event_params.insert(k.clone(), v.clone());
        }
        event_params.insert("session_id".into(), Value::String(opts.session.id.clone()));
        event_params.insert(
            "timestamp_millis".into(),
            Value::Number(opts.session.last_active_at.into()),
        );
        event_params.insert(
            "engagement_time_msec".into(),
            opts.session
                .last_active_at
                .checked_sub(opts.session.started_at)
                .map_or_else(
                    || json!(opts.session.last_active_at as f64 - opts.session.started_at as f64),
                    Value::from,
                ),
        );

        let body = json!({
            "client_id": opts.user_id,
            "user_id": opts.user_id,
            "events": [{
                "name": opts.event,
                "params": Value::Object(event_params),
            }]
        });

        self.try_send_measurement(&body).await
    }

    pub async fn try_send_measurement(&self, body: &Value) -> Result<(), NotificationError> {
        let Some(secret) = &self.secret else {
            warn!("No GA secret provided, skipping GA tracking");
            return Ok(());
        };
        let url = Url::parse(&self.collect_url).map_err(|e| {
            NotificationError::Configuration(format!("Invalid GA collect URL: {e}"))
        })?;
        let mut url = url;
        url.query_pairs_mut()
            .append_pair("measurement_id", &self.id)
            .append_pair("api_secret", secret);

        let resp = self.http.post(url).json(body).send().await?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(NotificationError::HttpStatus {
                status: status.as_u16(),
                body: text,
            });
        }
        Ok(())
    }
}

/// VAPID configuration (`src/routes/push.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VapidConfig {
    pub public_key: String,
    pub private_key: String,
    pub subject: String,
}

impl VapidConfig {
    pub fn from_env_lookup<F>(mut get_env: F) -> Result<Self, NotificationError>
    where
        F: FnMut(&str) -> Option<String>,
    {
        let public_key = get_env("VAPID_PUBLIC_KEY")
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .ok_or_else(|| {
                NotificationError::Configuration("VAPID_PUBLIC_KEY is required".into())
            })?;
        let private_key = get_env("VAPID_PRIVATE_KEY")
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .ok_or_else(|| {
                NotificationError::Configuration("VAPID_PRIVATE_KEY is required".into())
            })?;
        let email = get_env("VAPID_EMAIL")
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .ok_or_else(|| NotificationError::Configuration("VAPID_EMAIL is required".into()))?;

        let subject = if email.starts_with("mailto:") {
            email
        } else {
            format!("mailto:{email}")
        };
        Ok(Self {
            public_key,
            private_key,
            subject,
        })
    }
}

/// Push subscription keys (`src/routes/push.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PushSubscriptionKeys {
    pub p256dh: String,
    pub auth: String,
}

/// Push subscription target (`src/routes/push.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PushSubscriptionTarget {
    pub id: String,
    pub endpoint: String,
    pub keys: PushSubscriptionKeys,
}

/// Outcome of sending one Web Push notification (`src/routes/push.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PushSendOutcome {
    Sent {
        subscription_id: String,
    },
    Expired {
        subscription_id: String,
    },
    Failed {
        subscription_id: String,
        error: String,
    },
}

/// Expands `"offer:123:price"` into `["offer:*", "offer:123:*"]` (`src/routes/push.ts`).
pub fn wildcard_topic_patterns(topic: &str) -> Vec<String> {
    let parts: Vec<&str> = topic.split(':').collect();
    (1..parts.len())
        .map(|i| format!("{}:*", parts[..i].join(":")))
        .collect()
}

/// Trait for dispatching Web Push notifications.
#[async_trait]
pub trait WebPushDispatcher: Send + Sync {
    async fn send_notification(
        &self,
        subscription: &PushSubscriptionTarget,
        payload_json: &[u8],
    ) -> PushSendOutcome;
}

/// VAPID Web Push client backed by `web-push` (`HyperWebPushClient` by default).
pub struct VapidWebPushClient {
    config: VapidConfig,
    client: Arc<dyn WebPushClient + Send + Sync>,
}

impl VapidWebPushClient {
    pub fn new(config: VapidConfig) -> Self {
        Self::with_client(config, Arc::new(HyperWebPushClient::new()))
    }

    pub fn with_client(config: VapidConfig, client: Arc<dyn WebPushClient + Send + Sync>) -> Self {
        Self { config, client }
    }
}

#[async_trait]
impl WebPushDispatcher for VapidWebPushClient {
    async fn send_notification(
        &self,
        subscription: &PushSubscriptionTarget,
        payload_json: &[u8],
    ) -> PushSendOutcome {
        let sub_info = SubscriptionInfo::new(
            &subscription.endpoint,
            &subscription.keys.p256dh,
            &subscription.keys.auth,
        );
        let mut sig_builder =
            match VapidSignatureBuilder::from_base64(&self.config.private_key, &sub_info) {
                Ok(b) => b,
                Err(err) => {
                    return PushSendOutcome::Failed {
                        subscription_id: subscription.id.clone(),
                        error: format!("{err:?}"),
                    };
                }
            };
        sig_builder.add_claim("sub", self.config.subject.as_str());
        let signature = match sig_builder.build() {
            Ok(sig) => sig,
            Err(err) => {
                return PushSendOutcome::Failed {
                    subscription_id: subscription.id.clone(),
                    error: format!("{err:?}"),
                };
            }
        };

        let mut builder = WebPushMessageBuilder::new(&sub_info);
        builder.set_payload(ContentEncoding::Aes128Gcm, payload_json);
        builder.set_vapid_signature(signature);
        let message = match builder.build() {
            Ok(msg) => msg,
            Err(err) => {
                return PushSendOutcome::Failed {
                    subscription_id: subscription.id.clone(),
                    error: format!("{err:?}"),
                };
            }
        };

        match self.client.send(message).await {
            Ok(()) => PushSendOutcome::Sent {
                subscription_id: subscription.id.clone(),
            },
            Err(WebPushError::EndpointNotValid(_)) => PushSendOutcome::Expired {
                subscription_id: subscription.id.clone(),
            },
            Err(err) => PushSendOutcome::Failed {
                subscription_id: subscription.id.clone(),
                error: format!("{err:?}"),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use web_push::{WebPushMessage, request_builder};

    async fn spawn_http_server<F>(handler: F) -> String
    where
        F: Fn(String, String, String) -> (u16, String) + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handler = Arc::new(handler);
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let handler = handler.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 16384];
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let first = req.lines().next().unwrap_or_default().to_string();
                    let mut parts = first.split_whitespace();
                    let method = parts.next().unwrap_or("GET").to_string();
                    let path = parts.next().unwrap_or("/").to_string();
                    let body = req.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
                    let (status, resp_body) = handler(method, path, body);
                    let resp = format!(
                        "HTTP/1.1 {status} Status\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{resp_body}",
                        resp_body.len()
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
                });
            }
        });
        format!("http://{addr}")
    }

    struct MockWebPushTransport {
        mode: &'static str,
    }

    #[async_trait]
    impl WebPushClient for MockWebPushTransport {
        async fn send(&self, _message: WebPushMessage) -> Result<(), WebPushError> {
            match self.mode {
                "ok" => Ok(()),
                "gone" => request_builder::parse_response(410u16.try_into().unwrap(), Vec::new()),
                _ => Err(WebPushError::InvalidResponse),
            }
        }
    }

    #[tokio::test]
    async fn discord_telegram_and_ga_clients() {
        let mut env: HashMap<String, String> = HashMap::new();
        assert!(DiscordRestClient::from_env_lookup(|k| env.get(k).cloned()).is_err());
        env.insert("DISCORD_BOT_TOKEN".into(), "bot-tok".into());
        let _d = DiscordRestClient::from_env_lookup(|k| env.get(k).cloned()).unwrap();

        let base = spawn_http_server(|method, path, body| {
            if path == "/users/@me" && method == "GET" {
                (200, r#"{"id":"bot1"}"#.into())
            } else if path == "/channels/1/messages" && method == "POST" {
                (200, body)
            } else if path == "/empty" && method == "DELETE" {
                (204, String::new())
            } else if path == "/bot-tok/sendMessage" || path == "/bottg-tok/sendMessage" {
                if body.contains("fail") {
                    (500, "err".into())
                } else {
                    (200, r#"{"ok":true}"#.into())
                }
            } else if path.starts_with("/mp/collect") {
                if body.contains("bad-ga") {
                    (500, "err".into())
                } else {
                    (204, String::new())
                }
            } else {
                (400, "bad".into())
            }
        })
        .await;

        let discord = DiscordRestClient::with_base_url(&base, "bot-tok", Client::new());
        assert_eq!(discord.get("/users/@me").await.unwrap()["id"], "bot1");
        assert_eq!(
            discord
                .post("channels/1/messages", &json!({"content":"hi"}))
                .await
                .unwrap()["content"],
            "hi"
        );
        assert_eq!(discord.delete("/empty").await.unwrap(), Value::Null);
        assert!(discord.put("/bad", &json!({})).await.is_err());
        assert!(discord.patch("/bad", &json!({})).await.is_err());

        let tg = TelegramBotService::with_base_url(&base, "tg-tok", "chat-1", Client::new());
        tg.send_message("hello").await;
        tg.send_message("fail").await;
        let tg_env = TelegramBotService::from_env_lookup(|_| None);
        assert_eq!(tg_env.chat_id, "");

        let ga_no_secret = GaClient::from_env_lookup(|_| None);
        let mut params = HashMap::new();
        params.insert("offer_id".into(), Value::String("o1".into()));
        let opts = GaTrackOptions {
            event: "page_view".into(),
            location: "https://egdata.app/offers/o1".into(),
            params,
            session: GaSession {
                id: "s1".into(),
                started_at: 1_000,
                last_active_at: 2_500,
            },
            user_id: "u1".into(),
        };
        ga_no_secret.track(&opts).await;

        let ga = GaClient::with_url(
            format!("{base}/mp/collect"),
            GA_MEASUREMENT_ID_DEFAULT,
            Some("sec".into()),
            Client::new(),
        );
        ga.track(&opts).await;
        let mut fail_opts = opts.clone();
        fail_opts.event = "bad-ga".into();
        ga.track(&fail_opts).await;

        let ga_bad_url = GaClient::with_url("not-a-url", "id", Some("sec".into()), Client::new());
        ga_bad_url.track(&opts).await;

        let ga_dead = GaClient::with_url(
            "http://127.0.0.1:1/mp/collect",
            "id",
            Some("sec".into()),
            Client::new(),
        );
        ga_dead.track(&opts).await;
    }

    #[tokio::test]
    async fn vapid_config_topics_and_web_push_sender() {
        let mut env: HashMap<String, String> = HashMap::new();
        assert!(VapidConfig::from_env_lookup(|k| env.get(k).cloned()).is_err());
        env.insert("VAPID_PUBLIC_KEY".into(), "pub".into());
        assert!(VapidConfig::from_env_lookup(|k| env.get(k).cloned()).is_err());
        env.insert("VAPID_PRIVATE_KEY".into(), "priv".into());
        assert!(VapidConfig::from_env_lookup(|k| env.get(k).cloned()).is_err());
        env.insert("VAPID_EMAIL".into(), "admin@egdata.app".into());
        let cfg = VapidConfig::from_env_lookup(|k| env.get(k).cloned()).unwrap();
        assert_eq!(cfg.subject, "mailto:admin@egdata.app");

        env.insert("VAPID_EMAIL".into(), "mailto:ops@egdata.app".into());
        let cfg2 = VapidConfig::from_env_lookup(|k| env.get(k).cloned()).unwrap();
        assert_eq!(cfg2.subject, "mailto:ops@egdata.app");

        assert_eq!(
            wildcard_topic_patterns("offer:123:price"),
            vec!["offer:*", "offer:123:*"]
        );

        // Generate valid P-256 ECDH browser keypair bytes (65-byte uncompressed 0x04||X||Y)
        let mut pub_bytes = vec![0x04u8];
        // Known valid P-256 generator G point coordinates
        pub_bytes.extend_from_slice(&[
            0x6b, 0x17, 0xd1, 0xf2, 0xe1, 0x2c, 0x42, 0x47, 0xf8, 0xbc, 0xe6, 0xe5, 0x63, 0xa4,
            0x40, 0xf2, 0x77, 0x03, 0x7d, 0x81, 0x2d, 0xeb, 0x33, 0xa0, 0xf4, 0xa1, 0x39, 0x45,
            0xd8, 0x98, 0xc2, 0x96,
        ]);
        pub_bytes.extend_from_slice(&[
            0x4f, 0xe3, 0x42, 0xe2, 0xfe, 0x1a, 0x7f, 0x9b, 0x8e, 0xe7, 0xeb, 0x4a, 0x7c, 0x0f,
            0x9e, 0x16, 0x2b, 0xce, 0x33, 0x57, 0x6b, 0x31, 0x5e, 0xce, 0xcb, 0xb6, 0x40, 0x68,
            0x37, 0xbf, 0x51, 0xf5,
        ]);
        let p256dh = URL_SAFE_NO_PAD.encode(&pub_bytes);
        let auth = URL_SAFE_NO_PAD.encode([1u8; 16]);
        let valid_vapid_priv = "IQ9Ur0ykXoHS9gzfYX0aBjy9lvdrjx_PFUXmie9YRcY";

        let target = PushSubscriptionTarget {
            id: "sub-1".into(),
            endpoint: "https://updates.push.services.mozilla.com/wpush/v1/abc".into(),
            keys: PushSubscriptionKeys { p256dh, auth },
        };

        let vapid = VapidConfig {
            public_key: "unused".into(),
            private_key: valid_vapid_priv.into(),
            subject: "mailto:ops@egdata.app".into(),
        };

        let ok_sender = VapidWebPushClient::with_client(
            vapid.clone(),
            Arc::new(MockWebPushTransport { mode: "ok" }),
        );
        assert_eq!(
            ok_sender
                .send_notification(&target, b"{\"title\":\"Hi\"}")
                .await,
            PushSendOutcome::Sent {
                subscription_id: "sub-1".into()
            }
        );

        let gone_sender = VapidWebPushClient::with_client(
            vapid.clone(),
            Arc::new(MockWebPushTransport { mode: "gone" }),
        );
        assert_eq!(
            gone_sender
                .send_notification(&target, b"{\"title\":\"Hi\"}")
                .await,
            PushSendOutcome::Expired {
                subscription_id: "sub-1".into()
            }
        );

        let err_sender = VapidWebPushClient::with_client(
            vapid.clone(),
            Arc::new(MockWebPushTransport { mode: "err" }),
        );
        assert!(matches!(
            err_sender
                .send_notification(&target, b"{\"title\":\"Hi\"}")
                .await,
            PushSendOutcome::Failed { .. }
        ));

        // Bad VAPID private key fails gracefully
        let bad_key = VapidWebPushClient::new(VapidConfig {
            private_key: "not-a-key".into(),
            ..vapid
        });
        assert!(matches!(
            bad_key.send_notification(&target, b"{}").await,
            PushSendOutcome::Failed { .. }
        ));
    }
}
