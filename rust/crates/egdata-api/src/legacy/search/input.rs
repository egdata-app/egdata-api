//! Build the GET filter object and reproduce the public Zod issue array for POST and GET.
use super::super::common::{Error, Result};
use crate::v1::system::js_string_number;
use axum::http::{StatusCode, Uri};
use egdata_core::v1::{query::SearchV2Input, trim_js_whitespace};
use serde_json::{Value, json, value::RawValue};
use std::collections::HashMap;

const LISTS: [&str; 4] = ["tags", "categories", "customAttributes", "technologies"];
const FLAGS: [&str; 6] = [
    "isCodeRedemptionOnly",
    "excludeBlockchain",
    "onSale",
    "pastGiveaways",
    "isLowestPrice",
    "isLowestPriceEver",
];
const SORTS: [&str; 14] = [
    "releaseDate",
    "lastModifiedDate",
    "effectiveDate",
    "creationDate",
    "viewableDate",
    "pcReleaseDate",
    "upcoming",
    "priceAsc",
    "priceDesc",
    "price",
    "discount",
    "discountPercent",
    "priceUpdatedAt",
    "giveawayDate",
];

#[derive(Default)]
pub(super) struct SearchParams {
    raw: Value,
    // JSON values cannot represent JS NaN or Infinity. Keep the original
    // numeric type private to the validator so literal strings stay strings.
    exceptional: HashMap<String, &'static str>,
}

impl SearchParams {
    fn number(&mut self, field: &str, n: f64) -> Value {
        if n.is_finite() {
            return json!(n);
        }
        self.exceptional
            .insert(field.into(), if n.is_nan() { "NaN" } else { "Infinity" });
        Value::Null
    }
}

// Standard JSON decoding handles ordinary requests. On numeric overflow,
// RawValue still validates the JSON syntax and allows the schema to report a
// non-finite number at the correct field instead of treating the body as corrupt.
pub(super) fn post_params(body: &[u8]) -> SearchParams {
    let body = body.strip_prefix(b"\xef\xbb\xbf").unwrap_or(body);
    let text = String::from_utf8_lossy(body);
    let mut input = SearchParams::default();
    if let Ok(raw) = serde_json::from_str(&text) {
        input.raw = raw;
    } else if let Ok(raw) = serde_json::from_str::<&RawValue>(&text) {
        input.raw = decode_raw(raw, &[], &mut input).unwrap_or(Value::Null);
    }
    input
}

fn decode_raw(
    raw: &RawValue,
    path: &[&str],
    input: &mut SearchParams,
) -> serde_json::Result<Value> {
    if let Ok(value) = serde_json::from_str(raw.get()) {
        return Ok(value);
    }
    // The schema inspects the top-level fields, list entries and the two
    // price bounds. Anything deeper is either unknown or already mistyped.
    match raw.get().as_bytes().first() {
        Some(b'{') if path.len() < 2 => {
            let mut result = json!({});
            for (key, child) in serde_json::from_str::<HashMap<String, &RawValue>>(raw.get())? {
                let mut child_path = path.to_vec();
                child_path.push(&key);
                result[key.as_str()] = decode_raw(child, &child_path, input)?;
            }
            Ok(result)
        }
        Some(b'{') => Ok(json!({})),
        Some(b'[') if path.len() < 2 => {
            let entries = serde_json::from_str::<Vec<&RawValue>>(raw.get())?;
            let mut result = Vec::with_capacity(entries.len());
            for entry in entries {
                let mut element_path = path.to_vec();
                element_path.push("[]");
                result.push(decode_raw(entry, &element_path, input)?);
            }
            Ok(Value::Array(result))
        }
        Some(b'[') => Ok(json!([])),
        // A syntactically valid scalar rejected by Value is an overflowing
        // number. Only numeric schema fields distinguish it from finite numbers.
        _ if matches!(path, ["page" | "limit"] | ["price", "min" | "max"]) => {
            Ok(input.number(path.last().unwrap(), f64::INFINITY))
        }
        _ => Ok(json!(0)),
    }
}

pub(super) fn get_params(uri: &Uri) -> SearchParams {
    let mut input = SearchParams::default();
    let mut q = HashMap::<String, Vec<String>>::new();
    for (k, v) in url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes()) {
        q.entry(k.into_owned()).or_default().push(v.into_owned());
    }
    let mut obj = json!({});
    for k in [
        "title",
        "offerType",
        "seller",
        "developerDisplayName",
        "publisherDisplayName",
        "refundType",
        "sortBy",
        "sortDir",
        "facets",
    ] {
        if let Some(v) = q.get(k) {
            obj[k] = json!(v[0]);
        }
    }
    for k in LISTS {
        if let Some(v) = q.get(&format!("{k}[]")) {
            obj[k] = json!(v);
        } else if let Some(v) = q.get(k) {
            let items: Vec<_> = v[0]
                .split(',')
                .map(trim_js_whitespace)
                .filter(|v| !v.is_empty())
                .collect();
            if !items.is_empty() {
                obj[k] = json!(items);
            }
        }
    }
    for k in FLAGS {
        if let Some(v) = q.get(k) {
            obj[k] = match trim_js_whitespace(&v[0]).to_ascii_lowercase().as_str() {
                "true" | "1" => json!(true),
                "false" | "0" => json!(false),
                s => json!(s),
            };
        }
    }
    for k in ["limit", "page", "priceMin", "priceMax"] {
        if let Some(v) = q
            .get(k)
            .map(|v| trim_js_whitespace(&v[0]))
            .filter(|v| !v.is_empty())
        {
            let num = js_string_number(v);
            match k {
                "priceMin" => obj["price"]["min"] = input.number("min", num),
                "priceMax" => obj["price"]["max"] = input.number("max", num),
                _ => obj[k] = input.number(k, num),
            }
        }
    }
    input.raw = obj;
    input
}
fn type_issue(path: Value, want: &str, value: &Value) -> Value {
    let actual = match value {
        Value::Array(_) => "array",
        Value::Object(_) => "object",
        Value::Number(_) => "number",
        Value::Bool(_) => "boolean",
        Value::Null => "null",
        _ => "string",
    };
    json!({"expected":want,"code":"invalid_type","path":path,"message":format!("Invalid input: expected {want}, received {actual}")})
}
fn number(
    value: &Value,
    path: &[&str],
    exceptional: &HashMap<String, &'static str>,
    integer: bool,
) -> Option<Value> {
    if let Some(received) = path.last().and_then(|key| exceptional.get(*key)) {
        let actual = if *received == "NaN" { "NaN" } else { "number" };
        return Some(
            json!({"expected":"number","code":"invalid_type","received":received,"path":path,"message":format!("Invalid input: expected number, received {actual}")}),
        );
    }
    let Some(n) = value.as_f64() else {
        return Some(type_issue(json!(path), "number", value));
    };
    if integer && n.fract() != 0. {
        return Some(
            json!({"expected":"int","format":"safeint","code":"invalid_type","path":path,"message":"Invalid input: expected int, received number"}),
        );
    }
    if integer && n.abs() > 9007199254740991. {
        let big = n > 0.;
        let mut issue = json!({"code":if big{"too_big"}else{"too_small"}});
        let bound = if big {
            9007199254740991_i64
        } else {
            -9007199254740991
        };
        issue[if big { "maximum" } else { "minimum" }] = json!(bound);
        issue["note"] = json!("Integers must be within the safe integer range.");
        issue["origin"] = json!("int");
        issue["inclusive"] = json!(true);
        issue["path"] = json!(path);
        issue["message"] = json!(format!(
            "Too {}: expected int to be {}{}",
            if big { "big" } else { "small" },
            if big { "<=" } else { ">=" },
            bound
        ));
        return Some(issue);
    }
    None
}
pub(super) fn parsed(input: SearchParams) -> Result<SearchV2Input> {
    let SearchParams {
        mut raw,
        exceptional,
    } = input;
    if !raw.is_object() {
        return Err(Error::Json(
            StatusCode::BAD_REQUEST,
            json!({"message":"Invalid body"}),
        ));
    }
    let mut issues = Vec::new();
    for k in [
        "title",
        "offerType",
        "tags",
        "categories",
        "customAttributes",
        "technologies",
        "seller",
        "developerDisplayName",
        "publisherDisplayName",
        "refundType",
        "isCodeRedemptionOnly",
        "excludeBlockchain",
        "onSale",
        "pastGiveaways",
        "isLowestPrice",
        "isLowestPriceEver",
        "sortBy",
        "sortDir",
        "limit",
        "page",
        "price",
    ] {
        let Some(v) = raw.get_mut(k) else { continue };
        if LISTS.contains(&k) {
            let before = issues.len();
            if let Some(items) = v.as_array_mut() {
                for (i, item) in items.iter_mut().enumerate() {
                    if let Some(s) = item.as_str() {
                        let trimmed = trim_js_whitespace(s);
                        if trimmed.is_empty() {
                            issues.push(json!({"origin":"string","code":"too_small","minimum":1,"inclusive":true,"path":[k,i],"message":"Too small: expected string to have >=1 characters"}));
                        }
                        *item = json!(trimmed);
                    } else {
                        issues.push(type_issue(json!([k, i]), "string", item));
                    }
                }
                items.sort_by(|a, b| {
                    a.as_str()
                        .unwrap_or("")
                        .encode_utf16()
                        .cmp(b.as_str().unwrap_or("").encode_utf16())
                });
                items.dedup();
            } else {
                issues.push(type_issue(json!([k]), "array", v));
            }
            if k == "technologies" && issues.len() > before {
                return Err(Error::Json(
                    StatusCode::BAD_REQUEST,
                    json!({"message":"Invalid technologies. Provide an array of non-empty technology names."}),
                ));
            }
        } else if FLAGS.contains(&k) {
            if !v.is_boolean() {
                issues.push(type_issue(json!([k]), "boolean", v));
            }
        } else if matches!(k, "sortBy" | "sortDir") {
            let options: &[&str] = if k == "sortBy" {
                &SORTS
            } else {
                &["asc", "desc"]
            };
            if !v.as_str().is_some_and(|s| options.contains(&s)) {
                let names = options
                    .iter()
                    .map(|s| format!("{s:?}"))
                    .collect::<Vec<_>>()
                    .join("|");
                issues.push(json!({"code":"invalid_value","values":options,"path":[k],"message":format!("Invalid option: expected one of {names}")}));
            }
        } else if matches!(k, "page" | "limit") {
            if let Some(issue) = number(v, &[k], &exceptional, true) {
                issues.push(issue)
            } else {
                let n = v.as_f64().unwrap() as i64;
                *v = json!(if k == "page" {
                    n.max(1)
                } else {
                    n.clamp(1, 100)
                });
            }
        } else if k == "price" {
            if v.is_object() {
                for key in ["min", "max"] {
                    if let Some(value) = v.get(key)
                        && let Some(issue) = number(value, &[k, key], &exceptional, false)
                    {
                        issues.push(issue)
                    }
                }
            } else {
                issues.push(type_issue(json!([k]), "object", v));
            }
        } else if let Some(s) = v.as_str() {
            *v = json!(trim_js_whitespace(s));
        } else {
            issues.push(type_issue(json!([k]), "string", v));
        }
    }
    if !issues.is_empty() {
        return Err(Error::NoStoreJson(
            StatusCode::BAD_REQUEST,
            json!({"message":"Invalid search filters","issues":issues}),
        ));
    }
    if !matches!(raw["facets"].as_str(), Some("none" | "minimal")) {
        raw["facets"] = json!("full");
    }
    serde_json::from_value(raw).map_err(Into::into)
}
