//! Offer metadata helpers shared by both HTTP surfaces.

use bson::{Bson, Document, doc};
use egdata_core::attributes::ORDERED_OFFER_KEYS;
use egdata_core::ports::MongoFindOptions;
use egdata_core::v1::ProblemError;
use egdata_core::v1::serialization::{js_string, js_truthy};
use serde_json::{Map, Value};

use crate::shared::system::{docs_to_json, internal_error};
use crate::state::AppState;

pub fn stored_truthy(value: &Bson) -> bool {
    match value {
        Bson::Double(n) => *n != 0. && !n.is_nan(),
        Bson::Null | Bson::Undefined => false,
        Bson::Boolean(b) => *b,
        Bson::String(s) => !s.is_empty(),
        Bson::Int32(n) => *n != 0,
        Bson::Int64(n) => *n != 0,
        _ => true,
    }
}

pub async fn find(
    state: &AppState,
    collection: &str,
    filter: Document,
    options: MongoFindOptions,
) -> Result<Vec<Value>, ProblemError> {
    state
        .mongo
        .find_many(collection, filter, options)
        .await
        .map(docs_to_json)
        .map_err(|_| internal_error())
}

/// Mirrors orderOffersObject's array destructuring before localization.
pub fn checked_ordered(raw: &Value) -> Result<Value, ProblemError> {
    let source = &raw["customAttributes"];
    let attributes = if js_truthy(source) {
        checked_attributes(source)?
    } else {
        Value::Null
    };
    Ok(ordered_with_attributes(raw, attributes))
}

/// Converts the array form of attributesToObject and preserves historical non-array values.
pub fn checked_attributes(source: &Value) -> Result<Value, ProblemError> {
    egdata_core::v1::serialization::checked_attribute_map(source).ok_or_else(internal_error)
}

pub fn ordered_with_attributes(raw: &Value, attributes: Value) -> Value {
    let mut result = Map::new();
    for key in ORDERED_OFFER_KEYS {
        result.insert(key.into(), raw[key].clone());
    }
    result.insert("customAttributes".into(), attributes);
    Value::Object(result)
}

pub fn item_offer_rank(doc: &bson::Document) -> u8 {
    let kind = doc
        .get("offerType")
        .map(egdata_infra::bson_json::bson_to_js_json)
        .map(|v| js_string(&v).to_uppercase());
    let rank = match kind.as_deref().unwrap_or("") {
        "BASE_GAME" => 0,
        "DLC" => 1,
        "ADD_ON" | "ADDON" => 2,
        "EDITION" => 3,
        "BUNDLE" => 4,
        "CONSUMABLE" => 5,
        _ => 99,
    };
    rank + if doc.get_bool("prePurchase") == Ok(true) {
        100
    } else {
        0
    }
}

pub async fn slug_candidates(
    state: &AppState,
    expanded: &[Bson],
) -> Result<Vec<Value>, ProblemError> {
    let filter = doc! {
        "$and": [
            {
                "$or": [
                    {"productSlug": {"$in": expanded}},
                    {"urlSlug": {"$in": expanded}},
                    {"offerMappings.pageSlug": {"$in": expanded}},
                    {"customAttributes": {"$elemMatch": {"key": "com.epicgames.app.productSlug", "value": {"$in": expanded}}}},
                    {"customAttributes": {"$elemMatch": {"key": "slug", "value": {"$in": expanded}}}},
                ],
            },
            {"prePurchase": {"$ne": true}},
        ],
    };
    let options = MongoFindOptions {
        projection: Some(doc! {
            "id": 1, "productSlug": 1, "urlSlug": 1, "offerMappings": 1,
            "customAttributes": 1, "prePurchase": 1, "namespace": 1,
        }),
        ..Default::default()
    };
    find(state, "offers", filter, options).await
}

pub fn offer_identifier(offer: &Value) -> String {
    offer
        .get("id")
        .map(js_string)
        .unwrap_or_else(|| "undefined".into())
}
