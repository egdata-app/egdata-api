//! `/v1` system, native sitemap/robots, assets, stats, franchises, and game-awards routes.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::Duration;

use axum::{
    Extension, Router,
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri},
    response::Response,
};
use bson::{Bson, Document, doc};
use chrono::{DateTime, Datelike, TimeZone, Utc};
use egdata_core::localization::{
    apply_offer_localization_fields, get_offer_localization_entity_id,
};
use egdata_core::ports::MongoFindOptions;
use egdata_core::sitemap::{OFFER_SITEMAP_PAGE_LIMIT, get_offer_sitemap_entries};
use egdata_core::v1::{
    CursorBinding, CursorSortValue, MAX_PAGE_LIMIT, MongoSortField, NullsOrder, ProblemError,
    SortDirection, bson_to_serialized_json, country_and_region, decode_cursor_with,
    encode_cursor_with, iso_or_null, mongo_keyset_filter, mongo_sort_spec, page_meta,
    parse_integer, parse_pagination_map, regional_params, require_id_param, serialize_offer,
    string_id, trim_page,
};
use serde_json::{Map, Value, json};

use crate::state::AppState;
use crate::v1::helpers::{
    V1ErrorResponse, V1RequestContext, json_success, parse_strict_query_uri, v1_cache_get,
    v1_cache_key, v1_cache_set,
};

const XML_CACHE_CONTROL: &str = "private, max-age=3600, stale-while-revalidate=604800";
const SITEMAP_PAGE_SIZE: usize = 1_000;
const ASSET_CACHE_TTL_SECONDS: u64 = 60 * 60;
const STATS_CACHE_TTL_SECONDS: u64 = 60 * 60;
const AGGREGATE_CACHE_TTL_SECONDS: u64 = 60 * 60 * 24;
const FRANCHISE_CACHE_TTL_SECONDS: u64 = 60 * 60;
const FRANCHISE_OFFER_ORDERING: &str = "releaseDate:desc,id:asc";
const GAME_AWARDS_EVENT_SLUG: &str = "the-game-awards";

/// Builds the `/v1` system, sitemap, asset, stats, franchise, and game-awards router.
pub fn router() -> Router<AppState> {
    route_group("").router
}

pub fn route_group(prefix: &str) -> super::RouteGroup {
    super::RouteGroup::new(prefix)
        .get("/health", get_health)
        .get("/robots.txt", get_robots_txt)
        .get("/sitemap.xml", get_offers_sitemap)
        .get("/items-sitemap.xml", get_items_sitemap_hyphen)
        .get("/items/sitemap.xml", get_items_sitemap_slash)
        .get("/promotions-sitemap.xml", get_promotions_sitemap)
        .get("/profiles/sitemap.xml", get_profiles_sitemap)
        .get("/sandboxes/sitemap.xml", get_sandboxes_sitemap)
        .get("/assets/{id}", get_asset_by_id)
        .get("/stats", get_stats)
        .get("/stats/releases/monthly", get_stats_releases_monthly)
        .get("/stats/releases/yearly", get_stats_releases_yearly)
        .get("/stats/creations/monthly", get_stats_creations_monthly)
        .get("/stats/creations/yearly", get_stats_creations_yearly)
        .get("/stats/homepage", get_stats_homepage)
        .get("/franchises/{slug}", get_franchise_by_slug)
        .get("/game-awards", get_game_awards)
}

pub(crate) fn extract_request_id(
    ctx: Option<&Extension<V1RequestContext>>,
    headers: &HeaderMap,
) -> String {
    if let Some(Extension(v1)) = ctx {
        return v1.request_id.clone();
    }
    headers
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}

pub(crate) fn err_resp(error: ProblemError, uri: &Uri, request_id: String) -> V1ErrorResponse {
    V1ErrorResponse {
        error,
        path: uri.path().to_string(),
        request_id: (!request_id.is_empty()).then_some(request_id),
    }
}

pub(crate) fn internal_error() -> ProblemError {
    ProblemError::new(
        500,
        "INTERNAL_ERROR",
        "The API could not complete the request. Retry later and include the request ID when contacting support.",
    )
}

pub(crate) fn docs_to_json(docs: Vec<Document>) -> Vec<Value> {
    docs.into_iter()
        .map(|d| bson_to_serialized_json(&Bson::Document(d)))
        .collect()
}

pub(crate) fn doc_to_json(doc: Document) -> Value {
    bson_to_serialized_json(&Bson::Document(doc))
}

pub(crate) fn prepare_offer_for_localization(raw: &Value) -> Value {
    serialize_offer(raw, None, false)
}

pub(crate) async fn fetch_prices_by_offer_id(
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

async fn read_prices_by_offer_id(
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

pub(crate) async fn offer_localization_documents(
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

async fn read_offer_localizations_by_id(
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

pub(super) fn cached_length(value: &Value) -> Option<Value> {
    match value {
        Value::String(text) => Some(json!(text.encode_utf16().count())),
        Value::Array(rows) => Some(json!(rows.len())),
        other => other.get("length").cloned(),
    }
}

/// Both BSON string types are read by the Node driver as JavaScript strings.
pub(super) fn stored_text(value: &Bson) -> Option<&str> {
    match value {
        Bson::String(text) | Bson::Symbol(text) => Some(text),
        _ => None,
    }
}

pub(super) async fn localize_ordered_rows(
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

pub(super) async fn regional_offer_prices(
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

pub(super) fn serialize_localized_offer(
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
pub(super) fn serialize_stored_localized_offer(
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

pub(super) async fn serialize_priced_offers(
    state: &AppState,
    rows: &[Document],
    prices: &[Document],
    locale: &str,
) -> Result<(Vec<Value>, Value), ProblemError> {
    use super::helpers::primitive_id;
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

pub(crate) async fn localize_offers(
    state: &AppState,
    offers: &[Value],
    locale: &str,
) -> Result<Vec<Value>, ProblemError> {
    localize_offers_with_keys(state, offers, locale, |_, offer| {
        get_offer_localization_entity_id(offer)
    })
    .await
}

pub(super) async fn localize_offers_with_keys(
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
pub(super) fn stored_string_key(value: Option<&Bson>) -> Result<String, ProblemError> {
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

pub(crate) fn cursor_date_bson(value: &CursorSortValue) -> Bson {
    match value {
        CursorSortValue::Null => Bson::Null,
        CursorSortValue::String(s) => match DateTime::parse_from_rfc3339(s) {
            Ok(dt) => Bson::DateTime(bson::DateTime::from_chrono(dt.with_timezone(&Utc))),
            Err(_) => Bson::String(s.clone()),
        },
        CursorSortValue::Number(n) => number_to_bson(n),
    }
}

pub(crate) fn cursor_scalar_bson(value: &CursorSortValue) -> Bson {
    match value {
        CursorSortValue::Null => Bson::Null,
        CursorSortValue::String(s) => Bson::String(s.clone()),
        CursorSortValue::Number(n) => number_to_bson(n),
    }
}

fn number_to_bson(n: &serde_json::Number) -> Bson {
    if let Some(i) = n.as_i64() {
        Bson::Int64(i)
    } else {
        Bson::Double(n.as_f64().unwrap())
    }
}

fn native_response(
    method: &Method,
    request_id: &str,
    content_type: &'static str,
    body_str: String,
) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static("content-type"),
        HeaderValue::from_static(content_type),
    );
    headers.insert(
        HeaderName::from_static("cache-control"),
        HeaderValue::from_static(XML_CACHE_CONTROL),
    );
    headers.insert(
        HeaderName::from_static("cdn-cache-control"),
        HeaderValue::from_static("no-store"),
    );
    headers.insert(
        HeaderName::from_static("cloudflare-cdn-cache-control"),
        HeaderValue::from_static("no-store"),
    );
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    if !request_id.is_empty()
        && let Ok(val) = HeaderValue::from_str(request_id)
    {
        headers.insert(HeaderName::from_static("x-request-id"), val);
    }

    let body = if *method == Method::HEAD {
        Body::empty()
    } else {
        Body::from(body_str)
    };
    let mut resp = Response::new(body);
    *resp.status_mut() = StatusCode::OK;
    *resp.headers_mut() = headers;
    resp
}

fn xml_response(method: &Method, request_id: &str, body: String) -> Response {
    native_response(method, request_id, "application/xml; charset=utf-8", body)
}

fn sitemap_index_xml(urls: &[String]) -> String {
    let entries: Vec<String> = urls
        .iter()
        .map(|u| format!("  <sitemap><loc>{u}</loc></sitemap>"))
        .collect();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<sitemapindex xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n{}\n</sitemapindex>",
        entries.join("\n")
    )
}

fn string_field(row: &Value, key: &str) -> String {
    row.get(key)
        .map(egdata_core::v1::serialization::js_string)
        .unwrap_or_else(|| "undefined".into())
}
pub(crate) use egdata_core::v1::serialization::js_truthy;

// Native Node handlers omit lastmod for falsy values and call new Date(value).toISOString() otherwise.
pub(super) fn sitemap_date(value: Option<&Value>) -> Result<Option<String>, ProblemError> {
    let Some(value) = value.filter(|value| js_truthy(value)) else {
        return Ok(None);
    };
    let milliseconds = match value {
        Value::Number(number) => number.as_f64(),
        Value::Bool(true) => Some(1.),
        _ => None,
    };
    if let Some(ms) = milliseconds {
        return sitemap_timestamp(ms).map(Some);
    }
    let text = egdata_core::v1::serialization::js_string(value);
    let iso = iso_or_null(&Value::String(text))
        .and_then(|text| DateTime::parse_from_rfc3339(&text).ok())
        .map(|date| egdata_core::v1::serialization::js_iso_datetime(date.to_utc()))
        .ok_or_else(internal_error)?;
    Ok(Some(iso))
}

fn sitemap_timestamp(milliseconds: f64) -> Result<String, ProblemError> {
    egdata_core::v1::serialization::js_iso_millis(milliseconds as i64).ok_or_else(internal_error)
}

fn stored_sitemap_date(value: Option<&Bson>) -> Result<Option<String>, ProblemError> {
    if let Some(Bson::DateTime(date)) = value {
        // Even an invalid JS Date is truthy. The native handler then calls toISOString().
        return egdata_infra::bson_json::bson_datetime_to_iso_string(*date)
            .map(Some)
            .ok_or_else(internal_error);
    }
    sitemap_date(value.map(egdata_infra::bson_json::bson_to_js_json).as_ref())
}

fn sitemap_id(doc: &Document, key: &str) -> String {
    doc.get(key).map_or_else(
        || "undefined".into(),
        |value| {
            egdata_core::v1::serialization::stored_identifier(value)
                .unwrap_or_else(|| "null".into())
        },
    )
}

async fn ping_with_timeout<F>(fut: F, now: fn() -> DateTime<Utc>) -> (&'static str, Option<i64>)
where
    F: std::future::Future<Output = Result<bool, egdata_core::error::CoreError>>,
{
    let start = now().timestamp_millis();
    match tokio::time::timeout(Duration::from_millis(1_500), fut).await {
        Ok(Ok(true)) => ("ok", Some(now().timestamp_millis() - start)),
        _ => ("error", None),
    }
}

async fn get_health(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let req_id = extract_request_id(ctx.as_ref(), &headers);
    parse_strict_query_uri(&uri, &[]).map_err(|e| err_resp(e, &uri, req_id.clone()))?;

    let (redis_status, redis_latency) =
        ping_with_timeout(state.saved_queries.ping(), state.now).await;
    let (mongo_status, mongo_latency) = ping_with_timeout(state.mongo.ping(), state.now).await;
    let ok = redis_status == "ok" && mongo_status == "ok";

    let mut resp = json_success(
        &method,
        uri.path(),
        &req_id,
        json!({
            "status": if ok { "ok" } else { "error" },
            "services": {
                "redis": { "status": redis_status, "latencyMs": redis_latency },
                "mongodb": { "status": mongo_status, "latencyMs": mongo_latency },
            }
        }),
        Some(json!({ "apiVersion": "v1" })),
    );
    *resp.status_mut() = if ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    resp.headers_mut().insert(
        HeaderName::from_static("cache-control"),
        HeaderValue::from_static("public, max-age=60"),
    );
    Ok(resp)
}

async fn get_robots_txt(
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let req_id = extract_request_id(ctx.as_ref(), &headers);
    parse_strict_query_uri(&uri, &[]).map_err(|e| err_resp(e, &uri, req_id.clone()))?;

    let robots = "\
User-agent: *
Disallow: /
Allow: /v1/sitemap.xml
Allow: /v1/sitemap.xml?*
Allow: /v1/items-sitemap.xml
Allow: /v1/items-sitemap.xml?*
Allow: /v1/promotions-sitemap.xml
Allow: /v1/profiles/sitemap.xml
Allow: /v1/sandboxes/sitemap.xml
Allow: /v1/sandboxes/sitemap.xml?*
Allow: /v1/items/sitemap.xml
Allow: /v1/items/sitemap.xml?*
Allow: /v1/offers/*/og
Allow: /v1/sandboxes/*/og
";
    Ok(native_response(
        &method,
        &req_id,
        "text/plain; charset=utf-8",
        robots.to_string(),
    ))
}

async fn get_offers_sitemap(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let req_id = extract_request_id(ctx.as_ref(), &headers);
    let query =
        parse_strict_query_uri(&uri, &["page"]).map_err(|e| err_resp(e, &uri, req_id.clone()))?;
    let page = parse_integer(query.get("page").map(String::as_str), "page", Some(1), None)
        .map_err(|e| err_resp(e, &uri, req_id.clone()))?;

    let Some(page) = page else {
        let count = state
            .mongo
            .count_documents("offers", doc! {})
            .await
            .map_err(|_| err_resp(internal_error(), &uri, req_id.clone()))?;
        let pages = (count as usize).div_ceil(OFFER_SITEMAP_PAGE_LIMIT);
        let base = &state.config.v1_public_base_url;
        let urls: Vec<String> = (0..pages)
            .map(|i| format!("{base}/sitemap.xml?page={}", i + 1))
            .collect();
        return Ok(xml_response(&method, &req_id, sitemap_index_xml(&urls)));
    };

    let skip = ((page as u64) - 1).saturating_mul(OFFER_SITEMAP_PAGE_LIMIT as u64);
    let docs = state
        .mongo
        .find_many(
            "offers",
            doc! {},
            MongoFindOptions {
                projection: Some(doc! { "id": 1, "lastModifiedDate": 1 }),
                sort: Some(doc! { "lastModifiedDate": -1 }),
                collation: None,
                skip: Some(skip),
                limit: Some(OFFER_SITEMAP_PAGE_LIMIT as i64),
            },
        )
        .await
        .map_err(|_| err_resp(internal_error(), &uri, req_id.clone()))?;

    let mut urls = Vec::new();
    for doc in docs {
        let lastmod = stored_sitemap_date(doc.get("lastModifiedDate"))
            .map_err(|error| err_resp(error, &uri, req_id.clone()))?;
        let offer_id = sitemap_id(&doc, "id");
        for entry in get_offer_sitemap_entries(&offer_id) {
            let alternates: Vec<String> = entry
                .alternates
                .iter()
                .map(|alt| {
                    format!(
                        "    <xhtml:link rel=\"alternate\" hreflang=\"{}\" href=\"{}\" />",
                        alt.hreflang, alt.href
                    )
                })
                .collect();
            let lastmod_line = lastmod
                .as_ref()
                .map(|m| format!("    <lastmod>{m}</lastmod>"))
                .unwrap_or_default();
            urls.push(format!(
                "  <url>\n    <loc>{}</loc>\n{}\n{}\n  </url>",
                entry.loc,
                alternates.join("\n"),
                lastmod_line
            ));
        }
    }

    let body = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\" xmlns:xhtml=\"http://www.w3.org/1999/xhtml\">\n{}\n</urlset>",
        urls.join("\n")
    );
    Ok(xml_response(&method, &req_id, body))
}

async fn item_sitemap_handler(
    state: &AppState,
    method: &Method,
    uri: &Uri,
    req_id: &str,
    base: &str,
) -> Result<Response, V1ErrorResponse> {
    let query =
        parse_strict_query_uri(uri, &["page"]).map_err(|e| err_resp(e, uri, req_id.to_string()))?;
    let page = parse_integer(query.get("page").map(String::as_str), "page", Some(1), None)
        .map_err(|e| err_resp(e, uri, req_id.to_string()))?;

    let Some(page) = page else {
        let count = state
            .mongo
            .count_documents("items", doc! {})
            .await
            .map_err(|_| err_resp(internal_error(), uri, req_id.to_string()))?;
        let pages = (count as usize).div_ceil(SITEMAP_PAGE_SIZE);
        let urls: Vec<String> = (0..pages)
            .map(|i| format!("{base}?page={}", i + 1))
            .collect();
        return Ok(xml_response(method, req_id, sitemap_index_xml(&urls)));
    };

    let skip = ((page as u64) - 1).saturating_mul(SITEMAP_PAGE_SIZE as u64);
    let docs = state
        .mongo
        .find_many(
            "items",
            doc! {},
            MongoFindOptions {
                projection: Some(doc! { "id": 1, "lastModifiedDate": 1 }),
                sort: Some(doc! { "lastModifiedDate": -1 }),
                collation: None,
                skip: Some(skip),
                limit: Some(SITEMAP_PAGE_SIZE as i64),
            },
        )
        .await
        .map_err(|_| err_resp(internal_error(), uri, req_id.to_string()))?;

    let urls: Vec<String> = docs
        .into_iter()
        .map(|doc| {
            let lastmod = stored_sitemap_date(doc.get("lastModifiedDate"))
                .map_err(|error| err_resp(error, uri, req_id.to_string()))?;
            let id = sitemap_id(&doc, "id");
            let lastmod_line = lastmod
                .as_ref()
                .map(|m| format!("    <lastmod>{m}</lastmod>"))
                .unwrap_or_default();
            Ok(format!(
                "  <url>\n    <loc>https://egdata.app/items/{id}</loc>\n{lastmod_line}\n  </url>"
            ))
        })
        .collect::<Result<Vec<_>, V1ErrorResponse>>()?;

    let body = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n{}\n</urlset>",
        urls.join("\n")
    );
    Ok(xml_response(method, req_id, body))
}

async fn get_items_sitemap_hyphen(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let req_id = extract_request_id(ctx.as_ref(), &headers);
    let base = format!("{}/items-sitemap.xml", state.config.v1_public_base_url);
    item_sitemap_handler(&state, &method, &uri, &req_id, &base).await
}

async fn get_items_sitemap_slash(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let req_id = extract_request_id(ctx.as_ref(), &headers);
    let base = format!("{}/items/sitemap.xml", state.config.v1_public_base_url);
    item_sitemap_handler(&state, &method, &uri, &req_id, &base).await
}

async fn get_promotions_sitemap(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let req_id = extract_request_id(ctx.as_ref(), &headers);
    parse_strict_query_uri(&uri, &[]).map_err(|e| err_resp(e, &uri, req_id.clone()))?;

    let docs = state
        .mongo
        .find_many(
            "tags",
            doc! { "groupName": "event", "referenceCount": { "$gt": 0 } },
            MongoFindOptions::default(),
        )
        .await
        .map_err(|_| err_resp(internal_error(), &uri, req_id.clone()))?;

    let urls: Vec<String> = docs
        .into_iter()
        .map(|doc| {
            let val = doc_to_json(doc);
            let id = string_field(&val, "id");
            format!("  <url><loc>https://egdata.app/promotions/{id}</loc></url>")
        })
        .collect();

    let body = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n{}\n</urlset>",
        urls.join("\n")
    );
    Ok(xml_response(&method, &req_id, body))
}

async fn get_profiles_sitemap(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let req_id = extract_request_id(ctx.as_ref(), &headers);
    parse_strict_query_uri(&uri, &[]).map_err(|e| err_resp(e, &uri, req_id.clone()))?;

    let docs = state
        .mongo
        .find_many("epic", doc! {}, MongoFindOptions::default())
        .await
        .map_err(|_| err_resp(internal_error(), &uri, req_id.clone()))?;

    let urls: Vec<String> = docs
        .into_iter()
        .filter_map(|doc| {
            let val = doc_to_json(doc);
            val.get("accountId").filter(|id| js_truthy(id)).map(|id| {
                format!(
                    "  <url><loc>https://egdata.app/profile/{}</loc></url>",
                    egdata_core::v1::serialization::js_string(id)
                )
            })
        })
        .collect();

    let body = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n{}\n</urlset>",
        urls.join("\n")
    );
    Ok(xml_response(&method, &req_id, body))
}

async fn get_sandboxes_sitemap(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let req_id = extract_request_id(ctx.as_ref(), &headers);
    let query =
        parse_strict_query_uri(&uri, &["page"]).map_err(|e| err_resp(e, &uri, req_id.clone()))?;
    let page = parse_integer(query.get("page").map(String::as_str), "page", Some(1), None)
        .map_err(|e| err_resp(e, &uri, req_id.clone()))?;

    let Some(page) = page else {
        let count = state
            .mongo
            .count_documents("sandboxes", doc! {})
            .await
            .map_err(|_| err_resp(internal_error(), &uri, req_id.clone()))?;
        let pages = (count as usize).div_ceil(SITEMAP_PAGE_SIZE);
        let base = &state.config.v1_public_base_url;
        let urls: Vec<String> = (0..pages)
            .map(|i| format!("{base}/sandboxes/sitemap.xml?page={}", i + 1))
            .collect();
        return Ok(xml_response(&method, &req_id, sitemap_index_xml(&urls)));
    };

    let skip = ((page as u64) - 1).saturating_mul(SITEMAP_PAGE_SIZE as u64);
    let docs = state
        .mongo
        .find_many(
            "sandboxes",
            doc! {},
            MongoFindOptions {
                projection: None,
                sort: Some(doc! { "lastModified": -1 }),
                collation: None,
                skip: Some(skip),
                limit: Some(SITEMAP_PAGE_SIZE as i64),
            },
        )
        .await
        .map_err(|_| err_resp(internal_error(), &uri, req_id.clone()))?;

    let sections = ["", "/items", "/offers", "/assets", "/achievements"];
    let mut urls = Vec::new();
    for doc in docs {
        let lastmod_tag = stored_sitemap_date(doc.get("updated"))
            .map_err(|error| err_resp(error, &uri, req_id.clone()))?
            .map(|d| format!("<lastmod>{d}</lastmod>"))
            .unwrap_or_default();
        let id = sitemap_id(&doc, "_id");
        let base_url = format!("https://egdata.app/sandboxes/{id}");
        for section in sections {
            urls.push(format!(
                "  <url><loc>{base_url}{section}</loc>{lastmod_tag}</url>"
            ));
        }
    }

    let body = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n{}\n</urlset>",
        urls.join("\n")
    );
    Ok(xml_response(&method, &req_id, body))
}

async fn get_asset_by_id(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let req_id = extract_request_id(ctx.as_ref(), &headers);
    let id =
        require_id_param(Some(&raw_id), "id").map_err(|e| err_resp(e, &uri, req_id.clone()))?;

    let cache_key = v1_cache_key("assets.detail", &BTreeMap::from([("id", json!(id))]));
    if let Some(hit) = v1_cache_get(state.cache.as_ref(), &cache_key).await
        && !hit.is_null()
    {
        return Ok(json_success(&method, uri.path(), &req_id, hit, None));
    }

    let doc = state
        .mongo
        .find_one("assets", doc! { "artifactId": { "$eq": &id } }, None)
        .await
        .map_err(|_| err_resp(internal_error(), &uri, req_id.clone()))?
        .ok_or_else(|| {
            err_resp(
                egdata_core::v1::not_found(
                    "ASSET_NOT_FOUND",
                    format!("No asset with artifact ID '{id}' exists."),
                ),
                &uri,
                req_id.clone(),
            )
        })?;

    let asset = doc_to_json(doc);
    v1_cache_set(
        state.cache.as_ref(),
        &cache_key,
        &asset,
        ASSET_CACHE_TTL_SECONDS,
    )
    .await;
    Ok(json_success(&method, uri.path(), &req_id, asset, None))
}

async fn count_or_zero(state: &AppState, collection: &str, filter: Document) -> u64 {
    state
        .mongo
        .count_documents(collection, filter)
        .await
        .unwrap_or(0)
}

pub(crate) async fn stats_counts(state: &AppState, legacy: bool) -> Value {
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

async fn get_stats(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let req_id = extract_request_id(ctx.as_ref(), &headers);
    let cache_key = v1_cache_key("stats.counts", &BTreeMap::new());
    if let Some(hit) = v1_cache_get(state.cache.as_ref(), &cache_key).await
        && !hit.is_null()
    {
        return Ok(json_success(&method, uri.path(), &req_id, hit, None));
    }

    let data = stats_counts(&state, false).await;
    v1_cache_set(
        state.cache.as_ref(),
        &cache_key,
        &data,
        STATS_CACHE_TTL_SECONDS,
    )
    .await;
    Ok(json_success(&method, uri.path(), &req_id, data, None))
}

pub(crate) fn date_stats_pipeline(
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

async fn run_date_stats(
    state: &AppState,
    method: &Method,
    uri: &Uri,
    req_id: &str,
    cache_op: &str,
    fields: (&str, &str),
    monthly: bool,
) -> Result<Response, V1ErrorResponse> {
    let (date_field, count_field) = fields;
    let cache_key = v1_cache_key(cache_op, &BTreeMap::new());
    if let Some(hit) = v1_cache_get(state.cache.as_ref(), &cache_key).await
        && !hit.is_null()
    {
        return Ok(json_success(method, uri.path(), req_id, hit, None));
    }

    let rows = state
        .mongo
        .aggregate(
            "offers",
            date_stats_pipeline(date_field, count_field, monthly, (state.now)()),
        )
        .await
        .map_err(|_| err_resp(internal_error(), uri, req_id.to_string()))?;

    let data = Value::Array(docs_to_json(rows));
    v1_cache_set(
        state.cache.as_ref(),
        &cache_key,
        &data,
        AGGREGATE_CACHE_TTL_SECONDS,
    )
    .await;
    Ok(json_success(method, uri.path(), req_id, data, None))
}

async fn get_stats_releases_monthly(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let req_id = extract_request_id(ctx.as_ref(), &headers);
    run_date_stats(
        &state,
        &method,
        &uri,
        &req_id,
        "stats.releases.monthly",
        ("releaseDate", "releases"),
        true,
    )
    .await
}

async fn get_stats_releases_yearly(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let req_id = extract_request_id(ctx.as_ref(), &headers);
    run_date_stats(
        &state,
        &method,
        &uri,
        &req_id,
        "stats.releases.yearly",
        ("releaseDate", "releases"),
        false,
    )
    .await
}

async fn get_stats_creations_monthly(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let req_id = extract_request_id(ctx.as_ref(), &headers);
    run_date_stats(
        &state,
        &method,
        &uri,
        &req_id,
        "stats.creations.monthly",
        ("creationDate", "creations"),
        true,
    )
    .await
}

async fn get_stats_creations_yearly(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let req_id = extract_request_id(ctx.as_ref(), &headers);
    run_date_stats(
        &state,
        &method,
        &uri,
        &req_id,
        "stats.creations.yearly",
        ("creationDate", "creations"),
        false,
    )
    .await
}

pub(crate) async fn homepage_counts(state: &AppState, region: &str) -> Value {
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

async fn get_stats_homepage(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let req_id = extract_request_id(ctx.as_ref(), &headers);
    let raw_country = uri.query().and_then(|q| {
        url::form_urlencoded::parse(q.as_bytes())
            .find(|(k, _)| k == "country")
            .map(|(_, v)| v.into_owned())
    });
    let cr = country_and_region(raw_country.as_deref())
        .map_err(|e| err_resp(e, &uri, req_id.clone()))?;
    let region = cr.region;

    let cache_key = v1_cache_key(
        "stats.homepage",
        &BTreeMap::from([("region", json!(region))]),
    );
    if let Some(hit) = v1_cache_get(state.cache.as_ref(), &cache_key).await
        && !hit.is_null()
    {
        return Ok(json_success(&method, uri.path(), &req_id, hit, None));
    }

    let data = homepage_counts(&state, &region).await;
    v1_cache_set(
        state.cache.as_ref(),
        &cache_key,
        &data,
        AGGREGATE_CACHE_TTL_SECONDS,
    )
    .await;
    Ok(json_success(&method, uri.path(), &req_id, data, None))
}

async fn get_franchise_by_slug(
    State(state): State<AppState>,
    Path(raw_slug): Path<String>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let req_id = extract_request_id(ctx.as_ref(), &headers);
    let query = parse_strict_query_uri(&uri, &["limit", "cursor", "country", "locale"])
        .map_err(|e| err_resp(e, &uri, req_id.clone()))?;
    let rp = regional_params(
        query.get("country").map(String::as_str),
        query.get("locale").map(String::as_str),
    )
    .map_err(|e| err_resp(e, &uri, req_id.clone()))?;
    let pg = parse_pagination_map(&query, MAX_PAGE_LIMIT)
        .map_err(|e| err_resp(e, &uri, req_id.clone()))?;
    let slug =
        require_id_param(Some(&raw_slug), "slug").map_err(|e| err_resp(e, &uri, req_id.clone()))?;

    let cache_key = v1_cache_key(
        "franchises.detail",
        &BTreeMap::from([
            ("slug", json!(slug)),
            ("country", json!(rp.country)),
            ("region", json!(rp.region)),
            ("locale", json!(rp.locale)),
            ("limit", json!(pg.limit)),
            (
                "cursor",
                pg.cursor.as_ref().map(|c| json!(c)).unwrap_or(Value::Null),
            ),
        ]),
    );
    if let Some(hit) = v1_cache_get(state.cache.as_ref(), &cache_key).await
        && !hit.is_null()
        && let (Some(data), Some(pagination)) = (hit.get("data"), hit.get("pagination"))
    {
        return Ok(json_success(
            &method,
            uri.path(),
            &req_id,
            data.clone(),
            Some(json!({ "pagination": pagination.clone() })),
        ));
    }

    let franchise_doc = state
        .mongo
        .find_one("franchises", doc! { "_id": &slug }, None)
        .await
        .map_err(|_| err_resp(internal_error(), &uri, req_id.clone()))?
        .ok_or_else(|| {
            err_resp(
                egdata_core::v1::not_found(
                    "FRANCHISE_NOT_FOUND",
                    format!("No franchise with slug '{slug}' exists."),
                ),
                &uri,
                req_id.clone(),
            )
        })?;

    let franchise = doc_to_json(franchise_doc);
    let id = franchise
        .get("_id")
        .filter(|id| !id.is_null())
        .or_else(|| franchise.get("id"))
        .map(string_id)
        .unwrap_or(Value::Null);
    let name = franchise.get("name").cloned().unwrap_or(Value::Null);
    let last_updated = franchise
        .get("lastUpdated")
        .and_then(iso_or_null)
        .map(Value::String)
        .unwrap_or(Value::Null);

    let offer_ids: Vec<String> = franchise
        .get("offers")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    let payload = if offer_ids.is_empty() {
        json!({
            "data": {
                "id": id,
                "name": name,
                "lastUpdated": last_updated,
                "elements": [],
                "stats": {
                    "totalTimeHastily": 0,
                    "totalTimeNormally": 0,
                    "totalTimeCompletely": 0,
                    "totalAchievements": 0,
                    "totalXp": 0,
                    "gamesCount": 0,
                }
            },
            "pagination": page_meta(pg.limit, false, None),
        })
    } else {
        let mut filters = BTreeMap::new();
        filters.insert("slug".to_string(), json!(slug));
        let binding = CursorBinding {
            operation: "franchises.detail".to_string(),
            filters: Some(filters),
            ordering: FRANCHISE_OFFER_ORDERING.to_string(),
            country: rp.country.clone(),
            locale: rp.locale.clone(),
            limit: pg.limit,
        };
        let sort = [
            MongoSortField::new("releaseDate", SortDirection::Desc, NullsOrder::Last),
            MongoSortField::new("id", SortDirection::Asc, NullsOrder::Last),
        ];
        let secret = state.config.v1_cursor_secret.as_deref();
        let now_ms = (state.now)().timestamp_millis();

        let offer_id_bsons: Vec<Bson> = offer_ids.iter().cloned().map(Bson::String).collect();
        let base_filter = doc! { "id": { "$in": offer_id_bsons.clone() } };
        let filter = if let Some(ref raw_cursor) = pg.cursor {
            let last = decode_cursor_with(raw_cursor, &binding, secret, now_ms)
                .map_err(|e| err_resp(e, &uri, req_id.clone()))?;
            let tuple = last
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    if index == 0 {
                        cursor_date_bson(value)
                    } else {
                        cursor_scalar_bson(value)
                    }
                })
                .collect::<Vec<_>>();
            let ks = mongo_keyset_filter(&sort, &tuple)
                .map_err(|e| err_resp(e, &uri, req_id.clone()))?;
            doc! { "$and": [base_filter, ks] }
        } else {
            base_filter
        };

        let rows = state
            .mongo
            .find_many(
                "offers",
                filter,
                MongoFindOptions {
                    projection: None,
                    sort: Some(mongo_sort_spec(&sort)),
                    collation: None,
                    skip: None,
                    limit: Some(i64::from(pg.limit) + 1),
                },
            )
            .await
            .map_err(|_| err_resp(internal_error(), &uri, req_id.clone()))?;

        let raw_page = trim_page(rows, pg.limit as usize);
        let page_offer_ids = raw_page
            .items
            .iter()
            .map(|row| row.get("id").cloned().unwrap_or(Bson::Null))
            .collect();
        let trimmed = egdata_core::v1::TrimmedPage {
            has_more: raw_page.has_more,
            items: raw_page
                .items
                .into_iter()
                .map(|doc| egdata_infra::bson_json::bson_doc_to_js_json(&doc))
                .collect(),
        };
        let (prices_res, all_offers_res) = tokio::join!(
            read_prices_by_offer_id(&state, page_offer_ids, &rp.region),
            state.mongo.find_many(
                "offers",
                doc! { "id": { "$in": offer_id_bsons.clone() } },
                MongoFindOptions {
                    projection: Some(doc! { "id": 1, "namespace": 1 }),
                    ..Default::default()
                },
            ),
        );
        let price_map = prices_res.map_err(|e| err_resp(e, &uri, req_id.clone()))?;
        let all_offers_basic =
            all_offers_res.map_err(|_| err_resp(internal_error(), &uri, req_id.clone()))?;

        let prepared: Vec<Value> = trimmed
            .items
            .iter()
            .map(prepare_offer_for_localization)
            .collect();
        let localized = localize_offers(&state, &prepared, &rp.locale)
            .await
            .map_err(|e| err_resp(e, &uri, req_id.clone()))?;
        let elements: Vec<Value> = localized
            .iter()
            .map(|o| {
                let price = o
                    .get("id")
                    .and_then(Value::as_str)
                    .and_then(|oid| price_map.get(oid));
                serialize_offer(o, price, true)
            })
            .collect();

        let mut ns_set = HashSet::new();
        for doc in all_offers_basic {
            let val = doc_to_json(doc);
            if let Some(ns) = val
                .get("namespace")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                ns_set.insert(ns.to_string());
            }
        }
        let ns_bsons: Vec<Bson> = ns_set.iter().cloned().map(Bson::String).collect();

        let (ach_res, igdb_res) = tokio::join!(
            state.mongo.find_many(
                "achievementsets",
                doc! { "sandboxId": { "$in": ns_bsons }, "isBase": true },
                MongoFindOptions::default(),
            ),
            state.mongo.find_many(
                "igdbs",
                doc! { "offerId": { "$in": offer_id_bsons } },
                MongoFindOptions::default(),
            ),
        );
        let ach_sets = ach_res.map_err(|_| err_resp(internal_error(), &uri, req_id.clone()))?;
        let igdb_entries =
            igdb_res.map_err(|_| err_resp(internal_error(), &uri, req_id.clone()))?;

        let mut total_achievements: usize = 0;
        let mut total_xp: f64 = 0.0;
        for set in ach_sets {
            let val = doc_to_json(set);
            if let Some(arr) = val.get("achievements").and_then(Value::as_array) {
                total_achievements += arr.len();
                for ach in arr {
                    total_xp += js_number_or_zero(ach.get("xp"));
                }
            }
        }

        let mut time_hastily: f64 = 0.0;
        let mut time_normally: f64 = 0.0;
        let mut time_completely: f64 = 0.0;
        let mut unique_igdb_ids = HashSet::new();
        for igdb in igdb_entries {
            let val = doc_to_json(igdb);
            let igdb_id_key = match val.get("igdbId") {
                Some(v)
                    if !v.is_null() && *v != json!(0) && *v != json!("") && *v != json!(false) =>
                {
                    v.to_string()
                }
                _ => continue,
            };
            if let Some(ttb) = val.get("timeToBeat").and_then(Value::as_object)
                && unique_igdb_ids.insert(igdb_id_key)
            {
                time_hastily += js_number_or_zero(ttb.get("hastily"));
                time_normally += js_number_or_zero(ttb.get("normally"));
                time_completely += js_number_or_zero(ttb.get("completely"));
            }
        }

        let games_count = if unique_igdb_ids.is_empty() {
            ns_set.len()
        } else {
            unique_igdb_ids.len()
        };

        let next_cursor = trimmed
            .items
            .last()
            .filter(|_| trimmed.has_more)
            .map(|last| {
                let id = match &last["id"] {
                    Value::Number(n) => CursorSortValue::Number(n.clone()),
                    Value::String(text) => CursorSortValue::String(text.clone()),
                    _ => CursorSortValue::Null,
                };
                let tuple = [
                    last.get("releaseDate")
                        .and_then(iso_or_null)
                        .map(CursorSortValue::from)
                        .unwrap_or(CursorSortValue::Null),
                    id,
                ];
                encode_cursor_with(&binding, &tuple, secret, now_ms)
            })
            .transpose()
            .map_err(|e| err_resp(e, &uri, req_id.clone()))?;

        json!({
            "data": {
                "id": id,
                "name": name,
                "lastUpdated": last_updated,
                "elements": elements,
                "stats": {
                    "totalTimeHastily": json_num(time_hastily),
                    "totalTimeNormally": json_num(time_normally),
                    "totalTimeCompletely": json_num(time_completely),
                    "totalAchievements": total_achievements,
                    "totalXp": json_num(total_xp),
                    "gamesCount": games_count,
                }
            },
            "pagination": page_meta(pg.limit, trimmed.has_more, next_cursor),
        })
    };

    v1_cache_set(
        state.cache.as_ref(),
        &cache_key,
        &payload,
        FRANCHISE_CACHE_TTL_SECONDS,
    )
    .await;

    Ok(json_success(
        &method,
        uri.path(),
        &req_id,
        payload["data"].clone(),
        Some(json!({ "pagination": payload["pagination"].clone() })),
    ))
}

// Mirrors the JSON-relevant portion of Node Number(value) || 0 for franchise stats.
pub(crate) fn js_number_or_zero(value: Option<&Value>) -> f64 {
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

pub(super) fn js_primitive_string(value: &Value) -> String {
    if value.is_null() {
        String::new()
    } else {
        egdata_core::v1::serialization::js_string(value)
    }
}

pub(crate) use egdata_core::v1::serialization::js_string_number;

fn json_num(v: f64) -> Value {
    if v.fract() == 0.0 && v >= i64::MIN as f64 && v < i64::MAX as f64 {
        json!(v as i64)
    } else {
        json!(v)
    }
}

async fn get_game_awards(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let req_id = extract_request_id(ctx.as_ref(), &headers);
    let query = parse_strict_query_uri(&uri, &["country", "locale"])
        .map_err(|e| err_resp(e, &uri, req_id.clone()))?;
    let rp = regional_params(
        query.get("country").map(String::as_str),
        query.get("locale").map(String::as_str),
    )
    .map_err(|e| err_resp(e, &uri, req_id.clone()))?;

    let cache_key = v1_cache_key(
        "game-awards.modules",
        &BTreeMap::from([("region", json!(rp.region)), ("locale", json!(rp.locale))]),
    );
    let data = if let Some(hit) = v1_cache_get(state.cache.as_ref(), &cache_key).await
        && !hit.is_null()
    {
        hit
    } else {
        let modules_docs = state
            .mongo
            .find_many(
                "storefront-modules",
                doc! { "eventSlug": GAME_AWARDS_EVENT_SLUG },
                MongoFindOptions {
                    sort: Some(doc! { "moduleIndex": 1 }),
                    ..Default::default()
                },
            )
            .await
            .map_err(|_| err_resp(internal_error(), &uri, req_id.clone()))?;
        let modules = docs_to_json(modules_docs);

        let mut offer_ids = Vec::new();
        let mut seen = HashSet::new();
        for module in &modules {
            if let Some(offers) = module.get("offers").filter(|v| !v.is_null()) {
                let arr = offers
                    .as_array()
                    .ok_or_else(|| err_resp(internal_error(), &uri, req_id.clone()))?;
                for entry in arr {
                    if entry.is_null() {
                        return Err(err_resp(internal_error(), &uri, req_id.clone()));
                    }
                    if let Some(id) = entry.get("id").and_then(Value::as_str)
                        && seen.insert(id.to_string())
                    {
                        offer_ids.push(id.to_string());
                    }
                }
            }
        }

        let offer_id_bsons: Vec<Bson> = offer_ids.iter().cloned().map(Bson::String).collect();
        let (offers_res, prices_res) = tokio::join!(
            state.mongo.find_many(
                "offers",
                doc! { "id": { "$in": &offer_id_bsons } },
                MongoFindOptions::default(),
            ),
            read_prices_by_offer_id(&state, offer_id_bsons.clone(), &rp.region),
        );
        let offers_docs =
            offers_res.map_err(|_| err_resp(internal_error(), &uri, req_id.clone()))?;
        let price_map = prices_res.map_err(|e| err_resp(e, &uri, req_id.clone()))?;

        let offer_by_id = docs_to_json(offers_docs)
            .into_iter()
            .map(|offer| (string_field(&offer, "id"), offer))
            .collect::<HashMap<_, _>>();

        let mut result_modules = Vec::new();
        for module in modules {
            let Some(mod_offers) = module.get("offers").and_then(Value::as_array) else {
                continue;
            };
            if mod_offers.is_empty() {
                continue;
            }
            let raw_offers: Vec<Value> = mod_offers
                .iter()
                .filter_map(|entry| entry.get("id").filter(|id| js_truthy(id)))
                .filter_map(|id| offer_by_id.get(&egdata_core::v1::serialization::js_string(id)))
                .map(prepare_offer_for_localization)
                .collect();

            let localized = localize_offers(&state, &raw_offers, &rp.locale)
                .await
                .map_err(|e| err_resp(e, &uri, req_id.clone()))?;

            let serialized_offers: Vec<Value> = localized
                .iter()
                .map(|o| {
                    let price = o
                        .get("id")
                        .and_then(Value::as_str)
                        .and_then(|oid| price_map.get(oid));
                    serialize_offer(o, price, true)
                })
                .collect();

            let title = js_primitive_string(&module["title"]).trim().to_owned();
            let mut obj = Map::new();
            obj.insert("title".to_string(), Value::String(title));
            obj.insert(
                "moduleIndex".to_string(),
                module.get("moduleIndex").cloned().unwrap_or(Value::Null),
            );
            obj.insert(
                "moduleType".to_string(),
                module.get("moduleType").cloned().unwrap_or(Value::Null),
            );
            obj.insert("offers".to_string(), Value::Array(serialized_offers));
            result_modules.push(Value::Object(obj));
        }

        let val = Value::Array(result_modules);
        v1_cache_set(state.cache.as_ref(), &cache_key, &val, 60).await;
        val
    };

    Ok(json_success(
        &method,
        uri.path(),
        &req_id,
        data,
        Some(json!({
            "country": rp.country,
            "region": rp.region,
            "locale": rp.locale,
            "eventSlug": GAME_AWARDS_EVENT_SLUG,
        })),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use axum::http::Request;
    use egdata_core::error::CoreError;
    use egdata_core::ports::*;
    use http_body_util::BodyExt;
    use std::sync::Arc;
    use tokio::sync::Mutex;
    use tower::ServiceExt;

    use crate::state::ApiConfig;

    #[derive(Default)]
    struct MockStore {
        calls: Mutex<Vec<Value>>,
        cache_read_failure: bool,
        cache_write_failure: bool,
        cache: Mutex<BTreeMap<String, String>>,
        cache_ping_ok: Mutex<bool>,
        mongo_ping_ok: Mutex<bool>,
        mongo_fail_collections: Mutex<HashSet<String>>,
        find_one_map: Mutex<HashMap<String, Option<Document>>>,
        find_many_map: Mutex<HashMap<String, Vec<Document>>>,
        aggregate_map: Mutex<HashMap<String, Vec<Document>>>,
        count_map: Mutex<HashMap<String, u64>>,
    }

    #[async_trait]
    impl ResponseCachePort for MockStore {
        async fn get(&self, key: &str) -> Result<Option<String>, CoreError> {
            self.calls
                .lock()
                .await
                .push(json!({"operation":"cacheGet","key":key}));
            if self.cache_read_failure {
                return Err(CoreError::Internal("fixture cache read failure".into()));
            }
            Ok(self.cache.lock().await.get(key).cloned())
        }
        async fn set(&self, key: &str, value: &str, ttl: u64) -> Result<(), CoreError> {
            self.calls.lock().await.push(json!({"operation":"cacheSet","key":key,"value":serde_json::from_str::<Value>(value).unwrap(),"mode":"EX","ttl":ttl}));
            if self.cache_write_failure {
                return Err(CoreError::Internal("fixture cache write failure".into()));
            }
            self.cache
                .lock()
                .await
                .insert(key.to_string(), value.to_string());
            Ok(())
        }
        async fn del(&self, key: &str) -> Result<(), CoreError> {
            self.cache.lock().await.remove(key);
            Ok(())
        }
        async fn ping(&self) -> Result<bool, CoreError> {
            Ok(*self.cache_ping_ok.lock().await)
        }
    }

    #[async_trait]
    impl MongoStorePort for MockStore {
        async fn find_one(
            &self,
            collection: &str,
            filter: Document,
            _projection: Option<Document>,
        ) -> Result<Option<Document>, CoreError> {
            self.calls.lock().await.push(
                json!({"operation":"findOne","collection":collection,"filter":doc_to_json(filter)}),
            );
            if self
                .mongo_fail_collections
                .lock()
                .await
                .contains(collection)
            {
                return Err(CoreError::Internal("mongo fail".into()));
            }
            Ok(self
                .find_one_map
                .lock()
                .await
                .get(collection)
                .cloned()
                .flatten())
        }
        async fn find_many(
            &self,
            collection: &str,
            _filter: Document,
            options: MongoFindOptions,
        ) -> Result<Vec<Document>, CoreError> {
            let failures = self.mongo_fail_collections.lock().await;
            if failures.contains(collection)
                || (options.projection.is_some()
                    && failures.contains(&format!("{collection}.projection")))
            {
                return Err(CoreError::Internal("mongo fail".into()));
            }
            Ok(self
                .find_many_map
                .lock()
                .await
                .get(collection)
                .cloned()
                .unwrap_or_default())
        }
        async fn aggregate(
            &self,
            collection: &str,
            pipeline: Vec<Document>,
        ) -> Result<Vec<Document>, CoreError> {
            let pipeline: Vec<_> = pipeline
                .iter()
                .map(egdata_infra::bson_json::bson_doc_to_js_json)
                .collect();
            self.calls
                .lock()
                .await
                .push(json!({"operation":"aggregate","pipeline":pipeline}));
            if self
                .mongo_fail_collections
                .lock()
                .await
                .contains(collection)
            {
                return Err(CoreError::Internal("mongo fail".into()));
            }
            Ok(self
                .aggregate_map
                .lock()
                .await
                .get(collection)
                .cloned()
                .unwrap_or_default())
        }
        async fn count_documents(
            &self,
            collection: &str,
            filter: Document,
        ) -> Result<u64, CoreError> {
            self.calls.lock().await.push(
                json!({"operation":"count","collection":collection,"filter":doc_to_json(filter)}),
            );
            if self
                .mongo_fail_collections
                .lock()
                .await
                .contains(collection)
            {
                return Err(CoreError::Internal("mongo fail".into()));
            }
            Ok(self
                .count_map
                .lock()
                .await
                .get(collection)
                .copied()
                .unwrap_or(0))
        }
        async fn distinct(
            &self,
            _collection: &str,
            _field: &str,
            _filter: Document,
        ) -> Result<Vec<Bson>, CoreError> {
            Err(CoreError::Internal(
                "Unexpected distinct read in a system fixture".into(),
            ))
        }
        async fn insert_one(&self, _c: &str, _d: Document) -> Result<(), CoreError> {
            Err(CoreError::Internal(
                "Unexpected Mongo insert in a system fixture".into(),
            ))
        }
        async fn update_one(
            &self,
            _c: &str,
            _f: Document,
            _u: Document,
            _up: bool,
        ) -> Result<u64, CoreError> {
            Err(CoreError::Internal(
                "Unexpected Mongo write in a system fixture".into(),
            ))
        }
        async fn delete_one(&self, _c: &str, _f: Document) -> Result<u64, CoreError> {
            Err(CoreError::Internal(
                "Unexpected Mongo write in a system fixture".into(),
            ))
        }
        async fn ping(&self) -> Result<bool, CoreError> {
            Ok(*self.mongo_ping_ok.lock().await)
        }
    }

    fn make_state(store: Arc<MockStore>, config: ApiConfig) -> AppState {
        let mut state = crate::middleware::test_support::test_app_state(config);
        state.mongo = store.clone();
        state.cache = store.clone();
        state.graphql_cache = store.clone();
        state.saved_queries = store;
        state
    }

    async fn send(app: &Router, uri: &str) -> (StatusCode, HeaderMap, String) {
        send_method(app, Method::GET, uri, true).await
    }

    async fn send_method(
        app: &Router,
        method: Method,
        uri: &str,
        with_ctx: bool,
    ) -> (StatusCode, HeaderMap, String) {
        let mut req = Request::builder()
            .method(method)
            .uri(uri)
            .header("x-request-id", "hdr-req-id")
            .body(Body::empty())
            .unwrap();
        if with_ctx {
            req.extensions_mut().insert(V1RequestContext {
                request_id: "ctx-req-id".into(),
                key: None,
            });
        }
        let resp = app.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let headers = resp.headers().clone();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            headers,
            String::from_utf8_lossy(&bytes).into_owned(),
        )
    }

    #[tokio::test]
    async fn system_fixtures_reject_unexpected_database_operations_and_support_cache_eviction() {
        let store = MockStore::default();
        assert!(store.distinct("offers", "id", doc! {}).await.is_err());
        assert!(store.insert_one("offers", doc! {}).await.is_err());
        assert!(
            store
                .update_one("offers", doc! {}, doc! {}, false)
                .await
                .is_err()
        );
        assert!(store.delete_one("offers", doc! {}).await.is_err());
        store.set("stats", r#""cached""#, 60).await.unwrap();
        store.del("stats").await.unwrap();
        assert_eq!(store.get("stats").await.unwrap(), None);
    }

    #[tokio::test]
    async fn empty_price_batches_skip_storage_but_populated_batches_propagate_errors() {
        let store = Arc::new(MockStore::default());
        let state = make_state(store.clone(), ApiConfig::default());
        store
            .mongo_fail_collections
            .lock()
            .await
            .insert("pricev2".into());
        assert!(
            fetch_prices_by_offer_id(&state, &[], "US")
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            fetch_prices_by_offer_id(&state, &["game".into()], "US")
                .await
                .is_err()
        );
    }

    #[test]
    fn native_request_id_must_be_a_valid_header_value() {
        for id in ["", "bad\nheader"] {
            let response = xml_response(&Method::GET, id, "<urlset/>".into());
            assert!(!response.headers().contains_key("x-request-id"));
        }
    }

    #[test]
    fn franchise_number_coercion_matches_node_fixtures() {
        let fixtures: Vec<Value> = serde_json::from_str(include_str!(
            "../../tests/fixtures/franchise-number-coercion.json"
        ))
        .unwrap();
        for fixture in fixtures {
            let actual = js_number_or_zero(if fixture["missing"] == true {
                None
            } else {
                Some(&fixture["value"])
            });
            let label = &fixture["label"];
            assert_eq!(json_num(actual), fixture["expected"], "fixture {label}");
        }
    }

    #[tokio::test]
    async fn system_and_stats_http_match_node_oracle() {
        use sha2::{Digest, Sha256};
        use tower::ServiceExt;
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../tests/fixtures/system-http-node.json"))
                .unwrap();
        for case in cases {
            let input = &case["input"];
            let store = Arc::new(MockStore::default());
            let failure = input["failure"].as_str();
            *store.cache_ping_ok.lock().await = failure != Some("redisPing");
            *store.mongo_ping_ok.lock().await = failure != Some("mongoPing");
            if let Some(collection) = failure {
                store
                    .mongo_fail_collections
                    .lock()
                    .await
                    .insert(collection.into());
            }
            if let Some(counts) = input["counts"].as_object() {
                for (key, value) in counts {
                    store
                        .count_map
                        .lock()
                        .await
                        .insert(key.clone(), value.as_u64().unwrap());
                }
            }
            if let Some(rows) = input["aggregate"].as_array() {
                store.aggregate_map.lock().await.insert(
                    "offers".into(),
                    rows.iter()
                        .map(|row| bson::to_document(row).unwrap())
                        .collect(),
                );
            }
            if let Some(tables) = input["rows"].as_object() {
                for (name, rows) in tables {
                    store.find_many_map.lock().await.insert(
                        name.clone(),
                        rows.as_array()
                            .unwrap()
                            .iter()
                            .map(|row| bson::to_document(row).unwrap())
                            .collect(),
                    );
                }
            }
            if let Some(row) = input.get("franchise") {
                store
                    .find_one_map
                    .lock()
                    .await
                    .insert("franchises".into(), Some(bson::to_document(row).unwrap()));
            }
            if let Some(cached) = input["cached"].as_str() {
                store.cache.lock().await.insert(
                    v1_cache_key("stats.counts", &BTreeMap::new()),
                    cached.into(),
                );
            }
            let mut config = ApiConfig::default();
            if input["noCursorSecret"] == true {
                config.v1_cursor_secret = None;
            }
            let mut state = make_state(store.clone(), config);
            if case["request"]["path"] == "/v1/health" {
                let response_cache = MockStore::default();
                *response_cache.cache_ping_ok.lock().await = failure == Some("redisPing");
                state.cache = Arc::new(response_cache);
            }
            state.now = || "2026-11-17T12:00:00Z".parse().unwrap();
            let app = crate::v1::router(&state).with_state(state);
            let request = axum::http::Request::builder()
                .uri(case["request"]["path"].as_str().unwrap())
                .header("x-egdata-key-id", "key_oracle")
                .header("x-egdata-key-tier", "free")
                .header("x-request-id", "req_node_oracle")
                .body(Body::empty())
                .unwrap();
            let mut actual = crate::v1::oracle_test_support::capture_response(
                app.oneshot(request).await.unwrap(),
            )
            .await;
            if case["name"] == "openapi" {
                actual["body"] = json!({"sha256":hex::encode(Sha256::digest(actual["body"].to_string().as_bytes()))});
            }
            let name = &case["name"];
            assert_eq!(actual, case["response"], "{name}");
            let mut counts = Vec::new();
            let mut pipelines = Vec::new();
            let mut writes = Vec::new();
            for call in store.calls.lock().await.iter() {
                match call["operation"].as_str() {
                    Some("aggregate") => pipelines.push(call["pipeline"].clone()),
                    Some("cacheSet") => {
                        let mut write = call.clone();
                        write.as_object_mut().unwrap().remove("operation");
                        writes.push(write);
                    }
                    Some("count") => {
                        let mut filter = call["filter"].clone();
                        if let Some(dates) = filter.get("creationDate") {
                            let years = ["$gte", "$lt"].map(|key| {
                                let date = dates[key]
                                    .as_str()
                                    .unwrap()
                                    .parse::<DateTime<Utc>>()
                                    .unwrap()
                                    .with_timezone(&chrono::Local);
                                assert_eq!(
                                    date.format("%m-%d %H:%M:%S%.3f").to_string(),
                                    "01-01 00:00:00.000"
                                );
                                date.year()
                            });
                            filter = json!({"localYears":years});
                        }
                        counts.push(json!({"collection":call["collection"],"filter":filter}));
                    }
                    _ => {}
                }
            }
            // Count calls run concurrently in both implementations.
            counts.sort_by_key(Value::to_string);
            let mut expected = case["counts"].as_array().unwrap().clone();
            expected.sort_by_key(Value::to_string);
            assert_eq!(counts, expected, "{name} count queries");
            assert_eq!(json!(pipelines), case["pipelines"], "{name} pipelines");
            assert_eq!(json!(writes), case["writes"], "{name} cache writes");
        }
    }

    #[tokio::test]
    async fn native_http_matches_canonical_node_oracle() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../tests/fixtures/native-http-node.json"))
                .unwrap();
        for case in cases {
            let store = Arc::new(MockStore::default());
            let rows: Vec<Document> = if let Some(raw) = case["input"]["wireRows"].as_array() {
                raw.iter()
                    .map(|hex| {
                        let bytes = hex::decode(hex.as_str().unwrap()).unwrap();
                        bson::from_slice(&bytes).unwrap()
                    })
                    .collect()
            } else {
                case["input"]["rows"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|value| bson::to_document(value).unwrap())
                    .collect()
            };
            for collection in ["offers", "items", "tags", "epic", "sandboxes"] {
                store
                    .find_many_map
                    .lock()
                    .await
                    .insert(collection.into(), rows.clone());
                store
                    .count_map
                    .lock()
                    .await
                    .insert(collection.into(), case["input"]["count"].as_u64().unwrap());
                if case["input"]["fail"] == true {
                    store
                        .mongo_fail_collections
                        .lock()
                        .await
                        .insert(collection.into());
                }
            }
            let app = route_group("/v1")
                .router
                .layer(axum::middleware::from_fn(
                    crate::middleware::response_etag::response_etag,
                ))
                .with_state(make_state(store, ApiConfig::default()));
            let mut request = Request::builder()
                .method(case["request"]["method"].as_str().unwrap())
                .uri(case["request"]["path"].as_str().unwrap());
            if let Some(headers) = case["request"]["headers"].as_object() {
                for (key, value) in headers {
                    request = request.header(key, value.as_str().unwrap());
                }
            }
            let mut request = request.body(Body::empty()).unwrap();
            request.extensions_mut().insert(V1RequestContext {
                request_id: "req_node_oracle".into(),
                key: None,
            });
            let actual = crate::v1::oracle_test_support::capture_response(
                app.oneshot(request).await.unwrap(),
            )
            .await;
            let name = &case["name"];
            assert_eq!(actual, case["response"], "{name} response");
        }
    }

    #[tokio::test]
    async fn asset_http_and_io_match_canonical_node_oracle() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../tests/fixtures/assets-http-node.json"))
                .unwrap();
        for case in cases {
            let input = &case["input"];
            let store = Arc::new(MockStore {
                cache_read_failure: input["cacheReadFailure"] == true,
                cache_write_failure: input["cacheWriteFailure"] == true,
                ..Default::default()
            });
            if let Some(asset) = input.get("asset") {
                store
                    .find_one_map
                    .lock()
                    .await
                    .insert("assets".into(), Some(bson::to_document(asset).unwrap()));
            }
            if input["databaseFailure"] == true {
                store
                    .mongo_fail_collections
                    .lock()
                    .await
                    .insert("assets".into());
            }
            if let Some(cached) = input["cached"].as_str() {
                store.cache.lock().await.insert(
                    v1_cache_key("assets.detail", &BTreeMap::from([("id", json!("asset-a"))])),
                    cached.into(),
                );
            }
            let app = route_group("/v1")
                .router
                .layer(axum::middleware::from_fn(
                    crate::middleware::response_etag::response_etag,
                ))
                .with_state(make_state(store.clone(), ApiConfig::default()));
            let mut request = Request::builder()
                .method(case["request"]["method"].as_str().unwrap())
                .uri(case["request"]["path"].as_str().unwrap())
                .body(Body::empty())
                .unwrap();
            request.extensions_mut().insert(V1RequestContext {
                request_id: "req_node_oracle".into(),
                key: None,
            });
            let actual = crate::v1::oracle_test_support::capture_response(
                app.oneshot(request).await.unwrap(),
            )
            .await;
            let calls = json!(*store.calls.lock().await);
            let name = &case["name"];
            assert_eq!(actual, case["response"], "{name} response");
            assert_eq!(calls, case["calls"], "{name} service calls");
        }
    }

    #[tokio::test]
    async fn health_endpoint_ok_and_degraded() {
        let store = Arc::new(MockStore::default());
        *store.cache_ping_ok.lock().await = true;
        *store.mongo_ping_ok.lock().await = true;
        let app = router().with_state(make_state(store.clone(), ApiConfig::default()));

        let (st, hdrs, body) = send(&app, "/health").await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(hdrs.get("cache-control").unwrap(), "public, max-age=60");
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["data"]["status"], "ok");
        assert_eq!(v["meta"]["apiVersion"], "v1");

        // Degraded -> 503
        *store.mongo_ping_ok.lock().await = false;
        let (st2, _, body2) = send_method(&app, Method::GET, "/health", false).await;
        assert_eq!(st2, StatusCode::SERVICE_UNAVAILABLE);
        let v2: Value = serde_json::from_str(&body2).unwrap();
        assert_eq!(v2["data"]["status"], "error");
        assert_eq!(v2["data"]["services"]["mongodb"]["status"], "error");

        // Strict query rejects extra params
        let (st3, _, body3) = send(&app, "/health?foo=1").await;
        assert_eq!(st3, StatusCode::BAD_REQUEST);
        assert!(body3.contains("INVALID_QUERY"));
    }

    #[tokio::test]
    async fn native_robots_and_sitemaps() {
        let store = Arc::new(MockStore::default());
        store.count_map.lock().await.insert("offers".into(), 1001);
        store.count_map.lock().await.insert("items".into(), 1001);
        store
            .count_map
            .lock()
            .await
            .insert("sandboxes".into(), 1001);
        store.find_many_map.lock().await.insert(
            "offers".into(),
            vec![
                doc! { "id": "off-1", "lastModifiedDate": bson::DateTime::from_millis(1_700_000_000_000) },
                doc! { "id": 99_i32 },
            ],
        );
        store.find_many_map.lock().await.insert(
            "items".into(),
            vec![
                doc! { "id": "item-1", "lastModifiedDate": "2025-01-01T00:00:00Z" },
                doc! { "id": "item-2" },
            ],
        );
        store
            .find_many_map
            .lock()
            .await
            .insert("tags".into(), vec![doc! { "id": "event-1" }]);
        store.find_many_map.lock().await.insert(
            "epic".into(),
            vec![doc! { "accountId": "acc-1" }, doc! { "accountId": "" }],
        );
        store.find_many_map.lock().await.insert(
            "sandboxes".into(),
            vec![
                doc! { "_id": "sb-1", "updated": "2025-01-02T00:00:00Z" },
                doc! { "_id": "sb-2" },
            ],
        );

        let env = BTreeMap::from([(
            "V1_PUBLIC_BASE_URL".into(),
            " https://example.org/api/// ".into(),
        )]);
        let app = router().with_state(make_state(
            store.clone(),
            ApiConfig::from_env_map(&env).unwrap(),
        ));

        let (st, hdrs, robots) = send(&app, "/robots.txt").await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(
            hdrs.get("content-type").unwrap(),
            "text/plain; charset=utf-8"
        );
        assert!(robots.contains("Allow: /v1/sitemap.xml"));

        let (_, _, head_robots) = send_method(&app, Method::HEAD, "/robots.txt", false).await;
        assert!(head_robots.is_empty());

        let (st, _, idx) = send(&app, "/sitemap.xml").await;
        assert_eq!(st, StatusCode::OK);
        assert!(idx.contains("https://example.org/api/sitemap.xml?page=3"));

        let (st, _, page1) = send(&app, "/sitemap.xml?page=1").await;
        assert_eq!(st, StatusCode::OK);
        assert!(page1.contains("https://egdata.app/offers/off-1"));
        assert!(page1.contains("<lastmod>2023-11-14T22:13:20.000Z</lastmod>"));
        assert!(page1.contains("https://egdata.app/offers/99"));

        assert_eq!(
            send(&app, "/sitemap.xml?page=0").await.0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            send(&app, "/sitemap.xml?bogus=1").await.0,
            StatusCode::BAD_REQUEST
        );

        let (st, _, items_idx) = send(&app, "/items-sitemap.xml").await;
        assert_eq!(st, StatusCode::OK);
        assert!(items_idx.contains("items-sitemap.xml?page=2"));

        let (st, _, items_p1) = send(&app, "/items/sitemap.xml?page=1").await;
        assert_eq!(st, StatusCode::OK);
        assert!(items_p1.contains("https://egdata.app/items/item-1"));
        assert!(items_p1.contains("https://egdata.app/items/item-2"));

        let (st, _, promo_xml) = send(&app, "/promotions-sitemap.xml").await;
        assert_eq!(st, StatusCode::OK);
        assert!(promo_xml.contains("https://egdata.app/promotions/event-1"));

        let (st, _, prof_xml) = send(&app, "/profiles/sitemap.xml").await;
        assert_eq!(st, StatusCode::OK);
        assert!(prof_xml.contains("https://egdata.app/profile/acc-1"));
        assert!(!prof_xml.contains("/profile/</loc>"));

        let (st, _, sb_idx) = send(&app, "/sandboxes/sitemap.xml").await;
        assert_eq!(st, StatusCode::OK);
        assert!(sb_idx.contains("sandboxes/sitemap.xml?page=2"));

        let (st, _, sb_p1) = send(&app, "/sandboxes/sitemap.xml?page=1").await;
        assert_eq!(st, StatusCode::OK);
        assert!(sb_p1.contains("https://egdata.app/sandboxes/sb-1/achievements"));
        assert!(sb_p1.contains("https://egdata.app/sandboxes/sb-2"));
    }

    #[tokio::test]
    async fn assets_and_stats_routes() {
        let store = Arc::new(MockStore::default());
        let app = router().with_state(make_state(store.clone(), ApiConfig::default()));

        // Asset 404
        let (st, _, body) = send(&app, "/assets/missing").await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        assert!(body.contains("ASSET_NOT_FOUND"));

        // Asset 200 then cached
        store.find_one_map.lock().await.insert(
            "assets".into(),
            Some(doc! { "artifactId": "art-1", "platform": "Windows" }),
        );
        let (st, _, body) = send(&app, "/assets/art-1").await;
        assert_eq!(st, StatusCode::OK);
        assert!(body.contains("art-1"));

        *store.find_one_map.lock().await.get_mut("assets").unwrap() = None;
        let (st_cached, _, body_cached) = send(&app, "/assets/art-1").await;
        assert_eq!(st_cached, StatusCode::OK);
        assert!(body_cached.contains("art-1"));

        // Stats counts (with one collection failing -> count_or_zero = 0)
        store.count_map.lock().await.insert("offers".into(), 42);
        store
            .mongo_fail_collections
            .lock()
            .await
            .insert("products".into());
        let (st, _, stats_body) = send(&app, "/stats").await;
        assert_eq!(st, StatusCode::OK);
        let sv: Value = serde_json::from_str(&stats_body).unwrap();
        assert_eq!(sv["data"]["offers"], 42);
        assert_eq!(sv["data"]["products"], 0);
        // Cached hit
        assert_eq!(send(&app, "/stats").await.0, StatusCode::OK);

        // Releases / Creations monthly & yearly
        store.aggregate_map.lock().await.insert(
            "offers".into(),
            vec![doc! { "year": 2024, "month": 5, "releases": 10 }],
        );
        for ep in [
            "/stats/releases/monthly",
            "/stats/releases/yearly",
            "/stats/creations/monthly",
            "/stats/creations/yearly",
        ] {
            assert_eq!(send(&app, ep).await.0, StatusCode::OK);
            // Second call hits cache
            assert_eq!(send(&app, ep).await.0, StatusCode::OK);
        }

        // Homepage stats + cache + invalid country
        let (st, _, hp_body) = send(&app, "/stats/homepage?country=GB").await;
        assert_eq!(st, StatusCode::OK);
        assert!(hp_body.contains("trackedPriceChanges"));
        assert_eq!(
            send(&app, "/stats/homepage?country=GB").await.0,
            StatusCode::OK
        );
        assert_eq!(
            send(&app, "/stats/homepage?country=XX").await.0,
            StatusCode::BAD_REQUEST
        );
    }

    #[tokio::test]
    async fn franchises_and_game_awards_routes() {
        let store = Arc::new(MockStore::default());
        let app = router().with_state(make_state(store.clone(), ApiConfig::default()));

        // Missing franchise -> 404
        let (st, _, body) = send(&app, "/franchises/missing").await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        assert!(body.contains("FRANCHISE_NOT_FOUND"));

        // Empty offers franchise
        store.find_one_map.lock().await.insert(
            "franchises".into(),
            Some(doc! { "_id": "empty-fr", "name": "Empty", "offers": [] }),
        );
        let (st, _, body) = send(&app, "/franchises/empty-fr").await;
        assert_eq!(st, StatusCode::OK);
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["data"]["elements"], json!([]));
        assert_eq!(v["data"]["stats"]["gamesCount"], 0);

        // Populated franchise with pagination, localization, stats, and cursor
        store.find_one_map.lock().await.insert(
            "franchises".into(),
            Some(doc! {
                "_id": "witcher",
                "name": "The Witcher",
                "lastUpdated": "2025-01-01T00:00:00Z",
                "offers": ["off-1", "off-2"]
            }),
        );
        store.find_many_map.lock().await.insert(
            "offers".into(),
            vec![
                doc! {
                    "id": "off-1",
                    "namespace": "ns1",
                    "title": "Witcher 3",
                    "releaseDate": bson::DateTime::from_millis(1_700_000_000_000),
                },
                doc! {
                    "id": "off-2",
                    "namespace": "ns1",
                    "title": "Witcher 2",
                    "releaseDate": bson::DateTime::from_millis(1_600_000_000_000),
                },
            ],
        );
        store.find_many_map.lock().await.insert(
            "pricev2".into(),
            vec![doc! {
                "offerId": "off-1",
                "region": "US",
                "price": { "currencyCode": "USD", "discountPrice": 1999, "originalPrice": 3999 }
            }],
        );
        store.find_many_map.lock().await.insert(
            "egs_localizations".into(),
            vec![doc! {
                "entityType": "offer",
                "entityId": "ns1:off-1",
                "locale": "es-ES",
                "source": "egs",
                "fetchedAt": "2025-01-01T00:00:00Z",
                "data": { "title": "The Witcher 3 ES" }
            }],
        );
        store.find_many_map.lock().await.insert(
            "achievementsets".into(),
            vec![doc! {
                "sandboxId": "ns1",
                "isBase": true,
                "achievements": [{ "xp": "100" }, { "xp": 50 }]
            }],
        );
        store.find_many_map.lock().await.insert(
            "igdbs".into(),
            vec![
                doc! {
                    "igdbId": 1942,
                    "timeToBeat": { "hastily": "30", "normally": 50, "completely": 100.5 }
                },
                doc! { "igdbId": 0 },
            ],
        );

        let (st, _, body) = send(&app, "/franchises/witcher?limit=1&locale=es-ES").await;
        assert_eq!(st, StatusCode::OK);
        let fv: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(fv["data"]["elements"][0]["title"], "The Witcher 3 ES");
        assert_eq!(fv["data"]["stats"]["totalAchievements"], 2);
        assert_eq!(fv["data"]["stats"]["totalXp"], 150);
        assert_eq!(fv["data"]["stats"]["totalTimeCompletely"], 100.5);
        assert_eq!(fv["data"]["stats"]["gamesCount"], 1);
        let cursor = fv["meta"]["pagination"]["nextCursor"].as_str().unwrap();

        // Cached hit
        assert_eq!(
            send(&app, "/franchises/witcher?limit=1&locale=es-ES")
                .await
                .0,
            StatusCode::OK
        );

        // Next page with cursor (exercises cursor decoding + mongo_keyset_filter)
        store.find_many_map.lock().await.insert(
            "offers".into(),
            vec![doc! { "id": "off-2", "namespace": "ns1", "title": "Witcher 2" }],
        );
        // Clear igdbs so games_count falls back to ns_set.len()
        store
            .find_many_map
            .lock()
            .await
            .insert("igdbs".into(), vec![]);
        let (st2, _, body2) = send(
            &app,
            &format!("/franchises/witcher?limit=1&locale=es-ES&cursor={cursor}"),
        )
        .await;
        assert_eq!(st2, StatusCode::OK);
        let fv2: Value = serde_json::from_str(&body2).unwrap();
        assert!(!fv2["meta"]["pagination"]["hasMore"].as_bool().unwrap());

        // Game awards
        store.find_many_map.lock().await.insert(
            "storefront-modules".into(),
            vec![
                doc! { "title": "  GOTY  ", "moduleIndex": 0, "moduleType": "grid", "offers": [{ "id": "off-1" }] },
                doc! { "title": "Empty", "moduleIndex": 1, "offers": [] },
            ],
        );
        let (st, _, ga_body) = send(&app, "/game-awards?country=US&locale=en-US").await;
        assert_eq!(st, StatusCode::OK);
        let gav: Value = serde_json::from_str(&ga_body).unwrap();
        assert_eq!(gav["data"][0]["title"], "GOTY");
        assert_eq!(gav["data"].as_array().unwrap().len(), 1);
        assert_eq!(gav["meta"]["eventSlug"], "the-game-awards");
        // Cached hit
        assert_eq!(send(&app, "/game-awards").await.0, StatusCode::OK);

        // Helper branches coverage: cursor_date_bson & cursor_scalar_bson & internal errors
        assert_eq!(cursor_date_bson(&CursorSortValue::Null), Bson::Null);
        assert_eq!(
            cursor_date_bson(&CursorSortValue::from("bad-date")),
            Bson::String("bad-date".into())
        );
        assert_eq!(
            cursor_date_bson(&CursorSortValue::from(10_i64)),
            Bson::Int64(10)
        );
        assert_eq!(
            cursor_scalar_bson(&CursorSortValue::from_f64(1.5)),
            Bson::Double(1.5)
        );
        assert_eq!(cursor_scalar_bson(&CursorSortValue::Null), Bson::Null);

        store
            .mongo_fail_collections
            .lock()
            .await
            .insert("offers".into());
        assert_eq!(
            send(&app, "/stats/releases/monthly").await.0,
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }
}
