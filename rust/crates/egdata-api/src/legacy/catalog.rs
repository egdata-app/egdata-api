//! The legacy catalog returns Mongo documents directly with per-route cache policies.
use super::{Routes, common::*, system::selected_region};
use crate::state::AppState;
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, Uri},
    response::Response,
};
use bson::{Bson, Document, doc};
use egdata_core::{
    localization::{get_localized_cache_ttl_seconds, locale_cache_segment, parse_locale},
    ports::MongoFindOptions,
    v1::serialization::node_json,
};
use egdata_infra::bson_json::{bson_doc_to_js_json, bson_to_js_json};
use serde_json::{Value, json};
use std::collections::HashMap;
mod franchise;
mod free_games;
pub(super) mod items;
mod sandbox;
mod sellers;

pub(super) fn routes() -> Routes {
    Routes::new("")
        .get("/assets/{id}", asset)
        .get("/items", items::list)
        .post("/items/bulk", items::bulk)
        .post("/items/bulk/offers", items::bulk_offers)
        .get("/items/{id}", items::detail)
        .get("/items/{id}/assets", items::assets)
        .get("/items/{id}/builds", items::builds)
        .get("/items/{id}/offer", items::offer)
        .get("/items/{id}/changelog", items::changelog)
        .put("/items/regen/{id}", items::regen)
        .post("/items/bulk-regen", items::bulk_regen)
        .get("/sellers", sellers::list)
        .get("/sellers/{id}", sellers::offers)
        .get("/sellers/{id}/cover", sellers::cover)
        .get("/sellers/{id}/stats", sellers::stats)
        .get("/franchises/{slug}", franchise::detail)
        .merge(sandbox::routes())
        .merge(free_games::routes())
}

pub(super) fn query(uri: &Uri) -> HashMap<String, String> {
    let mut result = HashMap::new();
    for (k, v) in url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes()) {
        result
            .entry(k.into_owned())
            .or_insert_with(|| v.into_owned());
    }
    result
}
pub(super) fn locale(q: &HashMap<String, String>) -> Result<String> {
    parse_locale(q.get("locale").map(String::as_str))
        .map_err(|e| Error::Json(StatusCode::BAD_REQUEST, json!({"message":e.to_string()})))
}
pub(super) fn region(uri: &Uri, headers: &HeaderMap) -> Result<&'static str> {
    selected_region(uri, headers)
        .map(|(code, _)| code)
        .ok_or_else(|| not_found("Country not found"))
}
// Number.parseInt consumes a signed decimal prefix and yields NaN when empty.
pub(super) fn integer(value: Option<&String>, default: i64) -> Option<i64> {
    let Some(value) = value.filter(|v| !v.is_empty()) else {
        return Some(default);
    };
    let value = value.trim_start();
    let unsigned = value.strip_prefix(['+', '-']).unwrap_or(value);
    let n = unsigned.bytes().take_while(u8::is_ascii_digit).count();
    unsigned[..n].parse::<i64>().ok().and_then(|n| {
        if value.starts_with('-') {
            n.checked_neg()
        } else {
            Some(n)
        }
    })
}
pub(super) struct Page {
    pub(super) limit: Option<i64>,
    pub(super) page: Option<i64>,
}
impl Page {
    pub(super) fn new(q: &HashMap<String, String>, default: i64, max: i64) -> Self {
        Self {
            limit: integer(q.get("limit"), default).map(|n| n.min(max)),
            page: integer(q.get("page"), 1).map(|n| n.max(1)),
        }
    }
    pub(super) fn skip(&self, zero_limit_width: i64) -> Result<u64> {
        let width = self.limit.ok_or(Error::Internal)?;
        self.page
            .ok_or(Error::Internal)?
            .saturating_sub(1)
            .checked_mul(if width == 0 { zero_limit_width } else { width })
            .and_then(|v| v.try_into().ok())
            .ok_or(Error::Internal)
    }
    pub(super) fn key(&self) -> String {
        let number = |v: Option<i64>| v.map_or_else(|| "NaN".into(), |v| v.to_string());
        format!("{}:{}", number(self.page), number(self.limit))
    }
}
async fn asset(State(s): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    Ok(ok(&one(&s, "assets", doc! {"artifactId":{"$eq":id}})
        .await?
        .ok_or_else(|| {
            Error::Json(StatusCode::NOT_FOUND, json!({"error":"Asset not found"}))
        })?))
}

pub(super) fn checked_ordered_offer(offer: &Value) -> Result<Value> {
    let mut row = serde_json::Map::new();
    for key in egdata_core::attributes::ORDERED_OFFER_KEYS {
        if let Some(value) = offer.get(key) {
            if key != "customAttributes" {
                row.insert(key.into(), value.clone());
            } else if crate::v1::system::js_truthy(value) {
                row.insert(key.into(), crate::v1::offers::checked_attributes(value)?);
            }
        }
    }
    Ok(Value::Object(row))
}

pub(super) fn ordered_offer(offer: &Value) -> serde_json::Map<String, Value> {
    let mut row = serde_json::Map::new();
    for key in egdata_core::attributes::ORDERED_OFFER_KEYS {
        if let Some(v) = offer.get(key) {
            if key == "customAttributes" {
                if !v.is_null() {
                    row.insert(key.into(), items::attributes(v));
                }
            } else {
                row.insert(key.into(), v.clone());
            }
        }
    }
    row
}

// Undefined and null are distinct primitive Map keys. Object-valued keys use
// reference equality in Node and cannot match across independent driver reads.
#[derive(Debug, PartialEq, Eq, Hash)]
pub(super) enum PrimitiveId {
    Undefined,
    Null,
    Text(String),
    Boolean(bool),
    Number(String),
}

pub(super) fn primitive_id(value: Option<&Bson>) -> Option<PrimitiveId> {
    use egdata_core::v1::query::format_js_number;
    match value {
        None | Some(Bson::Undefined) => Some(PrimitiveId::Undefined),
        Some(Bson::Null) => Some(PrimitiveId::Null),
        Some(Bson::Boolean(b)) => Some(PrimitiveId::Boolean(*b)),
        Some(Bson::String(s)) => Some(PrimitiveId::Text(s.clone())),
        Some(Bson::Double(n)) => Some(PrimitiveId::Number(format_js_number(*n))),
        Some(v @ (Bson::Int32(_) | Bson::Int64(_))) => bson_to_js_json(v)
            .as_f64()
            .map(|n| PrimitiveId::Number(format_js_number(n))),
        _ => None,
    }
}

pub(super) fn field_values(rows: &[bson::Document], field: &str) -> Vec<Bson> {
    rows.iter()
        .map(|doc| doc.get(field).cloned().unwrap_or(Bson::Null))
        .collect()
}

pub(super) fn price_map(prices: &[Document]) -> HashMap<PrimitiveId, Value> {
    prices
        .iter()
        .filter_map(|p| Some((primitive_id(p.get("offerId"))?, bson_doc_to_js_json(p))))
        .collect()
}

pub(super) async fn offer_rows(
    state: &AppState,
    offers: &[Document],
    locale: &str,
    prices: Option<&HashMap<PrimitiveId, Value>>,
) -> Result<Vec<Value>> {
    let mut rows = Vec::with_capacity(offers.len());
    for offer in offers {
        let mut row = checked_ordered_offer(&bson_doc_to_js_json(offer))?;
        if let Some(prices) = prices {
            row["price"] = primitive_id(offer.get("id"))
                .and_then(|id| prices.get(&id))
                .cloned()
                .unwrap_or(Value::Null);
        }
        rows.push((can_localize(offer), row));
    }
    localize_projected_offers(state, rows, locale, true).await
}

pub(super) fn can_localize(doc: &bson::Document) -> bool {
    doc.get_str("id").is_ok() && doc.get_str("namespace").is_ok()
}

pub(super) async fn localize_projected_offers(
    state: &AppState,
    projected: Vec<(bool, Value)>,
    locale: &str,
    ordered: bool,
) -> Result<Vec<Value>> {
    let mut rows = Vec::with_capacity(projected.len());
    let mut eligible = Vec::new();
    let mut positions = Vec::new();
    for (i, (can_localize, row)) in projected.into_iter().enumerate() {
        // An ObjectId serializes to a string but is not a native translation key.
        if can_localize {
            eligible.push(row);
            positions.push(i);
            rows.push(Value::Null);
        } else {
            rows.push(egdata_core::localization::apply_offer_localization(
                &row, None, locale,
            ));
        }
    }
    let localized = localize_legacy_offers(state, &eligible, locale, ordered).await?;
    for (i, row) in positions.into_iter().zip(localized) {
        rows[i] = row;
    }
    Ok(rows)
}

/// The legacy ordered projection creates JS own properties even for absent Mongo fields.
/// A translation may fill those positions. Expanded documents only localize fields they contain.
pub(super) async fn localize_legacy_offers(
    s: &AppState,
    offers: &[Value],
    locale: &str,
    ordered: bool,
) -> Result<Vec<Value>> {
    use egdata_core::localization::{
        LOCALIZED_OFFER_FIELDS, apply_offer_localization, get_offer_localization_entity_id,
    };
    let docs = crate::v1::system::offer_localization_documents(s, offers, locale).await?;
    let docs: HashMap<_, _> = docs
        .iter()
        .filter_map(|doc| {
            Some((
                doc.get_str("entityId").ok()?,
                (
                    bson_doc_to_js_json(doc),
                    doc.get("sourceUpdatedAt")
                        .is_some_and(crate::v1::offer_metadata::stored_truthy),
                ),
            ))
        })
        .collect();
    let mut result = Vec::with_capacity(offers.len());
    for offer in offers {
        let Some((loc, has_source_date)) =
            get_offer_localization_entity_id(offer).and_then(|id| docs.get(id.as_str()))
        else {
            result.push(apply_offer_localization(offer, None, locale));
            continue;
        };
        let mut row = offer.clone();
        if ordered {
            let mut fields = serde_json::Map::new();
            for key in egdata_core::attributes::ORDERED_OFFER_KEYS {
                let translated = LOCALIZED_OFFER_FIELDS
                    .contains(&key)
                    .then(|| loc["data"].get(key))
                    .flatten();
                if let Some(value) = translated.or_else(|| offer.get(key)) {
                    fields.insert(key.into(), value.clone());
                }
            }
            if let Some(source) = offer.as_object() {
                for (key, value) in source {
                    fields.entry(key).or_insert_with(|| value.clone());
                }
            }
            row = Value::Object(fields);
        } else {
            for &field in LOCALIZED_OFFER_FIELDS {
                if let (Some(existing), Some(translated)) =
                    (row.get_mut(field), loc["data"].get(field))
                {
                    *existing = translated.clone();
                }
            }
        }
        row["locale"] = locale.into();
        row["localeStatus"] = "localized".into();
        row["canonicalLocale"] = "en-US".into();
        let mut provenance = json!({});
        for key in ["source", "fetchedAt", "sourceUpdatedAt"] {
            if let Some(value) = loc.get(key)
                && (key != "sourceUpdatedAt" || *has_source_date)
            {
                provenance[key] = value.clone();
            }
        }
        row["localization"] = provenance;
        result.push(row);
    }
    Ok(result)
}

/// Seller endpoints choose the first regional price. Franchise uses JS Map's last match.
async fn priced_offers(
    s: &AppState,
    offers: &[Value],
    region: &str,
    locale: &str,
    franchise: bool,
) -> Result<Vec<Value>> {
    let ids: Vec<_> = offers.iter().filter_map(|o| o["id"].as_str()).collect();
    let prices = many(
        s,
        "pricev2",
        doc! {"offerId":{"$in":ids},"region":region},
        Default::default(),
    )
    .await?;
    let mut by_id = HashMap::new();
    for price in &prices {
        if let Some(id) = price["offerId"].as_str() {
            if franchise {
                by_id.insert(id, price);
            } else {
                by_id.entry(id).or_insert(price);
            }
        }
    }
    let mut ordered = Vec::new();
    for offer in offers {
        let mut row = ordered_offer(offer);
        if let Some(price) = offer["id"].as_str().and_then(|id| by_id.get(id)) {
            row.insert("price".into(), (*price).clone());
        } else if franchise {
            row.insert("price".into(), Value::Null);
        }
        ordered.push(Value::Object(row));
    }
    localize_legacy_offers(s, &ordered, locale, true).await
}

#[cfg(test)]
#[tokio::test]
async fn legacy_catalog_http_node_oracle() {
    crate::v1::mongo_read_oracle::replay_legacy_oracle(include_str!(
        "../../tests/fixtures/legacy-catalog-http-node.json"
    ))
    .await
}
