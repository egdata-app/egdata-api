//! Shared `offer_prices` helpers used by the versioned and unversioned surfaces.
use bson::{Bson, Document};
use chrono::{DateTime, Utc};
use egdata_core::v1::{ProblemError, serialization};
use serde_json::{Value, json};

use crate::shared::system::{doc_to_json, internal_error, stored_string_key};

/// Persisted strings and decoded cursors also accept RFC-formatted timestamps.
pub fn cursor_date(value: &str) -> Option<DateTime<Utc>> {
    serialization::parse_stored_timestamp(value)
}

pub fn serialize_stored_price(mut raw: Document) -> Result<Value, ProblemError> {
    // The Node driver's Decimal128 and unpromoted Long implement String()/Number().
    // Preserve that scalar before the general serializer enumerates their BSON fields.
    fn amounts(doc: &mut Document, top_level: bool) {
        for &key in serialization::PRICE_AMOUNT_FIELDS {
            // A BSON object stored as the top-level price becomes the nested price object.
            if top_level && key == "price" {
                continue;
            }
            let text = match doc.get(key) {
                Some(Bson::Decimal128(n)) => n.to_string(),
                Some(Bson::Int64(n)) => n.to_string(),
                _ => continue,
            };
            doc.insert(key, text);
        }
    }
    if let Some(id) = raw.get("offerId")
        && !matches!(id, Bson::Null | Bson::Undefined)
    {
        let key = stored_string_key(Some(id))?;
        raw.insert("offerId", key);
    }
    amounts(&mut raw, true);
    if let Ok(price) = raw.get_document_mut("price") {
        amounts(price, false);
    }
    if let Ok(text) = raw.get_str("updatedAt")
        && let Some(date) = cursor_date(text)
    {
        raw.insert("updatedAt", bson::DateTime::from_chrono(date));
    }
    // Stored BSON may contain a literal Extended JSON date from an older import.
    // Its spelling belongs in the response even though the pagination cursor uses ISO.
    let literal_date = raw
        .get_document("date")
        .ok()
        .filter(|date| date.len() == 1)
        .and_then(|date| date.get("$date"))
        .map(|value| json!({"$date": serialization::bson_to_serialized_json(value)}));
    // serializePrice copies region directly to its output; it retains the driver's toJSON shape.
    let region = raw
        .get("region")
        .map(egdata_infra::bson_json::bson_to_js_json)
        .unwrap_or(Value::Null);
    let mut price = serialization::checked_price(&doc_to_json(raw)).ok_or_else(internal_error)?;
    price["region"] = region;
    if let Some(date) = literal_date {
        price["date"] = date;
    }
    Ok(price)
}
