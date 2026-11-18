//! BSON-to-JSON conversion matching Node.js `JSON.stringify` semantics on MongoDB documents.

use crate::v1::serialization::{js_iso_millis, node_bson_long, node_db_pointer};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use bson::{Bson, Document};
use serde_json::{Map, Number, Value, json};

/// Returns the ISO string for a valid JavaScript Date and None outside its range.
pub fn bson_datetime_to_iso_string(dt: bson::DateTime) -> Option<String> {
    js_iso_millis(dt.timestamp_millis())
}

/// Converts a `bson::Document` to a `serde_json::Value::Object` matching Node's `JSON.stringify`:
/// - `Bson::Undefined` keys are omitted (not emitted as `null`)
/// - `Bson::DateTime` -> `YYYY-MM-DDTHH:mm:ss.sssZ`
/// - `Bson::ObjectId` -> 24-char lowercase hex string
/// - `Bson::Int64` -> a JS number or the driver's Long object, depending on magnitude
/// - `Bson::Double` -> finite float JSON number (non-finite becomes `null`)
pub fn bson_doc_to_js_json(doc: &Document) -> Value {
    let mut map = Map::with_capacity(doc.len());
    for (k, v) in doc {
        if matches!(v, Bson::Undefined) {
            continue;
        }
        map.insert(k.clone(), bson_to_js_json(v));
    }
    Value::Object(map)
}

/// Converts any `bson::Bson` value into `serde_json::Value` matching Node `JSON.stringify`.
pub fn bson_to_js_json(value: &Bson) -> Value {
    match value {
        Bson::Double(f) => Number::from_f64(*f)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        Bson::String(s) => Value::String(s.clone()),
        Bson::Array(arr) => Value::Array(arr.iter().map(bson_to_js_json).collect()),
        Bson::Document(doc) => bson_doc_to_js_json(doc),
        Bson::Boolean(b) => Value::Bool(*b),
        Bson::Null | Bson::Undefined => Value::Null,
        Bson::RegularExpression(_) => Value::Object(Map::new()),
        Bson::JavaScriptCode(code) => json!({"code": code}),
        Bson::JavaScriptCodeWithScope(js) => {
            json!({"code": js.code, "scope": bson_doc_to_js_json(&js.scope)})
        }
        Bson::Int32(i) => Value::Number((*i).into()),
        Bson::Int64(i) => node_bson_long(*i),
        Bson::Timestamp(ts) => {
            json!({"$timestamp": ((u64::from(ts.time) << 32) | u64::from(ts.increment)).to_string()})
        }
        Bson::Binary(bin)
            if bin.subtype == bson::spec::BinarySubtype::Uuid && bin.bytes.len() == 16 =>
        {
            let digits = hex::encode(&bin.bytes);
            format!(
                "{}-{}-{}-{}-{}",
                &digits[..8],
                &digits[8..12],
                &digits[12..16],
                &digits[16..20],
                &digits[20..]
            )
            .into()
        }
        Bson::Binary(bin) => Value::String(BASE64_STANDARD.encode(&bin.bytes)),
        Bson::ObjectId(oid) => Value::String(oid.to_hex()),
        Bson::DateTime(dt) => bson_datetime_to_iso_string(*dt).into(),
        Bson::Symbol(sym) => Value::String(sym.clone()),
        Bson::Decimal128(dec) => json!({"$numberDecimal": dec.to_string()}),
        Bson::MinKey | Bson::MaxKey => json!({}),
        Bson::DbPointer(pointer) => {
            let (db, collection, oid) = node_db_pointer(pointer);
            let mut reference = json!({"$ref": collection, "$id": oid});
            if let Some(db) = db {
                reference["$db"] = db.into();
            }
            reference
        }
    }
}
