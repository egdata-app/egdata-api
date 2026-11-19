//! Shared build summary, comparison and tree helpers.

use std::collections::{HashMap, HashSet};

use bson::{Bson, Document, doc};
use futures::StreamExt;
use egdata_core::builds::{
    BuildComparisonCounts, BuildComparisonDirection, BuildFileChangeStatus,
};
use egdata_core::ports::MongoFindOptions;
use egdata_core::v1::ProblemError;
use serde_json::{Value, json};

use crate::state::AppState;

pub mod stored;


pub fn stored_build_summary(
    row: &Value,
    asset: Option<&Value>,
) -> Result<Value, ProblemError> {
    let mut summary = build_summary(row, asset);
    if row["_id"].is_null() || (row["platform"].is_null() && !row["labelName"].is_string()) {
        return Err(crate::shared::system::internal_error());
    }
    if !row["platform"].is_null() {
        summary["platform"] = row["platform"].clone();
    }
    let obj = summary.as_object_mut().unwrap();
    let id = egdata_core::v1::serialization::js_string(&row["_id"]);
    obj.insert("id".into(), json!(id));
    obj.insert("_id".into(), json!(id));
    Ok(summary)
}

pub fn tree_group_pipeline(
    snapshot: Document,
    path: &str,
    prefix_regex: impl FnOnce(&str) -> Bson,
) -> Vec<Document> {
    let child_prefix = if path.is_empty() {
        String::new()
    } else {
        format!("{path}/")
    };
    let path_filter = if child_prefix.is_empty() {
        doc! {"fileName": {"$type": "string"}}
    } else {
        doc! {"fileName": {"$regex": prefix_regex(&child_prefix)}}
    };
    let relative_path = if child_prefix.is_empty() {
        Bson::String("$fileName".into())
    } else {
        Bson::Document(
            doc! {"$replaceOne": {"input": "$fileName", "find": &child_prefix, "replacement": ""}},
        )
    };
    vec![
        doc! {"$match": {"$and": [snapshot, path_filter]}},
        doc! {"$set": {"relativePath": relative_path}},
        doc! {"$set": {"nodeType": {"$cond": [{"$regexMatch": {"input": "$relativePath", "regex": "/"}}, "directory", "file"]}, "nodeName": {"$arrayElemAt": [{"$split": ["$relativePath", "/"]}, 0]}}},
        doc! {"$group": {"_id": {"type": "$nodeType", "name": "$nodeName"}, "fileCount": {"$sum": 1}, "totalSize": {"$sum": {"$ifNull": ["$fileSize", 0]}}, "file": {"$first": "$$ROOT"}}},
    ]
}

pub fn tree_projection() -> Document {
    doc! {"$project": {
        "_id": 0,
        "type": "$_id.type",
        "name": "$_id.name",
        "fileCount": {"$cond": [{"$eq": ["$_id.type", "directory"]}, "$fileCount", "$$REMOVE"]},
        "totalSize": {"$cond": [{"$eq": ["$_id.type", "directory"]}, "$totalSize", "$$REMOVE"]},
        "file": {"$cond": [{"$eq": ["$_id.type", "file"]}, {
            "_id": "$file._id", "manifestHash": "$file.manifestHash", "manifestId": "$file.manifestId",
            "snapshotVerification": "$file.snapshotVerification", "appName": "$file.appName",
            "buildVersion": "$file.buildVersion", "appLabel": "$file.appLabel", "fileName": "$file.fileName",
            "symlinkTarget": "$file.symlinkTarget", "fileHash": "$file.fileHash", "fileMetaFlags": "$file.fileMetaFlags",
            "installTags": "$file.installTags", "fileSize": "$file.fileSize", "mimeType": "$file.mimeType", "depth": "$file.depth",
        }, "$$REMOVE"]},
    }}
}

pub struct StreamComparison {
    pub counts: BuildComparisonCounts,
    pub bytes: SnapshotBytes,
    pub install_tags: Value,
    pub top_files: Vec<SnapshotChange>,
    pub top_directories: Vec<DirectoryDelta>,
    pub changes: Vec<SnapshotChange>,
    pub has_more: bool,
    pub filtered_count: usize,
}

pub struct CompareStreamFilters<'a> {
    pub offset: usize,
    pub statuses: &'a HashSet<BuildFileChangeStatus>,
    pub query: Option<&'a str>,
    pub extensions: &'a Option<HashSet<String>>,
    pub direction: BuildComparisonDirection,
    pub after_path: Option<&'a str>,
    pub limit: usize,
}

pub async fn read_comparison(
    state: &AppState,
    base: &Document,
    target: &Document,
    filters: CompareStreamFilters<'_>,
) -> Result<StreamComparison, ProblemError> {
    let projection = doc! {"_id":0,"fileName":1,"fileHash":1,"fileSize":1,"mimeType":1,"installTags":1,"symlinkTarget":1,"fileMetaFlags":1};
    let sort = doc! {"fileName": if filters.direction==BuildComparisonDirection::Asc {1}else{-1}};
    let options = MongoFindOptions {
        projection: Some(projection),
        sort: Some(sort),
        ..Default::default()
    };
    let load_error = |_| crate::shared::system::internal_error();
    let before = state
        .mongo
        .find_stream("files", stored::snapshot_filter(base), options.clone())
        .await
        .map_err(load_error)?;
    let after = state
        .mongo
        .find_stream("files", stored::snapshot_filter(target), options)
        .await
        .map_err(load_error)?;
    compare_snapshot_streams(before, after, filters).await
}

pub fn wire_number(n: f64) -> Value {
    if n.abs() <= (1u64 << 53) as f64 && n.fract() == 0. {
        json!(n as i64)
    } else {
        json!(n)
    }
}

#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotBytes {
    pub base: SnapshotSum,
    pub target: SnapshotSum,
    pub delta: SnapshotSum,
    pub added: SnapshotSum,
    pub removed: SnapshotSum,
    pub modified_base: SnapshotSum,
    pub modified_target: SnapshotSum,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotChange {
    pub path: String,
    pub status: BuildFileChangeStatus,
    pub before: Option<std::sync::Arc<StoredSnapshot>>,
    pub after: Option<std::sync::Arc<StoredSnapshot>>,
    #[serde(serialize_with = "serialize_delta")]
    pub size_delta_bytes: f64,
}

pub fn serialize_delta<S: serde::Serializer>(n: &f64, s: S) -> Result<S::Ok, S::Error> {
    serde::Serialize::serialize(&wire_number(*n), s)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryDelta {
    path: String,
    #[serde(serialize_with = "serialize_delta")]
    size_delta_bytes: f64,
}

pub fn build_summary(build: &Value, asset: Option<&Value>) -> Value {
    let first_seen = build
        .get("firstSeenAt")
        .filter(|v| !v.is_null())
        .or_else(|| build.get("createdAt"))
        .cloned()
        .unwrap_or(Value::Null);
    let last_seen = build
        .get("lastSeenAt")
        .filter(|v| !v.is_null())
        .or_else(|| build.get("updatedAt"))
        .cloned()
        .unwrap_or(Value::Null);
    let download = build
        .get("downloadSizeBytes")
        .filter(|v| !v.is_null())
        .cloned()
        .or_else(|| {
            asset
                .and_then(|v| v.get("downloadSizeBytes"))
                .filter(|v| v.is_number())
                .cloned()
        })
        .unwrap_or(Value::Null);
    let installed = build
        .get("installedSizeBytes")
        .filter(|v| !v.is_null())
        .cloned()
        .or_else(|| {
            asset
                .and_then(|v| v.get("installedSizeBytes"))
                .filter(|v| v.is_number())
                .cloned()
        })
        .unwrap_or(Value::Null);
    json!({"id":build.get("_id").cloned().unwrap_or(Value::Null),"_id":build.get("_id").cloned().unwrap_or(Value::Null),"appName":build.get("appName").cloned().unwrap_or(Value::Null),"buildVersion":build.get("buildVersion").cloned().unwrap_or(Value::Null),"labelName":build.get("labelName").cloned().unwrap_or(Value::Null),"platform":build_platform(build),"hash":build.get("hash").cloned().unwrap_or(Value::Null),"firstSeenAt":first_seen,"lastSeenAt":last_seen,"createdAt":build.get("createdAt").cloned().unwrap_or(Value::Null),"updatedAt":build.get("updatedAt").cloned().unwrap_or(Value::Null),"downloadSizeBytes":download,"installedSizeBytes":installed,"technologies":build.get("technologies").filter(|v| !v.is_null()).cloned().unwrap_or(json!([])),"manifest":{"status":build.get("manifestStatus").filter(|v| !v.is_null()).cloned().unwrap_or(json!("legacy_unverified")),"canonicalHash":build.get("manifestId").cloned().unwrap_or(Value::Null),"sourceHash":build.get("sourceManifestHash").filter(|v| !v.is_null()).or_else(||build.get("hash")).cloned().unwrap_or(Value::Null),"parserVersion":build.get("manifestParserVersion").cloned().unwrap_or(Value::Null),"processedAt":build.get("manifestProcessedAt").cloned().unwrap_or(Value::Null),"fileCount":build.get("manifestFileCount").cloned().unwrap_or(Value::Null),"fileBytes":build.get("manifestFileBytes").cloned().unwrap_or(Value::Null),"errorCode":build.get("manifestErrorCode").cloned().unwrap_or(Value::Null)}})
}

#[derive(Clone)]
pub enum SnapshotSum {
    Number(f64),
    Text(String),
}

#[derive(Clone)]
pub struct StoredSnapshot {
    fields: Document,
    file_size: SnapshotSum,
    install_tags: SnapshotTags,
}

pub async fn compare_snapshot_streams<S1, S2>(
    mut base: S1,
    mut target: S2,
    filters: CompareStreamFilters<'_>,
) -> Result<StreamComparison, ProblemError>
where
    S1: futures::Stream<Item = Result<Document, egdata_core::error::CoreError>> + Unpin,
    S2: futures::Stream<Item = Result<Document, egdata_core::error::CoreError>> + Unpin,
{
    let mut before = next_snapshot(&mut base).await?;
    let mut after = next_snapshot(&mut target).await?;
    let (mut counts, mut bytes) = (BuildComparisonCounts::default(), SnapshotBytes::default());
    let (mut base_tags, mut target_tags) = (SnapshotTags::default(), SnapshotTags::default());
    let mut top_files = Vec::<SnapshotChange>::new();
    let mut directories = HashMap::<String, f64>::new();
    let mut directory_order = Vec::<String>::new();
    let mut changes = Vec::<SnapshotChange>::new();
    let mut has_more = false;
    let mut filtered_count = 0;
    let mut record =
        |change: SnapshotChange| {
            match change.status {
                BuildFileChangeStatus::Added => counts.added += 1,
                BuildFileChangeStatus::Removed => counts.removed += 1,
                BuildFileChangeStatus::Modified => counts.modified += 1,
                BuildFileChangeStatus::Unchanged => counts.unchanged += 1,
            }
            counts.total += 1;
            let zero = SnapshotSum::default();
            let bs = change.before.as_ref().map_or(&zero, |f| &f.file_size);
            let ts = change.after.as_ref().map_or(&zero, |f| &f.file_size);
            bytes.base.add(bs);
            bytes.target.add(ts);
            if let Some(file) = &change.before {
                for tag in &file.install_tags.values {
                    base_tags.insert(tag);
                }
            }
            if let Some(file) = &change.after {
                for tag in &file.install_tags.values {
                    target_tags.insert(tag);
                }
            }
            match change.status {
                BuildFileChangeStatus::Added => bytes.added.add(ts),
                BuildFileChangeStatus::Removed => bytes.removed.add(bs),
                BuildFileChangeStatus::Modified => {
                    bytes.modified_base.add(bs);
                    bytes.modified_target.add(ts);
                }
                BuildFileChangeStatus::Unchanged => {}
            }
            if change.status != BuildFileChangeStatus::Unchanged {
                let normalized = change.path.replace('\\', "/");
                let directory = normalized
                    .rfind('/')
                    .map_or("/", |i| if i == 0 { "/" } else { &normalized[..i] })
                    .to_string();
                if !directories.contains_key(&directory) {
                    directory_order.push(directory.clone());
                }
                *directories.entry(directory).or_default() += change.size_delta_bytes;
                top_files.push(change.clone());
                top_files.sort_by(|a, b| {
                    b.size_delta_bytes
                        .abs()
                        .partial_cmp(&a.size_delta_bytes.abs())
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
                top_files.truncate(10);
            }
            if !filters.statuses.contains(&change.status) {
                return;
            }
            if filters
                .query
                .is_some_and(|q| !change.path.to_lowercase().contains(q))
            {
                return;
            }
            if filters.extensions.as_ref().is_some_and(|set| {
                !set.is_empty() && !set.contains(&snapshot_extension(&change.path))
            }) {
                return;
            }
            filtered_count += 1;
            if let Some(cursor) = filters.after_path {
                let order = change.path.as_bytes().cmp(cursor.as_bytes());
                if (filters.direction == BuildComparisonDirection::Asc
                    && order != std::cmp::Ordering::Greater)
                    || (filters.direction == BuildComparisonDirection::Desc
                        && order != std::cmp::Ordering::Less)
                {
                    return;
                }
            }
            if filtered_count <= filters.offset {
                return;
            }
            if changes.len() < filters.limit {
                changes.push(change);
            } else {
                has_more = true;
            }
        };
    loop {
        match (before.take(), after.take()) {
            (None, None) => break,
            (None, Some(a)) => {
                record(snapshot_change(None, Some(a), BuildFileChangeStatus::Added));
                after = next_snapshot(&mut target).await?;
            }
            (Some(b), None) => {
                record(snapshot_change(
                    Some(b),
                    None,
                    BuildFileChangeStatus::Removed,
                ));
                before = next_snapshot(&mut base).await?;
            }
            (Some(b), Some(a))
                if b.fields.get_str("fileName").is_err()
                    || a.fields.get_str("fileName").is_err() =>
            {
                return Err(crate::shared::system::internal_error());
            }
            (Some(b), Some(a)) => match b.file_name().as_bytes().cmp(a.file_name().as_bytes()) {
                std::cmp::Ordering::Equal => {
                    let status = if snapshot_changed(&b, &a)? {
                        BuildFileChangeStatus::Modified
                    } else {
                        BuildFileChangeStatus::Unchanged
                    };
                    record(snapshot_change(Some(b), Some(a), status));
                    before = next_snapshot(&mut base).await?;
                    after = next_snapshot(&mut target).await?;
                }
                order
                    if (filters.direction == BuildComparisonDirection::Asc
                        && order == std::cmp::Ordering::Less)
                        || (filters.direction == BuildComparisonDirection::Desc
                            && order == std::cmp::Ordering::Greater) =>
                {
                    record(snapshot_change(
                        Some(b),
                        None,
                        BuildFileChangeStatus::Removed,
                    ));
                    before = next_snapshot(&mut base).await?;
                    after = Some(a);
                }
                _ => {
                    record(snapshot_change(None, Some(a), BuildFileChangeStatus::Added));
                    before = Some(b);
                    after = next_snapshot(&mut target).await?;
                }
            },
        }
    }
    bytes.delta = SnapshotSum::Number(bytes.target.number() - bytes.base.number());
    let mut top_directories = directory_order
        .into_iter()
        .map(|path| DirectoryDelta {
            size_delta_bytes: directories[&path],
            path,
        })
        .collect::<Vec<_>>();
    top_directories.sort_by(|a, b| {
        b.size_delta_bytes
            .abs()
            .partial_cmp(&a.size_delta_bytes.abs())
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    top_directories.truncate(10);
    let install_tags = json!({"added":target_tags.difference(&base_tags)?,"removed":base_tags.difference(&target_tags)?});
    Ok(StreamComparison {
        counts,
        bytes,
        install_tags,
        top_files,
        top_directories,
        changes,
        has_more,
        filtered_count,
    })
}

pub fn build_platform(build: &Value) -> String {
    build
        .get("platform")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            build
                .get("labelName")
                .and_then(Value::as_str)
                .and_then(|s| s.rsplit('-').next())
                .unwrap_or("Unknown")
                .to_owned()
        })
}

#[derive(Clone, Default)]
pub struct SnapshotTags {
    seen: HashSet<TagKey>,
    values: Vec<Bson>,
}

pub fn snapshot_changed(a: &StoredSnapshot, b: &StoredSnapshot) -> Result<bool, ProblemError> {
    fn field_or<'a>(doc: &'a Document, key: &str, default: &'a Bson) -> &'a Bson {
        doc.get(key)
            .filter(|v| !matches!(v, Bson::Null | Bson::Undefined))
            .unwrap_or(default)
    }
    let same_fallback = |key, default| {
        same_snapshot_field(
            Some(field_or(&a.fields, key, &default)),
            Some(field_or(&b.fields, key, &default)),
        )
    };
    if !same_snapshot_field(a.fields.get("fileHash"), b.fields.get("fileHash"))
        || !same_snapshot_field(a.fields.get("fileSize"), b.fields.get("fileSize"))
        || !same_fallback("symlinkTarget", Bson::String(String::new()))
        || !same_fallback("fileMetaFlags", Bson::Int32(0))
    {
        return Ok(true);
    }
    let left = SnapshotTags::sorted(a.install_tags.values.iter())?;
    let right = SnapshotTags::sorted(b.install_tags.values.iter())?;
    Ok(left.len() != right.len()
        || left
            .iter()
            .zip(right)
            .any(|(l, r)| !same_snapshot_field(Some(l), Some(r))))
}

pub fn snapshot_change(
    before: Option<StoredSnapshot>,
    after: Option<StoredSnapshot>,
    status: BuildFileChangeStatus,
) -> SnapshotChange {
    let path = after
        .as_ref()
        .or(before.as_ref())
        .map(|f| f.file_name().to_owned())
        .unwrap_or_default();
    let size_delta_bytes = after.as_ref().map_or(0., |f| f.file_size.number())
        - before.as_ref().map_or(0., |f| f.file_size.number());
    SnapshotChange {
        path,
        status,
        before: before.map(std::sync::Arc::new),
        after: after.map(std::sync::Arc::new),
        size_delta_bytes,
    }
}

pub fn snapshot_extension(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    name.rfind('.')
        .filter(|index| *index > 0)
        .map_or_else(String::new, |index| name[index + 1..].to_lowercase())
}

pub async fn next_snapshot<S>(stream: &mut S) -> Result<Option<StoredSnapshot>, ProblemError>
where
    S: futures::Stream<Item = Result<Document, egdata_core::error::CoreError>> + Unpin,
{
    match stream.next().await {
        None => Ok(None),
        Some(Err(_)) => Err(crate::shared::system::internal_error()),
        Some(Ok(row)) => StoredSnapshot::from_document(row).map(Some),
    }
}

#[derive(Clone, Hash, Eq, PartialEq)]
pub enum TagKey {
    Null,
    Bool(bool),
    Number(u64),
    Text(String),
}

pub fn same_snapshot_field(left: Option<&Bson>, right: Option<&Bson>) -> bool {
    !matches!(left,Some(Bson::Double(n)) if n.is_nan()) && stored::same_field(left, right)
}

impl SnapshotSum {
    fn from_size(size: Option<&Bson>) -> Result<Self, ProblemError> {
        Ok(match size {
            None | Some(Bson::Null | Bson::Undefined) => Self::default(),
            Some(Bson::Int32(v)) => Self::Number((*v).into()),
            Some(Bson::Int64(v)) if v.unsigned_abs() <= 1 << 53 => Self::Number(*v as f64),
            Some(Bson::Double(v)) => Self::Number(*v),
            Some(Bson::Boolean(v)) => Self::Number(f64::from(u8::from(*v))),
            Some(value) => Self::Text(snapshot_string(value)?),
        })
    }
    pub fn number(&self) -> f64 {
        match self {
            Self::Number(n) => *n,
            Self::Text(t) => egdata_core::v1::serialization::js_string_number(t),
        }
    }
    fn add(&mut self, other: &Self) {
        use egdata_core::v1::query::format_js_number;
        match (&mut *self, other) {
            (Self::Number(a), Self::Number(b)) => *a += b,
            (Self::Text(a), Self::Number(b)) => a.push_str(&format_js_number(*b)),
            (Self::Text(a), Self::Text(b)) => a.push_str(b),
            (Self::Number(a), Self::Text(b)) => {
                *self = Self::Text(format!("{}{b}", format_js_number(*a)))
            }
        }
    }
}

impl SnapshotTags {
    fn insert(&mut self, tag: &Bson) {
        if tag_key(tag).is_none_or(|key| self.seen.insert(key)) {
            self.values.push(tag.clone());
        }
    }

    fn sorted<'a>(values: impl Iterator<Item = &'a Bson>) -> Result<Vec<&'a Bson>, ProblemError> {
        let mut values = values.collect::<Vec<_>>();
        if values.len() > 1 {
            let mut keys = values
                .into_iter()
                .map(|v| Ok((snapshot_string(v)?, v)))
                .collect::<Result<Vec<_>, ProblemError>>()?;
            keys.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
            values = keys.into_iter().map(|(_, v)| v).collect();
        }
        Ok(values)
    }
    fn difference(&self, other: &Self) -> Result<Vec<Value>, ProblemError> {
        Ok(Self::sorted(
            self.values
                .iter()
                .filter(|v| !tag_key(v).is_some_and(|key| other.seen.contains(&key))),
        )?
        .into_iter()
        .map(egdata_infra::bson_json::bson_to_js_json)
        .collect())
    }
}

impl Default for SnapshotSum {
    fn default() -> Self {
        Self::Number(0.)
    }
}

impl serde::Serialize for SnapshotSum {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Number(n) => wire_number(*n).serialize(s),
            Self::Text(t) => s.serialize_str(t),
        }
    }
}

impl serde::Serialize for StoredSnapshot {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let object = self
            .fields
            .iter()
            .filter(|(key, v)| {
                matches!(
                    key.as_str(),
                    "fileName"
                        | "fileHash"
                        | "fileSize"
                        | "mimeType"
                        | "installTags"
                        | "symlinkTarget"
                        | "fileMetaFlags"
                ) && !matches!(v, Bson::Undefined)
            })
            .map(|(k, v)| (k.clone(), egdata_infra::bson_json::bson_to_js_json(v)))
            .collect();
        Value::Object(object).serialize(serializer)
    }
}

impl StoredSnapshot {
    fn file_name(&self) -> &str {
        self.fields.get_str("fileName").unwrap_or_default()
    }

    fn from_document(fields: Document) -> Result<Self, ProblemError> {
        if fields
            .get("fileName")
            .is_some_and(|v| !matches!(v, Bson::String(_) | Bson::Null))
        {
            return Err(crate::shared::system::internal_error());
        }
        let file_size = SnapshotSum::from_size(fields.get("fileSize"))?;
        let mut install_tags = SnapshotTags::default();
        match fields.get("installTags") {
            None | Some(Bson::Null | Bson::Undefined) => {}
            Some(Bson::String(s)) => {
                for ch in s.chars() {
                    install_tags.insert(&Bson::String(ch.to_string()))
                }
            }
            Some(Bson::Array(tags)) => {
                for tag in tags {
                    install_tags.insert(tag)
                }
            }
            _ => return Err(crate::shared::system::internal_error()),
        }
        Ok(Self {
            fields,
            file_size,
            install_tags,
        })
    }
}

pub fn snapshot_string(value: &Bson) -> Result<String, ProblemError> {
    match value {
        Bson::Document(d) if d.contains_key("toString") => {
            return Err(crate::shared::system::internal_error());
        }
        Bson::Array(values) => {
            return values
                .iter()
                .map(|v| {
                    if matches!(v, Bson::Null | Bson::Undefined) {
                        Ok(String::new())
                    } else {
                        snapshot_string(v)
                    }
                })
                .collect::<Result<Vec<_>, _>>()
                .map(|v| v.join(","));
        }
        _ => {}
    }
    Ok(egdata_core::v1::serialization::stored_identifier(value).unwrap_or_else(|| "null".into()))
}

pub fn tag_key(tag: &Bson) -> Option<TagKey> {
    use crate::v1_helpers::PrimitiveId;
    Some(match crate::v1_helpers::primitive_id(Some(tag))? {
        PrimitiveId::Missing | PrimitiveId::Null => TagKey::Null,
        PrimitiveId::Bool(b) => TagKey::Bool(b),
        PrimitiveId::Number(n) => TagKey::Number(n),
        PrimitiveId::Text(s) => TagKey::Text(s.into()),
    })
}