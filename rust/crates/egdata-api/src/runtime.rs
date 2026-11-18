//! Rust HTTP origin and operational command entrypoints.
mod dotenv;
use crate::{
    middleware::{
        compression::{
            NodeCompressionPredicate, canonicalize_accept_encoding, remember_compression_headers,
            weaken_encoded_etag,
        },
        cors::api_cors,
        origin_auth::origin_auth,
    },
    state::AppState,
};
use anyhow::{Context, Result, bail};
use axum::{Router, middleware};
use clap::Parser;
use std::{
    collections::BTreeMap,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
};

#[derive(Debug, Parser)]
#[command(about = "Run the egdata origin or its administrative commands")]
pub struct ServerArgs {
    /// Node-compatible dotenv file. Existing process variables take precedence.
    #[arg(long, global = true)]
    pub env_file: Option<PathBuf>,
    #[command(subcommand)]
    pub command: Option<crate::operations::Command>,
    /// Listener address (defaults to loopback for local development).
    #[arg(long, default_value_t = IpAddr::V4(Ipv4Addr::LOCALHOST))]
    pub bind: IpAddr,
    /// Overrides PORT (default 4001).
    #[arg(long)]
    pub port: Option<u16>,
}

/// Load without mutating global process environment. Certificate paths from an
/// explicit dotenv file resolve relative to that file, as in its Node checkout.
pub fn load_environment(
    file: Option<&Path>,
    process: BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>> {
    let mut values = BTreeMap::new();
    if let Some(file) = file {
        let file = file
            .canonicalize()
            .context("Cannot open the requested environment file")?;
        let base = file
            .parent()
            .context("Environment file has no parent directory")?;
        let bytes = std::fs::read(&file).context("Cannot read the environment file")?;
        values = dotenv::parse(&bytes);
        for key in ["MONGO_CA", "MONGO_CERT"] {
            if !process.contains_key(key)
                && let Some(value) = values.get_mut(key)
            {
                let path = Path::new(value);
                if path.is_relative() && !value.is_empty() {
                    *value = base.join(path).to_string_lossy().into_owned();
                }
            }
        }
    }
    values.extend(process);
    Ok(values)
}

pub fn application(state: AppState) -> Router {
    let anti_abuse_runtime =
        std::sync::Arc::new(crate::middleware::anti_abuse::AntiAbuseRuntime::new(&state));
    crate::v1::router(&state)
        .merge(crate::graphql::router(&state))
        .merge(crate::legacy::router(&state))
        .layer(middleware::from_fn(api_cors))
        .layer(middleware::from_fn(remember_compression_headers))
        .layer(
            tower_http::compression::CompressionLayer::new()
                .gzip(true)
                .deflate(true)
                .no_br()
                .no_zstd()
                .compress_when(NodeCompressionPredicate),
        )
        .layer(middleware::from_fn(canonicalize_accept_encoding))
        .layer(middleware::from_fn(weaken_encoded_etag))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            crate::middleware::anti_abuse::observe_response,
        ))
        .layer(middleware::from_fn_with_state(state.clone(), origin_auth))
        .layer(axum::Extension(anti_abuse_runtime))
        .with_state(state)
        // Must wrap after `.with_state` so Axum converts `MethodRouter` into `Route`
        // before stripping `Allow` from legacy 404 method-fallback responses.
        .layer(middleware::from_fn(crate::legacy::fallback_headers))
}

/// The caller owns the listener, making startup and graceful shutdown testable.
pub async fn serve(
    listener: tokio::net::TcpListener,
    state: AppState,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> Result<()> {
    axum::serve(
        listener,
        application(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown)
    .await
    .context("The HTTP server stopped unexpectedly")
}

pub async fn run(args: ServerArgs) -> Result<()> {
    let default_file = Path::new(".env");
    let file = args
        .env_file
        .as_deref()
        .or_else(|| default_file.is_file().then_some(default_file));
    let env = load_environment(file, std::env::vars().collect())?;
    if let Some(command) = args.command {
        return crate::operations::run(command, &env).await;
    }
    run_server(args.bind, args.port, env, |_| shutdown_signal()).await
}

async fn run_server<F: Future<Output = ()> + Send + 'static>(
    bind: IpAddr,
    port: Option<u16>,
    mut env: BTreeMap<String, String>,
    shutdown: impl FnOnce(SocketAddr) -> F,
) -> Result<()> {
    if bind.is_loopback() {
        env.entry("RESPONSE_CACHE_PREFIX".into())
            .or_insert_with(|| "rust:local:response:v2:".into());
    } else {
        env.entry("PORT".into()).or_insert_with(|| "4000".into());
    }
    if let Some(port) = port {
        env.insert("PORT".into(), port.to_string());
    }
    let config = crate::state::ApiConfig::from_env_map(&env)
        .map_err(|_| anyhow::anyhow!("Invalid API environment configuration"))?;
    validate_listener(bind, &config)?;
    // Bind before opening services so an occupied port fails without creating pools.
    let listener = tokio::net::TcpListener::bind((bind, config.port))
        .await
        .context("Cannot bind the requested API port")?;
    tracing::info!("Connecting to MongoDB");
    let startup = crate::runtime_adapters::build_state_for_listener(&env, bind.is_loopback());
    let state = if bind.is_loopback() {
        tokio::time::timeout(std::time::Duration::from_secs(30), startup)
            .await
            .context("Startup timed out connecting to the configured services")??
    } else {
        // Catalog indexes may take longer than a connection timeout on first deployment.
        startup.await?
    };
    let address = listener
        .local_addr()
        .context("Cannot determine the local API address")?;
    let inventory = crate::v1::operation_coverage();
    tracing::info!(%address, implemented = inventory.implemented, documented = inventory.documented, "Rust API listening");
    serve(listener, state, shutdown(address)).await
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {_ = term.recv()=>{},_ = tokio::signal::ctrl_c()=>{}}
            }
            Err(error) => {
                tracing::error!(%error,"Could not register termination signal handler")
            }
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("Shutting down Rust API");
}

fn validate_listener(bind: IpAddr, config: &crate::state::ApiConfig) -> Result<()> {
    if !bind.is_loopback()
        && (!config.origin_auth_required
            || config
                .origin_auth_token
                .as_deref()
                .is_none_or(str::is_empty))
    {
        bail!(
            "Configure ORIGIN_AUTH_REQUIRED=true and ORIGIN_AUTH_TOKEN to serve outside loopback behind the gateway"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    #[test]
    fn environment_precedence_and_relative_certificate_paths() {
        let dir = std::env::temp_dir().join(format!("egdata-runtime-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(".env");
        std::fs::write(
            &file,
            "MONGO_CA=certs/ca.pem\nMONGO_CERT=client.pem\nPORT=4000\n",
        )
        .unwrap();
        let env = load_environment(
            Some(&file),
            BTreeMap::from([
                ("PORT".into(), "4001".into()),
                ("MONGO_CERT".into(), "process-cert.pem".into()),
            ]),
        )
        .unwrap();
        assert_eq!(env["PORT"], "4001");
        assert_eq!(
            Path::new(&env["MONGO_CA"]),
            dir.canonicalize().unwrap().join("certs/ca.pem")
        );
        assert_eq!(env["MONGO_CERT"], "process-cert.pem");
        std::fs::write(&file, "line without an assignment\n").unwrap();
        assert!(
            load_environment(Some(&file), BTreeMap::new())
                .unwrap()
                .is_empty()
        );
        std::fs::remove_file(file).unwrap();
        std::fs::remove_dir(dir).unwrap();
        assert!(
            load_environment(Some(Path::new("/nonexistent/egdata/.env")), BTreeMap::new()).is_err()
        );
    }

    #[test]
    fn explicit_origin_listener_requires_gateway_auth() {
        let mut config = crate::state::ApiConfig::default();
        let bind = "0.0.0.0".parse().unwrap();
        assert!(validate_listener(bind, &config).is_err());
        assert!(validate_listener("127.0.0.1".parse().unwrap(), &config).is_ok());
        config.origin_auth_required = true;
        assert!(validate_listener(bind, &config).is_err());
        config.origin_auth_token = Some("fixture".into());
        assert!(validate_listener(bind, &config).is_ok());
    }

    #[tokio::test]
    async fn startup_rejects_an_unsecured_listener_and_an_occupied_port_before_opening_services() {
        let noop = |_| std::future::ready(());
        let error = run_server("0.0.0.0".parse().unwrap(), None, BTreeMap::new(), noop)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("ORIGIN_AUTH_REQUIRED"));
        let loopback = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let occupied = tokio::net::TcpListener::bind((loopback, 0)).await.unwrap();
        let error = run_server(
            loopback,
            Some(occupied.local_addr().unwrap().port()),
            BTreeMap::new(),
            noop,
        )
        .await
        .unwrap_err();
        assert_eq!(error.to_string(), "Cannot bind the requested API port");
        let error = run_server(loopback, Some(0), BTreeMap::new(), noop)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("MONGO_URL"));
    }

    #[tokio::test]
    #[ignore = "requires disposable X.509 MongoDB and Redis"]
    async fn startup_serves_health_with_the_configured_databases_and_drains() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let redis = url::Url::parse(&std::env::var("EGDATA_TEST_REDIS").unwrap()).unwrap();
        let env = BTreeMap::from([
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
            ("REDISHOST".into(), redis.host_str().unwrap().into()),
            ("REDISPORT".into(), redis.port().unwrap().to_string()),
        ]);
        let (send, received) = tokio::sync::oneshot::channel();
        run_server(
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            Some(0),
            env,
            |address| async move {
                let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
                stream
                    .write_all(
                        b"GET /v1/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
                    )
                    .await
                    .unwrap();
                let mut reply = String::new();
                stream.read_to_string(&mut reply).await.unwrap();
                send.send(reply).unwrap();
            },
        )
        .await
        .unwrap();
        let reply = received.await.unwrap();
        assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");
        let body: serde_json::Value =
            serde_json::from_str(reply.split_once("\r\n\r\n").unwrap().1).unwrap();
        for service in ["mongodb", "redis"] {
            assert_eq!(body["data"]["services"][service]["status"], "ok");
        }
    }

    #[tokio::test]
    async fn application_enforces_origin_auth_and_preserves_v1_context() {
        let config = crate::state::ApiConfig {
            origin_auth_required: true,
            origin_auth_token: Some("local-test-token".into()),
            v1_worker_token: Some("local-test-token".into()),
            v1_worker_auth_required: true,
            ..Default::default()
        };
        let app = application(crate::middleware::test_support::test_app_state(config));
        let denied = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/v1/countries")
                    .header("x-egdata-origin-token", "local-test-token")
                    .header("x-egdata-worker-token", "local-test-token")
                    .header("x-egdata-key-id", "key_localdev")
                    .header("x-egdata-key-tier", "free")
                    .header("origin", "http://localhost:3000")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.headers().contains_key("x-request-id"));
        assert_eq!(
            response.headers()["access-control-allow-origin"],
            "http://localhost:3000"
        );
    }

    #[tokio::test]
    async fn v1_compression_head_and_cors_match_node_oracle() {
        use http_body_util::BodyExt;
        let app = application(crate::middleware::test_support::test_app_state(
            crate::state::ApiConfig {
                origin_auth_token: Some("compression-test-token".into()),
                ..Default::default()
            },
        ));
        let denied = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("https://origin-api.egdata.app/v1/countries")
                    .header("origin", "https://egdata.app")
                    .header("x-egdata-key-id", "key_compression")
                    .header("x-egdata-key-tier", "free")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
        assert!(!denied.headers().contains_key("access-control-allow-origin"));

        let preflight = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("OPTIONS")
                    .uri("/v1/countries")
                    .header("origin", "https://egdata.app")
                    .header("access-control-request-method", "GET")
                    .header("x-egdata-origin-token", "compression-test-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(preflight.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            preflight.headers()["access-control-allow-methods"],
            "GET,HEAD,PUT,POST,DELETE,PATCH"
        );

        let make_request = |method, path, encoding: Option<&str>| {
            let mut builder = Request::builder()
                .method(method)
                .uri(path)
                .header("x-egdata-origin-token", "compression-test-token")
                .header("x-egdata-key-id", "key_compression")
                .header("x-egdata-key-tier", "free")
                .header("origin", "https://egdata.app");
            if let Some(value) = encoding {
                builder = builder.header("accept-encoding", value);
            }
            builder.body(Body::empty()).unwrap()
        };

        let get = app
            .clone()
            .oneshot(make_request("GET", "/v1/countries", Some("gzip, deflate")))
            .await
            .unwrap();
        assert_eq!(get.status(), StatusCode::OK);
        assert_eq!(get.headers()["content-encoding"], "gzip");
        assert!(get.headers()["etag"].to_str().unwrap().starts_with("W/"));
        assert_eq!(get.headers()["vary"], "Origin");
        assert_eq!(
            get.headers()["access-control-allow-origin"],
            "https://egdata.app"
        );
        let compressed = get.into_body().collect().await.unwrap().to_bytes();
        assert!(compressed.starts_with(&[0x1f, 0x8b]));

        let quality_zero = app
            .clone()
            .oneshot(make_request(
                "GET",
                "/v1/countries",
                Some("gzip;q=0, deflate"),
            ))
            .await
            .unwrap();
        assert_eq!(quality_zero.headers()["content-encoding"], "gzip");

        let deflate = app
            .clone()
            .oneshot(make_request("GET", "/v1/countries", Some("deflate")))
            .await
            .unwrap();
        assert_eq!(deflate.headers()["content-encoding"], "deflate");

        for encoding in [None, Some("identity")] {
            let identity = app
                .clone()
                .oneshot(make_request("GET", "/v1/countries", encoding))
                .await
                .unwrap();
            assert!(!identity.headers().contains_key("content-encoding"));
            assert!(
                !identity.headers()["etag"]
                    .to_str()
                    .unwrap()
                    .starts_with("W/")
            );
        }

        let small = app
            .clone()
            .oneshot(make_request("GET", "/v1/health", Some("gzip")))
            .await
            .unwrap();
        assert_eq!(small.headers()["content-encoding"], "gzip");
        assert!(!small.headers().contains_key("content-length"));

        let head = app
            .oneshot(make_request("HEAD", "/v1/countries", Some("gzip, deflate")))
            .await
            .unwrap();
        assert_eq!(head.status(), StatusCode::OK);
        assert!(!head.headers().contains_key("content-encoding"));
        assert!(
            head.into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn listener_serves_http_and_shuts_down_cleanly() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let state =
            crate::middleware::test_support::test_app_state(crate::state::ApiConfig::default());
        let task = tokio::spawn(serve(listener, state, async {
            let _ = rx.await;
        }));
        let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
        socket
            .write_all(b"GET /v1/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut bytes = Vec::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            socket.read_to_end(&mut bytes),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(String::from_utf8_lossy(&bytes).starts_with("HTTP/1.1 200"));
        tx.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
}
