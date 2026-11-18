//! Binary entrypoint for egdata-api.

#[tokio::main]
async fn main() -> std::process::ExitCode {
    use clap::Parser;
    tracing_subscriber::fmt()
        .with_env_filter("egdata_api=info")
        .with_writer(std::io::stderr)
        .with_target(false)
        .init();
    match egdata_api::runtime::run(egdata_api::runtime::ServerArgs::parse()).await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            // Display only the sanitized outer error, never a driver error chain
            // that may contain a service URL, credentials or certificate data.
            tracing::error!("{error}");
            std::process::ExitCode::FAILURE
        }
    }
}
