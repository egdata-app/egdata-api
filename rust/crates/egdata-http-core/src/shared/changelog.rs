//! Changelog context resolution shared by the versioned catalog and legacy top reads.

use crate::state::AppState;
use bson::{Bson, Document, doc, oid::ObjectId};
use egdata_infra::bson_json::bson_doc_to_js_json;
use serde_json::Value;

use crate::shared::offers::stored_truthy;

pub async fn resolve_changelog_context_safely(state: &AppState, change: &Document) -> Value {
    let Ok(metadata) = change.get_document("metadata") else {
        return Value::Null;
    };
    let Ok(context_type) = metadata.get_str("contextType") else {
        return Value::Null;
    };
    let Some(context_id) = metadata.get("contextId").filter(|id| stored_truthy(id)) else {
        return Value::Null;
    };

    let res = match context_type {
        "offer" => {
            state
                .mongo
                .find_one(
                    "offers",
                    doc! {"id": {"$eq": context_id}},
                    Some(
                        doc! {"id": 1, "title": 1, "keyImages": 1, "offerType": 1, "namespace": 1},
                    ),
                )
                .await
        }
        "item" => {
            state
                .mongo
                .find_one(
                    "items",
                    doc! {"id": {"$eq": context_id}},
                    Some(doc! {"id": 1, "title": 1, "keyImages": 1, "namespace": 1}),
                )
                .await
        }
        "asset" => state
            .mongo
            .find_one(
                "assets",
                doc! {"$or": [{"artifactId": {"$eq": context_id}}, {"id": {"$eq": context_id}}]},
                Some(doc! {"id": 1, "artifactId": 1, "namespace": 1}),
            )
            .await,
        "build" => {
            state
                .mongo
                .find_one(
                    "builds",
                    id_or_oid_filter(context_id),
                    Some(doc! {"_id": 1, "appName": 1, "buildVersion": 1}),
                )
                .await
        }
        _ => return Value::Null,
    };

    res.ok()
        .flatten()
        .map(|doc| bson_doc_to_js_json(&doc))
        .unwrap_or(Value::Null)
}

pub fn id_or_oid_filter(id: &Bson) -> Document {
    if let Some(oid) = id
        .as_object_id()
        .or_else(|| id.as_str().and_then(|text| ObjectId::parse_str(text).ok()))
    {
        doc! {"$or": [{"_id": oid}, {"_id": {"$eq": id}}]}
    } else {
        doc! {"_id": {"$eq": id}}
    }
}
