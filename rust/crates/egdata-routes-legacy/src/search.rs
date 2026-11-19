//! Unversioned search metadata, saved queries and retired search entrypoints.
mod extra;
mod input;
mod v2;
use super::{Routes, common::*, json_response, system::query};
use crate::state::AppState;
use axum::{
    extract::{Path, State},
    http::{StatusCode, Uri},
    response::Response,
};
use bson::{Bson, Regex, doc};
use egdata_infra::bson_json::bson_doc_to_js_json;
use serde_json::{Value, json};

pub(super) fn routes() -> Routes {
    Routes::new("/search")
        .get("", deprecated)
        .post("", deprecated)
        .get("/tags", tags)
        .get("/v2/search", v2::get)
        .post("/v2/search", v2::post)
        .get("/offer-types", facet)
        .get("/publishers", facet)
        .get("/developers", facet)
        .get("/{id}", saved)
        .merge(extra::routes())
}
async fn deprecated() -> Response {
    cache_header(
        json_response(
            StatusCode::GONE,
            &json!({"error":{"code":"DEPRECATED","message":"Use /search/v2/search instead."}}),
        ),
        "no-store",
    )
}
async fn tags(State(s): State<AppState>) -> Result<Response> {
    let rows = many(&s, "tags", doc! {"status":"ACTIVE"}, Default::default()).await?;
    Ok(cache_header(ok(&Value::Array(rows)), ONE_MINUTE))
}
async fn saved(State(s): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let raw = s
        .saved_queries
        .get(&id)
        .await?
        .filter(|v| !v.is_empty())
        .ok_or_else(|| not_found("Query not found"))?;
    Ok(ok(&serde_json::from_str(&raw)?))
}
async fn facet(State(s): State<AppState>, uri: Uri) -> Result<Response> {
    let field = match uri.path().rsplit('/').next() {
        Some("developers") => "developerDisplayName",
        Some("publishers") => "publisherDisplayName",
        _ => "offerType",
    };
    let mut pipeline = Vec::new();
    if field != "offerType"
        && let Some(q) = query(&uri, "query").filter(|q| !q.is_empty())
    {
        let re = Bson::RegularExpression(Regex {
            pattern: q,
            options: "i".into(),
        });
        pipeline.push(doc! {"$match":{field:{"$regex":re}}});
    }
    pipeline.push(doc! {"$group":{"_id":format!("${field}"),"count":{"$sum":1}}});
    if field != "offerType" {
        pipeline.push(doc! {"$sort":{"count":-1}})
    }
    let rows = s
        .mongo
        .aggregate("offers", pipeline)
        .await?
        .iter()
        .map(bson_doc_to_js_json)
        .filter(|row| {
            field != "offerType"
                || match &row["_id"] {
                    Value::Null | Value::Bool(false) => false,
                    Value::String(v) => !v.is_empty(),
                    Value::Number(n) => n.as_f64() != Some(0.),
                    _ => true,
                }
        })
        .collect();
    Ok(cache_header(ok(&Value::Array(rows)), ONE_MINUTE))
}
