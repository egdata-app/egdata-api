//! Discord REST v10, Telegram Bot, Google Analytics Measurement Protocol, and VAPID Web Push clients.

use std::collections::HashMap;
use std::sync::Arc;

use aes_gcm::{
    Aes128Gcm,
    aead::{Aead, KeyInit},
};
use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hkdf::Hkdf;
use p256::{
    PublicKey, SecretKey,
    ecdh::diffie_hellman,
    ecdsa::{Signature, SigningKey, signature::Signer},
    elliptic_curve::Generate,
};
use rand::Rng;
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::Sha256;
use thiserror::Error;
use tracing::{error, warn};
use url::Url;

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

const WEB_PUSH_DEFAULT_TTL_SECONDS: u32 = 2_419_200;
const WEB_PUSH_RECORD_SIZE: u32 = 4096;
const WEB_PUSH_MAX_PAYLOAD_BYTES: usize = 3052;
const VAPID_TTL_SECONDS: i64 = 43_200;

/// Built Web Push HTTP request ready to send to a push service endpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushRequest {
    pub endpoint: String,
    pub ttl: u32,
    pub authorization: String,
    pub body: Vec<u8>,
}

/// Response returned by [`PushTransport::send`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushResponse {
    pub status: u16,
    pub body: String,
}

/// Transport abstraction for dispatching built Web Push requests.
#[async_trait]
pub trait PushTransport: Send + Sync {
    async fn send(&self, request: PushRequest) -> Result<PushResponse, NotificationError>;
}

/// Default [`PushTransport`] backed by `reqwest::Client`.
#[derive(Clone, Default)]
pub struct ReqwestPushTransport {
    http: Client,
}

impl ReqwestPushTransport {
    pub fn new(http: Client) -> Self {
        Self { http }
    }
}

#[async_trait]
impl PushTransport for ReqwestPushTransport {
    async fn send(&self, request: PushRequest) -> Result<PushResponse, NotificationError> {
        let resp = self
            .http
            .post(&request.endpoint)
            .header("TTL", request.ttl.to_string())
            .header("Content-Encoding", "aes128gcm")
            .header("Content-Type", "application/octet-stream")
            .header("Content-Length", request.body.len().to_string())
            .header("Authorization", request.authorization)
            .body(request.body)
            .send()
            .await?;
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        Ok(PushResponse { status, body })
    }
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

/// VAPID Web Push client implementing RFC 8291 (`aes128gcm`) and RFC 8292 (`vapid`).
pub struct VapidWebPushClient {
    config: VapidConfig,
    client: Arc<dyn PushTransport>,
}

impl VapidWebPushClient {
    pub fn new(config: VapidConfig) -> Self {
        Self::with_client(config, Arc::new(ReqwestPushTransport::default()))
    }

    pub fn with_client(config: VapidConfig, client: Arc<dyn PushTransport>) -> Self {
        Self { config, client }
    }
}

fn decode_b64_url(input: &str, label: &str) -> Result<Vec<u8>, NotificationError> {
    URL_SAFE_NO_PAD
        .decode(input.trim_end_matches('='))
        .map_err(|_| NotificationError::WebPush(format!("Invalid {label}")))
}

fn vapid_audience(endpoint: &str) -> Result<String, NotificationError> {
    let url = Url::parse(endpoint)
        .map_err(|e| NotificationError::WebPush(format!("Invalid endpoint URL: {e}")))?;
    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(NotificationError::WebPush(
            "Invalid endpoint URL scheme".into(),
        ));
    }
    let host = url.host_str().unwrap_or_default();
    Ok(match url.port() {
        Some(port) => format!("{scheme}://{host}:{port}"),
        None => format!("{scheme}://{host}"),
    })
}

fn build_vapid_authorization(
    private_key_b64: &str,
    subject: &str,
    endpoint: &str,
    exp: i64,
) -> Result<String, NotificationError> {
    let key_bytes = decode_b64_url(private_key_b64, "VAPID private key")?;
    let signing_key = SigningKey::from_slice(&key_bytes)
        .map_err(|_| NotificationError::WebPush("Invalid VAPID private key".into()))?;
    let aud = vapid_audience(endpoint)?;

    let header_b64 = URL_SAFE_NO_PAD.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = json!({
        "aud": aud,
        "exp": exp,
        "sub": subject,
    });
    let claims_bytes = serde_json::to_vec(&claims)?;
    let claims_b64 = URL_SAFE_NO_PAD.encode(claims_bytes);
    let signing_input = format!("{header_b64}.{claims_b64}");

    let signature: Signature = signing_key.sign(signing_input.as_bytes());
    let sig_b64 = URL_SAFE_NO_PAD.encode(signature.to_bytes());
    let pub_point = signing_key.verifying_key().to_sec1_point(false);
    let pub_b64 = URL_SAFE_NO_PAD.encode(pub_point.as_bytes());

    Ok(format!("vapid t={signing_input}.{sig_b64}, k={pub_b64}"))
}

fn encrypt_aes128gcm_with_ephemeral(
    p256dh_b64: &str,
    auth_b64: &str,
    plaintext: &[u8],
    ephemeral: &SecretKey,
    salt: &[u8; 16],
) -> Result<Vec<u8>, NotificationError> {
    if plaintext.len() > WEB_PUSH_MAX_PAYLOAD_BYTES {
        return Err(NotificationError::WebPush("Payload too large".into()));
    }
    let ua_bytes = decode_b64_url(p256dh_b64, "p256dh key")?;
    let ua_key = PublicKey::from_sec1_bytes(&ua_bytes)
        .map_err(|_| NotificationError::WebPush("Invalid p256dh key".into()))?;
    let ua_pub = ua_key.to_sec1_bytes();

    let auth_bytes = decode_b64_url(auth_b64, "auth secret")?;
    if auth_bytes.len() != 16 {
        return Err(NotificationError::WebPush("Invalid auth secret length".into()));
    }

    let as_pub = ephemeral.public_key().to_sec1_bytes();
    let shared = diffie_hellman(ephemeral.to_nonzero_scalar(), ua_key.as_affine());

    let mut ikm_info = Vec::with_capacity(14 + ua_pub.len() + as_pub.len());
    ikm_info.extend_from_slice(b"WebPush: info\0");
    ikm_info.extend_from_slice(&ua_pub);
    ikm_info.extend_from_slice(&as_pub);

    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&auth_bytes), shared.raw_secret_bytes())
        .expand(&ikm_info, &mut ikm)
        .expect("32-byte IKM fits SHA-256 HKDF");

    let prk = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let mut cek = [0u8; 16];
    let mut nonce = [0u8; 12];
    prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek)
        .expect("16-byte CEK fits SHA-256 HKDF");
    prk.expand(b"Content-Encoding: nonce\0", &mut nonce)
        .expect("12-byte nonce fits SHA-256 HKDF");

    let mut padded = Vec::with_capacity(plaintext.len() + 1);
    padded.extend_from_slice(plaintext);
    padded.push(0x02);

    let cipher = Aes128Gcm::new_from_slice(&cek).expect("16-byte key is valid for AES-128-GCM");
    let ciphertext = cipher
        .encrypt(&nonce.into(), padded.as_slice())
        .expect("AES-128-GCM encryption within max payload is infallible");

    let mut body = Vec::with_capacity(21 + as_pub.len() + ciphertext.len());
    body.extend_from_slice(salt);
    body.extend_from_slice(&WEB_PUSH_RECORD_SIZE.to_be_bytes());
    body.push(as_pub.len() as u8);
    body.extend_from_slice(&as_pub);
    body.extend_from_slice(&ciphertext);
    Ok(body)
}

fn build_web_push_request(
    config: &VapidConfig,
    subscription: &PushSubscriptionTarget,
    payload_json: &[u8],
) -> Result<PushRequest, NotificationError> {
    let exp = chrono::Utc::now().timestamp() + VAPID_TTL_SECONDS;
    let authorization = build_vapid_authorization(
        &config.private_key,
        &config.subject,
        &subscription.endpoint,
        exp,
    )?;
    let mut salt = [0u8; 16];
    rand::rng().fill_bytes(&mut salt);
    let ephemeral = SecretKey::generate();
    let body = encrypt_aes128gcm_with_ephemeral(
        &subscription.keys.p256dh,
        &subscription.keys.auth,
        payload_json,
        &ephemeral,
        &salt,
    )?;
    Ok(PushRequest {
        endpoint: subscription.endpoint.clone(),
        ttl: WEB_PUSH_DEFAULT_TTL_SECONDS,
        authorization,
        body,
    })
}

#[async_trait]
impl WebPushDispatcher for VapidWebPushClient {
    async fn send_notification(
        &self,
        subscription: &PushSubscriptionTarget,
        payload_json: &[u8],
    ) -> PushSendOutcome {
        let request = match build_web_push_request(&self.config, subscription, payload_json) {
            Ok(req) => req,
            Err(err) => {
                return PushSendOutcome::Failed {
                    subscription_id: subscription.id.clone(),
                    error: err.to_string(),
                };
            }
        };

        match self.client.send(request).await {
            Ok(resp) if (200..300).contains(&resp.status) => PushSendOutcome::Sent {
                subscription_id: subscription.id.clone(),
            },
            Ok(resp) if resp.status == 410 => PushSendOutcome::Expired {
                subscription_id: subscription.id.clone(),
            },
            Ok(resp) => PushSendOutcome::Failed {
                subscription_id: subscription.id.clone(),
                error: format!("HTTP {}: {}", resp.status, resp.body),
            },
            Err(err) => PushSendOutcome::Failed {
                subscription_id: subscription.id.clone(),
                error: err.to_string(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{VerifyingKey, signature::Verifier};
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

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

    async fn spawn_capture_server(status: u16, resp_body: &'static str) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let captured = Arc::new(Mutex::new(Vec::new()));
        let captured_clone = captured.clone();
        tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = vec![0u8; 16384];
                let n = socket.read(&mut buf).await.unwrap_or(0);
                captured_clone
                    .lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&buf[..n]).to_string());
                let resp = format!(
                    "HTTP/1.1 {status} Status\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{resp_body}",
                    resp_body.len()
                );
                let _ = socket.write_all(resp.as_bytes()).await;
            }
        });
        (format!("http://{addr}/push"), captured)
    }

    struct MockWebPushTransport {
        mode: &'static str,
    }

    #[async_trait]
    impl PushTransport for MockWebPushTransport {
        async fn send(&self, _request: PushRequest) -> Result<PushResponse, NotificationError> {
            match self.mode {
                "ok" => Ok(PushResponse {
                    status: 201,
                    body: String::new(),
                }),
                "gone" => Ok(PushResponse {
                    status: 410,
                    body: "expired".into(),
                }),
                "status_err" => Ok(PushResponse {
                    status: 502,
                    body: "bad gateway".into(),
                }),
                _ => Err(NotificationError::WebPush("transport error".into())),
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

        let status_err_sender = VapidWebPushClient::with_client(
            vapid.clone(),
            Arc::new(MockWebPushTransport { mode: "status_err" }),
        );
        assert!(matches!(
            status_err_sender
                .send_notification(&target, b"{\"title\":\"Hi\"}")
                .await,
            PushSendOutcome::Failed { .. }
        ));

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

        // Bad VAPID private key or oversized payload fails gracefully
        let bad_key = VapidWebPushClient::new(VapidConfig {
            private_key: "not-a-key".into(),
            ..vapid.clone()
        });
        assert!(matches!(
            bad_key.send_notification(&target, b"{}").await,
            PushSendOutcome::Failed { .. }
        ));
        assert!(matches!(
            ok_sender.send_notification(&target, &[0u8; 3053]).await,
            PushSendOutcome::Failed { .. }
        ));

        // End-to-end ReqwestPushTransport against local HTTP server
        let (push_url, captured) = spawn_capture_server(201, "").await;
        let live_target = PushSubscriptionTarget {
            id: "sub-live".into(),
            endpoint: push_url,
            keys: target.keys.clone(),
        };
        let live_client = VapidWebPushClient::new(vapid.clone());
        assert_eq!(
            live_client
                .send_notification(&live_target, b"{\"title\":\"Live\"}")
                .await,
            PushSendOutcome::Sent {
                subscription_id: "sub-live".into()
            }
        );
        let raw_req = captured.lock().unwrap().remove(0);
        assert!(raw_req.starts_with("POST /push "));
        let lower = raw_req.to_ascii_lowercase();
        assert!(lower.contains("ttl: 2419200"));
        assert!(lower.contains("content-encoding: aes128gcm"));
        assert!(lower.contains("content-type: application/octet-stream"));
        assert!(lower.contains("authorization: vapid t="));

        // Transport error from ReqwestPushTransport (closed port)
        let dead_transport = ReqwestPushTransport::new(Client::new());
        let dead_req = PushRequest {
            endpoint: "http://127.0.0.1:1/push".into(),
            ttl: 60,
            authorization: "vapid t=a.b.c, k=d".into(),
            body: b"abc".to_vec(),
        };
        assert!(dead_transport.send(dead_req).await.is_err());

        // RFC 8291 official aes128gcm test vector
        let rfc_priv = hex::decode("c9f58f89813e9f8e872e71f42aa64e1757c9254dcc62b72ddc010bb4043ea11c").unwrap();
        let rfc_ephemeral = SecretKey::from_slice(&rfc_priv).unwrap();
        let rfc_ua_pub = URL_SAFE_NO_PAD.encode(
            hex::decode("042571b2becdfde360551aaf1ed0f4cd366c11cebe555f89bcb7b186a53339173168ece2ebe018597bd30479b86e3c8f8eced577ca59187e9246990db682008b0e").unwrap(),
        );
        let rfc_auth = URL_SAFE_NO_PAD.encode(hex::decode("05305932a1c7eabe13b6cec9fda48882").unwrap());
        let rfc_salt: [u8; 16] = hex::decode("0c6bfaadad67958803092d454676f397")
            .unwrap()
            .try_into()
            .unwrap();
        let encrypted = encrypt_aes128gcm_with_ephemeral(
            &rfc_ua_pub,
            &rfc_auth,
            b"When I grow up, I want to be a watermelon",
            &rfc_ephemeral,
            &rfc_salt,
        )
        .unwrap();
        let expected_rfc = hex::decode("0c6bfaadad67958803092d454676f397000010004104fe33f4ab0dea71914db55823f73b54948f41306d920732dbb9a59a53286482200e597a7b7bc260ba1c227998580992e93973002f3012a28ae8f06bbb78e5ec0ff297de5b429bba7153d3a4ae0caa091fd425f3b4b5414add8ab37a19c1bbb05cf5cb5b2a2e0562d558635641ec52812c6c8ff42e95ccb86be7cd").unwrap();
        assert_eq!(encrypted, expected_rfc);

        // VAPID ES256 signature verification and key derivation check
        let auth_header = build_vapid_authorization(
            valid_vapid_priv,
            "mailto:ops@egdata.app",
            "https://updates.push.services.mozilla.com/wpush/v2/abc",
            1_800_000_000,
        )
        .unwrap();
        let (t_part, k_part) = auth_header
            .strip_prefix("vapid t=")
            .unwrap()
            .split_once(", k=")
            .unwrap();
        assert_eq!(
            k_part,
            "BMjQIp55pdbU8pfCBKyXcZjlmER_mXt5LqNrN1hrXbdBS5EnhIbMu3Au-RV53iIpztzNXkGI56BFB1udQ8Bq_H4"
        );
        let pub_raw = URL_SAFE_NO_PAD.decode(k_part).unwrap();
        let vk = VerifyingKey::from_sec1_bytes(&pub_raw).unwrap();
        let jwt_parts: Vec<&str> = t_part.split('.').collect();
        assert_eq!(jwt_parts.len(), 3);
        let sig_raw = URL_SAFE_NO_PAD.decode(jwt_parts[2]).unwrap();
        let sig = Signature::from_slice(&sig_raw).unwrap();
        vk.verify(format!("{}.{}", jwt_parts[0], jwt_parts[1]).as_bytes(), &sig)
            .unwrap();
        let claims: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(jwt_parts[1]).unwrap()).unwrap();
        assert_eq!(claims["aud"], "https://updates.push.services.mozilla.com");
        assert_eq!(claims["sub"], "mailto:ops@egdata.app");
        assert_eq!(claims["exp"], 1_800_000_000);

        // Error branches for VAPID & encryption validation
        assert!(build_vapid_authorization("!!!", "s", "https://example.com", 1).is_err());
        assert!(build_vapid_authorization(&URL_SAFE_NO_PAD.encode([1u8; 4]), "s", "https://example.com", 1).is_err());
        assert!(vapid_audience("not a url").is_err());
        assert!(vapid_audience("ftp://example.com/push").is_err());
        assert!(vapid_audience("https:///").is_err());
        assert!(encrypt_aes128gcm_with_ephemeral(&rfc_ua_pub, &rfc_auth, &[0u8; 3053], &rfc_ephemeral, &rfc_salt).is_err());
        assert!(encrypt_aes128gcm_with_ephemeral("!!!", &rfc_auth, b"{}", &rfc_ephemeral, &rfc_salt).is_err());
        assert!(encrypt_aes128gcm_with_ephemeral(&URL_SAFE_NO_PAD.encode([1u8; 4]), &rfc_auth, b"{}", &rfc_ephemeral, &rfc_salt).is_err());
        assert!(encrypt_aes128gcm_with_ephemeral(&rfc_ua_pub, "!!!", b"{}", &rfc_ephemeral, &rfc_salt).is_err());
        assert!(encrypt_aes128gcm_with_ephemeral(&rfc_ua_pub, &URL_SAFE_NO_PAD.encode([1u8; 4]), b"{}", &rfc_ephemeral, &rfc_salt).is_err());
    }
}
