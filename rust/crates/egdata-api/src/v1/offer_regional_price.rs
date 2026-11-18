//! Regional offer price comparisons, ported from offer-details.ts.
use crate::state::AppState;
use axum::http::Uri;
use bson::{Bson, Document, doc};
use egdata_core::v1::serialization::{js_string_number, js_truthy, stored_identifier};
use egdata_core::{
    ports::MongoFindOptions,
    pricing::{
        PriceAvailability, PriceLike, PriceSource, is_price_country_eligible,
        is_price_region_eligible, price_availability_key, to_usd_cents,
    },
    v1::{ProblemError, REGIONS, country_and_region, not_found},
};
use egdata_infra::bson_json::{bson_doc_to_js_json, bson_to_js_json};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

use super::{
    helpers::{parse_strict_query_uri, v1_cache_get, v1_cache_key, v1_cache_set},
    system::{doc_to_json, internal_error},
};

const TTL: u64 = 60;

fn cache_key(operation: &str, parts: &[(&str, Value)]) -> String {
    let map: BTreeMap<_, _> = parts
        .iter()
        .map(|(key, value)| (*key, value.clone()))
        .collect();
    v1_cache_key(operation, &map)
}

async fn cached<F, Fut>(state: &AppState, key: String, load: F) -> Result<Value, ProblemError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<Value, ProblemError>>,
{
    if let Some(value) = v1_cache_get(state.cache.as_ref(), &key).await {
        return Ok(value);
    }
    let value = load().await?;
    v1_cache_set(state.cache.as_ref(), &key, &value, TTL).await;
    Ok(value)
}

async fn offer(state: &AppState, id: &str) -> Result<Value, ProblemError> {
    let value = state
        .mongo
        .find_one("offers", doc! {"id":{"$eq":id}}, None)
        .await
        .map_err(|_| internal_error())?
        .map(doc_to_json)
        .unwrap_or(Value::Null);
    if value.is_null() {
        Err(not_found(
            "OFFER_NOT_FOUND",
            "No offer exists with this ID.",
        ))
    } else {
        Ok(value)
    }
}

pub(crate) fn availability(offer: &Value) -> PriceAvailability {
    let values = |field: &str| {
        offer[field].as_array().map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
    };
    PriceAvailability {
        countries_whitelist: values("countriesWhitelist"),
        countries_blacklist: values("countriesBlacklist"),
    }
}

fn eligible_country(offer: &Value, country: &str) -> bool {
    is_price_country_eligible(&availability(offer), country)
}

fn eligible_region(offer: &Value, region: &str) -> bool {
    is_price_region_eligible(&availability(offer), region)
}

fn usd_number(price: &Value, source: PriceSource) -> Option<f64> {
    let input = PriceLike {
        currency_code: price["currencyCode"].as_str().map(str::to_owned),
        discount_price: price["discountPrice"].as_f64(),
        original_price: price["originalPrice"].as_f64(),
        payout_currency_exchange_rate: price["payoutCurrencyExchangeRate"].as_f64(),
    };
    to_usd_cents(&input, source)
}

pub(crate) fn usd_cents(price: &Value, original: bool) -> Value {
    let source = if original {
        PriceSource::Original
    } else {
        PriceSource::Discount
    };
    json!(usd_number(price, source))
}

fn release_filter(
    offer: &Value,
    id: &str,
    region: Option<&str>,
    now: chrono::DateTime<chrono::Utc>,
    include_end: bool,
) -> Document {
    let mut filter = doc! {"offerId":id};
    if let Some(region) = region {
        filter.insert("region", region);
    }
    let release = offer
        .get("releaseDate")
        .filter(|value| !value.is_null())
        .or_else(|| offer.get("effectiveDate").filter(|value| !value.is_null()));
    if let Some(release) = release.and_then(|value| {
        value
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|v| v.with_timezone(&chrono::Utc))
    }) && release <= now
    {
        let mut bounds = doc! {"$gte":bson::DateTime::from_chrono(release)};
        if include_end {
            bounds.insert("$lte", bson::DateTime::from_chrono(now));
        }
        filter.insert("updatedAt", bounds);
    }
    filter
}

async fn history(state: &AppState, filter: Document) -> Result<Vec<Document>, ProblemError> {
    state
        .mongo
        .find_many(
            "pricev2_historical",
            filter,
            MongoFindOptions {
                sort: Some(doc! {"updatedAt":-1}),
                ..Default::default()
            },
        )
        .await
        .map_err(|_| internal_error())
}

async fn live_prices(state: &AppState, id: &str) -> Result<Vec<Document>, ProblemError> {
    state
        .mongo
        .find_many("pricev2", doc! {"offerId":id}, MongoFindOptions::default())
        .await
        .map_err(|_| internal_error())
}

async fn live_price(
    state: &AppState,
    id: &str,
    region: &str,
) -> Result<Option<Document>, ProblemError> {
    state
        .mongo
        .find_one_with_options(
            "pricev2",
            doc! {"offerId":{"$eq":id},"region":{"$eq":region}},
            MongoFindOptions {
                sort: Some(doc! {"updatedAt":-1}),
                ..Default::default()
            },
        )
        .await
        .map_err(|_| internal_error())
}

pub(crate) fn stored_number(value: &Bson) -> f64 {
    match value {
        Bson::Decimal128(n) => js_string_number(&n.to_string()),
        Bson::Int64(n) => *n as f64,
        Bson::DateTime(d) => d.timestamp_millis() as f64,
        Bson::Double(n) => *n,
        Bson::Boolean(v) => i32::from(*v) as f64,
        Bson::Null => 0.0,
        other => stored_identifier(other).map_or(f64::NAN, |s| js_string_number(&s)),
    }
}

fn stored_usd(price: &Document, source: PriceSource) -> Option<f64> {
    let fields = price.get_document("price").ok()?;
    // The driver's default promotes Long to Number up to and including 2^53.
    // Larger longs and all decimals remain objects and fail the Node typeof check.
    let number = |field| match fields.get(field)? {
        Bson::Int32(n) => Some(f64::from(*n)),
        Bson::Int64(n) if n.unsigned_abs() <= (1_u64 << 53) => Some(*n as f64),
        Bson::Double(n) => Some(*n),
        _ => None,
    };
    to_usd_cents(
        &PriceLike {
            currency_code: fields.get_str("currencyCode").ok().map(str::to_owned),
            discount_price: number("discountPrice"),
            original_price: number("originalPrice"),
            payout_currency_exchange_rate: number("payoutCurrencyExchangeRate"),
        },
        source,
    )
}

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum PriceFormat {
    Legacy,
    V1,
}

pub(crate) fn price_summary(
    format: PriceFormat,
    current: &Document,
    history: &[&Document],
    live: Option<&Document>,
) -> Result<Value, ProblemError> {
    let mut discounts = Vec::with_capacity(history.len() + 1);
    for row in history.iter().copied().chain(std::iter::once(current)) {
        let price = row.get("price");
        if format == PriceFormat::Legacy
            && matches!(price, None | Some(Bson::Null | Bson::Undefined))
        {
            return Err(internal_error());
        }
        discounts.push(
            price
                .and_then(Bson::as_document)
                .and_then(|p| p.get("discountPrice"))
                .map_or(0., stored_number),
        );
    }
    let current_usd = stored_usd(current, PriceSource::Discount);
    let original_usd = stored_usd(current, PriceSource::Original);
    let mut normalized = current.clone();
    if let Ok(fields) = normalized.get_document_mut("price") {
        fields.insert(
            "basePayoutPrice",
            original_usd.map_or(Bson::Null, Bson::Double),
        );
    } else if format == PriceFormat::Legacy
        && let Some(price) = normalized.get("price")
        && matches!(
            price,
            Bson::Int32(_) | Bson::Double(_) | Bson::Boolean(_) | Bson::String(_) | Bson::Int64(_)
        )
        && !bson_to_js_json(price).is_object()
        && js_truthy(&bson_to_js_json(price))
    {
        return Err(internal_error());
    }
    let current = match format {
        PriceFormat::Legacy => bson_doc_to_js_json(&normalized),
        PriceFormat::V1 => super::offer_prices::serialize_stored_price(normalized)?,
    };
    let usd = history
        .iter()
        .copied()
        .chain(live)
        .filter_map(|row| stored_usd(row, PriceSource::Discount));
    let (min, max) = price_bounds(discounts.into_iter());
    let (min_usd, max_usd) = price_bounds(usd);
    Ok(
        json!({"currentPrice":current,"maxPrice":max,"minPrice":min,"currentPriceUsd":current_usd,"currentOriginalPriceUsd":original_usd,"maxPriceUsd":max_usd,"minPriceUsd":min_usd}),
    )
}

// Math.min/Math.max include every Number, including overflow and NaN, before
// JSON.stringify turns non-finite outputs into null.
fn price_bounds(mut values: impl Iterator<Item = f64>) -> (Option<f64>, Option<f64>) {
    let Some(first) = values.next() else {
        return (None, None);
    };
    let mut min = first;
    let mut max = first;
    for n in values {
        if n.is_nan() || min.is_nan() {
            return (None, None);
        }
        min = min.min(n);
        max = max.max(n);
    }
    (Some(min), Some(max))
}

fn updated_millis(row: &Document) -> Option<i64> {
    match row.get("updatedAt")? {
        Bson::DateTime(date) => Some(date.timestamp_millis()),
        Bson::Null => Some(0),
        Bson::Int32(n) => Some(i64::from(*n)),
        Bson::Int64(n) if n.unsigned_abs() <= (1_u64 << 53) => Some(*n),
        Bson::Double(n) if n.abs() <= 8_640_000_000_000_000. => Some(*n as i64),
        Bson::Boolean(v) => Some(i64::from(*v)),
        value => super::offer_price_history::cursor_date(&stored_identifier(value)?)
            .map(|dt| dt.timestamp_millis()),
    }
}

pub(super) async fn regional(
    state: &AppState,
    uri: &Uri,
    id: &str,
) -> Result<(Value, Value), ProblemError> {
    let query = parse_strict_query_uri(uri, &["country"])?;
    let requested = query
        .get("country")
        .map(|country| country_and_region(Some(country)))
        .transpose()?;
    let offer = offer(state, id).await?;
    let availability = price_availability_key(&availability(&offer));
    if let Some(requested) = requested {
        if !eligible_country(&offer, &requested.country) {
            return Err(not_found(
                "PRICE_NOT_FOUND",
                format!(
                    "No {} price is available for this offer.",
                    requested.country
                ),
            ));
        }
        let key = cache_key(
            "offer-details.regional-price",
            &[
                ("id", json!(id)),
                ("region", json!(requested.region)),
                ("availability", json!(availability)),
            ],
        );
        let data = cached(state, key, || async {
            let now = (state.now)();
            let live = live_price(state, id, &requested.region).await?;
            let mut history_rows = history(
                state,
                release_filter(&offer, id, Some(&requested.region), now, true),
            )
            .await?;
            if history_rows.is_empty() {
                history_rows =
                    history(state, doc! {"offerId":id,"region":&requested.region}).await?;
            }
            let current = live
                .as_ref()
                .or_else(|| history_rows.first())
                .ok_or_else(|| {
                    not_found(
                        "PRICE_NOT_FOUND",
                        format!(
                            "No {} price is available for this offer.",
                            requested.country
                        ),
                    )
                })?;
            price_summary(
                PriceFormat::V1,
                current,
                &history_rows.iter().collect::<Vec<_>>(),
                live.as_ref(),
            )
        })
        .await?;
        return Ok((
            data,
            json!({"country":requested.country,"region":requested.region}),
        ));
    }

    let key = cache_key(
        "offer-details.regional-price.all",
        &[("id", json!(id)), ("availability", json!(availability))],
    );
    let grouped = cached(state, key, || async {
        let live = live_prices(state, id).await?;
        let now = (state.now)();
        let mut historical = history(state, release_filter(&offer, id, None, now, false)).await?;
        if historical.is_empty() {
            historical = history(state, doc! {"offerId":id}).await?;
        }
        let mut result = Map::new();
        for region in REGIONS {
            if !eligible_region(&offer, region.code) {
                continue;
            }
            let mut region_history: Vec<_> = historical
                .iter()
                .filter(|row| row.get_str("region").ok() == Some(region.code))
                .collect();
            let current_live = live
                .iter()
                .find(|row| row.get_str("region").ok() == Some(region.code));
            if current_live.is_none() {
                // Invalid Date subtraction produces NaN, which JS sort treats as equality.
                region_history.sort_by(|a, b| match (updated_millis(a), updated_millis(b)) {
                    (Some(a), Some(b)) => b.cmp(&a),
                    _ => std::cmp::Ordering::Equal,
                });
            }
            if let Some(current) = current_live.or_else(|| region_history.first().copied()) {
                result.insert(
                    region.code.to_owned(),
                    price_summary(PriceFormat::V1, current, &region_history, current_live)?,
                );
            }
        }
        Ok(Value::Object(result))
    })
    .await?;
    let count = grouped.as_object().map_or(0, Map::len);
    Ok((
        grouped,
        json!({"country":null,"region":null,"grouped":true,"regions":count}),
    ))
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn offer_regional_price_http_node_oracle() {
        super::super::mongo_read_oracle::replay_mongo_oracle(include_str!(
            "../../tests/fixtures/offer-regional-price-http-node.json"
        ))
        .await;
    }
}
