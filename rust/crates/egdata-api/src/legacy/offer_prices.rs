//! Unversioned offer price, system requirements and public review summaries.
use super::common::Error;
use super::{
    Routes,
    common::{ONE_MINUTE, Result, cache_header, cached, many, not_found, ok, one, store},
    system::{query, selected_country},
};
use crate::v1::system::js_truthy;
use crate::{
    state::AppState,
    v1::{
        offer_insights::resolve_requirements,
        offer_price_history::cursor_date,
        offer_regional_price::{
            PriceFormat, availability, price_summary, stored_number, usd_cents,
        },
    },
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, Uri},
    response::Response,
};
use bson::{Bson, Document, doc};
use egdata_core::v1::serialization::stored_identifier;
use egdata_core::{
    countries::REGIONS,
    ports::MongoFindOptions,
    pricing::{is_price_country_eligible, is_price_region_eligible, price_availability_key},
};
use egdata_infra::bson_json::{bson_doc_to_js_json, bson_to_js_json};
use serde_json::{Value, json};

pub(super) fn routes() -> Routes {
    Routes::new("/offers/{id}")
        .get("/price", price)
        .get("/price-history", history)
        .get("/price/fairness", fairness)
        .get("/regional-price", regional)
        .get("/price-stats", stats)
        .get("/requirements", requirements)
        .get("/reviews-summary", reviews_summary)
}

#[cfg(test)]
#[tokio::test]
async fn legacy_offer_prices_http_node_oracle() {
    crate::v1::mongo_read_oracle::replay_legacy_oracle(include_str!(
        "../../tests/fixtures/legacy-offer-prices-http-node.json"
    ))
    .await;
}

fn region(country: &str) -> Option<&'static str> {
    REGIONS
        .iter()
        .find(|(_, r)| r.countries.contains(&country))
        .map(|(code, _)| *code)
}

fn minute(value: &Value) -> Response {
    cache_header(ok(value), ONE_MINUTE)
}

async fn save(state: &AppState, key: &str, value: &Value) -> Result<Response> {
    store(state, key, value, 3600).await?;
    Ok(minute(value))
}

fn price_filter(id: &str, region: &str) -> Document {
    doc! {"offerId":{"$eq":id},"region":{"$eq":region}}
}

fn normalize(mut value: Value) -> Result<Value> {
    if value["price"].is_object() {
        value["price"]["basePayoutPrice"] = usd_cents(&value["price"], true);
    } else if js_truthy(&value["price"]) && !value["price"].is_array() {
        return Err(Error::Internal);
    }
    Ok(value)
}

async fn price(
    State(state): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Response> {
    let country = selected_country(&uri, &headers);
    let region = region(&country).ok_or_else(|| not_found("Country not found"))?;
    let offer = one(&state, "offers", doc! {"id":{"$eq":&id}})
        .await?
        .ok_or_else(|| not_found("Price not found"))?;
    let available = availability(&offer);
    if !is_price_country_eligible(&available, &country) {
        return Err(not_found("Price not found"));
    }
    let key = format!(
        "price:{id}:{region}:{}:v0.3",
        price_availability_key(&available)
    );
    if let Some(hit) = cached(&state, &key).await? {
        return Ok(minute(&hit));
    }
    let value = one(&state, "pricev2", price_filter(&id, region))
        .await?
        .ok_or_else(|| not_found("Price not found"))?;
    save(&state, &key, &normalize(value)?).await
}

async fn fairness(
    State(state): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Response> {
    let country = selected_country(&uri, &headers);
    let key = format!("price-fairness:{id}:{country}:v0.1");
    if let Some(hit) = cached(&state, &key).await? {
        return Ok(minute(&hit));
    }
    let value = one(
        &state,
        "offer_country_pricing_scores",
        doc! {"offerId":{"$eq":&id},"country":{"$eq":country}},
    )
    .await?
    .ok_or_else(|| not_found("Price fairness score not found"))?;
    save(&state, &key, &value).await
}

fn sorted(sort: Document) -> MongoFindOptions {
    MongoFindOptions {
        sort: Some(sort),
        ..Default::default()
    }
}

/// Legacy routes use V8's Date constructor on query strings. Preserve the raw
/// cache key independently from this instant used in Mongo predicates.
pub(super) fn legacy_date(raw: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    use chrono::{NaiveDate, TimeZone, Utc};
    let text = egdata_core::v1::trim_js_whitespace(raw);
    if let Some(date) = cursor_date(text) {
        return Some(date);
    }
    // Non-ISO calendar dates use local time unless the caller gives a zone.
    let (text, utc) = text
        .strip_suffix(" GMT")
        .or_else(|| text.strip_suffix(" UTC"))
        .map_or((text, false), |s| (s, true));
    let date = [
        "%m/%d/%Y",
        "%Y/%m/%d",
        "%b %e, %Y",
        "%B %e, %Y",
        "%d %b %Y",
        "%d %B %Y",
    ]
    .iter()
    .find_map(|fmt| NaiveDate::parse_from_str(text, fmt).ok())?;
    let midnight = date.and_hms_opt(0, 0, 0)?;
    if utc {
        Some(midnight.and_utc())
    } else {
        chrono::Local
            .from_local_datetime(&midnight)
            .earliest()
            .map(|d| d.with_timezone(&Utc))
    }
}

fn since_date(raw: &str) -> bson::DateTime {
    // The JS BSON driver encodes an invalid Date as a zero timestamp.
    bson::DateTime::from_millis(legacy_date(raw).map_or(0, |x| x.timestamp_millis()))
}

async fn history(
    State(state): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
) -> Result<Response> {
    let requested = query(&uri, "region").filter(|v| !v.is_empty()).or_else(|| {
        query(&uri, "country")
            .as_deref()
            .and_then(region)
            .map(str::to_owned)
    });
    let since = query(&uri, "since");
    let key = format!(
        "price-history:{id}:{}:{}:v0.1",
        requested.as_deref().unwrap_or("all"),
        since.as_deref().unwrap_or("unlimited")
    );
    if let Some(hit) = cached(&state, &key).await? {
        return Ok(if requested.is_some() {
            minute(&hit)
        } else {
            ok(&hit)
        });
    }
    let mut filter = doc! {"offerId":id};
    match &requested {
        Some(code) => {
            filter.insert("region", code);
        }
        None => {
            filter.insert(
                "region",
                doc! {"$in": REGIONS.iter().map(|(k,_)|*k).collect::<Vec<_>>()},
            );
        }
    }
    if let Some(since) = since.filter(|v| !v.is_empty()) {
        filter.insert("updatedAt", doc! {"$gte":since_date(&since)});
    }
    let rows = state
        .mongo
        .find_many("pricev2_historical", filter, sorted(doc! {"date":-1}))
        .await?;
    if requested.is_some() {
        let value = Value::Array(rows.iter().map(bson_doc_to_js_json).collect());
        return save(&state, &key, &value).await;
    }
    let mut grouped = serde_json::Map::new();
    for row in rows {
        let Some(region) = row.get("region").filter(|r| js_truthy(&bson_to_js_json(r))) else {
            continue;
        };
        let Some(code) = stored_identifier(region) else {
            continue;
        };
        grouped
            .entry(code)
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .unwrap()
            .push(bson_doc_to_js_json(&row));
    }
    if grouped.is_empty() {
        return Ok(ok(&json!({})));
    }
    save(&state, &key, &Value::Object(grouped)).await
}

async fn regional_history(
    state: &AppState,
    offer: &Document,
    id: &str,
    region: Option<&str>,
) -> Result<Vec<Document>> {
    let mut base = doc! {"offerId":id};
    if let Some(code) = region {
        base.insert("region", code);
    }
    let mut filter = base.clone();
    let release = offer
        .get("releaseDate")
        .filter(|v| !matches!(v, Bson::Null))
        .or_else(|| offer.get("effectiveDate"));
    let now = bson::DateTime::from_chrono((state.now)());
    if let Some(release) = release
        && js_truthy(&bson_to_js_json(release))
        && stored_number(release) <= now.timestamp_millis() as f64
    {
        let mut bounds = doc! {"$gte":release};
        if region.is_some() {
            bounds.insert("$lte", now);
        }
        filter.insert("updatedAt", bounds);
    }
    let options = sorted(doc! {"updatedAt":-1});
    let rows = state
        .mongo
        .find_many("pricev2_historical", filter, options.clone())
        .await?;
    if rows.is_empty() {
        Ok(state
            .mongo
            .find_many("pricev2_historical", base, options)
            .await?)
    } else {
        Ok(rows)
    }
}

async fn regional(
    State(state): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
) -> Result<Response> {
    let country = query(&uri, "country").filter(|v| !v.is_empty());
    let offer = state
        .mongo
        .find_one("offers", doc! {"id":{"$eq":&id}}, None)
        .await?
        .ok_or_else(|| not_found("Price not found"))?;
    let available = availability(&bson_doc_to_js_json(&offer));
    if country
        .as_deref()
        .is_some_and(|c| !is_price_country_eligible(&available, c))
    {
        return Err(not_found("Price not found"));
    }
    let region = country
        .as_deref()
        .map(|c| region(c).ok_or_else(|| not_found("Country not found")))
        .transpose()?;
    let key = format!(
        "regional-price:{id}:{}:{}:v0.5",
        region.unwrap_or("all"),
        price_availability_key(&available)
    );
    if let Some(hit) = cached(&state, &key).await? {
        return Ok(minute(&hit));
    }
    let result = if let Some(code) = region {
        let live = state
            .mongo
            .find_one("pricev2", price_filter(&id, code), None)
            .await?;
        let historical = regional_history(&state, &offer, &id, Some(code)).await?;
        let current = live
            .as_ref()
            .or(historical.first())
            .ok_or_else(|| not_found("Price not found"))?;
        price_summary(
            PriceFormat::Legacy,
            current,
            &historical.iter().collect::<Vec<_>>(),
            live.as_ref(),
        )?
    } else {
        let live = state
            .mongo
            .find_many("pricev2", doc! {"offerId":{"$eq":&id}}, Default::default())
            .await?;
        let historical = regional_history(&state, &offer, &id, None).await?;
        let mut out = serde_json::Map::new();
        for &(code, _) in REGIONS {
            if !is_price_region_eligible(&available, code) {
                continue;
            }
            let current_live = live.iter().find(|r| r.get_str("region").ok() == Some(code));
            let mut rows: Vec<_> = historical
                .iter()
                .filter(|r| r.get_str("region").ok() == Some(code))
                .collect();
            if current_live.is_none() && rows.len() > 1 {
                if rows.iter().any(|r| r.get_datetime("updatedAt").is_err()) {
                    return Err(Error::Internal);
                }
                rows.sort_by_key(|r| {
                    std::cmp::Reverse(r.get_datetime("updatedAt").unwrap().timestamp_millis())
                });
            }
            if let Some(current) = current_live.or(rows.first().copied()) {
                out.insert(
                    code.to_owned(),
                    price_summary(PriceFormat::Legacy, current, &rows, current_live)?,
                );
            }
        }
        Value::Object(out)
    };
    save(&state, &key, &result).await
}

async fn stats(
    State(state): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Response> {
    let country = selected_country(&uri, &headers);
    let region = region(&country).ok_or_else(|| not_found("Country not found"))?;
    let offer = one(&state, "offers", doc! {"id":{"$eq":&id}})
        .await?
        .ok_or_else(|| not_found("Offer not found"))?;
    let filter = price_filter(&id, region);
    let mut discounted = filter.clone();
    discounted.insert("price.discount", doc! {"$gt":0});
    let (current, lowest, last) = tokio::join!(biased;
        state
            .mongo
            .find_one_with_options("pricev2", filter, sorted(doc! {"updatedAt":-1})),
        state.mongo.find_one_with_options(
            "pricev2_historical",
            discounted.clone(),
            sorted(doc! {"price.discountPrice":1})
        ),
        state.mongo.find_one_with_options(
            "pricev2_historical",
            discounted,
            sorted(doc! {"updatedAt":-1})
        ),
    );
    let to_json = |row: Option<Document>| {
        row.as_ref()
            .map(bson_doc_to_js_json)
            .map(normalize)
            .transpose()
    };
    Ok(ok(
        &json!({"current":to_json(current?.filter(|_|is_price_country_eligible(&availability(&offer),&country)))?,"lowest":to_json(lowest?)?,"lastDiscount":to_json(last?)?}),
    ))
}

async fn requirements(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let offer = one(&state, "offers", doc! {"id":&id})
        .await?
        .ok_or_else(|| not_found("Offer not found"))?;
    let namespace = offer["namespace"].as_str().unwrap_or_default();
    let (windows, macos) = tokio::try_join!(
        resolve_requirements(&state, namespace, &id, "windows"),
        resolve_requirements(&state, namespace, &id, "macos")
    )?;
    if windows.is_null() && macos.is_null() {
        return Err(not_found("Offer requirements not found"));
    }
    Ok(minute(&json!({"windows":windows,"macos":macos})))
}

async fn reviews_summary(
    State(state): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
) -> Result<Response> {
    let verified = query(&uri, "verified");
    let key = format!(
        "reviews-summary:{id}:{}",
        verified.as_deref().unwrap_or("undefined")
    );
    if let Some(hit) = cached(&state, &key).await? {
        return Ok(minute(&hit));
    }
    let mut filter = doc! {"id":id};
    match verified.as_deref() {
        Some("true") | Some("false") => {
            filter.insert("verified", verified.as_deref() == Some("true"));
        }
        _ => (),
    }
    let rows = many(&state, "reviews", filter, Default::default()).await?;
    if rows.is_empty() {
        return Ok(ok(
            &json!({"totalReviews":0,"averageRating":0,"recommendedPercentage":0,"notRecommendedPercentage":0}),
        ));
    }
    let count = rows.len() as f64;
    let sum = rows
        .iter()
        .map(|v| {
            if v.get("rating") == Some(&Value::Null) {
                0.0
            } else {
                v["rating"].as_f64().unwrap_or(f64::NAN)
            }
        })
        .sum::<f64>();
    let yes = rows
        .iter()
        .filter(|v| match &v["recommended"] {
            Value::Null => false,
            Value::Bool(x) => *x,
            Value::String(x) => !x.is_empty(),
            Value::Number(n) => n.as_f64() != Some(0.0),
            _ => true,
        })
        .count() as f64;
    save(&state,&key,&json!({"overallScore":sum/count,"recommendedPercentage":yes/count,"notRecommendedPercentage":(count-yes)/count,"totalReviews":rows.len()})).await
}
