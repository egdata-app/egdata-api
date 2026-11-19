//! Contract generation and validation CLI over the mounted route inventory.
//!
//! The document builders live in `egdata-openapi`; the mounted-route inventory lives in
//! the surface crates, so the tooling manifest is assembled here.

use egdata_core::v1::operations::v1_operations;
use egdata_openapi::{build_legacy_document, build_v1_document, contract_differences};
use serde_json::{Value, json};

fn tooling_manifest() -> Value {
    let render = |routes: std::collections::BTreeMap<(String, String), String>| {
        routes
            .into_iter()
            .map(|((method, path), file)| json!({"method":method,"path":path,"file":file}))
            .collect::<Vec<_>>()
    };
    let mut legacy = crate::legacy::registration_sources();
    for method in ["GET", "POST"] {
        legacy.insert(
            (method.to_string(), "/graphql".into()),
            "rust/crates/egdata-api/src/graphql/mod.rs".into(),
        );
    }
    json!({"v1Operations":v1_operations(),"v1Coverage":crate::v1::operation_coverage(),
        "v1Routes":render(crate::v1::routes().operations),"legacyRoutes":render(legacy),
        "v1Document":build_v1_document(),"legacyDocument":build_legacy_document()})
}

#[derive(clap::Parser)]
#[command(about = "Generate/check the Rust v1 OpenAPI operations and report handler coverage")]
struct Cli {
    /// Check generated operations against the checked-in TypeScript contract.
    #[arg(long)]
    check: bool,
    /// Fail unless all documented operations have registered Rust handlers.
    #[arg(long)]
    require_handlers: bool,
    /// Emit both contracts, operation metadata and mounted sources for monorepo tools.
    #[arg(long,conflicts_with_all=["check","inventory","require_handlers","output","legacy_inventory"])]
    tooling_manifest: bool,
    /// Print the implementation inventory instead of the OpenAPI document.
    #[arg(long)]
    inventory: bool,
    /// Compare the mounted unversioned routes with the legacy OpenAPI contract.
    #[arg(long,conflicts_with_all=["check","inventory","require_handlers","output"])]
    legacy_inventory: bool,
    /// Write the generated document to this path (stdout when omitted).
    #[arg(long, conflicts_with_all = ["check", "inventory"])]
    output: Option<std::path::PathBuf>,
}

pub fn run_cli_from_args(
    args: impl IntoIterator<Item = std::ffi::OsString>,
) -> anyhow::Result<String> {
    use clap::Parser;
    let cli = Cli::try_parse_from(args)?;
    if cli.tooling_manifest {
        return Ok(serde_json::to_string(&tooling_manifest())?);
    }
    if cli.legacy_inventory {
        return Ok(serde_json::to_string_pretty(&crate::legacy::inventory())?);
    }
    let document = build_v1_document();
    let coverage = crate::v1::operation_coverage();
    if cli.check {
        let source_tree = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../openapi");
        let local = std::path::Path::new("openapi");
        let directory = if local.is_dir() { local } else { &source_tree };
        let mut differences = Vec::new();
        let legacy = build_legacy_document();
        for (name, generated) in [
            ("egdata.openapi.json", &legacy),
            ("egdata.v1.openapi.json", &document),
        ] {
            use anyhow::Context;
            let path = directory.join(name);
            let bytes =
                std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
            let expected = serde_json::from_slice(&bytes)
                .with_context(|| format!("parsing {}", path.display()))?;
            differences.extend(
                contract_differences(&expected, generated)
                    .into_iter()
                    .map(|difference| format!("{name}: {difference}")),
            );
        }
        anyhow::ensure!(
            differences.is_empty(),
            "Contract differences:\n{}",
            differences.join("\n")
        );
    }
    if cli.require_handlers {
        anyhow::ensure!(
            coverage.missing_handlers.is_empty() && coverage.undocumented_handlers.is_empty(),
            "Incomplete handler coverage: {} missing, {} undocumented",
            coverage.missing_handlers.len(),
            coverage.undocumented_handlers.len()
        );
    }
    if let Some(path) = cli.output {
        std::fs::write(
            &path,
            format!("{}\n", serde_json::to_string_pretty(&document)?),
        )?;
        return Ok(format!("Wrote {}", path.display()));
    }
    if cli.inventory {
        return Ok(serde_json::to_string_pretty(&coverage)?);
    }
    if cli.check {
        return Ok(format!(
            "OpenAPI parity: {} operations match. Handlers registered: {}/{} ({} missing).",
            coverage.documented,
            coverage.implemented,
            coverage.documented,
            coverage.missing_handlers.len()
        ));
    }
    Ok(serde_json::to_string_pretty(&document)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_checks_registered_handlers_and_writes_documents() {
        let run = |args: &[&str]| run_cli_from_args(args.iter().map(std::ffi::OsString::from));
        assert!(
            run(&["generate-openapi", "--check"])
                .unwrap()
                .contains("154 operations match")
        );
        assert!(
            run(&["generate-openapi", "--check", "--require-handlers"])
                .unwrap()
                .contains("154 operations match")
        );
        let inventory: Value =
            serde_json::from_str(&run(&["generate-openapi", "--inventory"]).unwrap()).unwrap();
        assert_eq!(inventory["documented"], 154);
        let legacy: Value =
            serde_json::from_str(&run(&["generate-openapi", "--legacy-inventory"]).unwrap())
                .unwrap();
        assert_eq!(legacy["documented"], 120);
        let manifest: Value =
            serde_json::from_str(&run(&["generate-openapi", "--tooling-manifest"]).unwrap())
                .unwrap();
        assert_eq!(manifest["v1Coverage"], inventory);
        assert_eq!(manifest["v1Document"], build_v1_document());
        assert_eq!(manifest["legacyDocument"], build_legacy_document());
        assert_eq!(manifest["v1Routes"].as_array().unwrap().len(), 154);
        assert_eq!(
            serde_json::from_str::<Value>(&run(&["generate-openapi"]).unwrap()).unwrap(),
            build_v1_document()
        );
        assert!(run(&["generate-openapi", "--unknown"]).is_err());
        let file =
            std::env::temp_dir().join(format!("egdata-openapi-{}.json", uuid::Uuid::new_v4()));
        assert!(
            run(&["generate-openapi", "--output", file.to_str().unwrap()])
                .unwrap()
                .starts_with("Wrote ")
        );
        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(written, build_v1_document());
        std::fs::remove_file(&file).unwrap();
        assert!(
            run(&[
                "generate-openapi",
                "--output",
                file.join("missing.json").to_str().unwrap()
            ])
            .is_err()
        );
    }
}
