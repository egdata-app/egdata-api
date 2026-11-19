//! Offer price reads migrated from `src/v1/routes/offer-details.ts`.
pub use egdata_http_core::shared::offer_prices::*;

use super::{
    RouteGroup,
    helpers::{parse_strict_query_uri, read_response, v1_cache_get, v1_cache_key, v1_cache_set},
    offers,
    system::{doc_to_json, internal_error},
};
use crate::state::AppState;
use axum::{
    extract::{Path, Request, State},
    http::Uri,
};
use bson::{Bson, Document, doc};
use egdata_core::{
    ports::MongoFindOptions,
    v1::{ProblemError, canonical_country, not_found, regional_params},
};
use serde_json::{Value, json};
use std::collections::BTreeMap;


const TTL: u64 = 60;
const OFFER_MISSING: &str = "No offer exists with this ID.";
pub fn route_group(prefix: &str) -> RouteGroup {
    RouteGroup::new(prefix)
        .get(
            "/offers/{id}/price",
            |State(s), Path(id): Path<String>, r: Request| async move {
                let out = match egdata_core::v1::require_id_param(Some(&id), "id") {
                    Ok(id) => price(&s, r.uri(), &id).await,
                    Err(error) => Err(error),
                };
                read_response(&r, out)
            },
        )
        .get(
            "/offers/{id}/price-history",
            |State(s), Path(id): Path<String>, r: Request| async move {
                let out = match egdata_core::v1::require_id_param(Some(&id), "id") {
                    Ok(id) => super::offer_price_history::history(&s, r.uri(), &id).await,
                    Err(error) => Err(error),
                };
                super::helpers::read_envelope_response(&r, out)
            },
        )
        .get(
            "/offers/{id}/price/fairness",
            |State(s), Path(id): Path<String>, r: Request| async move {
                let out = match egdata_core::v1::require_id_param(Some(&id), "id") {
                    Ok(id) => fairness(&s, r.uri(), &id).await,
                    Err(error) => Err(error),
                };
                read_response(&r, out)
            },
        )
        .get(
            "/offers/{id}/regional-price",
            |State(s), Path(id): Path<String>, r: Request| async move {
                let out = match egdata_core::v1::require_id_param(Some(&id), "id") {
                    Ok(id) => super::offer_regional_price::regional(&s, r.uri(), &id).await,
                    Err(error) => Err(error),
                };
                read_response(&r, out)
            },
        )
        .get(
            "/offers/{id}/price-stats",
            |State(s), Path(id): Path<String>, r: Request| async move {
                let out = match egdata_core::v1::require_id_param(Some(&id), "id") {
                    Ok(id) => stats(&s, r.uri(), &id).await,
                    Err(error) => Err(error),
                };
                read_response(&r, out)
            },
        )
}
fn key(op: &str, parts: &[(&str, Value)]) -> String {
    let m: BTreeMap<_, _> = parts.iter().map(|(k, v)| (*k, v.clone())).collect();
    v1_cache_key(op, &m)
}
async fn cached<F, Fut>(s: &AppState, k: String, load: F) -> Result<Value, ProblemError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<Value, ProblemError>>,
{
    cached_ttl(s, k, TTL, load).await
}
async fn cached_ttl<F, Fut>(
    s: &AppState,
    k: String,
    ttl: u64,
    load: F,
) -> Result<Value, ProblemError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<Value, ProblemError>>,
{
    if let Some(v) = v1_cache_get(s.cache.as_ref(), &k).await {
        return Ok(v);
    }
    let v = load().await?;
    v1_cache_set(s.cache.as_ref(), &k, &v, ttl).await;
    Ok(v)
}
pub(super) async fn one(
    s: &AppState,
    c: &str,
    f: Document,
    p: Option<Document>,
) -> Result<Value, ProblemError> {
    s.mongo
        .find_one(c, f, p)
        .await
        .map(|v| v.map(doc_to_json).unwrap_or(Value::Null))
        .map_err(|_| internal_error())
}
/// Keep a stored namespace or identifier in its native BSON type for subsequent lookups.
pub(super) async fn require_stored(
    state: &AppState,
    id: &str,
    projection: Option<Document>,
) -> Result<Document, ProblemError> {
    state
        .mongo
        .find_one("offers", doc! {"id":{"$eq":id}}, projection)
        .await
        .map_err(|_| internal_error())?
        .ok_or_else(|| not_found("OFFER_NOT_FOUND", OFFER_MISSING))
}

pub(super) async fn require(
    state: &AppState,
    id: &str,
    projection: Option<Document>,
) -> Result<Value, ProblemError> {
    require_stored(state, id, projection).await.map(doc_to_json)
}
fn eligible(offer: &Document, country: &str) -> Result<bool, ProblemError> {
    let countries = |key| -> Result<Vec<String>, ProblemError> {
        match offer.get(key) {
            None | Some(Bson::Null | Bson::Undefined) => Ok(Vec::new()),
            Some(Bson::Array(entries)) => entries
                .iter()
                .map(|v| {
                    super::system::stored_text(v)
                        .map(str::to_uppercase)
                        .ok_or_else(internal_error)
                })
                .collect(),
            _ => Err(internal_error()),
        }
    };
    let whitelist = countries("countriesWhitelist")?;
    let blacklist = countries("countriesBlacklist")?;
    Ok(!blacklist.iter().any(|v| v == country)
        && (whitelist.is_empty() || whitelist.iter().any(|v| v == country)))
}

fn usd_cents(
    original_price: Option<f64>,
    currency: Option<&str>,
    rate: Option<f64>,
) -> Option<f64> {
    let values = egdata_core::pricing::PriceLike {
        original_price,
        currency_code: currency.map(str::to_owned),
        payout_currency_exchange_rate: rate,
        ..Default::default()
    };
    egdata_core::pricing::to_usd_cents(&values, egdata_core::pricing::PriceSource::Original)
}

fn stats_price(row: Option<Document>) -> Result<Value, ProblemError> {
    let Some(mut row) = row else {
        return Ok(Value::Null);
    };
    if let Ok(price) = row.get_document_mut("price") {
        // toUsdCents checks JS number types before serializePrice coerces stored amounts.
        let number = |key| match price.get(key) {
            Some(Bson::Double(n)) => Some(*n),
            Some(Bson::Int32(n)) => Some(f64::from(*n)),
            Some(Bson::Int64(n)) if n.unsigned_abs() <= 1 << 53 => Some(*n as f64),
            _ => None,
        };
        let cents = usd_cents(
            number("originalPrice"),
            price
                .get("currencyCode")
                .and_then(super::system::stored_text),
            number("payoutCurrencyExchangeRate"),
        );
        price.insert(
            "basePayoutPrice",
            cents.map(Bson::Double).unwrap_or(Bson::Null),
        );
    }
    serialize_stored_price(row)
}
async fn regional_params_from_uri(
    uri: &Uri,
) -> Result<egdata_core::v1::RegionalParams, ProblemError> {
    let q = parse_strict_query_uri(uri, &["country", "locale"])?;
    regional_params(
        q.get("country").map(String::as_str),
        q.get("locale").map(String::as_str),
    )
}
async fn price(s: &AppState, u: &Uri, id: &str) -> Result<(Value, Value), ProblemError> {
    let rp = regional_params_from_uri(u).await?;
    let payload = cached(
        s,
        key(
            "offer-details.price",
            &[
                ("id", json!(id)),
                ("region", json!(rp.region)),
                ("locale", json!(rp.locale)),
            ],
        ),
        || async {
            let detail = offers::cached_detail(s, &rp, id).await?;
            if detail.is_null() {
                return Err(not_found("OFFER_NOT_FOUND", OFFER_MISSING));
            }
            let country = canonical_country(Some(&rp.country))?;
            if !offers::country_eligible(&detail["offer"], &country) {
                return Err(not_found(
                    "PRICE_NOT_FOUND",
                    format!("No {} price is available for this offer.", rp.country),
                ));
            }
            let p = offers::current_price(s, id, &rp.region)
                .await?
                .unwrap_or(Value::Null);
            if p.is_null() {
                return Err(not_found(
                    "PRICE_NOT_FOUND",
                    format!("No {} price is available for this offer.", rp.country),
                ));
            }
            // currentPrice serializes first, including the historical top-level currency fallback.
            let mut normalized = p;
            if normalized["price"].is_object() {
                let price = &normalized["price"];
                normalized["price"]["basePayoutPrice"] = json!(usd_cents(
                    price["originalPrice"].as_f64(),
                    price["currencyCode"].as_str(),
                    price["payoutCurrencyExchangeRate"].as_f64()
                ));
            }
            Ok(json!({"price":normalized,"localization":detail["localization"]}))
        },
    )
    .await?;
    let mut meta = json!({"country":rp.country,"region":rp.region,"locale":rp.locale});
    if let Some(localization) = payload["localization"].as_object() {
        meta.as_object_mut().unwrap().extend(localization.clone());
    }
    Ok((payload["price"].clone(), meta))
}
async fn fairness(s: &AppState, u: &Uri, id: &str) -> Result<(Value, Value), ProblemError> {
    let q = parse_strict_query_uri(u, &["country"])?;
    let country = canonical_country(q.get("country").map(String::as_str))?;
    let score = cached_ttl(
        s,
        key(
            "offer-details.price-fairness",
            &[("id", json!(id)), ("country", json!(country))],
        ),
        300,
        || async {
            require(s, id, Some(doc! {"id":1})).await?;
            let v = one(
                s,
                "offer_country_pricing_scores",
                doc! {"offerId":id,"country":&country},
                None,
            )
            .await?;
            if v.is_null() {
                Err(not_found(
                    "PRICE_FAIRNESS_NOT_FOUND",
                    format!("No price fairness score is stored for this offer in {country}."),
                ))
            } else {
                Ok(egdata_core::v1::serialize_value(&v))
            }
        },
    )
    .await?;
    Ok((score, json!({"country":country})))
}
async fn read_stats_prices(
    state: &AppState,
    reads: [(&'static str, Document, Document); 3],
) -> Result<[Option<Document>; 3], ProblemError> {
    use futures::{FutureExt, StreamExt, stream::FuturesUnordered};
    let mut pending: FuturesUnordered<_> = reads
        .into_iter()
        .enumerate()
        .map(|(index, (collection, filter, sort))| {
            let mongo = state.mongo.clone();
            async move {
                let row = mongo
                    .find_one_with_options(
                        collection,
                        filter,
                        MongoFindOptions {
                            sort: Some(sort),
                            ..Default::default()
                        },
                    )
                    .await;
                (index, row)
            }
        })
        .collect();
    let mut rows = [None, None, None];
    while let Some((index, result)) = pending.next().await {
        match result {
            Ok(row) => rows[index] = row,
            Err(_) => {
                // Promise.all starts all three reads and rejects without waiting on a stalled sibling.
                while matches!(pending.next().now_or_never(), Some(Some(_))) {}
                if !pending.is_empty() {
                    tokio::spawn(pending.for_each(|_| std::future::ready(())));
                }
                return Err(internal_error());
            }
        }
    }
    Ok(rows)
}
async fn stats(s: &AppState, u: &Uri, id: &str) -> Result<(Value, Value), ProblemError> {
    let rp = regional_params_from_uri(u).await?;
    let load = || async {
        let offer = require_stored(
            s,
            id,
            Some(doc! {"countriesWhitelist":1,"countriesBlacklist":1}),
        )
        .await?;
        let discounted = doc! {"offerId":id,"region":&rp.region,"price.discount":{"$gt":0}};
        let reads = [
            (
                "pricev2",
                doc! {"offerId":{"$eq":id},"region":{"$eq":&rp.region}},
                doc! {"updatedAt":-1},
            ),
            (
                "pricev2_historical",
                discounted.clone(),
                doc! {"price.discountPrice":1},
            ),
            ("pricev2_historical", discounted, doc! {"updatedAt":-1}),
        ];
        let [current, lowest, last_discount] = read_stats_prices(s, reads).await?;
        let current = if eligible(&offer, &rp.country)? {
            stats_price(current)?
        } else {
            Value::Null
        };
        Ok(
            json!({"current":current,"lowest":stats_price(lowest)?,"lastDiscount":stats_price(last_discount)?}),
        )
    };
    let data = cached(
        s,
        key(
            "offer-details.price-stats",
            &[("id", json!(id)), ("region", json!(rp.region))],
        ),
        load,
    )
    .await?;
    Ok((
        data,
        json!({"country":rp.country,"region":rp.region,"locale":rp.locale}),
    ))
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn native_price_stats_history_node_http() {
        egdata_api_oracle::replay_mongo_oracle(include_str!(
            "../../egdata-api/tests/fixtures/offer-price-statistics-native-http-node.json"
        ))
        .await;
    }
    #[tokio::test]
    async fn offer_prices_http_node_oracle() {
        egdata_api_oracle::replay_mongo_oracle(include_str!(
            "../../egdata-api/tests/fixtures/offer-prices-http-node.json"
        ))
        .await;
    }
}
