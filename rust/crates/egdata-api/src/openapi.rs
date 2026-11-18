//! Generate both public contracts from their declarative definitions and mounted routes.

use egdata_core::v1::operations::{
    V1AuthMode, V1OperationMetadata, V1ParameterLocation, V1ResponseKind, v1_operations,
};
use serde_json::{Map, Value, json};

#[cfg(test)]
const CANONICAL_V1: &str = include_str!("../../../../openapi/egdata.v1.openapi.json");

const ACCOUNT_POLICY: &str = "Account closure rejects all account keys, including warm credential caches, with 401 INVALID_API_KEY before quota or cache access. Failure to verify credential/account status returns uncacheable 503 ACCOUNT_STATUS_UNAVAILABLE with Retry-After: 30. Initial email/terms onboarding gates the dashboard and existing/new console sessions: 403 EMAIL_VERIFICATION_REQUIRED until email is verified, then 403 AGREEMENT_REQUIRED until the current terms edition is accepted. Existing API keys keep working even after a dashboard visit. Privacy notices do not require acceptance.";

fn data_schema(operation: &V1OperationMetadata) -> Value {
    let id = operation.operation_id.to_lowercase();
    let resource = if id.contains("offer") || (id.contains("search") && !id.contains("changelog")) {
        Some("Offer")
    } else if id.contains("item") {
        Some("Item")
    } else if id.contains("seller") {
        Some("Seller")
    } else {
        None
    };
    let item = resource.map(|name| json!({"$ref": format!("#/components/schemas/{name}")}));
    if operation.paginated == Some(true) {
        json!({"type": "array", "items": item.unwrap_or_else(|| json!({"type":"object"}))})
    } else {
        item.unwrap_or_else(|| json!({"type": "object", "additionalProperties": true}))
    }
}

fn success_response(operation: &V1OperationMetadata) -> Value {
    match operation.response_kind {
        Some(V1ResponseKind::Redirect) => json!({
            "description": "Bodyless redirect",
            "headers": {"Location": {"description": "Canonical GET or native image URL.",
                "schema": {"type": "string", "format": "uri-reference"}}}
        }),
        Some(V1ResponseKind::Xml) => json!({"description": "Native XML document",
            "content": {"application/xml": {"schema": {"type": "string"}}}}),
        Some(V1ResponseKind::Text) => json!({"description": "Native plain-text document",
            "content": {"text/plain": {"schema": {"type": "string"}}}}),
        Some(V1ResponseKind::Ndjson) => {
            json!({"description": "Streamed NDJSON, one object per requested root.",
            "content": {"application/x-ndjson": {"schema": {"type": "string"}}}})
        }
        Some(V1ResponseKind::Image) => json!({"description": "Native image", "content": {
            "image/png": {"schema": {"type": "string", "format": "binary"}},
            "image/webp": {"schema": {"type": "string", "format": "binary"}}
        }}),
        _ => {
            let mut meta =
                json!({"type": "object", "additionalProperties": true, "properties": {}});
            if operation.paginated == Some(true) {
                meta["properties"]["pagination"] =
                    json!({"$ref": "#/components/schemas/Pagination"});
            }
            if operation.operation_id == "searchOffers" {
                meta["properties"]["facets"] =
                    json!({"type": "object", "additionalProperties": true});
                meta["properties"]["result"] =
                    json!({"type": "object", "additionalProperties": true});
            }
            json!({"description": operation.response_description.as_deref().unwrap_or("Successful response"),
                "content": {"application/json": {"schema": {"type": "object", "required": ["data", "meta"],
                    "properties": {"data": data_schema(operation), "meta": meta}}}}})
        }
    }
}

fn operation_object(operation: &V1OperationMetadata) -> Value {
    let authenticated = operation.auth == V1AuthMode::Key;
    let mut descriptions = Vec::new();
    if let Some(description) = &operation.description
        && !description.is_empty()
    {
        descriptions.push(description.as_str());
    }
    if authenticated {
        descriptions.push(ACCOUNT_POLICY);
    }
    let mut result = json!({
        "operationId": operation.operation_id,
        "summary": operation.summary,
        "description": descriptions.join("\n\n"),
        "tags": operation.tags,
        "security": if authenticated { json!([{"ApiKeyAuth": []}, {"BearerAuth": []}]) } else { json!([]) },
    });
    if let Some(parameters) = &operation.parameters
        && !parameters.is_empty()
    {
        result["parameters"] = parameters
            .iter()
            .map(|p| {
                json!({
                    "name": p.name, "in": p.location,
                    "required": p.required.unwrap_or(p.location == V1ParameterLocation::Path),
                    "description": p.description, "schema": p.schema,
                })
            })
            .collect();
    }
    if let Some(body) = &operation.request_body {
        result["requestBody"] = json!({"required": body.required, "description": body.description,
            "content": {"application/json": {"schema": body.schema}}});
    }
    let status = if operation.response_kind == Some(V1ResponseKind::Redirect) {
        "303"
    } else {
        "200"
    };
    result["responses"] = json!({});
    result["responses"][status] = success_response(operation);
    for code in [
        "400", "401", "403", "404", "405", "409", "413", "415", "429", "502", "503", "504",
    ] {
        result["responses"][code] = json!({"$ref": "#/components/responses/Problem"});
    }
    result["x-egdata-visibility"] = json!("public");
    result["x-egdata-scope"] = json!(operation.scope);
    if authenticated {
        result["x-egdata-quota-scope"] = json!("project");
    }
    if let Some(policy) = operation.expensive_policy {
        result["x-egdata-quota-policy"] = json!(policy);
    }
    if let Some(legacy) = &operation.legacy {
        result["x-egdata-legacy-paths"] = json!(legacy);
    }
    if operation.paginated == Some(true) {
        result["x-egdata-paginated"] = json!(true);
    }
    result
}

/// Assemble legacy operation definitions from their shared response and access policies.
pub fn build_legacy_document() -> Value {
    let mut document: Value =
        serde_json::from_str(include_str!("../../../../openapi/source/legacy.json"))
            .expect("valid legacy operation definitions");
    let shared: Value = serde_json::from_str(include_str!(
        "../../../../openapi/source/legacy-shared.json"
    ))
    .expect("valid shared legacy definitions");
    for methods in document["paths"]
        .as_object_mut()
        .expect("paths")
        .values_mut()
    {
        for operation in methods.as_object_mut().expect("path item").values_mut() {
            for response in operation["responses"]
                .as_object_mut()
                .expect("responses")
                .values_mut()
            {
                expand_legacy_reference(response, &shared);
            }
            if let Some(security) = operation.get_mut("security") {
                expand_legacy_reference(security, &shared);
            }
            if let Some(paragraphs) = operation["description"].as_array_mut() {
                for paragraph in paragraphs.iter_mut() {
                    expand_legacy_reference(paragraph, &shared);
                }
                let text = paragraphs
                    .iter()
                    .map(|p| p.as_str().expect("policy paragraph"))
                    .collect::<Vec<_>>()
                    .join("\n\n");
                operation["description"] = Value::String(text);
            }
        }
    }
    document
}

fn expand_legacy_reference(value: &mut Value, shared: &Value) {
    if let Some(pointer) = value
        .get("$ref")
        .and_then(Value::as_str)
        .and_then(|reference| reference.strip_prefix("./legacy-shared.json#"))
    {
        *value = shared
            .pointer(pointer)
            .expect("defined legacy contract reference")
            .clone();
    }
}

pub fn build_v1_document() -> Value {
    let mut document: Value =
        serde_json::from_str(include_str!("../../../../openapi/source/v1-base.json"))
            .expect("valid v1 document metadata");
    let mut paths = Map::<String, Value>::new();
    for operation in v1_operations() {
        let item = paths
            .entry(operation.path.clone())
            .or_insert_with(|| json!({}));
        item[operation.method.as_str().to_lowercase()] = operation_object(operation);
    }
    document["paths"] = Value::Object(paths);
    document
}

/// Report differences by operation, rather than emitting a multi-megabyte assertion.
pub fn contract_differences(expected: &Value, actual: &Value) -> Vec<String> {
    let (Some(expected), Some(actual)) = (expected.as_object(), actual.as_object()) else {
        return vec!["OpenAPI document must be an object".into()];
    };
    let (Some(expected_paths), Some(actual_paths)) = (
        expected.get("paths").and_then(Value::as_object),
        actual.get("paths").and_then(Value::as_object),
    ) else {
        return vec!["OpenAPI paths must be an object".into()];
    };
    let mut differences = Vec::new();
    for (path, item) in expected_paths {
        let Some(methods) = item.as_object() else {
            differences.push(format!("invalid path item: {path}"));
            continue;
        };
        let target = actual_paths.get(path);
        if methods.is_empty() && target != Some(item) {
            differences.push(format!("missing or changed path: {path}"));
        }
        for (method, operation) in methods {
            if target.and_then(|t| t.get(method)) != Some(operation) {
                differences.push(format!(
                    "missing or changed: {} {path}",
                    method.to_uppercase()
                ));
            }
        }
    }
    for (path, item) in actual_paths {
        let Some(methods) = item.as_object() else {
            differences.push(format!("invalid generated path item: {path}"));
            continue;
        };
        let source = expected_paths.get(path);
        if methods.is_empty() && source.is_none() {
            differences.push(format!("unexpected path: {path}"));
        }
        for method in methods.keys() {
            if source.and_then(|s| s.get(method)).is_none() {
                differences.push(format!("unexpected: {} {path}", method.to_uppercase()));
            }
        }
    }
    if expected.len() != actual.len()
        || expected
            .iter()
            .any(|(k, v)| k != "paths" && actual.get(k) != Some(v))
    {
        differences.push("document metadata or components differ".into());
    }
    differences
}

#[track_caller]
pub(crate) fn registration_source() -> String {
    let full = std::panic::Location::caller().file().replace('\\', "/");
    let path = full.split_once("crates/").map(|(_, p)| p).unwrap_or(&full);
    format!("rust/crates/{path}")
}

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

    #[test]
    fn generated_operations_match_the_entire_typescript_contract() {
        let expected = serde_json::from_str(CANONICAL_V1).unwrap();
        let differences = contract_differences(&expected, &build_v1_document());
        assert!(differences.is_empty(), "{}", differences.join("\n"));
        assert_eq!(v1_operations().len(), 154);
        let expected_bytes = serde_json::to_vec(&expected).unwrap();
        let actual_bytes = serde_json::to_vec(&build_v1_document()).unwrap();
        assert!(
            expected_bytes == actual_bytes,
            "JSON byte order must also match for ETag parity"
        );
    }

    #[test]
    fn contract_check_detects_missing_extra_and_changed_operations_and_metadata() {
        let expected = json!({"info": {"version": "1"}, "paths": {"/v1/health": {"get": {"operationId": "health"}}}});
        let actual = json!({"info": {"version": "2"}, "paths": {"/v1/extra": {"post": {}}}});
        let differences = contract_differences(&expected, &actual);
        assert_eq!(differences.len(), 3);
        assert!(differences[0].contains("GET /v1/health"));
        assert!(differences[1].contains("POST /v1/extra"));
        let valid = json!({"paths": {"/offers": {"get": {"summary": "Offers"}}}});
        let changed = json!({"paths": {"/offers": {"get": {"summary": "Items"}}}});
        assert_eq!(
            contract_differences(&valid, &changed),
            ["missing or changed: GET /offers"]
        );
        for malformed in [
            Value::Null,
            json!(false),
            json!({}),
            json!({"paths":[]}),
            json!({"paths":{"/offers":false}}),
        ] {
            assert!(!contract_differences(&valid, &malformed).is_empty());
            assert!(!contract_differences(&malformed, &valid).is_empty());
        }
        let empty_path = json!({"paths": {"/x": {}}});
        let no_paths = json!({"paths": {}});
        assert_eq!(
            contract_differences(&empty_path, &no_paths),
            ["missing or changed path: /x"]
        );
        assert_eq!(
            contract_differences(&no_paths, &empty_path),
            ["unexpected path: /x"]
        );
    }
}
