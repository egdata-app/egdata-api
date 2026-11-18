use super::{
    Routes, internal_error, json_response,
    system::{cache_control, missing_country, selected_region},
};
use crate::{
    state::AppState,
    v1::system::{date_stats_pipeline, homepage_counts, stats_counts},
};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode, Uri},
    response::Response,
};
use egdata_core::v1::serialization::node_json;
use egdata_infra::bson_json::bson_doc_to_js_json;
use serde_json::Value;

pub(super) fn routes() -> Routes {
    Routes::new("/stats")
        .get("", counts)
        .get("/homepage", homepage)
        .get("/releases/monthly", chart)
        .get("/releases/yearly", chart)
        .get("/creations/monthly", chart)
        .get("/creations/yearly", chart)
}

// Node's response cache treats a miss as an empty string or absent key. A
// malformed stored value reaches the normal Hono error handler.
async fn read(state: &AppState, key: &str) -> Result<Option<Response>, ()> {
    let Some(raw) = state
        .cache
        .get(key)
        .await
        .map_err(|_| ())?
        .filter(|s| !s.is_empty())
    else {
        return Ok(None);
    };
    let value = serde_json::from_str(&raw).map_err(|_| ())?;
    Ok(Some(cache_control(
        json_response(StatusCode::OK, &value),
        "public, max-age=3600",
    )))
}
async fn store(state: &AppState, key: &str, ttl: u64, value: &Value) -> Response {
    if state.cache.set(key, &node_json(value), ttl).await.is_err() {
        return internal_error();
    }
    json_response(StatusCode::OK, value)
}
async fn counts(State(state): State<AppState>) -> Response {
    let key = "stats:v0.3";
    match read(&state, key).await {
        Ok(Some(hit)) => return hit,
        Err(()) => return internal_error(),
        Ok(None) => (),
    }
    let counts = stats_counts(&state, true).await;
    let response = store(&state, key, 3600, &counts).await;
    if response.status().is_success() {
        cache_control(response, "public, max-age=60")
    } else {
        response
    }
}
async fn homepage(State(state): State<AppState>, uri: Uri, headers: HeaderMap) -> Response {
    let Some((region, _)) = selected_region(&uri, &headers) else {
        return missing_country();
    };
    let key = format!("stats:homepage:{region}");
    match read(&state, &key).await {
        Ok(Some(hit)) => return hit,
        Err(()) => return internal_error(),
        Ok(None) => (),
    }
    store(&state, &key, 86400, &homepage_counts(&state, region).await).await
}
async fn chart(State(state): State<AppState>, uri: Uri) -> Response {
    let path = uri.path().trim_start_matches("/stats/");
    let (count, period) = path.split_once('/').expect("registered chart path");
    let key = format!("stats:{count}:{period}");
    match read(&state, &key).await {
        Ok(Some(hit)) => return hit,
        Err(()) => return internal_error(),
        Ok(None) => (),
    }
    let field = if count == "releases" {
        "releaseDate"
    } else {
        "creationDate"
    };
    let pipeline = date_stats_pipeline(field, count, period == "monthly", (state.now)());
    let Ok(rows) = state.mongo.aggregate("offers", pipeline).await else {
        return internal_error();
    };
    store(
        &state,
        &key,
        86400,
        &Value::Array(rows.iter().map(bson_doc_to_js_json).collect()),
    )
    .await
}
