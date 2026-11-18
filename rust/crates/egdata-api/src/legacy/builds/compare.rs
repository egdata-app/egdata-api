use super::*;
use crate::v1::builds::{
    CompareStreamFilters, read_comparison,
    stored::{comparison_payload, compatible},
};
use egdata_core::builds::{BuildComparisonDirection, BuildFileChangeStatus};
use std::collections::{BTreeSet, HashSet};

pub(super) async fn compare(
    State(state): State<AppState>,
    Path((target_id, base_id)): Path<(String, String)>,
    uri: Uri,
) -> HandlerResult {
    let (target_oid, base_oid) = (object_id(&target_id)?, object_id(&base_id)?);
    let q = Query::from_uri(&uri);
    let invalid = || BuildError::Invalid("Invalid comparison query");
    let p = q.page(50, "Invalid comparison query")?;
    let dir = q.get("dir").unwrap_or("asc");
    let direction = match dir {
        "asc" => BuildComparisonDirection::Asc,
        "desc" => BuildComparisonDirection::Desc,
        _ => return Err(invalid()),
    };
    let names = q
        .get("status")
        .unwrap_or("added,modified,removed")
        .split(',')
        .collect::<BTreeSet<_>>();
    let statuses = names
        .iter()
        .map(|name| match *name {
            "added" => Ok(BuildFileChangeStatus::Added),
            "removed" => Ok(BuildFileChangeStatus::Removed),
            "modified" => Ok(BuildFileChangeStatus::Modified),
            "unchanged" => Ok(BuildFileChangeStatus::Unchanged),
            _ => Err(invalid()),
        })
        .collect::<Result<HashSet<_>, _>>()?;
    let extensions = q
        .get("extension")
        .unwrap_or("")
        .split(',')
        .map(egdata_core::v1::trim_js_whitespace)
        .map(|ext| ext.strip_prefix('.').unwrap_or(ext).to_lowercase())
        .filter(|ext| !ext.is_empty())
        .collect::<BTreeSet<_>>();
    let query = egdata_core::v1::trim_js_whitespace(q.get("q").unwrap_or(""));
    if query.encode_utf16().count() > 200 || extensions.len() > 20 {
        return Err(invalid());
    }
    let search = query.to_lowercase();
    let (target, base) = tokio::join!(
        state
            .mongo
            .find_one("builds", doc! {"_id":target_oid}, None),
        state.mongo.find_one("builds", doc! {"_id":base_oid}, None)
    );
    let (target, base) = (target?, base?);
    let (Some(target), Some(base)) = (target, base) else {
        return Err(BuildError::Missing);
    };
    if !compatible(&base, &target)? {
        return Ok(json_response(
            StatusCode::BAD_REQUEST,
            &json!({"error":{"code":"INCOMPATIBLE_BUILDS","message":"Builds must use the same app and platform"}}),
        ));
    }
    if !stored_comparable(&target) || !stored_comparable(&base) {
        return Ok(json_response(
            StatusCode::CONFLICT,
            &json!({"error":{"code":"MANIFEST_NOT_COMPARABLE","message":"Both builds must have stored file snapshots before comparison","baseStatus":bson_to_js_json(&manifest_status(&base)),"targetStatus":bson_to_js_json(&manifest_status(&target))}}),
        ));
    }
    let hash = cache_hash(
        &json!({"page":p.page,"limit":p.limit,"direction":dir,"query":search,"statuses":names,"extensions":extensions}),
    );
    let updated = |b: &Document| match b.get("updatedAt") {
        None | Some(Bson::Null) => "0".into(),
        Some(Bson::DateTime(d)) => d.timestamp_millis().to_string(),
        Some(v) => egdata_core::v1::serialization::js_string(&bson_to_js_json(v)),
    };
    let key = format!(
        "build-compare:v2:{base_id}:{target_id}:{}:{}:{hash}",
        updated(&base),
        updated(&target)
    );
    if let Some(hit) = cache_read(&state, &key).await? {
        return Ok(ok(&hit));
    }
    let extensions = Some(extensions.into_iter().collect());
    let compared = read_comparison(
        &state,
        &base,
        &target,
        CompareStreamFilters {
            direction,
            statuses: &statuses,
            extensions: &extensions,
            query: Some(&search),
            after_path: None,
            limit: p.limit as usize,
            offset: p.offset as usize,
        },
    )
    .await
    .map_err(|_| BuildError::Database)?;
    let mut value = comparison_payload(&base, &target, &compared, |row| {
        summary(row, None).map_err(|_| crate::v1::system::internal_error())
    })?;
    value["page"] = json!(p.page);
    value["limit"] = json!(p.limit);
    value["total"] = json!(compared.filtered_count);
    cache_write(&state, &key, &value).await;
    Ok(ok(&value))
}
