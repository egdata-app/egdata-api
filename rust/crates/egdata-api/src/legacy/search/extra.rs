//! Additional legacy search endpoints (`/search/changelog`, `/search/{id}/count`, `/search/natural-language`).
use super::super::{
    Routes,
    catalog::{localize_legacy_offers, ordered_offer},
    common::*,
    system::{query, selected_country},
};
use crate::state::AppState;
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, Uri},
    response::Response,
};
use bson::{Bson, Document, Regex, doc, oid::ObjectId};
use egdata_core::{
    countries::REGIONS,
    error::CoreError,
    localization::parse_locale,
    ports::{MongoFindOptions, VectorizeOfferMatch},
    v1::{serialization::js_string, trim_js_whitespace},
};
use egdata_infra::bson_json::bson_doc_to_js_json;
use futures::future::join_all;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};

pub(super) fn routes() -> Routes {
    Routes::new("/search")
        .get("/changelog", changelog)
        .post("/natural-language", natural_language)
        .get("/{id}/count", count)
}

fn is_js_truthy(value: &Value) -> bool {
    !matches!(value, Value::Null | Value::Bool(false))
        && value.as_str() != Some("")
        && value.as_f64() != Some(0.0)
}

fn json_to_bson(value: &Value) -> Bson {
    match value {
        Value::Null => Bson::Null,
        Value::Bool(b) => Bson::Boolean(*b),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Bson::Int64(i)
            } else {
                let f = n.as_f64().unwrap_or(0.0);
                if f.is_finite() && f.fract() == 0.0 && f >= i64::MIN as f64 && f <= i64::MAX as f64
                {
                    Bson::Int64(if f == 0.0 { 0 } else { f as i64 })
                } else {
                    Bson::Double(f)
                }
            }
        }
        Value::String(s) => Bson::String(s.clone()),
        Value::Array(items) => Bson::Array(items.iter().map(json_to_bson).collect()),
        Value::Object(map) => {
            let mut doc = Document::new();
            for (k, v) in map {
                doc.insert(k.clone(), json_to_bson(v));
            }
            Bson::Document(doc)
        }
    }
}

fn parse_int_or(raw: Option<&str>, default: i64) -> i64 {
    let Some(raw) = raw else {
        return default;
    };
    let trimmed = trim_js_whitespace(raw);
    let unsigned = trimmed.strip_prefix(['+', '-']).unwrap_or(trimmed);
    let digits = unsigned.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return default;
    }
    let parsed = unsigned[..digits].parse::<i64>().unwrap_or(default);
    let signed = if trimmed.starts_with('-') {
        parsed.saturating_neg()
    } else {
        parsed
    };
    if signed == 0 { default } else { signed }
}

fn mongo_changelog_hits(docs: Vec<Document>) -> Vec<Value> {
    docs.iter()
        .map(|doc| {
            let mut hit = bson_doc_to_js_json(doc);
            let id_str = hit
                .get("_id")
                .map(js_string)
                .unwrap_or_else(|| "undefined".to_owned());
            hit["_id"] = Value::String(id_str);
            hit
        })
        .collect()
}

fn normalize_changelog_value(current: Option<&Value>, raw: Option<&Value>) -> Value {
    if let Some(val) = current.filter(|v| !v.is_null()) {
        return val.clone();
    }
    match raw {
        None | Some(Value::Null) => Value::Null,
        Some(Value::String(s)) => {
            serde_json::from_str::<Value>(s).unwrap_or_else(|_| Value::String(s.clone()))
        }
        Some(other) => other.clone(),
    }
}

async fn hydrate_changelog_values(s: &AppState, hits: &mut [Value]) {
    if hits.is_empty() {
        return;
    }
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for hit in hits.iter() {
        if let Some(id) = hit
            .get("_id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            && seen.insert(id.to_owned())
        {
            ids.push(id.to_owned());
        }
    }
    let mut mongo_by_id = HashMap::new();
    if !ids.is_empty() {
        let mut candidates: Vec<Bson> = ids
            .iter()
            .filter_map(|id| ObjectId::parse_str(id).ok().map(Bson::ObjectId))
            .collect();
        candidates.extend(ids.iter().cloned().map(Bson::String));
        if let Ok(docs) = s
            .mongo
            .find_many(
                "changelogs_v2",
                doc! { "_id": { "$in": candidates } },
                Default::default(),
            )
            .await
        {
            for doc in docs {
                let val = bson_doc_to_js_json(&doc);
                if let Some(id) = val.get("_id").map(js_string) {
                    mongo_by_id.insert(id, val);
                }
            }
        }
    }
    for hit in hits.iter_mut() {
        let hit_id = hit
            .get("_id")
            .map(js_string)
            .unwrap_or_else(|| "undefined".to_owned());
        let Some(changes) = hit
            .pointer("/metadata/changes")
            .and_then(Value::as_array)
            .cloned()
        else {
            continue;
        };
        let mongo_items = mongo_by_id
            .get(&hit_id)
            .and_then(|doc| doc.pointer("/metadata/changes"))
            .and_then(Value::as_array);
        let hydrated_changes: Vec<Value> = changes
            .iter()
            .enumerate()
            .map(|(index, change)| {
                let mongo_item = mongo_items
                    .and_then(|items| items.get(index))
                    .and_then(Value::as_object);
                let mut map = change.as_object().cloned().unwrap_or_default();
                for (field, raw_field) in [("oldValue", "oldValueRaw"), ("newValue", "newValueRaw")]
                {
                    let value = if let Some(v) = mongo_item.and_then(|m| m.get(field)) {
                        v.clone()
                    } else {
                        normalize_changelog_value(change.get(field), change.get(raw_field))
                    };
                    map.insert(field.into(), value);
                }
                Value::Object(map)
            })
            .collect();
        if let Some(metadata) = hit.get_mut("metadata").and_then(Value::as_object_mut) {
            metadata.insert("changes".into(), Value::Array(hydrated_changes));
        }
    }
}

async fn resolve_changelog_search_document(
    s: &AppState,
    context_type: Option<&str>,
    context_id: Option<&str>,
) -> Result<Option<Value>> {
    let (Some(ctx_type), Some(ctx_id)) = (
        context_type.filter(|v| !v.is_empty()),
        context_id.filter(|v| !v.is_empty()),
    ) else {
        return Ok(None);
    };
    match ctx_type {
        "offer" => one(s, "offers", doc! { "id": { "$eq": ctx_id } }).await,
        "item" => one(s, "items", doc! { "id": { "$eq": ctx_id } }).await,
        "asset" => {
            let asset = one(
                s,
                "assets",
                doc! { "$or": [{ "artifactId": { "$eq": ctx_id } }, { "id": { "$eq": ctx_id } }] },
            )
            .await?;
            let Some(item_id) = asset
                .as_ref()
                .and_then(|doc| doc.get("itemId"))
                .filter(|v| is_js_truthy(v))
            else {
                return Ok(None);
            };
            one(s, "items", doc! { "id": { "$eq": json_to_bson(item_id) } }).await
        }
        "build" => {
            let filter = if let Ok(oid) = ObjectId::parse_str(ctx_id) {
                doc! { "$or": [{ "_id": oid }, { "_id": { "$eq": ctx_id } }] }
            } else {
                doc! { "_id": { "$eq": ctx_id } }
            };
            Ok(s.mongo
                .find_one(
                    "builds",
                    filter,
                    Some(doc! { "_id": 1, "appName": 1, "buildVersion": 1 }),
                )
                .await?
                .as_ref()
                .map(bson_doc_to_js_json))
        }
        _ => Ok(None),
    }
}

async fn enrich_changelog_search_documents(s: &AppState, hits: &mut [Value]) {
    let resolved = join_all(hits.iter().map(|hit| {
        let ctx_type = hit.pointer("/metadata/contextType").and_then(Value::as_str);
        let ctx_id = hit.pointer("/metadata/contextId").and_then(Value::as_str);
        async move {
            resolve_changelog_search_document(s, ctx_type, ctx_id)
                .await
                .unwrap_or(None)
        }
    }))
    .await;
    for (hit, doc) in hits.iter_mut().zip(resolved) {
        if let Some(obj) = hit.as_object_mut() {
            obj.insert("document".into(), doc.unwrap_or(Value::Null));
        }
    }
}

async fn fetch_related_context_ids(s: &AppState, text: &str) -> Result<Vec<String>> {
    let body = json!({
        "size": 100,
        "query": {
            "multi_match": {
                "query": text,
                "fields": ["title^3", "description", "id"]
            }
        }
    });
    let (offer_res, item_res) = tokio::join!(
        s.opensearch.search("egdata.offers", &body),
        s.opensearch.search("egdata.items", &body),
    );
    let offer_matches = offer_res?;
    let item_matches = item_res?;
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for res in [&offer_matches, &item_matches] {
        if let Some(hits) = res.pointer("/hits/hits").and_then(Value::as_array) {
            for hit in hits {
                if let Some(id) = hit
                    .pointer("/_source/id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    && seen.insert(id.to_owned())
                {
                    ids.push(id.to_owned());
                }
            }
        }
    }
    Ok(ids)
}

fn changelog_mongo_filter(id: Option<&str>, context_type: Option<&str>) -> Document {
    let mut filter = doc! { "metadata.contextType": { "$nin": ["file", "achievements"] } };
    if let Some(id) = id.filter(|v| !v.is_empty()) {
        filter.insert("metadata.contextId", id);
    }
    if let Some(t) = context_type.filter(|v| !v.is_empty()) {
        filter.insert(
            "metadata.contextType",
            doc! { "$eq": t, "$nin": ["file", "achievements"] },
        );
    }
    filter
}

fn changelog_response(
    hits: Vec<Value>,
    estimated_total_hits: u64,
    processing_time_ms: Option<Value>,
    query_text: &str,
    debug_info: Option<Value>,
    debug: bool,
) -> Response {
    let mut payload = Map::new();
    payload.insert("hits".into(), Value::Array(hits));
    payload.insert("estimatedTotalHits".into(), json!(estimated_total_hits));
    if let Some(ms) = processing_time_ms {
        payload.insert("processingTimeMs".into(), ms);
    }
    payload.insert("query".into(), json!(query_text));
    if let Some(info) = debug_info {
        payload.insert("debug".into(), info);
    }
    cache_header(
        ok(&Value::Object(payload)),
        if debug { "no-store" } else { ONE_MINUTE },
    )
}

async fn changelog(State(s): State<AppState>, uri: Uri) -> Result<Response> {
    let raw_query = query(&uri, "query");
    let page = parse_int_or(query(&uri, "page").as_deref(), 1).max(1);
    let limit = parse_int_or(query(&uri, "limit").as_deref(), 10).min(50);
    let context_type = query(&uri, "type");
    let id = query(&uri, "id");
    let debug = query(&uri, "debug").as_deref() == Some("1");

    let mut must = Vec::new();
    let mut filter = Vec::new();
    let mut related_context_ids = Vec::new();

    if let Some(q) = raw_query.as_deref().filter(|q| !q.is_empty()) {
        related_context_ids = fetch_related_context_ids(&s, q).await?;
        let mut should = vec![json!({
            "query_string": {
                "query": q,
                "default_operator": "AND"
            }
        })];
        if !related_context_ids.is_empty() {
            should.push(json!({ "terms": { "metadata.contextId.keyword": related_context_ids } }));
            should.push(json!({ "terms": { "metadata.contextId": related_context_ids } }));
        }
        must.push(json!({
            "bool": {
                "should": should,
                "minimum_should_match": 1
            }
        }));
    }

    if let Some(id_val) = id.as_deref().filter(|v| !v.is_empty()) {
        filter.push(json!({ "term": { "metadata.contextId.keyword": id_val } }));
    }
    if let Some(type_val) = context_type.as_deref().filter(|v| !v.is_empty()) {
        filter.push(json!({ "term": { "metadata.contextType.keyword": type_val } }));
    }

    let must_not = json!([
        { "term": { "metadata.contextType.keyword": "file" } },
        { "term": { "metadata.contextType.keyword": "achievements" } }
    ]);
    let mongo_filter = changelog_mongo_filter(id.as_deref(), context_type.as_deref());
    let skip = ((page - 1).saturating_mul(limit)).max(0) as u64;

    if raw_query
        .as_deref()
        .is_none_or(|q| trim_js_whitespace(q).is_empty())
    {
        let started_at = (s.now)();
        let find_opts = MongoFindOptions {
            sort: Some(doc! { "timestamp": -1 }),
            skip: Some(skip),
            limit: Some(limit),
            ..Default::default()
        };
        let (total_res, hits_res) = tokio::join!(
            s.mongo
                .count_documents("changelogs_v2", mongo_filter.clone()),
            s.mongo.find_many("changelogs_v2", mongo_filter, find_opts),
        );
        let estimated_total_hits = total_res?;
        let mongo_hits = hits_res?;
        let mut hits = mongo_changelog_hits(mongo_hits);
        enrich_changelog_search_documents(&s, &mut hits).await;
        let elapsed_ms = ((s.now)() - started_at).num_milliseconds().max(0);
        return Ok(changelog_response(
            hits,
            estimated_total_hits,
            Some(json!(elapsed_ms)),
            "",
            None,
            debug,
        ));
    }

    let query_str = raw_query.as_deref().unwrap_or("");
    let mut bool_query = Map::new();
    bool_query.insert("must_not".into(), must_not);
    bool_query.insert("must".into(), Value::Array(must));
    if !filter.is_empty() {
        bool_query.insert("filter".into(), Value::Array(filter));
    }
    let query_body = json!({ "bool": Value::Object(bool_query) });

    let os_body = json!({
        "from": (page - 1).saturating_mul(limit),
        "size": limit,
        "query": query_body,
        "sort": [{ "timestamp": { "order": "desc" } }]
    });
    let response = s.opensearch.search("egdata.changelog", &os_body).await?;

    let mut hits: Vec<Value> = response
        .pointer("/hits/hits")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|hit| {
                    let mut obj = hit
                        .get("_source")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    if let Some(hit_id) = hit.get("_id") {
                        obj.insert("_id".into(), hit_id.clone());
                    }
                    Value::Object(obj)
                })
                .collect()
        })
        .unwrap_or_default();

    hydrate_changelog_values(&s, &mut hits).await;
    enrich_changelog_search_documents(&s, &mut hits).await;

    let estimated_total_hits = response
        .pointer("/hits/total")
        .and_then(|total| {
            total
                .as_u64()
                .or_else(|| total.get("value").and_then(Value::as_u64))
        })
        .unwrap_or(0);
    let took = response.get("took").cloned();
    let sample_len = related_context_ids.len().min(10);

    if estimated_total_hits == 0 && !related_context_ids.is_empty() {
        let mut fallback_filter = mongo_filter;
        let ids_bson: Vec<Bson> = related_context_ids
            .iter()
            .cloned()
            .map(Bson::String)
            .collect();
        fallback_filter.insert("metadata.contextId", doc! { "$in": ids_bson });
        if let Some(id_val) = id.as_deref().filter(|v| !v.is_empty()) {
            fallback_filter.insert("metadata.contextId", id_val);
        }
        let find_opts = MongoFindOptions {
            sort: Some(doc! { "timestamp": -1 }),
            skip: Some(skip),
            limit: Some(limit),
            ..Default::default()
        };
        let (total_res, docs_res) = tokio::join!(
            s.mongo
                .count_documents("changelogs_v2", fallback_filter.clone()),
            s.mongo
                .find_many("changelogs_v2", fallback_filter, find_opts),
        );
        let fallback_total = total_res?;
        let fallback_docs = docs_res?;
        let mut fallback_hits = mongo_changelog_hits(fallback_docs);
        enrich_changelog_search_documents(&s, &mut fallback_hits).await;
        let debug_info = debug.then(|| {
            json!({
                "usedMongoFallback": true,
                "relatedContextIdsCount": related_context_ids.len(),
                "relatedContextIdsSample": &related_context_ids[..sample_len],
                "queryBody": query_body,
            })
        });
        return Ok(changelog_response(
            fallback_hits,
            fallback_total,
            took,
            query_str,
            debug_info,
            debug,
        ));
    }

    let debug_info = debug.then(|| {
        json!({
            "relatedContextIdsCount": related_context_ids.len(),
            "relatedContextIdsSample": &related_context_ids[..sample_len],
            "queryBody": query_body,
        })
    });
    Ok(changelog_response(
        hits,
        estimated_total_hits,
        took,
        query_str,
        debug_info,
        debug,
    ))
}

const INVALID_NL_BODY_MSG: &str = "Invalid body. Provide a query between 1 and 500 characters and an optional topK between 1 and 50.";

fn parse_natural_language_body(body: &Bytes) -> Result<(String, usize)> {
    let invalid = || {
        Error::Json(
            StatusCode::BAD_REQUEST,
            json!({ "message": INVALID_NL_BODY_MSG }),
        )
    };
    let parsed: Value = serde_json::from_slice(body).map_err(|_| invalid())?;
    let obj = parsed.as_object().ok_or_else(invalid)?;
    if obj.keys().any(|k| k != "query" && k != "topK") {
        return Err(invalid());
    }
    let query = obj
        .get("query")
        .and_then(Value::as_str)
        .map(trim_js_whitespace)
        .filter(|s| {
            let len = s.encode_utf16().count();
            (1..=500).contains(&len)
        })
        .ok_or_else(invalid)?
        .to_owned();
    let top_k = match obj.get("topK") {
        None => 10_usize,
        Some(val) => val
            .as_f64()
            .filter(|n| n.is_finite() && n.fract() == 0.0 && (1.0..=50.0).contains(n))
            .map(|n| n as usize)
            .ok_or_else(invalid)?,
    };
    Ok((query, top_k))
}

async fn lookup_and_localize_nl_matches(
    s: &AppState,
    vector_matches: &[VectorizeOfferMatch],
    locale: &str,
) -> Result<Vec<Value>> {
    let nl_failed = || {
        Error::Json(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "message": "Natural-language search failed" }),
        )
    };
    let mut seen_vector = HashSet::new();
    let mut vector_oids = Vec::new();
    let mut seen_offer = HashSet::new();
    let mut offer_ids = Vec::new();

    for m in vector_matches {
        if let Ok(oid) = ObjectId::parse_str(&m.id)
            && seen_vector.insert(m.id.clone())
        {
            vector_oids.push(Bson::ObjectId(oid));
        }
        if let Some(offer_id) = m
            .metadata
            .as_ref()
            .and_then(|meta| meta.get("id"))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            && seen_offer.insert(offer_id.to_owned())
        {
            offer_ids.push(Bson::String(offer_id.to_owned()));
        }
    }

    let mut lookup_filters = Vec::new();
    if !offer_ids.is_empty() {
        lookup_filters.push(doc! { "id": { "$in": offer_ids } });
    }
    if !vector_oids.is_empty() {
        lookup_filters.push(doc! { "_id": { "$in": vector_oids } });
    }

    let offers = if lookup_filters.is_empty() {
        Vec::new()
    } else {
        let filter = if lookup_filters.len() == 1 {
            lookup_filters.remove(0)
        } else {
            doc! { "$or": lookup_filters }
        };
        s.mongo
            .find_many("offers", filter, Default::default())
            .await
            .map_err(|_| nl_failed())?
    };

    let mut by_lookup_id = HashMap::new();
    for doc in offers {
        let offer = bson_doc_to_js_json(&doc);
        if let Some(mongo_id) = offer.get("_id") {
            by_lookup_id.insert(js_string(mongo_id), offer.clone());
        }
        if let Some(offer_id) = offer.get("id").and_then(Value::as_str) {
            by_lookup_id.insert(offer_id.to_owned(), offer);
        }
    }

    let ranked: Vec<(f64, Value)> = vector_matches
        .iter()
        .filter_map(|m| {
            let meta_id = m
                .metadata
                .as_ref()
                .and_then(|meta| meta.get("id"))
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty());
            meta_id
                .and_then(|id| by_lookup_id.get(id))
                .or_else(|| by_lookup_id.get(&m.id))
                .map(|offer| (m.score, Value::Object(ordered_offer(offer))))
        })
        .collect();

    let raw_offers: Vec<Value> = ranked.iter().map(|(_, o)| o.clone()).collect();
    let localized = localize_legacy_offers(s, &raw_offers, locale, true)
        .await
        .map_err(|_| nl_failed())?;

    Ok(ranked
        .into_iter()
        .zip(localized)
        .map(|((score, _), offer)| json!({ "score": score, "offer": offer }))
        .collect())
}

async fn natural_language(State(s): State<AppState>, uri: Uri, body: Bytes) -> Result<Response> {
    let locale = parse_locale(query(&uri, "locale").as_deref())
        .map_err(|e| Error::Json(StatusCode::BAD_REQUEST, json!({ "message": e.to_string() })))?;
    let (search_query, top_k) = parse_natural_language_body(&body)?;

    let vector_matches = s
        .vectorize
        .query_natural_language(&search_query, top_k)
        .await
        .map_err(|err| match err {
            CoreError::InvalidInput(_) => Error::Json(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({ "message": "Natural-language search is not configured" }),
            ),
            CoreError::Upstream(_) => Error::Json(
                StatusCode::BAD_GATEWAY,
                json!({ "message": "Natural-language search is temporarily unavailable" }),
            ),
            _ => Error::Json(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "message": "Natural-language search failed" }),
            ),
        })?;

    let matches = lookup_and_localize_nl_matches(&s, &vector_matches, &locale).await?;
    Ok(cache_header(
        ok(&json!({
            "query": search_query,
            "count": matches.len(),
            "matches": matches,
        })),
        "no-store",
    ))
}

fn build_count_pipeline(query: &Value, region: &str) -> Vec<Document> {
    let mut mongo_query = doc! { "namespace": { "$ne": "ue" } };
    let mut price_query = Document::new();

    if let Some(title) = query.get("title").filter(|v| is_js_truthy(v)) {
        mongo_query.insert(
            "title",
            doc! {
                "$regex": Bson::RegularExpression(Regex {
                    pattern: js_string(title),
                    options: "i".into(),
                })
            },
        );
    }
    if let Some(offer_type) = query.get("offerType").filter(|v| is_js_truthy(v)) {
        mongo_query.insert("offerType", json_to_bson(offer_type));
    }
    if let Some(tags) = query.get("tags").filter(|v| is_js_truthy(v)) {
        mongo_query.insert("tags.id", doc! { "$all": json_to_bson(tags) });
    }
    if let Some(attrs) = query.get("customAttributes").filter(|v| is_js_truthy(v)) {
        mongo_query.insert(
            "customAttributes",
            doc! { "$elemMatch": { "id": { "$in": json_to_bson(attrs) } } },
        );
    }
    if let Some(categories) = query.get("categories").filter(|v| is_js_truthy(v)) {
        mongo_query.insert("categories", doc! { "$all": json_to_bson(categories) });
    }
    if let Some(seller) = query.get("seller").filter(|v| is_js_truthy(v)) {
        let seller_bson = json_to_bson(seller);
        mongo_query.insert(
            "$or",
            vec![
                doc! { "seller.name": seller_bson.clone() },
                doc! { "seller.id": seller_bson },
            ],
        );
    }
    for key in ["developerDisplayName", "publisherDisplayName", "refundType"] {
        if let Some(val) = query.get(key).filter(|v| is_js_truthy(v)) {
            mongo_query.insert(key, json_to_bson(val));
        }
    }
    if let Some(val) = query.get("isCodeRedemptionOnly") {
        mongo_query.insert("isCodeRedemptionOnly", json_to_bson(val));
    }
    if query.get("excludeBlockchain").is_some_and(is_js_truthy) {
        if query.get("tags").is_some_and(is_js_truthy) {
            if let Ok(tags_doc) = mongo_query.get_document_mut("tags.id") {
                tags_doc.insert("$ne", "21739");
            }
        } else {
            mongo_query.insert("tags.id", doc! { "$ne": "21739" });
        }
    }

    if let Some(price) = query.get("price").filter(|v| is_js_truthy(v)) {
        let mut range = Document::new();
        if let Some(min) = price.get("min").filter(|v| is_js_truthy(v)) {
            range.insert("$gte", json_to_bson(min));
        }
        if let Some(max) = price.get("max").filter(|v| is_js_truthy(v)) {
            range.insert("$lte", json_to_bson(max));
        }
        if !range.is_empty() {
            price_query.insert("price.discountPrice", range);
        }
    }
    if query.get("onSale").is_some_and(is_js_truthy) {
        price_query.insert("price.discount", doc! { "$gt": 0 });
    }

    let mut lookup_match = doc! { "region": region };
    for (k, v) in price_query {
        lookup_match.insert(k, v);
    }

    let mut pipeline = vec![
        doc! { "$match": mongo_query },
        doc! {
            "$lookup": {
                "from": "pricev2",
                "localField": "id",
                "foreignField": "offerId",
                "as": "priceEngine",
                "pipeline": [{ "$match": lookup_match }],
            }
        },
        doc! { "$addFields": { "price": { "$arrayElemAt": ["$priceEngine", 0] } } },
        doc! { "$match": { "price": { "$ne": Bson::Null } } },
    ];

    if query.get("pastGiveaways").is_some_and(is_js_truthy) {
        pipeline.push(doc! {
            "$lookup": {
                "from": "freegames",
                "localField": "id",
                "foreignField": "id",
                "as": "freegame",
            }
        });
        pipeline.push(doc! { "$match": { "freegame": { "$ne": [] } } });
    }

    pipeline.push(doc! {
        "$facet": {
            "total": [{ "$count": "total" }],
            "tagCounts": [
                { "$unwind": "$tags" },
                { "$group": { "_id": "$tags.id", "count": { "$sum": 1 } } },
            ],
            "offerTypeCounts": [
                { "$group": { "_id": "$offerType", "count": { "$sum": 1 } } },
            ],
            "developer": [
                { "$unwind": "$developerDisplayName" },
                { "$group": { "_id": "$developerDisplayName", "count": { "$sum": 1 } } },
            ],
            "publisher": [
                { "$unwind": "$publisherDisplayName" },
                { "$group": { "_id": "$publisherDisplayName", "count": { "$sum": 1 } } },
                { "$sort": { "count": -1 } },
            ],
            "priceRange": [
                {
                    "$group": {
                        "_id": Bson::Null,
                        "minPrice": { "$min": "$price.price.discountPrice" },
                        "maxPrice": { "$max": "$price.price.discountPrice" },
                        "currency": { "$first": "$price.price.currencyCode" },
                    }
                }
            ],
        }
    });
    pipeline
}

async fn count(
    State(s): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Response> {
    let country = selected_country(&uri, &headers);
    let region = REGIONS
        .iter()
        .find(|(_, info)| info.countries.contains(&country.as_str()))
        .map(|(code, _)| *code)
        .unwrap_or("US");

    let cache_key = format!("search:count:{id}:{region}:v0.5");
    if let Some(hit) = cached(&s, &cache_key).await? {
        return Ok(cache_header(ok(&hit), ONE_MINUTE));
    }

    let raw = s
        .saved_queries
        .get(&id)
        .await?
        .filter(|v| !v.is_empty())
        .ok_or_else(|| not_found("Query not found"))?;
    let saved_query: Value = serde_json::from_str(&raw)?;

    let pipeline = build_count_pipeline(&saved_query, region);
    let count_error = || {
        Error::Json(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "message": "Error while counting results" }),
        )
    };

    let rows = s
        .mongo
        .aggregate("offers", pipeline)
        .await
        .map_err(|_| count_error())?;
    let row = rows
        .first()
        .map(bson_doc_to_js_json)
        .unwrap_or_else(|| json!({}));

    let result = json!({
        "tagCounts": row.get("tagCounts").filter(|v| is_js_truthy(v)).cloned().unwrap_or_else(|| json!([])),
        "offerTypeCounts": row.get("offerTypeCounts").filter(|v| is_js_truthy(v)).cloned().unwrap_or_else(|| json!([])),
        "total": row.pointer("/total/0/total").filter(|v| is_js_truthy(v)).cloned().unwrap_or_else(|| json!(0)),
        "developer": row.get("developer").filter(|v| is_js_truthy(v)).cloned().unwrap_or_else(|| json!([])),
        "publisher": row.get("publisher").filter(|v| is_js_truthy(v)).cloned().unwrap_or_else(|| json!([])),
        "priceRange": row.pointer("/priceRange/0").filter(|v| is_js_truthy(v)).cloned().unwrap_or_else(|| json!({ "minPrice": null, "maxPrice": null })),
    });

    store(&s, &cache_key, &result, 3600)
        .await
        .map_err(|_| count_error())?;
    Ok(cache_header(ok(&result), ONE_MINUTE))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        legacy::common::Error as LegacyError, middleware::test_support::test_app_state,
        state::ApiConfig, v1::oracle_test_support::capture_response,
    };
    use async_trait::async_trait;
    use axum::{body::Body, http::Request};
    use egdata_core::ports::{
        MongoFindOptions, MongoStorePort, OpenSearchPort, ResponseCachePort, VectorizePort,
    };
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;

    struct ExtraReads {
        name: String,
        remaining: Mutex<Vec<Value>>,
    }

    impl ExtraReads {
        fn replay(&self, call: Value) -> std::result::Result<Value, Value> {
            let mut remaining = self.remaining.lock().unwrap();
            let index = remaining
                .iter()
                .position(|entry| entry["call"] == call)
                .unwrap();
            let entry = remaining.remove(index);
            if index > 0 {
                assert!(call["method"] == "one" && remaining[0]["call"]["method"] == "one");
            }
            if !entry["error"].is_null() {
                Err(entry["error"].clone())
            } else {
                Ok(entry["result"].clone())
            }
        }

        fn mongo(
            &self,
            collection: &str,
            method: &str,
            query: Value,
            options: Value,
        ) -> std::result::Result<Value, CoreError> {
            self.replay(json!({
                "collection": collection,
                "method": method,
                "query": query,
                "options": options
            }))
            .map_err(|_| CoreError::Internal("fixture read failed".into()))
        }
    }

    fn fixture_bson(value: &Bson) -> Value {
        match value {
            Bson::ObjectId(id) => json!({"$oid": id.to_hex()}),
            Bson::RegularExpression(regex) => {
                json!({"$regularExpression": {"pattern": regex.pattern, "options": regex.options}})
            }
            Bson::Document(doc) => fixture_doc(doc),
            Bson::Array(items) => Value::Array(items.iter().map(fixture_bson).collect()),
            other => egdata_infra::bson_json::bson_to_js_json(other),
        }
    }

    fn fixture_doc(doc: &Document) -> Value {
        Value::Object(
            doc.iter()
                .map(|(k, v)| (k.clone(), fixture_bson(v)))
                .collect(),
        )
    }

    fn result_doc(value: &Value) -> Document {
        Bson::try_from(value.clone())
            .unwrap()
            .as_document()
            .unwrap()
            .clone()
    }

    fn find_options(opt: MongoFindOptions) -> Value {
        let mut options = json!({});
        if let Some(v) = opt.sort {
            options["sort"] = bson_doc_to_js_json(&v);
        }
        if let Some(v) = opt.projection {
            options["projection"] = bson_doc_to_js_json(&v);
        }
        if let Some(v) = opt.limit {
            options["limit"] = json!(v);
        }
        if let Some(v) = opt.skip {
            options["skip"] = json!(v);
        }
        options
    }

    #[async_trait]
    impl MongoStorePort for ExtraReads {
        async fn find_one(
            &self,
            collection: &str,
            filter: Document,
            projection: Option<Document>,
        ) -> std::result::Result<Option<Document>, CoreError> {
            let value = self.mongo(
                collection,
                "one",
                fixture_doc(&filter),
                find_options(MongoFindOptions {
                    projection,
                    ..Default::default()
                }),
            )?;
            Ok((!value.is_null()).then(|| result_doc(&value)))
        }

        async fn find_many(
            &self,
            collection: &str,
            filter: Document,
            opt: MongoFindOptions,
        ) -> std::result::Result<Vec<Document>, CoreError> {
            let value = self.mongo(collection, "many", fixture_doc(&filter), find_options(opt))?;
            Ok(value.as_array().unwrap().iter().map(result_doc).collect())
        }

        async fn aggregate(
            &self,
            collection: &str,
            pipeline: Vec<Document>,
        ) -> std::result::Result<Vec<Document>, CoreError> {
            let stages = pipeline.iter().map(fixture_doc).collect();
            let value = self.mongo(collection, "aggregate", Value::Array(stages), json!({}))?;
            Ok(value.as_array().unwrap().iter().map(result_doc).collect())
        }

        async fn count_documents(
            &self,
            collection: &str,
            filter: Document,
        ) -> std::result::Result<u64, CoreError> {
            let value = self.mongo(collection, "count", fixture_doc(&filter), json!({}))?;
            Ok(value.as_u64().unwrap())
        }

        async fn distinct(
            &self,
            _: &str,
            _: &str,
            _: Document,
        ) -> std::result::Result<Vec<Bson>, CoreError> {
            Ok(vec![])
        }
        async fn insert_one(&self, _: &str, _: Document) -> std::result::Result<(), CoreError> {
            Ok(())
        }
        async fn update_one(
            &self,
            _: &str,
            _: Document,
            _: Document,
            _: bool,
        ) -> std::result::Result<u64, CoreError> {
            Ok(0)
        }
        async fn delete_one(&self, _: &str, _: Document) -> std::result::Result<u64, CoreError> {
            Ok(0)
        }
        async fn ping(&self) -> std::result::Result<bool, CoreError> {
            Ok(true)
        }
    }

    #[async_trait]
    impl OpenSearchPort for ExtraReads {
        async fn search(&self, index: &str, body: &Value) -> std::result::Result<Value, CoreError> {
            self.replay(json!({
                "service": "opensearch",
                "method": "search",
                "index": index,
                "body": body
            }))
            .map_err(|_| CoreError::Upstream("opensearch failed".into()))
        }
    }

    #[async_trait]
    impl VectorizePort for ExtraReads {
        async fn query_natural_language(
            &self,
            query: &str,
            top_k: usize,
        ) -> std::result::Result<Vec<VectorizeOfferMatch>, CoreError> {
            match self.replay(json!({
                "service": "vectorize",
                "method": "queryNaturalLanguage",
                "query": query,
                "topK": top_k
            })) {
                Ok(val) => Ok(serde_json::from_value(val).unwrap()),
                Err(err) if err.as_str() == Some("config") => {
                    Err(CoreError::InvalidInput("not configured".into()))
                }
                Err(err) if err.as_str() == Some("upstream") => {
                    Err(CoreError::Upstream("upstream error".into()))
                }
                Err(_) => Err(CoreError::Internal("vectorize failed".into())),
            }
        }
    }

    #[async_trait]
    impl ResponseCachePort for ExtraReads {
        async fn get(&self, key: &str) -> std::result::Result<Option<String>, CoreError> {
            let hit = self
                .replay(json!({ "method": "get", "key": key }))
                .map_err(|_| CoreError::Internal("cache get".into()))?;
            Ok((!hit.is_null()).then(|| hit.to_string()))
        }

        async fn set(
            &self,
            key: &str,
            payload: &str,
            ttl: u64,
        ) -> std::result::Result<(), CoreError> {
            let mut call = json!({ "method": "set", "key": key, "ttl": ttl });
            if !payload.is_empty() {
                call["payload"] = serde_json::from_str::<Value>(payload).unwrap();
            }
            self.replay(call)
                .map_err(|_| CoreError::Internal("cache set".into()))?;
            Ok(())
        }

        async fn del(&self, _: &str) -> std::result::Result<(), CoreError> {
            Ok(())
        }
        async fn ping(&self) -> std::result::Result<bool, CoreError> {
            Ok(true)
        }
    }

    #[tokio::test]
    async fn legacy_search_extra_http_node_oracle() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../../tests/fixtures/legacy-search-extra-http-node.json"
        ))
        .unwrap();

        for case in cases {
            let reads = Arc::new(ExtraReads {
                name: case["name"].as_str().unwrap().into(),
                remaining: Mutex::new(case["trace"].as_array().unwrap().clone()),
            });
            let mut state = test_app_state(ApiConfig::default());
            state.now = || "2026-11-17T00:00:00Z".parse().unwrap();
            state.mongo = reads.clone();
            state.cache = reads.clone();
            state.saved_queries = reads.clone();
            state.opensearch = reads.clone();
            state.vectorize = reads.clone();

            let app = crate::runtime::application(state);
            let source = &case["request"];
            let mut builder = Request::builder()
                .method(source["method"].as_str().unwrap())
                .uri(source["path"].as_str().unwrap());
            if let Some(headers) = source["headers"].as_object() {
                for (k, v) in headers {
                    builder = builder.header(k, v.as_str().unwrap());
                }
            }
            let body = source["rawBody"]
                .as_str()
                .map(|raw| Body::from(raw.to_string()))
                .unwrap_or_default();
            let response = app.oneshot(builder.body(body).unwrap()).await.unwrap();
            assert_eq!(
                capture_response(response).await,
                case["response"],
                "{}",
                reads.name
            );
            assert!(
                reads.remaining.lock().unwrap().is_empty(),
                "{} missing reads",
                reads.name
            );
        }
    }

    #[test]
    fn unit_helpers_cover_scalar_and_edge_branches() {
        assert_eq!(parse_int_or(None, 10), 10);
        assert_eq!(parse_int_or(Some("0"), 10), 10);
        assert_eq!(parse_int_or(Some("-5"), 10), -5);
        assert_eq!(parse_int_or(Some("+7abc"), 10), 7);
        assert_eq!(parse_int_or(Some("abc"), 10), 10);

        assert_eq!(json_to_bson(&Value::Null), Bson::Null);
        assert_eq!(json_to_bson(&json!(true)), Bson::Boolean(true));
        assert_eq!(json_to_bson(&json!(12)), Bson::Int64(12));
        assert_eq!(json_to_bson(&json!(12.5)), Bson::Double(12.5));
        assert_eq!(json_to_bson(&json!(12.0)), Bson::Int64(12));
        assert_eq!(json_to_bson(&json!(-0.0)), Bson::Int64(0));
        assert_eq!(
            json_to_bson(&json!(u64::MAX)),
            Bson::Double(u64::MAX as f64)
        );
        assert_eq!(
            json_to_bson(&json!({ "a": [1, "x"] })),
            Bson::Document(doc! { "a": [1_i64, "x"] })
        );

        assert_eq!(
            normalize_changelog_value(Some(&json!("cur")), Some(&json!("raw"))),
            json!("cur")
        );
        assert_eq!(normalize_changelog_value(None, None), Value::Null);
        assert_eq!(
            normalize_changelog_value(None, Some(&Value::Null)),
            Value::Null
        );
        assert_eq!(
            normalize_changelog_value(None, Some(&json!(123))),
            json!(123)
        );
        assert_eq!(
            normalize_changelog_value(None, Some(&json!("[1,2]"))),
            json!([1, 2])
        );
        assert_eq!(
            normalize_changelog_value(None, Some(&json!("raw-text"))),
            json!("raw-text")
        );

        assert!(is_js_truthy(&json!(1)));
        assert!(!is_js_truthy(&json!(0)));
        assert!(!is_js_truthy(&json!("")));
        assert!(!is_js_truthy(&json!(false)));
        assert!(!is_js_truthy(&Value::Null));
        assert!(is_js_truthy(&json!([])));
        assert_eq!(
            mongo_changelog_hits(vec![doc! { "title": "no-id" }]),
            vec![json!({ "title": "no-id", "_id": "undefined" })]
        );
    }

    #[tokio::test]
    async fn unit_hydration_and_localization_error_branches() {
        let mut state = test_app_state(ApiConfig::default());
        let mut empty_hits = Vec::new();
        hydrate_changelog_values(&state, &mut empty_hits).await;
        assert!(empty_hits.is_empty());

        let mut no_id_hits = vec![json!({ "metadata": { "changes": [] } })];
        hydrate_changelog_values(&state, &mut no_id_hits).await;
        assert_eq!(no_id_hits[0]["metadata"]["changes"], json!([]));

        let matches = vec![VectorizeOfferMatch {
            id: "vec".into(),
            score: 0.9,
            metadata: None,
        }];
        assert!(
            lookup_and_localize_nl_matches(&state, &matches, "en-US")
                .await
                .is_ok_and(|v| v.is_empty())
        );

        let reads = Arc::new(ExtraReads {
            name: "unit".into(),
            remaining: Mutex::new(vec![
                json!({
                    "call": { "service": "opensearch", "method": "search", "index": "egdata.offers", "body": { "size": 100, "query": { "multi_match": { "query": "x", "fields": ["title^3", "description", "id"] } } } },
                    "result": {}
                }),
                json!({
                    "call": { "service": "opensearch", "method": "search", "index": "egdata.items", "body": { "size": 100, "query": { "multi_match": { "query": "x", "fields": ["title^3", "description", "id"] } } } },
                    "result": {}
                }),
                json!({
                    "call": { "collection": "offers", "method": "many", "query": { "id": { "$in": ["offer-1"] } }, "options": {} },
                    "result": [{ "_id": "1", "id": "offer-1", "namespace": "ns-1" }]
                }),
                json!({
                    "call": { "collection": "egs_localizations", "method": "many", "query": { "entityType": "offer", "entityId": { "$in": ["ns-1:offer-1"] }, "locale": "de-DE" }, "options": {} },
                    "error": true
                }),
                json!({
                    "call": { "method": "get", "key": "err-key" },
                    "error": true
                }),
            ]),
        });
        state.mongo = reads.clone();
        state.opensearch = reads.clone();

        assert!(
            fetch_related_context_ids(&state, "x")
                .await
                .is_ok_and(|v| v.is_empty())
        );

        let matches = vec![VectorizeOfferMatch {
            id: "vec".into(),
            score: 0.9,
            metadata: Some([("id".into(), json!("offer-1"))].into_iter().collect()),
        }];
        assert!(matches!(
            lookup_and_localize_nl_matches(&state, &matches, "de-DE").await,
            Err(LegacyError::Json(StatusCode::INTERNAL_SERVER_ERROR, _))
        ));

        // Cover unused trait stub methods on ExtraReads so test harness has 100% coverage.
        assert!(
            MongoStorePort::distinct(reads.as_ref(), "c", "f", doc! {})
                .await
                .is_ok()
        );
        assert!(
            MongoStorePort::insert_one(reads.as_ref(), "c", doc! {})
                .await
                .is_ok()
        );
        assert!(
            MongoStorePort::update_one(reads.as_ref(), "c", doc! {}, doc! {}, false)
                .await
                .is_ok()
        );
        assert!(
            MongoStorePort::delete_one(reads.as_ref(), "c", doc! {})
                .await
                .is_ok()
        );
        assert!(MongoStorePort::ping(reads.as_ref()).await.is_ok());
        assert!(ResponseCachePort::del(reads.as_ref(), "k").await.is_ok());
        assert!(ResponseCachePort::ping(reads.as_ref()).await.is_ok());
        assert!(
            ResponseCachePort::get(reads.as_ref(), "err-key")
                .await
                .is_err()
        );
    }
}
