//! Legacy profile queries and achievement refresh requests.
mod identity;
mod pipelines;
mod progress;
#[cfg(test)]
#[tokio::test]
async fn legacy_profiles_http_node_oracle() {
    egdata_api_oracle::replay_legacy_oracle(include_str!(
        "../../egdata-api/tests/fixtures/legacy-profiles-http-node.json"
    ))
    .await;
}
use super::common::spread;
use super::{
    Routes,
    common::{self, Error, ONE_MINUTE as PUBLIC, Result, cached, one, store as save},
};
use crate::state::AppState;
use egdata_http_core::shared::profiles::number;
use egdata_http_core::shared::system::js_truthy as truthy;
use axum::{
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, Uri, header},
    response::Response,
};
use bson::{Bson, Document, doc};
use egdata_core::ports::MongoFindOptions;
use egdata_core::v1::{query::format_js_number, serialization::js_string};
use egdata_infra::bson_json::bson_doc_to_js_json;
use serde_json::{Value, json};

pub(super) fn routes() -> Routes {
    Routes::new("")
        .get("/profiles/sitemap.xml", sitemap)
        .get("/profiles/leaderboard", leaderboard)
        .get("/profiles/me", identity::me)
        .get("/profiles/{id}", identity::detail)
        .get("/profiles/{id}/information", identity::information)
        .get("/profiles/{id}/achievements", progress::achievements)
        .get(
            "/profiles/{id}/achievements/{sandboxId}",
            progress::sandbox_achievements,
        )
        .get("/profiles/{id}/rare-achievements", progress::rare)
        .get(
            "/profiles/{id}/rare-achievements/{sandboxId}",
            progress::rare_sandbox,
        )
        .get("/profiles/{id}/games", progress::games)
        .get("/profiles/{id}/random-game", progress::random_game)
        .put("/profiles/{id}/refresh", refresh)
        .get("/profiles/{id}/refresh-status", refresh_status)
}

fn message(status: StatusCode, message: &str) -> Error {
    Error::Json(status, json!({"message":message}))
}
fn ok(value: &Value, cache: Option<&'static str>) -> Response {
    let response = common::ok(value);
    match cache {
        Some(policy) => common::cache_header(response, policy),
        None => response,
    }
}
fn values(rows: Vec<Document>) -> Vec<Value> {
    rows.iter().map(bson_doc_to_js_json).collect()
}
async fn many(s: &AppState, collection: &str, filter: Document) -> Result<Vec<Value>> {
    common::many(s, collection, filter, MongoFindOptions::default()).await
}
async fn aggregate(
    s: &AppState,
    stages: Vec<Value>,
    disk: Option<bool>,
    collation: Option<Document>,
) -> Result<Vec<Document>> {
    let pipeline = stages
        .iter()
        .map(|stage| bson::to_document(stage).expect("Mongo pipeline stage is an object"))
        .collect();
    Ok(s.mongo
        .aggregate_with_options(
            "player-achievements",
            pipeline,
            egdata_core::ports::MongoAggregateOptions {
                allow_disk_use: disk,
                collation,
                ..Default::default()
            },
        )
        .await?)
}
fn query(uri: &Uri, key: &str) -> Option<String> {
    url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
}
async fn sitemap(State(s): State<AppState>) -> Result<Response> {
    let rows = many(&s, "epic", doc! {}).await?;
    let elements = rows
        .iter()
        .map(|row| {
            format!(
                "<url>\n          <loc>https://egdata.app/profile/{}</loc>\n        </url>",
                row.get("accountId")
                    .map(js_string)
                    .unwrap_or_else(|| "undefined".into())
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let xml = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n  {elements}\n</urlset>"
    );
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, "text/plain; charset=UTF-8")
        .body(Body::from(xml))
        .unwrap())
}
async fn leaderboard(State(s): State<AppState>) -> Result<Response> {
    let mut stages = egdata_http_core::shared::profiles::leaderboard_stages();
    stages.extend([
        json!({"$sort":{"xpEarned":-1,"accountId":1}}),
        json!({"$limit":10}),
    ]);
    Ok(ok(
        &json!(values(aggregate(&s, stages, None, None).await?)),
        None,
    ))
}
fn cooldown_ms(donor: bool) -> i64 {
    if donor { 120_000 } else { 900_000 }
}
async fn refresh(State(s): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let donor = one(&s, "key-codes", doc! {"accountId":&id})
        .await?
        .is_some();
    s.profile_refresh.request(&id, cooldown_ms(donor)).await?;
    Ok(common::ok(
        &json!({"message":"Refresh achievements job added"}),
    ))
}
async fn refresh_status(State(s): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let donor = one(&s, "key-codes", doc! {"accountId":{"$eq":&id}})
        .await?
        .is_some();
    let ttl = cooldown_ms(donor) as f64;
    let raw = s.profile_refresh.status(&id).await?;
    let mut remaining = 0.;
    if let Some(raw) = raw.filter(|text| !text.is_empty()) {
        let job: Value = serde_json::from_str(&raw)?;
        if job.is_null() {
            return Err(Error::Internal);
        }
        let timestamp = job.get("timestamp").map(number);
        if let Some(timestamp) = timestamp {
            remaining = ((ttl - ((s.now)().timestamp_millis() as f64 - timestamp)) / 1000.)
                .ceil()
                .max(0.);
        }
    }
    Ok(ok(
        &json!({"canRefresh":remaining<=0.,"remainingTime":remaining}),
        None,
    ))
}
