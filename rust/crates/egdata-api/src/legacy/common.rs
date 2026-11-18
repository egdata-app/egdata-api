//! Shared response and data-access helpers for unversioned endpoints.
use super::{internal_error, json_response};
use crate::state::AppState;
use axum::{
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use bson::{Bson, Document};
use egdata_core::{error::CoreError, ports::MongoFindOptions, v1::serialization::node_json};
use egdata_infra::bson_json::bson_doc_to_js_json;
use serde_json::{Value, json};
// Mongo's Node driver receives JavaScript values after JSON.parse. It encodes
// numbers as int32 or double and stores ordinary objects literally.
pub(super) fn node_bson(value: &Value) -> Bson {
    match value {
        Value::Null => Bson::Null,
        Value::Bool(v) => Bson::Boolean(*v),
        Value::String(v) => Bson::String(v.clone()),
        Value::Number(n) => node_bson_number(n.as_f64().unwrap()),
        Value::Array(items) => Bson::Array(items.iter().map(node_bson).collect()),
        Value::Object(fields) => Bson::Document(
            fields
                .iter()
                .map(|(key, value)| (key.clone(), node_bson(value)))
                .collect(),
        ),
    }
}

pub(super) fn node_bson_number(number: f64) -> Bson {
    if number.fract() == 0.
        && (i32::MIN as f64..=i32::MAX as f64).contains(&number)
        && number.to_bits() != (-0.0_f64).to_bits()
    {
        Bson::Int32(number as i32)
    } else {
        Bson::Double(number)
    }
}

/// Mirrors object spread for cached and historical JSON values.
pub(crate) fn spread(value: &Value) -> Value {
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

pub(super) enum Error {
    Internal,
    Json(StatusCode, Value),
    NoStoreJson(StatusCode, Value),
}
pub(super) type Result<T> = std::result::Result<T, Error>;
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        match self {
            Self::Internal => internal_error(),
            Self::Json(status, body) => json_response(status, &body),
            Self::NoStoreJson(status, body) => {
                cache_header(json_response(status, &body), "no-store")
            }
        }
    }
}
impl From<CoreError> for Error {
    fn from(_: CoreError) -> Self {
        Self::Internal
    }
}
impl From<serde_json::Error> for Error {
    fn from(_: serde_json::Error) -> Self {
        Self::Internal
    }
}
impl From<egdata_core::v1::ProblemError> for Error {
    fn from(_: egdata_core::v1::ProblemError) -> Self {
        Self::Internal
    }
}
pub(super) fn ok(value: &Value) -> Response {
    json_response(StatusCode::OK, value)
}
pub(super) const ONE_MINUTE: &str = "public, max-age=60";
pub(super) const ONE_HOUR: &str = "public, max-age=3600";
pub(super) fn cache_header(mut response: Response, policy: &'static str) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, policy.parse().unwrap());
    response
}
pub(super) async fn cached(s: &AppState, key: &str) -> Result<Option<Value>> {
    s.cache
        .get(key)
        .await?
        .filter(|v| !v.is_empty())
        .map(|v| serde_json::from_str(&v))
        .transpose()
        .map_err(Into::into)
}
pub(super) async fn store(s: &AppState, key: &str, value: &Value, ttl: u64) -> Result<()> {
    Ok(s.cache.set(key, &node_json(value), ttl).await?)
}
pub(super) async fn many(
    s: &AppState,
    collection: &str,
    filter: Document,
    options: MongoFindOptions,
) -> Result<Vec<Value>> {
    Ok(s.mongo
        .find_many(collection, filter, options)
        .await?
        .iter()
        .map(bson_doc_to_js_json)
        .collect())
}
pub(super) async fn one(s: &AppState, collection: &str, filter: Document) -> Result<Option<Value>> {
    Ok(s.mongo
        .find_one(collection, filter, None)
        .await?
        .as_ref()
        .map(bson_doc_to_js_json))
}
pub(super) fn not_found(message: &str) -> Error {
    Error::Json(StatusCode::NOT_FOUND, json!({"message":message}))
}
