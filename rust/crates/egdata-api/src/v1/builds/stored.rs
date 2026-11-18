//! Manifest metadata is read from historical Mongo records before projecting endpoint fields.
use super::StreamComparison;
use crate::v1::{helpers::primitive_id, system::internal_error};
use bson::{Bson, Document, doc};
use egdata_core::v1::{ProblemError, serialization::js_string};
use egdata_infra::bson_json::{bson_doc_to_js_json, bson_to_js_json};
use indexmap::IndexMap;
use serde_json::{Value, json};

pub(crate) fn manifest_status(build: &Document) -> Bson {
    build
        .get("manifestStatus")
        .filter(|v| !matches!(v, Bson::Null))
        .cloned()
        .unwrap_or_else(|| "legacy_unverified".into())
}

pub(crate) fn snapshot_filter(build: &Document) -> Document {
    let hash = build.get("hash").unwrap_or(&Bson::Null);
    if manifest_status(build) == Bson::String("legacy_unverified".into()) {
        return doc! {"manifestHash": build.get("sourceManifestHash").filter(|v| !matches!(v,Bson::Null)).unwrap_or(hash)};
    }
    if let Some(id) = build
        .get("manifestId")
        .filter(|id| crate::v1::system::js_truthy(&bson_to_js_json(id)))
    {
        return doc! {"manifestId":{"$eq":id,"$type":"string"}};
    }
    doc! {"manifestHash":hash}
}

pub(crate) fn platform(build: &Document) -> Result<Bson, ProblemError> {
    if let Some(platform) = build.get("platform").filter(|v| !matches!(v, Bson::Null)) {
        return Ok(platform.clone());
    }
    let label = build.get_str("labelName").map_err(|_| internal_error())?;
    Ok(Bson::String(label.rsplit('-').next().unwrap().into()))
}

pub(crate) fn stored_comparable(build: &Document) -> bool {
    matches!(
        manifest_status(build).as_str(),
        Some("verified" | "legacy_unverified")
    ) && build.get_str("manifestId").is_ok()
}

pub(crate) fn same_field(left: Option<&Bson>, right: Option<&Bson>) -> bool {
    primitive_id(left).is_some_and(|key| Some(key) == primitive_id(right))
}

pub(crate) fn compatible(base: &Document, target: &Document) -> Result<bool, ProblemError> {
    Ok(same_field(base.get("appName"), target.get("appName"))
        && same_field(Some(&platform(base)?), Some(&platform(target)?)))
}

fn technologies(build: &Value) -> Result<IndexMap<String, &Value>, ProblemError> {
    let mut entries = IndexMap::new();
    if let Some(technologies) = build.get("technologies").filter(|v| !v.is_null()) {
        for tech in technologies.as_array().ok_or_else(internal_error)? {
            if tech.is_null() {
                return Err(internal_error());
            }
            let part = |key: &str| {
                tech.get(key)
                    .map(js_string)
                    .unwrap_or_else(|| "undefined".into())
            };
            entries.insert(format!("{}\0{}", part("section"), part("technology")), tech);
        }
    }
    Ok(entries)
}

pub(crate) fn comparison_payload(
    base: &Document,
    target: &Document,
    comparison: &StreamComparison,
    summarize: impl Fn(&Value) -> Result<Value, ProblemError>,
) -> Result<Value, ProblemError> {
    let same_stream = same_field(base.get("labelName"), target.get("labelName"));
    let mut warnings = Vec::new();
    if !same_stream {
        warnings.push("CROSS_STREAM_COMPARISON");
    }
    if [base, target]
        .iter()
        .any(|build| manifest_status(build).as_str() == Some("legacy_unverified"))
    {
        warnings.push("LEGACY_UNVERIFIED_SNAPSHOT");
    }
    let base = bson_doc_to_js_json(base);
    let target = bson_doc_to_js_json(target);
    let (base_summary, target_summary) = (summarize(&base)?, summarize(&target)?);
    let before = technologies(&base)?;
    let after = technologies(&target)?;
    let added: Vec<_> = after
        .iter()
        .filter(|(key, _)| !before.contains_key(*key))
        .map(|(_, value)| *value)
        .collect();
    let removed: Vec<_> = before
        .iter()
        .filter(|(key, _)| !after.contains_key(*key))
        .map(|(_, value)| *value)
        .collect();
    let sizes = |field: &str| {
        let from = &base[field];
        let to = &target[field];
        json!({"base":from,"target":to,"delta":from.as_f64().zip(to.as_f64()).map(|(from,to)|to-from)})
    };
    Ok(
        json!({"base":base_summary,"target":target_summary,"comparisonScope":if same_stream {"same_stream"}else{"cross_stream"},
        "summary":{"files":comparison.counts,"fileBytes":comparison.bytes,
        "installedSizeBytes":sizes("installedSizeBytes"),"fullDownloadSizeBytes":sizes("downloadSizeBytes"),
        "technologies":{"added":added,"removed":removed},
        "installTags":comparison.install_tags,"topFiles":comparison.top_files,"topDirectories":comparison.top_directories},
        "changes":comparison.changes,"warnings":warnings}),
    )
}
