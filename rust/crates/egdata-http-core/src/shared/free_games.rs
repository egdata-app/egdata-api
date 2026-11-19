//! Shared `free_games` helpers used by the versioned and unversioned surfaces.
use bson::{Document, doc};
use serde_json::{Value, json};

pub fn string_property(row: &Value, field: &str) -> String {
    row.get(field).map_or_else(
        || "undefined".to_owned(),
        egdata_core::v1::serialization::js_string,
    )
}

pub fn normalized_giveaway(raw: &Value, offer_id: &str, historical: Option<Value>) -> Value {
    let mut object = raw.as_object().cloned().unwrap_or_default();
    if !object.get("offerId").is_some_and(Value::is_string) {
        object.insert("offerId".into(), json!(offer_id));
    }
    if !object.get("platform").is_some_and(Value::is_string) {
        object.insert("platform".into(), Value::Null);
    }
    if let Some(historical) = historical {
        object.insert("historical".into(), historical);
    }
    Value::Object(object)
}

pub fn normalize_blacklist(value: &Value) -> Value {
    match value {
        Value::Array(values) => json!(
            values
                .iter()
                .filter(|v| v.is_string())
                .cloned()
                .collect::<Vec<_>>()
        ),
        Value::String(s) if !s.is_empty() => json!([s]),
        _ => json!([]),
    }
}

pub fn free_sellers_pipeline() -> Vec<Document> {
    vec![
        doc! {"$group":{"_id":"$id","doc":{"$first":"$$ROOT"}}},
        doc! {"$replaceRoot":{"newRoot":"$doc"}},
        doc! {"$lookup":{"from":"offers","localField":"id","foreignField":"id","as":"offer"}},
        doc! {"$unwind":"$offer"},
        doc! {"$group":{"_id":{"sellerId":"$offer.seller.id","sellerName":"$offer.seller.name"},"totalSingleGames":{"$sum":1}}},
        doc! {"$project":{"_id":0,"sellerId":"$_id.sellerId","sellerName":"$_id.sellerName","totalSingleGames":1}},
        doc! {"$sort":{"totalSingleGames":-1}},
    ]
}
