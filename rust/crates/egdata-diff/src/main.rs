//! Differential oracle CLI comparing Node (:4000) and Rust (:4001) HTTP origins.

pub mod diff;
pub mod runner;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let report = runner::run_cli_from_args(std::env::args_os()).await?;
    println!("{}", runner::format_report(&report));
    if report.failed > 0 {
        anyhow::bail!("{} differential check(s) failed", report.failed);
    }
    Ok(())
}
