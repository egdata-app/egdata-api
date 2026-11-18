//! Grouped price history and keyset pagination for a single pricing region.
use super::catalog_list::{PageRead, counted_page};
use super::{
    helpers::parse_strict_query_uri, offer_prices::require, offer_prices::serialize_stored_price,
    offers, system::internal_error,
};
use crate::state::AppState;
use axum::http::Uri;
use bson::{Bson, Document, doc, oid::ObjectId};
use chrono::{DateTime, Utc};
#[cfg(test)]
use chrono::{Duration, Local};
pub(super) use egdata_core::v1::iso_date::parse_iso_timestamp;
use egdata_core::{ports::MongoFindOptions, v1::*};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const HISTORY: &str = "offer-details.price-history";
fn stored_id(value: Option<&Bson>) -> CursorSortValue {
    match value {
        Some(Bson::ObjectId(id)) => format!("oid:{}", id.to_hex()).into(),
        Some(Bson::Int64(n)) if n.unsigned_abs() > (1 << 53) => n.to_string().into(),
        Some(Bson::Decimal128(n)) => n.to_string().into(),
        Some(Bson::Null | Bson::Undefined) => CursorSortValue::Null,
        Some(value) => {
            let json = egdata_infra::bson_json::bson_to_js_json(value);
            match json {
                Value::Number(n) => CursorSortValue::Number(n),
                other => serialization::js_string(&other).into(),
            }
        }
        None => CursorSortValue::Null,
    }
}

/// Persisted strings and decoded cursors also accept RFC-formatted timestamps.
pub(crate) fn cursor_date(value: &str) -> Option<DateTime<Utc>> {
    serialization::parse_stored_timestamp(value)
}

fn filter_id(value: &CursorSortValue) -> Bson {
    match value {
        CursorSortValue::String(s) => s
            .strip_prefix("oid:")
            .and_then(|id| ObjectId::parse_str(id).ok())
            .map(Bson::ObjectId)
            .unwrap_or_else(|| Bson::String(s.clone())),
        CursorSortValue::Number(n) => Bson::String(query::format_js_number(
            n.as_f64().expect("cursor numbers are finite"),
        )),
        CursorSortValue::Null => Bson::Null,
    }
}

fn history_filter(id: &str, region: Bson, since: Option<DateTime<Utc>>) -> Document {
    let mut filter = doc! {"offerId":id,"region":region};
    if let Some(since) = since {
        filter.insert(
            "updatedAt",
            doc! {"$gte":bson::DateTime::from_chrono(since)},
        );
    }
    filter
}

/// Offer detail cursors use the raw BSON ID type to distinguish ObjectIds from strings.
pub(super) fn date_keyset(
    state: &AppState,
    page: &Pagination,
    binding: &CursorBinding,
    date_field: &str,
) -> Result<Option<Document>, ProblemError> {
    let Some(last) = offers::decode(state, page, binding)? else {
        return Ok(None);
    };
    let sort = [date_field, "_id"]
        .map(|field| MongoSortField::new(field, SortDirection::Desc, NullsOrder::Last));
    let key: Vec<_> = last
        .iter()
        .enumerate()
        .map(|(index, value)| {
            if index != 0 {
                return filter_id(value);
            }
            value
                .as_str()
                .and_then(cursor_date)
                .map(|v| Bson::DateTime(bson::DateTime::from_chrono(v)))
                .unwrap_or(Bson::Null)
        })
        .collect();
    mongo_keyset_filter(&sort, &key).map(Some)
}

pub(super) fn stored_date(value: &Bson) -> Option<String> {
    match value {
        Bson::DateTime(date) => egdata_infra::bson_json::bson_datetime_to_iso_string(*date),
        Bson::String(s) | Bson::Symbol(s) if !s.is_empty() => {
            Some(cursor_date(s).map_or_else(|| s.clone(), serialization::js_iso_datetime))
        }
        Bson::Document(doc) => doc.get("$date").and_then(stored_date),
        _ => None,
    }
}

fn trimmed_date_page(
    rows: Vec<Document>,
    limit: u32,
    date_field: &str,
) -> (Vec<Document>, Option<[CursorSortValue; 2]>) {
    let rows = trim_page(rows, limit as usize);
    let tuple = rows.has_more.then(|| {
        let last = rows.items.last().expect("page limit is positive");
        let date = last.get(date_field).and_then(stored_date);
        [CursorSortValue::from(date), stored_id(last.get("_id"))]
    });
    (rows.items, tuple)
}

fn date_page_meta(
    state: &AppState,
    binding: &CursorBinding,
    last: Option<[CursorSortValue; 2]>,
    filter_order: &[&str],
) -> Result<PageMeta, ProblemError> {
    let next = last
        .map(|tuple| {
            encode_cursor_with_filter_order(
                binding,
                &tuple,
                state.config.v1_cursor_secret.as_deref(),
                (state.now)().timestamp_millis(),
                filter_order,
            )
        })
        .transpose()?;
    Ok(page_meta(binding.limit, next.is_some(), next))
}

pub(super) fn date_page(
    state: &AppState,
    rows: Vec<Document>,
    binding: &CursorBinding,
    date_field: &str,
    filter_order: &[&str],
) -> Result<(Vec<Document>, PageMeta), ProblemError> {
    let (rows, last) = trimmed_date_page(rows, binding.limit, date_field);
    Ok((rows, date_page_meta(state, binding, last, filter_order)?))
}

pub(super) async fn history(state: &AppState, uri: &Uri, id: &str) -> Result<Value, ProblemError> {
    let query = parse_strict_query_uri(
        uri,
        &["country", "locale", "region", "since", "limit", "cursor"],
    )?;
    let locale = canonical_locale(query.get("locale").map(String::as_str))?;
    let since = query
        .get("since")
        .filter(|v| !v.is_empty())
        .map(|value| {
            parse_iso_timestamp(trim_js_whitespace(value)).ok_or_else(|| {
                bad_request(
                    "INVALID_TIMESTAMP",
                    "The `since` parameter must be an ISO 8601 timestamp such as 2025-01-31T00:00:00Z.",
                    None,
                )
            })
        })
        .transpose()?;
    let since_iso = since.map(serialization::js_iso_datetime);
    let requested = query
        .get("region")
        .map(|v| trim_js_whitespace(v))
        .filter(|v| !v.is_empty());
    let country = query
        .get("country")
        .map(String::as_str)
        .filter(|v| !v.is_empty());
    let page = parse_pagination_map(&query, 100)?;
    if requested.is_none() && country.is_none() {
        let key = BTreeMap::from([("id", json!(id)), ("since", json!(since_iso))]);
        let load = || async {
            require(state, id, Some(doc! {"id":1})).await?;
            let regions: Vec<_> = REGIONS.iter().map(|r| r.code).collect();
            let filter = history_filter(id, Bson::Document(doc! {"$in":regions}), since);
            let rows = state
                .mongo
                .find_many(
                    "pricev2_historical",
                    filter,
                    MongoFindOptions {
                        sort: Some(doc! {"date":-1}),
                        ..Default::default()
                    },
                )
                .await
                .map_err(|_| internal_error())?;
            let mut groups = serde_json::Map::new();
            for row in rows {
                let region = row.get("region");
                if !region.is_some_and(super::item_serialization::truthy) {
                    continue;
                }
                let key = super::system::stored_string_key(region)?;
                // Node's grouping object inherits these properties; they are not array buckets.
                if matches!(
                    key.as_str(),
                    "__proto__"
                        | "constructor"
                        | "toString"
                        | "valueOf"
                        | "hasOwnProperty"
                        | "isPrototypeOf"
                        | "propertyIsEnumerable"
                        | "toLocaleString"
                        | "__defineGetter__"
                        | "__defineSetter__"
                        | "__lookupGetter__"
                        | "__lookupSetter__"
                ) {
                    return Err(internal_error());
                }
                groups
                    .entry(key)
                    .or_insert_with(|| json!([]))
                    .as_array_mut()
                    .unwrap()
                    .push(serialize_stored_price(row)?);
            }
            Ok(Value::Object(groups))
        };
        let grouped = offers::cached(
            state,
            "offer-details.price-history.by-region",
            key,
            60,
            load,
        )
        .await?;
        let count = match &grouped {
            Value::Object(groups) => groups.len(),
            Value::Array(entries) => entries.len(),
            Value::String(text) => text.encode_utf16().count(),
            _ => 0,
        };
        return Ok(
            json!({"data":grouped,"meta":{"region":null,"locale":locale,"grouped":true,"regions":count,"since":since_iso}}),
        );
    }
    let region = if let Some(raw) = requested {
        let code = raw.to_uppercase();
        if !REGIONS.iter().any(|r| r.code == code) {
            return Err(bad_request(
                "INVALID_REGION",
                format!(
                    "Unknown pricing region '{raw}'. Use a region code returned by /v1/regions."
                ),
                None,
            ));
        }
        code
    } else {
        country_and_region(country)?.region
    };
    let binding = CursorBinding {
        operation: HISTORY.into(),
        filters: Some(BTreeMap::from([
            ("offerId".into(), json!(id)),
            ("region".into(), json!(region)),
            ("since".into(), json!(since_iso)),
        ])),
        ordering: "date:desc,_id:desc".into(),
        country: region.clone(),
        locale: locale.clone(),
        limit: page.limit,
    };
    let parts = BTreeMap::from([
        ("id", json!(id)),
        ("region", json!(region)),
        ("locale", json!(locale)),
        ("since", json!(since_iso)),
        ("limit", json!(page.limit)),
        ("cursor", json!(page.cursor)),
    ]);
    let load = || async {
        require(state, id, Some(doc! {"id":1})).await?;
        let mut filter = history_filter(id, Bson::String(region.clone()), since);
        let base = filter.clone();
        if let Some(keyset) = date_keyset(state, &page, &binding, "date")? {
            filter.extend(keyset);
        }
        let (rows, total) = counted_page(
            state,
            HISTORY,
            &[
                ("id", json!(id)),
                ("region", json!(region)),
                ("since", json!(since_iso)),
            ],
            60,
            "pricev2_historical",
            Some(base),
            PageRead::Find(
                filter,
                MongoFindOptions {
                    sort: Some(doc! {"date":-1,"_id":-1}),
                    limit: Some(i64::from(page.limit) + 1),
                    ..Default::default()
                },
            ),
        )
        .await?;
        let (rows, last) = trimmed_date_page(rows, binding.limit, "date");
        let elements = rows
            .into_iter()
            .map(serialize_stored_price)
            .collect::<Result<Vec<_>, _>>()?;
        let pagination = date_page_meta(state, &binding, last, &["offerId", "region", "since"])?;
        Ok(json!({"elements":elements,"pagination":pagination.with_total(total)}))
    };
    let payload = offers::cached(state, HISTORY, parts, 60, load).await?;
    let mut envelope = json!({});
    if let Some(elements) = payload.get("elements") {
        envelope["data"] = elements.clone();
    }
    let mut meta = json!({"region":region,"locale":locale,"since":since_iso});
    if let Some(pagination) = payload.get("pagination") {
        meta["pagination"] = pagination.clone();
    }
    envelope["meta"] = meta;
    Ok(envelope)
}

#[cfg(test)]
#[tokio::test]
async fn offer_price_history_matches_persisted_node_http() {
    use axum::{body::Body, http::Request};
    use egdata_infra::{
        mongo::{MongoConfig, connect_mongo},
        port_adapters::MongoStoreAdapter,
    };
    use std::sync::Arc;
    use tower::ServiceExt;
    let Ok(url) = std::env::var("EGDATA_TEST_MONGO") else {
        return;
    };
    let config = MongoConfig {
        url,
        database_name: format!("price_history_fixture_{}", ObjectId::new().to_hex()),
        ca_path: std::env::var("EGDATA_TEST_MONGO_CA").unwrap().into(),
        cert_path: std::env::var("EGDATA_TEST_MONGO_CERT").unwrap().into(),
    };
    let (_client, db) = connect_mongo(&config).await.unwrap();
    let fixtures: Vec<Value> = serde_json::from_str(include_str!(
        "../../tests/fixtures/offer-price-history-stored-node.json"
    ))
    .unwrap();
    let fixture = &fixtures[0];
    for (name, docs) in fixture["documents"].as_object().unwrap() {
        let docs: Vec<_> = docs
            .as_array()
            .unwrap()
            .iter()
            .map(|raw| {
                bson::RawDocumentBuf::from_bytes(hex::decode(raw.as_str().unwrap()).unwrap())
                    .unwrap()
            })
            .collect();
        db.collection::<bson::RawDocumentBuf>(name)
            .insert_many(docs)
            .await
            .unwrap();
    }
    let mut state = crate::middleware::test_support::test_app_state(crate::state::ApiConfig {
        v1_cursor_secret: Some("deterministic-collection-cursor-secret-for-oracle".into()),
        v1_worker_token: Some("oracle-worker".into()),
        ..Default::default()
    });
    state.now = || "2026-11-17T00:00:00Z".parse().unwrap();
    state.mongo = Arc::new(MongoStoreAdapter::new(db.clone()));
    let app = super::router(&state).with_state(state);
    let mut differences = Vec::new();
    for case in fixture["cases"].as_array().unwrap() {
        let mut path = case["path"].as_str().unwrap().to_owned();
        if let Some(date) = case["localSince"].as_str() {
            let instant = DateTime::parse_from_rfc3339(date).unwrap().to_utc();
            let offset = |t: DateTime<Utc>| t.with_timezone(&Local).offset().local_minus_utc();
            let seconds = offset(instant).min(offset(instant - Duration::hours(1)));
            let local = instant.naive_utc() + Duration::seconds(i64::from(seconds));
            path.push_str(&format!("&since={}", local.format("%Y-%m-%dT%H:%M:%S%.3f")));
        }
        let request = Request::builder()
            .uri(&path)
            .header("x-egdata-key-id", "key_oracle")
            .header("x-egdata-key-tier", "free")
            .header("x-request-id", "req_node_oracle")
            .header("x-egdata-worker-token", "oracle-worker")
            .body(Body::empty())
            .unwrap();
        let actual = super::oracle_test_support::capture_response(
            app.clone().oneshot(request).await.unwrap(),
        )
        .await;
        if actual != case["response"] {
            differences.push(json!({"path":path,"actual":actual,"expected":case["response"]}));
        }
    }
    db.drop().await.unwrap();
    assert!(differences.is_empty(), "{differences:#?}");
}
