use super::{Routes, internal_error, json_response};
use crate::state::AppState;
use egdata_http_core::shared::build_launcher;
use egdata_http_core::shared::builds::{
    stored::{manifest_status, platform, same_field, snapshot_filter, stored_comparable},
    tree_group_pipeline, tree_projection,
};
use axum::{
    extract::{Path, Request, State},
    http::{StatusCode, Uri},
    response::Response,
};
use bson::{Bson, Document, doc, oid::ObjectId};
use egdata_core::{
    builds::{
        MAX_BUILD_PAGE, build_pagination_offset, normalize_build_tree_path, parse_build_integer,
    },
    error::CoreError,
    ports::MongoFindOptions,
    v1::serialization::node_json,
};
use egdata_infra::bson_json::{bson_doc_to_js_json, bson_to_js_json};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

mod compare;

#[cfg(test)]
#[tokio::test]
async fn legacy_builds_http_node_oracle() {
    egdata_api_oracle::replay_legacy_oracle(include_str!(
        "../../egdata-api/tests/fixtures/legacy-builds-http-node.json"
    ))
    .await;
}

pub(super) fn routes() -> Routes {
    Routes::new("")
        .get("/builds", list)
        .get("/builds/{id}", detail)
        .get("/builds/{id}/files", files)
        .get("/builds/{id}/history", history)
        .get("/builds/{id}/tree", tree)
        .get("/builds/{id}/items", items)
        .get("/builds/{id}/install-options", install_options)
        .get("/builds/{targetId}/compare/{baseId}", compare::compare)
        .post("/builds/resolve-launcher-records", launcher)
}

struct Query(BTreeMap<String, String>);
impl Query {
    fn from_uri(uri: &Uri) -> Self {
        let mut params = BTreeMap::new();
        for (key, value) in url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
        {
            params
                .entry(key.into_owned())
                .or_insert_with(|| value.into_owned());
        }
        Self(params)
    }
    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).map(String::as_str)
    }
    fn non_empty(&self, key: &str, default: &'static str) -> &str {
        self.get(key).filter(|s| !s.is_empty()).unwrap_or(default)
    }
    fn page(&self, default: u64, invalid_message: &'static str) -> Result<Page, BuildError> {
        let parse = || {
            let limit = parse_build_integer(self.get("limit"), default, 100)?;
            let page = parse_build_integer(self.get("page"), 1, MAX_BUILD_PAGE)?;
            let offset = build_pagination_offset(page, limit)?;
            Some(Page {
                page,
                limit,
                offset,
            })
        };
        parse().ok_or(BuildError::Invalid(invalid_message))
    }
}
struct Page {
    page: u64,
    limit: u64,
    offset: u64,
}
impl Page {
    fn find(&self, sort: Option<Document>) -> MongoFindOptions {
        MongoFindOptions {
            sort,
            skip: Some(self.offset),
            limit: Some(self.limit as i64),
            ..Default::default()
        }
    }
}
enum BuildError {
    Invalid(&'static str),
    Missing,
    Database,
}
impl From<CoreError> for BuildError {
    fn from(_: CoreError) -> Self {
        Self::Database
    }
}
impl From<egdata_core::v1::ProblemError> for BuildError {
    fn from(_: egdata_core::v1::ProblemError) -> Self {
        Self::Database
    }
}
impl axum::response::IntoResponse for BuildError {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            Self::Invalid(message) => (StatusCode::BAD_REQUEST, "VALIDATION_ERROR", message),
            Self::Missing => (StatusCode::NOT_FOUND, "BUILD_NOT_FOUND", "Build not found"),
            Self::Database => return internal_error(),
        };
        json_response(status, &json!({"error":{"code":code,"message":message}}))
    }
}
type HandlerResult = Result<Response, BuildError>;
fn ok(value: &Value) -> Response {
    json_response(StatusCode::OK, value)
}
fn object_id(value: &str) -> Result<ObjectId, BuildError> {
    ObjectId::parse_str(value).map_err(|_| BuildError::Invalid("Invalid build ID"))
}
async fn build(state: &AppState, id: ObjectId) -> Result<Document, BuildError> {
    state
        .mongo
        .find_one("builds", doc! {"_id":id}, None)
        .await?
        .ok_or(BuildError::Missing)
}

async fn cache_read(state: &AppState, key: &str) -> Result<Option<Value>, BuildError> {
    state
        .cache
        .get(key)
        .await
        .ok()
        .flatten()
        .filter(|s| !s.is_empty())
        .map(|s| serde_json::from_str(&s).map_err(|_| BuildError::Database))
        .transpose()
}
async fn cache_write(state: &AppState, key: &str, value: &Value) {
    let _ = state.cache.set(key, &node_json(value), 600).await;
}
fn cache_hash(params: &Value) -> String {
    hex::encode(Sha256::digest(node_json(params)))[..20].to_owned()
}
fn documents(rows: &[Document]) -> Vec<Value> {
    rows.iter().map(bson_doc_to_js_json).collect()
}
pub(super) fn summary(row: &Value, asset: Option<&Value>) -> super::common::Result<Value> {
    let mut summary = egdata_http_core::shared::builds::stored_build_summary(row, asset)
        .map_err(|_| super::common::Error::Internal)?;
    // Unversioned JSON.stringify omits undefined properties that /v1 serializes as null.
    let obj = summary.as_object_mut().unwrap();
    for key in ["appName", "buildVersion", "labelName", "hash"] {
        if row.get(key).is_none() {
            obj.shift_remove(key);
        }
    }
    if row.get("sourceManifestHash").is_none_or(Value::is_null) && row.get("hash").is_none() {
        obj["manifest"]
            .as_object_mut()
            .unwrap()
            .shift_remove("sourceHash");
    }
    Ok(summary)
}
async fn detail(State(s): State<AppState>, Path(id): Path<String>) -> HandlerResult {
    let row = s
        .mongo
        .find_one("builds", doc! {"_id":object_id(&id)?}, None)
        .await?
        .ok_or(BuildError::Missing)?;
    let platform = platform(&row)?;
    let build = bson_doc_to_js_json(&row);
    let filter = doc! {"artifactId":row.get("appName").unwrap_or(&Bson::Null),"platform":platform};
    let asset = s
        .mongo
        .find_one("assets", filter, None)
        .await?
        .as_ref()
        .map(bson_doc_to_js_json);
    Ok(ok(
        &summary(&build, asset.as_ref()).map_err(|_| BuildError::Database)?
    ))
}
async fn list(State(s): State<AppState>, uri: Uri) -> HandlerResult {
    let q = Query::from_uri(&uri);
    let p = q.page(10, "Invalid pagination or sort field")?;
    let sort = q.non_empty("sortBy", "createdAt");
    let direction = q.non_empty("sortDir", "desc");
    if !["createdAt", "updatedAt", "firstSeenAt"].contains(&sort) {
        return Err(BuildError::Invalid("Invalid pagination or sort field"));
    }
    let dir = match direction {
        "asc" => 1,
        "desc" => -1,
        _ => return Err(BuildError::Invalid("Invalid sort direction")),
    };
    let key = format!("builds:v2:{sort}:{direction}:{}:{}", p.limit, p.page);
    if let Some(hit) = cache_read(&s, &key).await? {
        return Ok(ok(&hit));
    }
    let rows = s
        .mongo
        .find_many("builds", Document::new(), p.find(Some(doc! {sort:dir})))
        .await?;
    let names = rows
        .iter()
        .map(|row| row.get("appName").cloned().unwrap_or(bson::Bson::Null))
        .collect::<Vec<_>>();
    let builds = documents(&rows);
    let items = documents(
        &s.mongo
            .find_many(
                "items",
                doc! {"releaseInfo.appId":{"$in":names},"entitlementType":"EXECUTABLE"},
                Default::default(),
            )
            .await?,
    );
    let result = Value::Array(
        builds
            .iter()
            .map(|b| {
                let mut summary = summary(b, None).map_err(|_| BuildError::Database)?;
                let item = items.iter().find(|item| {
                    item["releaseInfo"].as_array().is_some_and(|entries| {
                        entries.iter().any(|e| e.get("appId") == b.get("appName"))
                    })
                });
                summary["item"] = item.cloned().unwrap_or(Value::Null);
                Ok(summary)
            })
            .collect::<Result<Vec<_>, BuildError>>()?,
    );
    cache_write(&s, &key, &result).await;
    Ok(ok(&result))
}
async fn items(State(s): State<AppState>, Path(id): Path<String>, uri: Uri) -> HandlerResult {
    let id = object_id(&id)?;
    let p = Query::from_uri(&uri).page(25, "Invalid pagination")?;
    let b = build(&s, id).await?;
    let filter = doc! {"releaseInfo.appId":b.get("appName").unwrap_or(&Bson::Null)};
    let (rows, total) = tokio::join!(
        s.mongo.find_many("items", filter.clone(), p.find(None)),
        s.mongo.count_documents("items", filter)
    );
    let (rows, total) = (rows?, total?);
    Ok(ok(
        &json!({"data":documents(&rows),"page":p.page,"limit":p.limit,"total":total}),
    ))
}
async fn files(State(s): State<AppState>, Path(id): Path<String>, uri: Uri) -> HandlerResult {
    let id = object_id(&id)?;
    let q = Query::from_uri(&uri);
    let p = q.page(25, "Invalid files query")?;
    let sort = q.non_empty("sort", "depth");
    let dir = match q.non_empty("dir", "asc") {
        "asc" => 1,
        "desc" => -1,
        _ => return Err(BuildError::Invalid("Invalid files query")),
    };
    let query = egdata_core::v1::trim_js_whitespace(q.get("q").unwrap_or(""));
    let extensions: Vec<_> = q
        .get("extension")
        .unwrap_or("")
        .split(',')
        .map(egdata_core::v1::trim_js_whitespace)
        .map(|s| s.strip_prefix('.').unwrap_or(s))
        .filter(|s| !s.is_empty())
        .collect();
    if !["depth", "fileName", "fileSize"].contains(&sort)
        || query.encode_utf16().count() > 200
        || extensions.len() > 20
    {
        return Err(BuildError::Invalid("Invalid files query"));
    }
    let b = build(&s, id).await?;
    let mut filter = snapshot_filter(&b);
    let mut and = Vec::new();
    if !query.is_empty() {
        and.push(doc!{"fileName":{"$regex":bson::Regex{pattern:escape_regex(query),options:"i".into()}}});
    }
    if !extensions.is_empty() {
        let options = extensions
            .into_iter()
            .map(escape_regex)
            .collect::<Vec<_>>()
            .join("|");
        and.push(doc!{"fileName":{"$regex":bson::Regex{pattern:format!("\\.({options})$"),options:"i".into()}}});
    }
    if !and.is_empty() {
        filter.insert("$and", and);
    }
    let order = if sort == "depth" {
        doc! {"depth":dir,"fileName":dir}
    } else {
        doc! {sort:dir}
    };
    let (rows, total) = tokio::join!(
        s.mongo
            .find_many("files", filter.clone(), p.find(Some(order))),
        s.mongo.count_documents("files", filter)
    );
    let (rows, total) = (rows?, total?);
    Ok(ok(
        &json!({"files":documents(&rows),"manifestStatus":bson_to_js_json(&manifest_status(&b)),"page":p.page,"limit":p.limit,"total":total}),
    ))
}
fn escape_regex(s: &str) -> String {
    let mut escaped = String::new();
    for c in s.chars() {
        if r#".*+?^${}()|[]\/"#.contains(c) {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    escaped
}
async fn history(State(s): State<AppState>, Path(id): Path<String>, uri: Uri) -> HandlerResult {
    let id = object_id(&id)?;
    let q = Query::from_uri(&uri);
    let p = q.page(50, "Invalid history query")?;
    let scope = q.get("scope").unwrap_or("stream");
    if !["stream", "platform"].contains(&scope) {
        return Err(BuildError::Invalid("Invalid history query"));
    }
    let b = build(&s, id).await?;
    let platform = platform(&b)?;
    let mut filter = doc! {"appName":b.get("appName").unwrap_or(&Bson::Null)};
    if scope == "stream" {
        filter.insert("labelName", b.get("labelName").unwrap_or(&Bson::Null));
    } else {
        let text = platform.as_str().ok_or(BuildError::Database)?;
        filter.insert("$or",vec![doc!{"platform":&platform},doc!{"platform":{"$exists":false},"labelName":{"$regex":bson::Regex{pattern:format!("-{}$",escape_regex(text)),options:"i".into()}}}]);
    }
    let (rows, total) = tokio::join!(
        s.mongo.find_many(
            "builds",
            filter.clone(),
            p.find(Some(doc! {"firstSeenAt":-1,"createdAt":-1,"_id":-1}))
        ),
        s.mongo.count_documents("builds", filter)
    );
    let (rows, total) = (rows?, total?);
    let previous = previous_id(&s, &b, &platform).await?;
    let summaries = rows
        .into_iter()
        .map(|row| {
            let mut v =
                summary(&bson_doc_to_js_json(&row), None).map_err(|_| BuildError::Database)?;
            v["comparable"] = json!(stored_comparable(&row));
            v["sameStream"] = json!(same_field(row.get("labelName"), b.get("labelName")));
            Ok::<_, BuildError>(v)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ok(
        &json!({"data":summaries,"previousComparableBuildId":previous,"page":p.page,"limit":p.limit,"total":total}),
    ))
}
fn stored_id(row: &Document) -> Result<String, BuildError> {
    let id = row
        .get("_id")
        .filter(|value| !matches!(value, Bson::Null))
        .ok_or(BuildError::Database)?;
    Ok(egdata_core::v1::serialization::js_string(&bson_to_js_json(
        id,
    )))
}

async fn previous_id(
    s: &AppState,
    build: &Document,
    current_platform: &Bson,
) -> Result<Option<String>, BuildError> {
    let filter = doc! {"appName":build.get("appName").unwrap_or(&Bson::Null),"labelName":build.get("labelName").unwrap_or(&Bson::Null),"manifestStatus":{"$in":["verified","legacy_unverified"]},"manifestId":{"$type":"string"}};
    if let Some(id) = build
        .get("previousObservedBuildId")
        .filter(|id| egdata_http_core::shared::system::js_truthy(&bson_to_js_json(id)))
    {
        let mut observed = filter.clone();
        observed.insert("_id", id);
        if let Some(row) = s.mongo.find_one("builds", observed, None).await?
            && stored_comparable(&row)
            && same_field(Some(&platform(&row)?), Some(current_platform))
        {
            let id = stored_id(&row)?;
            if !id.is_empty() {
                return Ok(Some(id));
            }
        }
    }
    let created = build
        .get("createdAt")
        .filter(|v| !matches!(v, Bson::Null))
        .cloned()
        .unwrap_or_else(|| Bson::DateTime(bson::DateTime::from_chrono((s.now)())));
    let mut earlier = filter;
    earlier.extend(doc!{"_id":{"$ne":build.get("_id").unwrap_or(&Bson::Null)},"createdAt":{"$lt":created},"$or":[{"platform":current_platform},{"platform":{"$exists":false}}]});
    s.mongo
        .find_one_with_options(
            "builds",
            earlier,
            MongoFindOptions {
                sort: Some(doc! {"firstSeenAt":-1,"createdAt":-1}),
                ..Default::default()
            },
        )
        .await?
        .as_ref()
        .map(stored_id)
        .transpose()
}

async fn tree(State(s): State<AppState>, Path(id): Path<String>, uri: Uri) -> HandlerResult {
    let oid = object_id(&id)?;
    let q = Query::from_uri(&uri);
    let path = normalize_build_tree_path(q.get("path"))
        .ok_or(BuildError::Invalid("Invalid tree query"))?;
    let p = q.page(100, "Invalid tree query")?;
    let b = build(&s, oid).await?;
    let mut parts = json!({});
    if let Some(value) = ["manifestId", "sourceManifestHash"]
        .iter()
        .filter_map(|field| b.get(*field))
        .find(|v| !matches!(v, Bson::Null))
        .or_else(|| b.get("hash"))
    {
        parts["snapshotKey"] = bson_to_js_json(value);
    }
    parts["manifestUpdatedAt"] = match b.get("updatedAt") {
        None | Some(Bson::Null) => json!(0),
        Some(Bson::DateTime(date)) => date.timestamp_millis().into(),
        Some(value) => bson_to_js_json(value),
    };
    parts["path"] = json!(path);
    parts["page"] = json!(p.page);
    parts["limit"] = json!(p.limit);
    let hash = cache_hash(&parts);
    let key = format!("build-tree:v1:{id}:{hash}");
    if let Some(hit) = cache_read(&s, &key).await? {
        return Ok(ok(&hit));
    }
    let mut pipeline = tree_group_pipeline(snapshot_filter(&b), &path, |prefix| {
        bson::Bson::RegularExpression(bson::Regex {
            pattern: format!("^{}", escape_regex(prefix)),
            options: String::new(),
        })
    });
    pipeline.push(doc! {"$sort":{"_id.type":1,"_id.name":1}});
    pipeline.push(doc!{"$facet":{"nodes":[{"$skip":p.offset as i64},{"$limit":p.limit as i64},tree_projection()],"total":[{"$count":"count"}]}});
    let rows = s.mongo.aggregate("files", pipeline).await?;
    let data = rows.first().map(bson_doc_to_js_json).unwrap_or(Value::Null);
    let mut nodes = Vec::new();
    if let Some(source) = data.get("nodes").filter(|value| !value.is_null()) {
        for row in source.as_array().ok_or(BuildError::Database)? {
            if row.is_null() {
                return Err(BuildError::Database);
            }
            let mut node = super::common::spread(row);
            if !path.is_empty() {
                let name = row
                    .get("name")
                    .map(egdata_core::v1::serialization::js_string)
                    .unwrap_or_else(|| "undefined".into());
                node["path"] = json!(format!("{path}/{name}"));
            } else if let Some(name) = row.get("name") {
                node["path"] = name.clone();
            }
            nodes.push(node);
        }
    }
    if !data.is_null() && data["total"].is_null() {
        return Err(BuildError::Database);
    }
    let result = json!({"path":path,"nodes":nodes,"manifestStatus":bson_to_js_json(&manifest_status(&b)),"page":p.page,"limit":p.limit,"total":data.pointer("/total/0/count").filter(|value|!value.is_null()).cloned().unwrap_or(json!(0))});
    cache_write(&s, &key, &result).await;
    Ok(ok(&result))
}
async fn install_options(State(s): State<AppState>, Path(id): Path<String>) -> HandlerResult {
    let b = build(&s, object_id(&id)?).await?;
    let mut filter = snapshot_filter(&b);
    filter.insert("installTags", doc! {"$exists":true,"$not":{"$size":0}});
    let rows=s.mongo.aggregate("files",vec![doc!{"$match":filter},doc!{"$unwind":"$installTags"},doc!{"$group":{"_id":"$installTags","files":{"$sum":1},"size":{"$sum":{"$ifNull":["$fileSize",0]}}}},doc!{"$sort":{"_id":1}}]).await?;
    let mut result = json!({});
    for row in documents(&rows) {
        let key = row
            .get("_id")
            .map(egdata_core::v1::serialization::js_string)
            .unwrap_or_else(|| "undefined".into());
        let mut options = json!({});
        for field in ["files", "size"] {
            if let Some(value) = row.get(field) {
                options[field] = value.clone();
            }
        }
        result[key] = options;
    }
    Ok(ok(&result))
}
async fn launcher(State(s): State<AppState>, req: Request) -> HandlerResult {
    let bytes = axum::body::to_bytes(req.into_body(), usize::MAX)
        .await
        .map_err(|_| BuildError::Invalid("Invalid launcher record request"))?;
    let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let candidates = build_launcher::validate(body)
        .map_err(|_| BuildError::Invalid("Invalid launcher record request"))?;
    let mut results = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        results.push(
            build_launcher::resolve_candidate(&s, &candidate)
                .await
                .map_err(|_| BuildError::Database)?,
        );
    }
    Ok(ok(&json!({"results":results})))
}
