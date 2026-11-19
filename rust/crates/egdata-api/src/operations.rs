//! Administrative commands use the same configuration and service clients as the origin.
mod abuse;
use anyhow::{Context, Result, bail};
use clap::Subcommand;
use egdata_infra::{
    catalog_mongo::{
        MongoDatabaseSource, V1_INDEX_PLAN, ensure_v1_indexes, ensure_v1_search_mappings,
    },
    mongo::{MongoConfig, connect_mongo},
    search_clients::{OpenSearchClient, OpenSearchConfig},
};
use std::{collections::BTreeMap, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Create the additive indexes used for v1 lookups and keyset pagination.
    EnsureV1Indexes,
    /// Report required mappings. --apply adds eligible missing properties.
    EnsureV1SearchMappings {
        #[arg(long)]
        apply: bool,
    },
    /// Inspect anonymous traffic and manage short-lived scoped trials.
    AntiAbuseOps {
        #[command(subcommand)]
        action: abuse::Action,
    },
    /// Probe the local /v1/health endpoint for container healthchecks.
    Healthcheck {
        /// Overrides PORT (defaults to PORT env var or 4000).
        #[arg(long)]
        port: Option<u16>,
        /// Request timeout in seconds.
        #[arg(long, default_value_t = 2)]
        timeout_secs: u64,
    },
}

pub async fn run(command: Command, env: &BTreeMap<String, String>) -> Result<()> {
    let get = |name: &str| env.get(name).cloned();
    match command {
        Command::EnsureV1Indexes => {
            let config = MongoConfig::from_env_lookup(get)?;
            let (client, db) = connect_mongo(&config)
                .await
                .context("Could not connect to MongoDB")?;
            let result = ensure_v1_indexes(&MongoDatabaseSource::new(db), true).await;
            client.shutdown().await;
            println!(
                "v1 index plan checked: {} indexes, {} ensured, {} failed.",
                V1_INDEX_PLAN.len(),
                result.created,
                result.failed
            );
            if result.failed > 0 {
                bail!("Some required MongoDB indexes could not be ensured");
            }
        }
        Command::EnsureV1SearchMappings { apply } => {
            let client = OpenSearchClient::new(OpenSearchConfig::from_env_lookup(get)?);
            let reports = ensure_v1_search_mappings(&client, apply)
                .await
                .context("OpenSearch mapping inspection failed")?;
            println!("{}", serde_json::to_string_pretty(&reports)?);
            if reports
                .iter()
                .any(|r| !r.incompatible.is_empty() || (!apply && !r.missing.is_empty()))
            {
                bail!(
                    "Required OpenSearch mappings are missing or incompatible. Review the mapping report."
                );
            }
        }
        Command::AntiAbuseOps { action } => abuse::run(action, env).await?,
        Command::Healthcheck { port, timeout_secs } => {
            let port = match port {
                Some(p) => p,
                None => env
                    .get("PORT")
                    .and_then(|v| v.parse::<u16>().ok())
                    .unwrap_or(4000),
            };
            let origin_token = env
                .get("ORIGIN_AUTH_TOKEN")
                .map(String::as_str)
                .filter(|v| !v.is_empty());
            probe_health(port, Duration::from_secs(timeout_secs.max(1)), origin_token).await?;
        }
    }
    Ok(())
}

async fn probe_health(port: u16, timeout: Duration, origin_token: Option<&str>) -> Result<()> {
    let probe = async {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .context("Could not connect to local API port")?;
        let mut request =
            String::from("GET /v1/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n");
        if let Some(token) = origin_token {
            request.push_str("x-egdata-origin-token: ");
            request.push_str(token);
            request.push_str("\r\n");
        }
        request.push_str("\r\n");
        stream
            .write_all(request.as_bytes())
            .await
            .context("Could not send healthcheck request")?;
        let mut response = Vec::with_capacity(512);
        let mut chunk = [0u8; 512];
        loop {
            let n = stream
                .read(&mut chunk)
                .await
                .context("Could not read healthcheck response")?;
            if n == 0 {
                break;
            }
            response.extend_from_slice(&chunk[..n]);
            if response.windows(2).any(|w| w == b"\r\n") || response.len() >= 4096 {
                break;
            }
        }
        let status_line = std::str::from_utf8(&response)
            .ok()
            .and_then(|s| s.lines().next())
            .unwrap_or("");
        let status = status_line
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse::<u16>().ok());
        match status {
            Some(code) if (200..300).contains(&code) => Ok(()),
            Some(code) => bail!("Healthcheck returned HTTP {code}"),
            None => bail!("Healthcheck returned an invalid HTTP response"),
        }
    };
    tokio::time::timeout(timeout, probe)
        .await
        .context("Healthcheck timed out")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, Router, http::StatusCode};
    use serde_json::json;

    #[tokio::test]
    async fn mapping_inspection_reports_configuration_errors_missing_indexes_and_access_denials() {
        let inspect = |apply| Command::EnsureV1SearchMappings { apply };
        let env = BTreeMap::new();
        assert!(
            run(inspect(false), &env)
                .await
                .unwrap_err()
                .to_string()
                .contains("OPENSEARCH_URL")
        );
        assert!(
            run(Command::EnsureV1Indexes, &env)
                .await
                .unwrap_err()
                .to_string()
                .contains("MONGO_URL")
        );
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .route(
                "/missing/{index}/_mapping",
                axum::routing::get(|| async { StatusCode::NOT_FOUND }),
            )
            .route(
                "/denied/{index}/_mapping",
                axum::routing::get(|| async {
                    (
                        StatusCode::FORBIDDEN,
                        Json(json!({"error":"fixture service denied access"})),
                    )
                }),
            );
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async { stopped.await.unwrap() })
                .await
                .unwrap();
        });
        let env = BTreeMap::from([("OPENSEARCH_URL".into(), format!("{url}/missing"))]);
        assert!(
            run(inspect(false), &env)
                .await
                .unwrap_err()
                .to_string()
                .contains("missing or incompatible")
        );
        // Like the Node command, apply can add fields to an existing index but leaves absent indexes in the report.
        run(inspect(true), &env).await.unwrap();
        let env = BTreeMap::from([("OPENSEARCH_URL".into(), format!("{url}/denied"))]);
        let error = run(inspect(false), &env).await.unwrap_err();
        assert_eq!(error.to_string(), "OpenSearch mapping inspection failed");
        stop.send(()).unwrap();
        task.await.unwrap();
    }

    #[tokio::test]
    async fn healthcheck_reports_ok_unhealthy_and_unreachable_ports() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let healthy = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let flag = healthy.clone();
        let app = Router::new().route(
            "/v1/health",
            axum::routing::get(move || {
                let flag = flag.clone();
                async move {
                    if flag.load(std::sync::atomic::Ordering::Relaxed) {
                        StatusCode::OK
                    } else {
                        StatusCode::SERVICE_UNAVAILABLE
                    }
                }
            }),
        );
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async { stopped.await.unwrap() })
                .await
                .unwrap();
        });

        let env = BTreeMap::from([("PORT".into(), port.to_string())]);
        run(
            Command::Healthcheck {
                port: None,
                timeout_secs: 2,
            },
            &env,
        )
        .await
        .unwrap();

        healthy.store(false, std::sync::atomic::Ordering::Relaxed);
        let err = run(
            Command::Healthcheck {
                port: Some(port),
                timeout_secs: 2,
            },
            &BTreeMap::new(),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("HTTP 503"));

        stop.send(()).unwrap();
        task.await.unwrap();

        let err = run(
            Command::Healthcheck {
                port: Some(port),
                timeout_secs: 3,
            },
            &BTreeMap::new(),
        )
        .await
        .unwrap_err();
        let message = err.to_string();
        assert!(
            message.contains("Could not connect") || message.contains("Healthcheck timed out"),
            "unexpected error: {message}"
        );
    }
}
