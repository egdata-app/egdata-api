//! Job API client with canonical HMAC-SHA256 signing, retries, batch concurrency, and achievement refresh cooldowns.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD as BASE64_URL_NO_PAD};
use bytes::Bytes;
use chrono::{DateTime, Utc};
use egdata_core::v1::{
    serialization::{js_iso_datetime, node_json},
    trim_js_whitespace,
};
use futures::future::join_all;
use hmac::{Hmac, Mac};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use thiserror::Error;
use url::Url;

use crate::redis_store::RedisBackend;

type HmacSha256 = Hmac<Sha256>;
const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

/// Job types supported by the Job API (`src/clients/job-api.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum JobApiJobType {
    #[serde(rename = "offer-regen")]
    OfferRegen,
    #[serde(rename = "item-regen")]
    ItemRegen,
    #[serde(rename = "achievement-refresh")]
    AchievementRefresh,
}

impl JobApiJobType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OfferRegen => "offer-regen",
            Self::ItemRegen => "item-regen",
            Self::AchievementRefresh => "achievement-refresh",
        }
    }

    pub fn endpoint(self) -> &'static str {
        match self {
            Self::OfferRegen => "/v1/jobs/offer-regens",
            Self::ItemRegen => "/v1/jobs/item-regens",
            Self::AchievementRefresh => "/v1/jobs/achievement-refreshes",
        }
    }
}

/// Validated Job API client configuration (`src/clients/job-api.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobApiClientConfig {
    pub base_url: String,
    pub key_id: String,
    pub secret: String,
}

impl JobApiClientConfig {
    /// Loads and validates `JOB_API_BASE_URL`, `JOB_API_KEY_ID`, and `JOB_API_SECRET`.
    pub fn from_env_lookup<F>(mut get_env: F) -> Result<Self, JobApiError>
    where
        F: FnMut(&str) -> Option<String>,
    {
        let raw_base_url = required_env(&mut get_env, "JOB_API_BASE_URL", true)?;
        let key_id = required_env(&mut get_env, "JOB_API_KEY_ID", true)?;
        let secret = required_env(&mut get_env, "JOB_API_SECRET", false)?;

        let parsed = Url::parse(&raw_base_url).map_err(|_| {
            JobApiError::InvalidConfig("JOB_API_BASE_URL must be an absolute URL".into())
        })?;
        if !matches!(parsed.scheme(), "http" | "https")
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some_and(|s| !s.is_empty())
            || parsed.fragment().is_some_and(|s| !s.is_empty())
        {
            return Err(JobApiError::InvalidConfig(
                "JOB_API_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment"
                    .into(),
            ));
        }

        if !is_valid_key_id(&key_id) {
            return Err(JobApiError::InvalidConfig(
                "JOB_API_KEY_ID must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}".into(),
            ));
        }

        if secret.len() < 32 {
            return Err(JobApiError::InvalidConfig(
                "JOB_API_SECRET must contain at least 32 bytes".into(),
            ));
        }

        Ok(Self {
            base_url: raw_base_url.trim_end_matches('/').to_string(),
            key_id,
            secret,
        })
    }
}

fn required_env<F>(get_env: &mut F, name: &str, trim: bool) -> Result<String, JobApiError>
where
    F: FnMut(&str) -> Option<String>,
{
    let raw = get_env(name).ok_or_else(|| {
        JobApiError::InvalidConfig(format!("{name} is required for job submission"))
    })?;
    if trim_js_whitespace(&raw).is_empty() {
        return Err(JobApiError::InvalidConfig(format!(
            "{name} is required for job submission"
        )));
    }
    Ok(if trim {
        trim_js_whitespace(&raw).to_string()
    } else {
        raw
    })
}

/// Canonical signing input (`JobApiSigningInput` in `src/clients/job-api.ts`).
#[derive(Debug, Clone)]
pub struct JobApiSigningInput<'a> {
    pub key_id: &'a str,
    pub secret: &'a str,
    pub timestamp: &'a str,
    pub nonce: &'a str,
    pub method: &'a str,
    pub url: &'a str,
    pub idempotency_key: Option<&'a str>,
    pub body: &'a [u8],
}

/// Strictly validated HTTP 202 acceptance payload (`AcceptedJobApiSubmission`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptedJobApiSubmission {
    pub job_id: String,
    pub workflow_id: String,
    pub status_url: String,
    pub deduplicated: bool,
}

/// Errors produced by Job API configuration, submission, or achievement refresh cooldowns.
#[derive(Debug, Error)]
pub enum JobApiError {
    #[error("{0}")]
    InvalidConfig(String),
    #[error("{0}")]
    InvalidInput(String),
    #[error("{message}")]
    Request {
        message: String,
        retryable: bool,
        status: Option<u16>,
    },
    #[error("{failed} of {total} job submissions were not durably accepted")]
    BatchFailed {
        failed: usize,
        total: usize,
        errors: Vec<String>,
    },
    #[error("{0}")]
    RefreshCooldown(String),
}

impl JobApiError {
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            Self::Request {
                retryable: true,
                ..
            }
        )
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Computes the canonical request string and HMAC-SHA256 hex signature (`createJobApiSignature`).
pub fn create_job_api_signature(input: &JobApiSigningInput<'_>) -> Result<String, JobApiError> {
    sign_body_hash(input, &sha256_hex(input.body))
}

fn sign_body_hash(input: &JobApiSigningInput<'_>, body_hash: &str) -> Result<String, JobApiError> {
    let parsed =
        Url::parse(input.url).map_err(|_| JobApiError::InvalidInput("Invalid URL".into()))?;
    let path_and_query = match parsed.query() {
        Some(q) if !q.is_empty() => format!("{}?{q}", parsed.path()),
        _ => parsed.path().to_string(),
    };
    let canonical = [
        "egdata-job-api-v1",
        input.key_id,
        input.timestamp,
        input.nonce,
        &input.method.to_ascii_uppercase(),
        &path_and_query,
        input.idempotency_key.unwrap_or(""),
        body_hash,
    ]
    .join("\n");

    let mut mac = HmacSha256::new_from_slice(input.secret.as_bytes())
        .expect("HMAC-SHA256 accepts a key of any length");
    mac.update(canonical.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

/// Generates a UUIDv4-formatted request ID.
pub fn create_job_api_request_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Generates a 24-byte base64url nonce using the operating-system-seeded RNG.
pub fn create_job_api_nonce() -> String {
    BASE64_URL_NO_PAD.encode(rand::random::<[u8; 24]>())
}

/// Builds an idempotency key matching `createJobApiIdempotencyKey` in `src/clients/job-api.ts`.
pub fn create_job_api_idempotency_key(
    job_type: JobApiJobType,
    request_id: &str,
    item_index: usize,
    payload: &Value,
) -> Result<String, JobApiError> {
    if item_index as u64 > MAX_SAFE_INTEGER as u64 {
        return Err(JobApiError::InvalidInput(
            "Job API item index must be a non-negative safe integer".into(),
        ));
    }
    Ok(idempotency_key(
        job_type,
        request_id,
        item_index,
        &sha256_hex(node_json(payload).as_bytes()),
    ))
}

fn idempotency_key(
    job_type: JobApiJobType,
    request_id: &str,
    item_index: usize,
    body_hash: &str,
) -> String {
    let request_hash = sha256_hex(request_id.as_bytes());
    format!(
        "egdata-api:{}:{}:{item_index}:{}",
        job_type.as_str(),
        &request_hash[..32],
        &body_hash[..32]
    )
}

/// The signature, idempotency key and HTTP request must all use the same serialized payload.
struct SubmissionBody {
    bytes: Bytes,
    sha256: String,
}
impl SubmissionBody {
    fn new(payload: &Value) -> Self {
        let bytes = Bytes::from(node_json(payload));
        let sha256 = sha256_hex(&bytes);
        Self { bytes, sha256 }
    }
}

fn is_valid_key_id(s: &str) -> bool {
    let bytes = s.as_bytes();
    (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn is_valid_nonce(s: &str) -> bool {
    (16..=128).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn is_valid_external_job_id(s: &str) -> bool {
    let rest = s
        .strip_prefix("api-offer-regen-")
        .or_else(|| s.strip_prefix("api-item-regen-"))
        .or_else(|| s.strip_prefix("api-achievement-refresh-"));
    rest.is_some_and(|hex_part| {
        hex_part.len() == 64
            && hex_part
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    })
}

fn validate_accepted_submission(value: &Value) -> Result<AcceptedJobApiSubmission, JobApiError> {
    let Some(obj) = value.as_object() else {
        return Err(JobApiError::Request {
            message: "Job API returned an invalid acceptance body".into(),
            retryable: true,
            status: None,
        });
    };
    let job_id = obj.get("jobId").and_then(Value::as_str);
    let workflow_id = obj.get("workflowId").and_then(Value::as_str);
    let status_url = obj.get("statusUrl").and_then(Value::as_str);
    let deduplicated = obj.get("deduplicated").and_then(Value::as_bool);

    match (job_id, workflow_id, status_url, deduplicated) {
        (Some(jid), Some(wid), Some(surl), Some(dedup))
            if is_valid_external_job_id(jid) && wid == jid && !surl.is_empty() =>
        {
            Ok(AcceptedJobApiSubmission {
                job_id: jid.to_string(),
                workflow_id: wid.to_string(),
                status_url: surl.to_string(),
                deduplicated: dedup,
            })
        }
        _ => Err(JobApiError::Request {
            message: "Job API returned incomplete acceptance metadata".into(),
            retryable: true,
            status: None,
        }),
    }
}

/// Request options for [`JobApiClient::submit_request`].
#[derive(Debug, Clone)]
pub struct JobApiRequestOptions {
    pub request_id: Option<String>,
    pub max_attempts: usize,
    pub timeout_ms: u64,
    pub backoff_base_ms: u64,
}

impl Default for JobApiRequestOptions {
    fn default() -> Self {
        Self {
            request_id: None,
            max_attempts: 2,
            timeout_ms: 1_250,
            backoff_base_ms: 100,
        }
    }
}

/// Batch options for [`JobApiClient::submit_batch`].
#[derive(Debug, Clone)]
pub struct JobApiBatchOptions {
    pub concurrency: usize,
    pub request_options: JobApiRequestOptions,
}

impl Default for JobApiBatchOptions {
    fn default() -> Self {
        Self {
            concurrency: 8,
            request_options: JobApiRequestOptions::default(),
        }
    }
}

/// Clock + nonce abstraction for deterministic testing.
pub trait JobApiClock: Send + Sync {
    fn now_ms(&self) -> i64;
    fn nonce(&self) -> String;
}

#[derive(Debug, Default)]
pub struct SystemJobApiClock;

impl JobApiClock for SystemJobApiClock {
    fn now_ms(&self) -> i64 {
        Utc::now().timestamp_millis()
    }

    fn nonce(&self) -> String {
        create_job_api_nonce()
    }
}

/// Job API HTTP client (`src/clients/job-api.ts`).
#[derive(Clone)]
pub struct JobApiClient {
    config: JobApiClientConfig,
    http: Client,
    clock: Arc<dyn JobApiClock>,
}

impl JobApiClient {
    pub fn new(config: JobApiClientConfig) -> Self {
        Self {
            config,
            http: Client::new(),
            clock: Arc::new(SystemJobApiClock),
        }
    }

    pub fn with_clock(
        config: JobApiClientConfig,
        http: Client,
        clock: Arc<dyn JobApiClock>,
    ) -> Self {
        Self {
            config,
            http,
            clock,
        }
    }

    pub async fn submit_request(
        &self,
        job_type: JobApiJobType,
        payload: &Value,
        options: &JobApiRequestOptions,
    ) -> Result<AcceptedJobApiSubmission, JobApiError> {
        let request_id = options
            .request_id
            .clone()
            .unwrap_or_else(create_job_api_request_id);
        let body = SubmissionBody::new(payload);
        let key = idempotency_key(job_type, &request_id, 0, &body.sha256);
        self.submit_with_key(job_type, &body, &key, options).await
    }

    pub async fn submit_batch(
        &self,
        job_type: JobApiJobType,
        payloads: &[Value],
        options: &JobApiBatchOptions,
    ) -> Result<Vec<AcceptedJobApiSubmission>, JobApiError> {
        if !(1..=32).contains(&options.concurrency) {
            return Err(JobApiError::InvalidInput(
                "Job API batch concurrency must be an integer between 1 and 32".into(),
            ));
        }
        if payloads.is_empty() {
            return Ok(Vec::new());
        }

        let request_id = options
            .request_options
            .request_id
            .clone()
            .unwrap_or_else(create_job_api_request_id);
        let next_index = Arc::new(AtomicUsize::new(0));
        let results: Arc<tokio::sync::Mutex<Vec<Option<AcceptedJobApiSubmission>>>> =
            Arc::new(tokio::sync::Mutex::new(vec![None; payloads.len()]));
        let failures: Arc<tokio::sync::Mutex<Vec<String>>> =
            Arc::new(tokio::sync::Mutex::new(Vec::new()));

        let worker_count = options.concurrency.min(payloads.len());
        let workers = (0..worker_count).map(|_| {
            let next_index = next_index.clone();
            let results = results.clone();
            let failures = failures.clone();
            let request_id = request_id.clone();
            async move {
                loop {
                    let idx = next_index.fetch_add(1, Ordering::Relaxed);
                    if idx >= payloads.len() {
                        break;
                    }
                    let body = SubmissionBody::new(&payloads[idx]);
                    let key = idempotency_key(job_type, &request_id, idx, &body.sha256);
                    let res = self
                        .submit_with_key(job_type, &body, &key, &options.request_options)
                        .await;
                    match res {
                        Ok(accepted) => {
                            results.lock().await[idx] = Some(accepted);
                        }
                        Err(err) => {
                            failures
                                .lock()
                                .await
                                .push(format!("Job API batch item {idx} was not accepted: {err}"));
                        }
                    }
                }
            }
        });

        join_all(workers).await;

        let failed = failures.lock().await;
        if !failed.is_empty() {
            return Err(JobApiError::BatchFailed {
                failed: failed.len(),
                total: payloads.len(),
                errors: failed.clone(),
            });
        }

        let collected = results
            .lock()
            .await
            .iter_mut()
            .map(|slot| slot.take().expect("all batch items succeeded"))
            .collect();
        Ok(collected)
    }

    async fn submit_with_key(
        &self,
        job_type: JobApiJobType,
        body: &SubmissionBody,
        idempotency_key: &str,
        options: &JobApiRequestOptions,
    ) -> Result<AcceptedJobApiSubmission, JobApiError> {
        if !(1..=5).contains(&options.max_attempts) {
            return Err(JobApiError::InvalidInput(
                "Job API maxAttempts must be an integer between 1 and 5".into(),
            ));
        }
        if !(1..=MAX_SAFE_INTEGER as u64).contains(&options.timeout_ms) {
            return Err(JobApiError::InvalidInput(
                "Job API timeoutMs must be a positive integer".into(),
            ));
        }

        let url = format!("{}{}", self.config.base_url, job_type.endpoint());

        let mut attempt = 1usize;
        loop {
            let nonce = self.clock.nonce();
            if !is_valid_nonce(&nonce) {
                return Err(JobApiError::InvalidInput(
                    "Job API nonce must contain 16-128 URL-safe characters".into(),
                ));
            }
            let timestamp = self.clock.now_ms().div_euclid(1000).to_string();
            let signature = sign_body_hash(
                &JobApiSigningInput {
                    key_id: &self.config.key_id,
                    secret: &self.config.secret,
                    timestamp: &timestamp,
                    nonce: &nonce,
                    method: "POST",
                    url: &url,
                    idempotency_key: Some(idempotency_key),
                    body: &body.bytes,
                },
                &body.sha256,
            )?;

            let attempt_result = self
                .send_once(
                    &url,
                    &body.bytes,
                    idempotency_key,
                    &nonce,
                    &timestamp,
                    &signature,
                    options.timeout_ms,
                )
                .await;

            match attempt_result {
                Ok(accepted) => return Ok(accepted),
                Err(err) if !err.is_retryable() || attempt == options.max_attempts => {
                    return Err(err);
                }
                Err(_) => {}
            }

            if options.backoff_base_ms > 0 {
                let delay = options
                    .backoff_base_ms
                    .saturating_mul(1u64 << (attempt - 1));
                tokio::time::sleep(Duration::from_millis(delay)).await;
            }
            attempt += 1;
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn send_once(
        &self,
        url: &str,
        body: &Bytes,
        idempotency_key: &str,
        nonce: &str,
        timestamp: &str,
        signature: &str,
        timeout_ms: u64,
    ) -> Result<AcceptedJobApiSubmission, JobApiError> {
        let resp = self
            .http
            .post(url)
            .timeout(Duration::from_millis(if timeout_ms > i32::MAX as u64 {
                1
            } else {
                timeout_ms
            }))
            .header("content-type", "application/json")
            .header("idempotency-key", idempotency_key)
            .header("x-api-key-id", &self.config.key_id)
            .header("x-api-nonce", nonce)
            .header("x-api-signature", format!("sha256={signature}"))
            .header("x-api-timestamp", timestamp)
            .body(body.clone())
            .send()
            .await
            .map_err(|_| JobApiError::Request {
                message: "Job API request failed before acceptance was confirmed".into(),
                retryable: true,
                status: None,
            })?;

        let status = resp.status().as_u16();
        let bytes = resp.bytes().await.map_err(|_| JobApiError::Request {
            message: "Job API response could not be verified".into(),
            retryable: true,
            status: None,
        })?;
        // Fetch Response.text always uses UTF-8 and strips a leading byte order mark.
        let text =
            String::from_utf8_lossy(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes));
        if status != 202 {
            let details = String::from_utf16_lossy(
                &trim_js_whitespace(&text)
                    .encode_utf16()
                    .take(500)
                    .collect::<Vec<_>>(),
            );
            let suffix = if details.is_empty() {
                String::new()
            } else {
                format!(": {details}")
            };
            return Err(JobApiError::Request {
                message: format!("Job API rejected the submission with HTTP {status}{suffix}"),
                retryable: status == 408 || status == 429 || status >= 500,
                status: Some(status),
            });
        }

        let parsed: Value = serde_json::from_str(&text).map_err(|_| JobApiError::Request {
            message: "Job API returned a non-JSON acceptance body".into(),
            retryable: true,
            status: Some(status),
        })?;
        validate_accepted_submission(&parsed)
    }
}

/// Metadata stored in Redis after an accepted achievement refresh (`src/clients/achievement-refresh.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemporalAchievementRefreshMetadata {
    pub job_id: String,
    pub workflow_id: String,
    pub status_url: String,
    pub deduplicated: bool,
    pub accepted_at: String,
    pub job_type: String,
    pub orchestrator: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AchievementRefreshRequestResult {
    pub metadata: Option<TemporalAchievementRefreshMetadata>,
    pub reused_cooldown: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CooldownSlot {
    request_id: String,
    timestamp: i64,
}

/// Submitter abstraction for `request_achievement_refresh`.
#[async_trait]
pub trait JobSubmitter: Send + Sync {
    async fn submit_achievement_refresh(
        &self,
        account_id: &str,
        request_id: &str,
    ) -> Result<AcceptedJobApiSubmission, JobApiError>;
}

#[async_trait]
impl JobSubmitter for JobApiClient {
    async fn submit_achievement_refresh(
        &self,
        account_id: &str,
        request_id: &str,
    ) -> Result<AcceptedJobApiSubmission, JobApiError> {
        let opts = JobApiRequestOptions {
            request_id: Some(request_id.to_string()),
            ..JobApiRequestOptions::default()
        };
        self.submit_request(
            JobApiJobType::AchievementRefresh,
            &json!({ "accountId": account_id }),
            &opts,
        )
        .await
    }
}

fn parse_stored_record(raw: &str, label: &str) -> Result<Value, JobApiError> {
    let parsed: Value = serde_json::from_str(raw).map_err(|_| {
        JobApiError::RefreshCooldown(format!("{label} cache entry is not valid JSON"))
    })?;
    if !parsed.is_object() {
        return Err(JobApiError::RefreshCooldown(format!(
            "{label} cache entry must be an object"
        )));
    }
    Ok(parsed)
}

fn stored_timestamp(record: &Value) -> Option<i64> {
    let number = record["timestamp"].as_f64()?;
    (number.fract() == 0.0 && number > 0.0 && number <= MAX_SAFE_INTEGER as f64)
        .then_some(number as i64)
}

/// Computes remaining cooldown time in milliseconds (`achievementRefreshRemainingTime` in `src/clients/achievement-refresh.ts`).
pub fn achievement_refresh_remaining_time(
    raw: Option<&str>,
    ttl_ms: i64,
    now_ms: i64,
) -> Result<i64, JobApiError> {
    let Some(raw) = raw else {
        return Ok(0);
    };
    let record = parse_stored_record(raw, "Achievement refresh status")?;
    let timestamp = stored_timestamp(&record).ok_or_else(|| {
        JobApiError::RefreshCooldown(
            "Achievement refresh status cache entry has an invalid timestamp".into(),
        )
    })?;
    Ok(
        (i128::from(ttl_ms) + i128::from(timestamp) - i128::from(now_ms))
            .clamp(0, i128::from(i64::MAX)) as i64,
    )
}

fn parse_cooldown_slot(raw: &str) -> Result<CooldownSlot, JobApiError> {
    let record = parse_stored_record(raw, "Achievement refresh cooldown")?;
    let request_id = record["requestId"].as_str();
    let timestamp = stored_timestamp(&record);
    match (request_id, timestamp) {
        (Some(rid), Some(ts)) if is_valid_nonce(rid) => Ok(CooldownSlot {
            request_id: rid.to_string(),
            timestamp: ts,
        }),
        _ => Err(JobApiError::RefreshCooldown(
            "Achievement refresh cooldown cache entry is invalid".into(),
        )),
    }
}

/// The shared cooldown can be read or reused even when Job API submission is unconfigured.
pub struct ProfileRefreshService {
    pub redis: Arc<dyn RedisBackend>,
    pub jobs: Option<JobApiClient>,
}

#[async_trait]
impl JobSubmitter for ProfileRefreshService {
    async fn submit_achievement_refresh(
        &self,
        account_id: &str,
        request_id: &str,
    ) -> Result<AcceptedJobApiSubmission, JobApiError> {
        let jobs = self
            .jobs
            .as_ref()
            .ok_or_else(|| JobApiError::InvalidConfig("Job API is not configured".into()))?;
        jobs.submit_achievement_refresh(account_id, request_id)
            .await
    }
}

#[async_trait]
impl egdata_core::ports::ProfileRefreshPort for ProfileRefreshService {
    async fn status(
        &self,
        account_id: &str,
    ) -> Result<Option<String>, egdata_core::error::CoreError> {
        self.redis
            .get(&format!("refresh-achievements:{account_id}"))
            .await
            .map_err(|e| egdata_core::error::CoreError::Internal(e.to_string()))
    }
    async fn request(
        &self,
        account_id: &str,
        ttl_ms: i64,
    ) -> Result<(), egdata_core::error::CoreError> {
        request_achievement_refresh(
            account_id,
            ttl_ms,
            self.redis.as_ref(),
            self,
            || Utc::now().timestamp_millis(),
            create_job_api_request_id,
        )
        .await
        .map(|_| ())
        .map_err(|e| egdata_core::error::CoreError::Internal(e.to_string()))
    }
}

/// Requests an achievement refresh with Redis cooldown coordination (`requestAchievementRefresh`).
pub async fn request_achievement_refresh(
    account_id: &str,
    ttl_ms: i64,
    cache: &dyn RedisBackend,
    submitter: &dyn JobSubmitter,
    now_ms: impl Fn() -> i64,
    create_request_id: impl FnOnce() -> String,
) -> Result<AchievementRefreshRequestResult, JobApiError> {
    if !(1..=MAX_SAFE_INTEGER).contains(&ttl_ms) {
        return Err(JobApiError::InvalidInput(
            "Achievement refresh cooldown must be a positive integer".into(),
        ));
    }

    let status_key = format!("refresh-achievements:{account_id}");
    let cooldown_key = format!("refresh-achievements:temporal-cooldown:{account_id}");

    let existing_status = cache
        .get(&status_key)
        .await
        .map_err(|e| JobApiError::RefreshCooldown(e.to_string()))?;
    if achievement_refresh_remaining_time(existing_status.as_deref(), ttl_ms, now_ms())? > 0 {
        return Ok(AchievementRefreshRequestResult {
            metadata: None,
            reused_cooldown: true,
        });
    }

    let proposed = CooldownSlot {
        request_id: create_request_id(),
        timestamp: now_ms(),
    };
    let proposed_json =
        serde_json::to_string(&proposed).expect("cooldown slots contain only JSON scalars");
    cache
        .set_px(&cooldown_key, &proposed_json, ttl_ms as u64, true)
        .await
        .map_err(|e| JobApiError::RefreshCooldown(e.to_string()))?;

    let stored_slot = cache
        .get(&cooldown_key)
        .await
        .map_err(|e| JobApiError::RefreshCooldown(e.to_string()))?
        .ok_or_else(|| {
            JobApiError::RefreshCooldown(
                "Achievement refresh cooldown could not be established".into(),
            )
        })?;
    let slot = parse_cooldown_slot(&stored_slot)?;
    let elapsed_before_submit = now_ms().saturating_sub(slot.timestamp);
    if elapsed_before_submit < 0 || elapsed_before_submit >= ttl_ms {
        return Err(JobApiError::RefreshCooldown(
            "Achievement refresh cooldown expired before submission".into(),
        ));
    }

    let accepted = submitter
        .submit_achievement_refresh(account_id, &slot.request_id)
        .await?;
    let accepted_at_ms = now_ms();
    let accepted_at = DateTime::<Utc>::from_timestamp_millis(accepted_at_ms)
        .map(js_iso_datetime)
        .ok_or_else(|| JobApiError::RefreshCooldown("Invalid time value".into()))?;
    let metadata = TemporalAchievementRefreshMetadata {
        job_id: accepted.job_id,
        workflow_id: accepted.workflow_id,
        status_url: accepted.status_url,
        deduplicated: accepted.deduplicated,
        accepted_at,
        job_type: "achievement-refresh".into(),
        orchestrator: "temporal".into(),
        timestamp: slot.timestamp,
    };
    let remaining_ttl = (i128::from(ttl_ms) + i128::from(slot.timestamp)
        - i128::from(accepted_at_ms))
    .max(1) as u64;
    let metadata_json =
        serde_json::to_string(&metadata).expect("refresh metadata contains only JSON scalars");
    cache
        .set_px(&status_key, &metadata_json, remaining_ttl, false)
        .await
        .map_err(|e| JobApiError::RefreshCooldown(e.to_string()))?;

    Ok(AchievementRefreshRequestResult {
        metadata: Some(metadata),
        reused_cooldown: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    mod node_oracle;
    use crate::redis_store::RedisStoreError;
    use redis::Value as RedisValue;
    use std::collections::HashMap;
    use std::sync::{Mutex, atomic::AtomicU64};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    struct FixedClock {
        now_ms: i64,
        nonce: String,
    }

    impl JobApiClock for FixedClock {
        fn now_ms(&self) -> i64 {
            self.now_ms
        }
        fn nonce(&self) -> String {
            self.nonce.clone()
        }
    }

    #[derive(Default)]
    struct InMemoryCache {
        kv: Mutex<HashMap<String, String>>,
        drop_nx_write: Mutex<bool>,
        calls: Mutex<Vec<Value>>,
        fail_at: Option<usize>,
    }

    impl InMemoryCache {
        fn record(&self, call: Value) -> Result<(), RedisStoreError> {
            let mut calls = self.calls.lock().unwrap();
            calls.push(call);
            if self.fail_at == Some(calls.len() - 1) {
                return Err(RedisStoreError::InvalidConfig("fixture failure".into()));
            }
            Ok(())
        }
    }

    #[async_trait]
    impl RedisBackend for InMemoryCache {
        async fn get(&self, key: &str) -> Result<Option<String>, RedisStoreError> {
            self.record(json!({"method":"get","key":key}))?;
            Ok(self.kv.lock().unwrap().get(key).cloned())
        }
        async fn set_ex(&self, _k: &str, _v: &str, _t: u64) -> Result<bool, RedisStoreError> {
            panic!("unexpected set_ex in achievement refresh")
        }
        async fn set_px(
            &self,
            key: &str,
            value: &str,
            ttl_ms: u64,
            only_if_absent: bool,
        ) -> Result<bool, RedisStoreError> {
            self.record(
                json!({"method":"set","key":key,"raw":value,"ttl":ttl_ms,"nx":only_if_absent}),
            )?;
            if only_if_absent && *self.drop_nx_write.lock().unwrap() {
                return Ok(false);
            }
            let mut kv = self.kv.lock().unwrap();
            if only_if_absent && kv.contains_key(key) {
                return Ok(false);
            }
            kv.insert(key.to_string(), value.to_string());
            Ok(true)
        }
        async fn decr(&self, _k: &str) -> Result<i64, RedisStoreError> {
            panic!("unexpected decr in achievement refresh")
        }
        async fn del(&self, _k: &str) -> Result<usize, RedisStoreError> {
            panic!("unexpected del in achievement refresh")
        }
        async fn pttl(&self, _k: &str) -> Result<i64, RedisStoreError> {
            panic!("unexpected pttl in achievement refresh")
        }
        async fn hgetall(&self, _k: &str) -> Result<HashMap<String, String>, RedisStoreError> {
            panic!("unexpected hgetall in achievement refresh")
        }
        async fn ping(&self) -> Result<bool, RedisStoreError> {
            panic!("unexpected ping in achievement refresh")
        }
        async fn eval_script(
            &self,
            _s: &str,
            _k: &[&str],
            _a: &[&str],
        ) -> Result<RedisValue, RedisStoreError> {
            panic!("unexpected eval_script in achievement refresh")
        }
    }

    async fn spawn_job_server<F>(count: usize, handler: F) -> (String, tokio::task::JoinHandle<()>)
    where
        F: Fn(String, String) -> (u16, String) + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for _ in 0..count {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = node_oracle::request_from_socket(&mut socket).await;
                let (status, body) = handler(
                    request["path"].as_str().unwrap().to_owned(),
                    request["body"].as_str().unwrap().to_owned(),
                );
                let response = format!(
                    "HTTP/1.1 {status} Status\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        (format!("http://{addr}"), server)
    }

    #[test]
    fn config_signing_and_idempotency_validation() {
        let mut env: HashMap<String, String> = HashMap::new();
        assert!(JobApiClientConfig::from_env_lookup(|k| env.get(k).cloned()).is_err());
        env.insert("JOB_API_BASE_URL".into(), "   ".into());
        assert!(JobApiClientConfig::from_env_lookup(|k| env.get(k).cloned()).is_err());
        env.insert("JOB_API_BASE_URL".into(), "not-a-url".into());
        env.insert("JOB_API_KEY_ID".into(), "key-1".into());
        env.insert("JOB_API_SECRET".into(), "a".repeat(32));
        assert!(JobApiClientConfig::from_env_lookup(|k| env.get(k).cloned()).is_err());

        env.insert("JOB_API_BASE_URL".into(), "ftp://jobs.local".into());
        assert!(JobApiClientConfig::from_env_lookup(|k| env.get(k).cloned()).is_err());

        env.insert("JOB_API_BASE_URL".into(), "https://jobs.local/".into());
        env.insert("JOB_API_KEY_ID".into(), "-bad".into());
        assert!(JobApiClientConfig::from_env_lookup(|k| env.get(k).cloned()).is_err());

        env.insert("JOB_API_KEY_ID".into(), "api_key.1".into());
        env.insert("JOB_API_SECRET".into(), "short".into());
        assert!(JobApiClientConfig::from_env_lookup(|k| env.get(k).cloned()).is_err());

        env.insert("JOB_API_SECRET".into(), "s".repeat(32));
        let cfg = JobApiClientConfig::from_env_lookup(|k| env.get(k).cloned()).unwrap();
        assert_eq!(cfg.base_url, "https://jobs.local");

        let sig = create_job_api_signature(&JobApiSigningInput {
            key_id: "api_key.1",
            secret: &cfg.secret,
            timestamp: "1700000000",
            nonce: "nonce_12345678901234",
            method: "post",
            url: "https://jobs.local/v1/jobs/offer-regens?foo=1",
            idempotency_key: Some("idem-1"),
            body: b"{}",
        })
        .unwrap();
        assert_eq!(sig.len(), 64);

        let key = create_job_api_idempotency_key(
            JobApiJobType::OfferRegen,
            "req-1",
            0,
            &json!({"offerId":"1"}),
        )
        .unwrap();
        assert!(key.starts_with("egdata-api:offer-regen:"));
        assert!(is_valid_nonce(&create_job_api_nonce()));
        assert_eq!(create_job_api_request_id().len(), 36);
    }

    #[tokio::test]
    async fn submit_request_retries_validation_and_batch() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempts_clone = attempts.clone();
        let (base, server) = spawn_job_server(16, move |path, body| {
            if path == JobApiJobType::OfferRegen.endpoint() {
                if body.contains("retry-then-ok") {
                    let n = attempts_clone.fetch_add(1, Ordering::Relaxed);
                    if n == 0 {
                        return (503, "busy".into());
                    }
                }
                if body.contains("bad-400") {
                    return (400, "invalid payload".into());
                }
                if body.contains("empty-400") {
                    return (400, String::new());
                }
                if body.contains("bad-202-json") {
                    return (202, "not-json".into());
                }
                if body.contains("bad-202-meta") {
                    return (202, r#"{"jobId":"bad"}"#.into());
                }
                if body.contains("bad-202-arr") {
                    return (202, "[]".into());
                }
                let jid = format!("api-offer-regen-{}", "a".repeat(64));
                return (
                    202,
                    json!({
                        "jobId": jid,
                        "workflowId": jid,
                        "statusUrl": "https://jobs.local/status/1",
                        "deduplicated": false
                    })
                    .to_string(),
                );
            }
            assert_eq!(path, JobApiJobType::ItemRegen.endpoint());
            let jid = format!("api-item-regen-{}", "b".repeat(64));
            (
                202,
                json!({
                    "jobId": jid,
                    "workflowId": jid,
                    "statusUrl": "/status/2",
                    "deduplicated": true
                })
                .to_string(),
            )
        })
        .await;

        let cfg = JobApiClientConfig {
            base_url: base,
            key_id: "key1".into(),
            secret: "s".repeat(32),
        };
        let client = JobApiClient::with_clock(
            cfg.clone(),
            Client::new(),
            Arc::new(FixedClock {
                now_ms: 1_700_000_000_000,
                nonce: "fixed_nonce_123456".into(),
            }),
        );

        let mut fast_opts = JobApiRequestOptions {
            request_id: Some("req-1".into()),
            max_attempts: 2,
            timeout_ms: 2_000,
            backoff_base_ms: 0,
        };
        let accepted = client
            .submit_request(
                JobApiJobType::OfferRegen,
                &json!({"mode":"retry-then-ok"}),
                &fast_opts,
            )
            .await
            .unwrap();
        assert!(!accepted.deduplicated);
        assert_eq!(attempts.load(Ordering::Relaxed), 2);
        fast_opts.backoff_base_ms = 1;
        attempts.store(0, Ordering::Relaxed);
        assert!(
            client
                .submit_request(
                    JobApiJobType::OfferRegen,
                    &json!({"mode":"retry-then-ok"}),
                    &fast_opts
                )
                .await
                .is_ok()
        );

        // Non-retryable 400 fails immediately without retry
        let err_400 = client
            .submit_request(
                JobApiJobType::OfferRegen,
                &json!({"mode":"bad-400"}),
                &fast_opts,
            )
            .await
            .unwrap_err();
        assert!(!err_400.is_retryable());
        assert!(
            client
                .submit_request(
                    JobApiJobType::OfferRegen,
                    &json!({"mode":"empty-400"}),
                    &fast_opts
                )
                .await
                .is_err()
        );

        // Invalid 202 payloads
        for mode in ["bad-202-json", "bad-202-meta", "bad-202-arr"] {
            assert!(
                client
                    .submit_request(JobApiJobType::OfferRegen, &json!({"mode":mode}), &fast_opts)
                    .await
                    .is_err()
            );
        }

        // Option validation errors
        assert!(
            client
                .submit_request(
                    JobApiJobType::OfferRegen,
                    &json!({}),
                    &JobApiRequestOptions {
                        max_attempts: 0,
                        ..fast_opts.clone()
                    }
                )
                .await
                .is_err()
        );
        assert!(
            client
                .submit_request(
                    JobApiJobType::OfferRegen,
                    &json!({}),
                    &JobApiRequestOptions {
                        timeout_ms: 0,
                        ..fast_opts.clone()
                    }
                )
                .await
                .is_err()
        );
        // Bad nonce clock
        let bad_nonce_client = JobApiClient::with_clock(
            cfg.clone(),
            Client::new(),
            Arc::new(FixedClock {
                now_ms: 1000,
                nonce: "short".into(),
            }),
        );
        assert!(
            bad_nonce_client
                .submit_request(JobApiJobType::OfferRegen, &json!({}), &fast_opts)
                .await
                .is_err()
        );

        // Batch success + empty + failure
        let empty = client
            .submit_batch(
                JobApiJobType::ItemRegen,
                &[],
                &JobApiBatchOptions::default(),
            )
            .await
            .unwrap();
        assert!(empty.is_empty());

        let batch = client
            .submit_batch(
                JobApiJobType::ItemRegen,
                &[json!({"id":"1"}), json!({"id":"2"})],
                &JobApiBatchOptions {
                    concurrency: 2,
                    request_options: fast_opts.clone(),
                },
            )
            .await
            .unwrap();
        assert_eq!(batch.len(), 2);

        let bad_batch = client
            .submit_batch(
                JobApiJobType::OfferRegen,
                &[json!({"id":"ok"}), json!({"mode":"bad-400"})],
                &JobApiBatchOptions {
                    concurrency: 2,
                    request_options: fast_opts,
                },
            )
            .await
            .unwrap_err();
        assert_eq!(
            bad_batch.to_string(),
            "1 of 2 job submissions were not durably accepted"
        );
        assert!(
            client
                .submit_batch(
                    JobApiJobType::OfferRegen,
                    &[],
                    &JobApiBatchOptions {
                        concurrency: 0,
                        request_options: JobApiRequestOptions::default(),
                    }
                )
                .await
                .is_err()
        );

        server.await.unwrap();
        // Transport error
        let dead = JobApiClient::new(cfg);
        assert!(
            dead.submit_request(
                JobApiJobType::AchievementRefresh,
                &json!({"accountId":"a"}),
                &JobApiRequestOptions {
                    max_attempts: 1,
                    timeout_ms: 100,
                    backoff_base_ms: 0,
                    request_id: None,
                }
            )
            .await
            .is_err()
        );
    }

    #[tokio::test]
    async fn achievement_refresh_cooldown_flow() {
        let (base, server) = spawn_job_server(1, |_, _| {
            let jid = format!("api-achievement-refresh-{}", "d".repeat(64));
            (
                202,
                json!({
                    "jobId": jid,
                    "workflowId": jid,
                    "statusUrl": "/status/ach",
                    "deduplicated": false
                })
                .to_string(),
            )
        })
        .await;

        let submitter = JobApiClient::new(JobApiClientConfig {
            base_url: base,
            key_id: "key1".into(),
            secret: "s".repeat(32),
        });
        let cache = InMemoryCache::default();

        assert!(
            request_achievement_refresh(
                "acc1",
                0,
                &cache,
                &submitter,
                || 1_000,
                create_job_api_request_id
            )
            .await
            .is_err()
        );

        let now = Arc::new(AtomicU64::new(10_000));
        let now_fn = || now.load(Ordering::Relaxed) as i64;
        let res = request_achievement_refresh("acc1", 60_000, &cache, &submitter, now_fn, || {
            "valid_request_id_123456".into()
        })
        .await
        .unwrap();
        assert!(!res.reused_cooldown);
        server.await.unwrap();
        assert!(res.metadata.is_some());

        // Subsequent request reuses cooldown
        now.store(20_000, Ordering::Relaxed);
        let reused = request_achievement_refresh(
            "acc1",
            60_000,
            &cache,
            &submitter,
            now_fn,
            create_job_api_request_id,
        )
        .await
        .unwrap();
        assert!(reused.reused_cooldown);
        assert!(reused.metadata.is_none());

        // Drop NX write -> error
        *cache.drop_nx_write.lock().unwrap() = true;
        assert!(
            request_achievement_refresh("acc2", 60_000, &cache, &submitter, now_fn, || {
                "valid_request_id_123456".into()
            },)
            .await
            .is_err()
        );
        *cache.drop_nx_write.lock().unwrap() = false;

        // Invalid stored slot / status parsing
        assert!(achievement_refresh_remaining_time(Some("{"), 1000, 100).is_err());
        assert!(achievement_refresh_remaining_time(Some("[]"), 1000, 100).is_err());
        assert!(achievement_refresh_remaining_time(Some("{}"), 1000, 100).is_err());
        assert!(achievement_refresh_remaining_time(Some("{\"timestamp\":0}"), 1000, 100).is_err());
        assert!(parse_cooldown_slot("{").is_err());
        assert!(parse_cooldown_slot("[]").is_err());
        assert!(parse_cooldown_slot("{\"requestId\":\"bad\"}").is_err());

        // Expired cooldown before submit
        let tick = Arc::new(AtomicU64::new(0));
        let tick_c = tick.clone();
        assert!(
            request_achievement_refresh(
                "acc3",
                100,
                &cache,
                &submitter,
                move || {
                    let step = tick_c.fetch_add(1, Ordering::Relaxed);
                    if step <= 1 { 1_000 } else { 2_000 }
                },
                || "valid_request_id_123456".into(),
            )
            .await
            .is_err()
        );
    }
}
