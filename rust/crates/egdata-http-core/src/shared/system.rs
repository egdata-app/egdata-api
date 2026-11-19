//! Shared `system` helpers used by the versioned and unversioned surfaces.

use std::collections::{HashMap, HashSet};

use bson::{Bson, Document, doc};
use chrono::{DateTime, Datelike, TimeZone, Utc};
use egdata_core::localization::{
    apply_offer_localization_fields, get_offer_localization_entity_id,
};
use egdata_core::ports::MongoFindOptions;
use egdata_core::v1::{
    CursorSortValue, ProblemError, bson_to_serialized_json, serialize_offer,
};
pub use egdata_core::v1::serialization::js_truthy;
use serde_json::{Map, Value, json};

use crate::state::AppState;

pub use egdata_core::v1::serialization::js_string_number;

pub fn internal_error() -> ProblemError {
    ProblemError::new(
        500,
        "INTERNAL_ERROR",
        "The API could not complete the request. Retry later and include the request ID when contacting support.",
    )
}

pub fn docs_to_json(docs: Vec<Document>) -> Vec<Value> {
    docs.into_iter()
        .map(|d| bson_to_serialized_json(&Bson::Document(d)))
        .collect()
}

pub fn doc_to_json(doc: Document) -> Value {
    bson_to_serialized_json(&Bson::Document(doc))
}

pub fn prepare_offer_for_localization(raw: &Value) -> Value {
    serialize_offer(raw, None, false)
}

pub async fn fetch_prices_by_offer_id(
    state: &AppState,
    offer_ids: &[String],
    region: &str,
) -> Result<HashMap<String, Value>, ProblemError> {
    if offer_ids.is_empty() {
        return Ok(HashMap::new());
    }
    read_prices_by_offer_id(
        state,
        offer_ids.iter().cloned().map(Bson::String).collect(),
        region,
    )
    .await
}

pub async fn read_prices_by_offer_id(
    state: &AppState,
    offer_ids: Vec<Bson>,
    region: &str,
) -> Result<HashMap<String, Value>, ProblemError> {
    let docs = state
        .mongo
        .find_many(
            "pricev2",
            doc! { "offerId": { "$in": offer_ids }, "region": region },
            MongoFindOptions::default(),
        )
        .await
        .map_err(|_| internal_error())?;

    let mut map = HashMap::new();
    for doc in docs {
        let json = egdata_infra::bson_json::bson_doc_to_js_json(&doc);
        map.insert(string_field(&json, "offerId"), json);
    }
    Ok(map)
}

pub async fn offer_localization_documents(
    state: &AppState,
    offers: &[Value],
    locale: &str,
) -> Result<Vec<Document>, ProblemError> {
    read_offer_localizations_by_id(
        state,
        offers.iter().filter_map(get_offer_localization_entity_id),
        locale,
    )
    .await
}

pub async fn read_offer_localizations_by_id(
    state: &AppState,
    ids: impl Iterator<Item = String>,
    locale: &str,
) -> Result<Vec<Document>, ProblemError> {
    if locale == "en-US" {
        return Ok(Vec::new());
    }
    let mut entity_ids = Vec::new();
    let mut seen = HashSet::new();
    for eid in ids {
        if seen.insert(eid.clone()) {
            entity_ids.push(Bson::String(eid));
        }
    }

    if entity_ids.is_empty() {
        return Ok(Vec::new());
    }
    state
        .mongo
        .find_many(
            "egs_localizations",
            doc! {
                "entityType": "offer",
                "entityId": { "$in": entity_ids },
                "locale": locale,
            },
            MongoFindOptions::default(),
        )
        .await
        .map_err(|_| internal_error())
}

pub fn cached_length(value: &Value) -> Option<Value> {
    match value {
        Value::String(text) => Some(json!(text.encode_utf16().count())),
        Value::Array(rows) => Some(json!(rows.len())),
        other => other.get("length").cloned(),
    }
}

/// Both BSON string types are read by the Node driver as JavaScript strings.
pub fn stored_text(value: &Bson) -> Option<&str> {
    match value {
        Bson::String(text) | Bson::Symbol(text) => Some(text),
        _ => None,
    }
}

pub async fn localize_ordered_rows(
    state: &AppState,
    rows: &[impl std::borrow::Borrow<Document>],
    locale: &str,
) -> Result<Vec<Value>, ProblemError> {
    let prepared = rows
        .iter()
        .map(|row| {
            let raw = egdata_infra::bson_json::bson_doc_to_js_json(row.borrow());
            super::offers::checked_ordered(&raw)
        })
        .collect::<Result<Vec<_>, ProblemError>>()?;
    // Native JS types determine localization keys before BSON is serialized.
    localize_offers_with_keys(state, &prepared, locale, |index, _| {
        let row = rows[index].borrow();
        let namespace = row
            .get("namespace")
            .and_then(stored_text)
            .filter(|s| !s.is_empty())?;
        let id = row
            .get("id")
            .and_then(stored_text)
            .filter(|s| !s.is_empty())?;
        Some(format!("{namespace}:{id}"))
    })
    .await
}

pub async fn regional_offer_prices(
    state: &AppState,
    offers: &[Document],
    region: &str,
) -> Result<Vec<Document>, ProblemError> {
    let ids: Vec<_> = offers
        .iter()
        .map(|offer| offer.get("id").cloned().unwrap_or(Bson::Null))
        .collect();
    state
        .mongo
        .find_many(
            "pricev2",
            doc! {"region":region, "offerId":{"$in":ids}},
            MongoFindOptions::default(),
        )
        .await
        .map_err(|_| internal_error())
}

pub fn serialize_localized_offer(
    offer: &Value,
    price: Option<Document>,
) -> Result<Value, ProblemError> {
    let mut result = serialize_offer(offer, None, true);
    if let Some(price) = price {
        result["price"] = super::offer_prices::serialize_stored_price(price)?;
    }
    Ok(result)
}

/// Retains native BSON identifier coercion while serializing a localized offer and its price.
pub fn serialize_stored_localized_offer(
    row: &Document,
    localized: &Value,
    price: Option<Document>,
) -> Result<Value, ProblemError> {
    let mut offer = serialize_localized_offer(localized, price)?;
    for key in ["_id", "id"] {
        if let Some(value) = row
            .get(key)
            .filter(|v| !matches!(v, Bson::Null | Bson::Undefined))
        {
            offer[key] = stored_string_key(Some(value))?.into();
        }
    }
    Ok(offer)
}

pub async fn serialize_priced_offers(
    state: &AppState,
    rows: &[Document],
    prices: &[Document],
    locale: &str,
) -> Result<(Vec<Value>, Value), ProblemError> {
    use crate::v1_helpers::primitive_id;
    let localized = localize_ordered_rows(state, rows, locale).await?;
    let locale_meta = egdata_core::v1::localization_meta(localized.first());
    let by_id: HashMap<_, _> = prices
        .iter()
        .filter_map(|price| primitive_id(price.get("offerId")).map(|id| (id, price)))
        .collect();
    let offers = rows
        .iter()
        .zip(&localized)
        .map(|(row, localized)| {
            let price = primitive_id(row.get("id"))
                .and_then(|id| by_id.get(&id).copied())
                .cloned();
            serialize_localized_offer(localized, price)
        })
        .collect::<Result<_, _>>()?;
    Ok((offers, locale_meta))
}

pub async fn localize_offers(
    state: &AppState,
    offers: &[Value],
    locale: &str,
) -> Result<Vec<Value>, ProblemError> {
    localize_offers_with_keys(state, offers, locale, |_, offer| {
        get_offer_localization_entity_id(offer)
    })
    .await
}

pub async fn localize_offers_with_keys(
    state: &AppState,
    offers: &[Value],
    locale: &str,
    entity_id: impl Fn(usize, &Value) -> Option<String>,
) -> Result<Vec<Value>, ProblemError> {
    let keys = offers
        .iter()
        .enumerate()
        .filter_map(|(index, offer)| entity_id(index, offer));
    let rows = docs_to_json(read_offer_localizations_by_id(state, keys, locale).await?);
    let localizations = rows
        .iter()
        .filter_map(|row| row["entityId"].as_str().map(|id| (id, row)))
        .collect::<HashMap<_, _>>();
    Ok(offers
        .iter()
        .enumerate()
        .map(|(index, offer)| {
            let row = if localizations.is_empty() {
                None
            } else {
                entity_id(index, offer).and_then(|id| localizations.get(id.as_str()).copied())
            };
            let metadata = row.map(|row| {
                let mut metadata = Map::from_iter([
                    ("source".into(), row["source"].clone()),
                    ("fetchedAt".into(), row["fetchedAt"].clone()),
                ]);
                if let Some(value) = row.get("sourceUpdatedAt").filter(|value| js_truthy(value)) {
                    metadata.insert("sourceUpdatedAt".into(), value.clone());
                }
                Value::Object(metadata)
            });
            apply_offer_localization_fields(
                offer,
                locale,
                row.and_then(|row| row.get("data")),
                metadata,
            )
        })
        .collect())
}

/// Applies JavaScript String to a stored Mongo key, including missing and null fields.
pub fn stored_string_key(value: Option<&Bson>) -> Result<String, ProblemError> {
    match value {
        None | Some(Bson::Undefined) => Ok("undefined".into()),
        Some(Bson::Null) => Ok("null".into()),
        Some(Bson::Document(d)) if d.contains_key("toString") => Err(internal_error()),
        Some(Bson::Array(values)) => values
            .iter()
            .map(|v| match v {
                Bson::Undefined | Bson::Null => Ok(String::new()),
                _ => stored_string_key(Some(v)),
            })
            .collect::<Result<Vec<_>, _>>()
            .map(|values| values.join(",")),
        Some(value) => {
            Ok(egdata_core::v1::serialization::stored_identifier(value).unwrap_or_default())
        }
    }
}

pub fn cursor_date_bson(value: &CursorSortValue) -> Bson {
    match value {
        CursorSortValue::Null => Bson::Null,
        CursorSortValue::String(s) => match DateTime::parse_from_rfc3339(s) {
            Ok(dt) => Bson::DateTime(bson::DateTime::from_chrono(dt.with_timezone(&Utc))),
            Err(_) => Bson::String(s.clone()),
        },
        CursorSortValue::Number(n) => number_to_bson(n),
    }
}

pub fn cursor_scalar_bson(value: &CursorSortValue) -> Bson {
    match value {
        CursorSortValue::Null => Bson::Null,
        CursorSortValue::String(s) => Bson::String(s.clone()),
        CursorSortValue::Number(n) => number_to_bson(n),
    }
}

pub fn number_to_bson(n: &serde_json::Number) -> Bson {
    if let Some(i) = n.as_i64() {
        Bson::Int64(i)
    } else {
        Bson::Double(n.as_f64().unwrap())
    }
}

pub fn string_field(row: &Value, key: &str) -> String {
    row.get(key)
        .map(egdata_core::v1::serialization::js_string)
        .unwrap_or_else(|| "undefined".into())
}

pub async fn count_or_zero(state: &AppState, collection: &str, filter: Document) -> u64 {
    state
        .mongo
        .count_documents(collection, filter)
        .await
        .unwrap_or(0)
}

pub async fn stats_counts(state: &AppState, legacy: bool) -> Value {
    let year = (state.now)().with_timezone(&chrono::Local).year();
    let year_start = chrono::Local
        .with_ymd_and_hms(year, 1, 1, 0, 0, 0)
        .single()
        .map(|date| bson::DateTime::from_chrono(date.with_timezone(&Utc)))
        .unwrap_or_else(bson::DateTime::now);
    let next_year_start = chrono::Local
        .with_ymd_and_hms(year + 1, 1, 1, 0, 0, 0)
        .single()
        .map(|date| bson::DateTime::from_chrono(date.with_timezone(&Utc)))
        .unwrap_or_else(bson::DateTime::now);
    let year_filter = doc! { "creationDate": { "$gte": year_start, "$lt": next_year_start } };

    let (
        offers,
        items,
        tags,
        assets,
        price_engine,
        changelog,
        sandboxes,
        products,
        offers_year,
        items_year,
    ) = tokio::join!(
        count_or_zero(state, "offers", doc! {}),
        count_or_zero(state, "items", doc! {}),
        count_or_zero(state, "tags", doc! {}),
        count_or_zero(state, "assets", doc! {}),
        count_or_zero(state, "pricev2", doc! {}),
        count_or_zero(state, "changelogs_v2", doc! {}),
        state.mongo.count_documents("sandboxes", doc! {}),
        state.mongo.count_documents("products", doc! {}),
        count_or_zero(state, "offers", year_filter.clone()),
        count_or_zero(state, "items", year_filter),
    );

    let mut data = json!({
        "offers": offers,
        "items": items,
        "tags": tags,
        "assets": assets,
        "priceEngine": price_engine,
        "changelog": changelog,
        "sandboxes": sandboxes.as_ref().copied().unwrap_or(0),
        "products": products.as_ref().copied().unwrap_or(0),
        "offersYear": offers_year,
        "itemsYear": items_year,
    });
    // The legacy response reads the sandbox count when the products query succeeds.
    if legacy && products.is_ok() {
        if let Ok(count) = sandboxes {
            data["products"] = json!(count);
        } else {
            data.as_object_mut().unwrap().shift_remove("products");
        }
    }
    data
}

pub fn date_stats_pipeline(
    date_field: &str,
    count_field: &str,
    monthly: bool,
    now: DateTime<Utc>,
) -> Vec<Document> {
    let egs_launch = Utc
        .with_ymd_and_hms(2018, 12, 6, 0, 0, 0)
        .single()
        .map(bson::DateTime::from_chrono)
        .unwrap_or_else(bson::DateTime::now);
    let now = bson::DateTime::from_chrono(now);

    let mut group_id = doc! { "year": { "$year": format!("${date_field}") } };
    let mut project = doc! { "_id": 0, "year": "$_id.year", count_field: 1 };
    let mut sort = doc! { "_id.year": 1 };
    if monthly {
        group_id.insert("month", doc! { "$month": format!("${date_field}") });
        project.insert("month", "$_id.month");
        sort.insert("_id.month", 1);
    }

    vec![
        doc! {
            "$match": {
                "prePurchase": { "$ne": true },
                "isCodeRedemptionOnly": { "$ne": true },
                date_field: {
                    "$ne": Bson::Null,
                    "$lte": now,
                    "$gte": egs_launch,
                },
                "offerType": { "$eq": "BASE_GAME" },
            }
        },
        doc! {
            "$group": {
                "_id": group_id,
                count_field: { "$sum": 1 },
            }
        },
        doc! { "$sort": sort },
        doc! { "$project": project },
    ]
}

pub async fn homepage_counts(state: &AppState, region: &str) -> Value {
    let since = bson::DateTime::from_chrono((state.now)() - chrono::Duration::hours(72));
    let (offers, tracked_price_changes, active_discounts, giveaways) = tokio::join!(
        count_or_zero(state, "offers", doc! {}),
        count_or_zero(
            state,
            "pricev2",
            doc! {
                "region": region,
                "updatedAt": { "$gte": since },
                "appliedRules": { "$ne": [] },
            }
        ),
        count_or_zero(
            state,
            "pricev2",
            doc! {
                "region": region,
                "appliedRules": { "$ne": [] },
            }
        ),
        count_or_zero(state, "freegames", doc! {}),
    );

    json!({
        "offers": offers,
        "trackedPriceChanges": tracked_price_changes,
        "activeDiscounts": active_discounts,
        "giveaways": giveaways,
    })
}

pub fn js_number_or_zero(value: Option<&Value>) -> f64 {
    let number = match value {
        None | Some(Value::Null) => 0.0,
        Some(Value::Bool(value)) => {
            if *value {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::Number(number)) => number.as_f64().unwrap_or(0.0),
        Some(Value::String(value)) => js_string_number(value),
        Some(Value::Array(values)) if values.is_empty() => 0.0,
        Some(Value::Array(values)) if values.len() == 1 => {
            js_string_number(&js_primitive_string(&values[0]))
        }
        _ => f64::NAN,
    };
    if number == 0.0 || number.is_nan() {
        0.0
    } else {
        number
    }
}

pub fn js_primitive_string(value: &Value) -> String {
    if value.is_null() {
        String::new()
    } else {
        egdata_core::v1::serialization::js_string(value)
    }
}

pub fn truthy(value: &Bson) -> bool {
    match value {
        Bson::Null | Bson::Undefined => false,
        Bson::Boolean(value) => *value,
        Bson::String(text) | Bson::Symbol(text) => !text.is_empty(),
        Bson::Int32(number) => *number != 0,
        Bson::Int64(number) => *number != 0,
        Bson::Double(number) => *number != 0. && !number.is_nan(),
        _ => true,
    }
}
