//! JavaScript-compatible JSON helpers shared by both HTTP surfaces.

use serde_json::{Value, json};

/// Mirrors object spread for cached and historical JSON values.
pub fn spread(value: &Value) -> Value {
    let mut fields = serde_json::Map::new();
    match value {
        Value::Object(record) => return Value::Object(record.clone()),
        Value::Array(items) => fields.extend(
            items
                .iter()
                .enumerate()
                .map(|(i, v)| (i.to_string(), v.clone())),
        ),
        Value::String(text) => fields.extend(
            text.chars()
                .enumerate()
                .map(|(i, c)| (i.to_string(), json!(c.to_string()))),
        ),
        _ => {}
    }
    Value::Object(fields)
}
