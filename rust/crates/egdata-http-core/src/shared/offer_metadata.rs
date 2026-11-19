//! Shared `offer_metadata` helpers used by the versioned and unversioned surfaces.
use std::collections::BTreeMap;

use bson::Document;
use egdata_core::attributes::AttributeValue;
use egdata_core::v1::ProblemError;
use egdata_core::v1::serialization::js_truthy;
use egdata_infra::bson_json::bson_to_js_json;

use crate::shared::offers::stored_truthy;

pub fn feature_attributes(
    items: &[Document],
) -> Result<BTreeMap<String, AttributeValue>, ProblemError> {
    // Object.assign applies each item's attributes in order. A falsy value in a
    // later object can clear an earlier launcher flag.
    let mut attributes = BTreeMap::new();
    for item in items {
        let Some(raw) = item.get("customAttributes") else {
            continue;
        };
        let fields = crate::shared::offers::checked_attributes(&bson_to_js_json(raw))?;
        if let Some(fields) = fields.as_object() {
            for (key, value) in fields {
                let present = raw
                    .as_document()
                    .and_then(|d| d.get(key))
                    .map_or_else(|| js_truthy(value), stored_truthy);
                if present {
                    attributes.insert(
                        key.clone(),
                        AttributeValue {
                            attr_type: value["type"].as_str().unwrap_or_default().to_owned(),
                            value: value["value"].as_str().unwrap_or_default().to_owned(),
                        },
                    );
                } else {
                    attributes.remove(key);
                }
            }
        }
    }
    Ok(attributes)
}
