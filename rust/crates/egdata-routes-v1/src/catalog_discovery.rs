//! Remaining registered catalog discovery and changelog routes.

use super::catalog_list::{PageRead, counted_page};
use super::{
    RouteGroup,
    helpers::{
        V1RequestContext, json_envelope_response, json_success, parse_strict_query_uri,
        parse_validated_query, primitive_id, problem_response, search_query_issues, v1_cache_get,
        v1_cache_key, v1_cache_set,
    },
    system::{
        cached_length, doc_to_json, docs_to_json, internal_error, js_number_or_zero, js_truthy,
        localize_ordered_rows, regional_offer_prices, serialize_localized_offer,
        serialize_priced_offers,
    },
};
use crate::state::AppState;
use axum::{
    extract::{Path, Request, State},
    response::Response,
};
use bson::{Bson, Document, doc, oid::ObjectId};
use egdata_core::{
    ports::MongoFindOptions,
    v1::{
        CursorBinding, CursorSortValue, MongoSortField, NullsOrder, ProblemError, ProblemIssue,
        SortDirection, decode_cursor_with, encode_cursor_with, mongo_keyset_filter,
        mongo_sort_spec, page_meta, parse_pagination_map, regional_params,
        serialization::js_string, serialize_offer, serialize_value, trim_js_whitespace, trim_page,
    },
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};

pub fn route_group(prefix: &str) -> RouteGroup {
    RouteGroup::new(prefix)
        .get("/latest-games", latest_games)
        .get("/featured", featured)
        .get("/autocomplete", autocomplete)
        .get("/sales", sales)
        .get("/active-sales", active_sales)
        .get("/base-game/{namespace}", base_game)
        .get("/offer-by-slug/{slug}", offer_by_slug)
        .get("/items-from-offer/{id}", items_from_offer)
        .get("/tags", tags)
        .get("/changelog", changelog)
        .get("/changelist", changelog)
        .get("/changelist/{id}", changelist_detail)
}

fn request_id(request: &Request) -> String {
    request
        .extensions()
        .get::<V1RequestContext>()
        .map(|ctx| ctx.request_id.clone())
        .unwrap_or_default()
}

fn fail(request: &Request, error: &ProblemError) -> Response {
    problem_response(error, request.uri().path(), Some(&request_id(request)))
}

fn binding(
    operation: &str,
    filters: BTreeMap<String, Value>,
    ordering: &str,
    country: &str,
    locale: &str,
    limit: u32,
) -> CursorBinding {
    CursorBinding {
        operation: operation.into(),
        filters: Some(filters),
        ordering: ordering.into(),
        country: country.into(),
        locale: locale.into(),
        limit,
    }
}

async fn cache_or_compute<F, Fut>(
    state: &AppState,
    operation: &str,
    parts: BTreeMap<&str, Value>,
    ttl: u64,
    compute: F,
) -> Result<Value, ProblemError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<Value, ProblemError>>,
{
    let key = v1_cache_key(operation, &parts);
    if let Some(value) = v1_cache_get(state.cache.as_ref(), &key).await {
        return Ok(value);
    }
    let value = compute().await?;
    v1_cache_set(state.cache.as_ref(), &key, &value, ttl).await;
    Ok(value)
}

fn success(request: &Request, data: Value, meta: Value) -> Response {
    json_success(
        request.method(),
        request.uri().path(),
        &request_id(request),
        data,
        Some(meta),
    )
}

fn success_count(request: &Request, data: Value, mut meta: Value) -> Response {
    if let Some(count) = cached_length(&data) {
        meta["count"] = count;
    }
    success(request, data, meta)
}

fn page_field(
    request: &Request,
    page: &Value,
    field: &str,
    mut meta: Value,
    fields: &[&str],
) -> Response {
    for &key in fields {
        if let Some(value) = page.get(key) {
            meta[key] = value.clone();
        }
    }
    let mut body = json!({});
    if let Some(data) = page.get(field) {
        body["data"] = data.clone();
    }
    body["meta"] = meta;
    json_envelope_response(
        request.method(),
        request.uri().path(),
        &request_id(request),
        body,
    )
}

async fn priced_elements(
    state: &AppState,
    offers: &[Document],
    region: &str,
    locale: &str,
) -> Result<Value, ProblemError> {
    let prices = regional_offer_prices(state, offers, region).await?;
    let (elements, _) = serialize_priced_offers(state, offers, &prices, locale).await?;
    Ok(Value::Array(elements))
}

async fn latest_games(State(state): State<AppState>, request: Request) -> Response {
    let query = match parse_strict_query_uri(request.uri(), &["country", "locale"]) {
        Ok(query) => query,
        Err(error) => return fail(&request, &error),
    };
    let region = match regional_params(
        query.get("country").map(String::as_str),
        query.get("locale").map(String::as_str),
    ) {
        Ok(region) => region,
        Err(error) => return fail(&request, &error),
    };
    let value = cache_or_compute(
        &state,
        "catalog.latest-games",
        BTreeMap::from([
            ("region", json!(region.region)),
            ("locale", json!(region.locale)),
        ]),
        60,
        || async {
            let offers = state
                .mongo
                .find_many(
                    "offers",
                    doc! {"offerType":{"$in":["BASE_GAME","DLC","ADDON"]}},
                    MongoFindOptions {
                        limit: Some(25),
                        sort: Some(doc! {"creationDate":-1}),
                        ..Default::default()
                    },
                )
                .await
                .map_err(|_| internal_error())?;
            priced_elements(&state, &offers, &region.region, &region.locale).await
        },
    )
    .await;
    match value {
        Ok(elements) => success_count(
            &request,
            elements,
            json!({"country":region.country,"region":region.region,"locale":region.locale}),
        ),
        Err(error) => fail(&request, &error),
    }
}

async fn featured(State(state): State<AppState>, request: Request) -> Response {
    let query = match parse_strict_query_uri(request.uri(), &["country", "locale"]) {
        Ok(query) => query,
        Err(error) => return fail(&request, &error),
    };
    let region = match regional_params(
        query.get("country").map(String::as_str),
        query.get("locale").map(String::as_str),
    ) {
        Ok(region) => region,
        Err(error) => return fail(&request, &error),
    };
    let value = cache_or_compute(
        &state,
        "catalog.featured",
        BTreeMap::from([
            ("region", json!(region.region)),
            ("locale", json!(region.locale)),
        ]),
        300,
        || async {
            let featured = state
                .epic
                .featured_games()
                .await
                .map_err(|_| internal_error())?;
            if featured.is_empty() {
                return Ok(json!([]));
            }
            let ids: Vec<Bson> = featured
                .iter()
                .map(|entry| bson::to_bson(&entry["id"]).unwrap_or(Bson::Null))
                .collect();
            let offers = state
                .mongo
                .find_many(
                    "offers",
                    doc! {"id":{"$in":ids}},
                    MongoFindOptions {
                        sort: Some(doc! {"lastModifiedDate":-1}),
                        ..Default::default()
                    },
                )
                .await
                .map_err(|_| internal_error())?;
            priced_elements(&state, &offers, &region.region, &region.locale).await
        },
    )
    .await;
    match value {
        Ok(elements) => success_count(
            &request,
            elements,
            json!({"country":region.country,"region":region.region,"locale":region.locale}),
        ),
        Err(error) => fail(&request, &error),
    }
}

async fn autocomplete(State(state): State<AppState>, request: Request) -> Response {
    let query =
        match parse_validated_query(request.uri(), &["query", "limit", "locale"], |params| {
            let problem = match params.get("query").map(String::as_str) {
                None => Some((
                    "INVALID_TYPE",
                    "Invalid input: expected string, received undefined",
                )),
                Some("") => Some((
                    "TOO_SMALL",
                    "Too small: expected string to have >=1 characters",
                )),
                _ => None,
            };
            if let Some((code, message)) = problem {
                return vec![ProblemIssue {
                    parameter: Some("query".into()),
                    pointer: Some("/query".into()),
                    code: code.into(),
                    message: message.into(),
                }];
            }
            search_query_issues(params, "query", &[])
        }) {
            Ok(query) => query,
            Err(error) => return fail(&request, &error),
        };
    let search_query = &query["query"];
    let raw_limit = query
        .get("limit")
        .map(|value| trim_js_whitespace(value))
        .unwrap_or_default();
    let unsigned = raw_limit.strip_prefix(['+', '-']).unwrap_or(raw_limit);
    let digits = unsigned.bytes().take_while(u8::is_ascii_digit).count();
    let limit = unsigned[..digits]
        .parse::<i64>()
        .ok()
        .filter(|value| *value != 0)
        .map(|value| {
            if raw_limit.starts_with('-') {
                -value
            } else {
                value
            }
        })
        .unwrap_or(10)
        .min(10);
    let locale = match regional_params(None, query.get("locale").map(String::as_str)) {
        Ok(value) => value.locale,
        Err(error) => return fail(&request, &error),
    };
    let search = search_query
        .split(' ')
        .map(|part| format!("\"{}\"", trim_js_whitespace(part)))
        .collect::<Vec<_>>()
        .join(" | ");
    let text_filter = doc! {"$text":{"$search":&search,"$language":"en"}};
    let value = cache_or_compute(
        &state,
        "catalog.autocomplete",
        BTreeMap::from([("query", json!(search_query)), ("limit", json!(limit)), ("locale", json!(locale))]),
        60,
        || async {
            let offers = state.mongo.find_many("offers", text_filter.clone(), MongoFindOptions { limit: Some(limit), sort: Some(doc! {"score":{"$meta":"textScore"},"offerType":-1,"lastModifiedDate":-1}), collation: Some(doc! {"locale":"en","strength":1}), ..Default::default() }).await.map_err(|_| internal_error())?;
            let localized = localize_ordered_rows(&state,&offers,&locale).await?;
            let total = state.mongo.count_documents_with_options("offers", text_filter, Some(doc! {"collation":{"locale":"en","strength":1}})).await.map_err(|_| internal_error())?;
            Ok(json!({"elements":localized.iter().map(|offer| serialize_offer(offer,None,true)).collect::<Vec<_>>(),"total":total}))
        },
    ).await;
    match value {
        Ok(result) => {
            let mut meta = json!({"query":search_query});
            if let Some(total) = result.get("total") {
                meta["total"] = total.clone();
            }
            meta["locale"] = json!(locale);
            page_field(&request, &result, "elements", meta, &[])
        }
        Err(error) => fail(&request, &error),
    }
}

async fn tags(State(state): State<AppState>, request: Request) -> Response {
    let query = match parse_strict_query_uri(request.uri(), &["group"]) {
        Ok(query) => query,
        Err(error) => return fail(&request, &error),
    };
    let filter = query
        .get("group")
        .filter(|group| !group.is_empty())
        .map(|group| doc! {"groupName":group})
        .unwrap_or_default();
    match state
        .mongo
        .find_many("tags", filter, MongoFindOptions::default())
        .await
    {
        Ok(rows) => {
            let rows: Vec<_> = docs_to_json(rows).iter().map(serialize_value).collect();
            let mut meta = json!({"count":rows.len()});
            if let Some(group) = query.get("group").filter(|group| !group.is_empty()) {
                meta["group"] = json!(group);
            }
            success(&request, json!(rows), meta)
        }
        Err(_) => fail(&request, &internal_error()),
    }
}

async fn offer_by_slug(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    request: Request,
) -> Response {
    let found = state
        .mongo
        .find_one(
            "offers",
            doc! {"offerMappings.pageSlug":{"$eq":&slug}},
            Some(doc! {"id":1,"namespace":1}),
        )
        .await;
    match found {
        Ok(Some(row)) => {
            let row = doc_to_json(row);
            success(
                &request,
                json!({"id":identifier_text(row.get("id")),"namespace":row.get("namespace").cloned().unwrap_or(Value::Null)}),
                json!({}),
            )
        }
        Ok(None) => fail(
            &request,
            &ProblemError::new(404, "OFFER_NOT_FOUND", "No offer uses this page slug."),
        ),
        Err(_) => fail(&request, &internal_error()),
    }
}

async fn base_game(
    State(state): State<AppState>,
    Path(namespace): Path<String>,
    request: Request,
) -> Response {
    let query = match parse_strict_query_uri(request.uri(), &["country", "locale"]) {
        Ok(query) => query,
        Err(error) => return fail(&request, &error),
    };
    let region = match regional_params(
        query.get("country").map(String::as_str),
        query.get("locale").map(String::as_str),
    ) {
        Ok(value) => value,
        Err(error) => return fail(&request, &error),
    };
    let hidden = ["epic", "SeaQA", "d5241c76f178492ea1540fce45616757"];
    if hidden.contains(&namespace.as_str()) {
        return fail(
            &request,
            &ProblemError::new(
                404,
                "BASE_GAME_NOT_FOUND",
                "No public base game exists for this namespace.",
            ),
        );
    }
    let value = cache_or_compute(
        &state,
        "catalog.base-game",
        BTreeMap::from([
            ("namespace", json!(namespace)), ("region", json!(region.region)), ("locale",json!(region.locale)),
        ]),
        300,
        || async {
            let mut offer=state.mongo.find_one("offers",doc!{"namespace":{"$eq":&namespace}, "offerType":"BASE_GAME", "prePurchase":{"$ne":true}},None).await.map_err(|_|internal_error())?;
            if offer.is_none() {
                offer=state.mongo.find_one("offers",doc!{"namespace":{"$eq":&namespace},"offerType":"BASE_GAME","prePurchase":true},None).await.map_err(|_|internal_error())?;
            }
            let Some(offer)=offer else {return Ok(Value::Null);};
            let id=offer.get("id").cloned().unwrap_or(Bson::Null);
            let price=state.mongo.find_one_with_options(
                "pricev2",doc!{"offerId":id,"region":&region.region},
                MongoFindOptions{sort:Some(doc!{"updatedAt":-1}),..Default::default()},
            ).await.map_err(|_|internal_error())?;
            let localized=localize_ordered_rows(&state,&[offer],&region.locale).await?;
            serialize_localized_offer(&localized[0], price)
        },
    ).await;
    match value {
        Ok(value) if !js_truthy(&value) => fail(
            &request,
            &ProblemError::new(
                404,
                "BASE_GAME_NOT_FOUND",
                "No base game was found for this namespace.",
            ),
        ),
        Ok(offer) => success(
            &request,
            offer.clone(),
            json!({"country":region.country,"region":region.region,"locale":offer.get("locale").filter(|v|!v.is_null()).cloned().unwrap_or(json!(region.locale))}),
        ),
        Err(error) => fail(&request, &error),
    }
}

fn linked_item_ids(value: Option<&Bson>) -> Result<Vec<Bson>, ProblemError> {
    match value {
        None | Some(Bson::Null) => Ok(Vec::new()),
        Some(Bson::Array(items)) => items
            .iter()
            .map(|item| {
                if matches!(item, Bson::Null) {
                    return Err(internal_error());
                }
                Ok(item
                    .as_document()
                    .and_then(|item| item.get("id"))
                    .cloned()
                    .unwrap_or(Bson::Null))
            })
            .collect(),
        _ => Err(internal_error()),
    }
}

async fn items_from_offer(
    State(state): State<AppState>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    let value = cache_or_compute(
        &state,
        "catalog.items-from-offer",
        BTreeMap::from([("id", json!(id))]),
        300,
        || async {
            let Some(offer) = state
                .mongo
                .find_one("offers", doc! {"id":&id}, None)
                .await
                .map_err(|_| internal_error())?
            else {
                return Ok(json!([]));
            };
            let mut ids = linked_item_ids(offer.get("items"))?;
            let sub = state
                .mongo
                .find_one("offersubitems", doc! {"_id":&id}, None)
                .await
                .map_err(|_| internal_error())?;
            ids.extend(linked_item_ids(
                sub.as_ref().and_then(|doc| doc.get("subItems")),
            )?);
            let rows = state
                .mongo
                .find_many(
                    "items",
                    doc! {"$or":[{"id":{"$in":ids}},{"linkedOffers":&id}]},
                    MongoFindOptions::default(),
                )
                .await
                .map_err(|_| internal_error())?;
            let mut seen = std::collections::HashSet::new();
            let result: Vec<_> = rows
                .iter()
                .filter(|item| primitive_id(item.get("id")).is_none_or(|id| seen.insert(id)))
                .map(super::item_serialization::stored_item)
                .collect();
            Ok(json!(result))
        },
    )
    .await;
    match value {
        Ok(items) => success_count(&request, items, json!({})),
        Err(error) => fail(&request, &error),
    }
}

fn sort(field: &str, direction: SortDirection) -> MongoSortField {
    MongoSortField::new(field, direction, NullsOrder::Last)
}

fn tuple_bson(value: &CursorSortValue, date: bool, object_id: bool) -> Bson {
    if date {
        return super::system::cursor_date_bson(value);
    }
    if object_id && let Some(id) = value.as_str().and_then(|id| ObjectId::parse_str(id).ok()) {
        return Bson::ObjectId(id);
    }
    super::system::cursor_scalar_bson(value)
}

fn page_cursor(
    state: &AppState,
    binding: &CursorBinding,
    has_more: bool,
    date: Option<&Value>,
    id: CursorSortValue,
    total: Value,
) -> Result<Value, ProblemError> {
    let token = has_more
        .then(|| {
            encode_cursor_with(
                binding,
                &[
                    CursorSortValue::from(super::system::sitemap_date(date)?),
                    id,
                ],
                state.config.v1_cursor_secret.as_deref(),
                (state.now)().timestamp_millis(),
            )
        })
        .transpose()?;
    Ok(
        serde_json::to_value(page_meta(binding.limit, has_more, token).with_total(total))
            .unwrap_or(Value::Null),
    )
}

fn parse_cursor(
    state: &AppState,
    cursor: Option<&str>,
    binding: &CursorBinding,
) -> Result<Option<Vec<CursorSortValue>>, ProblemError> {
    cursor
        .map(|token| {
            decode_cursor_with(
                token,
                binding,
                state.config.v1_cursor_secret.as_deref(),
                (state.now)().timestamp_millis(),
            )
        })
        .transpose()
}

async fn sales(State(state): State<AppState>, request: Request) -> Response {
    let query =
        match parse_strict_query_uri(request.uri(), &["limit", "cursor", "country", "locale"]) {
            Ok(v) => v,
            Err(e) => return fail(&request, &e),
        };
    let region = match regional_params(
        query.get("country").map(String::as_str),
        query.get("locale").map(String::as_str),
    ) {
        Ok(v) => v,
        Err(e) => return fail(&request, &e),
    };
    let pagination = match parse_pagination_map(&query, 30) {
        Ok(v) => v,
        Err(e) => return fail(&request, &e),
    };
    let bind = binding(
        "catalog.sales",
        BTreeMap::new(),
        "appliedRules.endDate:asc,offerId:asc",
        &region.country,
        &region.locale,
        pagination.limit,
    );
    let cache_parts = BTreeMap::from([
        (
            "cursor",
            pagination.cursor.clone().map_or(Value::Null, |v| json!(v)),
        ),
        ("limit", json!(pagination.limit)),
        ("locale", json!(region.locale)),
        ("region", json!(region.region)),
    ]);
    let cache_key = v1_cache_key("catalog.sales", &cache_parts);
    if let Some(value) = v1_cache_get(state.cache.as_ref(), &cache_key).await {
        return sales_response(
            &request,
            &region.country,
            &region.region,
            &region.locale,
            &value,
        );
    }
    let cursor = match parse_cursor(&state, pagination.cursor.as_deref(), &bind) {
        Ok(v) => v,
        Err(e) => return fail(&request, &e),
    };
    let fields = [
        sort("appliedRules.endDate", SortDirection::Asc),
        sort("offerId", SortDirection::Asc),
    ];
    let mut filter = doc! {"region":&region.region,"price.discount":{"$gt":0},"appliedRules.endDate":{"$ne":Bson::Null}};
    let base = filter.clone();
    if let Some(tuple) = cursor {
        let vals: Vec<_> = tuple
            .iter()
            .enumerate()
            .map(|(i, v)| tuple_bson(v, i == 0, false))
            .collect();
        match mongo_keyset_filter(&fields, &vals) {
            Ok(f) => filter.extend(f),
            Err(e) => return fail(&request, &e),
        };
    }
    let (prices, total) = match counted_page(
        &state,
        "catalog.sales",
        &[("region", json!(region.region))],
        60,
        "pricev2",
        Some(base),
        PageRead::Find(
            filter,
            MongoFindOptions {
                limit: Some(i64::from(bind.limit + 1)),
                sort: Some(mongo_sort_spec(&fields)),
                ..Default::default()
            },
        ),
    )
    .await
    {
        Ok(result) => result,
        Err(e) => return fail(&request, &e),
    };
    let page = trim_page(prices, bind.limit as usize);
    let ids: Vec<_> = page
        .items
        .iter()
        .map(|row| row.get("offerId").cloned().unwrap_or(Bson::Null))
        .collect();
    let offers = match state
        .mongo
        .find_many(
            "offers",
            doc! {"id":{"$in":ids}},
            MongoFindOptions::default(),
        )
        .await
    {
        Ok(offers) => offers,
        Err(_) => return fail(&request, &internal_error()),
    };
    let by_id: HashMap<_, _> = offers
        .iter()
        .filter_map(|row| primitive_id(row.get("id")).map(|key| (key, row)))
        .collect();
    let rows: Vec<_> = page
        .items
        .iter()
        .filter_map(|price| {
            primitive_id(price.get("offerId"))
                .and_then(|id| by_id.get(&id))
                .map(|row| (*row).clone())
        })
        .collect();
    let (elements, locale_meta) =
        match serialize_priced_offers(&state, &rows, &page.items, &region.locale).await {
            Ok(v) => v,
            Err(e) => return fail(&request, &e),
        };
    let last = page
        .items
        .last()
        .map(egdata_infra::bson_json::bson_doc_to_js_json)
        .unwrap_or(Value::Null);
    let meta = match page_cursor(
        &state,
        &bind,
        page.has_more,
        last.pointer("/appliedRules/endDate"),
        identifier_text(last.get("offerId")).into(),
        total,
    ) {
        Ok(v) => v,
        Err(e) => return fail(&request, &e),
    };
    let cached = json!({"offers":elements,"pagination":meta,"localeMeta":locale_meta});
    v1_cache_set(state.cache.as_ref(), &cache_key, &cached, 60).await;
    sales_response(
        &request,
        &region.country,
        &region.region,
        &region.locale,
        &cached,
    )
}

fn sales_response(
    request: &Request,
    country: &str,
    region: &str,
    locale: &str,
    page: &Value,
) -> Response {
    let mut meta = serde_json::Map::from_iter([
        ("country".into(), json!(country)),
        ("region".into(), json!(region)),
        ("locale".into(), json!(locale)),
    ]);
    meta.append(
        egdata_http_core::shared::json::spread(&page["localeMeta"])
            .as_object_mut()
            .expect("object spread yields a record"),
    );
    page_field(
        request,
        page,
        "offers",
        Value::Object(meta),
        &["pagination"],
    )
}

async fn active_sales(State(state): State<AppState>, request: Request) -> Response {
    let query =
        match parse_strict_query_uri(request.uri(), &["limit", "cursor", "country", "locale"]) {
            Ok(v) => v,
            Err(e) => return fail(&request, &e),
        };
    let region = match regional_params(
        query.get("country").map(String::as_str),
        query.get("locale").map(String::as_str),
    ) {
        Ok(v) => v,
        Err(e) => return fail(&request, &e),
    };
    let pagination = match parse_pagination_map(&query, 50) {
        Ok(v) => v,
        Err(e) => return fail(&request, &e),
    };
    let bind = binding(
        "catalog.active-sales",
        BTreeMap::from([("group".into(), serde_json::json!("active-sales"))]),
        "updated:desc,id:asc",
        &region.country,
        &region.locale,
        pagination.limit,
    );
    let cache_parts = BTreeMap::from([
        (
            "cursor",
            pagination.cursor.clone().map_or(Value::Null, |v| json!(v)),
        ),
        ("limit", json!(pagination.limit)),
        ("locale", json!(region.locale)),
        ("region", json!(region.region)),
    ]);
    let cache_key = v1_cache_key("catalog.active-sales", &cache_parts);
    if let Some(value) = v1_cache_get(state.cache.as_ref(), &cache_key).await {
        return page_field(
            &request,
            &value,
            "elements",
            json!({"country":region.country,"region":region.region,"locale":region.locale}),
            &["pagination"],
        );
    }
    let cursor = match parse_cursor(&state, pagination.cursor.as_deref(), &bind) {
        Ok(v) => v,
        Err(e) => return fail(&request, &e),
    };
    let fields = [
        sort("updated", SortDirection::Desc),
        sort("id", SortDirection::Asc),
    ];
    let mut filter = doc! {"name":{"$regex":"(Sale|Savings|Promotion|Deals)","$options":"i"},"referenceCount":{"$gt":0},"id":{"$nin":[33639]}};
    let base = filter.clone();
    if let Some(tuple) = cursor {
        let vals: Vec<_> = tuple
            .iter()
            .enumerate()
            .map(|(i, v)| tuple_bson(v, i == 0, false))
            .collect();
        match mongo_keyset_filter(&fields, &vals) {
            Ok(f) => filter.extend(f),
            Err(e) => return fail(&request, &e),
        }
    }
    let (tags, total) = match counted_page(
        &state,
        "catalog.active-sales",
        &[],
        60,
        "tags",
        Some(base),
        PageRead::Find(
            filter,
            MongoFindOptions {
                limit: Some(i64::from(bind.limit + 1)),
                sort: Some(mongo_sort_spec(&fields)),
                ..Default::default()
            },
        ),
    )
    .await
    {
        Ok(result) => result,
        Err(e) => return fail(&request, &e),
    };
    let page = trim_page(tags, bind.limit as usize);
    let elements = futures::future::join_all(
        page.items
            .iter()
            .map(|tag| active_tag(&state, tag, &region.region, &region.locale)),
    )
    .await;
    let elements = match elements.into_iter().collect::<Result<Vec<_>, _>>() {
        Ok(rows) => rows,
        Err(error) => return fail(&request, &error),
    };
    let last = page
        .items
        .last()
        .map(egdata_infra::bson_json::bson_doc_to_js_json)
        .unwrap_or(Value::Null);
    let last_id = match last.get("id") {
        Some(Value::Number(n)) => CursorSortValue::Number(n.clone()),
        id => identifier_text(id).into(),
    };
    let meta = match page_cursor(
        &state,
        &bind,
        page.has_more,
        last.get("updated"),
        last_id,
        total,
    ) {
        Ok(v) => v,
        Err(e) => return fail(&request, &e),
    };
    let cached = json!({"elements":elements,"pagination":meta});
    v1_cache_set(state.cache.as_ref(), &cache_key, &cached, 60).await;
    success(
        &request,
        cached["elements"].clone(),
        json!({"country":region.country,"region":region.region,"locale":region.locale,"pagination":cached["pagination"]}),
    )
}

async fn active_tag(
    state: &AppState,
    tag: &Document,
    region: &str,
    locale: &str,
) -> Result<Value, ProblemError> {
    let id = tag.get("id").cloned().unwrap_or(Bson::Null);
    let offers = state
        .mongo
        .find_many(
            "offers",
            doc! {"tags":{"$elemMatch":{"id":id}}},
            MongoFindOptions {
                limit: Some(200),
                sort: Some(doc! {"lastModifiedDate":-1}),
                ..Default::default()
            },
        )
        .await
        .map_err(|_| internal_error())?;
    let prices = regional_offer_prices(state, &offers, region).await?;
    let tag = egdata_infra::bson_json::bson_doc_to_js_json(tag);
    let id = identifier_text(tag.get("id"));
    let active = id == "29899"
        || (!prices.is_empty()
            && prices.iter().all(|price| {
                let price = egdata_infra::bson_json::bson_doc_to_js_json(price);
                js_number_or_zero(price.pointer("/price/discount")) > 0.
                    || price
                        .pointer("/price/originalPrice")
                        .and_then(Value::as_f64)
                        == Some(0.)
            }));
    let top = &offers[..offers.len().min(3)];
    let (elements, _) = serialize_priced_offers(state, top, &prices, locale).await?;
    Ok(json!({"id":id,"name":tag["name"],"active":active,"offers":elements}))
}

async fn changelog(State(state): State<AppState>, request: Request) -> Response {
    let query = match parse_strict_query_uri(request.uri(), &["limit", "cursor"]) {
        Ok(v) => v,
        Err(e) => return fail(&request, &e),
    };
    let pagination = match parse_pagination_map(&query, 50) {
        Ok(v) => v,
        Err(e) => return fail(&request, &e),
    };
    let bind = binding(
        "catalog.changelog",
        BTreeMap::new(),
        "timestamp:desc,_id:asc",
        "US",
        "en-US",
        pagination.limit,
    );
    let cache_parts = BTreeMap::from([
        (
            "cursor",
            pagination.cursor.clone().map_or(Value::Null, |v| json!(v)),
        ),
        ("limit", json!(pagination.limit)),
    ]);
    let cache_key = v1_cache_key("catalog.changelog", &cache_parts);
    if let Some(value) = v1_cache_get(state.cache.as_ref(), &cache_key).await {
        return page_field(&request, &value, "elements", json!({}), &["pagination"]);
    }
    let cursor = match parse_cursor(&state, pagination.cursor.as_deref(), &bind) {
        Ok(v) => v,
        Err(e) => return fail(&request, &e),
    };
    let fields = [
        sort("timestamp", SortDirection::Desc),
        sort("_id", SortDirection::Asc),
    ];
    let mut filter = doc! {"metadata.contextType":{"$nin":["file","achievements"]}};
    let base = filter.clone();
    if let Some(tuple) = cursor {
        let vals: Vec<_> = tuple
            .iter()
            .enumerate()
            .map(|(i, v)| tuple_bson(v, i == 0, i == 1))
            .collect();
        match mongo_keyset_filter(&fields, &vals) {
            Ok(f) => filter.extend(f),
            Err(e) => return fail(&request, &e),
        }
    }
    let (rows, total) = match counted_page(
        &state,
        "catalog.changelog",
        &[],
        60,
        "changelogs_v2",
        Some(base),
        PageRead::Find(
            filter,
            MongoFindOptions {
                limit: Some(i64::from(bind.limit + 1)),
                sort: Some(mongo_sort_spec(&fields)),
                ..Default::default()
            },
        ),
    )
    .await
    {
        Ok(result) => result,
        Err(e) => return fail(&request, &e),
    };
    let page = trim_page(rows, bind.limit as usize);
    let elements = futures::future::join_all(
        page.items
            .iter()
            .map(|row| change_with_context(&state, row)),
    )
    .await;
    let last = page
        .items
        .last()
        .map(egdata_infra::bson_json::bson_doc_to_js_json)
        .unwrap_or(Value::Null);
    let meta = match page_cursor(
        &state,
        &bind,
        page.has_more,
        last.get("timestamp"),
        identifier_text(last.get("_id")).into(),
        total,
    ) {
        Ok(v) => v,
        Err(e) => return fail(&request, &e),
    };
    let cached = json!({"elements":elements,"pagination":meta});
    v1_cache_set(state.cache.as_ref(), &cache_key, &cached, 60).await;
    success(
        &request,
        cached["elements"].clone(),
        json!({"pagination":cached["pagination"]}),
    )
}

async fn changelist_detail(
    State(state): State<AppState>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    match state
        .mongo
        .find_one("changelogs_v2", changelog_id_filter(&id), None)
        .await
    {
        Ok(Some(row)) => {
            // The detail resolver reads context from serializeValue(change.toObject()).
            let plain = serialized_change(&row);
            let context_doc = bson::to_document(&plain).expect("serialized changelog is an object");
            let context =
                egdata_http_core::shared::changelog::resolve_changelog_context_safely(&state, &context_doc).await;
            let change = enriched_change(plain, context);
            success(&request, change, json!({}))
        }
        Ok(None) => fail(
            &request,
            &ProblemError::new(
                404,
                "CHANGELOG_NOT_FOUND",
                "No catalog change exists with this ID.",
            ),
        ),
        Err(_) => fail(&request, &internal_error()),
    }
}

async fn change_with_context(state: &AppState, row: &Document) -> Value {
    let context = egdata_http_core::shared::changelog::resolve_changelog_context_safely(state, row).await;
    enriched_change(serialized_change(row), context)
}

fn serialized_change(row: &Document) -> Value {
    let mut plain = serialize_value(&egdata_infra::bson_json::bson_doc_to_js_json(row));
    // Decimal128 ids arrive as `$numberDecimal` objects but Node's
    // serializeValue returns the Decimal128's numeric string.
    if let Some(id) = row
        .get("_id")
        .and_then(egdata_core::v1::serialization::stored_identifier)
    {
        plain["_id"] = json!(id);
    }
    plain
}

fn enriched_change(mut row: Value, context: Value) -> Value {
    let mut metadata = egdata_http_core::shared::json::spread(&row["metadata"]);
    metadata["context"] = serialize_value(&context);
    row["metadata"] = metadata;
    row
}

fn changelog_id_filter(id: &str) -> bson::Document {
    if let Ok(oid) = ObjectId::parse_str(id) {
        doc! {"$or":[{"_id":oid},{"_id":{"$eq":id}}]}
    } else {
        doc! {"_id":{"$eq":id}}
    }
}

fn identifier_text(value: Option<&Value>) -> String {
    value.map(js_string).unwrap_or_else(|| "undefined".into())
}

#[cfg(test)]
mod oracle_tests {
    use egdata_api_oracle::RecordedReads;
    use super::*;
    use crate::{test_support::test_app_state, state::ApiConfig};
    use std::sync::Arc;
    use tower::ServiceExt;

    #[test]
    fn decimal_changelog_ids_serialize_as_numeric_strings() {
        let row = doc! {
            "_id": "51.25".parse::<bson::Decimal128>().unwrap(),
            "timestamp": bson::DateTime::from_millis(0),
            "metadata": {"contextType":"item","contextId":"item-a"},
        };
        let change = serialized_change(&row);
        assert_eq!(change["_id"], "51.25");
        assert_eq!(change["timestamp"], "1970-01-01T00:00:00.000Z");
        assert_eq!(change["metadata"]["contextId"], "item-a");
    }

    fn fixture_now() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339("2026-11-17T18:00:00.000Z")
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    #[tokio::test]
    async fn catalog_discovery_http_matches_node_oracle() {
        let fixtures: Vec<Value> = serde_json::from_str(include_str!(
            "../../egdata-api/tests/fixtures/catalog-discovery-http-node.json"
        ))
        .unwrap();
        for case in fixtures {
            let store = Arc::new(RecordedReads::from_case(&case));
            let mut config = ApiConfig::default();
            if case["cursorUnconfigured"] == true {
                config.v1_cursor_secret = None;
            }
            let mut state = test_app_state(config);
            state.mongo = store.clone();
            state.cache = store.clone();
            state.now = fixture_now;
            state.epic = store.clone();
            let app = crate::router(&state).with_state(state);
            let req = &case["request"];
            let request = axum::http::Request::builder()
                .method(req["method"].as_str().unwrap())
                .uri(req["path"].as_str().unwrap())
                .header("x-egdata-key-id", "key_oracle")
                .header("x-egdata-key-tier", "free")
                .header("x-request-id", "req_node_oracle")
                .body(axum::body::Body::empty())
                .unwrap();
            let response = app.oneshot(request).await.unwrap();
            let actual = egdata_api_test_support::capture_response(response).await;
            let case_name = &case["name"];
            assert_eq!(actual, case["response"], "fixture {case_name}");
            store.assert_finished();
        }
    }
}
