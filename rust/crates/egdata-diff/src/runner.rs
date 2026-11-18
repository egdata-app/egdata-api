//! Differential test runner, fixture loader, OpenAPI GET extractor, and CLI support.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, bail};
use clap::Parser;
use futures::stream::{self, StreamExt};
use serde_json::Value;
use url::{Url, form_urlencoded};

use crate::diff::{
    DEFAULT_COMPARED_HEADERS, DEFAULT_IGNORED_JSON_KEYS, DiffCase, DiffMismatch, RecordedResponse,
    compare_responses, extract_compared_headers,
};

/// Configuration for executing differential HTTP comparisons between Node and Rust origins.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffRunnerConfig {
    pub node_base_url: String,
    pub rust_base_url: String,
    pub worker_token: Option<String>,
    pub key_id: Option<String>,
    pub key_tier: Option<String>,
    pub origin_token: Option<String>,
    pub concurrency: usize,
    pub compared_headers: Vec<String>,
    pub ignored_json_keys: Vec<String>,
}

impl Default for DiffRunnerConfig {
    fn default() -> Self {
        Self {
            node_base_url: "http://127.0.0.1:4000".to_string(),
            rust_base_url: "http://127.0.0.1:4001".to_string(),
            worker_token: None,
            key_id: None,
            key_tier: None,
            origin_token: None,
            concurrency: 8,
            compared_headers: DEFAULT_COMPARED_HEADERS
                .iter()
                .map(|s| (*s).to_string())
                .collect(),
            ignored_json_keys: DEFAULT_IGNORED_JSON_KEYS
                .iter()
                .map(|s| (*s).to_string())
                .collect(),
        }
    }
}

/// Aggregated result of running a suite of [`DiffCase`] entries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffReport {
    pub total: usize,
    pub passed: usize,
    pub failed: usize,
    pub mismatches: Vec<DiffMismatch>,
}

/// CLI arguments for the `egdata-diff` binary.
#[derive(Debug, Clone, Parser, PartialEq, Eq)]
#[command(
    name = "egdata-diff",
    about = "Differential oracle comparing Node (:4000) and Rust (:4001) HTTP origins"
)]
pub struct CliArgs {
    #[arg(long = "node-url", default_value = "http://127.0.0.1:4000")]
    pub node_url: String,

    #[arg(long = "rust-url", default_value = "http://127.0.0.1:4001")]
    pub rust_url: String,

    #[arg(long = "fixtures")]
    pub fixtures: Vec<PathBuf>,

    #[arg(long = "openapi")]
    pub openapi: Vec<PathBuf>,

    #[arg(long = "worker-token")]
    pub worker_token: Option<String>,

    #[arg(long = "key-id")]
    pub key_id: Option<String>,

    #[arg(long = "key-tier")]
    pub key_tier: Option<String>,

    #[arg(long = "origin-token")]
    pub origin_token: Option<String>,

    #[arg(long = "concurrency", default_value_t = 8)]
    pub concurrency: usize,

    #[arg(long = "sample-param", value_name = "KEY=VALUE")]
    pub sample_params: Vec<String>,

    #[arg(long = "include-og", default_value_t = false)]
    pub include_og: bool,
}

/// Loads differential test cases from a JSON file containing either `[...]` or `{"cases": [...]}`.
pub fn load_cases_from_file(path: impl AsRef<Path>) -> anyhow::Result<Vec<DiffCase>> {
    load_cases_from_file_inner(path.as_ref())
}

fn load_cases_from_file_inner(path_ref: &Path) -> anyhow::Result<Vec<DiffCase>> {
    let raw = fs::read_to_string(path_ref)
        .with_context(|| format!("failed to read fixture file {}", path_ref.display()))?;
    let value: Value = serde_json::from_str(&raw).with_context(|| {
        format!(
            "failed to parse JSON in fixture file {}",
            path_ref.display()
        )
    })?;

    match value {
        Value::Array(_) => serde_json::from_value::<Vec<DiffCase>>(value).with_context(|| {
            format!(
                "failed to deserialize DiffCase array from {}",
                path_ref.display()
            )
        }),
        Value::Object(mut obj) => {
            let cases_val = obj.remove("cases").ok_or_else(|| {
                anyhow::anyhow!(
                    "fixture object in {} must contain a 'cases' array",
                    path_ref.display()
                )
            })?;
            serde_json::from_value::<Vec<DiffCase>>(cases_val).with_context(|| {
                format!(
                    "failed to deserialize 'cases' array from {}",
                    path_ref.display()
                )
            })
        }
        _ => bail!(
            "fixture file {} must contain a JSON array or an object with a 'cases' array",
            path_ref.display()
        ),
    }
}

/// Returns `true` when an OpenAPI path represents a binary `/og` or `/og.*` image endpoint.
pub fn is_og_endpoint(path: &str) -> bool {
    path.split('/')
        .any(|segment| segment == "og" || segment.starts_with("og."))
}

/// Extracts parameterless or `sample_params`-substitutable GET operations from an OpenAPI 3.0 JSON file.
///
/// Binary `/og` and `/og.*` image endpoints are skipped by default; use
/// [`load_get_cases_from_openapi_with_options`] to include and mark them.
pub fn load_get_cases_from_openapi(
    openapi_json_path: impl AsRef<Path>,
    sample_params: &BTreeMap<String, String>,
) -> anyhow::Result<Vec<DiffCase>> {
    load_get_cases_from_openapi_inner(openapi_json_path.as_ref(), sample_params, true)
}

/// Extracts GET operations from an OpenAPI 3.0 JSON file with configurable `/og*` skipping.
pub fn load_get_cases_from_openapi_with_options(
    openapi_json_path: impl AsRef<Path>,
    sample_params: &BTreeMap<String, String>,
    skip_og: bool,
) -> anyhow::Result<Vec<DiffCase>> {
    load_get_cases_from_openapi_inner(openapi_json_path.as_ref(), sample_params, skip_og)
}

fn load_get_cases_from_openapi_inner(
    path_ref: &Path,
    sample_params: &BTreeMap<String, String>,
    skip_og: bool,
) -> anyhow::Result<Vec<DiffCase>> {
    let raw = fs::read_to_string(path_ref)
        .with_context(|| format!("failed to read OpenAPI spec {}", path_ref.display()))?;
    let doc: Value = serde_json::from_str(&raw)
        .with_context(|| format!("failed to parse OpenAPI JSON {}", path_ref.display()))?;

    let paths = doc.get("paths").and_then(Value::as_object).ok_or_else(|| {
        anyhow::anyhow!(
            "OpenAPI spec {} is missing 'paths' object",
            path_ref.display()
        )
    })?;

    let mut cases = Vec::new();
    for (raw_path, path_item) in paths {
        let Some(get_op) = path_item.get("get").and_then(Value::as_object) else {
            continue;
        };

        let is_og = is_og_endpoint(raw_path);
        if skip_og && is_og {
            continue;
        }

        let Some(mut resolved_path) = substitute_path_params(raw_path, sample_params) else {
            continue;
        };

        let Some(query_pairs) =
            resolve_required_query_params(&doc, path_item, get_op, sample_params)
        else {
            continue;
        };

        if !query_pairs.is_empty() {
            let mut serializer = form_urlencoded::Serializer::new(String::new());
            for (k, v) in query_pairs {
                serializer.append_pair(&k, &v);
            }
            resolved_path.push('?');
            resolved_path.push_str(&serializer.finish());
        }

        let base_name = get_op
            .get("operationId")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("GET {resolved_path}"));
        let name = if is_og {
            format!("{base_name} [og]")
        } else {
            base_name
        };

        cases.push(DiffCase {
            name,
            method: "GET".to_string(),
            path: resolved_path,
            headers: BTreeMap::new(),
            body: None,
        });
    }

    cases.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(cases)
}

fn substitute_path_params(
    raw_path: &str,
    sample_params: &BTreeMap<String, String>,
) -> Option<String> {
    let mut out = String::with_capacity(raw_path.len());
    let mut rest = raw_path;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after_brace = &rest[start + 1..];
        let end = after_brace.find('}')?;
        let param_name = &after_brace[..end];
        let value = sample_params.get(param_name)?;
        out.push_str(value);
        rest = &after_brace[end + 1..];
    }
    out.push_str(rest);
    Some(out)
}

fn resolve_parameter<'a>(doc: &'a Value, param: &'a Value) -> &'a Value {
    if let Some(ref_path) = param.get("$ref").and_then(Value::as_str)
        && let Some(pointer) = ref_path.strip_prefix('#')
        && let Some(target) = doc.pointer(pointer)
    {
        return target;
    }
    param
}

fn resolve_required_query_params(
    doc: &Value,
    path_item: &Value,
    get_op: &serde_json::Map<String, Value>,
    sample_params: &BTreeMap<String, String>,
) -> Option<Vec<(String, String)>> {
    let mut query_pairs = Vec::new();
    let path_params = path_item.get("parameters").and_then(Value::as_array);
    let op_params = get_op.get("parameters").and_then(Value::as_array);

    for param_list in [path_params, op_params].into_iter().flatten() {
        for raw_param in param_list {
            let param = resolve_parameter(doc, raw_param);
            let is_query = param.get("in").and_then(Value::as_str) == Some("query");
            let is_required = param.get("required").and_then(Value::as_bool) == Some(true);
            if !is_query || !is_required {
                continue;
            }
            let name = param.get("name").and_then(Value::as_str)?;
            let val = sample_params.get(name)?;
            query_pairs.push((name.to_string(), val.clone()));
        }
    }

    Some(query_pairs)
}

fn build_request_url(base_url: &str, path: &str) -> anyhow::Result<Url> {
    let base = base_url.trim_end_matches('/');
    let suffix = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    let combined = format!("{base}{suffix}");
    Url::parse(&combined).with_context(|| format!("invalid target URL '{combined}'"))
}

async fn send_request(
    client: &reqwest::Client,
    base_url: &str,
    cfg: &DiffRunnerConfig,
    case: &DiffCase,
    compared_header_refs: &[&str],
) -> anyhow::Result<RecordedResponse> {
    let url = build_request_url(base_url, &case.path)?;
    let method_upper = case.method.to_ascii_uppercase();
    let method = reqwest::Method::from_bytes(method_upper.as_bytes())
        .with_context(|| format!("invalid HTTP method '{}'", case.method))?;

    let mut req = client.request(method, url);
    if let Some(token) = &cfg.worker_token {
        req = req.header("x-egdata-worker-token", token);
    }
    if let Some(key_id) = &cfg.key_id {
        req = req.header("x-egdata-key-id", key_id);
    }
    if let Some(key_tier) = &cfg.key_tier {
        req = req.header("x-egdata-key-tier", key_tier);
    }
    if let Some(origin_token) = &cfg.origin_token {
        req = req.header("x-egdata-origin-token", origin_token);
    }
    for (k, v) in &case.headers {
        req = req.header(k.as_str(), v.as_str());
    }
    if let Some(body) = &case.body {
        req = req.json(body);
    }

    let response = req
        .send()
        .await
        .with_context(|| format!("request failed for {} {}", case.method, case.path))?;
    let status = response.status().as_u16();
    let headers = extract_compared_headers(response.headers(), compared_header_refs);
    let body = response
        .bytes()
        .await
        .with_context(|| format!("failed reading response body for {}", case.path))?
        .to_vec();

    Ok(RecordedResponse {
        status,
        headers,
        body,
    })
}

/// Executes a single [`DiffCase`] concurrently against Node and Rust origins and compares responses.
pub async fn execute_case(
    client: &reqwest::Client,
    cfg: &DiffRunnerConfig,
    case: &DiffCase,
) -> anyhow::Result<Vec<DiffMismatch>> {
    let compared_refs: Vec<&str> = cfg.compared_headers.iter().map(String::as_str).collect();
    let ignored_refs: Vec<&str> = cfg.ignored_json_keys.iter().map(String::as_str).collect();

    let (node_res, rust_res) = tokio::join!(
        send_request(client, &cfg.node_base_url, cfg, case, &compared_refs),
        send_request(client, &cfg.rust_base_url, cfg, case, &compared_refs),
    );

    let mut node = node_res?;
    let mut rust = rust_res?;
    let path = case.path.split('?').next().unwrap_or_default();
    if case.method.eq_ignore_ascii_case("GET") {
        for response in [&mut node, &mut rust] {
            crate::diff::normalize_timed_response(path, response);
        }
    }

    Ok(compare_responses(
        &case.name,
        &node,
        &rust,
        &compared_refs,
        &ignored_refs,
    ))
}

/// Executes a suite of [`DiffCase`] entries with bounded concurrency and aggregates a [`DiffReport`].
pub async fn run_suite(
    client: &reqwest::Client,
    cfg: &DiffRunnerConfig,
    cases: &[DiffCase],
) -> DiffReport {
    let concurrency = cfg.concurrency.max(1);
    let mut indexed_results: Vec<(usize, Vec<DiffMismatch>)> =
        stream::iter(cases.iter().enumerate())
            .map(|(idx, case)| async move {
                let mismatches = match execute_case(client, cfg, case).await {
                    Ok(m) => m,
                    Err(err) => vec![DiffMismatch {
                        case_name: case.name.clone(),
                        category: "request_error".to_string(),
                        detail: format!("{err:#}"),
                    }],
                };
                (idx, mismatches)
            })
            .buffer_unordered(concurrency)
            .collect()
            .await;

    indexed_results.sort_by_key(|(idx, _)| *idx);

    let mut passed = 0;
    let mut failed = 0;
    let mut mismatches = Vec::new();
    for (_, case_mismatches) in indexed_results {
        if case_mismatches.is_empty() {
            passed += 1;
        } else {
            failed += 1;
            mismatches.extend(case_mismatches);
        }
    }

    DiffReport {
        total: cases.len(),
        passed,
        failed,
        mismatches,
    }
}

/// Formats a [`DiffReport`] into a human-readable summary string.
pub fn format_report(report: &DiffReport) -> String {
    let mut lines = vec![format!(
        "Summary: {}/{} passed, {} failed ({} mismatches)",
        report.passed,
        report.total,
        report.failed,
        report.mismatches.len()
    )];
    for m in &report.mismatches {
        lines.push(format!("- [{}] {}: {}", m.case_name, m.category, m.detail));
    }
    lines.join("\n")
}

/// Parses `KEY=VALUE` sample parameter flags into a [`BTreeMap`].
pub fn parse_sample_params(entries: &[String]) -> anyhow::Result<BTreeMap<String, String>> {
    let mut map = BTreeMap::new();
    for entry in entries {
        let Some((key, value)) = entry.split_once('=') else {
            bail!("invalid --sample-param '{entry}'; expected KEY=VALUE");
        };
        if key.is_empty() {
            bail!("invalid --sample-param '{entry}'; key must not be empty");
        }
        map.insert(key.to_string(), value.to_string());
    }
    Ok(map)
}

/// Builds a [`DiffRunnerConfig`] from parsed [`CliArgs`].
pub fn config_from_cli(args: &CliArgs) -> DiffRunnerConfig {
    DiffRunnerConfig {
        node_base_url: args.node_url.clone(),
        rust_base_url: args.rust_url.clone(),
        worker_token: args.worker_token.clone(),
        key_id: args.key_id.clone(),
        key_tier: args.key_tier.clone(),
        origin_token: args.origin_token.clone(),
        concurrency: args.concurrency,
        ..DiffRunnerConfig::default()
    }
}

/// Parses CLI arguments and executes the differential suite.
pub async fn run_cli_from_args<I, T>(args: I) -> anyhow::Result<DiffReport>
where
    I: IntoIterator<Item = T>,
    T: Into<OsString>,
{
    let collected: Vec<OsString> = args.into_iter().map(Into::into).collect();
    run_cli_from_os_args(collected).await
}

async fn run_cli_from_os_args(args: Vec<OsString>) -> anyhow::Result<DiffReport> {
    let parsed = CliArgs::try_parse_from(args)?;
    run_cli(&parsed).await
}

/// Executes the differential suite for pre-parsed [`CliArgs`].
pub async fn run_cli(args: &CliArgs) -> anyhow::Result<DiffReport> {
    let sample_params = parse_sample_params(&args.sample_params)?;
    let mut cases = Vec::new();
    for fixture_path in &args.fixtures {
        cases.extend(load_cases_from_file(fixture_path)?);
    }
    for openapi_path in &args.openapi {
        cases.extend(load_get_cases_from_openapi_with_options(
            openapi_path,
            &sample_params,
            !args.include_og,
        )?);
    }
    if cases.is_empty() {
        bail!("no diff cases loaded; provide --fixtures and/or --openapi");
    }

    let cfg = config_from_cli(args);
    let client = reqwest::Client::new();
    Ok(run_suite(&client, &cfg, &cases).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;

    fn temp_file_path(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("egdata_diff_{name}_{nanos}.json"))
    }

    #[derive(Clone)]
    struct MockRouteResponse {
        status: u16,
        content_type: String,
        content_length_override: Option<usize>,
        extra_headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    struct MockServer {
        base_url: String,
        shutdown: oneshot::Sender<()>,
        handle: tokio::task::JoinHandle<()>,
    }

    impl MockServer {
        async fn stop(self) {
            let _ = self.shutdown.send(());
            let _ = self.handle.await;
        }
    }

    type MockHandler = Arc<dyn Fn(&str, &str, &str) -> MockRouteResponse + Send + Sync>;

    async fn start_mock_server<F>(handler: F) -> MockServer
    where
        F: Fn(&str, &str, &str) -> MockRouteResponse + Send + Sync + 'static,
    {
        start_mock_server_inner(Arc::new(handler)).await
    }

    async fn start_mock_server_inner(handler: MockHandler) -> MockServer {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind ephemeral port");
        let addr = listener.local_addr().expect("local addr");
        let (tx, mut rx) = oneshot::channel::<()>();

        let handle = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut rx => break,
                    accepted = listener.accept() => {
                        let (mut socket, _) = accepted.expect("accept connection");
                        let handler = Arc::clone(&handler);
                        tokio::spawn(async move {
                            let mut buf = vec![0u8; 8192];
                            let n = socket.read(&mut buf).await.unwrap_or(0);
                            let req_text = String::from_utf8_lossy(&buf[..n]);
                            let first_line = req_text.lines().next().unwrap_or("");
                            let mut parts = first_line.split_whitespace();
                            let method = parts.next().unwrap_or("GET");
                            let path = parts.next().unwrap_or("/");
                            let resp = handler(method, path, &req_text);

                            let content_len = resp.content_length_override.unwrap_or(resp.body.len());
                            let mut header_block = format!(
                                "HTTP/1.1 {} OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n",
                                resp.status,
                                resp.content_type,
                                content_len
                            );
                            for (k, v) in resp.extra_headers {
                                header_block.push_str(&format!("{k}: {v}\r\n"));
                            }
                            header_block.push_str("\r\n");

                            let _ = socket.write_all(header_block.as_bytes()).await;
                            let _ = socket.write_all(&resp.body).await;
                            let _ = socket.shutdown().await;
                        });
                    }
                }
            }
        });

        MockServer {
            base_url: format!("http://{addr}"),
            shutdown: tx,
            handle,
        }
    }

    #[test]
    fn loads_cases_from_array_and_wrapped_object_and_rejects_invalid() {
        let array_path = temp_file_path("cases_array");
        fs::write(
            &array_path,
            r#"[{"name":"health","method":"GET","path":"/health"}]"#,
        )
        .unwrap();
        let loaded = load_cases_from_file(&array_path).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "health");
        let _ = fs::remove_file(&array_path);

        let wrapped_path = temp_file_path("cases_wrapped");
        fs::write(
            &wrapped_path,
            r#"{"cases":[{"name":"countries","method":"GET","path":"/countries"}]}"#,
        )
        .unwrap();
        let loaded_wrapped = load_cases_from_file(&wrapped_path).unwrap();
        assert_eq!(loaded_wrapped.len(), 1);
        assert_eq!(loaded_wrapped[0].path, "/countries");
        let _ = fs::remove_file(&wrapped_path);

        let bad_array_elem_path = temp_file_path("bad_array_elem");
        fs::write(&bad_array_elem_path, r#"[123]"#).unwrap();
        assert!(load_cases_from_file(&bad_array_elem_path).is_err());
        let _ = fs::remove_file(&bad_array_elem_path);

        let bad_wrapped_elem_path = temp_file_path("bad_wrapped_elem");
        fs::write(&bad_wrapped_elem_path, r#"{"cases":[123]}"#).unwrap();
        assert!(load_cases_from_file(&bad_wrapped_elem_path).is_err());
        let _ = fs::remove_file(&bad_wrapped_elem_path);

        let bad_obj_path = temp_file_path("bad_obj");
        fs::write(&bad_obj_path, r#"{"other":[]}"#).unwrap();
        assert!(load_cases_from_file(&bad_obj_path).is_err());
        let _ = fs::remove_file(&bad_obj_path);

        let bad_scalar_path = temp_file_path("bad_scalar");
        fs::write(&bad_scalar_path, r#"123"#).unwrap();
        assert!(load_cases_from_file(&bad_scalar_path).is_err());
        let _ = fs::remove_file(&bad_scalar_path);

        let bad_json_path = temp_file_path("bad_json");
        fs::write(&bad_json_path, r#"{not-json"#).unwrap();
        assert!(load_cases_from_file(&bad_json_path).is_err());
        let _ = fs::remove_file(&bad_json_path);

        assert!(load_cases_from_file(temp_file_path("missing_file")).is_err());
    }

    #[test]
    fn extracts_openapi_get_cases_with_params_refs_and_og_handling() {
        let spec_path = temp_file_path("openapi_spec");
        let spec = serde_json::json!({
            "openapi": "3.0.3",
            "components": {
                "parameters": {
                    "OfferId": {
                        "name": "id",
                        "in": "path",
                        "required": true,
                        "schema": { "type": "string" }
                    },
                    "ReqQuery": {
                        "name": "q",
                        "in": "query",
                        "required": true,
                        "schema": { "type": "string" }
                    }
                }
            },
            "paths": {
                "/v1/health": {
                    "get": { "operationId": "getHealth" }
                },
                "/v1/post-only": {
                    "post": { "operationId": "createThing" }
                },
                "/v1/offers/{id}": {
                    "parameters": [{ "$ref": "#/components/parameters/OfferId" }],
                    "get": { "operationId": "getOffer" }
                },
                "/v1/offers/{id}/og": {
                    "get": { "operationId": "getOfferOg" }
                },
                "/v1/free-games/og.webp": {
                    "get": {}
                },
                "/v1/missing/{unknown}": {
                    "get": { "operationId": "getMissing" }
                },
                "/v1/broken/{unclosed": {
                    "get": { "operationId": "getBroken" }
                },
                "/v1/search": {
                    "get": {
                        "operationId": "search",
                        "parameters": [
                            { "$ref": "#/components/parameters/ReqQuery" },
                            { "name": "limit", "in": "query", "required": false }
                        ]
                    }
                },
                "/v1/unnamed-no-params": {
                    "get": {}
                },
                "/v1/missing-req-query": {
                    "get": {
                        "parameters": [
                            { "name": "missingQuery", "in": "query", "required": true }
                        ]
                    }
                },
                "/v1/unnamed-req-query": {
                    "get": {
                        "parameters": [
                            { "in": "query", "required": true }
                        ]
                    }
                }
            }
        });
        fs::write(&spec_path, serde_json::to_string(&spec).unwrap()).unwrap();

        let sample_params = BTreeMap::from([
            ("id".to_string(), "offer-123".to_string()),
            ("q".to_string(), "epic games".to_string()),
        ]);

        // Default skips /og*
        let default_cases = load_get_cases_from_openapi(&spec_path, &sample_params).unwrap();
        let paths: Vec<&str> = default_cases.iter().map(|c| c.path.as_str()).collect();
        assert_eq!(
            paths,
            vec![
                "/v1/health",
                "/v1/offers/offer-123",
                "/v1/search?q=epic+games",
                "/v1/unnamed-no-params"
            ]
        );
        assert_eq!(default_cases[0].name, "getHealth");
        assert_eq!(default_cases[3].name, "GET /v1/unnamed-no-params");

        // With skip_og = false, /og* endpoints are included and marked [og]
        let all_cases =
            load_get_cases_from_openapi_with_options(&spec_path, &sample_params, false).unwrap();
        let og_cases: Vec<(&str, &str)> = all_cases
            .iter()
            .filter(|c| c.name.contains("[og]"))
            .map(|c| (c.name.as_str(), c.path.as_str()))
            .collect();
        assert_eq!(
            og_cases,
            vec![
                ("GET /v1/free-games/og.webp [og]", "/v1/free-games/og.webp"),
                ("getOfferOg [og]", "/v1/offers/offer-123/og"),
            ]
        );

        let _ = fs::remove_file(&spec_path);

        let no_paths_spec = temp_file_path("openapi_no_paths");
        fs::write(&no_paths_spec, r#"{"openapi":"3.0.3"}"#).unwrap();
        assert!(load_get_cases_from_openapi(&no_paths_spec, &sample_params).is_err());
        let _ = fs::remove_file(&no_paths_spec);

        let invalid_json_spec = temp_file_path("openapi_bad_json");
        fs::write(&invalid_json_spec, r#"{bad"#).unwrap();
        assert!(load_get_cases_from_openapi(&invalid_json_spec, &sample_params).is_err());
        let _ = fs::remove_file(&invalid_json_spec);

        assert!(
            load_get_cases_from_openapi(temp_file_path("missing_spec"), &sample_params).is_err()
        );
    }

    #[test]
    fn extracts_cases_from_repo_openapi_specs() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let params = BTreeMap::from([
            (
                "id".to_string(),
                "620b1dc8a8b54cfda56ffbae32946f70".to_string(),
            ),
            ("sandboxId".to_string(), "SeaQA".to_string()),
            ("query".to_string(), "SeaQA".to_string()),
            ("from".to_string(), "2024-01-01".to_string()),
            ("to".to_string(), "2024-12-31".to_string()),
        ]);

        let v1_cases =
            load_get_cases_from_openapi(root.join("openapi/egdata.v1.openapi.json"), &params)
                .unwrap();
        assert!(v1_cases.iter().any(|c| c.path == "/v1/health"));
        assert!(
            v1_cases
                .iter()
                .any(|c| c.path == "/v1/offers/620b1dc8a8b54cfda56ffbae32946f70")
        );
        assert!(v1_cases.iter().any(|c| c.path == "/v1/sandboxes/SeaQA"));
        assert!(
            v1_cases
                .iter()
                .any(|c| c.path == "/v1/autocomplete?query=SeaQA")
        );
        assert!(!v1_cases.iter().any(|c| is_og_endpoint(&c.path)));

        let legacy_cases =
            load_get_cases_from_openapi(root.join("openapi/egdata.openapi.json"), &params).unwrap();
        assert!(legacy_cases.iter().any(|c| c.path == "/health"));
        assert!(
            legacy_cases
                .iter()
                .any(|c| c.path == "/offers/620b1dc8a8b54cfda56ffbae32946f70")
        );
        assert!(legacy_cases.iter().any(|c| c.path == "/sandboxes/SeaQA"));
        assert!(!legacy_cases.iter().any(|c| is_og_endpoint(&c.path)));
    }

    #[tokio::test]
    async fn executes_concurrent_cases_and_formats_report() {
        let in_flight = Arc::new(AtomicUsize::new(0));
        let max_in_flight = Arc::new(AtomicUsize::new(0));

        let in_flight_clone = Arc::clone(&in_flight);
        let max_clone = Arc::clone(&max_in_flight);
        let node_server = start_mock_server(move |method, path, req_text| {
            let current = in_flight_clone.fetch_add(1, Ordering::SeqCst) + 1;
            max_clone.fetch_max(current, Ordering::SeqCst);

            let lower = req_text.to_ascii_lowercase();
            assert!(lower.contains("x-egdata-worker-token: wt-1"));
            assert!(lower.contains("x-egdata-key-id: key_1234"));
            assert!(lower.contains("x-egdata-key-tier: pro"));
            assert!(lower.contains("x-egdata-origin-token: ot-1"));

            let resp = match (method, path) {
                ("GET", "/v1/health") => MockRouteResponse {
                    status: 200,
                    content_type: "application/json".to_string(),
                    content_length_override: None,
                    extra_headers: vec![("etag".into(), "\"v1\"".into())],
                    body: br#"{"ok":true,"requestId":"node-req-1"}"#.to_vec(),
                },
                ("GET", "/v1/truncated") => MockRouteResponse {
                    status: 200,
                    content_type: "application/json".to_string(),
                    content_length_override: Some(100),
                    extra_headers: vec![],
                    body: b"short".to_vec(),
                },
                ("POST", "/echo") => MockRouteResponse {
                    status: 200,
                    content_type: "application/json".to_string(),
                    content_length_override: None,
                    extra_headers: vec![],
                    body: br#"{"echo":true}"#.to_vec(),
                },
                _ => MockRouteResponse {
                    status: 200,
                    content_type: "application/json".to_string(),
                    content_length_override: None,
                    extra_headers: vec![],
                    body: br#"{"value":"node"}"#.to_vec(),
                },
            };
            in_flight_clone.fetch_sub(1, Ordering::SeqCst);
            resp
        })
        .await;

        let rust_server = start_mock_server(|method, path, _| match (method, path) {
            ("GET", "/v1/health") => MockRouteResponse {
                status: 200,
                content_type: "application/json".to_string(),
                content_length_override: None,
                extra_headers: vec![("etag".into(), "\"v1\"".into())],
                body: br#"{"ok":true,"requestId":"rust-req-2"}"#.to_vec(),
            },
            ("POST", "/echo") => MockRouteResponse {
                status: 200,
                content_type: "application/json".to_string(),
                content_length_override: None,
                extra_headers: vec![],
                body: br#"{"echo":true}"#.to_vec(),
            },
            _ => MockRouteResponse {
                status: 500,
                content_type: "application/json".to_string(),
                content_length_override: None,
                extra_headers: vec![],
                body: br#"{"value":"rust"}"#.to_vec(),
            },
        })
        .await;

        let cfg = DiffRunnerConfig {
            node_base_url: node_server.base_url.clone(),
            rust_base_url: rust_server.base_url.clone(),
            worker_token: Some("wt-1".to_string()),
            key_id: Some("key_1234".to_string()),
            key_tier: Some("pro".to_string()),
            origin_token: Some("ot-1".to_string()),
            concurrency: 2,
            ..DiffRunnerConfig::default()
        };

        let cases = vec![
            DiffCase {
                name: "health".to_string(),
                method: "GET".to_string(),
                path: "/v1/health".to_string(),
                headers: BTreeMap::from([("x-custom".to_string(), "1".to_string())]),
                body: None,
            },
            DiffCase {
                name: "echo-post".to_string(),
                method: "post".to_string(),
                path: "echo".to_string(),
                headers: BTreeMap::new(),
                body: Some(serde_json::json!({"hello": "world"})),
            },
            DiffCase {
                name: "mismatch-case".to_string(),
                method: "GET".to_string(),
                path: "/v1/diff".to_string(),
                headers: BTreeMap::new(),
                body: None,
            },
        ];

        let client = reqwest::Client::new();
        let single_ok = execute_case(&client, &cfg, &cases[0]).await.unwrap();
        assert!(single_ok.is_empty());

        // Exercise default config with None optional auth headers
        let default_hdr_cfg = DiffRunnerConfig {
            node_base_url: rust_server.base_url.clone(),
            rust_base_url: rust_server.base_url.clone(),
            ..DiffRunnerConfig::default()
        };
        assert!(
            execute_case(&client, &default_hdr_cfg, &cases[0])
                .await
                .unwrap()
                .is_empty()
        );

        let report = run_suite(&client, &cfg, &cases).await;
        assert_eq!(report.total, 3);
        assert_eq!(report.passed, 2);
        assert_eq!(report.failed, 1);
        assert_eq!(report.mismatches.len(), 2);
        assert_eq!(report.mismatches[0].case_name, "mismatch-case");
        assert_eq!(report.mismatches[0].category, "status");
        assert_eq!(report.mismatches[1].category, "json_body");

        let formatted = format_report(&report);
        assert!(formatted.contains("Summary: 2/3 passed, 1 failed (2 mismatches)"));
        assert!(formatted.contains("- [mismatch-case] status:"));

        // Test transport/request_error path in run_suite (invalid method)
        let bad_cases = vec![DiffCase {
            name: "bad-method".to_string(),
            method: "BAD METHOD".to_string(),
            path: "/v1/health".to_string(),
            headers: BTreeMap::new(),
            body: None,
        }];
        let err_report = run_suite(&client, &cfg, &bad_cases).await;
        assert_eq!(err_report.failed, 1);
        assert_eq!(err_report.mismatches[0].category, "request_error");

        // Test truncated response body error in send_request
        let truncated_case = DiffCase {
            name: "truncated".to_string(),
            method: "GET".to_string(),
            path: "/v1/truncated".to_string(),
            headers: BTreeMap::new(),
            body: None,
        };
        assert!(execute_case(&client, &cfg, &truncated_case).await.is_err());

        // Test execute_case error propagation when rust origin fails (node succeeds!)
        let rust_unreachable_cfg = DiffRunnerConfig {
            rust_base_url: "http://127.0.0.1:1".to_string(),
            ..cfg.clone()
        };
        assert!(
            execute_case(&client, &rust_unreachable_cfg, &cases[0])
                .await
                .is_err()
        );

        // Test invalid URL error
        let invalid_url_cfg = DiffRunnerConfig {
            node_base_url: "not a url".to_string(),
            ..cfg
        };
        assert!(
            execute_case(&client, &invalid_url_cfg, &cases[0])
                .await
                .is_err()
        );

        node_server.stop().await;
        rust_server.stop().await;
    }

    #[tokio::test]
    async fn parses_cli_and_runs_from_args() {
        assert!(parse_sample_params(&["no_equals".to_string()]).is_err());
        assert!(parse_sample_params(&["=val".to_string()]).is_err());
        let parsed_params =
            parse_sample_params(&["id=abc".to_string(), "q=a=b".to_string()]).unwrap();
        assert_eq!(parsed_params.get("id").map(String::as_str), Some("abc"));
        assert_eq!(parsed_params.get("q").map(String::as_str), Some("a=b"));

        let server = start_mock_server(|_, _, _| MockRouteResponse {
            status: 200,
            content_type: "application/json".to_string(),
            content_length_override: None,
            extra_headers: vec![],
            body: br#"{"ok":true}"#.to_vec(),
        })
        .await;

        let fixtures_path = temp_file_path("cli_fixtures");
        fs::write(
            &fixtures_path,
            r#"[{"name":"fixture-health","method":"GET","path":"/health"}]"#,
        )
        .unwrap();

        let openapi_path = temp_file_path("cli_openapi");
        fs::write(
            &openapi_path,
            r#"{"openapi":"3.0.3","paths":{"/v1/offers/{id}":{"get":{"operationId":"getOffer"}}}}"#,
        )
        .unwrap();

        let report = run_cli_from_args([
            "egdata-diff",
            "--node-url",
            &server.base_url,
            "--rust-url",
            &server.base_url,
            "--fixtures",
            fixtures_path.to_str().unwrap(),
            "--openapi",
            openapi_path.to_str().unwrap(),
            "--worker-token",
            "wt",
            "--key-id",
            "key_1",
            "--key-tier",
            "free",
            "--origin-token",
            "ot",
            "--concurrency",
            "4",
            "--sample-param",
            "id=offer_1",
            "--include-og",
        ])
        .await
        .unwrap();

        assert_eq!(report.total, 2);
        assert_eq!(report.passed, 2);
        assert_eq!(report.failed, 0);

        // Error when no cases loaded
        let empty_err = run_cli_from_args([
            "egdata-diff",
            "--node-url",
            &server.base_url,
            "--rust-url",
            &server.base_url,
        ])
        .await
        .unwrap_err();
        assert!(empty_err.to_string().contains("no diff cases loaded"));

        // Error on invalid --sample-param
        assert!(
            run_cli_from_args(["egdata-diff", "--sample-param", "bad"])
                .await
                .is_err()
        );

        // Error on missing --fixtures file
        assert!(
            run_cli_from_args([
                "egdata-diff",
                "--fixtures",
                temp_file_path("nope_fix").to_str().unwrap()
            ])
            .await
            .is_err()
        );

        // Error on missing --openapi file
        assert!(
            run_cli_from_args([
                "egdata-diff",
                "--openapi",
                temp_file_path("nope_oa").to_str().unwrap()
            ])
            .await
            .is_err()
        );

        // Error on invalid CLI arg
        assert!(
            run_cli_from_args(["egdata-diff", "--unknown-flag"])
                .await
                .is_err()
        );

        let _ = fs::remove_file(&fixtures_path);
        let _ = fs::remove_file(&openapi_path);
        server.stop().await;
    }
}
