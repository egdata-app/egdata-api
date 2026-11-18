//! Legacy top-level catalog/changelist reads and `/offers/{id}/overview`.
use super::{
    Routes,
    catalog::{
        can_localize, checked_ordered_offer, field_values, locale, localize_projected_offers,
        offer_rows, price_map, primitive_id, query, region,
    },
    common::*,
    system::selected_country,
};
use crate::{
    state::AppState,
    v1::{
        offer_metadata::{feature_attributes, stored_truthy},
        offer_regional_price::stored_number,
    },
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, Uri},
    response::Response,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use bson::{Bson, Document, doc, oid::ObjectId};
use chrono::{DateTime, Utc};
use egdata_core::{
    attributes::{FeatureTag, GameFeatures, get_game_features},
    v1::{
        query::format_js_number,
        serialization::{js_array_index, js_truthy, stored_identifier},
        trim_js_whitespace,
    },
};
use egdata_core::{
    countries::AGE_RATINGS_COUNTRIES,
    localization::{get_localized_cache_ttl_seconds, locale_cache_segment},
    ports::MongoFindOptions,
};
use egdata_infra::bson_json::{bson_doc_to_js_json, bson_to_js_json};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

pub(super) fn routes() -> Routes {
    Routes::new("")
        .get("/featured", featured)
        .get("/latest-games", latest_games)
        .get("/autocomplete", autocomplete)
        .get("/sales", sales)
        .get("/active-sales", active_sales)
        .get("/changelist", changelist)
        .get("/changelist/{id}", changelist_detail)
        .get("/offers/{id}/overview", offer_overview)
}

fn expand(q: &HashMap<String, String>) -> bool {
    q.get("expand").is_some_and(|v| {
        matches!(
            egdata_core::v1::trim_js_whitespace(v)
                .to_ascii_lowercase()
                .as_str(),
            "true" | "1" | "full"
        )
    })
}

fn expand_segment(expanded: bool) -> &'static str {
    if expanded { "full" } else { "card" }
}

fn minute(value: &Value) -> Response {
    cache_header(ok(value), ONE_MINUTE)
}

fn timing(mut response: Response, end: DateTime<Utc>, start: DateTime<Utc>) -> Response {
    response.headers_mut().insert(
        "server-timing",
        format!("db;dur={}", (end - start).num_milliseconds())
            .parse()
            .unwrap(),
    );
    response
}

async fn save_localized(
    state: &AppState,
    key: &str,
    value: &Value,
    default_ttl: u64,
) -> Result<()> {
    store(
        state,
        key,
        value,
        get_localized_cache_ttl_seconds(value, default_ttl),
    )
    .await
}

fn id_or_oid_filter(id: &Bson) -> Document {
    if let Some(oid) = id
        .as_object_id()
        .or_else(|| id.as_str().and_then(|text| ObjectId::parse_str(text).ok()))
    {
        doc! {"$or": [{"_id": oid}, {"_id": {"$eq": id}}]}
    } else {
        doc! {"_id": {"$eq": id}}
    }
}

async fn featured(State(state): State<AppState>, uri: Uri) -> Result<Response> {
    let q = query(&uri);
    let locale = locale(&q)?;
    let expanded = expand(&q);
    let start = (state.now)();

    let cache_key = "featured:v0.1";
    let response_cache_key = format!(
        "featured-response:{}:v0.1:{}",
        locale_cache_segment(&locale),
        expand_segment(expanded)
    );

    if let Some(hit) = cached(&state, &response_cache_key).await? {
        return Ok(minute(&hit));
    }

    let featured_games = if let Some(hit) = cached(&state, cache_key).await? {
        hit.as_array().cloned().ok_or(Error::Internal)?
    } else {
        let games = state.epic.featured_games().await?;
        let val = Value::Array(games.clone());
        store(&state, cache_key, &val, 86400).await?;
        games
    };

    let end = (state.now)();
    let ids: Vec<Bson> = featured_games
        .iter()
        .map(|f| {
            if f.is_null() {
                Err(Error::Internal)
            } else {
                Ok(node_bson(&f["id"]))
            }
        })
        .collect::<Result<_>>()?;
    let offers = state
        .mongo
        .find_many(
            "offers",
            doc! {"id": {"$in": ids}},
            MongoFindOptions {
                sort: Some(doc! {"lastModifiedDate": -1}),
                ..Default::default()
            },
        )
        .await?;

    let prices = HashMap::new();
    let result =
        Value::Array(offer_rows(&state, &offers, &locale, (!expanded).then_some(&prices)).await?);

    save_localized(&state, &response_cache_key, &result, 3600).await?;
    Ok(timing(minute(&result), end, start))
}

async fn latest_games(
    State(state): State<AppState>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Response> {
    let start = (state.now)();
    let q = query(&uri);
    let locale = locale(&q)?;
    let region = region(&uri, &headers)?;
    let expanded = expand(&q);

    let cache_key = format!(
        "latest-games:{region}:{}:{}",
        locale_cache_segment(&locale),
        expand_segment(expanded)
    );

    if let Some(hit) = cached(&state, &cache_key).await? {
        let mut res = minute(&hit);
        res.headers_mut().insert("x-cache", "HIT".parse().unwrap());
        return Ok(res);
    }

    let items = state
        .mongo
        .find_many(
            "offers",
            doc! {"offerType": {"$in": ["BASE_GAME", "DLC", "ADDON"]}},
            MongoFindOptions {
                limit: Some(25),
                sort: Some(doc! {"creationDate": -1}),
                ..Default::default()
            },
        )
        .await?;

    let ids: Vec<Bson> = field_values(&items, "id");
    let prices = state
        .mongo
        .find_many(
            "pricev2",
            doc! {"region": region, "offerId": {"$in": ids}},
            Default::default(),
        )
        .await?;

    let end = (state.now)();
    let result =
        Value::Array(offer_rows(&state, &items, &locale, Some(&price_map(&prices))).await?);

    save_localized(&state, &cache_key, &result, 60).await?;
    Ok(timing(minute(&result), end, start))
}

/// The top-level routes use parseInt(value || default, 10), even for values
/// outside the signed integer range. NaN is part of their Redis cache keys.
fn page_number(value: Option<&String>, default: f64) -> f64 {
    let Some(value) = value.filter(|s| !s.is_empty()) else {
        return default;
    };
    let trimmed = trim_js_whitespace(value);
    let unsigned = trimmed.strip_prefix(['+', '-']).unwrap_or(trimmed);
    let digits = unsigned.bytes().take_while(u8::is_ascii_digit).count();
    unsigned[..digits]
        .parse::<f64>()
        .map_or(f64::NAN, |n| if trimmed.starts_with('-') { -n } else { n })
}

fn requested_page(q: &HashMap<String, String>, max: f64) -> (f64, f64) {
    let page = page_number(q.get("page"), 1.).clamp(1., f64::INFINITY);
    let limit = page_number(q.get("limit"), 10.).clamp(f64::NEG_INFINITY, max);
    (page, limit)
}

async fn find_page(
    state: &AppState,
    collection: &str,
    filter: Document,
    sort: Document,
    collation: Option<Document>,
    skip: Option<f64>,
    limit: f64,
) -> Result<Vec<Document>> {
    // Avoid truncating JavaScript numbers that the Rust driver's typed find
    // options cannot express. Mongo itself handles these differently in find
    // and aggregate. Negative limits request one batch in the Node driver.
    if limit.abs() < i64::MAX as f64 && skip.is_none_or(|s| (0. ..i64::MAX as f64).contains(&s)) {
        return Ok(state
            .mongo
            .find_many(
                collection,
                filter,
                MongoFindOptions {
                    limit: Some(limit as i64),
                    skip: skip.map(|s| s as u64),
                    sort: Some(sort),
                    collation,
                    ..Default::default()
                },
            )
            .await?);
    }
    let mut options = doc! {"sort":sort, "limit":node_bson_number(limit.abs())};
    if let Some(skip) = skip {
        options.insert("skip", node_bson_number(skip));
    }
    if let Some(collation) = collation {
        options.insert("collation", collation);
    }
    if limit < 0. {
        options.insert("singleBatch", true);
    }
    Ok(state
        .mongo
        .find_many_with_raw_page(collection, filter, options)
        .await?)
}

async fn autocomplete(State(state): State<AppState>, uri: Uri) -> Result<Response> {
    let q = query(&uri);
    let locale = locale(&q)?;

    let Some(search_query) = q.get("query").filter(|v| !v.is_empty()) else {
        return Ok(ok(&json!({"elements": [], "total": 0})));
    };

    let (_, limit) = requested_page(&q, 10.);
    let limit_key = format_js_number(limit);
    let encoded_query = BASE64_STANDARD.encode(search_query.as_bytes());
    let cache_key = format!(
        "autocomplete:{encoded_query}:{limit_key}:{}:v0.1",
        locale_cache_segment(&locale)
    );

    if let Some(hit) = cached(&state, &cache_key).await? {
        return Ok(ok(&hit));
    }

    let start = (state.now)();
    let search_expr = search_query
        .split(' ')
        .map(|part| format!("\"{}\"", egdata_core::v1::trim_js_whitespace(part)))
        .collect::<Vec<_>>()
        .join(" | ");

    let offers = find_page(
        &state,
        "offers",
        doc! {"$text":{"$search":&search_expr, "$language":"en"}},
        doc! {"score":{"$meta":"textScore"},"offerType":-1,"lastModifiedDate":-1},
        Some(doc! {"locale":"en","strength":1}),
        None,
        limit,
    )
    .await?;

    let elements = offer_rows(&state, &offers, &locale, None).await?;
    let total = state
        .mongo
        .count_documents_with_options(
            "offers",
            doc! {"$text": {"$search": search_expr}},
            Some(doc! {"collation": {"locale": "en", "strength": 1}}),
        )
        .await?;

    let has_elements = !elements.is_empty();
    let response = json!({"elements": elements, "total": total});
    if has_elements {
        store(&state, &cache_key, &response, 60).await?;
    }

    Ok(timing(ok(&response), (state.now)(), start))
}

async fn sales(State(state): State<AppState>, uri: Uri, headers: HeaderMap) -> Result<Response> {
    let q = query(&uri);
    let locale = locale(&q)?;
    let region = region(&uri, &headers)?;
    let (page, limit) = requested_page(&q, 30.);
    let expanded = expand(&q);

    let cache_key = format!(
        "sales:{region}:{}:{}:{}:v1.3:{}",
        format_js_number(page),
        format_js_number(limit),
        locale_cache_segment(&locale),
        expand_segment(expanded)
    );

    if let Some(hit) = cached(&state, &cache_key).await? {
        let mut res = cache_header(ok(&hit), "public, max-age=0");
        res.headers_mut().insert("x-cache", "HIT".parse().unwrap());
        return Ok(res);
    }

    let skip = (page - 1.) * limit;
    let start = (state.now)();

    let pipeline = vec![
        doc! {
            "$match": {
                "region": region,
                "price.discount": {"$gt": 0},
                "appliedRules.endDate": {"$ne": Bson::Null}
            }
        },
        doc! {"$addFields": {"price": "$$ROOT"}},
        doc! {
            "$lookup": {
                "from": "offers",
                "localField": "offerId",
                "foreignField": "id",
                "as": "offer"
            }
        },
        doc! {
            "$unwind": {
                "path": "$offer",
                "preserveNullAndEmptyArrays": true
            }
        },
        doc! {"$sort": {"appliedRules.endDate": 1}},
        doc! {"$skip": node_bson_number(skip)},
        doc! {"$limit": node_bson_number(limit)},
    ];

    let agg_docs = state.mongo.aggregate("pricev2", pipeline).await?;
    let count = state
        .mongo
        .count_documents(
            "pricev2",
            doc! {"price.discount": {"$gt": 0}, "region": region},
        )
        .await?;

    let priced_offers: Vec<_> = agg_docs
        .iter()
        .filter(|r| r.get("offer").is_some_and(stored_truthy))
        .collect();
    // Map keys in separate Mongo documents match by primitive value, or by reference
    // to the same row for object-valued IDs.
    let mut by_id = HashMap::new();
    for row in &priced_offers {
        let id = row.get_document("offer").ok().and_then(|o| o.get("id"));
        if let Some(key) = primitive_id(id) {
            by_id.insert(key, row.get("price"));
        }
    }
    let mut rows = Vec::new();
    for row in priced_offers {
        let doc = row.get_document("offer").ok();
        let offer = bson_to_js_json(&row["offer"]);
        let value = if expanded {
            let mut full = spread(&offer);
            if let Some(price) = row.get("price") {
                full["price"] = bson_to_js_json(price);
            } else {
                full.as_object_mut().unwrap().remove("price");
            }
            full
        } else {
            let mut card = checked_ordered_offer(&offer)?;
            let id = doc.and_then(|o| o.get("id"));
            let price = primitive_id(id).map_or_else(
                || row.get("price"),
                |key| by_id.get(&key).copied().flatten(),
            );
            card["price"] = price.map(bson_to_js_json).unwrap_or(Value::Null);
            card
        };
        rows.push((doc.is_some_and(can_localize), value));
    }
    let elements = localize_projected_offers(&state, rows, &locale, !expanded).await?;

    let res = json!({
        "elements": elements,
        "page": page,
        "limit": limit,
        "total": count,
    });

    save_localized(&state, &cache_key, &res, 60).await?;
    Ok(timing(
        cache_header(ok(&res), "public, max-age=0"),
        (state.now)(),
        start,
    ))
}

async fn active_sales(
    State(state): State<AppState>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Response> {
    let q = query(&uri);
    let locale = locale(&q)?;
    let region = region(&uri, &headers)?;
    let expanded = expand(&q);

    let cache_key = format!(
        "active-sales:{region}:{}:{}",
        locale_cache_segment(&locale),
        expand_segment(expanded)
    );

    if let Some(hit) = cached(&state, &cache_key).await? {
        return Ok(minute(&hit));
    }

    let tags = state
        .mongo
        .find_many(
            "tags",
            doc! {
                "name": {"$regex": "(Sale|Savings|Promotion|Deals)", "$options": "i"},
                "referenceCount": {"$gt": 0},
                "id": {"$nin": [33639]}
            },
            MongoFindOptions {
                sort: Some(doc! {"updated": -1}),
                ..Default::default()
            },
        )
        .await?;

    let shared = std::sync::Arc::new((state.clone(), locale));
    let tag_futures = tags.into_iter().map(|t| {
        let shared = shared.clone();
        async move {
            let (state, locale) = shared.as_ref();
            let offers = state.mongo.find_many(
                "offers",
                doc! {"tags": {"$elemMatch": {"id": t.get("id").cloned().unwrap_or(Bson::Null)}}},
                MongoFindOptions {
                    sort: Some(doc! {"lastModifiedDate": -1}),
                    ..Default::default()
                },
            )
            .await?;

            let offer_ids: Vec<Bson> = field_values(&offers, "id");
            let prices = state
                .mongo
                .find_many(
                    "pricev2",
                    doc! {"region": region, "offerId": {"$in": offer_ids}},
                    Default::default(),
                )
                .await?;

            let t = bson_doc_to_js_json(&t);
            let mut every_on_sale = t["id"].as_str() == Some("29899");
            if !every_on_sale && !prices.is_empty() {
                every_on_sale = true;
                for p in &prices {
                    let price = p
                        .get("price")
                        .filter(|v| !matches!(v, Bson::Null | Bson::Undefined))
                        .ok_or(Error::Internal)?;
                    let field = |key| price.as_document().and_then(|d| d.get(key));
                    let on_sale = field("discount").is_some_and(|v| stored_number(v) > 0.)
                        || matches!(
                            field("originalPrice"),
                            Some(Bson::Int32(0) | Bson::Int64(0) | Bson::Double(0.))
                        );
                    if !on_sale {
                        every_on_sale = false;
                        break;
                    }
                }
            }

            let top_offers = &offers[..offers.len().min(3)];
            let localized =
                offer_rows(state, top_offers, locale, Some(&price_map(&prices))).await?;

            let mut row = serde_json::Map::new();
            for key in ["id", "name"] {
                if let Some(value) = t.get(key) {
                    row.insert(key.into(), value.clone());
                }
            }
            row.insert("active".into(), every_on_sale.into());
            row.insert("offers".into(), Value::Array(localized));
            Ok::<_, Error>(Value::Object(row))
        }
    });

    let result = Value::Array(finish_sale_groups(tag_futures.collect()).await?);
    save_localized(&state, &cache_key, &result, 3600).await?;
    Ok(minute(&result))
}

// Promise.all rejects immediately while already-started sibling reads continue.
// Successful groups are in completion order because the Node route pushes into an array.
async fn finish_sale_groups<F>(
    mut pending: futures::stream::FuturesUnordered<F>,
) -> Result<Vec<Value>>
where
    F: std::future::Future<Output = Result<Value>> + Send + 'static,
{
    use futures::{FutureExt, StreamExt};
    let mut groups = Vec::with_capacity(pending.len());
    while let Some(group) = pending.next().await {
        match group {
            Ok(group) => groups.push(group),
            Err(error) => {
                // Start waiting siblings in input order before handing their unfinished
                // reads to the runtime. These results never populate the response cache.
                while matches!(pending.next().now_or_never(), Some(Some(_))) {}
                if !pending.is_empty() {
                    tokio::spawn(pending.for_each(|_| std::future::ready(())));
                }
                return Err(error);
            }
        }
    }
    Ok(groups)
}

pub(crate) async fn resolve_changelog_context_safely(state: &AppState, change: &Document) -> Value {
    let Ok(metadata) = change.get_document("metadata") else {
        return Value::Null;
    };
    let Ok(context_type) = metadata.get_str("contextType") else {
        return Value::Null;
    };
    let Some(context_id) = metadata.get("contextId").filter(|id| stored_truthy(id)) else {
        return Value::Null;
    };

    let res = match context_type {
        "offer" => {
            state
                .mongo
                .find_one(
                    "offers",
                    doc! {"id": {"$eq": context_id}},
                    Some(
                        doc! {"id": 1, "title": 1, "keyImages": 1, "offerType": 1, "namespace": 1},
                    ),
                )
                .await
        }
        "item" => {
            state
                .mongo
                .find_one(
                    "items",
                    doc! {"id": {"$eq": context_id}},
                    Some(doc! {"id": 1, "title": 1, "keyImages": 1, "namespace": 1}),
                )
                .await
        }
        "asset" => state
            .mongo
            .find_one(
                "assets",
                doc! {"$or": [{"artifactId": {"$eq": context_id}}, {"id": {"$eq": context_id}}]},
                Some(doc! {"id": 1, "artifactId": 1, "namespace": 1}),
            )
            .await,
        "build" => {
            state
                .mongo
                .find_one(
                    "builds",
                    id_or_oid_filter(context_id),
                    Some(doc! {"_id": 1, "appName": 1, "buildVersion": 1}),
                )
                .await
        }
        _ => return Value::Null,
    };

    res.ok()
        .flatten()
        .map(|doc| bson_doc_to_js_json(&doc))
        .unwrap_or(Value::Null)
}

// Object spread observes the driver's enumerable properties before JSON serialization.
fn spread_metadata(metadata: Option<&Bson>) -> Value {
    let buffer = |bytes: &[u8]| json!({"type":"Buffer","data":bytes});
    match metadata {
        Some(Bson::ObjectId(id)) => json!({"buffer":buffer(&id.bytes())}),
        Some(Bson::Decimal128(n)) => json!({"bytes":buffer(&n.bytes())}),
        Some(Bson::Binary(b)) => {
            json!({"buffer":buffer(&b.bytes),"sub_type":u8::from(b.subtype),"position":b.bytes.len()})
        }
        Some(Bson::Timestamp(ts)) => {
            json!({"high":ts.time as i32,"low":ts.increment as i32,"unsigned":true})
        }
        None | Some(Bson::DateTime(_)) => json!({}),
        Some(value) => spread(&bson_to_js_json(value)),
    }
}

async fn enrich_changelog(state: &AppState, doc: Document) -> Value {
    let context = super::resolve_changelog_context_safely(state, &doc).await;
    let mut change = bson_doc_to_js_json(&doc);
    let mut metadata = spread_metadata(doc.get("metadata"));
    metadata["context"] = context;
    change["metadata"] = metadata;
    change
}

async fn changelist(State(state): State<AppState>, uri: Uri) -> Result<Response> {
    let start = (state.now)();
    let (page, limit) = requested_page(&query(&uri), 50.);
    let cache_key = format!(
        "changelist:{}:{}",
        format_js_number(page),
        format_js_number(limit)
    );

    if let Some(hit) = cached(&state, &cache_key).await? {
        return Ok(minute(&hit));
    }

    let rows = find_page(
        &state,
        "changelogs_v2",
        doc! {"metadata.contextType":{"$nin":["file","achievements"]}},
        doc! {"timestamp":-1},
        None,
        Some((page - 1.) * limit),
        limit,
    )
    .await?;

    let result = Value::Array(
        futures::future::join_all(rows.into_iter().map(|c| enrich_changelog(&state, c))).await,
    );
    store(&state, &cache_key, &result, 60).await?;
    Ok(timing(minute(&result), (state.now)(), start))
}

async fn changelist_detail(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response> {
    let start = (state.now)();
    let cache_key = format!("changelist:{id}");

    if let Some(hit) = cached(&state, &cache_key).await? {
        return Ok(minute(&hit));
    }

    let change = state
        .mongo
        .find_one("changelogs_v2", id_or_oid_filter(&Bson::String(id)), None)
        .await?
        .ok_or_else(|| not_found("Change not found"))?;

    let result = enrich_changelog(&state, change).await;
    store(&state, &cache_key, &result, 3600).await?;
    Ok(timing(minute(&result), (state.now)(), start))
}

fn resolve_age_rating(sandbox: Option<&Document>, country: &str) -> Value {
    let Some(gatings) = sandbox.and_then(|s| s.get_document("ageGatings").ok()) else {
        return Value::Null;
    };
    let system = AGE_RATINGS_COUNTRIES
        .iter()
        .find(|(_, countries)| countries.contains(&country))
        .map_or("Generic", |(name, _)| *name);
    match gatings.get(system) {
        Some(rating) if stored_truthy(rating) => {
            json!({ (system): bson_to_js_json(rating) })
        }
        _ => Value::Null,
    }
}

pub(super) async fn linked_feature_items(
    state: &AppState,
    id: &str,
    offer: &Document,
    subs: Vec<Document>,
) -> Result<Vec<Document>> {
    // JavaScript reads .id from each array member. A null member throws,
    // while a missing id becomes null within the driver's BSON array.
    fn append_ids(target: &mut Vec<Bson>, doc: &Document, field: &str) -> Result<()> {
        let values = doc.get_array(field).map_err(|_| Error::Internal)?;
        for value in values {
            if matches!(value, Bson::Null | Bson::Undefined) {
                return Err(Error::Internal);
            }
            target.push(
                value
                    .as_document()
                    .and_then(|v| v.get("id"))
                    .cloned()
                    .unwrap_or(Bson::Null),
            );
        }
        Ok(())
    }
    let mut item_ids = Vec::new();
    append_ids(&mut item_ids, offer, "items")?;
    for sub in subs {
        append_ids(&mut item_ids, &sub, "subItems")?;
    }
    Ok(state
        .mongo
        .find_many(
            "items",
            doc! {"$or": [{"id": {"$in": item_ids}}, {"linkedOffers": id}]},
            Default::default(),
        )
        .await?)
}

pub(super) fn features_from_items(items: &[Document], offer: &Document) -> Result<GameFeatures> {
    features_from_tags(items, offer.get_array("tags").map_err(|_| Error::Internal)?)
}

fn features_from_tags(items: &[Document], source: &[Bson]) -> Result<GameFeatures> {
    let attributes = feature_attributes(items)?;
    // The JS object uses string property keys, but feature matching compares
    // the final tag's original id with a known string using strict equality.
    let mut tags = indexmap::IndexMap::new();
    for tag in source {
        if matches!(tag, Bson::Null | Bson::Undefined) {
            return Err(Error::Internal);
        }
        let Some(id) = tag.as_document().and_then(|d| d.get("id")) else {
            continue;
        };
        let Some(key) = stored_identifier(id) else {
            continue;
        };
        tags.insert(
            key,
            id.as_str().map(|s| FeatureTag {
                id: s.to_owned(),
                name: String::new(),
            }),
        );
    }
    let mut tags: Vec<_> = tags.into_values().flatten().collect();
    tags.sort_by_cached_key(|tag| js_array_index(&tag.id).unwrap_or(u32::MAX));
    Ok(get_game_features(&attributes, &tags))
}

async fn offer_overview(
    State(state): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Response> {
    let q = query(&uri);
    let locale = locale(&q)?;
    let selected_country = selected_country(&uri, &headers);
    let region = region(&uri, &headers)?;

    let start = (state.now)();
    let cache_key = format!(
        "overview:{id}:{region}:{}:v0.1",
        locale_cache_segment(&locale)
    );

    if let Some(hit) = cached(&state, &cache_key).await? {
        return Ok(minute(&hit));
    }

    let raw_offer = state
        .mongo
        .find_one("offers", doc! {"id": &id}, None)
        .await?
        .ok_or_else(|| not_found("Offer not found"))?;

    let offer = bson_doc_to_js_json(&raw_offer);
    let (price_res, media_res, igdb_res, sub_items_res, sandbox_res, giveaways_res, genres_res) = tokio::join!(
        one(&state, "pricev2", doc! {"offerId": &id, "region": region}),
        one(&state, "media", doc! {"_id": &id}),
        one(&state, "igdb", doc! {"offerId": &id}),
        state.mongo.find_many(
            "offersubitems",
            doc! {"_id": &id},
            MongoFindOptions {
                projection: Some(doc! {"_id": 1, "subItems": 1}),
                ..Default::default()
            },
        ),
        state.mongo.find_one(
            "sandboxes",
            doc! {"_id": raw_offer.get("namespace").cloned().unwrap_or(Bson::Null)},
            None,
        ),
        many(
            &state,
            "freegames",
            doc! {"id": &id},
            MongoFindOptions {
                sort: Some(doc! {"startDate": -1}),
                ..Default::default()
            },
        ),
        state.mongo.find_many(
            "tags",
            doc! {"groupName": "genre", "status": "ACTIVE"},
            Default::default(),
        ),
    );

    let raw_items =
        linked_feature_items(&state, &id, &raw_offer, sub_items_res.unwrap_or_default()).await?;
    let tags = raw_offer.get_array("tags").map_err(|_| Error::Internal)?;
    let features = features_from_tags(&raw_items, tags)?;

    let sandbox_data = sandbox_res.ok().flatten();
    if matches!(
        sandbox_data.as_ref().and_then(|doc| doc.get("ageGatings")),
        Some(Bson::Null | Bson::Undefined)
    ) {
        return Err(Error::Internal);
    }
    let age_rating = resolve_age_rating(sandbox_data.as_ref(), &selected_country);
    let polls_filter = doc! {"_id": sandbox_data.as_ref().and_then(|s| s.get("id")).cloned().unwrap_or(Bson::Null)};
    let polls = one(&state, "ratings_polls", polls_filter)
        .await?
        .unwrap_or(Value::Null);

    let item_id_bsons = field_values(&raw_items, "id");
    let assets = state
        .mongo
        .find_many(
            "assets",
            doc! {"itemId": {"$in": item_id_bsons}},
            Default::default(),
        )
        .await?;

    let apps: Vec<Bson> = field_values(&assets, "artifactId");
    let builds = state
        .mongo
        .aggregate(
            "builds",
            vec![
                doc! {"$match": {"appName": {"$in": apps}}},
                doc! {"$sort": {"createdAt": -1}},
                doc! {"$group": {"_id": "$appName", "doc": {"$first": "$$ROOT"}}},
            ],
        )
        .await?;

    let mut seen_tech = HashSet::new();
    let mut technologies = Vec::new();
    for row in builds {
        let doc = row
            .get("doc")
            .filter(|v| !matches!(v, Bson::Null | Bson::Undefined))
            .ok_or(Error::Internal)?;
        let Some(tech) = doc.as_document().and_then(|d| d.get("technologies")) else {
            continue;
        };
        let entries = tech
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_else(|| std::slice::from_ref(tech));
        for entry in entries {
            if !stored_truthy(entry) {
                continue;
            }
            let value = entry.as_document().and_then(|doc| doc.get("technology"));
            // Strict equality never considers NaN equal, while Set would.
            let distinct = matches!(value,Some(Bson::Double(n)) if n.is_nan())
                || primitive_id(value).is_none_or(|key| seen_tech.insert(key));
            if distinct {
                technologies.push(bson_to_js_json(entry));
            }
        }
    }

    let genre_ids: HashSet<_> = genres_res
        .unwrap_or_default()
        .iter()
        .filter_map(|g| primitive_id(g.get("id")))
        .collect();
    let offer_genres: Vec<Value> = tags
        .iter()
        .filter(|tag| {
            primitive_id(tag.as_document().and_then(|d| d.get("id")))
                .is_some_and(|key| genre_ids.contains(&key))
        })
        .map(bson_to_js_json)
        .collect();

    let mut ordered = checked_ordered_offer(&offer)?;
    if let Some(attrs) = offer
        .get("customAttributes")
        .filter(|attrs| !js_truthy(attrs))
    {
        // The overview explicitly reinserts falsy attributes omitted by the ordered projection.
        ordered["customAttributes"] = attrs.clone();
    }
    let localized_offer = localize_projected_offers(
        &state,
        vec![(can_localize(&raw_offer), ordered)],
        &locale,
        true,
    )
    .await?
    .remove(0);

    let result = json!({
        "offer": localized_offer,
        "price": price_res.ok().flatten().unwrap_or(Value::Null),
        "media": media_res.ok().flatten().unwrap_or(Value::Null),
        "igdb": igdb_res.ok().flatten().unwrap_or(Value::Null),
        "features": features,
        "ageRating": age_rating,
        "giveaways": giveaways_res.ok().unwrap_or_default(),
        "polls": polls,
        "genres": offer_genres,
        "technologies": technologies,
    });

    save_localized(&state, &cache_key, &result, 300).await?;
    Ok(timing(minute(&result), (state.now)(), start))
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn legacy_top_reads_http_node_oracle() {
        crate::v1::mongo_read_oracle::replay_legacy_oracle(include_str!(
            "../../tests/fixtures/legacy-top-reads-http-node.json"
        ))
        .await;
    }
}
