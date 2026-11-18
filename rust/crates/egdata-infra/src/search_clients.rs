//! Meilisearch, OpenSearch, and Cloudflare Vectorize HTTP clients (`src/clients/meilisearch.ts`, `opensearch.ts`, `vectorize.ts`).

use std::time::Duration;

use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use bytes::Bytes;
use egdata_core::v1::{
    query::trim_js_whitespace,
    serialization::{js_string, node_json},
};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use reqwest::{Client, Method, header};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json, value::RawValue};
use thiserror::Error;
use url::Url;

pub const DEFAULT_MEILISEARCH_HOST: &str = "http://localhost:7700";
pub const CLOUDFLARE_API_BASE: &str = "https://api.cloudflare.com/client/v4";
pub const DEFAULT_VECTORIZE_INDEX: &str = "egdata-offers";
pub const EMBEDDING_MODEL: &str = "@cf/baai/bge-base-en-v1.5";
pub const CLOUDFLARE_REQUEST_TIMEOUT_MS: u64 = 15_000;

/// Shared error type for Meilisearch, OpenSearch, and Cloudflare Vectorize clients.
#[derive(Debug, Error)]
pub enum SearchClientError {
    #[error("{0}")]
    Configuration(String),
    #[error("{0}")]
    VectorizeConfiguration(String),
    #[error("{0}")]
    UnexpectedResponse(String),
    #[error("{message}")]
    CloudflareVectorize {
        message: String,
        status: Option<u16>,
    },
    #[error("{service} HTTP {status}: {body}")]
    HttpStatus {
        service: &'static str,
        status: u16,
        body: String,
    },
    #[error("Meilisearch requests cannot include credentials in the URL")]
    MeilisearchUrlCredentials,
    #[error("Invalid Meilisearch API key header")]
    MeilisearchHeader,
    #[error("http request error: {0}")]
    Transport(#[from] reqwest::Error),
    #[error("json decode error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid compressed OpenSearch response: {0}")]
    Compression(std::io::Error),
}

fn normalize_env_value(value: Option<String>) -> Option<String> {
    value
        .map(|v| trim_js_whitespace(&v).to_string())
        .filter(|v| !v.is_empty())
}

/// Meilisearch configuration (`src/clients/meilisearch.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeilisearchConfig {
    pub host: String,
    pub api_key: String,
}

impl MeilisearchConfig {
    pub fn from_env_lookup<F>(mut get_env: F) -> Self
    where
        F: FnMut(&str) -> Option<String>,
    {
        let host = get_env("MEILISEARCH_INSTANCE")
            .filter(|host| !host.is_empty())
            .unwrap_or_else(|| DEFAULT_MEILISEARCH_HOST.to_owned());
        let host = if host.starts_with("http://") || host.starts_with("https://") {
            host
        } else {
            format!("http://{host}")
        };
        let api_key = get_env("MEILISEARCH_API_KEY").unwrap_or_default();
        Self { host, api_key }
    }
}

/// HTTP client for Meilisearch (`src/clients/meilisearch.ts`).
#[derive(Clone)]
pub struct MeilisearchClient {
    base: Result<Url, &'static str>,
    auth: Result<Option<header::HeaderValue>, ()>,
    http: Client,
}

impl MeilisearchClient {
    pub fn new(config: MeilisearchConfig) -> Self {
        Self::with_client(config, Client::new())
    }

    pub fn with_client(config: MeilisearchConfig, http: Client) -> Self {
        let mut host = config.host;
        if !host.ends_with('/') {
            host.push('/');
        }
        let base = Url::parse(&host).map_err(|_| "The provided host is not valid");
        let auth = if config.api_key.is_empty() {
            Ok(None)
        } else {
            // Fetch Headers uses a Web IDL ByteString and trims HTTP whitespace.
            let value = format!("Bearer {}", config.api_key);
            let octets: Result<Vec<_>, _> = value
                .trim_end_matches([' ', '\t', '\r', '\n'])
                .chars()
                .map(|ch| u8::try_from(ch as u32))
                .collect();
            octets.map_err(|_| ()).and_then(|bytes| {
                header::HeaderValue::from_bytes(&bytes)
                    .map(Some)
                    .map_err(|_| ())
            })
        };
        Self { base, auth, http }
    }

    pub async fn search(&self, index: &str, body: &Value) -> Result<Value, SearchClientError> {
        self.post_json(&format!("indexes/{index}/search"), body)
            .await
    }

    pub async fn multi_search(&self, body: &Value) -> Result<Value, SearchClientError> {
        self.post_json("multi-search", body).await
    }

    async fn post_json(&self, path: &str, body: &Value) -> Result<Value, SearchClientError> {
        let base = self
            .base
            .as_ref()
            .map_err(|message| SearchClientError::Configuration((*message).into()))?;
        let auth = self
            .auth
            .as_ref()
            .map_err(|_| SearchClientError::MeilisearchHeader)?;
        let url = base.join(path).map_err(|_| {
            SearchClientError::Configuration("The provided host is not valid".into())
        })?;
        // The Fetch API rejects URL userinfo before sending any request.
        if !url.username().is_empty() || url.password().is_some() {
            return Err(SearchClientError::MeilisearchUrlCredentials);
        }
        let mut req = self
            .http
            .post(url)
            .header(header::CONTENT_TYPE, "application/json")
            .body(node_json(body));
        if let Some(auth) = auth {
            req = req.header(header::AUTHORIZATION, auth);
        }
        let resp = req.send().await?;
        let status = resp.status();
        let bytes = resp.bytes().await?;
        let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes);
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            parse_response_json(bytes)?
        };
        if !status.is_success() {
            return Err(SearchClientError::HttpStatus {
                service: "Meilisearch",
                status: status.as_u16(),
                body: String::from_utf8_lossy(bytes).into_owned(),
            });
        }
        Ok(value)
    }
}

/// OpenSearch configuration (`src/clients/opensearch.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenSearchConfig {
    pub node: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

impl OpenSearchConfig {
    /// Validates `OPENSEARCH_URL`, `OPENSEARCH_USERNAME`, and `OPENSEARCH_PASSWORD` identically to `src/clients/opensearch.ts`.
    pub fn from_env_lookup<F>(mut get_env: F) -> Result<Self, SearchClientError>
    where
        F: FnMut(&str) -> Option<String>,
    {
        let raw_node = get_env("OPENSEARCH_URL");
        let node = normalize_env_value(raw_node).ok_or_else(|| {
            SearchClientError::Configuration(
                "OPENSEARCH_URL is required for OpenSearch-backed routes.".into(),
            )
        })?;

        let parsed = Url::parse(&node)
            .map_err(|_| SearchClientError::Configuration("Invalid URL".into()))?;
        let node_includes_auth =
            !parsed.username().is_empty() && parsed.password().is_some_and(|p| !p.is_empty());

        let raw_user = get_env("OPENSEARCH_USERNAME");
        let raw_pass = get_env("OPENSEARCH_PASSWORD");
        let username = normalize_env_value(raw_user.clone());
        let password = normalize_env_value(raw_pass.clone());

        let has_blank_separate_credentials = (raw_user.is_some() && username.is_none())
            || (raw_pass.is_some() && password.is_none());

        if !node_includes_auth && has_blank_separate_credentials {
            return Err(SearchClientError::Configuration(
                "OPENSEARCH_USERNAME and OPENSEARCH_PASSWORD cannot be blank when configured."
                    .into(),
            ));
        }

        if username.is_some() != password.is_some() {
            return Err(SearchClientError::Configuration(
                "OPENSEARCH_USERNAME and OPENSEARCH_PASSWORD must be set together.".into(),
            ));
        }

        let config = Self {
            node,
            username,
            password,
        };
        config.connection()?;
        Ok(config)
    }

    fn connection(&self) -> Result<(Url, Option<String>), SearchClientError> {
        let mut endpoint = Url::parse(&self.node)
            .map_err(|_| SearchClientError::Configuration("Invalid URL".into()))?;
        if !matches!(endpoint.scheme(), "http" | "https") {
            return Err(SearchClientError::Configuration(format!(
                "Invalid protocol: '{}:'",
                endpoint.scheme()
            )));
        }
        let user = decode_credential(endpoint.username())?;
        let pass = decode_credential(endpoint.password().unwrap_or(""))?;
        let auth = if !user.is_empty() && !pass.is_empty() {
            Some(format!(
                "Basic {}",
                BASE64_STANDARD.encode(format!("{user}:{pass}"))
            ))
        } else {
            self.basic_auth_header()
        };
        // The Node client passes exactly one header and never sends partial URL credentials.
        let _ = endpoint.set_username("");
        let _ = endpoint.set_password(None);
        endpoint.set_fragment(None);
        Ok((endpoint, auth))
    }

    pub fn basic_auth_header(&self) -> Option<String> {
        match (&self.username, &self.password) {
            (Some(u), Some(p)) => {
                let encoded = BASE64_STANDARD.encode(format!("{u}:{p}"));
                Some(format!("Basic {encoded}"))
            }
            _ => None,
        }
    }
}

/// Trait for OpenSearch index mapping operations (used by `catalog_mongo::ensure_v1_search_mappings`).
#[async_trait]
pub trait OpenSearchMappingClient: Send + Sync {
    async fn get_mapping(&self, index: &str) -> Result<Option<Value>, SearchClientError>;
    async fn put_mapping(&self, index: &str, properties: &Value) -> Result<(), SearchClientError>;
}

/// HTTP client for OpenSearch (`src/clients/opensearch.ts`).
#[derive(Clone)]
pub struct OpenSearchClient {
    connection: Result<(Url, Option<String>), String>,
    http: Client,
}

fn decode_credential(raw: &str) -> Result<std::borrow::Cow<'_, str>, SearchClientError> {
    let malformed = || SearchClientError::Configuration("URI malformed".into());
    for (at, _) in raw.match_indices('%') {
        if !raw
            .as_bytes()
            .get(at + 1..at + 3)
            .is_some_and(|pair| pair.iter().all(u8::is_ascii_hexdigit))
        {
            return Err(malformed());
        }
    }
    percent_decode_str(raw)
        .decode_utf8()
        .map_err(|_| malformed())
}

fn parse_response_json(bytes: &[u8]) -> Result<Value, serde_json::Error> {
    // The SDK decodes malformed UTF-8 with replacement, then JSON.parse uses
    // IEEE-754 even for integer tokens. Preserve ordinary integers for Rust callers.
    fn round_numbers(value: &mut Value) {
        match value {
            Value::Array(items) => items.iter_mut().for_each(round_numbers),
            Value::Object(fields) => fields.values_mut().for_each(round_numbers),
            Value::Number(n)
                if !n.is_f64() && n.as_f64().is_some_and(|x| x.abs() >= (1_u64 << 53) as f64) =>
            {
                let rounded = ryu_js::Buffer::new()
                    .format(n.as_f64().unwrap())
                    .parse()
                    .expect("finite JSON number");
                *n = rounded;
            }
            _ => {}
        }
    }
    let mut value = serde_json::from_str(&String::from_utf8_lossy(bytes))?;
    round_numbers(&mut value);
    Ok(value)
}

impl OpenSearchClient {
    pub fn new(config: OpenSearchConfig) -> Self {
        let http = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            // The OpenSearch SDK accepts unsolicited gzip/deflate, leaves other
            // encodings untouched, and retries aborted wire reads before decoding.
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .no_zstd()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("valid OpenSearch HTTP client");
        Self::with_client(config, http)
    }

    pub fn with_client(config: OpenSearchConfig, http: Client) -> Self {
        Self {
            connection: config.connection().map_err(|e| e.to_string()),
            http,
        }
    }

    pub async fn search(
        &self,
        index: Option<&str>,
        body: &Value,
    ) -> Result<Value, SearchClientError> {
        self.send_json(Method::POST, index, "_search", Some(node_json(body)))
            .await
    }

    async fn send_json(
        &self,
        method: Method,
        index: Option<&str>,
        operation: &str,
        body: Option<String>,
    ) -> Result<Value, SearchClientError> {
        let (endpoint, auth) = self
            .connection
            .as_ref()
            .map_err(|e| SearchClientError::Configuration(e.clone()))?;
        let mut url = endpoint.clone();
        let mut path = url.path().to_owned();
        if !path.ends_with('/') {
            path.push('/');
        }
        if let Some(index) = index.filter(|s| !s.is_empty()) {
            path.push_str(&percent_encode_segment(index));
            path.push('/');
        }
        path.push_str(operation);
        url.set_path(&path);
        let body = body.map(Bytes::from);
        let mut retries = 3;
        loop {
            let mut req = self.http.request(method.clone(), url.clone());
            if let Some(auth) = auth {
                req = req.header(header::AUTHORIZATION, auth);
            }
            if let Some(body) = &body {
                req = req
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(body.clone());
            }
            let resp = match req.send().await {
                Err(err) if retries > 0 && !err.is_builder() => {
                    retries -= 1;
                    continue;
                }
                other => other?,
            };
            let status = resp.status();
            let is_json = resp
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|h| h.to_str().ok())
                .is_some_and(|ty| {
                    ty.contains("application/json")
                        || ty.contains("application/vnd.opensearch+json")
                });
            let compressed = resp
                .headers()
                .get(header::CONTENT_ENCODING)
                .and_then(|h| h.to_str().ok())
                .is_some_and(|h| {
                    let encoding = h.to_ascii_lowercase();
                    encoding.contains("gzip") || encoding.contains("deflate")
                });
            let bytes = match resp.bytes().await {
                Err(_) if retries > 0 => {
                    retries -= 1;
                    continue;
                }
                result => result?,
            };
            let bytes = if compressed {
                tokio::task::spawn_blocking(move || {
                    use std::io::Read;
                    let mut output = Vec::new();
                    if bytes.starts_with(&[0x1f, 0x8b]) {
                        flate2::read::MultiGzDecoder::new(bytes.as_ref())
                            .read_to_end(&mut output)?;
                    } else {
                        flate2::read::ZlibDecoder::new(bytes.as_ref()).read_to_end(&mut output)?;
                    }
                    Ok::<_, std::io::Error>(Bytes::from(output))
                })
                .await
                .map_err(std::io::Error::other)
                .and_then(std::convert::identity)
                .map_err(SearchClientError::Compression)?
            } else {
                bytes
            };
            let value = if is_json && !bytes.is_empty() {
                parse_response_json(bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes))?
            } else {
                Value::String(String::from_utf8_lossy(&bytes).into_owned())
            };
            if retries > 0 && matches!(status.as_u16(), 502..=504) {
                retries -= 1;
                continue;
            }
            if status.as_u16() >= 400 {
                return Err(SearchClientError::HttpStatus {
                    service: "OpenSearch",
                    status: status.as_u16(),
                    body: String::from_utf8_lossy(&bytes).into_owned(),
                });
            }
            return Ok(value);
        }
    }
}

#[async_trait]
impl OpenSearchMappingClient for OpenSearchClient {
    async fn get_mapping(&self, index: &str) -> Result<Option<Value>, SearchClientError> {
        match self
            .send_json(Method::GET, Some(index), "_mapping", None)
            .await
        {
            Ok(mut body) => Ok(body
                .get_mut(index)
                .and_then(|v| v.get_mut("mappings"))
                .filter(|v| !v.is_null())
                .map(Value::take)),
            Err(SearchClientError::HttpStatus { status: 404, .. }) => Ok(None),
            Err(err) => Err(err),
        }
    }
    async fn put_mapping(&self, index: &str, properties: &Value) -> Result<(), SearchClientError> {
        let payload = format!(r#"{{"properties":{}}}"#, node_json(properties));
        self.send_json(Method::POST, Some(index), "_mapping", Some(payload))
            .await?;
        Ok(())
    }
}

/// Cloudflare Vectorize configuration (`src/clients/vectorize.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VectorizeConfig {
    pub account_id: String,
    pub api_token: String,
    pub index_name: String,
    pub api_base: String,
    pub timeout_ms: u64,
}

impl VectorizeConfig {
    pub fn from_env_lookup<F>(mut get_env: F) -> Result<Self, SearchClientError>
    where
        F: FnMut(&str) -> Option<String>,
    {
        let account_id = normalize_env_value(get_env("CLOUDFLARE_ACCOUNT_ID"));
        let api_token = normalize_env_value(get_env("CLOUDFLARE_API_TOKEN"));
        let index_name = normalize_env_value(get_env("VECTORIZE_INDEX_NAME"))
            .unwrap_or_else(|| DEFAULT_VECTORIZE_INDEX.to_string());

        let (Some(account_id), Some(api_token)) = (account_id, api_token) else {
            return Err(SearchClientError::VectorizeConfiguration(
                "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required for natural-language search.".into(),
            ));
        };

        Ok(Self {
            account_id,
            api_token,
            index_name,
            api_base: CLOUDFLARE_API_BASE.to_string(),
            timeout_ms: CLOUDFLARE_REQUEST_TIMEOUT_MS,
        })
    }
}

// JSON.parse keeps the last value of a repeated key. Borrow the original values
// so selecting a property does not materialize a potentially large embedding.
type RawObject<'a> = std::collections::BTreeMap<String, &'a RawValue>;

fn null_property(field: &str) -> SearchClientError {
    SearchClientError::UnexpectedResponse(format!(
        "Cannot read properties of null (reading '{field}')"
    ))
}

fn raw_property<'a>(input: &'a str, key: &str) -> Option<&'a RawValue> {
    serde_json::from_str::<RawObject>(input).ok()?.remove(key)
}

/// Vectorize search hit (`src/clients/vectorize.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VectorizeOfferMatch {
    pub id: String,
    pub score: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Map<String, Value>>,
}

#[derive(Deserialize)]
struct VectorizeQueryResult<'a> {
    #[serde(borrow)]
    matches: Option<Vec<&'a RawValue>>,
}

fn describe_cloudflare_errors(errors: Option<&RawValue>) -> Result<String, SearchClientError> {
    let Some(raw) = errors.filter(|value| value.get() != "null") else {
        return Ok(String::new());
    };
    let values = serde_json::from_str::<Vec<Value>>(raw.get()).map_err(|_| {
        SearchClientError::UnexpectedResponse("errors?.map is not a function".into())
    })?;
    let mut description = String::new();
    for item in values {
        if item.is_null() {
            return Err(SearchClientError::UnexpectedResponse(
                "Cannot destructure property 'code' of 'object null' as it is null.".into(),
            ));
        }
        let parts = ["code", "message"]
            .into_iter()
            .filter_map(|key| item.get(key))
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    js_string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(": ");
        if !parts.is_empty() {
            if !description.is_empty() {
                description.push_str(", ");
            }
            description.push_str(&parts);
        }
    }
    Ok(description)
}

/// Cloudflare Workers AI + Vectorize v2 client (`src/clients/vectorize.ts`).
#[derive(Clone)]
pub struct VectorizeClient {
    config: VectorizeConfig,
    http: Client,
}

impl VectorizeClient {
    pub fn new(config: VectorizeConfig) -> Result<Self, SearchClientError> {
        Client::builder()
            .timeout(Duration::from_millis(config.timeout_ms))
            .build()
            .map(|http| Self::with_client(config, http))
            .map_err(SearchClientError::Transport)
    }

    pub fn with_client(config: VectorizeConfig, http: Client) -> Self {
        Self { config, http }
    }

    async fn request_cloudflare<T>(
        &self,
        url: &str,
        body: String,
        operation: &str,
        decode: impl FnOnce(&RawValue) -> Result<T, SearchClientError>,
    ) -> Result<T, SearchClientError> {
        let resp = self
            .http
            .post(url)
            .bearer_auth(&self.config.api_token)
            .header(header::CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
            .map_err(|_| SearchClientError::CloudflareVectorize {
                message: format!("{operation} request failed."),
                status: None,
            })?;
        let status = resp.status();
        let invalid = || SearchClientError::CloudflareVectorize {
            message: format!("{operation} returned an invalid response."),
            status: Some(status.as_u16()),
        };
        let bytes = resp.bytes().await.map_err(|_| invalid())?;
        let text = String::from_utf8_lossy(bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes));
        // Borrow the result from the network buffer. Error payloads and surplus embedding rows
        // can have a different shape and must not invalidate a successful operation.
        let payload: RawObject = if text.trim_start().starts_with('{') {
            serde_json::from_str(&text).map_err(|_| invalid())?
        } else {
            let scalar = serde_json::from_str::<&RawValue>(&text).map_err(|_| invalid())?;
            if scalar.get() == "null" {
                return Err(null_property(if status.is_success() {
                    "success"
                } else {
                    "errors"
                }));
            }
            RawObject::new()
        };
        if status.is_success()
            && payload.get("success").is_none_or(|v| v.get() != "false")
            && let Some(result) = payload.get("result")
        {
            return decode(result);
        }
        let details = describe_cloudflare_errors(payload.get("errors").copied())?;
        let suffix = if details.is_empty() {
            ".".to_owned()
        } else {
            format!(": {details}")
        };
        Err(SearchClientError::CloudflareVectorize {
            message: format!("{operation} failed{suffix}"),
            status: Some(status.as_u16()),
        })
    }

    pub async fn generate_embedding(&self, query: &str) -> Result<Vec<f64>, SearchClientError> {
        let url = format!(
            "{}/accounts/{}/ai/run/{EMBEDDING_MODEL}",
            self.config.api_base.trim_end_matches('/'),
            percent_encode_segment(&self.config.account_id)
        );
        self.request_cloudflare(
            &url,
            node_json(&json!({"text":query})),
            "Workers AI embedding generation",
            |raw| {
                let invalid = || SearchClientError::CloudflareVectorize {
                    message: "Workers AI embedding generation returned an invalid embedding."
                        .into(),
                    status: None,
                };
                if raw.get() == "null" {
                    return Err(null_property("data"));
                }
                let data = raw_property(raw.get(), "data").ok_or_else(invalid)?.get();
                let not_an_array = || {
                    SearchClientError::UnexpectedResponse("embedding.some is not a function".into())
                };
                // Node reads only data[0]. The HTTP envelope already validated the entire
                // JSON document, so the common array path can borrow just its first value.
                let first: &RawValue = if let Some(elements) = data.strip_prefix('[') {
                    Deserialize::deserialize(&mut serde_json::Deserializer::from_str(elements))
                        .map_err(|_| invalid())?
                } else if data.starts_with('{') {
                    raw_property(data, "0").ok_or_else(invalid)?
                } else if data.starts_with('"') && data != "\"\"" {
                    return Err(not_an_array());
                } else {
                    return Err(invalid());
                };
                let first = first.get();
                if !first.starts_with('[') {
                    let empty = match first {
                        "null" | "false" | "\"\"" => true,
                        object if object.starts_with('{') => raw_property(object, "length")
                            .is_some_and(|length| length.get().parse::<f64>() == Ok(0.0)),
                        scalar => scalar.parse::<f64>() == Ok(0.0),
                    };
                    return Err(if empty { invalid() } else { not_an_array() });
                }
                serde_json::from_str::<Vec<f64>>(first)
                    .ok()
                    .filter(|v| !v.is_empty())
                    .ok_or_else(invalid)
            },
        )
        .await
    }

    pub async fn query_vectorize(
        &self,
        vector: &[f64],
        top_k: usize,
    ) -> Result<Vec<VectorizeOfferMatch>, SearchClientError> {
        let url = format!(
            "{}/accounts/{}/vectorize/v2/indexes/{}/query",
            self.config.api_base.trim_end_matches('/'),
            percent_encode_segment(&self.config.account_id),
            percent_encode_segment(&self.config.index_name)
        );
        let mut body = String::from(r#"{"vector":["#);
        let mut number = ryu_js::Buffer::new();
        for (index, value) in vector.iter().enumerate() {
            if index != 0 {
                body.push(',');
            }
            body.push_str(if value.is_finite() {
                number.format(*value)
            } else {
                "null"
            });
        }
        use std::fmt::Write;
        write!(
            body,
            r#"],"topK":{top_k},"returnMetadata":"all","returnValues":false}}"#
        )
        .unwrap();
        self.request_cloudflare(&url, body, "Vectorize offer query", |raw| {
            if raw.get() == "null" {
                return Err(null_property("matches"));
            }
            if !raw.get().starts_with('{') {
                return Ok(Vec::new());
            }
            let result = serde_json::from_str::<VectorizeQueryResult>(raw.get()).map_err(|_| {
                SearchClientError::UnexpectedResponse(
                    "(result.matches ?? []).filter is not a function".into(),
                )
            })?;
            let mut matches = Vec::new();
            for row in result.matches.unwrap_or_default() {
                if row.get() == "null" {
                    return Err(null_property("id"));
                }
                if let Ok(hit) = serde_json::from_str::<VectorizeOfferMatch>(row.get())
                    && !hit.id.is_empty()
                {
                    matches.push(hit);
                }
            }
            Ok(matches)
        })
        .await
    }

    pub async fn query_offers_with_natural_language(
        &self,
        query: &str,
        top_k: usize,
    ) -> Result<Vec<VectorizeOfferMatch>, SearchClientError> {
        let embedding = self.generate_embedding(query).await?;
        self.query_vectorize(&embedding, top_k).await
    }
}

fn percent_encode_segment(input: &str) -> std::borrow::Cow<'_, str> {
    const COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'!')
        .remove(b'~')
        .remove(b'*')
        .remove(b'\'')
        .remove(b'(')
        .remove(b')');
    utf8_percent_encode(input, COMPONENT).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;

    async fn spawn_http_server<F>(
        expected_requests: usize,
        handler: F,
    ) -> (String, tokio::task::JoinHandle<()>)
    where
        F: Fn(&str, &str, &str, &str) -> (u16, String) + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for _ in 0..expected_requests {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut reader = BufReader::new(&mut socket);
                let mut first = String::new();
                reader.read_line(&mut first).await.unwrap();
                let mut parts = first.split_whitespace();
                let method = parts.next().unwrap();
                let path = parts.next().unwrap();
                let mut headers = String::new();
                loop {
                    let count = reader.read_line(&mut headers).await.unwrap();
                    assert_ne!(count, 0, "incomplete HTTP request");
                    if count == 2 {
                        break;
                    }
                }
                let len = headers
                    .lines()
                    .filter_map(|line| line.split_once(':'))
                    .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                    .map_or(0, |(_, value)| value.trim().parse().unwrap());
                let mut body = vec![0; len];
                reader.read_exact(&mut body).await.unwrap();
                let (status, body) =
                    handler(method, path, std::str::from_utf8(&body).unwrap(), &headers);
                let reply = format!(
                    "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(reply.as_bytes()).await.unwrap();
            }
        });
        (format!("http://{addr}"), server)
    }

    #[tokio::test]
    async fn opensearch_url_auth_is_decoded_and_takes_precedence() {
        let (base, server) = spawn_http_server(1, |method, path, body, headers| {
            assert_eq!((method, path), ("POST", "/offers/_search"));
            let auth: Vec<_> = headers
                .lines()
                .filter_map(|line| line.split_once(':'))
                .filter(|(key, _)| key.eq_ignore_ascii_case("authorization"))
                .map(|(_, value)| value.trim())
                .collect();
            assert_eq!(auth, ["Basic dXJsIHVzZXI6dXJsOnBhc3M="]);
            assert_eq!(body, r#"{"query":{"term":{"offerId":"offer-1"}}}"#);
            (200, r#"{"hits":[]}"#.into())
        })
        .await;
        let url = base.replacen("http://", "http://url%20user:url%3Apass@", 1);
        let mut env: HashMap<String, String> = HashMap::new();
        env.insert("OPENSEARCH_URL".into(), url);
        env.insert("OPENSEARCH_USERNAME".into(), "explicit".into());
        env.insert("OPENSEARCH_PASSWORD".into(), "credentials".into());
        let config = OpenSearchConfig::from_env_lookup(|key| env.get(key).cloned()).unwrap();
        let client = OpenSearchClient::new(config);
        let body = json!({"query":{"term":{"offerId":"offer-1"}}});
        client.search(Some("offers"), &body).await.unwrap();

        server.await.unwrap();
    }

    #[test]
    fn config_validation_matches_ts_behavior() {
        let empty: HashMap<String, String> = HashMap::new();
        let meili = MeilisearchConfig::from_env_lookup(|k| empty.get(k).cloned());
        assert_eq!(meili.host, DEFAULT_MEILISEARCH_HOST);
        assert_eq!(meili.api_key, "");

        assert!(OpenSearchConfig::from_env_lookup(|k| empty.get(k).cloned()).is_err());

        let mut invalid_url: HashMap<String, String> = HashMap::new();
        invalid_url.insert("OPENSEARCH_URL".into(), "not a URL".into());
        assert!(matches!(
            OpenSearchConfig::from_env_lookup(|k| invalid_url.get(k).cloned()),
            Err(SearchClientError::Configuration(message)) if message == "Invalid URL"
        ));

        let mut env: HashMap<String, String> = HashMap::new();
        env.insert("OPENSEARCH_URL".into(), "https://search.example.com".into());
        env.insert("OPENSEARCH_USERNAME".into(), "   ".into());
        assert!(OpenSearchConfig::from_env_lookup(|k| env.get(k).cloned()).is_err());

        env.remove("OPENSEARCH_USERNAME");
        env.insert("OPENSEARCH_PASSWORD".into(), "pw".into());
        assert!(OpenSearchConfig::from_env_lookup(|k| env.get(k).cloned()).is_err());

        env.insert("OPENSEARCH_USERNAME".into(), "user".into());
        let os_cfg = OpenSearchConfig::from_env_lookup(|k| env.get(k).cloned()).unwrap();
        assert_eq!(
            os_cfg.basic_auth_header().as_deref(),
            Some("Basic dXNlcjpwdw==")
        );

        // URL-embedded credentials allow blank separate vars without failing
        let mut url_auth: HashMap<String, String> = HashMap::new();
        url_auth.insert(
            "OPENSEARCH_URL".into(),
            "https://u:p@search.example.com/".into(),
        );
        url_auth.insert("OPENSEARCH_USERNAME".into(), "".into());
        let os_url_cfg = OpenSearchConfig::from_env_lookup(|k| url_auth.get(k).cloned()).unwrap();
        assert!(os_url_cfg.basic_auth_header().is_none());

        assert_eq!(
            VectorizeConfig::from_env_lookup(|k| empty.get(k).cloned())
                .unwrap_err()
                .to_string(),
            "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required for natural-language search."
        );
        let mut vec_env: HashMap<String, String> = HashMap::new();
        vec_env.insert("CLOUDFLARE_ACCOUNT_ID".into(), "acc_1".into());
        vec_env.insert("CLOUDFLARE_API_TOKEN".into(), "tok_1".into());
        let vec_cfg = VectorizeConfig::from_env_lookup(|k| vec_env.get(k).cloned()).unwrap();
        assert_eq!(vec_cfg.index_name, DEFAULT_VECTORIZE_INDEX);
        assert_eq!(vec_cfg.timeout_ms, 15_000);
    }

    #[tokio::test]
    async fn meilisearch_and_opensearch_clients() {
        let (base, server) = spawn_http_server(10, |method, path, _body, _headers| {
            if path == "/indexes/offers/search" && method == "POST" {
                (200, r#"{"hits":[{"id":"o1"}]}"#.into())
            } else if path == "/multi-search" && method == "POST" {
                (200, r#"{"results":[]}"#.into())
            } else if path == "/indexes/bad/search" {
                (500, r#"{"message":"boom"}"#.into())
            } else if path == "/egdata.offers/_search" && method == "POST" {
                (200, r#"{"hits":{"total":{"value":1}}}"#.into())
            } else if path == "/_search" && method == "POST" {
                (400, "bad".into())
            } else if path == "/egdata.offers/_mapping" && method == "GET" {
                (
                    200,
                    r#"{"egdata.offers":{"mappings":{"properties":{"title":{"type":"text"}}}}}"#
                        .into(),
                )
            } else if path == "/missing/_mapping" && method == "GET" {
                (404, r#"{"error":"not found"}"#.into())
            } else if path == "/err/_mapping" && method == "GET" {
                (500, "err".into())
            } else if path == "/egdata.offers/_mapping" && method == "POST" {
                (200, r#"{"acknowledged":true}"#.into())
            } else {
                (400, "bad put".into())
            }
        })
        .await;

        let meili = MeilisearchClient::new(MeilisearchConfig {
            host: base.clone(),
            api_key: "key".into(),
        });
        let hits = meili.search("offers", &json!({"q":"alan"})).await.unwrap();
        assert_eq!(hits["hits"][0]["id"], "o1");
        assert!(meili.multi_search(&json!({"queries":[]})).await.is_ok());
        assert!(matches!(
            meili.search("bad", &json!({})).await,
            Err(SearchClientError::HttpStatus {
                service: "Meilisearch",
                status: 500,
                ..
            })
        ));

        let os = OpenSearchClient::new(OpenSearchConfig {
            node: base,
            username: Some("u".into()),
            password: Some("p".into()),
        });
        let os_res = os.search(Some("egdata.offers"), &json!({})).await.unwrap();
        assert_eq!(os_res["hits"]["total"]["value"], 1);
        assert!(os.search(None, &json!({})).await.is_err());

        assert!(os.get_mapping("egdata.offers").await.unwrap().is_some());
        assert!(os.get_mapping("missing").await.unwrap().is_none());
        assert!(os.get_mapping("err").await.is_err());
        os.put_mapping("egdata.offers", &json!({"a":{"type":"keyword"}}))
            .await
            .unwrap();
        assert!(os.put_mapping("bad", &json!({})).await.is_err());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn vector_query_serializes_nonfinite_values_like_json_stringify() {
        let (base, server) = spawn_http_server(1, |method, _, body, _| {
            assert_eq!(method, "POST");
            let body: Value = serde_json::from_str(body).unwrap();
            assert_eq!(body["vector"], json!([null, null, null, 0.25]));
            (200, r#"{"result":{"matches":[]}}"#.into())
        })
        .await;
        let client = VectorizeClient::new(VectorizeConfig {
            api_base: base,
            account_id: "account".into(),
            api_token: "fixture".into(),
            index_name: "offers".into(),
            timeout_ms: 5000,
        })
        .unwrap();
        assert!(
            client
                .query_vectorize(&[f64::INFINITY, f64::NAN, f64::NEG_INFINITY, 0.25], 1)
                .await
                .unwrap()
                .is_empty()
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn vectorize_client_success_and_error_paths() {
        let (base, server) = spawn_http_server(6, |_method, path, _body, _| {
            if path.contains("/ai/run/") {
                (200, r#"{"success":true,"result":{"data":[[0.1,0.2,0.3]]}}"#.into())
            } else if path.contains("/indexes/egdata-offers/query") {
                (
                    200,
                    r#"{"success":true,"result":{"matches":[{"id":"o1","score":0.95,"metadata":{"title":"G1"}},{"id":"","score":0.5}]}}"#.into(),
                )
            } else if path.contains("/indexes/invalid-json/query") {
                (200, "not-json".into())
            } else if path.contains("/indexes/cf-error/query") {
                (400, r#"{"success":false,"errors":[{"code":1001,"message":"bad vector"}]}"#.into())
            } else if path.contains("/indexes/empty-err/query") {
                (502, r#"{"success":false,"errors":[{}]}"#.into())
            } else {
                assert!(path.contains("/indexes/no-err/query"));
                (500, r#"{"success":false}"#.into())
            }
        })
        .await;

        let cfg = VectorizeConfig {
            account_id: "acc".into(),
            api_token: "tok".into(),
            index_name: "egdata-offers".into(),
            api_base: base.clone(),
            timeout_ms: 5_000,
        };
        let client = VectorizeClient::new(cfg.clone()).unwrap();
        let matches = client
            .query_offers_with_natural_language("cozy game", 5)
            .await
            .unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].id, "o1");
        assert_eq!(matches[0].score, 0.95);

        let bad_json = VectorizeClient::new(VectorizeConfig {
            index_name: "invalid-json".into(),
            ..cfg.clone()
        })
        .unwrap();
        assert_eq!(
            bad_json
                .query_vectorize(&[0.1], 3)
                .await
                .unwrap_err()
                .to_string(),
            "Vectorize offer query returned an invalid response."
        );

        let cf_err = VectorizeClient::new(VectorizeConfig {
            index_name: "cf-error".into(),
            ..cfg.clone()
        })
        .unwrap();
        let err = cf_err.query_vectorize(&[0.1], 3).await.unwrap_err();
        assert!(err.to_string().contains("1001: bad vector"));

        let empty_err = VectorizeClient::new(VectorizeConfig {
            index_name: "empty-err".into(),
            ..cfg.clone()
        })
        .unwrap();
        assert!(
            empty_err
                .query_vectorize(&[0.1], 3)
                .await
                .unwrap_err()
                .to_string()
                .ends_with("failed.")
        );

        let no_err = VectorizeClient::new(VectorizeConfig {
            index_name: "no-err".into(),
            ..cfg.clone()
        })
        .unwrap();
        assert!(
            no_err
                .query_vectorize(&[0.1], 3)
                .await
                .unwrap_err()
                .to_string()
                .ends_with("failed.")
        );

        server.await.unwrap();
        let (empty_embed_base, empty_server) = spawn_http_server(1, |_, _, _, _| {
            (200, r#"{"success":true,"result":{"data":[[]]}}"#.into())
        })
        .await;
        let bad_embed = VectorizeClient::with_client(
            VectorizeConfig {
                api_base: empty_embed_base.clone(),
                ..cfg.clone()
            },
            Client::new(),
        );
        assert_eq!(
            bad_embed
                .generate_embedding("hi")
                .await
                .unwrap_err()
                .to_string(),
            "Workers AI embedding generation returned an invalid embedding."
        );
        empty_server.await.unwrap();

        // The fixture has finished and closed its listener.
        let dead = VectorizeClient::new(VectorizeConfig {
            api_base: empty_embed_base,
            ..cfg
        })
        .unwrap();
        assert_eq!(
            dead.generate_embedding("hi").await.unwrap_err().to_string(),
            "Workers AI embedding generation request failed."
        );
    }
}
