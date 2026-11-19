//! Item serialization from native Mongo records, before BSON values lose their JS type.
pub use egdata_http_core::shared::system::truthy;

use bson::{Bson, Document};
use egdata_core::v1::serialization::{
    ITEM_FIELDS, bson_date_value, bson_to_serialized_json, insert_attribute,
    is_coercible_attribute_key, stored_identifier,
};
use egdata_infra::bson_json::bson_to_js_json;
use serde_json::{Map, Value};


fn attributes(source: &Bson) -> Value {
    let Bson::Array(entries) = source else {
        return bson_to_js_json(source);
    };
    let mut result = Map::new();
    for entry in entries {
        if matches!(entry, Bson::Null | Bson::Undefined) {
            // serializeItem catches the failed destructuring and serializes the original array.
            return bson_to_serialized_json(source);
        }
        let Some(fields) = entry.as_document() else {
            continue;
        };
        let Some(key) = fields.get("key").filter(|key| truthy(key)) else {
            continue;
        };
        if matches!(key, Bson::Array(_) | Bson::Document(_))
            && !is_coercible_attribute_key(&bson_to_js_json(key))
        {
            return bson_to_serialized_json(source);
        }
        let key = stored_identifier(key).expect("truthy keys are defined");
        let kind = fields
            .get("type")
            .filter(|v| truthy(v))
            .map(bson_to_js_json);
        let value = fields
            .get("value")
            .filter(|v| !matches!(v, Bson::Undefined))
            .map(bson_to_js_json);
        insert_attribute(&mut result, key, kind, value);
    }
    Value::Object(result)
}

pub(super) fn stored_item(row: &Document) -> Value {
    let mut out = Map::with_capacity(ITEM_FIELDS.len() + 1);
    for &field in ITEM_FIELDS {
        let value = row.get(field).map_or(Value::Null, |raw| match field {
            "_id" | "id" => stored_identifier(raw).into(),
            "creationDate" | "lastModifiedDate" | "releaseDate" => bson_date_value(raw),
            _ => bson_to_serialized_json(raw),
        });
        out.insert(field.into(), value);
    }
    out.insert(
        "customAttributes".into(),
        row.get("customAttributes").map_or(Value::Null, attributes),
    );
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    #[test]
    fn stored_item_attributes_match_node_bson_bytes() {
        let fixtures: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../../egdata-api/tests/fixtures/item-attributes-bson-node.json"
        ))
        .unwrap();
        for fixture in fixtures {
            let bytes = hex::decode(fixture["bsonHex"].as_str().unwrap()).unwrap();
            let row = bson::from_slice(&bytes).unwrap();
            let name = &fixture["name"];
            assert_eq!(super::stored_item(&row), fixture["item"], "{name}");
        }
    }

    #[tokio::test]
    async fn registered_item_attributes_match_node() {
        egdata_api_oracle::replay_mongo_oracle(include_str!(
            "../../egdata-api/tests/fixtures/item-attributes-http-node.json"
        ))
        .await;
    }
}
