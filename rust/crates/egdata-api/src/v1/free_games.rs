//! Free-game routes migrated from `src/v1/routes/free-games.ts`.

use futures::{FutureExt, StreamExt, stream::FuturesUnordered};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    future::Future,
    sync::Arc,
};

use axum::{
    Extension,
    extract::State,
    http::{Method, Uri},
    response::Response,
};
use bson::{Bson, Document, doc};
use egdata_core::{
    ports::MongoFindOptions,
    v1::{
        CursorBinding, CursorSortValue, MongoSortField, NullsOrder, ProblemError, SortDirection,
        decode_cursor_with, encode_cursor_with, encode_cursor_with_filter_order,
        mongo_keyset_filter, page_meta, parse_pagination_map, regional_params, service_unavailable,
        trim_page,
    },
};
use serde_json::{Value, json};

use super::{
    RouteGroup,
    helpers::{
        V1RequestContext, json_envelope_response, parse_strict_query_uri, problem_response,
        v1_cache_get, v1_cache_key, v1_cache_set,
    },
    offers::checked_ordered,
    system::{doc_to_json, docs_to_json, internal_error, localize_offers, stored_string_key},
};
use crate::state::AppState;

type Payload = Result<Value, ProblemError>;

pub fn route_group(prefix: &str) -> RouteGroup {
    RouteGroup::new(prefix)
        .get("/free-games", |State(s), u, ctx| {
            dispatch(s, u, ctx, Operation::Current)
        })
        .get("/free-games/history", |State(s), u, ctx| {
            dispatch(s, u, ctx, Operation::History)
        })
        .get("/free-games/search", |State(s), u, ctx| {
            dispatch(s, u, ctx, Operation::Search)
        })
        .get("/free-games/stats", |State(s), u, ctx| {
            dispatch(s, u, ctx, Operation::Stats)
        })
        .get("/free-games/mobile", |State(s), u, ctx| {
            dispatch(s, u, ctx, Operation::Mobile)
        })
        .get("/free-games/sellers", |State(s), u: Uri, ctx| async move {
            respond(&u, ctx, sellers(&s).await)
        })
}

#[derive(Clone, Copy)]
enum Operation {
    Current,
    History,
    Search,
    Stats,
    Mobile,
}

async fn dispatch(
    state: AppState,
    uri: Uri,
    ctx: Option<Extension<V1RequestContext>>,
    op: Operation,
) -> Response {
    respond(&uri, ctx, execute(&state, &uri, op).await)
}

fn respond(uri: &Uri, ctx: Option<Extension<V1RequestContext>>, payload: Payload) -> Response {
    let request_id = ctx.map(|Extension(ctx)| ctx.request_id).unwrap_or_default();
    match payload {
        Ok(envelope) => json_envelope_response(&Method::GET, uri.path(), &request_id, envelope),
        Err(error) => problem_response(&error, uri.path(), Some(&request_id)),
    }
}

async fn execute(state: &AppState, uri: &Uri, op: Operation) -> Payload {
    let query_keys: &[&str] = match op {
        Operation::Current | Operation::Stats | Operation::Mobile => &["country", "locale"],
        Operation::History => &["country", "locale", "limit", "cursor"],
        Operation::Search => &[
            "title",
            "offerType",
            "tags",
            "categories",
            "sortBy",
            "sortDir",
            "country",
            "locale",
            "limit",
            "cursor",
        ],
    };
    let query = if matches!(op, Operation::Search) {
        super::helpers::parse_validated_query(uri, query_keys, |params| {
            super::helpers::search_query_issues(
                params,
                "title",
                &[
                    (
                        "offerType",
                        &[
                            "IN_GAME_PURCHASE",
                            "BASE_GAME",
                            "EXPERIENCE",
                            "UNLOCKABLE",
                            "ADD_ON",
                            "Bundle",
                            "CONSUMABLE",
                            "WALLET",
                            "OTHERS",
                            "DEMO",
                            "DLC",
                            "VIRTUAL_CURRENCY",
                            "BUNDLE",
                            "DIGITAL_EXTRA",
                            "EDITION",
                        ],
                    ),
                    (
                        "sortBy",
                        &[
                            "giveawayDate",
                            "releaseDate",
                            "lastModifiedDate",
                            "effectiveDate",
                            "creationDate",
                            "viewableDate",
                            "pcReleaseDate",
                            "upcoming",
                            "price",
                            "giveaway.endDate",
                            "price.price.discountPrice",
                        ],
                    ),
                    ("sortDir", &["asc", "desc"]),
                ],
            )
        })?
    } else {
        parse_strict_query_uri(uri, query_keys)?
    };
    let region = regional_params(
        query.get("country").map(String::as_str),
        query.get("locale").map(String::as_str),
    )?;
    match op {
        Operation::Current => current(state, &region).await,
        Operation::History => history(state, &query, &region).await,
        Operation::Search => search(state, uri, &query, &region).await,
        Operation::Stats => stats(state, &region).await,
        Operation::Mobile => mobile(state, &region).await,
    }
}

async fn cached<F, Fut>(
    state: &AppState,
    key: String,
    ttl: u64,
    load: F,
) -> Result<Value, ProblemError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<Value, ProblemError>>,
{
    if let Some(hit) = v1_cache_get(state.cache.as_ref(), &key).await {
        return Ok(hit);
    }
    let value = load().await?;
    v1_cache_set(state.cache.as_ref(), &key, &value, ttl).await;
    Ok(value)
}

fn cache_parts<'a>(parts: &[(&'a str, Value)]) -> BTreeMap<&'a str, Value> {
    parts
        .iter()
        .map(|(key, value)| (*key, value.clone()))
        .collect()
}

fn meta_region(region: &egdata_core::v1::RegionalParams) -> Value {
    json!({"country":region.country,"region":region.region,"locale":region.locale})
}

// Redis can contain an older payload shape. Hono omits undefined properties
// from its JSON envelope and preserves explicitly stored nulls.
fn counted_response(data: Value, mut meta: Value) -> Value {
    let count = match &data {
        Value::Array(rows) => Some(json!(rows.len())),
        Value::String(text) => Some(json!(text.encode_utf16().count())),
        other => other.get("length").cloned(),
    };
    if let Some(count) = count {
        meta["count"] = count;
    }
    let mut envelope = json!({});
    envelope["data"] = data;
    envelope["meta"] = meta;
    envelope
}

fn page_response(mut page: Value, mut meta: Value, fields: &[&str]) -> Value {
    for field in fields {
        if let Some(value) = page.get_mut(*field) {
            meta[*field] = value.take();
        }
    }
    let mut envelope = json!({});
    if let Some(data) = page.get_mut("data") {
        envelope["data"] = data.take();
    }
    envelope["meta"] = meta;
    envelope
}

async fn find(
    state: &AppState,
    collection: &str,
    filter: Document,
    options: MongoFindOptions,
) -> Result<Vec<Value>, ProblemError> {
    state
        .mongo
        .find_many(collection, filter, options)
        .await
        .map(|rows| {
            rows.iter()
                .map(egdata_infra::bson_json::bson_doc_to_js_json)
                .collect()
        })
        .map_err(|_| internal_error())
}

fn id(value: &Value, field: &str) -> String {
    super::system::js_primitive_string(&value[field])
}

pub(crate) fn string_property(row: &Value, field: &str) -> String {
    row.get(field).map_or_else(
        || "undefined".to_owned(),
        egdata_core::v1::serialization::js_string,
    )
}

fn mongo_ids(ids: &[String]) -> Vec<Bson> {
    ids.iter().cloned().map(Bson::String).collect()
}

async fn prices(
    state: &AppState,
    ids: &[String],
    region: &str,
) -> Result<HashMap<String, Value>, ProblemError> {
    Ok(find(
        state,
        "pricev2",
        doc! {"offerId":{"$in":Bson::Array(mongo_ids(ids))},"region":region},
        MongoFindOptions::default(),
    )
    .await?
    .into_iter()
    .map(|row| (string_property(&row, "offerId"), row))
    .collect())
}

fn ordered_with_price(offer: &Value, price: Option<&Value>) -> Result<Value, ProblemError> {
    let mut row = checked_ordered(offer)?;
    row["price"] = price.cloned().unwrap_or(Value::Null);
    Ok(row)
}

pub(crate) fn normalized_giveaway(raw: &Value, offer_id: &str, historical: Option<Value>) -> Value {
    let mut object = raw.as_object().cloned().unwrap_or_default();
    if !object.get("offerId").is_some_and(Value::is_string) {
        object.insert("offerId".into(), json!(offer_id));
    }
    if !object.get("platform").is_some_and(Value::is_string) {
        object.insert("platform".into(), Value::Null);
    }
    if let Some(historical) = historical {
        object.insert("historical".into(), historical);
    }
    Value::Object(object)
}

fn end_date_filter(now: chrono::DateTime<chrono::Utc>) -> Document {
    doc! {"endDate":{"$gte":bson::DateTime::from_chrono(now)}}
}

// Promise.all keeps input order and lets already-started siblings finish on failure.
async fn collect_giveaway_reads<T, F>(
    reads: impl IntoIterator<Item = F>,
) -> Result<Vec<T>, ProblemError>
where
    T: Send + 'static,
    F: Future<Output = Result<T, ProblemError>> + Send + 'static,
{
    let mut pending = reads
        .into_iter()
        .enumerate()
        .map(|(index, future)| async move { future.await.map(|value| (index, value)) })
        .collect::<FuturesUnordered<_>>();
    let mut completed: Vec<_> = (0..pending.len()).map(|_| None).collect();
    while let Some(result) = pending.next().await {
        match result {
            Ok((index, row)) => completed[index] = Some(row),
            Err(error) => {
                while matches!(pending.next().now_or_never(), Some(Some(_))) {}
                if !pending.is_empty() {
                    tokio::spawn(pending.for_each(|_| std::future::ready(())));
                }
                return Err(error);
            }
        }
    }
    Ok(completed.into_iter().flatten().collect())
}

fn source_id(row: &Document, key: &str) -> Result<String, ProblemError> {
    match row.get(key) {
        None | Some(Bson::Undefined | Bson::Null) => Ok(String::new()),
        other => stored_string_key(other),
    }
}

async fn enrich_sources(
    state: &AppState,
    region: &egdata_core::v1::RegionalParams,
    desktop: Vec<Document>,
    mobile: Vec<Document>,
    include_history: bool,
) -> Result<Value, ProblemError> {
    let mut sources = Vec::with_capacity(desktop.len() + mobile.len());
    for (kind, field, rows) in [("desktop", "id", desktop), ("mobile", "offerId", mobile)] {
        for row in rows {
            let id = source_id(&row, field)?;
            if !id.is_empty() {
                sources.push((kind, row, id));
            }
        }
    }
    let shared = Arc::new((state.clone(), region.clone()));
    let records = collect_giveaway_reads(sources.into_iter().map(|(kind, row, id)| {
        let shared = shared.clone();
        async move { enrich(&shared.0, row, &id, kind, &shared.1, include_history).await }
    }))
    .await?;
    Ok(Value::Array(records.into_iter().flatten().collect()))
}

async fn enrich(
    state: &AppState,
    raw: Document,
    offer_id: &str,
    kind: &str,
    region: &egdata_core::v1::RegionalParams,
    historical: bool,
) -> Result<Option<Value>, ProblemError> {
    let offer_reads = [
        ("offers", doc! {"id":offer_id}, None),
        (
            "pricev2",
            doc! {"offerId":offer_id,"region":&region.region},
            Some(doc! {"updatedAt":-1}),
        ),
    ];
    let docs = collect_giveaway_reads(offer_reads.into_iter().map(|(collection, filter, sort)| {
        let mongo = state.mongo.clone();
        async move {
            mongo
                .find_one_with_options(
                    collection,
                    filter,
                    MongoFindOptions {
                        sort,
                        ..Default::default()
                    },
                )
                .await
                .map_err(|_| internal_error())
        }
    }))
    .await?;
    let mut docs = docs.into_iter();
    let offer_doc = docs.next().flatten();
    let price_doc = docs.next().flatten();
    let historical_value = if historical {
        if kind == "desktop" {
            let rows = state
                .mongo
                .find_many("freegames", doc! {"id":offer_id}, Default::default())
                .await
                .map_err(|_| internal_error())?;
            Some(Value::Array(docs_to_json(rows)))
        } else {
            state
                .mongo
                .find_one("mobile-freebies", doc! {"offerId":offer_id}, None)
                .await
                .map_err(|_| internal_error())?
                .map(doc_to_json)
        }
    } else {
        None
    };
    let giveaway = normalized_giveaway(
        &doc_to_json(raw),
        offer_id,
        historical.then(|| historical_value.unwrap_or(Value::Null)),
    );
    let Some(offer) = offer_doc else {
        return if !historical {
            Ok(None)
        } else {
            Ok(Some(json!({"giveaway":giveaway})))
        };
    };
    let offer_items = fetch_offer_items(state, &offer).await?;
    let mut localized =
        super::system::localize_ordered_rows(state, std::slice::from_ref(&offer), &region.locale)
            .await?
            .pop()
            .expect("one localized offer");
    let blacklist = offer
        .get("countriesBlacklist")
        .map(egdata_core::bson_json::bson_to_js_json);
    localized["countriesBlacklist"] =
        normalize_blacklist(blacklist.as_ref().unwrap_or(&Value::Null));
    let mut serialized =
        super::system::serialize_stored_localized_offer(&offer, &localized, price_doc)?;
    serialized["items"] = Value::Array(offer_items);
    serialized["giveaway"] = giveaway;
    Ok(Some(serialized))
}

pub(crate) fn normalize_blacklist(value: &Value) -> Value {
    match value {
        Value::Array(values) => json!(
            values
                .iter()
                .filter(|v| v.is_string())
                .cloned()
                .collect::<Vec<_>>()
        ),
        Value::String(s) if !s.is_empty() => json!([s]),
        _ => json!([]),
    }
}

async fn fetch_offer_items(state: &AppState, offer: &Document) -> Result<Vec<Value>, ProblemError> {
    fn item_id(item: &Bson) -> Option<&str> {
        match item.as_document()?.get("id")? {
            Bson::String(id) | Bson::Symbol(id) => Some(id),
            _ => None,
        }
    }

    let offer_id = offer.get("id").unwrap_or(&Bson::Null);
    let mut ids: Vec<_> = offer
        .get_array("items")
        .into_iter()
        .flatten()
        .filter_map(item_id)
        .collect();
    let sub_docs = state
        .mongo
        .find_many(
            "offersubitems",
            doc! {"_id":offer_id},
            MongoFindOptions {
                projection: Some(doc! {"subItems":1}),
                ..Default::default()
            },
        )
        .await
        .map_err(|_| internal_error())?;
    for entry in &sub_docs {
        match entry.get("subItems") {
            None | Some(Bson::Null | Bson::Undefined) => continue,
            Some(Bson::Array(items)) => {
                for item in items {
                    if matches!(item, Bson::Null | Bson::Undefined) {
                        return Err(internal_error());
                    }
                    if let Some(id) = item_id(item) {
                        ids.push(id);
                    }
                }
            }
            _ => return Err(internal_error()),
        }
    }
    let filter = doc! {"$or":[{"id":{"$in":ids}},{"linkedOffers":offer_id}]};
    state
        .mongo
        .find_many("items", filter, Default::default())
        .await
        .map(docs_to_json)
        .map_err(|_| internal_error())
}

async fn current(state: &AppState, region: &egdata_core::v1::RegionalParams) -> Payload {
    let key = v1_cache_key(
        "free-games.current",
        &cache_parts(&[
            ("region", json!(region.region)),
            ("locale", json!(region.locale)),
        ]),
    );
    let data = cached(state, key, 60, || async {
        let now = (state.now)();
        let opts = MongoFindOptions {
            sort: Some(doc! {"endDate":1}),
            ..Default::default()
        };
        let rows = collect_giveaway_reads(["freegames", "mobile-freebies"].map(|collection| {
            let mongo = state.mongo.clone();
            let options = opts.clone();
            async move {
                mongo
                    .find_many(collection, end_date_filter(now), options)
                    .await
                    .map_err(|_| internal_error())
            }
        }))
        .await?;
        let mut rows = rows.into_iter();
        enrich_sources(
            state,
            region,
            rows.next().unwrap(),
            rows.next().unwrap(),
            true,
        )
        .await
    })
    .await?;
    Ok(counted_response(data, meta_region(region)))
}

fn cursor_binding(
    operation: &str,
    filters: Option<BTreeMap<String, Value>>,
    order: &str,
    region: &egdata_core::v1::RegionalParams,
    limit: u32,
) -> CursorBinding {
    CursorBinding {
        operation: operation.into(),
        filters,
        ordering: order.into(),
        country: region.country.clone(),
        locale: region.locale.clone(),
        limit,
    }
}

fn decode_cursor(
    state: &AppState,
    raw: Option<&String>,
    binding: &CursorBinding,
) -> Result<Option<Vec<Value>>, ProblemError> {
    raw.map(|token| {
        decode_cursor_with(
            token,
            binding,
            state.config.v1_cursor_secret.as_deref(),
            (state.now)().timestamp_millis(),
        )
        .map(|tuple| {
            tuple
                .into_iter()
                .map(|v| match v {
                    CursorSortValue::Null => Value::Null,
                    CursorSortValue::Number(n) => Value::Number(n),
                    CursorSortValue::String(s) => Value::String(s),
                })
                .collect()
        })
    })
    .transpose()
}

fn page_value(limit: u32, more: bool, token: Option<String>) -> Value {
    json!(page_meta(limit, more, token))
}

fn sort_value(value: &Value) -> CursorSortValue {
    match value {
        Value::Null => CursorSortValue::Null,
        Value::Number(n) => CursorSortValue::Number(n.clone()),
        Value::String(s) => CursorSortValue::String(s.clone()),
        Value::Bool(value) => CursorSortValue::from(i64::from(*value)),
        _ => CursorSortValue::String(super::system::js_primitive_string(value)),
    }
}

fn cursor_id(row: &Value) -> CursorSortValue {
    match &row["id"] {
        Value::Null => CursorSortValue::Null,
        id => CursorSortValue::String(egdata_core::v1::serialization::js_string(id)),
    }
}

fn giveaway_cursor_date(value: &Bson) -> Option<String> {
    use egdata_core::v1::serialization::{js_iso_datetime, js_iso_millis};
    match value {
        Bson::DateTime(d) => js_iso_millis(d.timestamp_millis()),
        Bson::Int32(i) => js_iso_millis(i64::from(*i)),
        Bson::Int64(i) if egdata_core::v1::serialization::node_bson_long(*i).is_number() => {
            js_iso_millis(*i)
        }
        Bson::Double(d) if d.is_finite() => js_iso_millis(*d as i64),
        Bson::Boolean(b) => js_iso_millis(i64::from(*b)),
        v => super::offer_price_history::cursor_date(&stored_string_key(Some(v)).ok()?)
            .map(js_iso_datetime),
    }
}

async fn history(
    state: &AppState,
    query: &BTreeMap<String, String>,
    region: &egdata_core::v1::RegionalParams,
) -> Payload {
    let paging = parse_pagination_map(query, 25)?;
    let binding = cursor_binding(
        "freeGames.history",
        Some(BTreeMap::new()),
        "endDate:desc,id:desc",
        region,
        paging.limit,
    );
    let key = v1_cache_key(
        "free-games.history",
        &cache_parts(&[
            ("region", json!(region.region)),
            ("locale", json!(region.locale)),
            ("limit", json!(paging.limit)),
            ("cursor", json!(paging.cursor)),
        ]),
    );
    let cached_page = cached(state, key, 60, || async {
        let last = decode_cursor(state, paging.cursor.as_ref(), &binding)?;
        let sort = [
            MongoSortField::new("endDate", SortDirection::Desc, NullsOrder::Last),
            MongoSortField::new("id", SortDirection::Desc, NullsOrder::Last),
        ];
        let filter = if let Some(tuple) = last.as_ref() {
            let date = tuple
                .first()
                .filter(|v| !v.is_null())
                .map(|v| {
                    let date = super::offer_price_history::cursor_date(
                        &super::system::js_primitive_string(v),
                    );
                    Bson::DateTime(bson::DateTime::from_millis(
                        date.map_or(0, |d| d.timestamp_millis()),
                    ))
                })
                .unwrap_or(Bson::Null);
            let id = tuple
                .get(1)
                .map_or(Bson::Null, |v| bson::to_bson(v).unwrap_or(Bson::Null));
            mongo_keyset_filter(&sort, &[date, id])
                .expect("the history cursor supplies one value per sort field")
        } else {
            Document::new()
        };
        let options = MongoFindOptions {
            sort: Some(doc! {"endDate":-1,"id":-1}),
            limit: Some(i64::from(paging.limit + 1)),
            ..Default::default()
        };
        // The date tie-break tuple always uses the BSON date value from the original row.
        let rows = state
            .mongo
            .find_many("freegames", filter, options)
            .await
            .map_err(|_| internal_error())?;
        let page = trim_page(rows, paging.limit as usize);
        let offer_ids = page
            .items
            .iter()
            .map(|row| source_id(row, "id"))
            .collect::<Result<Vec<_>, _>>()?;
        let ids = mongo_ids(&offer_ids);
        let filters = [
            ("offers", doc! {"id":{"$in":&ids}}),
            (
                "pricev2",
                doc! {"offerId":{"$in":ids},"region":&region.region},
            ),
        ];
        let models = collect_giveaway_reads(filters.map(|(collection, filter)| {
            let mongo = state.mongo.clone();
            async move {
                mongo
                    .find_many(collection, filter, Default::default())
                    .await
                    .map_err(|_| internal_error())
            }
        }))
        .await?;
        let mut models = models.into_iter();
        let by_id =
            |rows: Vec<Document>, key: &str| -> Result<HashMap<String, Document>, ProblemError> {
                rows.into_iter()
                    .map(|row| Ok((stored_string_key(row.get(key))?, row)))
                    .collect()
            };
        let offers = by_id(models.next().unwrap(), "id")?;
        let prices = by_id(models.next().unwrap(), "offerId")?;
        let matched: Vec<_> = offer_ids.iter().filter_map(|id| offers.get(id)).collect();
        let localized =
            super::system::localize_ordered_rows(state, &matched, &region.locale).await?;
        let mut localized = localized.into_iter();
        let data = page
            .items
            .iter()
            .zip(&offer_ids)
            .map(|(row, id)| {
                let mut entry = if let Some(offer) = offers.get(id) {
                    let localized = localized
                        .next()
                        .expect("localization preserves matched rows");
                    super::system::serialize_stored_localized_offer(
                        offer,
                        &localized,
                        prices.get(id).cloned(),
                    )?
                } else {
                    json!({})
                };
                entry["giveaway"] = normalized_giveaway(&doc_to_json(row.clone()), id, None);
                Ok::<_, ProblemError>(entry)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let token = if page.has_more {
            page.items
                .last()
                .map(|row| {
                    let date = match row
                        .get("endDate")
                        .filter(|v| super::offer_metadata::stored_truthy(v))
                    {
                        Some(v) => CursorSortValue::String(
                            giveaway_cursor_date(v).ok_or_else(internal_error)?,
                        ),
                        None => CursorSortValue::Null,
                    };
                    let key = match row.get("id") {
                        None | Some(Bson::Null | Bson::Undefined) => CursorSortValue::Null,
                        value => CursorSortValue::String(stored_string_key(value)?),
                    };
                    let tuple = [date, key];
                    encode_cursor_with(
                        &binding,
                        &tuple,
                        state.config.v1_cursor_secret.as_deref(),
                        (state.now)().timestamp_millis(),
                    )
                })
                .transpose()?
        } else {
            None
        };
        Ok(json!({"data":data,"pagination":page_value(paging.limit,page.has_more,token)}))
    })
    .await?;
    Ok(page_response(
        cached_page,
        meta_region(region),
        &["pagination"],
    ))
}

fn csv_values(uri: &Uri, field: &str) -> Vec<String> {
    let mut values = Vec::new();
    for (key, value) in url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes()) {
        if key == field {
            values.extend(
                value
                    .split(',')
                    .map(egdata_core::v1::trim_js_whitespace)
                    .filter(|v| !v.is_empty())
                    .map(str::to_owned),
            );
        }
    }
    values.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    values.dedup();
    values
}
fn mapped_sort_field(sort_by: &str, region: &str) -> String {
    match sort_by {
        "giveawayDate" | "giveaway.endDate" => "freeEntries.endDate".into(),
        "price" | "price.price.discountPrice" => format!("prices.{region}.price.discountPrice"),
        _ => sort_by.to_string(),
    }
}

async fn search(
    state: &AppState,
    uri: &Uri,
    query: &BTreeMap<String, String>,
    region: &egdata_core::v1::RegionalParams,
) -> Payload {
    let paging = parse_pagination_map(query, 50)?;
    let title = query
        .get("title")
        .map(|v| egdata_core::v1::trim_js_whitespace(v))
        .filter(|v| !v.is_empty())
        .map(str::to_owned);
    let offer_type = query.get("offerType").cloned();
    let tags = csv_values(uri, "tags");
    let categories = csv_values(uri, "categories");
    let sort_by = query
        .get("sortBy")
        .map(String::as_str)
        .unwrap_or("lastModifiedDate");
    let sort_dir = query.get("sortDir").map(String::as_str).unwrap_or("desc");
    let sort_field = mapped_sort_field(sort_by, &region.region);
    let filters = BTreeMap::from([
        ("title".into(), json!(title)),
        ("offerType".into(), json!(offer_type)),
        ("tags".into(), json!(tags)),
        ("categories".into(), json!(categories)),
    ]);
    let binding = cursor_binding(
        "freeGames.search",
        Some(filters.clone()),
        &format!("{sort_field}:{sort_dir},id.keyword:asc"),
        region,
        paging.limit,
    );
    let key = v1_cache_key(
        "free-games.search",
        &cache_parts(&[
            ("region", json!(region.region)),
            ("locale", json!(region.locale)),
            ("limit", json!(paging.limit)),
            ("cursor", json!(paging.cursor)),
            ("title", json!(title)),
            ("offerType", json!(offer_type)),
            ("tags", json!(tags)),
            ("categories", json!(categories)),
            ("sortBy", json!(sort_by)),
            ("sortDir", json!(sort_dir)),
        ]),
    );
    let page = cached(state, key, 60, || async {
        let mut must = Vec::new();
        if let Some(title) = &title {
            must.push(
                json!({"multi_match":{"query":title,"fields":["title^3","description","id"]}}),
            );
        }
        let mut filter = vec![json!({"exists":{"field":"freeEntries"}})];
        if let Some(offer_type) = &offer_type {
            filter.push(json!({"term":{"offerType.keyword":offer_type}}));
        }
        if !tags.is_empty() {
            filter.push(json!({"terms_set":{"tags.id.keyword":{
                "terms":tags,"minimum_should_match_script":{"source":tags.len().to_string()}
            }}}));
        }
        if !categories.is_empty() {
            filter.push(json!({"terms":{"categories.keyword":categories}}));
        }
        let mut body = json!({
            "size": paging.limit + 1,
            "query": {"bool":{"must":must,"filter":filter}},
            "sort": [
                {(sort_field.as_str()): {"order":sort_dir,"missing":"_last"}},
                {"id.keyword":{"order":"asc","missing":"_last"}}
            ]
        });
        if let Some(tuple) = decode_cursor(state, paging.cursor.as_ref(), &binding)? {
            body["search_after"] = json!(tuple);
        }
        let response = state
            .opensearch
            .search("egdata.offers", &body)
            .await
            .map_err(|_| {
                service_unavailable(
                    "SEARCH_UNAVAILABLE",
                    "The free-game search index is temporarily unavailable.",
                )
            })?;
        let hits = response
            .pointer("/hits/hits")
            .and_then(Value::as_array)
            .ok_or_else(internal_error)?;
        let total = &response["hits"]["total"];
        let (total_value, total_relation) = if total.is_number() {
            (total.clone(), json!("eq"))
        } else {
            (total["value"].clone(), total["relation"].clone())
        };
        let has_more = hits.len() > paging.limit as usize;
        let page = &hits[..hits.len().min(paging.limit as usize)];
        if page.iter().any(Value::is_null) {
            return Err(internal_error());
        }
        let ids: Vec<_> = page.iter().map(|hit| id(&hit["_source"], "id")).collect();
        let prices_by_id = prices(state, &ids, &region.region).await?;
        let ordered_offers: Vec<_> = page
            .iter()
            .map(|hit| {
                let source = &hit["_source"];
                ordered_with_price(source, prices_by_id.get(&string_property(source, "id")))
            })
            .collect::<Result<_, _>>()?;
        let data: Vec<_> = localize_offers(state, &ordered_offers, &region.locale)
            .await?
            .into_iter()
            .map(|offer| {
                egdata_core::v1::serialization::serialize_json_offer(
                    &offer,
                    offer.get("price"),
                    true,
                )
            })
            .collect();
        let token = if has_more {
            let hit = page.last().expect("a truncated page has a last hit");
            let tuple = match hit["sort"].as_array().filter(|sort| !sort.is_empty()) {
                Some(sort) => sort.iter().map(sort_value).collect::<Vec<_>>(),
                None => {
                    let source = &hit["_source"];
                    let field = sort_field
                        .split('.')
                        .try_fold(source, |row, part| row.get(part));
                    vec![sort_value(field.unwrap_or(&Value::Null)), cursor_id(source)]
                }
            };
            Some(encode_cursor_with_filter_order(
                &binding,
                &tuple,
                state.config.v1_cursor_secret.as_deref(),
                (state.now)().timestamp_millis(),
                &["title", "offerType", "tags", "categories"],
            )?)
        } else {
            None
        };
        Ok(json!({
            "data": data,
            "pagination": page_value(paging.limit, has_more, token),
            "result": {
                "total": total_value, "totalRelation": total_relation,
                "timedOut": super::search::js_truthy(&response["timed_out"]),
                "tookMs": number(&response["took"])
            }
        }))
    })
    .await?;
    Ok(page_response(
        page,
        meta_region(region),
        &["pagination", "result"],
    ))
}

fn number(value: &Value) -> Option<f64> {
    let n = match value {
        Value::Bool(v) => f64::from(*v),
        Value::Null => 0.0,
        _ => super::system::js_string_number(&super::system::js_primitive_string(value)),
    };
    n.is_finite().then_some(n)
}
async fn stats(state: &AppState, region: &egdata_core::v1::RegionalParams) -> Payload {
    let key = v1_cache_key(
        "free-games.stats",
        &cache_parts(&[("region", json!(region.region))]),
    );
    let data = cached(state, key, 3600, || async {
        let giveaways = find(
            state,
            "freegames",
            Document::new(),
            MongoFindOptions {
                sort: Some(doc! {"endDate":-1}),
                ..Default::default()
            },
        )
        .await?;
        let ids: Vec<String> = giveaways
            .iter()
            .map(|v| id(v, "id"))
            .filter(|v| !v.is_empty())
            .collect();
        let (offers, priced) = tokio::join!(
            find(
                state,
                "offers",
                doc! {"id":{"$in":mongo_ids(&ids)}},
                MongoFindOptions::default()
            ),
            find(
                state,
                "pricev2",
                doc! {"offerId":{"$in":mongo_ids(&ids)},"region":&region.region},
                MongoFindOptions::default()
            ),
        );
        let (offers, priced) = (offers?, priced?);
        let mut repetitions = HashMap::<&str, u32>::new();
        for id in &ids {
            *repetitions.entry(id).or_default() += 1;
        }
        let sellers: HashSet<_> = offers
            .iter()
            .filter_map(|offer| offer.pointer("/seller/id").filter(|id| !id.is_null()))
            .map(super::system::js_primitive_string)
            .collect();
        let prices: Vec<_> = priced
            .iter()
            .filter_map(|row| row.get("price"))
            .filter(|price| price.is_object() || price.is_array())
            .collect();
        let first = prices.first().copied().unwrap_or(&Value::Null);
        let mut total = json!({"currencyCode":first["currencyCode"].as_str()});
        for field in [
            "originalPrice",
            "discountPrice",
            "discount",
            "basePayoutPrice",
        ] {
            total[field] = json!(
                prices
                    .iter()
                    .filter_map(|price| price.get(field).and_then(number))
                    .sum::<f64>()
            );
        }
        total["basePayoutCurrencyCode"] = json!(first["basePayoutCurrencyCode"].as_str());
        total["payoutCurrencyExchangeRate"] =
            json!(first.get("payoutCurrencyExchangeRate").and_then(number));
        Ok(json!({
            "totalValue":total,
            "totalOffers":offers.len(),
            "totalGiveaways":giveaways.len(),
            "repeated":repetitions.values().filter(|n|**n>1).count(),
            "sellers":sellers.len(),
        }))
    })
    .await?;
    Ok(json!({"data":data,"meta":meta_region(region)}))
}

async fn mobile(state: &AppState, region: &egdata_core::v1::RegionalParams) -> Payload {
    let key = v1_cache_key(
        "free-games.mobile",
        &cache_parts(&[
            ("region", json!(region.region)),
            ("locale", json!(region.locale)),
        ]),
    );
    let data = cached(state, key, 60, || async {
        let now = bson::DateTime::from_chrono((state.now)());
        let records = state
            .mongo
            .find_many(
                "mobile-freebies",
                doc! {"startDate":{"$lte":now},"endDate":{"$gte":now}},
                Default::default(),
            )
            .await
            .map_err(|_| internal_error())?;
        enrich_sources(state, region, Vec::new(), records, false).await
    })
    .await?;
    Ok(counted_response(data, meta_region(region)))
}

pub(crate) fn free_sellers_pipeline() -> Vec<Document> {
    vec![
        doc! {"$group":{"_id":"$id","doc":{"$first":"$$ROOT"}}},
        doc! {"$replaceRoot":{"newRoot":"$doc"}},
        doc! {"$lookup":{"from":"offers","localField":"id","foreignField":"id","as":"offer"}},
        doc! {"$unwind":"$offer"},
        doc! {"$group":{"_id":{"sellerId":"$offer.seller.id","sellerName":"$offer.seller.name"},"totalSingleGames":{"$sum":1}}},
        doc! {"$project":{"_id":0,"sellerId":"$_id.sellerId","sellerName":"$_id.sellerName","totalSingleGames":1}},
        doc! {"$sort":{"totalSingleGames":-1}},
    ]
}

async fn sellers(state: &AppState) -> Payload {
    let key = v1_cache_key("free-games.sellers", &BTreeMap::new());
    let data = cached(state, key, 3600, || async {
        let pipeline = free_sellers_pipeline();
        let rows = state
            .mongo
            .aggregate_with_options(
                "freegames",
                pipeline,
                egdata_core::ports::MongoAggregateOptions {
                    max_time_ms: Some(60_000),
                    allow_disk_use: Some(true),
                    ..Default::default()
                },
            )
            .await
            .map_err(|_| internal_error())?;
        Ok(json!(docs_to_json(rows)))
    })
    .await?;
    Ok(counted_response(data, json!({})))
}

#[cfg(test)]
mod oracle_tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use serde_json::Value;
    use std::sync::Arc;
    use tower::ServiceExt;

    fn fixed_now() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339("2026-11-17T12:00:00.000Z")
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    #[tokio::test]
    async fn free_games_edge_cases_match_node() {
        super::super::mongo_read_oracle::replay_mongo_oracle(include_str!(
            "../../tests/fixtures/free-games-edges-http-node.json"
        ))
        .await;
    }

    #[tokio::test]
    async fn registered_free_games_routes_match_node_http_oracle() {
        let fixture: Vec<Value> = serde_json::from_str(include_str!(
            "../../tests/fixtures/free-games-http-node.json"
        ))
        .unwrap();
        for case in fixture {
            let name = &case["name"];
            let reads = Arc::new(super::super::mongo_read_oracle::RecordedReads::from_case(
                &case,
            ));
            let config = crate::state::ApiConfig {
                v1_cursor_secret: (case["noSigner"] != true)
                    .then(|| "test-cursor-secret-that-is-at-least-32-chars".into()),
                ..Default::default()
            };
            let mut state = crate::middleware::test_support::test_app_state(config);
            state.now = fixed_now;
            state.mongo = reads.clone();
            state.cache = reads.clone();
            state.opensearch = reads.clone();
            let app = route_group("/v1").router.with_state(state);
            let path = case["request"]["path"].as_str().unwrap();
            let mut request = Request::builder().uri(path).body(Body::empty()).unwrap();
            request.extensions_mut().insert(V1RequestContext {
                request_id: "req_node_oracle".into(),
                key: None,
            });
            let response = app.oneshot(request).await.unwrap();
            assert_eq!(
                crate::v1::oracle_test_support::capture_response(response).await,
                case["response"],
                "{name}"
            );
            reads.assert_finished();
        }
    }
}
