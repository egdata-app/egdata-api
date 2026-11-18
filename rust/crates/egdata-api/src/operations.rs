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
use std::collections::BTreeMap;

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
    }
    Ok(())
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
}
