//! Build catalog handlers.
//!
//! Build reads share the same Mongo collections and summary conversion as the
//! ingestion pipeline. Snapshot operations are kept here so their query
//! semantics remain explicit at the HTTP boundary.
pub use egdata_http_core::shared::builds::*;

use super::{
    RouteGroup,
    helpers::{
        V1RequestContext, json_success, parse_strict_query_uri, parse_validated_query,
        problem_response, v1_cache_get, v1_cache_key, v1_cache_set,
    },
};
use crate::state::AppState;
use axum::{
    extract::{Path, Request, State},
    http::Method,
    response::Response,
};
use bson::{Bson, Document, doc, oid::ObjectId};
use egdata_core::v1::serialization::{iso_or_null, js_string};
use egdata_core::{
    builds::{
        BuildComparisonDirection, BuildDocument, BuildFileChangeStatus,
        build_manifest_status, effective_build_platform,
    },
    ports::MongoFindOptions,
    v1::{
        CursorBinding, CursorSortValue, MongoSortField, NullsOrder, ProblemError, ProblemIssue,
        SortDirection, bson_to_serialized_json, decode_cursor_with, encode_cursor_with,
        mongo_keyset_filter, mongo_sort_spec, page_meta, parse_pagination_map, trim_page,
    },
};
use egdata_infra::bson_json::bson_doc_to_js_json;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};

pub mod stored {
    pub use egdata_http_core::shared::builds::stored::*;
}

const LIST_TTL: u64 = 60;
const DETAIL_TTL: u64 = 120;
const SNAPSHOT_TTL: u64 = 300;
const HISTORY_ORDERING: &str = "firstSeenAt:desc,createdAt:desc,_id:desc";
const GLOBAL_CURSOR_SCOPE: (&str, &str) = ("", "");

enum QueryRule<'a> {
    Choices(&'a [&'a str]),
    MaxLength(usize),
}

fn build_query(
    request: &Request,
    allowed: &[&str],
    rules: &[(&str, QueryRule<'_>)],
) -> Result<BTreeMap<String, String>, ProblemError> {
    parse_validated_query(request.uri(), allowed, |params| {
        rules
            .iter()
            .filter_map(|(field, rule)| {
                let field = *field;
                let value = params.get(field)?;
                let (code, message) = match rule {
                    QueryRule::Choices(values) if !values.contains(&value.as_str()) => {
                        let choices = values
                            .iter()
                            .map(|v| format!("\"{v}\""))
                            .collect::<Vec<_>>()
                            .join("|");
                        (
                            "INVALID_VALUE",
                            format!("Invalid option: expected one of {choices}"),
                        )
                    }
                    QueryRule::MaxLength(max) if value.encode_utf16().count() > *max => (
                        "TOO_BIG",
                        format!("Too big: expected string to have <={max} characters"),
                    ),
                    _ => return None,
                };
                Some(ProblemIssue {
                    parameter: Some(field.into()),
                    pointer: Some(format!("/{field}")),
                    code: code.into(),
                    message,
                })
            })
            .collect()
    })
}

fn sort_js_strings(values: &mut [String]) {
    values.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

fn file_extensions(raw: Option<&str>) -> Result<Vec<String>, ProblemError> {
    let mut extensions: Vec<_> = egdata_core::v1::parse_csv(raw)
        .unwrap_or_default()
        .into_iter()
        .map(|entry| entry.strip_prefix('.').unwrap_or(&entry).to_lowercase())
        .filter(|entry| !entry.is_empty())
        .collect();
    if extensions.len() > 20 {
        return Err(ProblemError::new(
            400,
            "INVALID_QUERY",
            "At most 20 distinct extensions can be filtered at once.",
        )
        .with_errors(vec![ProblemIssue {
            parameter: Some("extension".into()),
            pointer: None,
            code: "TOO_MANY".into(),
            message: format!(
                "The parameter contains {} distinct extensions.",
                extensions.len()
            ),
        }]));
    }
    sort_js_strings(&mut extensions);
    extensions.dedup();
    Ok(extensions)
}

fn list_cursor_binding(sort_by: &str, sort_dir: &str, limit: u32) -> CursorBinding {
    CursorBinding {
        operation: "builds.list".into(),
        filters: Some(BTreeMap::new()),
        ordering: format!("{sort_by}:{sort_dir},_id:{sort_dir}"),
        country: GLOBAL_CURSOR_SCOPE.0.into(),
        locale: GLOBAL_CURSOR_SCOPE.1.into(),
        limit,
    }
}

fn cursor_bson(value: &CursorSortValue) -> Bson {
    match value {
        CursorSortValue::Null => Bson::Null,
        CursorSortValue::Number(number) => bson::to_bson(number).unwrap_or(Bson::Null),
        CursorSortValue::String(value) => Bson::String(value.clone()),
    }
}

pub fn route_group(prefix: &str) -> RouteGroup {
    RouteGroup::new(prefix)
        .get("/builds", list_builds)
        .get("/builds/{id}", build_detail)
        .get("/builds/{id}/files", build_files)
        .get("/builds/{id}/history", build_history)
        .get("/builds/{id}/tree", build_tree)
        .get("/builds/{targetId}/compare/{baseId}", compare_builds)
        .get("/builds/{id}/items", build_items)
        .get("/builds/{id}/install-options", install_options)
}

fn context(request: &Request) -> &V1RequestContext {
    request.extensions().get().expect("v1 context")
}

fn fail(request: &Request, error: &ProblemError) -> Response {
    problem_response(
        error,
        request.uri().path(),
        Some(&context(request).request_id),
    )
}

fn invalid_build_id(id: &str) -> ProblemError {
    ProblemError::new(
        400,
        "INVALID_BUILD_ID",
        format!("The build identifier '{id}' is not a valid build id."),
    )
    .with_errors(vec![ProblemIssue {
        pointer: None,
        parameter: Some("id".into()),
        code: "INVALID".into(),
        message: "Expected a 24-character hexadecimal build id.".into(),
    }])
}

fn build_id(id: &str) -> Result<ObjectId, ProblemError> {
    ObjectId::parse_str(id).map_err(|_| invalid_build_id(id))
}

fn decode<T: for<'de> serde::Deserialize<'de>>(doc: Document) -> Result<T, ProblemError> {
    bson::from_document(doc).map_err(|_| super::system::internal_error())
}

fn method(request: &Request) -> &Method {
    request.method()
}

async fn build_list_rows(
    state: &AppState,
    sort_by: &str,
    fields: &[MongoSortField; 2],
    last: Option<&[CursorSortValue]>,
    limit: u32,
) -> Result<Vec<Document>, ProblemError> {
    let after = last.map(|tuple| [cursor_date(tuple.first()), cursor_id(tuple.get(1))]);
    let fetch = |filter, sort, count| {
        state.mongo.find_many(
            "builds",
            filter,
            MongoFindOptions {
                sort: Some(sort),
                limit: Some(count),
                ..Default::default()
            },
        )
    };
    let failed = |_| super::system::internal_error();
    let count = i64::from(limit) + 1;
    let descending = fields[0].direction == SortDirection::Desc;
    if !descending && last.is_some_and(|tuple| matches!(tuple.first(), Some(CursorSortValue::Null)))
    {
        let mut filter = doc! {sort_by:Bson::Null};
        if let Some([_, id]) = after.as_ref()
            && *id != Bson::Null
        {
            filter.insert("_id", doc! {"$gt":id});
        }
        return fetch(filter, doc! { "_id": 1 }, count)
            .await
            .map_err(failed);
    }
    // MongoDB puts nulls first when sorting ascending. Node exhausts dated
    // records before paging through the null group in ascending ObjectId order.
    let mut filter = if descending {
        Document::new()
    } else {
        doc! { sort_by: { "$ne": Bson::Null } }
    };
    if let Some(tuple) = &after {
        filter.insert("$and", vec![fixed_keyset(fields, tuple)]);
    }
    let mut rows = fetch(filter, mongo_sort_spec(fields), count)
        .await
        .map_err(failed)?;
    if !descending && rows.len() < count as usize {
        let remaining = count - rows.len() as i64;
        rows.extend(
            fetch(doc! { sort_by: Bson::Null }, doc! { "_id": 1 }, remaining)
                .await
                .map_err(failed)?,
        );
    }
    Ok(rows)
}

async fn list_builds(State(state): State<AppState>, request: Request) -> Response {
    let query = match build_query(
        &request,
        &["limit", "cursor", "sortBy", "sortDir"],
        &[
            (
                "sortBy",
                QueryRule::Choices(&["createdAt", "updatedAt", "firstSeenAt"]),
            ),
            ("sortDir", QueryRule::Choices(&["asc", "desc"])),
        ],
    ) {
        Ok(query) => query,
        Err(error) => return fail(&request, &error),
    };
    let pagination = match parse_pagination_map(&query, 100) {
        Ok(pagination) => pagination,
        Err(error) => return fail(&request, &error),
    };
    let sort_by = query
        .get("sortBy")
        .map(String::as_str)
        .unwrap_or("createdAt");
    let sort_dir = query.get("sortDir").map(String::as_str).unwrap_or("desc");
    let binding = list_cursor_binding(sort_by, sort_dir, pagination.limit);
    let (sort_direction, nulls) = if sort_dir == "asc" {
        (SortDirection::Asc, NullsOrder::First)
    } else {
        (SortDirection::Desc, NullsOrder::Last)
    };
    let sort_fields = [
        MongoSortField::new(sort_by, sort_direction, nulls),
        MongoSortField::new("_id", sort_direction, nulls),
    ];
    let key = v1_cache_key(
        "builds.list",
        &BTreeMap::from([
            ("sortBy", json!(sort_by)),
            ("sortDir", json!(sort_dir)),
            ("limit", json!(pagination.limit)),
            ("cursor", json!(pagination.cursor)),
        ]),
    );
    if let Some(cached) = v1_cache_get(state.cache.as_ref(), &key).await {
        let data = cached["data"].clone();
        let count = data.as_array().map_or(0, Vec::len);
        return json_success(
            method(&request),
            request.uri().path(),
            &context(&request).request_id,
            data,
            Some(
                json!({"count": count, "sortBy": sort_by, "sortDir": sort_dir, "pagination": cached["pagination"]}),
            ),
        );
    }
    let last = match pagination.cursor.as_deref() {
        Some(raw) => match decode_cursor_with(
            raw,
            &binding,
            state.config.v1_cursor_secret.as_deref(),
            (state.now)().timestamp_millis(),
        ) {
            Ok(tuple) => Some(tuple),
            Err(error) => return fail(&request, &error),
        },
        None => None,
    };
    let (rows, total) = tokio::join!(
        build_list_rows(
            &state,
            sort_by,
            &sort_fields,
            last.as_deref(),
            pagination.limit,
        ),
        super::counts::documents(&state, "builds.list", &[], LIST_TTL, "builds", doc! {})
    );
    let (rows, total) = match rows.and_then(|rows| total.map(|total| (rows, total))) {
        Ok(pair) => pair,
        Err(error) => return fail(&request, &error),
    };
    let page = trim_page(rows, pagination.limit as usize);
    let builds: Vec<_> = page.items.iter().map(bson_doc_to_js_json).collect();
    let mut seen = HashSet::new();
    let app_names: Vec<_> = builds
        .iter()
        .filter_map(|build| build["appName"].as_str())
        .filter(|app| !app.is_empty() && seen.insert(*app))
        .collect();
    let catalog_items = if app_names.is_empty() {
        Vec::new()
    } else {
        match state
            .mongo
            .find_many(
                "items",
                doc! {"releaseInfo.appId": {"$in": app_names}, "entitlementType": "EXECUTABLE"},
                MongoFindOptions::default(),
            )
            .await
        {
            Ok(items) => items,
            Err(_) => {
                return fail(&request, &super::system::internal_error());
            }
        }
    };
    let data = builds
        .iter()
        .map(|build| {
            let item = catalog_items.iter().find(|item| {
                item.get_array("releaseInfo").is_ok_and(|releases| {
                    releases.iter().any(|release| {
                        release
                            .as_document()
                            .and_then(|doc| doc.get_str("appId").ok())
                            == build["appName"].as_str()
                    })
                })
            });
            let mut summary = egdata_core::v1::serialize_value(&stored_build_summary(build, None)?);
            summary["item"] = item
                .map(super::item_serialization::stored_item)
                .unwrap_or(Value::Null);
            Ok::<_, ProblemError>(summary)
        })
        .collect::<Result<Vec<_>, _>>();
    let data = match data {
        Ok(data) => data,
        Err(error) => return fail(&request, &error),
    };
    let next_cursor = if let Some(build) = builds.last().filter(|_| page.has_more) {
        let date = iso_or_null(&build[sort_by]);
        match encode_cursor_with(
            &binding,
            &[
                CursorSortValue::from(date),
                CursorSortValue::from(js_string(&build["_id"])),
            ],
            state.config.v1_cursor_secret.as_deref(),
            (state.now)().timestamp_millis(),
        ) {
            Ok(cursor) => Some(cursor),
            Err(error) => return fail(&request, &error),
        }
    } else {
        None
    };
    let pagination_meta = page_meta(pagination.limit, page.has_more, next_cursor).with_total(total);
    let result = json!({"data": data, "pagination": pagination_meta});
    v1_cache_set(state.cache.as_ref(), &key, &result, LIST_TTL).await;
    let meta = json!({
        "count": data.len(),
        "sortBy": sort_by,
        "sortDir": sort_dir,
        "pagination": pagination_meta,
    });
    json_success(
        method(&request),
        request.uri().path(),
        &context(&request).request_id,
        Value::Array(data),
        Some(meta),
    )
}

async fn build_detail(
    State(state): State<AppState>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    if let Err(error) = parse_strict_query_uri(request.uri(), &[]) {
        return fail(&request, &error);
    }
    let oid = match build_id(&id) {
        Ok(oid) => oid,
        Err(error) => return fail(&request, &error),
    };
    let key = v1_cache_key("builds.detail", &BTreeMap::from([("id", json!(id))]));
    if let Some(cached) = v1_cache_get(state.cache.as_ref(), &key).await {
        return json_success(
            method(&request),
            request.uri().path(),
            &context(&request).request_id,
            cached,
            None,
        );
    }
    let row = match state
        .mongo
        .find_one("builds", doc! {"_id": oid}, None)
        .await
    {
        Ok(Some(row)) => row,
        Ok(None) => {
            v1_cache_set(state.cache.as_ref(), &key, &Value::Null, DETAIL_TTL).await;
            return fail(
                &request,
                &ProblemError::new(404, "BUILD_NOT_FOUND", format!("No build matches '{id}'.")),
            );
        }
        Err(_) => {
            return fail(&request, &super::system::internal_error());
        }
    };
    let build = bson_doc_to_js_json(&row);
    let platform = build_platform(&build);
    let artifact = row.get("appName").cloned().unwrap_or(Bson::Null);
    let asset_filter = doc! {"artifactId":{"$eq":artifact},"platform":{"$eq":platform}};
    let asset = match state.mongo.find_one("assets", asset_filter, None).await {
        Ok(asset) => asset.as_ref().map(bson_doc_to_js_json),
        Err(_) => return fail(&request, &super::system::internal_error()),
    };
    let result = match stored_build_summary(&build, asset.as_ref()) {
        Ok(summary) => egdata_core::v1::serialize_value(&summary),
        Err(error) => return fail(&request, &error),
    };
    v1_cache_set(state.cache.as_ref(), &key, &result, DETAIL_TTL).await;
    json_success(
        method(&request),
        request.uri().path(),
        &context(&request).request_id,
        result,
        None,
    )
}

async fn load_build(state: &AppState, id: &str) -> Result<BuildDocument, ProblemError> {
    decode(load_stored_build(state, id).await?)
}
async fn load_stored_build(state: &AppState, id: &str) -> Result<Document, ProblemError> {
    let oid = build_id(id)?;
    let row = state
        .mongo
        .find_one("builds", doc! {"_id": oid}, None)
        .await
        .map_err(|_| super::system::internal_error())?
        .ok_or_else(|| {
            ProblemError::new(404, "BUILD_NOT_FOUND", format!("No build matches '{id}'."))
        })?;
    Ok(row)
}

fn fixed_keyset<const N: usize>(fields: &[MongoSortField; N], values: &[Bson; N]) -> Document {
    mongo_keyset_filter(fields, values)
        .expect("nonempty static sort with one cursor value per field")
}

pub fn cursor_date(value: Option<&CursorSortValue>) -> Bson {
    let date = match value {
        Some(CursorSortValue::String(raw)) => {
            super::offer_price_history::cursor_date(raw).map(bson::DateTime::from_chrono)
        }
        Some(CursorSortValue::Number(n)) => n
            .as_f64()
            .filter(|n| n.abs() <= 8_640_000_000_000_000.)
            .map(|n| bson::DateTime::from_millis(n as i64)),
        _ => None,
    };
    date.map_or(Bson::Null, Bson::DateTime)
}

fn cursor_id(value: Option<&CursorSortValue>) -> Bson {
    value
        .and_then(CursorSortValue::as_str)
        .and_then(|id| ObjectId::parse_str(id).ok())
        .map_or_else(|| value.map_or(Bson::Null, cursor_bson), Bson::ObjectId)
}

fn history_cursor_binding(id: &str, scope: &str, limit: u32) -> CursorBinding {
    CursorBinding {
        operation: "builds.history".into(),
        filters: Some(BTreeMap::from([
            ("id".into(), json!(id)),
            ("scope".into(), json!(scope)),
        ])),
        ordering: HISTORY_ORDERING.into(),
        country: GLOBAL_CURSOR_SCOPE.0.into(),
        locale: GLOBAL_CURSOR_SCOPE.1.into(),
        limit,
    }
}

async fn previous_comparable_build_id(
    state: &AppState,
    build: &BuildDocument,
    platform: &str,
) -> Result<Option<String>, ProblemError> {
    if let Some(previous_id) = build.previous_observed_build_id {
        let observed = state
            .mongo
            .find_one(
                "builds",
                doc! {
                    "_id": previous_id,
                    "appName": &build.app_name,
                    "labelName": &build.label_name,
                    "manifestStatus": {"$in": ["verified", "legacy_unverified"]},
                    "manifestId": {"$type": "string"},
                },
                None,
            )
            .await
            .map_err(|_| super::system::internal_error())?
            .and_then(|doc| decode::<BuildDocument>(doc).ok());
        if let Some(observed) = observed
            && observed.manifest_id.is_some()
            && matches!(
                build_manifest_status(&observed),
                egdata_core::builds::ManifestStatus::Verified
                    | egdata_core::builds::ManifestStatus::LegacyUnverified
            )
            && effective_build_platform(&observed) == platform
        {
            return Ok(Some(observed.id.to_hex()));
        }
    }

    let created_at = Bson::DateTime(bson::DateTime::from_chrono(
        build.created_at.unwrap_or_else(state.now),
    ));
    let previous = state
        .mongo
        .find_many(
            "builds",
            doc! {
                "appName": &build.app_name,
                "labelName": &build.label_name,
                "_id": {"$ne": build.id},
                "manifestStatus": {"$in": ["verified", "legacy_unverified"]},
                "manifestId": {"$type": "string"},
                "createdAt": {"$lt": created_at},
                "$or": [{"platform": platform}, {"platform": {"$exists": false}}],
            },
            MongoFindOptions {
                sort: Some(doc! {"firstSeenAt": -1, "createdAt": -1}),
                limit: Some(1),
                ..Default::default()
            },
        )
        .await
        .map_err(|_| super::system::internal_error())?;
    previous
        .first()
        .map(|row| {
            let doc = bson_doc_to_js_json(row);
            doc.get("_id")
                .filter(|id| !id.is_null())
                .map(js_string)
                .ok_or_else(super::system::internal_error)
        })
        .transpose()
}

async fn build_files(
    State(state): State<AppState>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    let query = match build_query(
        &request,
        &["limit", "cursor", "sort", "dir", "q", "extension"],
        &[
            (
                "sort",
                QueryRule::Choices(&["depth", "fileName", "fileSize"]),
            ),
            ("dir", QueryRule::Choices(&["asc", "desc"])),
            ("q", QueryRule::MaxLength(200)),
            ("extension", QueryRule::MaxLength(500)),
        ],
    ) {
        Ok(query) => query,
        Err(error) => return fail(&request, &error),
    };
    let pagination = match parse_pagination_map(&query, 100) {
        Ok(value) => value,
        Err(error) => return fail(&request, &error),
    };
    let sort = query.get("sort").map(String::as_str).unwrap_or("depth");
    let dir = query.get("dir").map(String::as_str).unwrap_or("asc");
    let search = query
        .get("q")
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    let extensions = match file_extensions(query.get("extension").map(String::as_str)) {
        Ok(extensions) => extensions,
        Err(error) => return fail(&request, &error),
    };
    let filter_map = BTreeMap::from([
        ("id".to_string(), json!(id)),
        ("sort".to_string(), json!(sort)),
        ("dir".to_string(), json!(dir)),
        (
            "q".to_string(),
            search.clone().map_or(Value::Null, |s| json!(s)),
        ),
        (
            "extensions".to_string(),
            if extensions.is_empty() {
                Value::Null
            } else {
                json!(extensions)
            },
        ),
    ]);
    let ordering = if sort == "fileName" {
        format!("fileName:{dir}")
    } else {
        format!("{sort}:{dir},fileName:{dir}")
    };
    let binding = CursorBinding {
        operation: "builds.files".into(),
        filters: Some(filter_map.into_iter().collect()),
        ordering,
        country: GLOBAL_CURSOR_SCOPE.0.into(),
        locale: GLOBAL_CURSOR_SCOPE.1.into(),
        limit: pagination.limit,
    };
    let direction = if dir == "asc" {
        SortDirection::Asc
    } else {
        SortDirection::Desc
    };
    let nulls = if dir == "asc" {
        NullsOrder::First
    } else {
        NullsOrder::Last
    };
    let mut sort_fields = Vec::new();
    if sort != "fileName" {
        sort_fields.push(MongoSortField::new(sort, direction, nulls));
    }
    sort_fields.push(MongoSortField::new("fileName", direction, nulls));
    let build = match load_stored_build(&state, &id).await {
        Ok(build) => build,
        Err(error) => return fail(&request, &error),
    };
    let cache_key = v1_cache_key(
        "builds.files",
        &BTreeMap::from([
            ("id", json!(id)),
            ("sort", json!(sort)),
            ("dir", json!(dir)),
            ("q", search.clone().map_or(Value::Null, |q| json!(q))),
            (
                "extensions",
                if extensions.is_empty() {
                    Value::Null
                } else {
                    json!(extensions)
                },
            ),
            ("limit", json!(pagination.limit)),
            ("cursor", json!(pagination.cursor)),
        ]),
    );
    if let Some(cached) = v1_cache_get(state.cache.as_ref(), &cache_key).await {
        let data = cached["data"].clone();
        let count = data.as_array().map_or(0, Vec::len);
        return json_success(
            method(&request),
            request.uri().path(),
            &context(&request).request_id,
            data,
            Some(
                json!({"count": count, "manifestStatus": egdata_infra::bson_json::bson_to_js_json(&stored::manifest_status(&build)), "pagination": cached["pagination"]}),
            ),
        );
    }
    let last = match pagination.cursor.as_deref() {
        Some(raw) => match decode_cursor_with(
            raw,
            &binding,
            state.config.v1_cursor_secret.as_deref(),
            (state.now)().timestamp_millis(),
        ) {
            Ok(tuple) => Some(tuple),
            Err(error) => return fail(&request, &error),
        },
        None => None,
    };
    let mut filter = stored::snapshot_filter(&build);
    let mut clauses = vec![filter.clone()];
    if let Some(search) = search.as_deref() {
        clauses.push(doc! {"fileName": {"$regex": regex::escape(search), "$options": "i"}});
    }
    if !extensions.is_empty() {
        let pattern = format!(
            r"\.({})$",
            extensions
                .iter()
                .map(|s| regex::escape(s))
                .collect::<Vec<_>>()
                .join("|")
        );
        clauses.push(doc! {"fileName": {"$regex": pattern, "$options": "i"}});
    }
    let base = if clauses.len() == 1 {
        filter.clone()
    } else {
        doc! {"$and":clauses.clone()}
    };
    if let Some(tuple) = &last {
        let bson_tuple: Vec<Bson> = tuple.iter().map(cursor_bson).collect();
        let cursor_filter = match mongo_keyset_filter(&sort_fields, &bson_tuple) {
            Ok(filter) => filter,
            Err(error) => return fail(&request, &error),
        };
        clauses.push(cursor_filter);
    }
    if clauses.len() > 1 {
        filter = doc! {"$and": clauses};
    }
    let sort_doc = mongo_sort_spec(&sort_fields);
    let parts = [
        ("id", json!(id)),
        ("q", json!(search)),
        (
            "extensions",
            if extensions.is_empty() {
                Value::Null
            } else {
                json!(extensions)
            },
        ),
    ];
    let (rows, total) = tokio::join!(
        state.mongo.find_many(
            "files",
            filter,
            MongoFindOptions {
                sort: Some(sort_doc),
                limit: Some(i64::from(pagination.limit + 1)),
                ..Default::default()
            },
        ),
        super::counts::documents(&state, "builds.files", &parts, SNAPSHOT_TTL, "files", base)
    );
    let rows = match rows {
        Ok(rows) => rows,
        Err(_) => return fail(&request, &super::system::internal_error()),
    };
    let total = match total {
        Ok(total) => total,
        Err(error) => return fail(&request, &error),
    };
    let page = trim_page(rows, pagination.limit as usize);
    let last_row = page.items.last();
    let next_cursor = if let Some(row) = last_row.filter(|_| page.has_more) {
        let file_name = row
            .get_str("fileName")
            .ok()
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let mut tuple = Vec::new();
        if sort != "fileName" {
            let value = match row.get(sort).map(bson_to_serialized_json) {
                Some(Value::Number(number)) => CursorSortValue::Number(number),
                _ => CursorSortValue::Null,
            };
            tuple.push(value);
        }
        tuple.push(CursorSortValue::from(file_name));
        match egdata_core::v1::encode_cursor_with_filter_order(
            &binding,
            &tuple,
            state.config.v1_cursor_secret.as_deref(),
            (state.now)().timestamp_millis(),
            &["id", "sort", "dir", "q", "extensions"],
        ) {
            Ok(cursor) => Some(cursor),
            Err(error) => return fail(&request, &error),
        }
    } else {
        None
    };
    let data: Vec<_> = page
        .items
        .iter()
        .cloned()
        .map(|row| bson_to_serialized_json(&Bson::Document(row)))
        .collect();
    let pagination_meta = page_meta(pagination.limit, page.has_more, next_cursor).with_total(total);
    let cached = json!({"data": data, "pagination": pagination_meta});
    v1_cache_set(state.cache.as_ref(), &cache_key, &cached, 300).await;
    json_success(
        method(&request),
        request.uri().path(),
        &context(&request).request_id,
        cached["data"].clone(),
        Some(
            json!({"count": data.len(), "manifestStatus": egdata_infra::bson_json::bson_to_js_json(&stored::manifest_status(&build)), "pagination": cached["pagination"]}),
        ),
    )
}

async fn build_history(
    State(state): State<AppState>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    let query = match build_query(
        &request,
        &["limit", "cursor", "scope"],
        &[("scope", QueryRule::Choices(&["stream", "platform"]))],
    ) {
        Ok(query) => query,
        Err(error) => return fail(&request, &error),
    };
    let pagination = match parse_pagination_map(&query, 100) {
        Ok(value) => value,
        Err(error) => return fail(&request, &error),
    };
    let scope = query.get("scope").map(String::as_str).unwrap_or("stream");
    let build = match load_build(&state, &id).await {
        Ok(v) => v,
        Err(e) => return fail(&request, &e),
    };
    let binding = history_cursor_binding(&id, scope, pagination.limit);
    let cache_key = v1_cache_key(
        "builds.history",
        &BTreeMap::from([
            ("id", json!(id)),
            ("scope", json!(scope)),
            ("limit", json!(pagination.limit)),
            ("cursor", json!(pagination.cursor)),
        ]),
    );
    let cached = v1_cache_get(state.cache.as_ref(), &cache_key).await;
    if let Some(cached) = cached {
        let data = cached["data"].clone();
        let previous = cached["previousComparableBuildId"].clone();
        let meta = json!({"count": data.as_array().map_or(0, Vec::len), "scope": scope, "previousComparableBuildId": previous, "pagination": cached["pagination"]});
        return json_success(
            method(&request),
            request.uri().path(),
            &context(&request).request_id,
            data,
            Some(meta),
        );
    }
    let last = match pagination.cursor.as_deref() {
        Some(raw) => match decode_cursor_with(
            raw,
            &binding,
            state.config.v1_cursor_secret.as_deref(),
            (state.now)().timestamp_millis(),
        ) {
            Ok(tuple) => Some(tuple),
            Err(error) => return fail(&request, &error),
        },
        None => None,
    };
    let mut filter = doc! {"appName": &build.app_name};
    if scope == "stream" {
        filter.insert("labelName", &build.label_name);
    } else {
        let platform = regex::escape(effective_build_platform(&build));
        filter.insert("$or", vec![
            doc! {"platform": effective_build_platform(&build)},
            doc! {"platform": {"$exists": false}, "labelName": {"$regex": format!("-{platform}$"), "$options": "i"}},
        ]);
    }
    let base = filter.clone();
    let mut conditions = vec![filter];
    if let Some(tuple) = &last {
        let bson_tuple = [
            cursor_date(tuple.first()),
            cursor_date(tuple.get(1)),
            cursor_id(tuple.get(2)),
        ];
        let fields = [
            MongoSortField::new("firstSeenAt", SortDirection::Desc, NullsOrder::Last),
            MongoSortField::new("createdAt", SortDirection::Desc, NullsOrder::Last),
            MongoSortField::new("_id", SortDirection::Desc, NullsOrder::Last),
        ];
        conditions.push(fixed_keyset(&fields, &bson_tuple));
    }
    let filter = if conditions.len() == 1 {
        conditions.remove(0)
    } else {
        doc! {"$and": conditions}
    };
    let parts = [("id", json!(id)), ("scope", json!(scope))];
    let (rows, total, previous) = tokio::join!(
        state.mongo.find_many(
            "builds",
            filter,
            MongoFindOptions {
                sort: Some(doc! {"firstSeenAt": -1, "createdAt": -1, "_id": -1}),
                limit: Some(i64::from(pagination.limit + 1)),
                ..Default::default()
            },
        ),
        super::counts::documents(&state, "builds.history", &parts, LIST_TTL, "builds", base),
        previous_comparable_build_id(&state, &build, effective_build_platform(&build),)
    );
    let rows = match rows {
        Ok(rows) => rows,
        Err(_) => return fail(&request, &super::system::internal_error()),
    };
    let total = match total {
        Ok(total) => total,
        Err(error) => return fail(&request, &error),
    };
    let page = trim_page(rows, pagination.limit as usize);
    let last_row = page.items.last().map(bson_doc_to_js_json);
    let mut data = Vec::new();
    for row in &page.items {
        let entry = bson_doc_to_js_json(row);
        let mut record = match stored_build_summary(&entry, None) {
            Ok(summary) => egdata_core::v1::serialize_value(&summary),
            Err(error) => return fail(&request, &error),
        };
        record["comparable"] = json!(
            entry["manifestId"].is_string()
                && matches!(
                    record["manifest"]["status"].as_str(),
                    Some("verified" | "legacy_unverified")
                )
        );
        record["sameStream"] =
            json!(entry["labelName"].as_str() == Some(build.label_name.as_str()));
        data.push(record);
    }
    let next_cursor = if let Some(row) = last_row.as_ref().filter(|_| page.has_more) {
        let first = iso_or_null(&row["firstSeenAt"]);
        let created = iso_or_null(&row["createdAt"]);
        let row_id = js_string(&row["_id"]);
        match egdata_core::v1::encode_cursor_with_filter_order(
            &binding,
            &[
                CursorSortValue::from(first),
                CursorSortValue::from(created),
                CursorSortValue::from(row_id),
            ],
            state.config.v1_cursor_secret.as_deref(),
            (state.now)().timestamp_millis(),
            &["id", "scope"],
        ) {
            Ok(cursor) => Some(cursor),
            Err(error) => return fail(&request, &error),
        }
    } else {
        None
    };
    let previous = match previous {
        Ok(previous) => previous,
        Err(error) => return fail(&request, &error),
    };
    let pagination_meta = page_meta(pagination.limit, page.has_more, next_cursor).with_total(total);
    let cached_value =
        json!({"data": data, "pagination": pagination_meta, "previousComparableBuildId": previous});
    v1_cache_set(state.cache.as_ref(), &cache_key, &cached_value, LIST_TTL).await;
    json_success(
        method(&request),
        request.uri().path(),
        &context(&request).request_id,
        cached_value["data"].clone(),
        Some(
            json!({"count": data.len(), "scope": scope, "previousComparableBuildId": cached_value["previousComparableBuildId"], "pagination": cached_value["pagination"]}),
        ),
    )
}



async fn build_tree(
    State(state): State<AppState>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    let query = match build_query(
        &request,
        &["limit", "cursor", "path"],
        &[("path", QueryRule::MaxLength(500))],
    ) {
        Ok(query) => query,
        Err(error) => return fail(&request, &error),
    };
    let pagination = match parse_pagination_map(&query, 100) {
        Ok(v) => v,
        Err(e) => return fail(&request, &e),
    };
    let build = match load_stored_build(&state, &id).await {
        Ok(v) => v,
        Err(e) => return fail(&request, &e),
    };
    let path = match egdata_core::builds::normalize_build_tree_path(
        query.get("path").map(String::as_str),
    ) {
        Some(path) => path,
        None => {
            return fail(
                    &request,
                    &ProblemError::new(
                        400,
                        "INVALID_PATH",
                        "The `path` parameter must be a relative manifest directory that uses forward slashes and does not ascend above the build root.",
                    ).with_errors(vec![ProblemIssue {
                        pointer: None,
                        parameter: Some("path".into()),
                        code: "INVALID".into(),
                        message: "Expected a normalized relative directory path.".into(),
                    }]),
                );
        }
    };
    let binding = CursorBinding {
        operation: "builds.tree".into(),
        filters: Some(BTreeMap::from([
            ("id".into(), json!(id)),
            ("path".into(), json!(path)),
        ])),
        ordering: "type:asc,name:asc".into(),
        country: GLOBAL_CURSOR_SCOPE.0.into(),
        locale: GLOBAL_CURSOR_SCOPE.1.into(),
        limit: pagination.limit,
    };
    let cache_key = v1_cache_key(
        "builds.tree",
        &BTreeMap::from([
            ("id", json!(id)),
            ("path", json!(path)),
            ("limit", json!(pagination.limit)),
            ("cursor", json!(pagination.cursor)),
        ]),
    );
    if let Some(cached) = v1_cache_get(state.cache.as_ref(), &cache_key).await {
        let nodes = cached["nodes"].clone();
        let count = nodes.as_array().map_or(0, Vec::len);
        return json_success(
            method(&request),
            request.uri().path(),
            &context(&request).request_id,
            nodes,
            Some(
                json!({"count": count, "path": path, "manifestStatus": egdata_infra::bson_json::bson_to_js_json(&stored::manifest_status(&build)), "pagination": cached["pagination"]}),
            ),
        );
    }
    let last = match pagination.cursor.as_deref() {
        Some(raw) => match decode_cursor_with(
            raw,
            &binding,
            state.config.v1_cursor_secret.as_deref(),
            (state.now)().timestamp_millis(),
        ) {
            Ok(tuple) => Some(tuple),
            Err(error) => return fail(&request, &error),
        },
        None => None,
    };
    let mut pipeline = tree_group_pipeline(stored::snapshot_filter(&build), &path, |prefix| {
        Bson::String(format!("^{}", regex::escape(prefix)))
    });
    let mut base = pipeline.clone();
    base.push(doc! {"$project":{"_id":1}});
    if let Some(tuple) = &last {
        let fields = [
            MongoSortField::new("_id.type", SortDirection::Asc, NullsOrder::First),
            MongoSortField::new("_id.name", SortDirection::Asc, NullsOrder::First),
        ];
        let values = [
            tuple.first().map_or(Bson::Null, cursor_bson),
            tuple.get(1).map_or(Bson::Null, cursor_bson),
        ];
        let keyset = fixed_keyset(&fields, &values);
        pipeline.push(doc! {"$match": keyset});
    }
    pipeline.push(doc! {"$sort": {"_id.type": 1, "_id.name": 1}});
    pipeline.push(doc! {"$limit": i64::from(pagination.limit + 1)});
    pipeline.push(tree_projection());
    let parts = [("id", json!(id)), ("path", json!(path))];
    let (rows, total) = tokio::join!(
        state.mongo.aggregate("files", pipeline),
        super::counts::aggregate(&state, "builds.tree", &parts, SNAPSHOT_TTL, "files", base)
    );
    let rows = match rows {
        Ok(rows) => rows,
        Err(_) => return fail(&request, &super::system::internal_error()),
    };
    let total = match total {
        Ok(total) => total,
        Err(error) => return fail(&request, &error),
    };
    let page = trim_page(rows, pagination.limit as usize);
    let nodes: Vec<_> = page
        .items
        .iter()
        .map(|row| {
            let mut node = bson_to_serialized_json(&Bson::Document(row.clone()));
            let name = node
                .get("name")
                .map_or_else(|| "undefined".into(), js_string);
            node["path"] = if path.is_empty() {
                json!(name)
            } else {
                json!(format!("{path}/{name}"))
            };
            node
        })
        .collect();
    let last_node = nodes.last();
    let next_cursor = if let Some(node) = last_node.filter(|_| page.has_more) {
        let stringify = |key: &str| node.get(key).map_or_else(|| "undefined".into(), js_string);
        let kind = stringify("type");
        let name = stringify("name");
        match egdata_core::v1::encode_cursor_with_filter_order(
            &binding,
            &[CursorSortValue::from(kind), CursorSortValue::from(name)],
            state.config.v1_cursor_secret.as_deref(),
            (state.now)().timestamp_millis(),
            &["id", "path"],
        ) {
            Ok(cursor) => Some(cursor),
            Err(error) => return fail(&request, &error),
        }
    } else {
        None
    };
    let cached = json!({"nodes": nodes, "pagination": page_meta(pagination.limit, page.has_more, next_cursor).with_total(total)});
    v1_cache_set(state.cache.as_ref(), &cache_key, &cached, 300).await;
    json_success(
        method(&request),
        request.uri().path(),
        &context(&request).request_id,
        cached["nodes"].clone(),
        Some(
            json!({"count": nodes.len(), "path": path, "manifestStatus": egdata_infra::bson_json::bson_to_js_json(&stored::manifest_status(&build)), "pagination": cached["pagination"]}),
        ),
    )
}

// JavaScript adds numeric sizes but concatenates a historical string size.









// Arrays and documents from independent Mongo reads remain distinct objects.
// Preserve insertion order before the stable JavaScript UTF-16 tag sort.


// Keep the projected document intact for the HTTP response. Historical files
// can have missing, null or non-string metadata; each is observable in Node.















async fn compare_builds(
    State(state): State<AppState>,
    Path((target_id, base_id)): Path<(String, String)>,
    request: Request,
) -> Response {
    let query = match build_query(
        &request,
        &["limit", "cursor", "dir", "q", "status", "extension"],
        &[
            ("dir", QueryRule::Choices(&["asc", "desc"])),
            ("q", QueryRule::MaxLength(200)),
            ("status", QueryRule::MaxLength(500)),
            ("extension", QueryRule::MaxLength(500)),
        ],
    ) {
        Ok(query) => query,
        Err(error) => return fail(&request, &error),
    };
    let direction_value = query.get("dir").map(String::as_str).unwrap_or("asc");
    let pagination = match parse_pagination_map(&query, 100) {
        Ok(v) => v,
        Err(e) => return fail(&request, &e),
    };
    let direction = if direction_value == "desc" {
        BuildComparisonDirection::Desc
    } else {
        BuildComparisonDirection::Asc
    };
    let statuses = egdata_core::v1::parse_csv(query.get("status").map(String::as_str))
        .unwrap_or_else(|| vec!["added".into(), "modified".into(), "removed".into()]);
    let mut status_set = HashSet::new();
    for status in &statuses {
        let parsed = match status.as_str() {
            "added" => BuildFileChangeStatus::Added,
            "removed" => BuildFileChangeStatus::Removed,
            "modified" => BuildFileChangeStatus::Modified,
            "unchanged" => BuildFileChangeStatus::Unchanged,
            _ => {
                return fail(
                    &request,
                    &ProblemError::new(
                        400,
                        "INVALID_QUERY",
                        format!(
                            "The `status` parameter contains an unsupported status '{status}'."
                        ),
                    )
                    .with_errors(vec![ProblemIssue {
                        pointer: None,
                        parameter: Some("status".into()),
                        code: "INVALID".into(),
                        message: "Expected added, removed, modified, or unchanged.".into(),
                    }]),
                );
            }
        };
        status_set.insert(parsed);
    }
    let extension_values = match file_extensions(query.get("extension").map(String::as_str)) {
        Ok(values) => values,
        Err(error) => return fail(&request, &error),
    };
    let extensions = (!extension_values.is_empty())
        .then(|| extension_values.iter().cloned().collect::<HashSet<_>>());
    let (target, base) = tokio::join!(
        load_stored_build(&state, &target_id),
        load_stored_build(&state, &base_id)
    );
    let (target, base) = match target.and_then(|target| base.map(|base| (target, base))) {
        Ok(pair) => pair,
        Err(e) => return fail(&request, &e),
    };
    let compatible = match stored::compatible(&base, &target) {
        Ok(value) => value,
        Err(e) => return fail(&request, &e),
    };
    if !compatible {
        return fail(
            &request,
            &ProblemError::new(
                400,
                "INCOMPATIBLE_BUILDS",
                "Both builds must use the same app name and platform.",
            ),
        );
    }
    if !stored::stored_comparable(&target) || !stored::stored_comparable(&base) {
        return fail(
            &request,
            &ProblemError::new(
                409,
                "MANIFEST_NOT_COMPARABLE",
                "Both builds must have a stored file snapshot before they can be compared.",
            ),
        );
    }
    let search = query
        .get("q")
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    let binding = CursorBinding {
        operation: "builds.compare".into(),
        filters: Some(BTreeMap::from([
            ("targetId".into(), json!(target_id)),
            ("baseId".into(), json!(base_id)),
            (
                "dir".into(),
                json!(if direction == BuildComparisonDirection::Asc {
                    "asc"
                } else {
                    "desc"
                }),
            ),
            ("statuses".into(), json!(statuses)),
            (
                "extensions".into(),
                if extensions.as_ref().is_some_and(|s| !s.is_empty()) {
                    json!(extension_values)
                } else {
                    Value::Null
                },
            ),
            ("q".into(), search.clone().map_or(Value::Null, |q| json!(q))),
        ])),
        ordering: format!(
            "fileName:{}",
            if direction == BuildComparisonDirection::Asc {
                "asc"
            } else {
                "desc"
            }
        ),
        country: GLOBAL_CURSOR_SCOPE.0.into(),
        locale: GLOBAL_CURSOR_SCOPE.1.into(),
        limit: pagination.limit,
    };
    let updated_at = |row: &Document| match row.get("updatedAt") {
        Some(Bson::DateTime(d)) => Ok(d.timestamp_millis()),
        None | Some(Bson::Null) => Ok(0),
        _ => Err(super::system::internal_error()),
    };
    let (target_time, base_time) =
        match updated_at(&target).and_then(|t| updated_at(&base).map(|b| (t, b))) {
            Ok(times) => times,
            Err(e) => return fail(&request, &e),
        };
    let cache_key = v1_cache_key(
        "builds.compare",
        &BTreeMap::from([
            ("targetId", json!(target_id)),
            ("baseId", json!(base_id)),
            ("targetUpdatedAt", json!(target_time)),
            ("baseUpdatedAt", json!(base_time)),
            (
                "dir",
                json!(if direction == BuildComparisonDirection::Asc {
                    "asc"
                } else {
                    "desc"
                }),
            ),
            ("statuses", json!(statuses)),
            (
                "extensions",
                if extensions.as_ref().is_some_and(|s| !s.is_empty()) {
                    json!(extension_values)
                } else {
                    Value::Null
                },
            ),
            ("q", search.clone().map_or(Value::Null, |q| json!(q))),
            ("limit", json!(pagination.limit)),
            ("cursor", json!(pagination.cursor)),
        ]),
    );
    if let Some(cached) = v1_cache_get(state.cache.as_ref(), &cache_key).await {
        let data = cached["data"].clone();
        return json_success(
            method(&request),
            request.uri().path(),
            &context(&request).request_id,
            data.clone(),
            Some(
                json!({"count": data["changes"].as_array().map_or(0, Vec::len), "pagination": cached["pagination"]}),
            ),
        );
    }
    let last = match pagination.cursor.as_deref() {
        Some(raw) => match decode_cursor_with(
            raw,
            &binding,
            state.config.v1_cursor_secret.as_deref(),
            (state.now)().timestamp_millis(),
        ) {
            Ok(tuple) => tuple
                .first()
                .and_then(CursorSortValue::as_str)
                .map(str::to_owned),
            Err(error) => return fail(&request, &error),
        },
        None => None,
    };
    let comparison = match read_comparison(
        &state,
        &base,
        &target,
        CompareStreamFilters {
            offset: 0,
            statuses: &status_set,
            query: search.as_deref(),
            extensions: &extensions,
            direction,
            after_path: last.as_deref(),
            limit: pagination.limit as usize,
        },
    )
    .await
    {
        Ok(value) => value,
        Err(error) => return fail(&request, &error),
    };
    let last_path = comparison.changes.last().map(|c| c.path.as_str());
    let data = match stored::comparison_payload(&base, &target, &comparison, |row| {
        stored_build_summary(row, None).map(|value| egdata_core::v1::serialize_value(&value))
    }) {
        Ok(value) => value,
        Err(e) => return fail(&request, &e),
    };
    let next_cursor = if let Some(path) = last_path.filter(|_| comparison.has_more) {
        match egdata_core::v1::encode_cursor_with_filter_order(
            &binding,
            &[CursorSortValue::from(path)],
            state.config.v1_cursor_secret.as_deref(),
            (state.now)().timestamp_millis(),
            &["targetId", "baseId", "dir", "statuses", "extensions", "q"],
        ) {
            Ok(value) => Some(value),
            Err(error) => return fail(&request, &error),
        }
    } else {
        None
    };
    let pagination_value = page_meta(pagination.limit, comparison.has_more, next_cursor)
        .with_total(comparison.filtered_count);
    let mut cached = json!({"data": data, "pagination": pagination_value});
    v1_cache_set(state.cache.as_ref(), &cache_key, &cached, SNAPSHOT_TTL).await;
    json_success(
        method(&request),
        request.uri().path(),
        &context(&request).request_id,
        cached["data"].take(),
        Some(json!({"count": comparison.changes.len(), "pagination": cached["pagination"]})),
    )
}

async fn build_items(
    State(state): State<AppState>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    let query = match parse_strict_query_uri(request.uri(), &["limit", "cursor"]) {
        Ok(query) => query,
        Err(error) => return fail(&request, &error),
    };
    let pagination = match parse_pagination_map(&query, 100) {
        Ok(value) => value,
        Err(error) => return fail(&request, &error),
    };
    let build = match load_stored_build(&state, &id).await {
        Ok(build) => build,
        Err(error) => return fail(&request, &error),
    };
    let binding = CursorBinding {
        operation: "builds.items".into(),
        filters: Some(BTreeMap::from([("id".into(), json!(id))])),
        ordering: "id:asc".into(),
        country: GLOBAL_CURSOR_SCOPE.0.into(),
        locale: GLOBAL_CURSOR_SCOPE.1.into(),
        limit: pagination.limit,
    };
    let cache_key = v1_cache_key(
        "builds.items",
        &BTreeMap::from([
            ("id", json!(id)),
            ("limit", json!(pagination.limit)),
            ("cursor", json!(pagination.cursor)),
        ]),
    );
    if let Some(cached) = v1_cache_get(state.cache.as_ref(), &cache_key).await {
        let data = cached["data"].clone();
        return json_success(
            method(&request),
            request.uri().path(),
            &context(&request).request_id,
            data.clone(),
            Some(
                json!({"count": data.as_array().map_or(0, Vec::len), "pagination": cached["pagination"]}),
            ),
        );
    }
    let last = match pagination.cursor.as_deref() {
        Some(raw) => match decode_cursor_with(
            raw,
            &binding,
            state.config.v1_cursor_secret.as_deref(),
            (state.now)().timestamp_millis(),
        ) {
            Ok(tuple) => Some(tuple),
            Err(error) => return fail(&request, &error),
        },
        None => None,
    };
    let base = doc! {"releaseInfo.appId":build.get("appName").unwrap_or(&Bson::Null)};
    let mut clauses = vec![base.clone()];
    if let Some(tuple) = &last {
        let value = tuple.first().map_or(Bson::Null, cursor_bson);
        clauses.push(fixed_keyset(
            &[MongoSortField::new(
                "id",
                SortDirection::Asc,
                NullsOrder::First,
            )],
            &[value],
        ));
    }
    let filter = if clauses.len() == 1 {
        clauses.remove(0)
    } else {
        doc! {"$and": clauses}
    };
    let parts = [("id", json!(id))];
    let (rows, total) = tokio::join!(
        state.mongo.find_many(
            "items",
            filter,
            MongoFindOptions {
                sort: Some(doc! {"id": 1}),
                limit: Some(i64::from(pagination.limit + 1)),
                ..Default::default()
            },
        ),
        super::counts::documents(&state, "builds.items", &parts, LIST_TTL, "items", base)
    );
    let rows = match rows {
        Ok(rows) => rows,
        Err(_) => return fail(&request, &super::system::internal_error()),
    };
    let total = match total {
        Ok(total) => total,
        Err(error) => return fail(&request, &error),
    };
    let page = trim_page(rows, pagination.limit as usize);
    let last_row = page.items.last();
    let data: Vec<_> = page
        .items
        .iter()
        .map(super::item_serialization::stored_item)
        .collect();
    let next_cursor = if let Some(row) = last_row.filter(|_| page.has_more) {
        match encode_cursor_with(
            &binding,
            &[CursorSortValue::from(
                row.get_str("id")
                    .ok()
                    .filter(|id| !id.is_empty())
                    .map(str::to_owned),
            )],
            state.config.v1_cursor_secret.as_deref(),
            (state.now)().timestamp_millis(),
        ) {
            Ok(token) => Some(token),
            Err(error) => return fail(&request, &error),
        }
    } else {
        None
    };
    let cached = json!({"data": data, "pagination": page_meta(pagination.limit, page.has_more, next_cursor).with_total(total)});
    v1_cache_set(state.cache.as_ref(), &cache_key, &cached, LIST_TTL).await;
    json_success(
        method(&request),
        request.uri().path(),
        &context(&request).request_id,
        cached["data"].clone(),
        Some(json!({"count": data.len(), "pagination": cached["pagination"]})),
    )
}

async fn install_options(
    State(state): State<AppState>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    if let Err(error) = parse_strict_query_uri(request.uri(), &[]) {
        return fail(&request, &error);
    }
    let build = match load_stored_build(&state, &id).await {
        Ok(build) => build,
        Err(error) => return fail(&request, &error),
    };
    let cache_key = v1_cache_key(
        "builds.install-options",
        &BTreeMap::from([("id", json!(id))]),
    );
    if let Some(cached) = v1_cache_get(state.cache.as_ref(), &cache_key).await {
        let options = cached["options"].clone();
        let count = options.as_object().map_or(0, serde_json::Map::len);
        return json_success(
            method(&request),
            request.uri().path(),
            &context(&request).request_id,
            options,
            Some(json!({"count": count, "truncated": cached["truncated"]})),
        );
    }
    let mut filter = stored::snapshot_filter(&build);
    filter.insert("installTags", doc! {"$exists":true,"$not":{"$size":0}});
    let rows = match state.mongo.aggregate("files", vec![
        doc! {"$match":filter},
        doc! {"$unwind": "$installTags"},
        doc! {"$group": {"_id": "$installTags", "files": {"$sum": 1}, "size": {"$sum": {"$ifNull": ["$fileSize", 0]}}}},
        doc! {"$sort": {"_id": 1}}, doc! {"$limit": 200},
    ]).await {
        Ok(rows) => rows, Err(_) => return fail(&request, &super::system::internal_error()),
    };
    let mut options = serde_json::Map::new();
    for row in &rows {
        let fields = bson_doc_to_js_json(row);
        let key = fields
            .get("_id")
            .map_or_else(|| "undefined".into(), js_string);
        let mut entry = json!({});
        for name in ["files", "size"] {
            if let Some(value) = fields.get(name) {
                entry[name] = value.clone();
            }
        }
        options.insert(key, entry);
    }
    let truncated = rows.len() >= 200;
    let cached = json!({"options": options, "truncated": truncated});
    v1_cache_set(state.cache.as_ref(), &cache_key, &cached, 300).await;
    json_success(
        method(&request),
        request.uri().path(),
        &context(&request).request_id,
        cached["options"].clone(),
        Some(
            json!({"count": cached["options"].as_object().map_or(0, serde_json::Map::len), "truncated": truncated}),
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{test_support::test_app_state, state::ApiConfig};
    use async_trait::async_trait;
    use axum::{
        Router,
        body::Body,
        http::{Request as HttpRequest, StatusCode},
    };
    use bson::{Bson, Document, oid::ObjectId};
    use egdata_core::builds::BuildFileSnapshot;
    use egdata_core::{
        error::CoreError,
        ports::{MongoStorePort, ResponseCachePort},
    };
    use futures::stream;
    use http_body_util::BodyExt;
    use serde_json::Value;
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;

    fn app() -> Router {
        let state = test_app_state(ApiConfig::default());
        crate::router(&state).with_state(state)
    }

    fn get(path: &str) -> HttpRequest<Body> {
        HttpRequest::builder()
            .uri(path)
            .header("x-egdata-key-id", "key_test1234")
            .header("x-egdata-key-tier", "free")
            .body(Body::empty())
            .unwrap()
    }

    fn cursor_time() -> i64 {
        chrono::Utc::now().timestamp_millis()
    }

    async fn json(response: Response) -> Value {
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
    }

    #[derive(Default)]
    pub(super) struct RecordingCache {
        pub(super) values: Mutex<std::collections::HashMap<String, String>>,
        gets: Mutex<Vec<String>>,
        pub(super) sets: Mutex<Vec<(String, String, u64)>>,
    }

    #[async_trait]
    impl ResponseCachePort for RecordingCache {
        async fn get(&self, key: &str) -> Result<Option<String>, CoreError> {
            self.gets.lock().unwrap().push(key.to_owned());
            Ok(self.values.lock().unwrap().get(key).cloned())
        }
        async fn set(&self, key: &str, value: &str, ttl_seconds: u64) -> Result<(), CoreError> {
            self.sets
                .lock()
                .unwrap()
                .push((key.to_owned(), value.to_owned(), ttl_seconds));
            self.values
                .lock()
                .unwrap()
                .insert(key.to_owned(), value.to_owned());
            Ok(())
        }
        async fn del(&self, key: &str) -> Result<(), CoreError> {
            self.values.lock().unwrap().remove(key);
            Ok(())
        }
        async fn ping(&self) -> Result<bool, CoreError> {
            Ok(true)
        }
    }

    #[tokio::test]
    async fn list_rejects_unknown_and_bad_sort_query_and_returns_empty_page() {
        for (path, code) in [
            ("/v1/builds?unexpected=1", "INVALID_QUERY"),
            ("/v1/builds?sortBy=labelName", "INVALID_QUERY"),
            ("/v1/builds?limit=0", "INVALID_LIMIT"),
        ] {
            let response = app().oneshot(get(path)).await.unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            assert_eq!(json(response).await["code"], code);
        }
        let response = app().oneshot(get("/v1/builds?limit=7")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json(response).await;
        assert_eq!(body["data"], json!([]));
        assert_eq!(body["meta"]["count"], 0);
        assert_eq!(body["meta"]["pagination"]["limit"], 7);
        assert_eq!(body["meta"]["pagination"]["hasMore"], false);
    }

    #[tokio::test]
    async fn detail_rejects_invalid_ids_and_reports_missing_builds() {
        let invalid = app().oneshot(get("/v1/builds/nope")).await.unwrap();
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        assert_eq!(json(invalid).await["code"], "INVALID_BUILD_ID");
        let missing = app()
            .oneshot(get("/v1/builds/507f1f77bcf86cd799439011"))
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        assert_eq!(json(missing).await["code"], "BUILD_NOT_FOUND");
    }

    #[tokio::test]
    async fn snapshot_queries_reject_unknown_parameters_before_loading() {
        let response = app()
            .oneshot(get("/v1/builds/507f1f77bcf86cd799439011/files?x=1"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(json(response).await["code"], "INVALID_QUERY");
    }

    #[tokio::test]
    async fn list_cursor_continues_and_rejects_a_binding_mismatch() {
        let state = test_app_state(ApiConfig::default());
        let app = crate::router(&state).with_state(state.clone());
        let binding = list_cursor_binding("createdAt", "desc", 7);
        let token = encode_cursor_with(
            &binding,
            &[
                CursorSortValue::Null,
                CursorSortValue::from("507f1f77bcf86cd799439011"),
            ],
            state.config.v1_cursor_secret.as_deref(),
            cursor_time(),
        )
        .unwrap();
        let continued = app
            .clone()
            .oneshot(get(&format!("/v1/builds?limit=7&cursor={token}")))
            .await
            .unwrap();
        assert_eq!(continued.status(), StatusCode::OK);
        assert!(json(continued).await["data"].is_array());
        let mismatch = app
            .oneshot(get(&format!(
                "/v1/builds?limit=7&sortBy=updatedAt&cursor={token}"
            )))
            .await
            .unwrap();
        assert_eq!(mismatch.status(), StatusCode::BAD_REQUEST);
        assert_eq!(json(mismatch).await["code"], "CURSOR_MISMATCH");
    }

    #[derive(Clone)]
    struct CursorMongo {
        build: Document,
        file_filters: Arc<Mutex<Vec<Document>>>,
        stream_batches: Arc<Mutex<std::collections::VecDeque<Vec<Document>>>>,
        stream_calls: Arc<Mutex<Vec<(String, Document, MongoFindOptions)>>>,
        stream_error: bool,
        item_rows: Vec<Document>,
        item_filters: Arc<Mutex<Vec<Document>>>,
        aggregate_rows: Vec<Document>,
        pipelines: Arc<Mutex<Vec<Vec<Document>>>>,
    }

    #[async_trait]
    impl MongoStorePort for CursorMongo {
        async fn find_one(
            &self,
            collection: &str,
            _filter: Document,
            _projection: Option<Document>,
        ) -> Result<Option<Document>, CoreError> {
            Ok((collection == "builds").then(|| self.build.clone()))
        }
        async fn find_many(
            &self,
            collection: &str,
            filter: Document,
            _options: MongoFindOptions,
        ) -> Result<Vec<Document>, CoreError> {
            if collection == "files" {
                self.file_filters.lock().unwrap().push(filter);
                return Ok(Vec::new());
            }
            if collection == "items" {
                self.item_filters.lock().unwrap().push(filter);
                return Ok(self.item_rows.clone());
            }
            Ok(Vec::new())
        }
        async fn find_stream(
            &self,
            collection: &str,
            filter: Document,
            options: MongoFindOptions,
        ) -> Result<egdata_core::ports::MongoDocumentStream, CoreError> {
            self.stream_calls
                .lock()
                .unwrap()
                .push((collection.to_owned(), filter, options));
            if self.stream_error {
                return Err(CoreError::Internal("snapshot stream failed".into()));
            }
            let rows = self
                .stream_batches
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_default();
            Ok(Box::pin(stream::iter(rows.into_iter().map(Ok))))
        }
        async fn aggregate(
            &self,
            _collection: &str,
            pipeline: Vec<Document>,
        ) -> Result<Vec<Document>, CoreError> {
            self.pipelines.lock().unwrap().push(pipeline);
            Ok(self.aggregate_rows.clone())
        }
        async fn count_documents(
            &self,
            _collection: &str,
            _filter: Document,
        ) -> Result<u64, CoreError> {
            Ok(0)
        }
        async fn distinct(
            &self,
            _collection: &str,
            _field: &str,
            _filter: Document,
        ) -> Result<Vec<Bson>, CoreError> {
            Ok(Vec::new())
        }
        async fn insert_one(&self, _collection: &str, _doc: Document) -> Result<(), CoreError> {
            Ok(())
        }
        async fn update_one(
            &self,
            _collection: &str,
            _filter: Document,
            _update: Document,
            _upsert: bool,
        ) -> Result<u64, CoreError> {
            Ok(0)
        }
        async fn delete_one(&self, _collection: &str, _filter: Document) -> Result<u64, CoreError> {
            Ok(0)
        }
        async fn ping(&self) -> Result<bool, CoreError> {
            Ok(true)
        }
    }

    fn cursor_build_document() -> Document {
        bson::to_document(&BuildDocument {
            id: ObjectId::parse_str("507f1f77bcf86cd799439011").unwrap(),
            app_name: "TestApp".into(),
            build_version: "1".into(),
            label_name: "Test-Windows".into(),
            platform: Some("Windows".into()),
            hash: "hash".into(),
            source_manifest_hash: None,
            manifest_id: Some("manifest".into()),
            manifest_status: Some(egdata_core::builds::ManifestStatus::Verified),
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
        })
        .unwrap()
    }

    fn file_snapshot(name: &str, hash: &str, size: i64) -> Document {
        bson::to_document(&BuildFileSnapshot {
            file_name: name.into(),
            file_hash: hash.into(),
            file_size: size,
            mime_type: Some("application/octet-stream".into()),
            install_tags: Some(vec!["base".into()]),
            symlink_target: None,
            file_meta_flags: None,
        })
        .unwrap()
    }

    fn compare_mock(
        rows: Vec<Document>,
        calls: Arc<Mutex<Vec<(String, Document, MongoFindOptions)>>>,
    ) -> CursorMongo {
        let mut streams = std::collections::VecDeque::new();
        streams.push_back(Vec::new()); // base stream
        streams.push_back(rows); // target stream
        CursorMongo {
            build: cursor_build_document(),
            file_filters: Arc::new(Mutex::new(Vec::new())),
            stream_batches: Arc::new(Mutex::new(streams)),
            stream_calls: calls,
            stream_error: false,
            item_rows: Vec::new(),
            item_filters: Arc::new(Mutex::new(Vec::new())),
            aggregate_rows: Vec::new(),
            pipelines: Arc::new(Mutex::new(Vec::new())),
        }
    }

    #[tokio::test]
    async fn compare_route_streams_projection_and_caches_node_shaped_cursor_pages() {
        let id = "507f1f77bcf86cd799439011";
        let snapshots = vec![
            file_snapshot("a.bin", "a", 4),
            file_snapshot("b.bin", "b", 7),
        ];
        let calls = Arc::new(Mutex::new(Vec::new()));
        let cache = Arc::new(RecordingCache::default());
        let mut state = test_app_state(ApiConfig::default());
        state.mongo = Arc::new(compare_mock(snapshots.clone(), calls.clone()));
        state.cache = cache.clone();
        let app = crate::router(&state).with_state(state);
        let path = format!("/v1/builds/{id}/compare/{id}?limit=1&status=added");

        let first = app.clone().oneshot(get(&path)).await.unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        let first: Value = json(first).await;
        assert_eq!(first["data"]["summary"]["files"]["added"], 2);
        assert_eq!(first["data"]["changes"][0]["path"], "a.bin");
        assert_eq!(first["meta"]["pagination"]["hasMore"], true);
        assert_eq!(first["data"]["warnings"], json!([]));
        let cursor = first["meta"]["pagination"]["nextCursor"]
            .as_str()
            .unwrap()
            .to_owned();
        {
            let recorded = calls.lock().unwrap();
            assert_eq!(recorded.len(), 2);
            for (collection, filter, options) in recorded.iter() {
                assert_eq!(collection, "files");
                assert_eq!(
                    filter,
                    &doc! {"manifestId": {"$eq": "manifest", "$type": "string"}}
                );
                assert_eq!(
                    options.projection.as_ref().unwrap(),
                    &doc! {"_id": 0, "fileName": 1, "fileHash": 1, "fileSize": 1, "mimeType": 1, "installTags": 1, "symlinkTarget": 1, "fileMetaFlags": 1}
                );
                assert_eq!(options.sort.as_ref().unwrap(), &doc! {"fileName": 1});
            }
        }
        let node_fixture: Value =
            serde_json::from_str(include_str!("fixtures/build-comparison-node.json")).unwrap();
        let expected_key = node_fixture["expectedCacheKey"].as_str().unwrap();
        {
            let sets = cache.sets.lock().unwrap();
            assert_eq!(sets.len(), 1);
            assert_eq!(sets[0].0, expected_key);
            assert_eq!(sets[0].2, 300);
            let payload: Value = serde_json::from_str(&sets[0].1).unwrap();
            assert_eq!(payload["data"]["changes"][0]["path"], "a.bin");
            assert_eq!(payload["pagination"]["nextCursor"], cursor);
        }

        let mut state = test_app_state(ApiConfig::default());
        state.mongo = Arc::new(compare_mock(snapshots, calls.clone()));
        state.cache = cache.clone();
        let app = crate::router(&state).with_state(state);
        let second_path =
            format!("/v1/builds/{id}/compare/{id}?limit=1&status=added&cursor={cursor}");
        let second = app.clone().oneshot(get(&second_path)).await.unwrap();
        assert_eq!(second.status(), StatusCode::OK);
        let second: Value = json(second).await;
        assert_eq!(second["data"]["changes"][0]["path"], "b.bin");
        assert_eq!(second["meta"]["pagination"]["hasMore"], false);
        assert_eq!(calls.lock().unwrap().len(), 4);

        let hit = app.clone().oneshot(get(&second_path)).await.unwrap();
        assert_eq!(hit.status(), StatusCode::OK);
        assert_eq!(json(hit).await["data"]["changes"][0]["path"], "b.bin");
        assert_eq!(
            calls.lock().unwrap().len(),
            4,
            "cache hit bypasses Mongo streams"
        );
        assert_eq!(
            cache.gets.lock().unwrap().last().unwrap(),
            &cache.sets.lock().unwrap()[1].0
        );

        let mismatch_binding = CursorBinding {
            operation: "builds.compare".into(),
            filters: Some(BTreeMap::from([
                ("targetId".into(), json!(id)),
                ("baseId".into(), json!(id)),
                ("dir".into(), json!("asc")),
                ("statuses".into(), json!(["removed"])),
                ("extensions".into(), Value::Null),
                ("q".into(), Value::Null),
            ])),
            ordering: "fileName:asc".into(),
            country: "".into(),
            locale: "".into(),
            limit: 1,
        };
        let bad_cursor = encode_cursor_with(
            &mismatch_binding,
            &[CursorSortValue::from("a.bin")],
            ApiConfig::default().v1_cursor_secret.as_deref(),
            cursor_time(),
        )
        .unwrap();
        let response = app
            .oneshot(get(&format!(
                "/v1/builds/{id}/compare/{id}?limit=1&status=added&cursor={bad_cursor}"
            )))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(json(response).await["code"], "CURSOR_MISMATCH");
        assert_eq!(
            calls.lock().unwrap().len(),
            4,
            "bad cursor fails before snapshot reads"
        );
    }

    #[tokio::test]
    async fn compare_route_propagates_stream_errors_and_matches_zod_query_errors() {
        let id = "507f1f77bcf86cd799439011";
        let mut mongo = compare_mock(Vec::new(), Arc::new(Mutex::new(Vec::new())));
        mongo.stream_error = true;
        let mut state = test_app_state(ApiConfig::default());
        state.mongo = Arc::new(mongo);
        let app = crate::router(&state).with_state(state);
        let failed = app
            .clone()
            .oneshot(get(&format!("/v1/builds/{id}/compare/{id}")))
            .await
            .unwrap();
        assert_eq!(failed.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            json(failed).await["detail"],
            "The API could not complete the request. Retry later and include the request ID when contacting support."
        );

        let invalid_dir = app
            .clone()
            .oneshot(get(&format!("/v1/builds/{id}/compare/{id}?dir=sideways")))
            .await
            .unwrap();
        assert_eq!(invalid_dir.status(), StatusCode::BAD_REQUEST);
        let body = json(invalid_dir).await;
        assert_eq!(
            body["detail"],
            "One or more query parameters are invalid or not supported."
        );
        assert_eq!(body["errors"][0]["parameter"], "dir");
        assert_eq!(body["errors"][0]["code"], "INVALID_VALUE");
        assert_eq!(
            body["errors"][0]["message"],
            "Invalid option: expected one of \"asc\"|\"desc\""
        );

        let invalid_status = app
            .clone()
            .oneshot(get(&format!("/v1/builds/{id}/compare/{id}?status=corrupt")))
            .await
            .unwrap();
        assert_eq!(invalid_status.status(), StatusCode::BAD_REQUEST);
        let body = json(invalid_status).await;
        assert_eq!(
            body["detail"],
            "The `status` parameter contains an unsupported status 'corrupt'."
        );
        assert_eq!(body["errors"][0]["code"], "INVALID");

        let many_extensions = (0..21)
            .map(|n| format!(".ext{n}"))
            .collect::<Vec<_>>()
            .join(",");
        let response = app
            .oneshot(get(&format!(
                "/v1/builds/{id}/compare/{id}?extension={many_extensions}"
            )))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = json(response).await;
        assert_eq!(
            body["detail"],
            "At most 20 distinct extensions can be filtered at once."
        );
        assert_eq!(body["errors"][0]["code"], "TOO_MANY");
        assert_eq!(
            body["errors"][0]["message"],
            "The parameter contains 21 distinct extensions."
        );
    }

    fn files_binding(id: &str, sort: &str, dir: &str, limit: u32) -> CursorBinding {
        CursorBinding {
            operation: "builds.files".into(),
            filters: Some(BTreeMap::from([
                ("id".into(), json!(id)),
                ("sort".into(), json!(sort)),
                ("dir".into(), json!(dir)),
                ("q".into(), Value::Null),
                ("extensions".into(), Value::Null),
            ])),
            ordering: format!("{sort}:{dir},fileName:{dir}"),
            country: "".into(),
            locale: "".into(),
            limit,
        }
    }

    #[tokio::test]
    async fn files_cursor_applies_keyset_filter_and_rejects_filter_mismatch() {
        let filters = Arc::new(Mutex::new(Vec::new()));
        let mut state = test_app_state(ApiConfig::default());
        state.mongo = Arc::new(CursorMongo {
            build: cursor_build_document(),
            file_filters: filters.clone(),
            stream_batches: Arc::new(Mutex::new(std::collections::VecDeque::new())),
            stream_calls: Arc::new(Mutex::new(Vec::new())),
            stream_error: false,
            item_rows: Vec::new(),
            item_filters: Arc::new(Mutex::new(Vec::new())),
            aggregate_rows: Vec::new(),
            pipelines: Arc::new(Mutex::new(Vec::new())),
        });
        let app = crate::router(&state).with_state(state.clone());
        let id = "507f1f77bcf86cd799439011";
        let token = encode_cursor_with(
            &files_binding(id, "depth", "asc", 5),
            &[
                CursorSortValue::from(3_i64),
                CursorSortValue::from("folder/file.pak"),
            ],
            state.config.v1_cursor_secret.as_deref(),
            cursor_time(),
        )
        .unwrap();
        let continued = app
            .clone()
            .oneshot(get(&format!(
                "/v1/builds/{id}/files?limit=5&cursor={token}"
            )))
            .await
            .unwrap();
        assert_eq!(continued.status(), StatusCode::OK);
        assert!(json(continued).await["data"].is_array());
        {
            let recorded = filters.lock().unwrap();
            assert_eq!(recorded.len(), 1);
            assert!(
                recorded[0].contains_key("$and"),
                "cursor condition must be combined with the manifest filter"
            );
        }
        let mismatch = app
            .oneshot(get(&format!(
                "/v1/builds/{id}/files?limit=5&dir=desc&cursor={token}"
            )))
            .await
            .unwrap();
        assert_eq!(mismatch.status(), StatusCode::BAD_REQUEST);
        assert_eq!(json(mismatch).await["code"], "CURSOR_MISMATCH");
        assert_eq!(
            filters.lock().unwrap().len(),
            1,
            "invalid cursor must fail before the file query"
        );
    }

    #[tokio::test]
    async fn history_cursor_is_bound_to_build_and_scope() {
        let filters = Arc::new(Mutex::new(Vec::new()));
        let mut state = test_app_state(ApiConfig::default());
        state.mongo = Arc::new(CursorMongo {
            build: cursor_build_document(),
            file_filters: filters.clone(),
            stream_batches: Arc::new(Mutex::new(std::collections::VecDeque::new())),
            stream_calls: Arc::new(Mutex::new(Vec::new())),
            stream_error: false,
            item_rows: Vec::new(),
            item_filters: Arc::new(Mutex::new(Vec::new())),
            aggregate_rows: Vec::new(),
            pipelines: Arc::new(Mutex::new(Vec::new())),
        });
        let app = crate::router(&state).with_state(state.clone());
        let id = "507f1f77bcf86cd799439011";
        let binding = history_cursor_binding(id, "stream", 4);
        let token = encode_cursor_with(
            &binding,
            &[
                CursorSortValue::Null,
                CursorSortValue::from("2025-01-01T00:00:00.000Z"),
                CursorSortValue::from(id),
            ],
            state.config.v1_cursor_secret.as_deref(),
            cursor_time(),
        )
        .unwrap();
        let continued = app
            .clone()
            .oneshot(get(&format!(
                "/v1/builds/{id}/history?limit=4&cursor={token}"
            )))
            .await
            .unwrap();
        assert_eq!(continued.status(), StatusCode::OK);
        assert!(json(continued).await["data"].is_array());
        let mismatch = app
            .oneshot(get(&format!(
                "/v1/builds/{id}/history?limit=4&scope=platform&cursor={token}"
            )))
            .await
            .unwrap();
        assert_eq!(mismatch.status(), StatusCode::BAD_REQUEST);
        assert_eq!(json(mismatch).await["code"], "CURSOR_MISMATCH");
    }

    #[tokio::test]
    async fn tree_returns_nonempty_nodes_and_applies_signed_cursor_after_grouping() {
        let id = "507f1f77bcf86cd799439011";
        let pipelines = Arc::new(Mutex::new(Vec::new()));
        let mut state = test_app_state(ApiConfig::default());
        state.mongo = Arc::new(CursorMongo {
            build: cursor_build_document(),
            file_filters: Arc::new(Mutex::new(Vec::new())),
            stream_batches: Arc::new(Mutex::new(std::collections::VecDeque::new())),
            stream_calls: Arc::new(Mutex::new(Vec::new())),
            stream_error: false,
            item_rows: Vec::new(),
            item_filters: Arc::new(Mutex::new(Vec::new())),
            aggregate_rows: vec![
                doc! {"type": "directory", "name": "Engine", "fileCount": 3_i32, "totalSize": 100_i64},
                doc! {"type": "file", "name": "Readme.txt", "file": {"fileName": "Readme.txt", "fileSize": 4_i64}},
            ],
            pipelines: pipelines.clone(),
        });
        let app = crate::router(&state).with_state(state.clone());
        let first = app
            .clone()
            .oneshot(get(&format!("/v1/builds/{id}/tree?limit=1")))
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        let first: Value = json(first).await;
        assert_eq!(first["data"][0]["type"], "directory");
        assert_eq!(first["data"][0]["name"], "Engine");
        assert_eq!(first["data"][0]["path"], "Engine");
        assert_eq!(first["data"][0]["fileCount"], 3);
        assert_eq!(first["meta"]["pagination"]["hasMore"], true);
        let cursor = first["meta"]["pagination"]["nextCursor"].as_str().unwrap();
        let second = app
            .clone()
            .oneshot(get(&format!(
                "/v1/builds/{id}/tree?limit=1&cursor={cursor}"
            )))
            .await
            .unwrap();
        assert_eq!(second.status(), StatusCode::OK);
        {
            let pipeline_rows = pipelines.lock().unwrap();
            let page_pipelines: Vec<_> = pipeline_rows
                .iter()
                .filter(|pipeline| {
                    pipeline
                        .last()
                        .is_none_or(|stage| stage.get_str("$count") != Ok("total"))
                })
                .collect();
            assert_eq!(page_pipelines.len(), 2);
            assert!(
                page_pipelines[1][4].contains_key("$match"),
                "keyset match must run after grouping"
            );
            assert!(
                page_pipelines[1]
                    .iter()
                    .any(|stage| stage.contains_key("$project")),
                "tree file fields are explicitly projected"
            );
        }
        let mismatch = app
            .oneshot(get(&format!(
                "/v1/builds/{id}/tree?limit=1&path=Subdir&cursor={cursor}"
            )))
            .await
            .unwrap();
        assert_eq!(mismatch.status(), StatusCode::BAD_REQUEST);
        assert_eq!(json(mismatch).await["code"], "CURSOR_MISMATCH");
    }

    #[tokio::test]
    async fn items_returns_next_cursor_and_continues_with_id_keyset() {
        let id = "507f1f77bcf86cd799439011";
        let item_filters = Arc::new(Mutex::new(Vec::new()));
        let mut state = test_app_state(ApiConfig::default());
        state.mongo = Arc::new(CursorMongo {
            build: cursor_build_document(),
            file_filters: Arc::new(Mutex::new(Vec::new())),
            stream_batches: Arc::new(Mutex::new(std::collections::VecDeque::new())),
            stream_calls: Arc::new(Mutex::new(Vec::new())),
            stream_error: false,
            item_rows: vec![
                doc! {"id": "a", "title": "A"},
                doc! {"id": "b", "title": "B"},
            ],
            item_filters: item_filters.clone(),
            aggregate_rows: Vec::new(),
            pipelines: Arc::new(Mutex::new(Vec::new())),
        });
        let app = crate::router(&state).with_state(state);
        let first = app
            .clone()
            .oneshot(get(&format!("/v1/builds/{id}/items?limit=1")))
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        let first: Value = json(first).await;
        assert_eq!(first["data"][0]["id"], "a");
        let cursor = first["meta"]["pagination"]["nextCursor"].as_str().unwrap();
        let second = app
            .clone()
            .oneshot(get(&format!(
                "/v1/builds/{id}/items?limit=1&cursor={cursor}"
            )))
            .await
            .unwrap();
        assert_eq!(second.status(), StatusCode::OK);
        {
            let filters = item_filters.lock().unwrap();
            assert_eq!(filters.len(), 2);
            assert!(
                filters[1].contains_key("$and"),
                "continuation adds the ID keyset filter"
            );
            assert_eq!(
                filters[1].get_array("$and").unwrap()[1]
                    .as_document()
                    .unwrap()
                    .get_document("id")
                    .unwrap()
                    .get_str("$gt"),
                Ok("a")
            );
        }
    }

    #[tokio::test]
    async fn install_options_preserves_aggregate_shape_and_limit() {
        let id = "507f1f77bcf86cd799439011";
        let pipelines = Arc::new(Mutex::new(Vec::new()));
        let mut state = test_app_state(ApiConfig::default());
        state.mongo = Arc::new(CursorMongo {
            build: cursor_build_document(),
            file_filters: Arc::new(Mutex::new(Vec::new())),
            stream_batches: Arc::new(Mutex::new(std::collections::VecDeque::new())),
            stream_calls: Arc::new(Mutex::new(Vec::new())),
            stream_error: false,
            item_rows: Vec::new(),
            item_filters: Arc::new(Mutex::new(Vec::new())),
            aggregate_rows: vec![doc! {"_id": "base", "files": 3_i64, "size": 1024_i64}],
            pipelines: pipelines.clone(),
        });
        let response = crate::router(&state)
            .with_state(state)
            .oneshot(get(&format!("/v1/builds/{id}/install-options")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json(response).await;
        assert_eq!(body["data"]["base"], json!({"files": 3, "size": 1024}));
        assert_eq!(body["meta"]["count"], 1);
        assert_eq!(body["meta"]["truncated"], false);
        {
            let pipelines = pipelines.lock().unwrap();
            assert_eq!(pipelines[0].last().unwrap().get_i32("$limit"), Ok(200));
            assert_eq!(pipelines[0][1].get_str("$unwind"), Ok("$installTags"));
        }
    }

    #[tokio::test]
    async fn item_pagination_fails_when_cursor_secret_is_not_configured() {
        let id = "507f1f77bcf86cd799439011";
        let mut state = test_app_state(ApiConfig {
            v1_cursor_secret: None,
            ..ApiConfig::default()
        });
        state.mongo = Arc::new(CursorMongo {
            build: cursor_build_document(),
            file_filters: Arc::new(Mutex::new(Vec::new())),
            stream_batches: Arc::new(Mutex::new(std::collections::VecDeque::new())),
            stream_calls: Arc::new(Mutex::new(Vec::new())),
            stream_error: false,
            item_rows: vec![doc! {"id": "a"}, doc! {"id": "b"}],
            item_filters: Arc::new(Mutex::new(Vec::new())),
            aggregate_rows: Vec::new(),
            pipelines: Arc::new(Mutex::new(Vec::new())),
        });
        let response = crate::router(&state)
            .with_state(state)
            .oneshot(get(&format!("/v1/builds/{id}/items?limit=1")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(json(response).await["code"], "CURSOR_NOT_CONFIGURED");
    }

    #[test]
    fn build_summary_timestamps_use_node_millisecond_format() {
        let mut build = cursor_build_document();
        let date = bson::DateTime::parse_rfc3339_str("2025-01-02T03:04:05.000Z").unwrap();
        for field in [
            "createdAt",
            "updatedAt",
            "firstSeenAt",
            "lastSeenAt",
            "manifestProcessedAt",
        ] {
            build.insert(field, date);
        }
        let summary = stored_build_summary(&bson_doc_to_js_json(&build), None).unwrap();
        assert_eq!(summary["firstSeenAt"], "2025-01-02T03:04:05.000Z");
        assert_eq!(summary["lastSeenAt"], "2025-01-02T03:04:05.000Z");
        assert_eq!(summary["createdAt"], "2025-01-02T03:04:05.000Z");
        assert_eq!(summary["updatedAt"], "2025-01-02T03:04:05.000Z");
        assert_eq!(
            summary["manifest"]["processedAt"],
            "2025-01-02T03:04:05.000Z"
        );
    }

    #[tokio::test]
    async fn streamed_compare_keeps_global_summary_and_applies_signed_path_continuation() {
        let snap = |name: &str, hash: &str, size: i64| BuildFileSnapshot {
            file_name: name.into(),
            file_hash: hash.into(),
            file_size: size,
            mime_type: Some("application/octet-stream".into()),
            install_tags: Some(vec!["base".into()]),
            symlink_target: None,
            file_meta_flags: None,
        };
        let docs = |rows: Vec<BuildFileSnapshot>| {
            rows.into_iter()
                .map(|row| Ok(bson::to_document(&row).unwrap()))
                .collect::<Vec<Result<Document, egdata_core::error::CoreError>>>()
        };
        let statuses = [
            BuildFileChangeStatus::Added,
            BuildFileChangeStatus::Removed,
            BuildFileChangeStatus::Modified,
            BuildFileChangeStatus::Unchanged,
        ]
        .into_iter()
        .collect();
        let comparison = compare_snapshot_streams(
            stream::iter(docs(vec![
                snap("a.bin", "old", 4),
                snap("b.bin", "same", 5),
            ])),
            stream::iter(docs(vec![
                snap("b.bin", "same", 5),
                snap("c.bin", "new", 7),
            ])),
            CompareStreamFilters {
                offset: 0,
                statuses: &statuses,
                query: None,
                extensions: &None,
                direction: BuildComparisonDirection::Asc,
                after_path: Some("a.bin"),
                limit: 1,
            },
        )
        .await
        .unwrap();
        assert_eq!(comparison.counts.total, 3);
        assert_eq!(comparison.counts.removed, 1);
        assert_eq!(comparison.counts.added, 1);
        assert_eq!(comparison.bytes.base.number(), 9.);
        assert_eq!(comparison.bytes.target.number(), 12.);
        assert_eq!(comparison.changes.len(), 1);
        assert_eq!(comparison.changes[0].path, "b.bin");
        assert!(comparison.has_more);
        assert_eq!(comparison.install_tags["added"], json!([]));
    }

    #[tokio::test]
    async fn streamed_compare_matches_node_generated_helper_fixture() {
        let fixture: Value =
            serde_json::from_str(include_str!("fixtures/build-comparison-node.json")).unwrap();
        let snapshots = |key: &str| {
            fixture["inputs"][key]
                .as_array()
                .unwrap()
                .iter()
                .cloned()
                .map(serde_json::from_value::<BuildFileSnapshot>)
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        let docs = |rows: Vec<BuildFileSnapshot>| {
            rows.into_iter()
                .map(|row| Ok(bson::to_document(&row).unwrap()))
                .collect::<Vec<Result<Document, egdata_core::error::CoreError>>>()
        };
        let filters = &fixture["filters"];
        let statuses = serde_json::from_value(filters["statuses"].clone()).unwrap();
        let direction = serde_json::from_value(filters["direction"].clone()).unwrap();
        let comparison = compare_snapshot_streams(
            stream::iter(docs(snapshots("base"))),
            stream::iter(docs(snapshots("target"))),
            CompareStreamFilters {
                offset: 0,
                statuses: &statuses,
                query: filters["query"].as_str(),
                extensions: &None,
                direction,
                after_path: filters["afterPath"].as_str(),
                limit: filters["limit"].as_u64().unwrap() as usize,
            },
        )
        .await
        .unwrap();
        let actual = json!({
            "changes": comparison.changes,
            "hasMore": comparison.has_more,
            "files": comparison.counts,
            "fileBytes": comparison.bytes,
            "installTags": comparison.install_tags,
            "topFiles": comparison.top_files,
            "topDirectories": comparison.top_directories,
        });
        assert_eq!(actual, fixture["expected"]);
    }
}

#[cfg(test)]
mod reads_node_oracle_tests {
    use super::*;
    use crate::{test_support::test_app_state, state::ApiConfig};
    use async_trait::async_trait;
    use axum::body::Body;
    use egdata_core::{error::CoreError, ports::MongoStorePort};
    use std::sync::Arc;
    use tower::ServiceExt;

    fn fixed_now() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339("2026-11-17T00:00:00.000Z")
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    fn build_document(value: &Value) -> Document {
        let mut document = bson::to_document(value).unwrap();
        for key in ["_id", "previousObservedBuildId"] {
            if let Ok(text) = document.get_str(key)
                && let Ok(id) = ObjectId::parse_str(text)
            {
                document.insert(key, id);
            }
        }
        for field in [
            "firstSeenAt",
            "lastSeenAt",
            "createdAt",
            "updatedAt",
            "manifestProcessedAt",
        ] {
            if let Some(Bson::String(raw)) = document.get(field)
                && let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(raw)
            {
                document.insert(
                    field,
                    Bson::DateTime(bson::DateTime::from_chrono(
                        parsed.with_timezone(&chrono::Utc),
                    )),
                );
            }
        }
        document
    }

    #[derive(Default)]
    struct ReadStore {
        build: Option<Document>,
        total: Option<u64>,
        filters: Arc<std::sync::Mutex<Vec<Value>>>,
        base_snapshot: Option<Document>,
        base_files: Vec<Document>,
        asset: Option<Document>,
        history: Vec<Document>,
        list_rows: Vec<Document>,
        null_rows: Vec<Document>,
        files: Vec<Document>,
        items: Vec<Document>,
        item_rows: Vec<Document>,
        assets: Vec<Document>,
        launcher_offers: Vec<Document>,
        tree: Vec<Document>,
        install_options: Vec<Document>,
        fail_collection: Option<String>,
        fail_stage: Option<String>,
        observed: Option<Document>,
        earlier: Option<Document>,
    }

    #[async_trait]
    impl MongoStorePort for ReadStore {
        async fn find_one(
            &self,
            collection: &str,
            filter: Document,
            _: Option<Document>,
        ) -> Result<Option<Document>, CoreError> {
            if self.fail_collection.as_deref() == Some(collection) {
                return Err(CoreError::Internal("fixture database failure".into()));
            }
            if self.fail_stage.as_deref() == Some("observed")
                && filter.contains_key("manifestStatus")
            {
                return Err(CoreError::Internal("fixture observed lookup failed".into()));
            }
            Ok(match collection {
                "builds" if filter.contains_key("manifestStatus") => self.observed.clone(),
                "builds"
                    if self
                        .base_snapshot
                        .as_ref()
                        .is_some_and(|base| base.get("_id") == filter.get("_id")) =>
                {
                    self.base_snapshot.clone()
                }
                "builds" => self.build.clone(),
                "assets" => self.asset.clone(),
                _ => None,
            })
        }
        async fn find_many(
            &self,
            collection: &str,
            filter: Document,
            _: MongoFindOptions,
        ) -> Result<Vec<Document>, CoreError> {
            if matches!(collection, "files" | "items") {
                self.filters
                    .lock()
                    .unwrap()
                    .push(bson_doc_to_js_json(&filter));
            }
            if self.fail_collection.as_deref() == Some(collection) {
                return Err(CoreError::Internal("fixture database failure".into()));
            }
            if self.fail_stage.as_deref() == Some("null-phase")
                && filter.get("createdAt") == Some(&Bson::Null)
            {
                return Err(CoreError::Internal("fixture null group failure".into()));
            }
            let history_filter = filter.contains_key("appName")
                || filter.get_array("$and").is_ok_and(|clauses| {
                    clauses.iter().any(|clause| {
                        clause
                            .as_document()
                            .is_some_and(|document| document.contains_key("appName"))
                    })
                });
            if (self.fail_stage.as_deref() == Some("previous") && filter.contains_key("manifestId"))
                || (self.fail_stage.as_deref() == Some("history-page") && history_filter)
            {
                return Err(CoreError::Internal("fixture history lookup failed".into()));
            }
            match collection {
                "builds" if filter.contains_key("manifestId") => {
                    Ok(self.earlier.iter().cloned().collect())
                }
                "builds"
                    if history_filter
                        && !filter.contains_key("_id")
                        && !filter.contains_key("manifestId") =>
                {
                    Ok(self.history.clone())
                }
                "builds"
                    if filter
                        .get_document("createdAt")
                        .is_ok_and(|value| value.get("$ne") == Some(&Bson::Null)) =>
                {
                    Ok(self.list_rows.clone())
                }
                "builds" if filter.get("createdAt") == Some(&Bson::Null) => {
                    Ok(self.null_rows.clone())
                }
                "builds" => Ok(self.list_rows.clone()),
                "files" => Ok(self.files.clone()),
                "items"
                    if filter.get("releaseInfo.appId") == Some(&Bson::String("TestApp".into())) =>
                {
                    Ok(self.item_rows.clone())
                }
                "items" => Ok(self.items.clone()),
                "assets" => Ok(self.assets.clone()),
                "offers" => Ok(self.launcher_offers.clone()),
                _ => Ok(vec![]),
            }
        }
        async fn find_stream(
            &self,
            collection: &str,
            filter: Document,
            _: MongoFindOptions,
        ) -> Result<egdata_core::ports::MongoDocumentStream, CoreError> {
            if self.fail_collection.as_deref() == Some(collection) {
                return Err(CoreError::Internal("fixture database failure".into()));
            }
            if self.fail_stage.as_deref() == Some("read-file-stream") {
                return Ok(Box::pin(futures::stream::iter([Err(CoreError::Internal(
                    "fixture stream interruption".into(),
                ))])));
            }
            assert_eq!(collection, "files");
            let base_id = self
                .base_snapshot
                .as_ref()
                .and_then(|build| build.get_str("manifestId").ok());
            let manifest_id = filter
                .get_document("manifestId")
                .ok()
                .and_then(|value| value.get_str("$eq").ok());
            let (side, rows) = if base_id.is_some() && base_id == manifest_id {
                ("base", &self.base_files)
            } else {
                ("target", &self.files)
            };
            if side == "target" && self.fail_stage.as_deref() == Some("target-open") {
                return Err(CoreError::Internal("fixture target stream failed".into()));
            }
            let mut records: Vec<_> = rows.iter().cloned().map(Ok).collect();
            if let Some(offset) = self
                .fail_stage
                .as_deref()
                .and_then(|stage| stage.strip_prefix(&format!("{side}-next-")))
                .and_then(|n| n.parse::<usize>().ok())
            {
                records.truncate(offset);
                records.push(Err(CoreError::Internal(
                    "fixture interrupted cursor".into(),
                )));
            }
            Ok(Box::pin(futures::stream::iter(records)))
        }
        async fn aggregate(
            &self,
            collection: &str,
            pipeline: Vec<Document>,
        ) -> Result<Vec<Document>, CoreError> {
            if pipeline
                .last()
                .is_some_and(|stage| stage.get_str("$count") == Ok("total"))
            {
                self.filters.lock().unwrap().push(json!(
                    pipeline.iter().map(bson_doc_to_js_json).collect::<Vec<_>>()
                ));
                let total = self.total.unwrap_or(self.tree.len() as u64);
                return Ok(vec![doc! {"total":total as i64}]);
            }
            if self.fail_collection.as_deref() == Some(collection) {
                return Err(CoreError::Internal(
                    "private snapshot database failure".into(),
                ));
            }
            if collection != "files" {
                return Ok(vec![]);
            }
            if let Some(filter) = pipeline
                .first()
                .and_then(|stage| stage.get_document("$match").ok())
            {
                self.filters
                    .lock()
                    .unwrap()
                    .push(bson_doc_to_js_json(filter));
            }
            let install_query = pipeline
                .first()
                .and_then(|stage| stage.get_document("$match").ok())
                .is_some_and(|filter| {
                    filter.contains_key("installTags")
                        || filter.get_array("$and").is_ok_and(|clauses| {
                            clauses.iter().any(|clause| {
                                clause
                                    .as_document()
                                    .is_some_and(|document| document.contains_key("installTags"))
                            })
                        })
                });
            Ok(if install_query {
                self.install_options.clone()
            } else {
                self.tree.clone()
            })
        }
        async fn count_documents(&self, name: &str, filter: Document) -> Result<u64, CoreError> {
            self.filters
                .lock()
                .unwrap()
                .push(bson_doc_to_js_json(&filter));
            if self.fail_stage.as_deref() == Some("count") {
                return Err(CoreError::Internal("fixture count".into()));
            }
            let count = match name {
                "files" => self.files.len(),
                "items" => self.item_rows.len(),
                _ if filter.contains_key("appName") => self.history.len(),
                _ => self.list_rows.len() + self.null_rows.len(),
            };
            Ok(self.total.unwrap_or(count as u64))
        }
        async fn distinct(&self, _: &str, _: &str, _: Document) -> Result<Vec<Bson>, CoreError> {
            Ok(vec![])
        }
        async fn insert_one(&self, _: &str, _: Document) -> Result<(), CoreError> {
            Ok(())
        }
        async fn update_one(
            &self,
            _: &str,
            _: Document,
            _: Document,
            _: bool,
        ) -> Result<u64, CoreError> {
            Ok(0)
        }
        async fn delete_one(&self, _: &str, _: Document) -> Result<u64, CoreError> {
            Ok(0)
        }
        async fn ping(&self) -> Result<bool, CoreError> {
            Ok(true)
        }
    }

    #[tokio::test]
    async fn build_history_files_and_tree_match_node_oracle_and_accept_node_cursors() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../egdata-api/tests/fixtures/build-reads-http-node.json"
        ))
        .unwrap();
        for case in cases {
            let input = &case["input"];
            let build = input
                .get("build")
                .filter(|value| value.is_object())
                .map(build_document);
            let asset = input
                .get("asset")
                .filter(|value| value.is_object())
                .map(|value| bson::to_document(value).unwrap());
            let history = input["historyRows"]
                .as_array()
                .into_iter()
                .flatten()
                .map(build_document)
                .collect();
            let list_rows = input["listRows"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|value| {
                    let mut row = build_document(value);
                    if case["name"] == "build-list-linked-item" {
                        row.insert("manifestFileBytes", Bson::Double(4_294_967_297.0));
                    }
                    row
                })
                .collect();
            let null_rows = input["nullRows"]
                .as_array()
                .into_iter()
                .flatten()
                .map(build_document)
                .collect();
            let file_document = |value: &Value| {
                Bson::try_from(value.clone())
                    .unwrap()
                    .as_document()
                    .unwrap()
                    .clone()
            };
            let files = input["fileRows"]
                .as_array()
                .into_iter()
                .flatten()
                .map(file_document)
                .collect();
            let items = input["items"]
                .as_array()
                .into_iter()
                .flatten()
                .map(bson::to_document)
                .collect::<Result<_, _>>()
                .unwrap();
            let item_rows = input["itemRows"]
                .as_array()
                .into_iter()
                .flatten()
                .map(bson::to_document)
                .collect::<Result<_, _>>()
                .unwrap();
            let assets = input["assets"]
                .as_array()
                .into_iter()
                .flatten()
                .map(bson::to_document)
                .collect::<Result<_, _>>()
                .unwrap();
            let launcher_offers = input["launcherOffers"]
                .as_array()
                .into_iter()
                .flatten()
                .map(bson::to_document)
                .collect::<Result<_, _>>()
                .unwrap();
            let tree = input["treeRows"]
                .as_array()
                .into_iter()
                .flatten()
                .map(bson::to_document)
                .collect::<Result<_, _>>()
                .unwrap();
            let install_options = input["installOptionRows"]
                .as_array()
                .into_iter()
                .flatten()
                .map(bson::to_document)
                .collect::<Result<_, _>>()
                .unwrap();
            let filters = Arc::new(std::sync::Mutex::new(Vec::new()));
            let store = ReadStore {
                total: input["total"].as_u64(),
                filters: filters.clone(),
                build,
                base_snapshot: input.get("baseSnapshot").map(build_document),
                base_files: input["baseFiles"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(file_document)
                    .collect(),
                asset,
                history,
                list_rows,
                null_rows,
                files,
                items,
                item_rows,
                assets,
                launcher_offers,
                tree,
                install_options,
                fail_collection: input["errorCollection"].as_str().map(str::to_owned),
                fail_stage: input["failStage"].as_str().map(str::to_owned),
                earlier: input.get("earlier").map(build_document),
                observed: input.get("observed").map(build_document),
            };
            let cache = Arc::new(super::tests::RecordingCache::default());
            if let Some(seeded) = input.get("cached") {
                *cache.values.lock().unwrap() = serde_json::from_value(seeded.clone()).unwrap();
            }
            let mut state = test_app_state(ApiConfig {
                v1_cursor_secret: (input["noCursorSecret"] != true)
                    .then(|| "test-cursor-secret-that-is-at-least-32-chars".into()),
                ..ApiConfig::default()
            });
            state.now = fixed_now;
            state.mongo = Arc::new(store);
            state.cache = cache.clone();
            let app = crate::router(&state).with_state(state);
            let path = case["request"]["path"].as_str().unwrap();
            let mut request_builder = axum::http::Request::builder()
                .method(case["request"]["method"].as_str().unwrap_or("GET"))
                .uri(path)
                .header("x-request-id", "req_node_oracle")
                .header("x-egdata-key-id", "key_oracle")
                .header("x-egdata-key-tier", "free");
            let request_body = if case["request"]["body"].is_object() {
                request_builder = request_builder.header("content-type", "application/json");
                Body::from(case["request"]["body"].to_string())
            } else {
                Body::empty()
            };
            let request = request_builder.body(request_body).unwrap();
            let response = app.oneshot(request).await.unwrap();
            let actual = egdata_api_test_support::capture_response(response).await;
            assert_eq!(actual, case["response"], "{}", case["name"]);
            if let Some(expected) = case.get("filters") {
                assert_eq!(
                    &json!(*filters.lock().unwrap()),
                    expected,
                    "{} Mongo queries",
                    case["name"]
                );
            }
            let writes = cache
                .sets
                .lock()
                .unwrap()
                .iter()
                .map(|(key, _, ttl)| json!({"key":key,"ttl":ttl}))
                .collect::<Vec<_>>();
            assert_eq!(
                json!(writes),
                case["cacheWrites"],
                "{} cache writes",
                case["name"]
            );
        }
    }
}
