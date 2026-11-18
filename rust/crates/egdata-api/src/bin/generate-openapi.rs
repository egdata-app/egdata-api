//! Contract validation/generation entrypoint; implementation lives in the library.

fn main() -> anyhow::Result<()> {
    println!(
        "{}",
        egdata_api::openapi::run_cli_from_args(std::env::args_os())?
    );
    Ok(())
}
