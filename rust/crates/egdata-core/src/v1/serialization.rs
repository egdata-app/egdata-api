//! Deterministic `/v1` document serialization and currency precision helpers.

use bson::Bson;
use chrono::{DateTime, Datelike, NaiveDate, SecondsFormat, Timelike, Utc};
use serde::{Serialize, Serializer, ser::SerializeMap};
use serde_json::{Map, Number, Value};

// HTTP ETags hash the serialized bytes. JavaScript's JSON.stringify uses a
// different spelling than serde_json for values such as 10.0, -0.0 and 1e-7.
struct NodeNumberFormat;

impl serde_json::ser::Formatter for NodeNumberFormat {
    fn write_f64<W: ?Sized + std::io::Write>(
        &mut self,
        writer: &mut W,
        value: f64,
    ) -> std::io::Result<()> {
        writer.write_all(ryu_js::Buffer::new().format(value).as_bytes())
    }
}

/// Returns the integer index of an enumerable ECMAScript array-index property.
pub fn js_array_index(key: &str) -> Option<u32> {
    if key.is_empty()
        || (key.len() > 1 && key.starts_with('0'))
        || !key.as_bytes()[0].is_ascii_digit()
    {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

struct NodeValue<'a>(&'a Value);

impl Serialize for NodeValue<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self.0 {
            Value::Array(items) => serializer.collect_seq(items.iter().map(NodeValue)),
            Value::Object(object) => {
                let mut map = serializer.serialize_map(Some(object.len()))?;
                if object.keys().any(|k| js_array_index(k).is_some()) {
                    let mut entries: Vec<_> = object.iter().collect();
                    entries.sort_by_key(|(key, _)| js_array_index(key).unwrap_or(u32::MAX));
                    for (key, value) in entries {
                        map.serialize_entry(key, &NodeValue(value))?;
                    }
                } else {
                    for (key, value) in object {
                        map.serialize_entry(key, &NodeValue(value))?;
                    }
                }
                map.end()
            }
            Value::Number(n) if n.as_f64().is_some_and(|v| v.abs() >= (1_u64 << 53) as f64) => {
                serializer.serialize_f64(n.as_f64().unwrap())
            }
            scalar => scalar.serialize(serializer),
        }
    }
}

/// Compact JSON with ECMAScript property order and number formatting for bodies and hashes.
pub fn node_json(value: &Value) -> String {
    let mut serializer = serde_json::Serializer::with_formatter(Vec::new(), NodeNumberFormat);
    NodeValue(value)
        .serialize(&mut serializer)
        .expect("JSON values can be serialized into a byte vector");
    String::from_utf8(serializer.into_inner()).expect("JSON is valid UTF-8")
}

/// Document field names normalized as UTC ISO 8601 timestamps.
pub const DATE_FIELDS: &[&str] = &[
    "effectiveDate",
    "creationDate",
    "lastModifiedDate",
    "releaseDate",
    "pcReleaseDate",
    "viewableDate",
    "expiryDate",
    "updatedAt",
    "createdAt",
    "fetchedAt",
    "sourceUpdatedAt",
    "timestamp",
    "lastUpdated",
    "startDate",
    "endDate",
    "serverDate",
    "lastUsedAt",
];

/// Canonical field list preserved on serialized offer documents.
pub const OFFER_FIELDS: &[&str] = &[
    "_id",
    "id",
    "namespace",
    "title",
    "description",
    "longDescription",
    "offerType",
    "effectiveDate",
    "creationDate",
    "lastModifiedDate",
    "isCodeRedemptionOnly",
    "keyImages",
    "currentPrice",
    "seller",
    "productSlug",
    "offerMappings",
    "urlSlug",
    "url",
    "tags",
    "items",
    "categories",
    "developerDisplayName",
    "publisherDisplayName",
    "prePurchase",
    "releaseDate",
    "pcReleaseDate",
    "viewableDate",
    "expiryDate",
    "countriesBlacklist",
    "countriesWhitelist",
    "refundType",
];

/// Canonical field list preserved on serialized item documents.
pub const ITEM_FIELDS: &[&str] = &[
    "_id",
    "id",
    "namespace",
    "title",
    "description",
    "longDescription",
    "itemType",
    "creationDate",
    "lastModifiedDate",
    "releaseDate",
    "keyImages",
    "categories",
    "developer",
    "entitlementName",
    "entitlementType",
    "status",
    "url",
    "linkedOffers",
    "builds",
];

/// Price fields normalized to integer minor currency units.
pub const PRICE_AMOUNT_FIELDS: &[&str] = &[
    "originalPrice",
    "discountPrice",
    "price",
    "basePrice",
    "minPrice",
    "maxPrice",
    "amount",
];

const ZERO_DECIMAL_CURRENCIES: &[&str] = &[
    "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND",
    "VUV", "XAF", "XOF", "XPF",
];

const THREE_DECIMAL_CURRENCIES: &[&str] = &["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"];

/// Returns the decimal precision (0, 2, or 3) for an ISO 4217 currency code.
pub fn currency_precision(currency_code: Option<&str>) -> u8 {
    let Some(code) = currency_code.filter(|s| !s.is_empty()) else {
        return 2;
    };
    let upper = code.to_ascii_uppercase();
    if ZERO_DECIMAL_CURRENCIES.contains(&upper.as_str()) {
        0
    } else if THREE_DECIMAL_CURRENCIES.contains(&upper.as_str()) {
        3
    } else {
        2
    }
}

/// Converts a `bson::Bson` value into a normalized `serde_json::Value`.
pub fn bson_to_serialized_json(value: &Bson) -> Value {
    serialize_bson_depth(value, 0)
}

/// The Node MongoDB driver's default deserializer promotes signed 64-bit values
/// through ±2^53 to JS numbers. Larger values remain BSON Long instances.
pub fn node_bson_long(value: i64) -> Value {
    const LIMIT: i64 = 1 << 53;
    if (-LIMIT..=LIMIT).contains(&value) {
        value.into()
    } else {
        serde_json::json!({"high": (value >> 32) as i32, "low": value as i32, "unsigned": false})
    }
}

/// The driver's DBRef constructor splits a namespace with exactly one dot.
pub fn node_db_pointer(pointer: &bson::DbPointer) -> (Option<String>, String, Value) {
    // The bson crate exposes DBPointer's namespace and OID only via Extended JSON.
    let extended = Bson::DbPointer(pointer.clone()).into_relaxed_extjson();
    let fields = &extended["$dbPointer"];
    let namespace = fields["$ref"].as_str().unwrap();
    let (db, collection) = namespace
        .split_once('.')
        .filter(|(_, rest)| !rest.contains('.'))
        .map_or((None, namespace), |(db, collection)| {
            (Some(db.to_owned()), collection)
        });
    (db, collection.to_owned(), fields["$id"]["$oid"].clone())
}

fn enumerable_bytes(bytes: &[u8]) -> Value {
    Value::Object(
        bytes
            .iter()
            .enumerate()
            .map(|(i, byte)| (i.to_string(), (*byte).into()))
            .collect(),
    )
}

/// JavaScript Date.toISOString uses a signed, six-digit year outside 0000..9999.
pub fn js_iso_datetime(dt: DateTime<Utc>) -> String {
    let year = dt.year();
    if (0..=9999).contains(&year) {
        return dt.to_rfc3339_opts(SecondsFormat::Millis, true);
    }
    format!("{year:+07}{}", dt.format("-%m-%dT%H:%M:%S%.3fZ"))
}

/// Format a stored BSON millisecond count over the full JavaScript Date range.
pub fn js_iso_millis(ms: i64) -> Option<String> {
    if ms.unsigned_abs() > 8_640_000_000_000_000 {
        return None;
    }
    if let Some(dt) = DateTime::from_timestamp_millis(ms) {
        return Some(js_iso_datetime(dt));
    }
    // Outside chrono's range each Gregorian cycle shifts the year by exactly 400.
    const CYCLE_MS: i64 = 146_097 * 86_400_000;
    let within_cycle = DateTime::from_timestamp_millis(ms.rem_euclid(CYCLE_MS)).unwrap();
    let year = i64::from(within_cycle.year()) + 400 * ms.div_euclid(CYCLE_MS);
    Some(format!(
        "{year:+07}{}",
        within_cycle.format("-%m-%dT%H:%M:%S%.3fZ")
    ))
}

/// Convert a stored identifier before BSON objects lose their scalar string representation.
pub fn stored_identifier(value: &Bson) -> Option<String> {
    Some(match value {
        Bson::Null | Bson::Undefined => return None,
        Bson::Int64(n) => n.to_string(),
        Bson::Double(n) => super::query::format_js_number(*n),
        Bson::Decimal128(decimal) => decimal.to_string(),
        Bson::Timestamp(ts) => ((u64::from(ts.time) << 32) | u64::from(ts.increment)).to_string(),
        Bson::Binary(bin)
            if bin.subtype == bson::spec::BinarySubtype::Uuid && bin.bytes.len() == 16 =>
        {
            uuid::Uuid::from_slice(&bin.bytes).unwrap().to_string()
        }
        Bson::Binary(bin) => String::from_utf8_lossy(&bin.bytes).into_owned(),
        Bson::Array(entries) => entries
            .iter()
            .map(|v| stored_identifier(v).unwrap_or_default())
            .collect::<Vec<_>>()
            .join(","),
        Bson::Document(_) => "[object Object]".into(),
        other => js_string(&crate::bson_json::bson_to_js_json(other)),
    })
}

/// Applies the v1 isoOrNull rules before BSON dates are converted to response JSON.
pub fn bson_iso_or_null(value: &Bson) -> Option<String> {
    match value {
        Bson::DateTime(dt) => js_iso_millis(dt.timestamp_millis()),
        Bson::String(s) | Bson::Symbol(s) => iso_or_null(&Value::String(s.clone())),
        Bson::Document(doc) => doc.get("$date").and_then(bson_iso_or_null),
        _ => None,
    }
}

/// Serialize date fields while their BSON types and literal document keys are still available.
pub fn bson_date_value(value: &Bson) -> Value {
    bson_iso_or_null(value).map_or_else(|| crate::bson_json::bson_to_js_json(value), Value::String)
}

fn serialize_bson_depth(value: &Bson, depth: usize) -> Value {
    if depth > 12 {
        return Value::Null;
    }
    let properties = match value {
        Bson::Array(entries) => {
            return Value::Array(
                entries
                    .iter()
                    .map(|entry| serialize_bson_depth(entry, depth + 1))
                    .collect(),
            );
        }
        Bson::Document(doc) => {
            let mut map = Map::with_capacity(doc.len());
            for (key, entry) in doc {
                let field = match key.as_str() {
                    "__v" | "__proto__" => continue,
                    "_id" | "id" => stored_identifier(entry).into(),
                    field if DATE_FIELDS.contains(&field) => bson_date_value(entry),
                    _ => serialize_bson_depth(entry, depth + 1),
                };
                map.insert(key.clone(), field);
            }
            return Value::Object(map);
        }
        Bson::Binary(bin) => serde_json::json!({
            "buffer": enumerable_bytes(&bin.bytes), "sub_type": u8::from(bin.subtype), "position": bin.bytes.len()
        }),
        Bson::Decimal128(decimal) => {
            serde_json::json!({"bytes": enumerable_bytes(&decimal.bytes())})
        }
        Bson::Timestamp(ts) => serde_json::json!({
            "high": ts.time as i32, "low": ts.increment as i32, "unsigned": true
        }),
        Bson::JavaScriptCode(code) => serde_json::json!({"code": code, "scope": null}),
        Bson::JavaScriptCodeWithScope(js) => {
            let code = serialize_bson_depth(&Bson::String(js.code.clone()), depth + 1);
            let scope = serialize_bson_depth(&Bson::Document(js.scope.clone()), depth + 1);
            return serde_json::json!({"code": code, "scope": scope});
        }
        Bson::DbPointer(pointer) => {
            let (db, collection, oid) = node_db_pointer(pointer);
            serde_json::json!({"collection": collection, "oid": oid, "db": db, "fields": {}})
        }
        // Unpromoted Long instances have enumerable high/low/unsigned properties.
        Bson::Int64(n) => node_bson_long(*n),
        other => return crate::bson_json::bson_to_js_json(other),
    };
    serialize_value_depth(&properties, depth, JsonFormat::Extended)
}

/// ECMAScript date-only strings use UTC and default omitted month and day to January 1.
pub fn parse_iso_date_only(s: &str) -> Option<DateTime<Utc>> {
    let full_date = match s.len() {
        4 if s.bytes().all(|b| b.is_ascii_digit()) => Some(format!("{s}-01-01")),
        7 if s.as_bytes()[4] == b'-' => Some(format!("{s}-01")),
        _ => None,
    };
    NaiveDate::parse_from_str(full_date.as_deref().unwrap_or(s), "%Y-%m-%d")
        .ok()
        .map(|day| day.and_time(chrono::NaiveTime::MIN).and_utc())
}

/// Parse stored timestamps for both catalog responses and their pagination cursors.
pub fn parse_stored_timestamp(value: &str) -> Option<DateTime<Utc>> {
    if let Ok(date) = DateTime::parse_from_rfc3339(value) {
        return (date.nanosecond() < 1_000_000_000).then(|| date.to_utc());
    }
    parse_iso_date_only(value)
        .or_else(|| super::iso_date::parse_iso_timestamp(value))
        .or_else(|| {
            DateTime::parse_from_rfc2822(value)
                .or_else(|_| DateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f%z"))
                .ok()
                .filter(|date| date.nanosecond() < 1_000_000_000)
                .map(|date| date.to_utc())
        })
}

/// Parses a JSON date representation into a UTC ISO 8601 string with millisecond precision.
pub fn iso_or_null(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(s) => {
            if s.is_empty() {
                return None;
            }
            Some(parse_stored_timestamp(s).map_or_else(|| s.clone(), js_iso_datetime))
        }
        Value::Object(map) => {
            if let Some(date_val) = map.get("$date") {
                match date_val {
                    Value::Number(n) => n
                        .as_i64()
                        .and_then(DateTime::from_timestamp_millis)
                        .map(js_iso_datetime),
                    Value::Object(inner) => inner
                        .get("$numberLong")
                        .and_then(Value::as_str)
                        .and_then(|s| s.parse::<i64>().ok())
                        .and_then(DateTime::from_timestamp_millis)
                        .map(js_iso_datetime),
                    _ => iso_or_null(date_val),
                }
            } else {
                None
            }
        }
        _ => None,
    }
}

/// The String() conversion used for document identifiers, filters and map keys in Node.
pub fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::String(s) => s.clone(),
        Value::Number(n) => super::query::format_js_number(n.as_f64().unwrap()),
        Value::Bool(b) => b.to_string(),
        Value::Array(entries) => entries
            .iter()
            .map(|entry| {
                if entry.is_null() {
                    String::new()
                } else {
                    js_string(entry)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// Preserves null and recognizes Extended JSON ObjectIds before String() coercion.
pub fn string_id(value: &Value) -> Value {
    if value.is_null() {
        return Value::Null;
    }
    if let Some(Value::String(oid)) = value.get("$oid") {
        return Value::String(oid.clone());
    }
    Value::String(js_string(value))
}

/// Normalizes a date field, returning `Null` for missing values or preserving non-date values.
pub fn date_value(value: &Value) -> Value {
    if value.is_null() {
        return Value::Null;
    }
    iso_or_null(value).map_or_else(|| value.clone(), Value::String)
}

/// Recursively normalizes values without dropping documented fields.
pub fn serialize_value(value: &Value) -> Value {
    serialize_value_depth(value, 0, JsonFormat::Extended)
}

/// Mirrors serializeValue on data parsed from an HTTP response or a JSON cache.
pub fn serialize_json_value(value: &Value) -> Value {
    serialize_value_depth(value, 0, JsonFormat::Plain)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum JsonFormat {
    Extended,
    Plain,
}

impl JsonFormat {
    fn id(self, value: &Value) -> Value {
        match self {
            Self::Extended => string_id(value),
            Self::Plain if value.is_null() => Value::Null,
            Self::Plain => Value::String(js_string(value)),
        }
    }

    fn date(self, value: &Value) -> Value {
        if self == Self::Extended {
            return date_value(value);
        }
        // Node's isoOrNull follows literal $date properties but only parses a
        // string or native Date. A plain JSON number is not a BSON datetime.
        let mut date = value;
        while let Some(inner) = date.get("$date") {
            date = inner;
        }
        date.as_str()
            .and_then(|_| iso_or_null(date))
            .map_or_else(|| value.clone(), Value::String)
    }
}

fn serialize_value_depth(value: &Value, depth: usize, format: JsonFormat) -> Value {
    if depth > 12 {
        return Value::Null;
    }
    match value {
        Value::Null => Value::Null,
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|entry| serialize_value_depth(entry, depth + 1, format))
                .collect(),
        ),
        Value::Object(map) => {
            if format == JsonFormat::Extended
                && map.len() == 1
                && let Some(Value::String(oid)) = map.get("$oid")
            {
                return Value::String(oid.clone());
            }
            if format == JsonFormat::Extended && map.len() == 1 && map.contains_key("$date") {
                return date_value(value);
            }
            let mut output = Map::new();
            for (key, entry) in map {
                if key == "__v" || (format == JsonFormat::Plain && key == "__proto__") {
                    continue;
                }
                if key == "_id" || key == "id" {
                    output.insert(key.clone(), format.id(entry));
                } else if DATE_FIELDS.contains(&key.as_str()) {
                    output.insert(key.clone(), format.date(entry));
                } else {
                    output.insert(key.clone(), serialize_value_depth(entry, depth + 1, format));
                }
            }
            Value::Object(output)
        }
        _ => value.clone(),
    }
}

pub fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64() != Some(0.),
        _ => true,
    }
}

/// Assign an array-form custom attribute to a plain JavaScript result object.
pub fn insert_attribute(
    result: &mut Map<String, Value>,
    key: String,
    kind: Option<Value>,
    value: Option<Value>,
) {
    // Assignment of __proto__ changes the prototype, without adding an enumerable own key.
    if key == "__proto__" {
        return;
    }
    let mut fields = Map::new();
    fields.insert(
        "type".into(),
        kind.unwrap_or_else(|| Value::String("STRING".into())),
    );
    if let Some(value) = value {
        fields.insert("value".into(), value);
    }
    result.insert(key, Value::Object(fields));
}

/// A stored object with an own, non-callable toString cannot produce a string
/// primitive. Array.join also applies this conversion to its elements.
pub fn is_coercible_attribute_key(key: &Value) -> bool {
    match key {
        Value::Object(fields) => !fields.contains_key("toString"),
        Value::Array(keys) => keys.iter().all(is_coercible_attribute_key),
        _ => true,
    }
}

/// The unchecked JS helper throws when a null array entry cannot be destructured.
pub fn checked_attribute_map(source: &Value) -> Option<Value> {
    let Some(entries) = source.as_array() else {
        return Some(source.clone());
    };
    let mut result = Map::new();
    for entry in entries {
        if entry.is_null() {
            return None;
        }
        if let Some(key) = entry.get("key").filter(|value| js_truthy(value)) {
            if !is_coercible_attribute_key(key) {
                return None;
            }
            insert_attribute(
                &mut result,
                js_string(key),
                entry.get("type").filter(|v| js_truthy(v)).cloned(),
                entry.get("value").cloned(),
            );
        }
    }
    Some(Value::Object(result))
}

pub fn attributes_to_object(value: &Value) -> Value {
    checked_attribute_map(value).unwrap_or_else(|| serialize_value(value))
}

fn custom_attributes_value(value: Option<&Value>, format: JsonFormat) -> Value {
    match value {
        None | Some(Value::Null) => Value::Null,
        Some(v) => checked_attribute_map(v).unwrap_or_else(|| serialize_value_depth(v, 0, format)),
    }
}

/// JavaScript Number() conversion for a primitive string.
pub fn js_string_number(value: &str) -> f64 {
    use num_traits::ToPrimitive;
    let value = super::query::trim_js_whitespace(value);
    if value.is_empty() {
        return 0.;
    }
    let radix = match value.as_bytes() {
        [b'0', b'x' | b'X', ..] => Some(16),
        [b'0', b'b' | b'B', ..] => Some(2),
        [b'0', b'o' | b'O', ..] => Some(8),
        _ => None,
    };
    if let Some(radix) = radix {
        let digits = &value[2..];
        if !digits.chars().all(|ch| ch.is_digit(radix)) {
            return f64::NAN;
        }
        return num_bigint::BigUint::parse_bytes(digits.as_bytes(), radix)
            .and_then(|int| int.to_f64())
            .unwrap_or(f64::NAN);
    }
    // Rust accepts inf and case-insensitive spellings, while JS requires Infinity.
    if value
        .trim_start_matches(['+', '-'])
        .starts_with(|c: char| c.is_ascii_alphabetic())
        && !matches!(value, "Infinity" | "+Infinity" | "-Infinity")
    {
        return f64::NAN;
    }
    value.parse().unwrap_or(f64::NAN)
}

fn integer_minor_unit(value: Option<&Value>) -> Value {
    let number = match value {
        None | Some(Value::Null) => return Value::Null,
        Some(Value::Number(n)) => n.as_f64().expect("JSON numbers have an f64 representation"),
        Some(Value::Bool(b)) => f64::from(*b),
        Some(v) => js_string_number(&js_string(v)),
    };
    if !number.is_finite() {
        return Value::Null;
    }
    let floor = number.floor();
    let rounded = if number - floor < 0.5 {
        floor
    } else {
        floor + 1.0
    };
    if (i64::MIN as f64..i64::MAX as f64).contains(&rounded) {
        Value::from(rounded as i64)
    } else {
        Value::from(rounded)
    }
}

/// Serializes an offer document with explicit null-preserving fields, price, and localization metadata.
pub fn serialize_offer(
    raw_value: &Value,
    price: Option<&Value>,
    include_localization: bool,
) -> Value {
    serialize_offer_with_format(raw_value, price, include_localization, JsonFormat::Extended)
}

/// Serializes an offer from an HTTP JSON response, where $oid and $date can be literal keys.
/// The regional price is independently loaded from its MongoDB collection.
pub fn serialize_json_offer(
    raw_value: &Value,
    price: Option<&Value>,
    include_localization: bool,
) -> Value {
    serialize_offer_with_format(raw_value, price, include_localization, JsonFormat::Plain)
}

fn serialize_offer_with_format(
    raw_value: &Value,
    price: Option<&Value>,
    include_localization: bool,
    format: JsonFormat,
) -> Value {
    let raw = raw_value.as_object();
    let mut output = Map::new();

    for &field in OFFER_FIELDS {
        let value = raw.and_then(|m| m.get(field)).unwrap_or(&Value::Null);
        let serialized = match field {
            "effectiveDate" | "creationDate" | "lastModifiedDate" | "releaseDate"
            | "pcReleaseDate" | "viewableDate" | "expiryDate" => format.date(value),
            "_id" | "id" => format.id(value),
            _ => serialize_value_depth(value, 0, format),
        };
        output.insert(field.to_string(), serialized);
    }

    output.insert(
        "customAttributes".to_string(),
        custom_attributes_value(raw.and_then(|m| m.get("customAttributes")), format),
    );
    output.insert(
        "price".to_string(),
        match price {
            None => Value::Null,
            Some(p) => serialize_price(p),
        },
    );

    if include_localization {
        let locale = raw
            .and_then(|m| m.get("locale"))
            .cloned()
            .unwrap_or(Value::Null);
        let locale_status = raw
            .and_then(|m| m.get("localeStatus"))
            .cloned()
            .unwrap_or(Value::Null);
        let canonical_locale = raw
            .and_then(|m| m.get("canonicalLocale"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());

        output.insert("locale".to_string(), locale.clone());
        output.insert("localeStatus".to_string(), locale_status.clone());
        if let Some(canon) = canonical_locale {
            output.insert(
                "canonicalLocale".to_string(),
                Value::String(canon.to_string()),
            );
        }
        if let Some(loc_meta) = raw
            .and_then(|m| m.get("localization"))
            .filter(|v| !v.is_null() && **v != Value::Bool(false))
        {
            let mut loc_obj = Map::new();
            loc_obj.insert("locale".to_string(), locale);
            loc_obj.insert("localeStatus".to_string(), locale_status);
            if let Some(canon) = canonical_locale {
                loc_obj.insert(
                    "canonicalLocale".to_string(),
                    Value::String(canon.to_string()),
                );
            }
            loc_obj.insert(
                "localization".to_string(),
                serialize_value_depth(loc_meta, 0, format),
            );
            output.insert("localization".to_string(), Value::Object(loc_obj));
        }
    }

    Value::Object(output)
}

/// Serializes a regional price document with minor-unit integer normalization and currency precision.
pub fn serialize_price(raw_value: &Value) -> Value {
    serialize_price_with_format(raw_value, JsonFormat::Extended)
}

/// Search index prices come from JSON, including ordinary objects with dollar-prefixed keys.
pub fn serialize_indexed_price(raw: &Value) -> Option<Value> {
    if raw.is_null() {
        return Some(Value::Null);
    }
    let array_object;
    let raw = if let Some(entries) = raw.as_array() {
        array_object = Value::Object(
            entries
                .iter()
                .enumerate()
                .map(|(i, v)| (i.to_string(), v.clone()))
                .collect(),
        );
        &array_object
    } else {
        raw
    };
    if !raw.is_object() || invalid_price_currency(price_currency(raw)) {
        return None;
    }
    Some(serialize_price_with_format(raw, JsonFormat::Plain))
}

fn serialize_price_with_format(raw_value: &Value, format: JsonFormat) -> Value {
    if raw_value.is_null() {
        return Value::Null;
    }
    let Some(raw) = raw_value.as_object() else {
        return Value::Null;
    };
    let array_entries = raw.get("price").and_then(Value::as_array).map(|entries| {
        entries
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v.clone()))
            .collect::<Map<_, _>>()
    });
    let nested = raw
        .get("price")
        .and_then(Value::as_object)
        .or(array_entries.as_ref());
    let currency = price_currency(raw_value);
    let currency = if invalid_price_currency(currency) {
        raw.get("currencyCode")
            .filter(|code| code.is_string())
            .unwrap_or(&Value::Null)
    } else {
        currency
    };
    let precision = currency_precision(currency.as_str());

    let mut output = Map::new();
    output.insert(
        "offerId".to_string(),
        format.id(raw.get("offerId").unwrap_or(&Value::Null)),
    );
    output.insert(
        "region".to_string(),
        raw.get("region").cloned().unwrap_or(Value::Null),
    );
    output.insert("currencyCode".to_string(), currency.clone());
    output.insert(
        "precision".to_string(),
        Value::Number(Number::from(precision)),
    );

    for &field in PRICE_AMOUNT_FIELDS {
        if let Some(val) = nested
            .and_then(|fields| fields.get(field))
            .or_else(|| raw.get(field))
        {
            output.insert(field.to_string(), integer_minor_unit(Some(val)));
        }
    }

    for (key, value) in raw {
        if key == "price" || key == "_id" || key == "__v" {
            continue;
        }
        if PRICE_AMOUNT_FIELDS.contains(&key.as_str()) || output.contains_key(key) {
            continue;
        }
        output.insert(key.clone(), serialize_value_depth(value, 0, format));
    }

    if let Some(nested_map) = nested {
        let mut nested_out = Map::new();
        for (key, value) in nested_map {
            if PRICE_AMOUNT_FIELDS.contains(&key.as_str()) {
                nested_out.insert(key.clone(), integer_minor_unit(Some(value)));
            } else {
                nested_out.insert(key.clone(), serialize_value_depth(value, 0, format));
            }
        }
        nested_out.insert("currencyCode".to_string(), currency.clone());
        nested_out.insert(
            "precision".to_string(),
            Value::Number(Number::from(precision)),
        );
        output.insert("price".to_string(), Value::Object(nested_out));
    }

    output.insert(
        "updatedAt".to_string(),
        format.date(raw.get("updatedAt").unwrap_or(&Value::Null)),
    );
    Value::Object(output)
}

fn price_currency(raw: &Value) -> &Value {
    raw["price"]
        .get("currencyCode")
        .filter(|code| !code.is_null())
        .unwrap_or(&raw["currencyCode"])
}

fn invalid_price_currency(currency: &Value) -> bool {
    match currency {
        Value::Null | Value::String(_) | Value::Bool(false) => false,
        Value::Number(n) => n.as_f64() != Some(0.),
        _ => true,
    }
}

/// A truthy non-string currency makes Node's currencyPrecision throw before the price is returned.
pub fn checked_price(raw: &Value) -> Option<Value> {
    (!invalid_price_currency(price_currency(raw))).then(|| serialize_price(raw))
}

/// Serializes a catalog item document preserving all documented fields.
pub fn serialize_item(raw_value: &Value) -> Value {
    let raw = raw_value.as_object();
    let mut output = Map::new();

    for &field in ITEM_FIELDS {
        let value = raw.and_then(|m| m.get(field)).unwrap_or(&Value::Null);
        let serialized = match field {
            "creationDate" | "lastModifiedDate" | "releaseDate" => date_value(value),
            "_id" | "id" => string_id(value),
            _ => serialize_value(value),
        };
        output.insert(field.to_string(), serialized);
    }

    output.insert(
        "customAttributes".to_string(),
        custom_attributes_value(
            raw.and_then(|m| m.get("customAttributes")),
            JsonFormat::Extended,
        ),
    );
    Value::Object(output)
}

/// Serializes a seller document.
pub fn serialize_seller(raw_value: &Value) -> Value {
    if raw_value.is_null() {
        return Value::Null;
    }
    let Some(raw) = raw_value.as_object() else {
        return Value::Null;
    };
    let mut output = Map::new();
    output.insert(
        "id".to_string(),
        string_id(raw.get("id").unwrap_or(&Value::Null)),
    );
    output.insert(
        "name".to_string(),
        raw.get("name").cloned().unwrap_or(Value::Null),
    );
    output.insert(
        "slug".to_string(),
        raw.get("slug").cloned().unwrap_or(Value::Null),
    );
    output.insert(
        "externalId".to_string(),
        raw.get("externalId").cloned().unwrap_or(Value::Null),
    );
    Value::Object(output)
}

/// Extracts top-level localization metadata for response `meta`.
pub fn localization_meta(offer: Option<&Value>) -> Value {
    let Some(raw) = offer.and_then(Value::as_object) else {
        return Value::Object(Map::new());
    };
    let mut output = Map::new();
    output.insert(
        "locale".to_string(),
        raw.get("locale")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| Value::String("en-US".to_string())),
    );
    output.insert(
        "localeStatus".to_string(),
        raw.get("localeStatus")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| Value::String("canonical".to_string())),
    );
    if let Some(canon) = raw
        .get("canonicalLocale")
        .filter(|v| !v.is_null() && **v != Value::String(String::new()))
    {
        output.insert("canonicalLocale".to_string(), canon.clone());
    }
    if let Some(loc) = raw
        .get("localization")
        .filter(|v| !v.is_null() && **v != Value::Bool(false))
    {
        output.insert("localization".to_string(), serialize_value(loc));
    }
    Value::Object(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bson::{doc, oid::ObjectId};
    use serde_json::json;

    #[test]
    fn historical_attribute_keys_and_nested_currency_validation() {
        let malformed = json!([{"key":["legacy", {"toString":false}],"value":"archived"}]);
        assert_eq!(checked_attribute_map(&malformed), None);
        assert_eq!(attributes_to_object(&malformed), malformed);
        for (top, expected) in [(json!("JPY"), json!("JPY")), (json!(3), Value::Null)] {
            let raw = json!({"currencyCode":top,"price":{"currencyCode":5,"discountPrice":9.5}});
            assert!(checked_price(&raw).is_none());
            assert!(serialize_indexed_price(&raw).is_none());
            let price = serialize_price(&raw);
            assert_eq!(price["currencyCode"], expected);
            assert_eq!(price["price"]["discountPrice"], 10);
        }
        assert_eq!(
            bson_iso_or_null(&Bson::Symbol("2026-07-18".into())).as_deref(),
            Some("2026-07-18T00:00:00.000Z")
        );
    }

    #[test]
    fn indexed_offer_keeps_json_types_while_its_regional_price_uses_stored_types() {
        let id = json!({"$oid":"5f0000000000000000000001"});
        let source = json!({
            "id":id, "seller":{"extra":id},
            "customAttributes":[null, {"id":id}],
            "localization":{"providerMetadata":id}
        });
        let price = json!({"offerId":id});
        let indexed = serialize_json_offer(&source, Some(&price), true);
        assert_eq!(indexed["id"], "[object Object]");
        assert_eq!(indexed["seller"]["extra"], id);
        assert_eq!(indexed["customAttributes"][1]["id"], "[object Object]");
        assert_eq!(
            indexed["localization"]["localization"]["providerMetadata"],
            id
        );
        assert_eq!(indexed["price"]["offerId"], "5f0000000000000000000001");

        let stored = serialize_offer(&source, Some(&price), true);
        assert_eq!(stored["id"], "5f0000000000000000000001");
        assert_eq!(stored["seller"]["extra"], "5f0000000000000000000001");
    }

    #[test]
    fn node_objects_propagate_truncated_writer_errors() {
        for object in [json!({"a":[true]}), json!({"1":true})] {
            for capacity in [0, 1, 32] {
                let mut buffer = [0_u8; 32];
                let writer = &mut buffer[..capacity];
                let mut serializer =
                    serde_json::Serializer::with_formatter(writer, NodeNumberFormat);
                let result = NodeValue(&object).serialize(&mut serializer);
                if capacity == 32 {
                    result.unwrap();
                    let expected = node_json(&object);
                    assert_eq!(&buffer[..expected.len()], expected.as_bytes());
                } else {
                    assert!(result.unwrap_err().is_io());
                }
            }
        }
    }

    #[test]
    fn test_currency_precision() {
        assert_eq!(currency_precision(None), 2);
        assert_eq!(currency_precision(Some("USD")), 2);
        assert_eq!(currency_precision(Some("jpy")), 0);
        assert_eq!(currency_precision(Some("KRW")), 0);
        assert_eq!(currency_precision(Some("kwd")), 3);
    }

    #[test]
    fn test_dates_and_ids_and_serialize_value() {
        assert_eq!(iso_or_null(&Value::Null), None);
        assert_eq!(iso_or_null(&json!("")), None);
        assert_eq!(iso_or_null(&json!(123)), None);
        assert_eq!(
            iso_or_null(&json!("2025-01-02T03:04:05Z")),
            Some("2025-01-02T03:04:05.000Z".into())
        );
        assert_eq!(
            iso_or_null(&json!("2025-01-02")),
            Some("2025-01-02T00:00:00.000Z".into())
        );
        for (input, expected) in [
            ("2023", "2023-01-01T00:00:00.000Z"),
            ("2023-09", "2023-09-01T00:00:00.000Z"),
            ("2023-99", "2023-99"),
            ("long", "long"),
        ] {
            assert_eq!(iso_or_null(&json!(input)).as_deref(), Some(expected));
        }
        assert_eq!(iso_or_null(&json!("not-a-date")), Some("not-a-date".into()));
        assert_eq!(
            iso_or_null(&json!({"$date": 1_700_000_000_000_i64})),
            Some("2023-11-14T22:13:20.000Z".into())
        );
        assert_eq!(
            iso_or_null(&json!({"$date": {"$numberLong": "1700000000000"}})),
            Some("2023-11-14T22:13:20.000Z".into())
        );
        assert_eq!(
            iso_or_null(&json!({"$date": "2025-01-02T00:00:00Z"})),
            Some("2025-01-02T00:00:00.000Z".into())
        );
        assert_eq!(iso_or_null(&json!({"other": 1})), None);

        assert_eq!(string_id(&Value::Null), Value::Null);
        assert_eq!(string_id(&json!(123)), json!("123"));
        assert_eq!(string_id(&json!(true)), json!("true"));
        assert_eq!(string_id(&json!({"$oid": "abc"})), json!("abc"));
        assert_eq!(string_id(&json!({"part": 1})), json!("[object Object]"));
        assert_eq!(string_id(&json!([1, null, "x"])), json!("1,,x"));

        assert_eq!(date_value(&Value::Null), Value::Null);
        assert_eq!(date_value(&json!(42)), json!(42));

        let val = json!({
            "__v": 0,
            "_id": {"$oid": "507f1f77bcf86cd799439011"},
            "createdAt": {"$date": "2025-02-01T00:00:00Z"},
            "nested": [{"$oid": "abc"}, {"$date": "2025-02-01T00:00:00Z"}]
        });
        let ser = serialize_value(&val);
        assert!(ser.get("__v").is_none());
        assert_eq!(ser["_id"], "507f1f77bcf86cd799439011");
        assert_eq!(ser["createdAt"], "2025-02-01T00:00:00.000Z");
        assert_eq!(ser["nested"][0], "abc");
        assert_eq!(ser["nested"][1], "2025-02-01T00:00:00.000Z");

        // Depth > 12 returns null
        let mut deep = json!("leaf");
        for _ in 0..15 {
            deep = json!({"x": deep});
        }
        let ser_deep = serialize_value(&deep);
        assert!(ser_deep.is_object());
    }

    #[test]
    fn test_bson_to_serialized_json() {
        let oid = ObjectId::parse_str("507f1f77bcf86cd799439011").unwrap();
        let dt = bson::DateTime::from_millis(1_700_000_000_000);
        let d = doc! {
            "_id": oid,
            "createdAt": dt,
            "count": 3_i32,
            "big": 9_i64,
            "ratio": 1.5_f64,
            "nan": f64::NAN,
            "ok": true,
            "tags": ["a", "b"],
            "ignored": Bson::Undefined
        };
        let json = bson_to_serialized_json(&Bson::Document(d));
        assert_eq!(json["_id"], "507f1f77bcf86cd799439011");
        assert_eq!(json["createdAt"], "2023-11-14T22:13:20.000Z");
        assert_eq!(json["count"], 3);
        assert_eq!(json["big"], 9);
        assert_eq!(json["ratio"], 1.5);
        assert_eq!(json["nan"], Value::Null);
        assert_eq!(json["ok"], true);
        assert_eq!(json["tags"], json!(["a", "b"]));
        assert_eq!(json["ignored"], Value::Null);
    }

    #[test]
    fn test_serialize_offer_price_item_seller_and_localization() {
        let offer = json!({
            "id": "offer-1",
            "title": "Test Game",
            "effectiveDate": "2025-01-01T00:00:00Z",
            "expiryDate": "2026-06-01T12:00:00Z",
            "customAttributes": [
                {"key": "developerName", "value": "Studio"},
                {"key": "", "value": "ignored"},
                "not-an-object"
            ],
            "locale": "es-ES",
            "localeStatus": "localized",
            "canonicalLocale": "en-US",
            "localization": {"source": "egs", "fetchedAt": "2025-01-01T00:00:00Z"}
        });
        let price = json!({
            "offerId": "offer-1",
            "region": "EURO",
            "price": {
                "currencyCode": "EUR",
                "discountPrice": "1999",
                "originalPrice": 2999.4,
                "label": "sale"
            },
            "updatedAt": "2025-01-02T00:00:00Z",
            "extra": true
        });
        let serialized = serialize_offer(&offer, Some(&price), true);
        assert_eq!(serialized["id"], "offer-1");
        assert_eq!(serialized["_id"], Value::Null);
        assert_eq!(serialized["expiryDate"], "2026-06-01T12:00:00.000Z");
        assert_eq!(
            serialized["customAttributes"]["developerName"]["type"],
            "STRING"
        );
        assert_eq!(serialized["price"]["precision"], 2);
        assert_eq!(serialized["price"]["discountPrice"], 1999);
        assert_eq!(serialized["price"]["originalPrice"], 2999);
        assert_eq!(serialized["price"]["price"]["currencyCode"], "EUR");
        assert_eq!(serialized["price"]["extra"], true);
        assert_eq!(serialized["locale"], "es-ES");
        assert_eq!(
            serialized["localization"]["localization"]["fetchedAt"],
            "2025-01-01T00:00:00.000Z"
        );

        let no_loc = serialize_offer(&offer, None, false);
        assert_eq!(no_loc["price"], Value::Null);
        assert!(no_loc.get("locale").is_none());

        let bare_offer = serialize_offer(&json!({}), None, true);
        assert_eq!(bare_offer["customAttributes"], Value::Null);
        assert_eq!(bare_offer["expiryDate"], Value::Null);
        assert!(bare_offer.get("localization").is_none());
        assert!(bare_offer.get("canonicalLocale").is_none());

        let loc_no_canon = serialize_offer(
            &json!({
                "customAttributes": [{"key": "k", "type": "", "value": "v"}],
                "localization": {"source": "egs"}
            }),
            None,
            true,
        );
        assert_eq!(loc_no_canon["customAttributes"]["k"]["type"], "STRING");
        assert!(
            loc_no_canon["localization"]
                .get("canonicalLocale")
                .is_none()
        );

        let flat_price = serialize_price(&json!({
            "offerId": "o1",
            "currencyCode": "USD",
            "discountPrice": 500
        }));
        assert_eq!(flat_price["discountPrice"], 500);
        assert!(flat_price.get("price").is_none());

        let empty_meta = localization_meta(Some(&json!({})));
        assert_eq!(empty_meta["locale"], "en-US");
        assert_eq!(empty_meta["localeStatus"], "canonical");
        assert!(empty_meta.get("canonicalLocale").is_none());
        assert!(empty_meta.get("localization").is_none());

        assert_eq!(serialize_price(&Value::Null), Value::Null);
        assert_eq!(serialize_price(&json!("bad")), Value::Null);
        assert_eq!(
            integer_minor_unit(Some(&json!(true))),
            Value::Number(Number::from(1))
        );
        assert_eq!(
            integer_minor_unit(Some(&json!(false))),
            Value::Number(Number::from(0))
        );
        assert_eq!(integer_minor_unit(Some(&json!("nan"))), Value::Null);
        assert_eq!(integer_minor_unit(Some(&json!([]))), json!(0));
        assert_eq!(integer_minor_unit(None), Value::Null);
        assert_eq!(integer_minor_unit(Some(&Value::Null)), Value::Null);

        let item = serialize_item(&json!({
            "id": "item-1",
            "creationDate": "2024-01-01T00:00:00Z",
            "customAttributes": {"a": {"type": "STRING", "value": "1"}}
        }));
        assert_eq!(item["id"], "item-1");
        assert_eq!(item["customAttributes"]["a"]["value"], "1");
        assert_eq!(attributes_to_object(&json!("scalar")), json!("scalar"));

        assert_eq!(serialize_seller(&Value::Null), Value::Null);
        assert_eq!(serialize_seller(&json!(1)), Value::Null);
        let seller = serialize_seller(&json!({"id": "s1", "name": "Epic"}));
        assert_eq!(seller["id"], "s1");
        assert_eq!(seller["slug"], Value::Null);

        assert_eq!(localization_meta(None), json!({}));
        let meta = localization_meta(Some(&offer));
        assert_eq!(meta["locale"], "es-ES");
        assert_eq!(meta["canonicalLocale"], "en-US");
    }
}
