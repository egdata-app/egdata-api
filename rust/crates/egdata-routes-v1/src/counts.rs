use super::{helpers::cached_total, system::internal_error};
use crate::state::AppState;
use bson::{Document, doc};
use egdata_core::v1::ProblemError;
use serde_json::{Value, json};

pub(super) async fn documents(
    state: &AppState,
    operation: &str,
    parts: &[(&str, Value)],
    ttl: u64,
    collection: &str,
    filter: Document,
) -> Result<Value, ProblemError> {
    cached_total(state, operation, parts, ttl, async {
        state
            .mongo
            .count_documents(collection, filter)
            .await
            .map(|count| json!(count))
            .map_err(|_| internal_error())
    })
    .await
}

pub(super) async fn aggregate(
    state: &AppState,
    operation: &str,
    parts: &[(&str, Value)],
    ttl: u64,
    collection: &str,
    mut pipeline: Vec<Document>,
) -> Result<Value, ProblemError> {
    cached_total(state, operation, parts, ttl, async {
        pipeline.push(doc! {"$count":"total"});
        let rows = state
            .mongo
            .aggregate(collection, pipeline)
            .await
            .map_err(|_| internal_error())?;
        Ok(rows
            .first()
            .and_then(|row| row.get("total"))
            .map(egdata_infra::bson_json::bson_to_js_json)
            .unwrap_or_else(|| json!(0)))
    })
    .await
}
