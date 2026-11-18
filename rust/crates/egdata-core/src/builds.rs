//! Build comparison merge-join, manifest tree path normalization, pagination, and build summaries.

use bson::{Document, doc, oid::ObjectId};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{BTreeSet, HashMap, HashSet};

/// Maximum allowed pagination offset for build file scans.
pub const MAX_BUILD_PAGINATION_OFFSET: u64 = 100_000;

/// Maximum valid 1-based page number when `limit = 1`.
pub const MAX_BUILD_PAGE: u64 = MAX_BUILD_PAGINATION_OFFSET + 1;

/// Normalize a client-supplied directory path into canonical manifest form.
///
/// Manifest paths use forward slashes and are relative to the build root.
pub fn normalize_build_tree_path(path: Option<&str>) -> Option<String> {
    let Some(raw) = path.filter(|s| !s.is_empty() && *s != "/") else {
        return Some(String::new());
    };

    if raw.encode_utf16().count() > 500
        || raw.starts_with('/')
        || raw.contains('\\')
        || raw.contains("//")
        || raw.contains('\0')
    {
        return None;
    }

    let normalized = raw.strip_suffix('/').unwrap_or(raw);
    if normalized
        .split('/')
        .any(|segment| segment == "." || segment == "..")
    {
        return None;
    }

    Some(normalized.to_string())
}

/// Parse a bounded positive decimal integer query parameter, using `fallback` when absent.
pub fn parse_build_integer(value: Option<&str>, fallback: u64, maximum: u64) -> Option<u64> {
    let parsed = match value {
        None => fallback,
        Some(raw) => {
            if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            raw.parse::<u64>().ok()?
        }
    };

    if parsed >= 1 && parsed <= maximum {
        Some(parsed)
    } else {
        None
    }
}

/// Compute a 0-based MongoDB skip offset, rejecting values above [`MAX_BUILD_PAGINATION_OFFSET`].
pub fn build_pagination_offset(page: u64, limit: u64) -> Option<u64> {
    let offset = page.checked_sub(1)?.checked_mul(limit)?;
    if offset <= MAX_BUILD_PAGINATION_OFFSET {
        Some(offset)
    } else {
        None
    }
}

/// Manifest ingestion/verification status on a build document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ManifestStatus {
    Processing,
    Verified,
    Invalid,
    Unavailable,
    Failed,
    LegacyUnverified,
}

/// Technology detection entry recorded on a build document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuildTechnology {
    pub section: String,
    pub technology: String,
}

// MongoDB stores timestamps as BSON dates. JSON summaries and older fixtures
// use RFC 3339 strings for the same fields.
fn build_date<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<DateTime<Utc>>, D::Error> {
    match Option::<bson::Bson>::deserialize(deserializer)? {
        None => Ok(None),
        Some(bson::Bson::DateTime(date)) => Ok(Some(date.to_chrono())),
        Some(bson::Bson::String(text)) => text.parse().map(Some).map_err(serde::de::Error::custom),
        Some(_) => Err(serde::de::Error::custom("expected a build timestamp")),
    }
}

// The JS ingestion client can store integral byte counts as BSON doubles.
fn build_count<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<u64>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Number {
        Integer(u64),
        Double(f64),
    }

    match Option::<Number>::deserialize(deserializer)? {
        None => Ok(None),
        Some(Number::Integer(n)) => Ok(Some(n)),
        Some(Number::Double(n)) if n.fract() == 0.0 && (0.0..u64::MAX as f64).contains(&n) => {
            Ok(Some(n as u64))
        }
        Some(_) => Err(serde::de::Error::custom(
            "expected a nonnegative integral build size or count",
        )),
    }
}

/// Build document stored in the `builds` MongoDB collection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDocument {
    #[serde(rename = "_id")]
    pub id: ObjectId,
    pub app_name: String,
    pub build_version: String,
    pub label_name: String,
    pub platform: Option<String>,
    pub hash: String,
    pub source_manifest_hash: Option<String>,
    pub manifest_id: Option<String>,
    pub manifest_status: Option<ManifestStatus>,
    pub manifest_parser_version: Option<String>,
    #[serde(default, deserialize_with = "build_date")]
    pub manifest_processed_at: Option<DateTime<Utc>>,
    #[serde(default, deserialize_with = "build_count")]
    pub manifest_file_count: Option<u64>,
    #[serde(default, deserialize_with = "build_count")]
    pub manifest_file_bytes: Option<u64>,
    pub manifest_error_code: Option<String>,
    #[serde(default, deserialize_with = "build_date")]
    pub first_seen_at: Option<DateTime<Utc>>,
    #[serde(default, deserialize_with = "build_date")]
    pub last_seen_at: Option<DateTime<Utc>>,
    pub previous_observed_build_id: Option<ObjectId>,
    pub technologies: Option<Vec<BuildTechnology>>,
    #[serde(default, deserialize_with = "build_count")]
    pub download_size_bytes: Option<u64>,
    #[serde(default, deserialize_with = "build_count")]
    pub installed_size_bytes: Option<u64>,
    #[serde(default, deserialize_with = "build_date")]
    pub created_at: Option<DateTime<Utc>>,
    #[serde(default, deserialize_with = "build_date")]
    pub updated_at: Option<DateTime<Utc>>,
}

/// Fallback download/installed sizes sourced from an asset document.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildAssetSizes {
    #[serde(default, deserialize_with = "build_count")]
    pub download_size_bytes: Option<u64>,
    #[serde(default, deserialize_with = "build_count")]
    pub installed_size_bytes: Option<u64>,
}

/// Manifest sub-object exposed by [`build_summary`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildManifestSummary {
    pub status: ManifestStatus,
    pub canonical_hash: Option<String>,
    pub source_hash: String,
    pub parser_version: Option<String>,
    pub processed_at: Option<DateTime<Utc>>,
    pub file_count: Option<u64>,
    pub file_bytes: Option<u64>,
    pub error_code: Option<String>,
}

/// Public build summary payload emitted by build API routes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildSummary {
    pub id: String,
    #[serde(rename = "_id")]
    pub mongo_id: String,
    pub app_name: String,
    pub build_version: String,
    pub label_name: String,
    pub platform: String,
    pub hash: String,
    pub first_seen_at: Option<DateTime<Utc>>,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
    pub download_size_bytes: Option<u64>,
    pub installed_size_bytes: Option<u64>,
    pub technologies: Vec<BuildTechnology>,
    pub manifest: BuildManifestSummary,
}

/// Derive the effective platform from `build.platform` or the trailing `-` segment of `label_name`.
pub fn effective_build_platform(build: &BuildDocument) -> &str {
    build
        .platform
        .as_deref()
        .unwrap_or_else(|| build.label_name.rsplit('-').next().unwrap_or("Unknown"))
}

/// Return the build's manifest status, defaulting to [`ManifestStatus::LegacyUnverified`].
pub fn build_manifest_status(build: &BuildDocument) -> ManifestStatus {
    build
        .manifest_status
        .unwrap_or(ManifestStatus::LegacyUnverified)
}

/// Construct the MongoDB query filter used to read file snapshots for a build.
pub fn build_snapshot_query(build: &BuildDocument) -> Document {
    if build_manifest_status(build) == ManifestStatus::LegacyUnverified {
        let hash = build.source_manifest_hash.as_deref().unwrap_or(&build.hash);
        return doc! { "manifestHash": hash };
    }

    match build.manifest_id.as_deref().filter(|id| !id.is_empty()) {
        Some(manifest_id) => doc! { "manifestId": { "$eq": manifest_id, "$type": "string" } },
        None => doc! { "manifestHash": &build.hash },
    }
}

/// Shape a [`BuildDocument`] (with optional fallback asset sizes) into a public [`BuildSummary`].
pub fn build_summary(build: &BuildDocument, asset: Option<&BuildAssetSizes>) -> BuildSummary {
    let id_hex = build.id.to_hex();
    let asset_download = asset.and_then(|a| a.download_size_bytes);
    let asset_installed = asset.and_then(|a| a.installed_size_bytes);

    BuildSummary {
        id: id_hex.clone(),
        mongo_id: id_hex,
        app_name: build.app_name.clone(),
        build_version: build.build_version.clone(),
        label_name: build.label_name.clone(),
        platform: effective_build_platform(build).to_string(),
        hash: build.hash.clone(),
        first_seen_at: build.first_seen_at.or(build.created_at),
        last_seen_at: build.last_seen_at.or(build.updated_at),
        created_at: build.created_at,
        updated_at: build.updated_at,
        download_size_bytes: build.download_size_bytes.or(asset_download),
        installed_size_bytes: build.installed_size_bytes.or(asset_installed),
        technologies: build.technologies.clone().unwrap_or_default(),
        manifest: BuildManifestSummary {
            status: build_manifest_status(build),
            canonical_hash: build.manifest_id.clone(),
            source_hash: build
                .source_manifest_hash
                .clone()
                .unwrap_or_else(|| build.hash.clone()),
            parser_version: build.manifest_parser_version.clone(),
            processed_at: build.manifest_processed_at,
            file_count: build.manifest_file_count,
            file_bytes: build.manifest_file_bytes,
            error_code: build.manifest_error_code.clone(),
        },
    }
}

/// Snapshot metadata for a single file in a build manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildFileSnapshot {
    pub file_name: String,
    pub file_hash: String,
    pub file_size: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symlink_target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_meta_flags: Option<i64>,
}

/// Classification of a file path across two compared builds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BuildFileChangeStatus {
    Added,
    Removed,
    Modified,
    Unchanged,
}

/// Diff record for a single file path across base and target builds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildFileChange {
    pub path: String,
    pub status: BuildFileChangeStatus,
    pub before: Option<BuildFileSnapshot>,
    pub after: Option<BuildFileSnapshot>,
    pub size_delta_bytes: i64,
}

/// Sort direction of incoming sorted snapshot streams.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BuildComparisonDirection {
    Asc,
    Desc,
}

/// Filtering and pagination options for [`compare_build_file_snapshots`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildComparisonFilters {
    pub statuses: HashSet<BuildFileChangeStatus>,
    pub query: Option<String>,
    pub extensions: Option<HashSet<String>>,
    pub page: usize,
    pub limit: usize,
    pub direction: BuildComparisonDirection,
}

/// Global counts across all file paths in the comparison.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuildComparisonCounts {
    pub added: usize,
    pub removed: usize,
    pub modified: usize,
    pub unchanged: usize,
    pub total: usize,
}

/// Aggregate byte totals across base and target builds.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildComparisonFileBytes {
    pub base: i64,
    pub target: i64,
    pub delta: i64,
    pub added: i64,
    pub removed: i64,
    pub modified_base: i64,
    pub modified_target: i64,
}

/// Added and removed install tags between base and target builds.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuildComparisonInstallTags {
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

/// Net byte delta for a single parent directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildComparisonDirectoryDelta {
    pub path: String,
    pub size_delta_bytes: i64,
}

/// Full summary and paginated changes produced by [`compare_build_file_snapshots`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildComparisonResult {
    pub files: BuildComparisonCounts,
    pub file_bytes: BuildComparisonFileBytes,
    pub install_tags: BuildComparisonInstallTags,
    pub top_files: Vec<BuildFileChange>,
    pub top_directories: Vec<BuildComparisonDirectoryDelta>,
    pub changes: Vec<BuildFileChange>,
    pub total: usize,
}

fn canonical_tags(tags: Option<&[String]>) -> BTreeSet<&str> {
    tags.unwrap_or(&[]).iter().map(String::as_str).collect()
}

fn is_modified(before: &BuildFileSnapshot, after: &BuildFileSnapshot) -> bool {
    before.file_hash != after.file_hash
        || before.file_size != after.file_size
        || before.symlink_target.as_deref().unwrap_or("")
            != after.symlink_target.as_deref().unwrap_or("")
        || before.file_meta_flags.unwrap_or(0) != after.file_meta_flags.unwrap_or(0)
        || canonical_tags(before.install_tags.as_deref())
            != canonical_tags(after.install_tags.as_deref())
}

fn change_added(after: BuildFileSnapshot) -> BuildFileChange {
    BuildFileChange {
        path: after.file_name.clone(),
        status: BuildFileChangeStatus::Added,
        size_delta_bytes: after.file_size,
        before: None,
        after: Some(after),
    }
}

fn change_removed(before: BuildFileSnapshot) -> BuildFileChange {
    BuildFileChange {
        path: before.file_name.clone(),
        status: BuildFileChangeStatus::Removed,
        size_delta_bytes: -before.file_size,
        before: Some(before),
        after: None,
    }
}

fn change_matched(before: BuildFileSnapshot, after: BuildFileSnapshot) -> BuildFileChange {
    let status = if is_modified(&before, &after) {
        BuildFileChangeStatus::Modified
    } else {
        BuildFileChangeStatus::Unchanged
    };
    BuildFileChange {
        path: after.file_name.clone(),
        status,
        size_delta_bytes: after.file_size - before.file_size,
        before: Some(before),
        after: Some(after),
    }
}

fn file_extension(path: &str) -> String {
    let file_name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    match file_name.rfind('.') {
        Some(dot) if dot > 0 => file_name[dot + 1..].to_lowercase(),
        _ => String::new(),
    }
}

fn matches_filters(change: &BuildFileChange, filters: &BuildComparisonFilters) -> bool {
    if !filters.statuses.contains(&change.status) {
        return false;
    }
    if let Some(query) = filters.query.as_deref().filter(|q| !q.is_empty())
        && !change.path.to_lowercase().contains(&query.to_lowercase())
    {
        return false;
    }
    if let Some(extensions) = filters.extensions.as_ref().filter(|e| !e.is_empty())
        && !extensions.contains(&file_extension(&change.path))
    {
        return false;
    }
    true
}

fn parent_directory(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    match normalized.rfind('/') {
        None | Some(0) => "/".to_string(),
        Some(sep) => normalized[..sep].to_string(),
    }
}

/// Perform a bounded-memory merge-join over two file snapshot iterables sorted by
/// `fileName` in MongoDB binary byte order in `filters.direction`.
pub fn compare_build_file_snapshots<I1, I2>(
    base_files: I1,
    target_files: I2,
    filters: &BuildComparisonFilters,
) -> BuildComparisonResult
where
    I1: IntoIterator<Item = BuildFileSnapshot>,
    I2: IntoIterator<Item = BuildFileSnapshot>,
{
    let mut base_iter = base_files.into_iter();
    let mut target_iter = target_files.into_iter();
    compare_build_file_snapshots_dyn(&mut base_iter, &mut target_iter, filters)
}

fn compare_build_file_snapshots_dyn(
    base_iter: &mut dyn Iterator<Item = BuildFileSnapshot>,
    target_iter: &mut dyn Iterator<Item = BuildFileSnapshot>,
    filters: &BuildComparisonFilters,
) -> BuildComparisonResult {
    let mut before = base_iter.next();
    let mut after = target_iter.next();

    let mut counts = BuildComparisonCounts::default();
    let mut file_bytes = BuildComparisonFileBytes::default();
    let mut base_tags = BTreeSet::<String>::new();
    let mut target_tags = BTreeSet::<String>::new();
    let mut top_files = Vec::<BuildFileChange>::new();
    let mut directory_deltas = HashMap::<String, i64>::new();
    let mut directory_order = Vec::<String>::new();
    let mut changes = Vec::<BuildFileChange>::new();
    let mut filtered_total = 0usize;
    let first_row = filters.page.saturating_sub(1) * filters.limit;

    let mut record = |change: BuildFileChange| {
        match change.status {
            BuildFileChangeStatus::Added => counts.added += 1,
            BuildFileChangeStatus::Removed => counts.removed += 1,
            BuildFileChangeStatus::Modified => counts.modified += 1,
            BuildFileChangeStatus::Unchanged => counts.unchanged += 1,
        }
        counts.total += 1;

        let before_size = change.before.as_ref().map_or(0, |s| s.file_size);
        let after_size = change.after.as_ref().map_or(0, |s| s.file_size);
        file_bytes.base += before_size;
        file_bytes.target += after_size;

        if let Some(tags) = change.before.as_ref().and_then(|s| s.install_tags.as_ref()) {
            for tag in tags {
                base_tags.insert(tag.clone());
            }
        }
        if let Some(tags) = change.after.as_ref().and_then(|s| s.install_tags.as_ref()) {
            for tag in tags {
                target_tags.insert(tag.clone());
            }
        }

        match change.status {
            BuildFileChangeStatus::Added => file_bytes.added += after_size,
            BuildFileChangeStatus::Removed => file_bytes.removed += before_size,
            BuildFileChangeStatus::Modified => {
                file_bytes.modified_base += before_size;
                file_bytes.modified_target += after_size;
            }
            BuildFileChangeStatus::Unchanged => {}
        }

        if change.status != BuildFileChangeStatus::Unchanged {
            let directory = parent_directory(&change.path);
            let entry = directory_deltas.entry(directory.clone());
            if matches!(entry, std::collections::hash_map::Entry::Vacant(_)) {
                directory_order.push(directory);
            }
            *entry.or_insert(0) += change.size_delta_bytes;

            top_files.push(change.clone());
            top_files.sort_by(|left, right| {
                right
                    .size_delta_bytes
                    .abs()
                    .cmp(&left.size_delta_bytes.abs())
            });
            top_files.truncate(10);
        }

        if !matches_filters(&change, filters) {
            return;
        }
        if filtered_total >= first_row && changes.len() < filters.limit {
            changes.push(change);
        }
        filtered_total += 1;
    };

    loop {
        match (before.take(), after.take()) {
            (None, None) => break,
            (None, Some(a)) => {
                record(change_added(a));
                after = target_iter.next();
            }
            (Some(b), None) => {
                record(change_removed(b));
                before = base_iter.next();
            }
            (Some(b), Some(a)) => {
                let order = b.file_name.as_bytes().cmp(a.file_name.as_bytes());
                if order == Ordering::Equal {
                    record(change_matched(b, a));
                    before = base_iter.next();
                    after = target_iter.next();
                } else if (filters.direction == BuildComparisonDirection::Asc
                    && order == Ordering::Less)
                    || (filters.direction == BuildComparisonDirection::Desc
                        && order == Ordering::Greater)
                {
                    record(change_removed(b));
                    before = base_iter.next();
                    after = Some(a);
                } else {
                    record(change_added(a));
                    before = Some(b);
                    after = target_iter.next();
                }
            }
        }
    }

    file_bytes.delta = file_bytes.target - file_bytes.base;

    let added_tags = target_tags
        .difference(&base_tags)
        .cloned()
        .collect::<Vec<_>>();
    let removed_tags = base_tags
        .difference(&target_tags)
        .cloned()
        .collect::<Vec<_>>();

    let mut top_directories = directory_order
        .into_iter()
        .map(|path| {
            let size_delta_bytes = directory_deltas[&path];
            BuildComparisonDirectoryDelta {
                path,
                size_delta_bytes,
            }
        })
        .collect::<Vec<_>>();
    top_directories.sort_by(|left, right| {
        right
            .size_delta_bytes
            .abs()
            .cmp(&left.size_delta_bytes.abs())
    });
    top_directories.truncate(10);

    BuildComparisonResult {
        files: counts,
        file_bytes,
        install_tags: BuildComparisonInstallTags {
            added: added_tags,
            removed: removed_tags,
        },
        top_files,
        top_directories,
        changes,
        total: filtered_total,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_documents_accept_native_dates_and_integral_bson_doubles() {
        let time = bson::DateTime::from_millis(1_700_000_000_123);
        let mut row = doc! {
            "_id": ObjectId::new(), "appName": "Demo", "buildVersion": "1",
            "labelName": "Live", "hash": "hash", "createdAt": time,
            "updatedAt": "2023-11-14T22:13:20.123Z", "lastSeenAt": null,
            "manifestFileCount": 8, "downloadSizeBytes": 4_294_967_297.0,
        };
        let build: BuildDocument = bson::from_document(row.clone()).unwrap();
        assert_eq!(build.created_at, Some(time.to_chrono()));
        assert_eq!(build.updated_at, build.created_at);
        assert!(build.last_seen_at.is_none() && build.first_seen_at.is_none());
        assert_eq!(build.download_size_bytes, Some(4_294_967_297));
        assert_eq!(build.manifest_file_count, Some(8));
        for size in [-1.0, 1.5, f64::INFINITY, u64::MAX as f64] {
            row.insert("downloadSizeBytes", size);
            assert!(bson::from_document::<BuildDocument>(row.clone()).is_err());
        }
        row.insert("downloadSizeBytes", "missing");
        assert!(bson::from_document::<BuildDocument>(row.clone()).is_err());
        row.insert("downloadSizeBytes", bson::Bson::Null);
        row.insert("createdAt", 123);
        assert!(bson::from_document::<BuildDocument>(row).is_err());
        let mut invalid = serde_json::Deserializer::from_str("{");
        assert!(build_date(&mut invalid).is_err());
    }

    #[test]
    fn archived_json_build_values_validate_dates_and_byte_counts() {
        for (input, expected) in [
            ("null", Ok(None)),
            ("{\"$date\":{\"$numberLong\":\"0\"}}", Ok(Some(0))),
            ("\"1970-01-01T00:00:00Z\"", Ok(Some(0))),
            ("\"invalid\"", Err(())),
            ("true", Err(())),
            ("{", Err(())),
        ] {
            let value = build_date(&mut serde_json::Deserializer::from_str(input));
            assert_eq!(
                value
                    .map(|date| date.map(|d| d.timestamp_millis()))
                    .map_err(|_| ()),
                expected
            );
        }
        for (input, expected) in [
            ("null", Ok(None)),
            ("23", Ok(Some(23))),
            ("23.0", Ok(Some(23))),
            ("1.5", Err(())),
            ("-1", Err(())),
            ("\"42\"", Err(())),
        ] {
            let value = build_count(&mut serde_json::Deserializer::from_str(input));
            assert_eq!(value.map_err(|_| ()), expected);
        }
    }

    fn snap(name: &str, hash: &str, size: i64) -> BuildFileSnapshot {
        BuildFileSnapshot {
            file_name: name.to_string(),
            file_hash: hash.to_string(),
            file_size: size,
            mime_type: None,
            install_tags: None,
            symlink_target: None,
            file_meta_flags: None,
        }
    }

    fn all_statuses_filters() -> BuildComparisonFilters {
        BuildComparisonFilters {
            statuses: HashSet::from([
                BuildFileChangeStatus::Added,
                BuildFileChangeStatus::Removed,
                BuildFileChangeStatus::Modified,
                BuildFileChangeStatus::Unchanged,
            ]),
            query: None,
            extensions: None,
            page: 1,
            limit: 50,
            direction: BuildComparisonDirection::Asc,
        }
    }

    fn sample_build() -> BuildDocument {
        BuildDocument {
            id: ObjectId::parse_str("67141fcefb3045682a6fbf19").unwrap(),
            app_name: "TestApp".into(),
            build_version: "1.0".into(),
            label_name: "Live-Windows".into(),
            platform: None,
            hash: "source-hash".into(),
            source_manifest_hash: None,
            manifest_id: None,
            manifest_status: None,
            manifest_parser_version: None,
            manifest_processed_at: None,
            manifest_file_count: None,
            manifest_file_bytes: None,
            manifest_error_code: None,
            first_seen_at: None,
            last_seen_at: None,
            previous_observed_build_id: None,
            technologies: None,
            download_size_bytes: None,
            installed_size_bytes: None,
            created_at: None,
            updated_at: None,
        }
    }

    #[test]
    fn normalize_build_tree_path_accepts_and_rejects_correctly() {
        assert_eq!(normalize_build_tree_path(None), Some(String::new()));
        assert_eq!(normalize_build_tree_path(Some("")), Some(String::new()));
        assert_eq!(normalize_build_tree_path(Some("/")), Some(String::new()));
        assert_eq!(
            normalize_build_tree_path(Some("Engine/Binaries/")),
            Some("Engine/Binaries".to_string())
        );
        assert_eq!(
            normalize_build_tree_path(Some("Engine/Binaries")),
            Some("Engine/Binaries".to_string())
        );

        for invalid in [
            "/Engine",
            "Engine\\Binaries",
            "Engine//Binaries",
            "Engine/../Config",
            "./Engine",
            "Engine/./Binaries",
            "a\0b",
        ] {
            assert_eq!(normalize_build_tree_path(Some(invalid)), None);
        }

        let too_long = "a".repeat(501);
        assert_eq!(normalize_build_tree_path(Some(&too_long)), None);
    }

    #[test]
    fn build_pagination_parses_and_bounds_offsets() {
        assert_eq!(parse_build_integer(None, 25, 100), Some(25));
        assert_eq!(parse_build_integer(Some("10"), 25, 100), Some(10));
        assert_eq!(parse_build_integer(Some("0"), 25, 100), None);
        assert_eq!(parse_build_integer(Some("101"), 25, 100), None);
        assert_eq!(parse_build_integer(Some(""), 25, 100), None);
        assert_eq!(parse_build_integer(Some("10foo"), 25, 100), None);
        assert_eq!(parse_build_integer(Some("1.5"), 25, 100), None);
        assert_eq!(parse_build_integer(Some("1e2"), 25, 100), None);
        assert_eq!(parse_build_integer(Some("0x10"), 25, 100), None);
        assert_eq!(
            parse_build_integer(Some("99999999999999999999999"), 25, 100),
            None
        );

        assert_eq!(
            parse_build_integer(Some(&MAX_BUILD_PAGE.to_string()), 1, MAX_BUILD_PAGE),
            Some(MAX_BUILD_PAGE)
        );
        assert_eq!(build_pagination_offset(1_001, 100), Some(100_000));
        assert_eq!(build_pagination_offset(1_002, 100), None);
        assert_eq!(build_pagination_offset(0, 100), None);
        assert_eq!(build_pagination_offset(u64::MAX, 2), None);
    }

    #[test]
    fn builds_helpers_handle_platform_snapshot_query_and_summary() {
        let mut legacy = sample_build();
        legacy.manifest_status = Some(ManifestStatus::LegacyUnverified);
        legacy.manifest_id = Some("legacy:canonical".into());
        legacy.source_manifest_hash = Some("legacy-source-hash".into());
        assert_eq!(
            build_snapshot_query(&legacy),
            doc! { "manifestHash": "legacy-source-hash" }
        );

        let mut older_legacy = sample_build();
        older_legacy.manifest_id = Some("legacy:canonical".into());
        assert_eq!(
            build_snapshot_query(&older_legacy),
            doc! { "manifestHash": "source-hash" }
        );

        let mut verified = sample_build();
        verified.manifest_status = Some(ManifestStatus::Verified);
        verified.manifest_id = Some("canonical-hash".into());
        verified.platform = Some("Mac".into());
        verified.download_size_bytes = Some(100);
        verified.installed_size_bytes = Some(200);
        assert_eq!(
            build_snapshot_query(&verified),
            doc! { "manifestId": { "$eq": "canonical-hash", "$type": "string" } }
        );
        assert_eq!(effective_build_platform(&verified), "Mac");

        let mut verified_no_id = sample_build();
        verified_no_id.manifest_status = Some(ManifestStatus::Verified);
        verified_no_id.manifest_id = Some(String::new());
        assert_eq!(
            build_snapshot_query(&verified_no_id),
            doc! { "manifestHash": "source-hash" }
        );

        let asset = BuildAssetSizes {
            download_size_bytes: Some(999),
            installed_size_bytes: Some(999),
        };
        let s1 = build_summary(&verified, Some(&asset));
        assert_eq!(s1.download_size_bytes, Some(100));
        assert_eq!(s1.installed_size_bytes, Some(200));
        assert_eq!(s1.manifest.status, ManifestStatus::Verified);
        assert_eq!(
            s1.manifest.canonical_hash.as_deref(),
            Some("canonical-hash")
        );

        let s2 = build_summary(&sample_build(), Some(&asset));
        assert_eq!(s2.platform, "Windows");
        assert_eq!(s2.download_size_bytes, Some(999));
        assert_eq!(s2.installed_size_bytes, Some(999));
        assert_eq!(s2.manifest.status, ManifestStatus::LegacyUnverified);
    }

    #[test]
    fn compare_build_file_snapshots_covers_merge_join_filters_and_pagination() {
        let base = vec![
            snap("A.txt", "old", 10),
            snap("B.bin", "same", 20),
            snap("Removed.pak", "removed", 30),
        ];
        let target = vec![
            snap("A.txt", "new", 15),
            snap("Added.dll", "added", 40),
            snap("B.bin", "same", 20),
        ];

        let res = compare_build_file_snapshots(base, target, &all_statuses_filters());
        assert_eq!(
            res.files,
            BuildComparisonCounts {
                added: 1,
                removed: 1,
                modified: 1,
                unchanged: 1,
                total: 4,
            }
        );
        assert_eq!(res.file_bytes.base, 60);
        assert_eq!(res.file_bytes.target, 75);
        assert_eq!(res.file_bytes.delta, 15);
        assert_eq!(res.file_bytes.added, 40);
        assert_eq!(res.file_bytes.removed, 30);
        assert_eq!(res.file_bytes.modified_base, 10);
        assert_eq!(res.file_bytes.modified_target, 15);
        assert_eq!(
            res.changes
                .iter()
                .map(|c| (c.path.as_str(), c.status))
                .collect::<Vec<_>>(),
            vec![
                ("A.txt", BuildFileChangeStatus::Modified),
                ("Added.dll", BuildFileChangeStatus::Added),
                ("B.bin", BuildFileChangeStatus::Unchanged),
                ("Removed.pak", BuildFileChangeStatus::Removed),
            ]
        );
    }

    #[test]
    fn compare_detects_semantic_modifications_and_binary_order_and_desc_pagination() {
        let mut s_base = snap("A", "same", 1);
        s_base.install_tags = Some(vec!["base".into()]);
        s_base.symlink_target = Some("old".into());
        s_base.file_meta_flags = Some(1);

        let mut s_target = snap("A", "same", 1);
        s_target.install_tags = Some(vec!["target".into()]);
        s_target.symlink_target = Some("new".into());
        s_target.file_meta_flags = Some(2);

        let tag_res = compare_build_file_snapshots([s_base], [s_target], &all_statuses_filters());
        assert_eq!(tag_res.files.modified, 1);
        assert_eq!(tag_res.install_tags.added, vec!["target"]);
        assert_eq!(tag_res.install_tags.removed, vec!["base"]);

        // Descending + pagination + root directory + filters
        let desc_res = compare_build_file_snapshots(
            [
                snap("D/root.bin", "removed", 40),
                snap("B/keep.bin", "same", 5),
                snap("A/change.bin", "old", 10),
            ],
            [
                snap("C/added.bin", "added", 30),
                snap("B/keep.bin", "same", 5),
                snap("A/change.bin", "new", 25),
            ],
            &BuildComparisonFilters {
                page: 2,
                limit: 2,
                direction: BuildComparisonDirection::Desc,
                ..all_statuses_filters()
            },
        );
        assert_eq!(desc_res.total, 4);
        assert_eq!(
            desc_res
                .changes
                .iter()
                .map(|c| c.path.as_str())
                .collect::<Vec<_>>(),
            vec!["B/keep.bin", "A/change.bin"]
        );
        assert_eq!(
            desc_res
                .top_files
                .iter()
                .map(|c| c.path.as_str())
                .collect::<Vec<_>>(),
            vec!["D/root.bin", "C/added.bin", "A/change.bin"]
        );
        assert_eq!(
            desc_res.top_directories,
            vec![
                BuildComparisonDirectoryDelta {
                    path: "D".into(),
                    size_delta_bytes: -40,
                },
                BuildComparisonDirectoryDelta {
                    path: "C".into(),
                    size_delta_bytes: 30,
                },
                BuildComparisonDirectoryDelta {
                    path: "A".into(),
                    size_delta_bytes: 15,
                },
            ]
        );

        // Query + extension + status filters & trailing target/base exhaustion + >10 files truncation
        let mut many_target = Vec::new();
        for i in 0..12 {
            many_target.push(snap(&format!("/top/f{i:02}.DLL"), "h", (i + 1) * 10));
        }
        many_target.push(snap(".hidden", "h", 5));

        let filtered = compare_build_file_snapshots(
            [snap("only_base.pak", "b", 1)],
            many_target,
            &BuildComparisonFilters {
                statuses: HashSet::from([BuildFileChangeStatus::Added]),
                query: Some("f1".into()),
                extensions: Some(HashSet::from(["dll".into()])),
                page: 1,
                limit: 5,
                direction: BuildComparisonDirection::Asc,
            },
        );
        assert_eq!(filtered.files.added, 13);
        assert_eq!(filtered.files.removed, 1);
        assert_eq!(filtered.top_files.len(), 10);
        assert_eq!(filtered.total, 2);
        assert_eq!(
            filtered
                .changes
                .iter()
                .map(|c| c.path.as_str())
                .collect::<Vec<_>>(),
            vec!["/top/f10.DLL", "/top/f11.DLL"]
        );

        // Query mismatch and extension mismatch on dotless/dot-prefix file
        let no_ext_filtered = compare_build_file_snapshots(
            [],
            [snap("README", "r", 1)],
            &BuildComparisonFilters {
                statuses: HashSet::from([BuildFileChangeStatus::Added]),
                query: Some("zzz".into()),
                extensions: Some(HashSet::from(["txt".into()])),
                page: 1,
                limit: 5,
                direction: BuildComparisonDirection::Asc,
            },
        );
        assert_eq!(no_ext_filtered.total, 0);

        let ext_mismatch = compare_build_file_snapshots(
            [],
            [snap("README", "r", 1)],
            &BuildComparisonFilters {
                statuses: HashSet::from([BuildFileChangeStatus::Added]),
                query: None,
                extensions: Some(HashSet::from(["txt".into()])),
                page: 1,
                limit: 5,
                direction: BuildComparisonDirection::Asc,
            },
        );
        assert_eq!(ext_mismatch.total, 0);

        // Base exhausted while target still has trailing files & empty query/extensions & root "/file"
        let trailing_target = compare_build_file_snapshots(
            [snap("A.txt", "a", 10)],
            [snap("A.txt", "a", 10), snap("/root.txt", "b", 20)],
            &BuildComparisonFilters {
                statuses: HashSet::from([
                    BuildFileChangeStatus::Added,
                    BuildFileChangeStatus::Unchanged,
                ]),
                query: Some(String::new()),
                extensions: Some(HashSet::new()),
                page: 1,
                limit: 1,
                direction: BuildComparisonDirection::Asc,
            },
        );
        assert_eq!(trailing_target.total, 2);
        assert_eq!(trailing_target.top_directories[0].path, "/");

        // Serde roundtrips for build types
        let res_rt: BuildComparisonResult =
            serde_json::from_value(serde_json::to_value(&trailing_target).unwrap()).unwrap();
        assert_eq!(res_rt, trailing_target);
        let dir_rt: BuildComparisonDirection = serde_json::from_str(r#""desc""#).unwrap();
        assert_eq!(dir_rt, BuildComparisonDirection::Desc);
        let doc_rt: BuildDocument =
            serde_json::from_value(serde_json::to_value(sample_build()).unwrap()).unwrap();
        assert_eq!(doc_rt.app_name, "TestApp");
        let sum = build_summary(&sample_build(), None);
        let sum_rt: BuildSummary =
            serde_json::from_value(serde_json::to_value(&sum).unwrap()).unwrap();
        assert_eq!(sum_rt, sum);
        let asset_rt: BuildAssetSizes =
            serde_json::from_str(r#"{"downloadSizeBytes":1,"installedSizeBytes":2}"#).unwrap();
        assert_eq!(asset_rt.download_size_bytes, Some(1));
        let tech_rt: BuildTechnology =
            serde_json::from_str(r#"{"section":"Engine","technology":"UE5"}"#).unwrap();
        assert_eq!(tech_rt.technology, "UE5");
    }
}
