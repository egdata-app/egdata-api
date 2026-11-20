//! OpenSearch-backed search endpoints migrated from the Node search routers.
pub use egdata_http_core::shared::search::*;

use axum::{
    Extension, Json,
    body::Body,
    extract::State,
    http::{HeaderValue, Uri},
    response::Response,
};
use egdata_core::v1::serialization::{
    serialize_indexed_price, serialize_json_offer, serialize_json_value,
};
use egdata_core::{
    error::CoreError,
    ports::MongoFindOptions,
    v1::{
        CursorBinding, CursorSortValue, MongoSortField, NullsOrder, ProblemError, SortDirection,
        country_and_region, mongo_keyset_filter, parse_boolean, parse_integer,
        parse_pagination_map, regional_params, require_json_content_type, trim_js_whitespace,
    },
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

use super::{
    RouteGroup,
    helpers::{V1ErrorResponse, parse_validated_query, v1_cache_get, v1_cache_key, v1_cache_set},
    system::internal_error,
};
use crate::{
    state::AppState,
    helpers::{V1RequestContext, json_success, parse_strict_query_uri},
};

const SEARCH_V2_KEYS: &[&str] = &[
    "title",
    "facets",
    "fields",
    "technologies",
    "offerType",
    "tags",
    "categories",
    "customAttributes",
    "seller",
    "developerDisplayName",
    "publisherDisplayName",
    "refundType",
    "isCodeRedemptionOnly",
    "excludeBlockchain",
    "pastGiveaways",
    "onSale",
    "isLowestPrice",
    "isLowestPriceEver",
    "priceMin",
    "priceMax",
    "sortBy",
    "sortDir",
    "country",
    "locale",
    "limit",
    "cursor",
];
const MULTI_SEARCH_KEYS: &[&str] = &[
    "query",
    "offerType",
    "tags",
    "categories",
    "customAttributes",
    "seller",
    "developerDisplayName",
    "publisherDisplayName",
    "refundType",
    "isCodeRedemptionOnly",
    "excludeBlockchain",
    "pastGiveaways",
    "onSale",
    "isLowestPrice",
    "isLowestPriceEver",
    "priceMin",
    "priceMax",
    "sortBy",
    "sortDir",
    "country",
    "locale",
    "limit",
    "cursor",
];

const SEARCH_FACETS_KEYS: &[&str] = &[
    "title",
    "facets",
    "technologies",
    "offerType",
    "tags",
    "categories",
    "customAttributes",
    "seller",
    "developerDisplayName",
    "publisherDisplayName",
    "refundType",
    "isCodeRedemptionOnly",
    "excludeBlockchain",
    "pastGiveaways",
    "onSale",
    "isLowestPrice",
    "isLowestPriceEver",
    "priceMin",
    "priceMax",
    "sortBy",
    "sortDir",
    "country",
    "locale",
];

pub fn route_group(prefix: &str) -> RouteGroup {
    RouteGroup::new(prefix)
        .get("/search/tags", search_tags)
        .get("/search/offer-types", search_offer_types)
        .get("/search/developers", search_developers)
        .get("/search/publishers", search_publishers)
        .get("/search/facets", search_offer_facets)
        .get("/search", search_offers)
        .post("/search", search_redirect_post)
        .get("/search/{id}", get_cached_search)
        .get("/search/{id}/count", count_cached_search)
        .post("/search/natural-language", natural_language_search)
        .get("/search/changelog", search_changelog)
        .get("/multisearch/offers", multisearch_offers)
        .get("/multisearch/items", multisearch_items)
        .get("/multisearch/sellers", multisearch_sellers)
}

fn request_id(
    ctx: Option<&Extension<V1RequestContext>>,
    headers: &axum::http::HeaderMap,
) -> String {
    if let Some(Extension(context)) = ctx {
        return context.request_id.clone();
    }
    headers
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned()
}

fn fail(error: ProblemError, uri: &Uri, id: String) -> V1ErrorResponse {
    V1ErrorResponse {
        error,
        path: uri.path().to_owned(),
        request_id: (!id.is_empty()).then_some(id),
    }
}

pub fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|n| n != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn cached_meta(mut meta: Value, cache: &Value, fields: &[&str]) -> Value {
    for field in fields {
        if let Some(value) = cache.get(*field) {
            meta[*field] = value.clone();
        }
    }
    meta
}

fn cached_page(uri: &Uri, id: &str, cache: &Value, data_key: &str, meta: Value) -> Response {
    let mut envelope = json!({});
    if let Some(data) = cache.get(data_key) {
        envelope["data"] = data.clone();
    }
    envelope["meta"] = meta;
    super::helpers::json_envelope_response(&axum::http::Method::GET, uri.path(), id, envelope)
}

fn search_pagination(
    body: &Value,
    limit: u32,
    has_more: bool,
    next: Option<String>,
) -> egdata_core::v1::PageMeta {
    let raw = &body["hits"]["total"];
    let total = raw
        .as_number()
        .or_else(|| raw["value"].as_number())
        .cloned();
    egdata_core::v1::page_meta(limit, has_more, next).with_total(json!(total))
}

fn search_result_meta(body: &Value) -> Value {
    json!({"tookMs":body.get("took").filter(|v| !v.is_null()).cloned().unwrap_or(json!(0)), "timedOut":js_truthy(&body["timed_out"])})
}

fn query_bson(value: &Value) -> bson::Bson {
    match value {
        Value::Number(n) if n.is_f64() || n.as_i64().is_none() => n
            .as_f64()
            .map(bson::Bson::Double)
            .unwrap_or(bson::Bson::Null),
        value => bson::to_bson(value).unwrap_or(bson::Bson::Null),
    }
}

fn facet_limit(raw: Option<&String>) -> i64 {
    let Some(raw) = raw else {
        return 100;
    };
    let raw = trim_js_whitespace(raw);
    let (sign, digits) = match raw.strip_prefix('-') {
        Some(value) => (-1.0, value),
        None => (1.0, raw.strip_prefix('+').unwrap_or(raw)),
    };
    let digits = digits
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>();
    if digits.is_empty() {
        return 100;
    }
    let value = digits.parse::<f64>().unwrap_or(f64::INFINITY) * sign;
    if value == 0.0 {
        return 100;
    }
    value.clamp(1.0, 500.0) as i64
}

fn cursor_secret(state: &AppState) -> Option<String> {
    egdata_core::v1::cursor::resolve_cursor_secret(
        state.config.v1_cursor_secret.as_deref(),
        Some(&state.config.node_env),
        None,
    )
}

fn offer_search_params(uri: &Uri, multi: bool) -> Result<BTreeMap<String, String>, ProblemError> {
    let allowed = if multi {
        MULTI_SEARCH_KEYS
    } else {
        SEARCH_V2_KEYS
    };
    parse_validated_query(uri, allowed, |params| {
        let mut issues = Vec::new();
        let mut issue = |field: &str, code: &str, message: String| {
            issues.push(egdata_core::v1::ProblemIssue {
                parameter: Some(field.into()),
                pointer: Some(format!("/{field}")),
                code: code.into(),
                message,
            });
        };
        for (field, max) in [
            (if multi { "query" } else { "title" }, 500),
            ("offerType", 80),
            ("seller", 200),
            ("developerDisplayName", 300),
            ("publisherDisplayName", 300),
            ("refundType", 80),
            ("sortBy", 80),
        ] {
            if (multi || field != "sortBy")
                && params
                    .get(field)
                    .is_some_and(|v| v.encode_utf16().count() > max)
            {
                issue(
                    field,
                    "TOO_BIG",
                    format!("Too big: expected string to have <={max} characters"),
                );
            }
        }
        for (field, choices) in [
            ("sortDir", &["asc", "desc"][..]),
            ("facets", &["full", "minimal", "none"][..]),
        ] {
            if (!multi || field != "facets")
                && params
                    .get(field)
                    .is_some_and(|v| !choices.contains(&v.as_str()))
            {
                let options = choices
                    .iter()
                    .map(|v| format!("\"{v}\""))
                    .collect::<Vec<_>>()
                    .join("|");
                issue(
                    field,
                    "INVALID_VALUE",
                    format!("Invalid option: expected one of {options}"),
                );
            }
        }
        if !multi
            && params
                .get("fields")
                .is_some_and(|v| !matches!(v.as_str(), "full" | "card"))
        {
            issue(
                "fields",
                "INVALID_VALUE",
                "Invalid option: expected one of \"full\"|\"card\"".into(),
            );
        }
        issues
    })
}



const FACET_SECTION_CHOICES: &[&str] = &[
    "offerType",
    "tags",
    "technologies",
    "developer",
    "publisher",
    "seller",
    "price",
    "all",
];

fn offer_facet_params(uri: &Uri) -> Result<BTreeMap<String, String>, ProblemError> {
    parse_validated_query(uri, SEARCH_FACETS_KEYS, |params| {
        let mut issues = Vec::new();
        let mut issue = |field: &str, code: &str, message: String| {
            issues.push(egdata_core::v1::ProblemIssue {
                parameter: Some(field.into()),
                pointer: Some(format!("/{field}")),
                code: code.into(),
                message,
            });
        };
        for (field, max) in [
            ("title", 500),
            ("offerType", 80),
            ("seller", 200),
            ("developerDisplayName", 300),
            ("publisherDisplayName", 300),
            ("refundType", 80),
        ] {
            if params
                .get(field)
                .is_some_and(|v| v.encode_utf16().count() > max)
            {
                issue(
                    field,
                    "TOO_BIG",
                    format!("Too big: expected string to have <={max} characters"),
                );
            }
        }
        if params
            .get("sortDir")
            .is_some_and(|v| !matches!(v.as_str(), "asc" | "desc"))
        {
            issue(
                "sortDir",
                "INVALID_VALUE",
                "Invalid option: expected one of \"asc\"|\"desc\"".into(),
            );
        }
        issues
    })
}

fn parse_facet_sections(raw: Option<&str>) -> Result<Vec<String>, ProblemError> {
    const ALL_SECTIONS: &[&str] = &[
        "offerType",
        "tags",
        "technologies",
        "developer",
        "publisher",
        "seller",
        "price",
    ];
    let Some(entries) = egdata_core::v1::parse_csv(raw) else {
        return Ok(ALL_SECTIONS.iter().map(|s| (*s).to_owned()).collect());
    };
    if entries.iter().any(|e| !FACET_SECTION_CHOICES.contains(&e.as_str())) {
        let options = FACET_SECTION_CHOICES
            .iter()
            .map(|v| format!("`{v}`"))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(ProblemError::new(
            400,
            "INVALID_QUERY",
            format!("Unsupported `facets` section. Expected one or more of {options}."),
        ));
    }
    if entries.iter().any(|e| e == "all") {
        return Ok(ALL_SECTIONS.iter().map(|s| (*s).to_owned()).collect());
    }
    Ok(entries)
}

fn build_facet_section_aggregations(sections: &[String], region: &str) -> Value {
    let mut aggs = serde_json::Map::new();
    for section in sections {
        match section.as_str() {
            "offerType" => {
                aggs.insert(
                    "offerType".into(),
                    json!({"terms":{"field":"offerType.keyword","size":100}}),
                );
            }
            "technologies" => {
                aggs.insert(
                    "technologies".into(),
                    json!({"terms":{"field":"lastBuilds.technologies.technology.keyword","size":10000}}),
                );
            }
            "price" => {
                aggs.insert(
                    "priceStats".into(),
                    json!({"stats":{"field":format!("prices.{region}.price.discountPrice")}}),
                );
            }
            "tags" => {
                aggs.insert(
                    "tags".into(),
                    json!({"terms":{"field":"tags.name.keyword","size":10000}}),
                );
            }
            "developer" => {
                aggs.insert(
                    "developer".into(),
                    json!({"terms":{"field":"developerDisplayName.keyword","size":1000}}),
                );
            }
            "publisher" => {
                aggs.insert(
                    "publisher".into(),
                    json!({"terms":{"field":"publisherDisplayName.keyword","size":1000}}),
                );
            }
            _ => {
                aggs.insert(
                    "seller".into(),
                    json!({"terms":{"field":"seller.name.keyword","size":1000}}),
                );
            }
        }
    }
    Value::Object(aggs)
}

/// Fields the egdata.app search cards render, as audited against `OfferCard`,
/// `OfferListItem`, `effective-price`, `getImage` and extension ownership.
/// `fields=card` is opt-in; the default `full` payload keeps every documented
/// offer field for other clients.
const OFFER_CARD_FIELDS: &[&str] = &[
    "id",
    "namespace",
    "title",
    "offerType",
    "keyImages",
    "seller",
    "tags",
    "developerDisplayName",
    "publisherDisplayName",
    "prePurchase",
    "releaseDate",
    "price",
    "locale",
    "localeStatus",
    "canonicalLocale",
];

fn offer_card(offer: Value) -> Value {
    let Value::Object(source) = offer else {
        return offer;
    };
    let mut card = serde_json::Map::new();
    for field in OFFER_CARD_FIELDS {
        if let Some(value) = source.get(*field) {
            card.insert((*field).to_owned(), value.clone());
        }
    }
    Value::Object(card)
}

fn apply_cursor(
    state: &AppState,
    binding: &CursorBinding,
    raw: Option<&str>,
    now: i64,
) -> Result<Option<Vec<Value>>, ProblemError> {
    raw.map(|raw| {
        egdata_core::v1::cursor::decode_search_cursor(
            raw,
            binding,
            cursor_secret(state).as_deref(),
            now,
        )
    })
    .transpose()
}

const OFFER_FILTER_ORDER: &[&str] = &[
    "title",
    "offerType",
    "tags",
    "categories",
    "customAttributes",
    "technologies",
    "seller",
    "developerDisplayName",
    "publisherDisplayName",
    "refundType",
    "isCodeRedemptionOnly",
    "excludeBlockchain",
    "onSale",
    "pastGiveaways",
    "isLowestPrice",
    "isLowestPriceEver",
    "price",
];
const MULTI_OFFER_FILTER_ORDER: &[&str] = &[
    "query",
    "offerType",
    "tags",
    "categories",
    "customAttributes",
    "seller",
    "developerDisplayName",
    "publisherDisplayName",
    "refundType",
    "isCodeRedemptionOnly",
    "excludeBlockchain",
    "pastGiveaways",
    "onSale",
    "isLowestPrice",
    "isLowestPriceEver",
    "priceMin",
    "priceMax",
    "sortBy",
    "sortDir",
];

fn serialized_hit_record(source: &Value) -> Value {
    match serialize_json_value(source) {
        record @ Value::Object(_) => record,
        other => egdata_http_core::shared::json::spread(&other),
    }
}

fn search_page<'a>(
    state: &AppState,
    binding: &CursorBinding,
    response: &'a Value,
    limit: u32,
    now: i64,
    filter_order: &[&str],
) -> Result<(&'a [Value], bool, Option<String>), ProblemError> {
    let hit_group = response
        .get("hits")
        .filter(|v| !v.is_null())
        .ok_or_else(internal_error)?;
    let raw = match hit_group.get("hits") {
        None | Some(Value::Null) => &[][..],
        Some(Value::Array(rows)) => rows.as_slice(),
        _ => return Err(internal_error()),
    };
    let more = raw.len() > limit as usize;
    let rows = &raw[..raw.len().min(limit as usize)];
    if rows.iter().any(Value::is_null) {
        return Err(internal_error());
    }
    let token = if more {
        let Some(sort) = rows
            .last()
            .and_then(|hit| hit.get("sort"))
            .and_then(Value::as_array)
        else {
            return Ok((rows, more, None));
        };
        Some(egdata_core::v1::cursor::encode_search_cursor(
            binding,
            sort,
            cursor_secret(state).as_deref(),
            now,
            filter_order,
        )?)
    } else {
        None
    };
    Ok((rows, more, token))
}

async fn search_tags(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    uri: Uri,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let id = request_id(ctx.as_ref(), &headers);
    parse_strict_query_uri(&uri, &[]).map_err(|e| fail(e, &uri, id.clone()))?;
    let docs = state
        .mongo
        .find_many(
            "tags",
            bson::doc! {"status":"ACTIVE"},
            MongoFindOptions::default(),
        )
        .await
        .map_err(|_| fail(internal_error(), &uri, id.clone()))?;
    let count = docs.len();
    Ok(json_success(
        &axum::http::Method::GET,
        uri.path(),
        &id,
        json!(
            docs.into_iter()
                .map(|d| egdata_core::v1::bson_to_serialized_json(&bson::Bson::Document(d)))
                .collect::<Vec<_>>()
        ),
        Some(json!({"count": count})),
    ))
}

fn facet_row(document: &bson::Document, field: &str) -> Value {
    let mut row = json!({});
    for (key, source) in [(field, "_id"), ("count", "count")] {
        if let Some(value) = document.get(source) {
            row[key] = egdata_core::v1::bson_to_serialized_json(value);
        }
    }
    row
}

async fn search_offer_types(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    uri: Uri,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let id = request_id(ctx.as_ref(), &headers);
    let rows = state
        .mongo
        .aggregate(
            "offers",
            vec![bson::doc! {"$group":{"_id":"$offerType","count":{"$sum":1}}}],
        )
        .await
        .map_err(|_| fail(internal_error(), &uri, id.clone()))?;
    let mut values: Vec<_> = rows
        .iter()
        .filter(|row| {
            row.get("_id")
                .is_some_and(|v| !matches!(v, bson::Bson::Null))
        })
        .map(|row| facet_row(row, "offerType"))
        .collect();
    values.sort_by(|a, b| {
        b.get("count")
            .and_then(Value::as_i64)
            .cmp(&a.get("count").and_then(Value::as_i64))
    });
    let count = values.len();
    Ok(json_success(
        &axum::http::Method::GET,
        uri.path(),
        &id,
        json!(values),
        Some(json!({"count":count})),
    ))
}

fn search_query(
    uri: &Uri,
    allowed: &[&str],
    maximum_lengths: &[(&str, usize)],
) -> Result<BTreeMap<String, String>, ProblemError> {
    parse_validated_query(uri, allowed, |params| {
        maximum_lengths
            .iter()
            .filter_map(|&(key, max)| {
                let value = params.get(key)?;
                (value.encode_utf16().count() > max).then(|| egdata_core::v1::ProblemIssue {
                    parameter: Some(key.into()),
                    pointer: Some(format!("/{key}")),
                    code: "TOO_BIG".into(),
                    message: format!("Too big: expected string to have <={max} characters"),
                })
            })
            .collect()
    })
}

async fn aggregate_names(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    uri: Uri,
    ctx: Option<Extension<V1RequestContext>>,
    field: &'static str,
) -> Result<Response, V1ErrorResponse> {
    let id = request_id(ctx.as_ref(), &headers);
    let query = search_query(&uri, &["query", "limit"], &[("query", 200)])
        .map_err(|e| fail(e, &uri, id.clone()))?;
    let mut pipeline = Vec::new();
    if let Some(q) = query.get("query").filter(|q| !q.is_empty()) {
        let mut regex = String::new();
        for c in q.chars() {
            if r".*+?^${}()|[]\".contains(c) {
                regex.push('\\');
            }
            regex.push(c);
        }
        let mut m = bson::Document::new();
        m.insert(field, bson::doc! {"$regex": regex, "$options":"i"});
        pipeline.push(bson::doc! {"$match":m});
    }
    pipeline.extend([
        bson::doc! {"$group":{"_id":format!("${field}"),"count":{"$sum":1}}},
        bson::doc! {"$match":{"_id":{"$ne":bson::Bson::Null}}},
        bson::doc! {"$sort":{"count":-1,"_id":1}},
        bson::doc! {"$limit": facet_limit(query.get("limit"))},
    ]);
    let limit = facet_limit(query.get("limit"));
    let rows = state
        .mongo
        .aggregate("offers", pipeline)
        .await
        .map_err(|_| fail(internal_error(), &uri, id.clone()))?;
    let data: Vec<_> = rows.iter().map(|row| facet_row(row, "name")).collect();
    let count = data.len();
    Ok(json_success(
        &axum::http::Method::GET,
        uri.path(),
        &id,
        json!(data),
        Some(json!({"limit":limit,"count":count})),
    ))
}
async fn search_developers(
    State(s): State<AppState>,
    h: axum::http::HeaderMap,
    u: Uri,
    c: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    aggregate_names(State(s), h, u, c, "developerDisplayName").await
}
async fn search_publishers(
    State(s): State<AppState>,
    h: axum::http::HeaderMap,
    u: Uri,
    c: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    aggregate_names(State(s), h, u, c, "publisherDisplayName").await
}

async fn search_offers(
    headers: axum::http::HeaderMap,
    uri: Uri,
    ctx: Option<Extension<V1RequestContext>>,
    State(state): State<AppState>,
) -> Result<Response, V1ErrorResponse> {
    search_v2_offers(State(state), headers, uri, ctx).await
}

// The Node `/search` contract is a separate V2 search from legacy multisearch.
// Keep this builder local so legacy multisearch query semantics remain intact.
async fn search_v2_offers(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    uri: Uri,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let id = request_id(ctx.as_ref(), &headers);
    let q = offer_search_params(&uri, false).map_err(|e| fail(e, &uri, id.clone()))?;
    let country = q.get("country").map(String::as_str).unwrap_or("US");
    let rp = regional_params(Some(country), q.get("locale").map(String::as_str))
        .map_err(|e| fail(e, &uri, id.clone()))?;
    let pagination = parse_pagination_map(&q, 100).map_err(|e| fail(e, &uri, id.clone()))?;
    let limit = pagination.limit;
    let min = parse_integer(
        q.get("priceMin").map(String::as_str),
        "priceMin",
        Some(0),
        None,
    )
    .map_err(|e| fail(e, &uri, id.clone()))?;
    let max = parse_integer(
        q.get("priceMax").map(String::as_str),
        "priceMax",
        Some(0),
        None,
    )
    .map_err(|e| fail(e, &uri, id.clone()))?;
    if min.zip(max).is_some_and(|(a, b)| a > b) {
        return Err(fail(
            ProblemError::new(
                400,
                "INVALID_QUERY",
                "`priceMin` cannot be greater than `priceMax`.",
            ),
            &uri,
            id,
        ));
    }
    let sort_by = q
        .get("sortBy")
        .map(String::as_str)
        .filter(|v| !v.is_empty());
    let dir = if sort_by.is_some() {
        q.get("sortDir").map(String::as_str).unwrap_or("desc")
    } else {
        "desc"
    };
    const SORTS: &[&str] = &[
        "releaseDate",
        "lastModifiedDate",
        "effectiveDate",
        "creationDate",
        "viewableDate",
        "pcReleaseDate",
        "upcoming",
        "priceAsc",
        "priceDesc",
        "price",
        "discount",
        "discountPercent",
        "priceUpdatedAt",
        "giveawayDate",
    ];
    if let Some(sort) = sort_by.filter(|v| !SORTS.contains(v)) {
        return Err(fail(
            ProblemError::new(
                400,
                "INVALID_QUERY",
                format!("Unsupported `sortBy` value '{sort}'."),
            ),
            &uri,
            id,
        ));
    }
    let title = q
        .get("title")
        .map(|s| trim_js_whitespace(s))
        .filter(|s| !s.is_empty());
    let mut normalized = serde_json::Map::new();
    for key in ["title", "offerType"] {
        normalized.insert(
            key.to_string(),
            q.get(key)
                .map(|v| trim_js_whitespace(v).to_owned())
                .filter(|v| !v.is_empty())
                .map_or(Value::Null, |v| json!(v)),
        );
    }
    for key in ["tags", "categories", "customAttributes", "technologies"] {
        let values = egdata_core::v1::parse_csv(q.get(key).map(String::as_str)).unwrap_or_default();
        normalized.insert(key.to_string(), json!(values));
    }
    for key in [
        "seller",
        "developerDisplayName",
        "publisherDisplayName",
        "refundType",
    ] {
        normalized.insert(
            key.to_string(),
            q.get(key)
                .map(|v| trim_js_whitespace(v).to_owned())
                .filter(|v| !v.is_empty())
                .map_or(Value::Null, |v| json!(v)),
        );
    }
    for key in [
        "isCodeRedemptionOnly",
        "excludeBlockchain",
        "onSale",
        "pastGiveaways",
        "isLowestPrice",
        "isLowestPriceEver",
    ] {
        let value = json!(
            parse_boolean(q.get(key).map(String::as_str), key).map_err(|e| fail(
                e,
                &uri,
                id.clone()
            ))?
        );
        normalized.insert(key.to_owned(), value);
    }
    normalized.insert(
        "price".into(),
        if min.is_some() || max.is_some() {
            {
                let mut range = serde_json::Map::new();
                if let Some(value) = min {
                    range.insert("min".into(), json!(value));
                }
                if let Some(value) = max {
                    range.insert("max".into(), json!(value));
                }
                Value::Object(range)
            }
        } else {
            Value::Null
        },
    );
    let ordering = format!(
        "{}:{dir},id:asc",
        sort_by.unwrap_or(if title.is_some() {
            "_score"
        } else {
            "lastModifiedDate"
        })
    );
    let filters: BTreeMap<String, Value> = normalized.clone().into_iter().collect();
    let binding = CursorBinding {
        operation: "search.offers".into(),
        filters: Some(filters),
        ordering,
        country: rp.country.clone(),
        locale: rp.locale.clone(),
        limit,
    };
    let now = (state.now)().timestamp_millis();
    let now_iso = chrono::DateTime::from_timestamp_millis(now)
        .map(|date| date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default();
    let must = text_matches(title);
    let region = &rp.region;
    let mut filter = offer_filters(&Value::Object(normalized.clone()), region, false, false);
    let mut sorts = Vec::new();
    let sort_field = match sort_by.unwrap_or("") {
        "priceAsc" | "priceDesc" | "price" => format!("prices.{region}.price.discountPrice"),
        "discount" => format!("prices.{region}.price.discount"),
        "discountPercent" => {
            format!("prices.{region}.appliedRules.discountSetting.discountPercentage")
        }
        "priceUpdatedAt" => format!("prices.{region}.updatedAt"),
        "giveawayDate" => "freeEntries.endDate".into(),
        "upcoming" | "releaseDate" => "releaseDate".into(),
        "" => {
            if title.is_some() {
                "_score".into()
            } else {
                "lastModifiedDate".into()
            }
        }
        v => v.into(),
    };
    let actual_dir = match sort_by {
        Some("priceAsc") => "asc",
        Some("priceDesc") => "desc",
        Some("upcoming") => {
            if dir == "asc" {
                "desc"
            } else {
                "asc"
            }
        }
        _ => dir,
    };
    if sort_by == Some("upcoming") {
        filter.push(json!({"range":{"releaseDate":{"gte":now_iso}}}));
    }
    if sort_by == Some("releaseDate") {
        filter.push(json!({"range":{"releaseDate":if dir=="desc"{json!({"lte":now_iso})}else{json!({"gte":now_iso})}}}));
    }
    if sort_by == Some("giveawayDate") {
        filter.push(json!({"exists":{"field":"freeEntries"}}));
    }
    // OpenSearch's score sort does not accept field-sort options such as `missing`.
    if sort_field == "_score" {
        sorts.push(json!({"_score":{"order":actual_dir}}));
    } else {
        sorts.push(json!({sort_field.clone():{"order":actual_dir,"missing":"_last"}}));
    }
    if title.is_some() && sort_field != "_score" {
        sorts.push(json!({"_score":{"order":"desc"}}));
    }
    sorts.push(json!({"id.keyword":{"order":"asc","missing":"_last"}}));
    let facets = q.get("facets").map(String::as_str).unwrap_or("none");
    let fields = q.get("fields").map(String::as_str).unwrap_or("full");
    let mut aggs = json!({"offerType":{"terms":{"field":"offerType.keyword","size":100}},"technologies":{"terms":{"field":"lastBuilds.technologies.technology.keyword","size":if facets=="full"{10000}else{1000}}},"priceStats":{"stats":{"field":format!("prices.{region}.price.discountPrice")}}});
    if facets == "full" {
        aggs["tags"] = json!({"terms":{"field":"tags.name.keyword","size":10000}});
        aggs["developer"] = json!({"terms":{"field":"developerDisplayName.keyword","size":1000}});
        aggs["publisher"] = json!({"terms":{"field":"publisherDisplayName.keyword","size":1000}});
        aggs["seller"] = json!({"terms":{"field":"seller.name.keyword","size":1000}});
    }
    let mut request = json!({"size":limit+1,"track_total_hits":true,"query":{"bool":{"must":must,"filter":filter}},"sort":sorts});
    if facets != "none" {
        request["aggregations"] = aggs;
    }
    let cache_parts = BTreeMap::from([
        ("region", json!(rp.region)),
        ("locale", json!(rp.locale)),
        ("limit", json!(limit)),
        (
            "cursor",
            pagination.cursor.clone().map_or(Value::Null, |v| json!(v)),
        ),
        ("filters", json!(normalized)),
        ("ordering", json!(binding.ordering)),
        ("facets", json!(facets)),
        ("fields", json!(fields)),
    ]);
    let cache_key = v1_cache_key("search.offers", &cache_parts);
    if let Some(cached) = v1_cache_get(state.cache.as_ref(), &cache_key).await {
        let meta = cached_meta(
            json!({"country":rp.country,"region":rp.region,"locale":rp.locale}),
            &cached,
            &["facets", "result", "pagination"],
        );
        return Ok(cached_page(&uri, &id, &cached, "offers", meta));
    }
    let after = apply_cursor(&state, &binding, pagination.cursor.as_deref(), now)
        .map_err(|e| fail(e, &uri, id.clone()))?;
    if let Some(after) = after {
        request["search_after"] = json!(after);
    }
    let response = state
        .opensearch
        .search("egdata.offers", &request)
        .await
        .map_err(|_| {
            fail(
                ProblemError::new(
                    503,
                    "SEARCH_UNAVAILABLE",
                    "Offer search is temporarily unavailable. Please retry shortly.",
                )
                .with_headers(BTreeMap::from([("Retry-After".into(), "1".into())])),
                &uri,
                id.clone(),
            )
        })?;
    let (hits, has_more, next) =
        search_page(&state, &binding, &response, limit, now, OFFER_FILTER_ORDER)
            .map_err(|e| fail(e, &uri, id.clone()))?;
    let ordered = hits
        .iter()
        .map(|hit| super::offers::checked_ordered(&hit["_source"]))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| fail(e, &uri, id.clone()))?;
    let localized = super::system::localize_offers(&state, &ordered, &rp.locale)
        .await
        .map_err(|e| fail(e, &uri, id.clone()))?;
    let cards: Vec<Value> = localized
        .iter()
        .zip(hits)
        .map(|(offer, hit)| {
            let price = &hit["_source"]["prices"][region];
            let mut card = serialize_json_offer(offer, None, true);
            card["price"] = serialize_indexed_price(price).ok_or_else(internal_error)?;
            if fields == "card" {
                card = offer_card(card);
            }
            Ok(card)
        })
        .collect::<Result<_, _>>()
        .map_err(|e| fail(e, &uri, id.clone()))?;
    let meta = json!({
        "country": rp.country,
        "region": rp.region,
        "locale": rp.locale,
        "facets": response.get("aggregations").filter(|v| !v.is_null()).map(serialize_json_value).unwrap_or(json!({})),
        "result": search_result_meta(&response),
        "pagination": search_pagination(&response,limit,has_more,next)
    });
    let offers = json!(cards);
    v1_cache_set(
        state.cache.as_ref(),
        &cache_key,
        &json!({
            "offers": offers,
            "pagination": meta["pagination"],
            "facets": meta["facets"],
            "result": meta["result"]
        }),
        60,
    )
    .await;
    Ok(json_success(
        &axum::http::Method::GET,
        uri.path(),
        &id,
        offers,
        Some(meta),
    ))
}

async fn search_offer_facets(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    uri: Uri,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let id = request_id(ctx.as_ref(), &headers);
    let q = offer_facet_params(&uri).map_err(|e| fail(e, &uri, id.clone()))?;
    let country = q.get("country").map(String::as_str).unwrap_or("US");
    let rp = regional_params(Some(country), q.get("locale").map(String::as_str))
        .map_err(|e| fail(e, &uri, id.clone()))?;
    let min = parse_integer(
        q.get("priceMin").map(String::as_str),
        "priceMin",
        Some(0),
        None,
    )
    .map_err(|e| fail(e, &uri, id.clone()))?;
    let max = parse_integer(
        q.get("priceMax").map(String::as_str),
        "priceMax",
        Some(0),
        None,
    )
    .map_err(|e| fail(e, &uri, id.clone()))?;
    if min.zip(max).is_some_and(|(a, b)| a > b) {
        return Err(fail(
            ProblemError::new(
                400,
                "INVALID_QUERY",
                "`priceMin` cannot be greater than `priceMax`.",
            ),
            &uri,
            id,
        ));
    }
    let sort_by = q
        .get("sortBy")
        .map(String::as_str)
        .filter(|v| !v.is_empty());
    let dir = if sort_by.is_some() {
        q.get("sortDir").map(String::as_str).unwrap_or("desc")
    } else {
        "desc"
    };
    const SORTS: &[&str] = &[
        "releaseDate",
        "lastModifiedDate",
        "effectiveDate",
        "creationDate",
        "viewableDate",
        "pcReleaseDate",
        "upcoming",
        "priceAsc",
        "priceDesc",
        "price",
        "discount",
        "discountPercent",
        "priceUpdatedAt",
        "giveawayDate",
    ];
    if let Some(sort) = sort_by.filter(|v| !SORTS.contains(v)) {
        return Err(fail(
            ProblemError::new(
                400,
                "INVALID_QUERY",
                format!("Unsupported `sortBy` value '{sort}'."),
            ),
            &uri,
            id,
        ));
    }
    let sections = parse_facet_sections(q.get("facets").map(String::as_str))
        .map_err(|e| fail(e, &uri, id.clone()))?;
    let title = q
        .get("title")
        .map(|s| trim_js_whitespace(s))
        .filter(|s| !s.is_empty());
    let mut normalized = serde_json::Map::new();
    for key in ["title", "offerType"] {
        normalized.insert(
            key.to_string(),
            q.get(key)
                .map(|v| trim_js_whitespace(v).to_owned())
                .filter(|v| !v.is_empty())
                .map_or(Value::Null, |v| json!(v)),
        );
    }
    for key in ["tags", "categories", "customAttributes", "technologies"] {
        let values = egdata_core::v1::parse_csv(q.get(key).map(String::as_str)).unwrap_or_default();
        normalized.insert(key.to_string(), json!(values));
    }
    for key in [
        "seller",
        "developerDisplayName",
        "publisherDisplayName",
        "refundType",
    ] {
        normalized.insert(
            key.to_string(),
            q.get(key)
                .map(|v| trim_js_whitespace(v).to_owned())
                .filter(|v| !v.is_empty())
                .map_or(Value::Null, |v| json!(v)),
        );
    }
    for key in [
        "isCodeRedemptionOnly",
        "excludeBlockchain",
        "onSale",
        "pastGiveaways",
        "isLowestPrice",
        "isLowestPriceEver",
    ] {
        let value = json!(
            parse_boolean(q.get(key).map(String::as_str), key).map_err(|e| fail(
                e,
                &uri,
                id.clone()
            ))?
        );
        normalized.insert(key.to_owned(), value);
    }
    normalized.insert(
        "price".into(),
        if min.is_some() || max.is_some() {
            let mut range = serde_json::Map::new();
            if let Some(value) = min {
                range.insert("min".into(), json!(value));
            }
            if let Some(value) = max {
                range.insert("max".into(), json!(value));
            }
            Value::Object(range)
        } else {
            Value::Null
        },
    );
    let ordering = format!(
        "{}:{dir},id:asc",
        sort_by.unwrap_or(if title.is_some() {
            "_score"
        } else {
            "lastModifiedDate"
        })
    );
    let now = (state.now)().timestamp_millis();
    let now_iso = chrono::DateTime::from_timestamp_millis(now)
        .map(|date| date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default();
    let must = text_matches(title);
    let region = &rp.region;
    let mut filter = offer_filters(&Value::Object(normalized.clone()), region, false, false);
    if sort_by == Some("upcoming") {
        filter.push(json!({"range":{"releaseDate":{"gte":now_iso}}}));
    }
    if sort_by == Some("releaseDate") {
        filter.push(json!({"range":{"releaseDate":if dir=="desc"{json!({"lte":now_iso})}else{json!({"gte":now_iso})}}}));
    }
    if sort_by == Some("giveawayDate") {
        filter.push(json!({"exists":{"field":"freeEntries"}}));
    }
    let aggs = build_facet_section_aggregations(&sections, region);
    let request = json!({
        "size": 0,
        "track_total_hits": false,
        "query": {"bool": {"must": must, "filter": filter}},
        "aggregations": aggs
    });
    let cache_parts = BTreeMap::from([
        ("region", json!(rp.region)),
        ("locale", json!(rp.locale)),
        ("filters", json!(normalized)),
        ("ordering", json!(ordering)),
        ("sections", json!(sections)),
    ]);
    let cache_key = v1_cache_key("search.facets", &cache_parts);
    if let Some(cached) = v1_cache_get(state.cache.as_ref(), &cache_key).await {
        let meta = cached_meta(
            json!({"country": rp.country, "region": rp.region, "locale": rp.locale, "sections": sections}),
            &cached,
            &["result"],
        );
        return Ok(cached_page(&uri, &id, &cached, "facets", meta));
    }
    let response = state
        .opensearch
        .search("egdata.offers", &request)
        .await
        .map_err(|_| {
            fail(
                ProblemError::new(
                    503,
                    "SEARCH_UNAVAILABLE",
                    "Offer search is temporarily unavailable. Please retry shortly.",
                )
                .with_headers(BTreeMap::from([("Retry-After".into(), "1".into())])),
                &uri,
                id.clone(),
            )
        })?;
    let facets = response
        .get("aggregations")
        .filter(|v| !v.is_null())
        .map(serialize_json_value)
        .unwrap_or(json!({}));
    let result_meta = search_result_meta(&response);
    let meta = json!({
        "country": rp.country,
        "region": rp.region,
        "locale": rp.locale,
        "sections": sections,
        "result": result_meta
    });
    v1_cache_set(
        state.cache.as_ref(),
        &cache_key,
        &json!({
            "facets": facets,
            "result": meta["result"]
        }),
        60,
    )
    .await;
    Ok(json_success(
        &axum::http::Method::GET,
        uri.path(),
        &id,
        facets,
        Some(meta),
    ))
}

fn json_search_body(
    headers: &axum::http::HeaderMap,
    body: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Result<Value, ProblemError> {
    require_json_content_type(
        headers
            .get(axum::http::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
    )?;
    body.map(|Json(value)| value).map_err(|_| {
        ProblemError::new(400, "MALFORMED_JSON", "The request body is not valid JSON.")
    })
}

async fn search_redirect_post(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    uri: Uri,
    ctx: Option<Extension<V1RequestContext>>,
    body: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Result<Response, V1ErrorResponse> {
    let id = request_id(ctx.as_ref(), &headers);
    let body = json_search_body(&headers, body).map_err(|e| fail(e, &uri, id.clone()))?;
    const ALLOWED: &[&str] = &[
        "title",
        "offerType",
        "tags",
        "categories",
        "customAttributes",
        "technologies",
        "seller",
        "developerDisplayName",
        "publisherDisplayName",
        "refundType",
        "isCodeRedemptionOnly",
        "excludeBlockchain",
        "onSale",
        "pastGiveaways",
        "isLowestPrice",
        "isLowestPriceEver",
        "sortBy",
        "sortDir",
        "facets",
        "fields",
        "price",
        "limit",
        "country",
        "locale",
    ];
    let invalid = ProblemError::new(
        400,
        "INVALID_BODY",
        "Provide a valid search filter object. Unknown fields and unsupported sorts are rejected.",
    );
    let Some(input) = body.as_object() else {
        return Err(fail(invalid, &uri, id));
    };
    if input.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
        return Err(fail(invalid, &uri, id));
    }
    const STRING_LIMITS: &[(&str, usize)] = &[
        ("title", 500),
        ("offerType", 80),
        ("seller", 200),
        ("developerDisplayName", 300),
        ("publisherDisplayName", 300),
        ("refundType", 80),
        ("sortBy", 80),
        ("country", usize::MAX),
        ("locale", usize::MAX),
    ];
    for (key, max) in STRING_LIMITS {
        if let Some(value) = input.get(*key) {
            let Some(value) = value.as_str() else {
                return Err(fail(invalid.clone(), &uri, id.clone()));
            };
            if value.encode_utf16().count() > *max {
                return Err(fail(invalid.clone(), &uri, id.clone()));
            }
        }
    }
    let mut lists = BTreeMap::<&str, Vec<String>>::new();
    for key in ["tags", "categories", "customAttributes", "technologies"] {
        if let Some(value) = input.get(key) {
            let Some(values) = value.as_array().filter(|values| values.len() <= 100) else {
                return Err(fail(invalid.clone(), &uri, id.clone()));
            };
            let mut normalized = Vec::with_capacity(values.len());
            for value in values {
                let Some(value) = value.as_str() else {
                    return Err(fail(invalid.clone(), &uri, id.clone()));
                };
                let value = trim_js_whitespace(value);
                if value.is_empty() {
                    return Err(fail(invalid.clone(), &uri, id.clone()));
                }
                normalized.push(value.to_owned());
            }
            normalized.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            normalized.dedup();
            lists.insert(key, normalized);
        }
    }
    for key in [
        "isCodeRedemptionOnly",
        "excludeBlockchain",
        "onSale",
        "pastGiveaways",
        "isLowestPrice",
        "isLowestPriceEver",
    ] {
        if input.get(key).is_some_and(|value| !value.is_boolean()) {
            return Err(fail(invalid.clone(), &uri, id.clone()));
        }
    }
    if input
        .get("sortDir")
        .is_some_and(|value| !matches!(value.as_str(), Some("asc" | "desc")))
        || input
            .get("facets")
            .is_some_and(|value| !matches!(value.as_str(), Some("full" | "minimal" | "none")))
        || input
            .get("fields")
            .is_some_and(|value| !matches!(value.as_str(), Some("full" | "card")))
    {
        return Err(fail(invalid.clone(), &uri, id.clone()));
    }
    if let Some(limit) = input.get("limit")
        && !limit
            .as_f64()
            .is_some_and(|n| n.is_finite() && n.fract() == 0.0 && (1.0..=100.0).contains(&n))
    {
        return Err(fail(invalid.clone(), &uri, id.clone()));
    }
    let mut price_values = BTreeMap::<&str, f64>::new();
    if let Some(price) = input.get("price") {
        let Some(price) = price
            .as_object()
            .filter(|obj| obj.keys().all(|key| key == "min" || key == "max"))
        else {
            return Err(fail(invalid.clone(), &uri, id.clone()));
        };
        for key in ["min", "max"] {
            if let Some(value) = price.get(key) {
                if let Some(number) = value.as_f64().filter(|n| {
                    n.is_finite() && n.fract() == 0.0 && *n >= 0.0 && *n <= 9_007_199_254_740_991.0
                }) {
                    price_values.insert(key, number);
                } else {
                    return Err(fail(invalid.clone(), &uri, id.clone()));
                }
            }
        }
    }
    const SORTS: &[&str] = &[
        "releaseDate",
        "lastModifiedDate",
        "effectiveDate",
        "creationDate",
        "viewableDate",
        "pcReleaseDate",
        "upcoming",
        "priceAsc",
        "priceDesc",
        "price",
        "discount",
        "discountPercent",
        "priceUpdatedAt",
        "giveawayDate",
    ];
    if let Some(sort) = input
        .get("sortBy")
        .and_then(Value::as_str)
        .filter(|sort| !sort.is_empty())
        && !SORTS.contains(&sort)
    {
        return Err(fail(
            ProblemError::new(
                400,
                "INVALID_BODY",
                format!("Unsupported `sortBy` value '{sort}'."),
            ),
            &uri,
            id,
        ));
    }
    if price_values
        .get("min")
        .zip(price_values.get("max"))
        .is_some_and(|(min, max)| min > max)
    {
        return Err(fail(
            ProblemError::new(
                400,
                "INVALID_BODY",
                "`price.min` cannot exceed `price.max`.",
            ),
            &uri,
            id,
        ));
    }
    let regional = regional_params(
        input.get("country").and_then(Value::as_str),
        input.get("locale").and_then(Value::as_str),
    )
    .map_err(|e| fail(e, &uri, id.clone()))?;
    let mut params = BTreeMap::<String, Vec<String>>::new();
    for key in [
        "title",
        "offerType",
        "seller",
        "developerDisplayName",
        "publisherDisplayName",
        "refundType",
    ] {
        if let Some(value) = input.get(key).and_then(Value::as_str) {
            let value = trim_js_whitespace(value);
            if !value.is_empty() {
                params.insert(key.into(), vec![value.into()]);
            }
        }
    }
    for (key, values) in lists {
        if values.is_empty() {
            continue;
        }
        if values.iter().any(|value| value.contains(',')) {
            params.insert(format!("{key}[]"), values);
        } else {
            params.insert(key.into(), vec![values.join(",")]);
        }
    }
    for (key, value) in [
        ("isCodeRedemptionOnly", input.get("isCodeRedemptionOnly")),
        ("excludeBlockchain", input.get("excludeBlockchain")),
        ("onSale", input.get("onSale")),
        ("pastGiveaways", input.get("pastGiveaways")),
        ("isLowestPrice", input.get("isLowestPrice")),
        ("isLowestPriceEver", input.get("isLowestPriceEver")),
    ] {
        if let Some(value) = value.and_then(Value::as_bool) {
            params.insert(key.into(), vec![value.to_string()]);
        }
    }
    if let Some(sort) = input
        .get("sortBy")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        params.insert("sortBy".into(), vec![sort.into()]);
    }
    if let Some(sort) = input.get("sortDir").and_then(Value::as_str) {
        params.insert("sortDir".into(), vec![sort.into()]);
    }
    if let Some(facets) = input.get("facets").and_then(Value::as_str) {
        params.insert("facets".into(), vec![facets.into()]);
    }
    if let Some(fields) = input.get("fields").and_then(Value::as_str) {
        params.insert("fields".into(), vec![fields.into()]);
    }
    if let Some(limit) = input.get("limit").and_then(Value::as_f64) {
        params.insert(
            "limit".into(),
            vec![egdata_core::v1::query::format_js_number(limit)],
        );
    }
    for (key, query_key) in [("min", "priceMin"), ("max", "priceMax")] {
        if let Some(value) = price_values.get(key) {
            params.insert(
                query_key.into(),
                vec![egdata_core::v1::query::format_js_number(*value)],
            );
        }
    }
    params.insert("country".into(), vec![regional.country]);
    params.insert("locale".into(), vec![regional.locale]);
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, values) in params {
        for value in values {
            serializer.append_pair(&key, &value);
        }
    }
    let base = state.config.v1_public_base_url.trim().trim_end_matches('/');
    let location = format!("{base}/search?{}", serializer.finish());
    let mut response = Response::new(Body::empty());
    *response.status_mut() = axum::http::StatusCode::SEE_OTHER;
    response.headers_mut().insert(
        axum::http::header::LOCATION,
        HeaderValue::from_str(&location).map_err(|_| fail(internal_error(), &uri, id.clone()))?,
    );
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
    Ok(response)
}

async fn get_cached_search(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    uri: Uri,
    ctx: Option<Extension<V1RequestContext>>,
    axum::extract::Path(id_path): axum::extract::Path<String>,
) -> Result<Response, V1ErrorResponse> {
    let id = request_id(ctx.as_ref(), &headers);
    parse_strict_query_uri(&uri, &[]).map_err(|e| fail(e, &uri, id.clone()))?;
    let cached = state
        .saved_queries
        .get(&id_path)
        .await
        .map_err(|_| fail(internal_error(), &uri, id.clone()))?;
    let Some(raw) = cached else {
        return Err(fail(
            ProblemError::new(
                404,
                "SEARCH_QUERY_NOT_FOUND",
                "No cached search query exists with this ID.",
            ),
            &uri,
            id,
        ));
    };
    let value: Value = serde_json::from_str(&raw).map_err(|_| {
        fail(
            ProblemError::new(
                404,
                "SEARCH_QUERY_NOT_FOUND",
                "No cached search query exists with this ID.",
            ),
            &uri,
            id.clone(),
        )
    })?;
    Ok(json_success(
        &axum::http::Method::GET,
        uri.path(),
        &id,
        serialize_json_value(&value),
        None,
    ))
}

async fn count_cached_search(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    uri: Uri,
    ctx: Option<Extension<V1RequestContext>>,
    axum::extract::Path(id_path): axum::extract::Path<String>,
) -> Result<Response, V1ErrorResponse> {
    let id = request_id(ctx.as_ref(), &headers);
    let q = parse_strict_query_uri(&uri, &["country"]).map_err(|e| fail(e, &uri, id.clone()))?;
    let country_region = country_and_region(q.get("country").map(String::as_str))
        .map_err(|error| fail(error, &uri, id.clone()))?;
    let Some(raw) = state
        .saved_queries
        .get(&id_path)
        .await
        .map_err(|_| fail(internal_error(), &uri, id.clone()))?
    else {
        return Err(fail(
            ProblemError::new(
                404,
                "SEARCH_QUERY_NOT_FOUND",
                "No cached search query exists with this ID.",
            ),
            &uri,
            id,
        ));
    };
    let filters: Value = serde_json::from_str(&raw).map_err(|_| {
        fail(
            ProblemError::new(
                404,
                "SEARCH_QUERY_NOT_FOUND",
                "No cached search query exists with this ID.",
            ),
            &uri,
            id.clone(),
        )
    })?;
    let region = country_region.region;
    let mut key_parts = BTreeMap::new();
    key_parts.insert("id", json!(id_path));
    key_parts.insert("region", json!(region));
    let result_cache_key = v1_cache_key("search.query-count", &key_parts);
    if let Some(value) = v1_cache_get(state.cache.as_ref(), &result_cache_key).await {
        return Ok(json_success(
            &axum::http::Method::GET,
            uri.path(),
            &id,
            value,
            Some(json!({"country":country_region.country,"region":region})),
        ));
    }
    if filters.is_null() {
        return Err(fail(internal_error(), &uri, id));
    }
    let mut offer_filter = bson::doc! {"namespace":{"$ne":"ue"}};
    if let Some(title) = filters["title"].as_str().filter(|t| !t.is_empty()) {
        let mut pattern = String::new();
        for c in title.chars() {
            match c {
                '\n' => pattern.push_str("\\n"),
                '\r' => pattern.push_str("\\r"),
                '\u{2028}' => pattern.push_str("\\u2028"),
                '\u{2029}' => pattern.push_str("\\u2029"),
                c => {
                    if r#".*+?^${}()|[]\/"#.contains(c) {
                        pattern.push('\\');
                    }
                    pattern.push(c);
                }
            }
        }
        offer_filter.insert(
            "title",
            bson::doc! {"$regex":bson::Regex{pattern,options:"i".into()}},
        );
    }
    for key in [
        "offerType",
        "developerDisplayName",
        "publisherDisplayName",
        "refundType",
    ] {
        if let Some(v) = filters[key].as_str().filter(|v| !v.is_empty()) {
            offer_filter.insert(key, v);
        }
    }
    for (key, field) in [("tags", "tags.id"), ("categories", "categories")] {
        if let Some(v) = filters[key].as_array().filter(|v| !v.is_empty()) {
            offer_filter.insert(field, bson::doc! {"$all":bson::to_bson(v).unwrap()});
        }
    }
    if let Some(seller) = filters["seller"].as_str().filter(|v| !v.is_empty()) {
        offer_filter.insert(
            "$or",
            vec![
                bson::doc! {"seller.name":seller},
                bson::doc! {"seller.id":seller},
            ],
        );
    }
    if let Some(value) = filters.get("isCodeRedemptionOnly") {
        offer_filter.insert("isCodeRedemptionOnly", query_bson(value));
    }
    let mut price_filter = bson::Document::new();
    if let Some(price) = filters.get("price") {
        let mut range = bson::Document::new();
        if let Some(v) = price.get("min").map(query_bson) {
            range.insert("$gte", v);
        }
        if let Some(v) = price.get("max").map(query_bson) {
            range.insert("$lte", v);
        }
        if !range.is_empty() {
            price_filter.insert("price.discountPrice", range);
        }
    }
    if filters.get("onSale").and_then(Value::as_bool) == Some(true) {
        price_filter.insert("price.discount", bson::doc! {"$gt":0});
    }
    let mut price_lookup = bson::doc! {"region":&region};
    for (key, value) in price_filter {
        price_lookup.insert(key, value);
    }
    let mut pipeline = vec![
        bson::doc! {"$match":offer_filter},
        bson::doc! {"$lookup":{"from":"pricev2","localField":"id","foreignField":"offerId","as":"priceEngine","pipeline":[{"$match":price_lookup},{"$sort":{"updatedAt":-1}},{"$limit":1}]}},
        bson::doc! {"$addFields":{"price":{"$arrayElemAt":["$priceEngine",0]}}},
        bson::doc! {"$match":{"price":{"$ne":bson::Bson::Null}}},
    ];
    if filters.get("pastGiveaways").and_then(Value::as_bool) == Some(true) {
        pipeline.push(bson::doc!{"$lookup":{"from":"freegames","localField":"id","foreignField":"id","as":"freegame"}});
        pipeline.push(bson::doc! {"$match":{"freegame":{"$ne":[]}}});
    }
    pipeline.push(bson::doc!{"$facet":{"total":[{"$count":"total"}],"tagCounts":[{"$unwind":"$tags"},{"$group":{"_id":"$tags.id","count":{"$sum":1}}}],"offerTypeCounts":[{"$group":{"_id":"$offerType","count":{"$sum":1}}}],"developer":[{"$unwind":"$developerDisplayName"},{"$group":{"_id":"$developerDisplayName","count":{"$sum":1}}}],"publisher":[{"$unwind":"$publisherDisplayName"},{"$group":{"_id":"$publisherDisplayName","count":{"$sum":1}}},{"$sort":{"count":-1}}],"priceRange":[{"$group":{"_id":bson::Bson::Null,"minPrice":{"$min":"$price.price.discountPrice"},"maxPrice":{"$max":"$price.price.discountPrice"},"currency":{"$first":"$price.price.currencyCode"}}}]}});
    let rows = state
        .mongo
        .aggregate("offers", pipeline)
        .await
        .map_err(|_| fail(internal_error(), &uri, id.clone()))?;
    let row = rows
        .first()
        .map(|d| egdata_core::v1::bson_to_serialized_json(&bson::Bson::Document(d.clone())))
        .unwrap_or(json!({}));
    let price_range = row
        .get("priceRange")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .cloned()
        .unwrap_or(json!({"minPrice":null,"maxPrice":null}));
    let result = json!({"tagCounts":row.get("tagCounts").cloned().unwrap_or(json!([])),"offerTypeCounts":row.get("offerTypeCounts").cloned().unwrap_or(json!([])),"total":row.pointer("/total/0/total").cloned().unwrap_or(json!(0)),"developer":row.get("developer").cloned().unwrap_or(json!([])),"publisher":row.get("publisher").cloned().unwrap_or(json!([])),"priceRange":price_range});
    v1_cache_set(state.cache.as_ref(), &result_cache_key, &result, 300).await;
    Ok(json_success(
        &axum::http::Method::GET,
        uri.path(),
        &id,
        result,
        Some(json!({"country":country_region.country,"region":region})),
    ))
}

async fn natural_language_search(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    uri: Uri,
    ctx: Option<Extension<V1RequestContext>>,
    body: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Result<Response, V1ErrorResponse> {
    let id = request_id(ctx.as_ref(), &headers);
    let query_params =
        parse_strict_query_uri(&uri, &["locale"]).map_err(|e| fail(e, &uri, id.clone()))?;
    let regional = regional_params(None, query_params.get("locale").map(String::as_str))
        .map_err(|e| fail(e, &uri, id.clone()))?;
    let body = json_search_body(&headers, body).map_err(|e| fail(e, &uri, id.clone()))?;
    const INVALID_NATURAL_BODY: &str =
        "Provide a `query` between 1 and 500 characters and an optional `topK` between 1 and 50.";
    if !body.is_object()
        || body
            .as_object()
            .is_some_and(|object| object.keys().any(|key| key != "query" && key != "topK"))
    {
        return Err(fail(
            ProblemError::new(400, "INVALID_BODY", INVALID_NATURAL_BODY),
            &uri,
            id,
        ));
    }
    let query = body
        .get("query")
        .and_then(Value::as_str)
        .map(trim_js_whitespace)
        .filter(|s| !s.is_empty() && s.encode_utf16().count() <= 500)
        .ok_or_else(|| {
            fail(
                ProblemError::new(400, "INVALID_BODY", INVALID_NATURAL_BODY),
                &uri,
                id.clone(),
            )
        })?;
    let top = match body.get("topK") {
        None => 10,
        Some(Value::Number(value)) => value
            .as_f64()
            .filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= 0.0 && *n <= u64::MAX as f64)
            .map(|n| n as u64)
            .ok_or_else(|| {
                fail(
                    ProblemError::new(400, "INVALID_BODY", INVALID_NATURAL_BODY),
                    &uri,
                    id.clone(),
                )
            })?,
        Some(_) => {
            return Err(fail(
                ProblemError::new(400, "INVALID_BODY", INVALID_NATURAL_BODY),
                &uri,
                id,
            ));
        }
    };
    if !(1..=50).contains(&top) {
        return Err(fail(
            ProblemError::new(400, "INVALID_BODY", INVALID_NATURAL_BODY),
            &uri,
            id,
        ));
    }
    let matches = state
        .vectorize
        .query_natural_language(query, top as usize)
        .await
        .map_err(|error| {
            let problem = match error {
                CoreError::InvalidInput(_) => ProblemError::new(
                    503,
                    "NATURAL_LANGUAGE_SEARCH_NOT_CONFIGURED",
                    "Natural-language search is not configured.",
                ),
                CoreError::Upstream(_) => ProblemError::new(
                    502,
                    "NATURAL_LANGUAGE_SEARCH_UNAVAILABLE",
                    "Natural-language search is temporarily unavailable.",
                )
                .with_headers(BTreeMap::from([("Retry-After".into(), "1".into())])),
                _ => internal_error(),
            };
            fail(problem, &uri, id.clone())
        })?;
    let mut ids: Vec<bson::Bson> = Vec::new();
    let mut object_ids = Vec::new();
    for m in &matches {
        if let Ok(oid) = bson::oid::ObjectId::parse_str(&m.id) {
            object_ids.push(bson::Bson::ObjectId(oid));
        }
        if let Some(id) = m
            .metadata
            .as_ref()
            .and_then(|v| v.get("id"))
            .and_then(Value::as_str)
            && !ids.contains(&bson::Bson::String(id.to_owned()))
        {
            ids.push(bson::Bson::String(id.to_owned()));
        }
    }
    let mut filters = Vec::new();
    if !ids.is_empty() {
        filters.push(bson::doc! {"id":{"$in":ids}});
    }
    if !object_ids.is_empty() {
        filters.push(bson::doc! {"_id":{"$in":object_ids}});
    }
    let offers = if filters.is_empty() {
        vec![]
    } else {
        state
            .mongo
            .find_many(
                "offers",
                if filters.len() == 1 {
                    filters.remove(0)
                } else {
                    bson::doc! {"$or":filters}
                },
                MongoFindOptions::default(),
            )
            .await
            .map_err(|_| fail(internal_error(), &uri, id.clone()))?
    };
    let offers: Vec<Value> = offers
        .into_iter()
        .map(|d| egdata_core::v1::bson_to_serialized_json(&bson::Bson::Document(d)))
        .collect();
    let mut by_id = std::collections::HashMap::new();
    for offer in &offers {
        by_id.insert(super::offer_details::string_field(offer, "_id"), offer);
        by_id.insert(super::offer_details::string_field(offer, "id"), offer);
    }
    let ranked: Vec<_> = matches
        .iter()
        .filter_map(|m| {
            let metadata_id = m
                .metadata
                .as_ref()
                .and_then(|v| v.get("id"))
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty());
            metadata_id
                .and_then(|v| by_id.get(v))
                .or_else(|| by_id.get(&m.id))
                .map(|offer| (m.score, *offer))
        })
        .collect();
    let raw = ranked
        .iter()
        .map(|(_, o)| super::offers::checked_ordered(o))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| fail(e, &uri, id.clone()))?;
    let localized = super::system::localize_offers(&state, &raw, &regional.locale)
        .await
        .map_err(|e| fail(e, &uri, id.clone()))?;
    let matches: Vec<Value> = ranked
        .into_iter()
        .zip(localized)
        .map(|((score, _), offer)| json!({"score":score,"offer":serialize_json_offer(&offer, None, true)}))
        .collect();
    Ok(json_success(
        &axum::http::Method::POST,
        uri.path(),
        &id,
        json!(matches),
        Some(json!({"query":query,"count":matches.len(),"locale":regional.locale})),
    ))
}

async fn search_changelog(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    uri: Uri,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let id = request_id(ctx.as_ref(), &headers);
    let q = search_query(
        &uri,
        &["query", "type", "id", "limit", "cursor"],
        &[("query", 500), ("type", 100), ("id", 200)],
    )
    .map_err(|e| fail(e, &uri, id.clone()))?;
    let pagination = parse_pagination_map(&q, 50).map_err(|e| fail(e, &uri, id.clone()))?;
    let limit = pagination.limit;
    let binding = CursorBinding {
        operation: "search.changelog".into(),
        filters: Some(BTreeMap::from([
            ("id".into(), q.get("id").map_or(Value::Null, |v| json!(v))),
            (
                "query".into(),
                q.get("query").map_or(Value::Null, |v| json!(v)),
            ),
            (
                "type".into(),
                q.get("type").map_or(Value::Null, |v| json!(v)),
            ),
        ])),
        ordering: "timestamp:desc,_id:asc".into(),
        country: "US".into(),
        locale: "en-US".into(),
        limit,
    };
    let now = (state.now)().timestamp_millis();
    if q.get("query").is_none_or(|v| v.trim().is_empty()) {
        let cache_key = v1_cache_key(
            "search.changelog",
            &BTreeMap::from([
                ("id", q.get("id").map_or(Value::Null, |v| json!(v))),
                ("type", q.get("type").map_or(Value::Null, |v| json!(v))),
                ("limit", json!(limit)),
                ("cursor", json!(pagination.cursor)),
            ]),
        );
        if let Some(cached) = v1_cache_get(state.cache.as_ref(), &cache_key).await {
            let mut meta = cached_meta(json!({}), &cached, &["pagination"]);
            meta["query"] = json!("");
            return Ok(cached_page(&uri, &id, &cached, "hits", meta));
        }
        let after = apply_cursor(&state, &binding, pagination.cursor.as_deref(), now)
            .map_err(|e| fail(e, &uri, id.clone()))?;
        let mut filter = bson::doc! {"metadata.contextType":{"$nin":["file","achievements"]}};
        if let Some(t) = q.get("type").filter(|v| !v.is_empty()) {
            filter.insert("metadata.contextType", t);
        }
        if let Some(context_id) = q.get("id").filter(|v| !v.is_empty()) {
            filter.insert("metadata.contextId", context_id);
        }
        let base_filter = filter.clone();
        if let Some(last) = after.as_ref() {
            let fields = [
                MongoSortField::new("timestamp", SortDirection::Desc, NullsOrder::Last),
                MongoSortField::new("_id", SortDirection::Asc, NullsOrder::Last),
            ];
            let tuple = last
                .iter()
                .zip(fields.iter())
                .map(|(v, field)| match v {
                    Value::String(s) if field.field == "timestamp" => {
                        // The BSON driver encodes an invalid JavaScript Date at epoch zero.
                        let millis = super::offer_price_history::cursor_date(s)
                            .map_or(0, |date| date.timestamp_millis());
                        bson::Bson::DateTime(bson::DateTime::from_millis(millis))
                    }
                    Value::String(s) => bson::oid::ObjectId::parse_str(s)
                        .map(bson::Bson::ObjectId)
                        .unwrap_or_else(|_| bson::Bson::String(s.clone())),
                    other => query_bson(other),
                })
                .collect::<Vec<_>>();
            let keyset =
                mongo_keyset_filter(&fields, &tuple).map_err(|e| fail(e, &uri, id.clone()))?;
            if !keyset.is_empty() {
                filter.extend(keyset);
            }
        }
        let count_parts = [("id", json!(q.get("id"))), ("type", json!(q.get("type")))];
        let (rows, total) = tokio::join!(biased;
            state.mongo.find_many("changelogs_v2", filter, MongoFindOptions {sort:Some(bson::doc!{"timestamp":-1,"_id":1}), limit:Some(i64::from(limit)+1),..Default::default()}),
            super::counts::documents(&state,"search.changelog",&count_parts,60,"changelogs_v2",base_filter)
        );
        let rows = rows.map_err(|_| fail(internal_error(), &uri, id.clone()))?;
        let total = total.map_err(|e| fail(e, &uri, id.clone()))?;
        let more = rows.len() > limit as usize;
        let items = rows.into_iter().take(limit as usize).collect::<Vec<_>>();
        let next = if let Some(row) = items.last().filter(|_| more) {
            let timestamp = row
                .get("timestamp")
                .map(egdata_infra::bson_json::bson_to_js_json);
            let timestamp = match timestamp.as_ref().filter(|value| js_truthy(value)) {
                None => CursorSortValue::Null,
                Some(value) => {
                    let date = match value {
                        Value::Number(n) => n
                            .as_f64()
                            .and_then(|n| chrono::DateTime::from_timestamp_millis(n as i64)),
                        Value::String(s) => chrono::DateTime::parse_from_rfc3339(s)
                            .or_else(|_| chrono::DateTime::parse_from_rfc2822(s))
                            .map(|date| date.to_utc())
                            .ok()
                            .or_else(|| {
                                chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
                                    .ok()?
                                    .and_hms_opt(0, 0, 0)
                                    .map(|date| date.and_utc())
                            }),
                        Value::Bool(true) => chrono::DateTime::from_timestamp_millis(1),
                        _ => None,
                    }
                    .ok_or_else(|| fail(internal_error(), &uri, id.clone()))?;
                    CursorSortValue::from(egdata_core::v1::serialization::js_iso_datetime(date))
                }
            };
            let object_id = row
                .get("_id")
                .map(egdata_infra::bson_json::bson_to_js_json)
                .map(|v| egdata_core::v1::serialization::js_string(&v))
                .unwrap_or_else(|| "undefined".into());
            Some(
                egdata_core::v1::cursor::encode_cursor_with_filter_order(
                    &binding,
                    &[timestamp, CursorSortValue::from(object_id)],
                    cursor_secret(&state).as_deref(),
                    now,
                    &["query", "type", "id"],
                )
                .map_err(|e| fail(e, &uri, id.clone()))?,
            )
        } else {
            None
        };
        let data = items
            .into_iter()
            .map(|row| egdata_core::v1::bson_to_serialized_json(&bson::Bson::Document(row)))
            .collect::<Vec<_>>();
        let pagination = egdata_core::v1::page_meta(limit, more, next).with_total(total);
        v1_cache_set(
            state.cache.as_ref(),
            &cache_key,
            &json!({"hits":data,"pagination":pagination}),
            60,
        )
        .await;
        return Ok(json_success(
            &axum::http::Method::GET,
            uri.path(),
            &id,
            json!(data),
            Some(json!({"query":"","pagination":pagination})),
        ));
    }
    let after = apply_cursor(&state, &binding, pagination.cursor.as_deref(), now)
        .map_err(|e| fail(e, &uri, id.clone()))?;
    let mut must = Vec::new();
    let mut filter = Vec::new();
    if let Some(text) = q.get("query") {
        must.push(json!({"query_string":{"query":text,"default_operator":"AND"}}));
    }
    filter.extend([
        json!({"term":{"metadata.contextType.keyword":"file"}}),
        json!({"term":{"metadata.contextType.keyword":"achievements"}}),
    ]);
    if let Some(t) = q.get("type").filter(|v| !v.is_empty()) {
        filter.push(json!({"term":{"metadata.contextType.keyword":t}}));
    }
    if let Some(v) = q.get("id").filter(|v| !v.is_empty()) {
        filter.push(json!({"term":{"metadata.contextId.keyword":v}}));
    }
    let mut body = json!({"size":limit+1,"track_total_hits":true,"query":{"bool":{"must_not":filter,"must":must}},"sort":[{"timestamp":{"order":"desc","missing":"_last"}},{"metadata.contextId.keyword":{"order":"asc","missing":"_last"}},{"metadata.contextType.keyword":{"order":"asc","missing":"_last"}}]});
    if let Some(after) = after {
        body["search_after"] = json!(after);
    }
    let result = state
        .opensearch
        .search("egdata.changelog", &body)
        .await
        .map_err(|_| {
            fail(
                ProblemError::new(
                    503,
                    "SEARCH_UNAVAILABLE",
                    "Changelog search is temporarily unavailable. Please retry shortly.",
                )
                .with_headers(BTreeMap::from([("Retry-After".into(), "1".into())])),
                &uri,
                id.clone(),
            )
        })?;
    let (hits, has_more, next) = search_page(
        &state,
        &binding,
        &result,
        limit,
        now,
        &["query", "type", "id"],
    )
    .map_err(|e| fail(e, &uri, id.clone()))?;
    let data: Vec<_> = hits
        .iter()
        .map(|hit| {
            let mut row = serialized_hit_record(&hit["_source"]);
            if let Some(id) = hit.get("_id") {
                row["_id"] = id.clone();
            } else {
                row.as_object_mut().unwrap().shift_remove("_id");
            }
            row
        })
        .collect();
    Ok(json_success(
        &axum::http::Method::GET,
        uri.path(),
        &id,
        json!(data),
        Some(
            json!({"pagination":search_pagination(&result,limit,has_more,next),"query":q.get("query"),"result":search_result_meta(&result)}),
        ),
    ))
}

async fn multisearch_offers(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    uri: Uri,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let id = request_id(ctx.as_ref(), &headers);
    let q = offer_search_params(&uri, true).map_err(|e| fail(e, &uri, id.clone()))?;
    let rp = regional_params(
        q.get("country").map(String::as_str),
        q.get("locale").map(String::as_str),
    )
    .map_err(|e| fail(e, &uri, id.clone()))?;
    let pagination = parse_pagination_map(&q, 100).map_err(|e| fail(e, &uri, id.clone()))?;
    let limit = pagination.limit;
    let dir = q.get("sortDir").map(String::as_str).unwrap_or("desc");
    let raw_text = q
        .get("query")
        .map(|v| trim_js_whitespace(v))
        .filter(|v| !v.is_empty());
    let parsed_url = raw_text
        .filter(|v| v.contains("store.epicgames.com"))
        .and_then(|v| url::Url::parse(v).ok());
    let text = parsed_url
        .as_ref()
        .and_then(|u| u.path().rsplit('/').next())
        .filter(|v| !v.is_empty())
        .or(raw_text);
    let mut values = json!({"query":text,"offerType":q.get("offerType")});
    for key in ["tags", "categories", "customAttributes"] {
        values[key] =
            json!(egdata_core::v1::parse_csv(q.get(key).map(String::as_str)).unwrap_or_default());
    }
    for key in [
        "seller",
        "developerDisplayName",
        "publisherDisplayName",
        "refundType",
    ] {
        values[key] = json!(q.get(key));
    }
    for key in [
        "isCodeRedemptionOnly",
        "excludeBlockchain",
        "pastGiveaways",
        "onSale",
        "isLowestPrice",
        "isLowestPriceEver",
    ] {
        values[key] = json!(
            parse_boolean(q.get(key).map(String::as_str), key).map_err(|e| fail(
                e,
                &uri,
                id.clone()
            ))?
        );
    }
    for key in ["priceMin", "priceMax"] {
        values[key] =
            json!(
                parse_integer(q.get(key).map(String::as_str), key, Some(0), None)
                    .map_err(|e| fail(e, &uri, id.clone()))?
            );
    }
    let sort = q.get("sortBy").map(String::as_str);
    values["sortBy"] = json!(sort);
    values["sortDir"] = json!(dir);
    let binding = CursorBinding {
        operation: "multisearch.offers".into(),
        ordering: format!(
            "{}:{dir},id:asc",
            sort.unwrap_or(if text.is_some() {
                "_score"
            } else {
                "lastModifiedDate"
            })
        ),
        filters: Some(values.as_object().unwrap().clone().into_iter().collect()),
        country: rp.country.clone(),
        locale: rp.locale.clone(),
        limit,
    };
    let cache_key = v1_cache_key(
        "multisearch.offers",
        &BTreeMap::from([
            ("region", json!(rp.region)),
            ("locale", json!(rp.locale)),
            ("limit", json!(limit)),
            ("cursor", json!(pagination.cursor)),
            ("filters", values.clone()),
        ]),
    );
    if let Some(cached) = v1_cache_get(state.cache.as_ref(), &cache_key).await {
        let meta = cached_meta(
            json!({"country":rp.country,"region":rp.region,"locale":rp.locale}),
            &cached,
            &["result", "pagination"],
        );
        return Ok(cached_page(&uri, &id, &cached, "hits", meta));
    }
    let now = (state.now)().timestamp_millis();
    let search_after = apply_cursor(&state, &binding, pagination.cursor.as_deref(), now)
        .map_err(|e| fail(e, &uri, id.clone()))?;
    let query = text_matches(text);
    let region = &rp.region;
    let mut filters = offer_filters(&values, region, true, false);
    let sort_field = match sort {
        Some("priceAsc" | "priceDesc" | "price") => {
            Some(format!("prices.{region}.price.discountPrice"))
        }
        Some("discount") => Some(format!("prices.{region}.price.discount")),
        Some("giveawayDate") => Some("freeEntries.endDate".to_owned()),
        Some("upcoming") => {
            let date = egdata_core::v1::serialization::js_iso_datetime(
                chrono::DateTime::from_timestamp_millis(now).unwrap(),
            );
            filters.push(json!({"range":{"releaseDate":{"gte":date}}}));
            Some("releaseDate".to_owned())
        }
        other => other.filter(|s| !s.is_empty()).map(str::to_owned),
    };
    let direction = match sort {
        Some("priceAsc") => "asc",
        Some("priceDesc") => "desc",
        Some("upcoming") if dir == "asc" => "desc",
        Some("upcoming") => "asc",
        _ => dir,
    };
    let mut sorts = Vec::new();
    if let Some(field) = sort_field {
        sorts.push(json!({field:{"order":direction,"missing":"_last"}}));
        if text.is_some() {
            sorts.push(json!({"_score":{"order":"desc"}}));
        }
    } else {
        sorts.push(json!({"_score":{"order":"desc"}}));
    }
    sorts.push(json!({"id.keyword":{"order":"asc","missing":"_last"}}));
    let mut body = json!({"size":limit+1,"track_total_hits":true,"query":{"bool":{"must":query,"filter":filters}},"sort":sorts});
    if let Some(after) = search_after {
        body["search_after"] = json!(after);
    }
    let result = state
        .opensearch
        .search("egdata.offers", &body)
        .await
        .map_err(|_| {
            fail(
                ProblemError::new(
                    503,
                    "SEARCH_UNAVAILABLE",
                    "Offer search is temporarily unavailable.",
                )
                .with_headers(BTreeMap::from([("Retry-After".into(), "1".into())])),
                &uri,
                id.clone(),
            )
        })?;
    let (hits, has_more, next) = search_page(
        &state,
        &binding,
        &result,
        limit,
        now,
        MULTI_OFFER_FILTER_ORDER,
    )
    .map_err(|e| fail(e, &uri, id.clone()))?;
    let ordered = hits
        .iter()
        .map(|hit| super::offers::checked_ordered(&hit["_source"]))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| fail(e, &uri, id.clone()))?;
    let localized = super::system::localize_offers(&state, &ordered, &rp.locale)
        .await
        .map_err(|e| fail(e, &uri, id.clone()))?;
    let cards: Vec<Value> = localized
        .iter()
        .map(|offer| serialize_json_offer(offer, None, true))
        .collect();
    let pagination_meta = search_pagination(&result, limit, has_more, next);
    let result_meta = search_result_meta(&result);
    v1_cache_set(
        state.cache.as_ref(),
        &cache_key,
        &json!({"hits":cards,"pagination":pagination_meta,"result":result_meta}),
        60,
    )
    .await;
    Ok(json_success(
        &axum::http::Method::GET,
        uri.path(),
        &id,
        json!(cards),
        Some(
            json!({"country":rp.country,"region":rp.region,"locale":rp.locale,"result":result_meta,"pagination":pagination_meta}),
        ),
    ))
}

async fn multisearch_items(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    uri: Uri,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let id = request_id(ctx.as_ref(), &headers);
    let mut q = search_query(
        &uri,
        &["query", "type", "limit", "cursor"],
        &[("query", 500), ("type", 100)],
    )
    .map_err(|e| fail(e, &uri, id.clone()))?;
    q.entry("limit".into()).or_insert_with(|| "20".into());
    let pagination = parse_pagination_map(&q, 100).map_err(|e| fail(e, &uri, id.clone()))?;
    let limit = pagination.limit;
    let binding = CursorBinding {
        operation: "multisearch.items".into(),
        filters: Some(BTreeMap::from([
            (
                "query".into(),
                q.get("query").map_or(Value::Null, |v| json!(v)),
            ),
            (
                "type".into(),
                q.get("type").map_or(Value::Null, |v| json!(v)),
            ),
        ])),
        ordering: "lastModifiedDate:desc,id:asc".into(),
        country: String::new(),
        locale: String::new(),
        limit,
    };
    let now = (state.now)().timestamp_millis();
    let mut cache_parts = BTreeMap::from([("limit", json!(limit))]);
    for key in ["query", "type"] {
        if let Some(value) = q.get(key) {
            cache_parts.insert(key, json!(value));
        }
    }
    if let Some(cursor) = pagination.cursor.as_deref() {
        cache_parts.insert("cursor", json!(cursor));
    }
    let cache_key = v1_cache_key("multisearch.items", &cache_parts);
    if let Some(cached) = v1_cache_get(state.cache.as_ref(), &cache_key).await {
        return Ok(cached_page(
            &uri,
            &id,
            &cached,
            "hits",
            cached_meta(json!({}), &cached, &["result", "pagination"]),
        ));
    }
    let after = apply_cursor(&state, &binding, pagination.cursor.as_deref(), now)
        .map_err(|e| fail(e, &uri, id.clone()))?;
    let must = q
        .get("query")
        .filter(|s| !s.is_empty())
        .map(|s| json!([{"multi_match":{"query":s,"fields":["title^2","description","id"]}}]))
        .unwrap_or(json!([]));
    let mut filter = vec![json!({"bool":{"must_not":{"term":{"namespace.keyword":"ue"}}}})];
    if let Some(t) = q.get("type").filter(|v| !v.is_empty()) {
        filter.push(json!({"term":{"entitlementType.keyword":t}}));
    }
    let mut body = json!({"size":limit+1,"track_total_hits":true,"query":{"bool":{"must":must,"filter":filter}},"sort":[{"lastModifiedDate":{"order":"desc","missing":"_last"}},{"id.keyword":{"order":"asc","missing":"_last"}}]});
    if let Some(after) = after {
        body["search_after"] = json!(after);
    }
    let result = state
        .opensearch
        .search("egdata.items", &body)
        .await
        .map_err(|_| {
            fail(
                ProblemError::new(
                    503,
                    "SEARCH_UNAVAILABLE",
                    "Item search is temporarily unavailable.",
                )
                .with_headers(BTreeMap::from([("Retry-After".into(), "1".into())])),
                &uri,
                id.clone(),
            )
        })?;
    let (hits, has_more, next) =
        search_page(&state, &binding, &result, limit, now, &["query", "type"])
            .map_err(|e| fail(e, &uri, id.clone()))?;
    let data: Vec<_> = hits
        .iter()
        .map(|hit| {
            let source = &hit["_source"];
            let mut item = serialized_hit_record(source);
            item["customAttributes"] = source
                .get("customAttributes")
                .filter(|v| js_truthy(v))
                .map(super::offers::checked_attributes)
                .transpose()?
                .unwrap_or_else(|| json!({}));
            Ok(item)
        })
        .collect::<Result<_, _>>()
        .map_err(|e| fail(e, &uri, id.clone()))?;
    let pagination_meta = search_pagination(&result, limit, has_more, next);
    let result_meta = search_result_meta(&result);
    v1_cache_set(
        state.cache.as_ref(),
        &cache_key,
        &json!({"hits":data,"pagination":pagination_meta,"result":result_meta}),
        60,
    )
    .await;
    Ok(json_success(
        &axum::http::Method::GET,
        uri.path(),
        &id,
        json!(data),
        Some(json!({"result":result_meta,"pagination":pagination_meta})),
    ))
}

async fn multisearch_sellers(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    uri: Uri,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let id = request_id(ctx.as_ref(), &headers);
    let q = search_query(&uri, &["query", "limit"], &[("query", 300)])
        .map_err(|e| fail(e, &uri, id.clone()))?;
    // Match Node's parseInt(value || "20") || 20, capped only at 100.
    let parsed_limit = q
        .get("limit")
        .and_then(|raw| {
            let trimmed = egdata_core::v1::trim_js_whitespace(raw);
            let numeric = trimmed
                .strip_prefix(['+', '-'])
                .unwrap_or(trimmed)
                .chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>();
            if numeric.is_empty() {
                None
            } else {
                let sign = if trimmed.starts_with('-') { -1.0 } else { 1.0 };
                Some(numeric.parse::<f64>().unwrap_or(f64::INFINITY) * sign)
            }
        })
        .filter(|n| *n != 0.0)
        .unwrap_or(20.0);
    let limit = parsed_limit.min(100.0);
    let limit_json = if limit.is_finite()
        && limit.fract() == 0.0
        && limit >= i64::MIN as f64
        && limit <= i64::MAX as f64
    {
        json!(limit as i64)
    } else {
        json!(limit)
    };
    let cache_key = {
        let mut parts = BTreeMap::new();
        parts.insert("limit", limit_json.clone());
        if let Some(query) = q.get("query") {
            parts.insert("query", json!(query));
        }
        if limit.is_finite() {
            v1_cache_key("multisearch.sellers", &parts)
        } else {
            let query_part = q
                .get("query")
                .map(|query| format!(":query={}", json!(query)))
                .unwrap_or_default();
            format!("v1:multisearch.sellers:limit=null{query_part}")
        }
    };
    if let Some(cached) = v1_cache_get(state.cache.as_ref(), &cache_key).await {
        let data = cached
            .get("hits")
            .filter(|v| !v.is_null())
            .ok_or_else(|| fail(internal_error(), &uri, id.clone()))?;
        let mut meta = cached_meta(json!({}), &cached, &["result"]);
        if let Some(length) = data
            .as_array()
            .map(Vec::len)
            .or_else(|| data.as_str().map(|s| s.encode_utf16().count()))
        {
            meta["count"] = json!(length);
        }
        return Ok(cached_page(&uri, &id, &cached, "hits", meta));
    }
    let query = q
        .get("query")
        .filter(|v| !v.is_empty())
        .map(
            |v| json!({"bool":{"must":[{"match":{"seller.name":{"query":v,"fuzziness":"AUTO"}}}]}}),
        )
        .unwrap_or(json!({"match_all":{}}));
    let result=state.opensearch.search("egdata.offers",&json!({"size":0,"query":query,"aggs":{"sellers":{"terms":{"field":"seller.id.keyword","size":limit_json}}}})).await.map_err(|_|fail(ProblemError::new(503,"SEARCH_UNAVAILABLE","Seller search is temporarily unavailable.").with_headers(BTreeMap::from([("Retry-After".into(),"1".into())])),&uri,id.clone()))?;
    let buckets = match result.pointer("/aggregations/sellers/buckets") {
        Some(Value::Array(buckets)) => buckets.as_slice(),
        Some(Value::Null) | None if !result.is_null() => &[],
        _ => return Err(fail(internal_error(), &uri, id)),
    };
    if buckets.iter().any(Value::is_null) {
        return Err(fail(internal_error(), &uri, id));
    }
    let seller_ids: Vec<String> = buckets
        .iter()
        .filter_map(|b| b.get("key").and_then(Value::as_str).map(str::to_owned))
        .collect();
    let ids: Vec<_> = seller_ids.iter().cloned().map(bson::Bson::String).collect();
    let docs = if seller_ids.is_empty() {
        vec![]
    } else {
        state
            .mongo
            .find_many(
                "sellers",
                bson::doc! {"_id":{"$in":ids}},
                MongoFindOptions::default(),
            )
            .await
            .map_err(|_| fail(internal_error(), &uri, id.clone()))?
    };
    let by_id: std::collections::HashMap<String, Value> = docs
        .into_iter()
        .map(|d| {
            let raw = egdata_core::v1::bson_to_serialized_json(&bson::Bson::Document(d));
            let id = raw
                .get("_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            (id, egdata_core::v1::serialize_seller(&raw))
        })
        .collect();
    let data: Vec<Value> = seller_ids
        .iter()
        .filter_map(|id| by_id.get(id).cloned())
        .collect();
    let result_meta = search_result_meta(&result);
    v1_cache_set(
        state.cache.as_ref(),
        &cache_key,
        &json!({"hits":data,"result":result_meta}),
        300,
    )
    .await;
    Ok(json_success(
        &axum::http::Method::GET,
        uri.path(),
        &id,
        json!(data),
        Some(json!({
            "result": result_meta,
            "count": data.len()
        })),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{test_support::test_app_state, state::ApiConfig};
    use async_trait::async_trait;
    use axum::{Router, body::Body, http::Request};
    use bson::{Bson, Document};
    use egdata_core::v1::decode_cursor_with;
    use egdata_core::{
        error::CoreError,
        ports::{MongoFindOptions, MongoStorePort, OpenSearchPort, ResponseCachePort},
    };
    use http_body_util::BodyExt;
    use serde_json::Value;
    use std::collections::HashMap;
    use tokio::sync::Mutex;
    use tower::ServiceExt;

    #[derive(Clone)]
    struct SearchRecorder(std::sync::Arc<Mutex<Vec<(String, Value)>>>);
    #[async_trait]
    impl OpenSearchPort for SearchRecorder {
        async fn search(&self, index: &str, body: &Value) -> Result<Value, CoreError> {
            self.0.lock().await.push((index.into(), body.clone()));
            Ok(
                json!({"took":3,"hits":{"total":{"value":2,"relation":"eq"},"hits":[
                    {"_id":"offer-a","_source":{"id":"offer-a","title":"A","lastModifiedDate":"2026-01-02T00:00:00Z","prices":{"EURO":{"price":{"discountPrice":5}}}},"sort":["2026-01-02T00:00:00Z","offer-a"]},
                    {"_id":"offer-b","_source":{"id":"offer-b","title":"B","lastModifiedDate":"2026-01-01T00:00:00Z","prices":{"EURO":{"price":{"discountPrice":7}}}},"sort":["2026-01-01T00:00:00Z","offer-b"]}
                ]}}),
            )
        }
    }

    #[derive(Clone)]
    struct ItemOracleSearch(Value, bool, std::sync::Arc<Mutex<Vec<(String, Value)>>>);
    #[async_trait]
    impl OpenSearchPort for ItemOracleSearch {
        async fn search(&self, index: &str, body: &Value) -> Result<Value, CoreError> {
            self.2.lock().await.push((index.into(), body.clone()));
            if self.1 {
                Err(CoreError::Upstream("unavailable".into()))
            } else {
                Ok(self.0.clone())
            }
        }
    }

    #[derive(Clone, Default)]
    struct OracleCache {
        payload: Option<String>,
        entries: HashMap<String, String>,
        store: std::sync::Arc<Mutex<HashMap<String, String>>>,
        fail_read: bool,
        fail_write: bool,
        writes: std::sync::Arc<Mutex<Vec<(String, String, u64)>>>,
        reads: std::sync::Arc<Mutex<Vec<String>>>,
    }
    #[async_trait]
    impl ResponseCachePort for OracleCache {
        async fn get(&self, key: &str) -> Result<Option<String>, CoreError> {
            self.reads.lock().await.push(key.to_owned());
            if self.fail_read {
                Err(CoreError::Internal("cache read".into()))
            } else {
                Ok(self
                    .store
                    .lock()
                    .await
                    .get(key)
                    .cloned()
                    .or_else(|| self.entries.get(key).cloned())
                    .or_else(|| {
                        if self.entries.is_empty() {
                            self.payload.clone()
                        } else {
                            None
                        }
                    }))
            }
        }
        async fn set(&self, key: &str, value: &str, ttl: u64) -> Result<(), CoreError> {
            self.writes
                .lock()
                .await
                .push((key.into(), value.into(), ttl));
            if self.fail_write {
                Err(CoreError::Internal("cache write".into()))
            } else {
                self.store.lock().await.insert(key.into(), value.into());
                Ok(())
            }
        }
        async fn del(&self, _: &str) -> Result<(), CoreError> {
            Err(CoreError::Internal(
                "unexpected search cache eviction".into(),
            ))
        }
        async fn ping(&self) -> Result<bool, CoreError> {
            Ok(true)
        }
    }

    #[derive(Clone)]
    struct FixtureVectorize(Vec<egdata_core::ports::VectorizeOfferMatch>);
    #[async_trait]
    impl egdata_core::ports::VectorizePort for FixtureVectorize {
        async fn query_natural_language(
            &self,
            _query: &str,
            _top_k: usize,
        ) -> Result<Vec<egdata_core::ports::VectorizeOfferMatch>, CoreError> {
            Ok(self.0.clone())
        }
    }

    #[derive(Clone)]
    struct ConfigErrorVectorize;
    #[async_trait]
    impl egdata_core::ports::VectorizePort for ConfigErrorVectorize {
        async fn query_natural_language(
            &self,
            _query: &str,
            _top_k: usize,
        ) -> Result<Vec<egdata_core::ports::VectorizeOfferMatch>, CoreError> {
            Err(CoreError::InvalidInput("not configured".into()))
        }
    }

    #[derive(Clone)]
    struct UpstreamErrorVectorize;
    #[async_trait]
    impl egdata_core::ports::VectorizePort for UpstreamErrorVectorize {
        async fn query_natural_language(
            &self,
            _query: &str,
            _top_k: usize,
        ) -> Result<Vec<egdata_core::ports::VectorizeOfferMatch>, CoreError> {
            Err(CoreError::Upstream("upstream unavailable".into()))
        }
    }

    #[derive(Clone)]
    struct GenericErrorVectorize;
    #[async_trait]
    impl egdata_core::ports::VectorizePort for GenericErrorVectorize {
        async fn query_natural_language(
            &self,
            _query: &str,
            _top_k: usize,
        ) -> Result<Vec<egdata_core::ports::VectorizeOfferMatch>, CoreError> {
            Err(CoreError::Internal("unexpected vector error".into()))
        }
    }

    type RecordedAggregate = std::sync::Arc<Mutex<Vec<(String, Vec<Document>)>>>;
    type RecordedFinds = std::sync::Arc<Mutex<Vec<(String, Document, MongoFindOptions)>>>;
    #[derive(Clone, Default)]
    struct AggregateRecorder {
        aggregates: RecordedAggregate,
        finds: RecordedFinds,
        rows: Vec<Document>,
        fail_finds: bool,
        fail_count: bool,
        changelog_counts: std::sync::Arc<tokio::sync::Mutex<Vec<Document>>>,
        fail_aggregate: bool,
        localized: Vec<Document>,
        fail_localization: bool,
        aggregate_output: Option<Vec<Document>>,
    }
    #[async_trait]
    impl MongoStorePort for AggregateRecorder {
        async fn find_one(
            &self,
            _: &str,
            _: Document,
            _: Option<Document>,
        ) -> Result<Option<Document>, CoreError> {
            Err(CoreError::Internal(
                "unexpected single-document search read".into(),
            ))
        }
        async fn find_many(
            &self,
            collection: &str,
            filter: Document,
            options: MongoFindOptions,
        ) -> Result<Vec<Document>, CoreError> {
            self.finds
                .lock()
                .await
                .push((collection.into(), filter, options));
            if self.fail_finds {
                Err(CoreError::Internal("mongo unavailable".into()))
            } else if collection == "egs_localizations" {
                if self.fail_localization {
                    Err(CoreError::Internal("localization unavailable".into()))
                } else {
                    Ok(self.localized.clone())
                }
            } else {
                Ok(self.rows.clone())
            }
        }
        async fn aggregate(
            &self,
            collection: &str,
            pipeline: Vec<Document>,
        ) -> Result<Vec<Document>, CoreError> {
            self.aggregates
                .lock()
                .await
                .push((collection.into(), pipeline));
            if self.fail_aggregate {
                return Err(CoreError::Internal("mongo unavailable".into()));
            }
            if let Some(output) = &self.aggregate_output {
                return Ok(output.clone());
            }
            Ok(vec![
                bson::doc! {"total":[{"total":2}],"tagCounts":[{"_id":"tag1","count":2}],"offerTypeCounts":[{"_id":"BASE_GAME","count":2}],"developer":[],"publisher":[],"priceRange":[{"minPrice":1,"maxPrice":99,"currency":"EUR"}]},
            ])
        }
        async fn count_documents(
            &self,
            collection: &str,
            filter: Document,
        ) -> Result<u64, CoreError> {
            if collection != "changelogs_v2" {
                return Err(CoreError::Internal("unexpected search count".into()));
            }
            self.changelog_counts.lock().await.push(filter);
            if self.fail_count {
                return Err(CoreError::Internal("count unavailable".into()));
            }
            Ok(23)
        }
        async fn distinct(&self, _: &str, _: &str, _: Document) -> Result<Vec<Bson>, CoreError> {
            Err(CoreError::Internal(
                "unexpected search distinct read".into(),
            ))
        }
        async fn insert_one(&self, _: &str, _: Document) -> Result<(), CoreError> {
            Err(CoreError::Internal("unexpected search store write".into()))
        }
        async fn update_one(
            &self,
            _: &str,
            _: Document,
            _: Document,
            _: bool,
        ) -> Result<u64, CoreError> {
            Err(CoreError::Internal(
                "unexpected search store operation".into(),
            ))
        }
        async fn delete_one(&self, _: &str, _: Document) -> Result<u64, CoreError> {
            Err(CoreError::Internal(
                "unexpected search store operation".into(),
            ))
        }
        async fn ping(&self) -> Result<bool, CoreError> {
            Ok(true)
        }
    }

    #[tokio::test]
    async fn search_fixtures_reject_unrecorded_reads_and_writes() {
        let mongo = AggregateRecorder::default();
        assert!(mongo.ping().await.unwrap());
        assert!(
            mongo
                .find_one("offers", Document::new(), None)
                .await
                .is_err()
        );
        assert!(
            mongo
                .count_documents("offers", Document::new())
                .await
                .is_err()
        );
        assert!(
            mongo
                .distinct("offers", "id", Document::new())
                .await
                .is_err()
        );
        assert!(mongo.insert_one("offers", Document::new()).await.is_err());
        assert!(
            mongo
                .update_one("offers", Document::new(), Document::new(), false)
                .await
                .is_err()
        );
        assert!(mongo.delete_one("offers", Document::new()).await.is_err());
        let cache = OracleCache {
            entries: HashMap::from([("existing".into(), "saved".into())]),
            payload: Some("fallback".into()),
            ..Default::default()
        };
        assert!(cache.ping().await.unwrap());
        assert_eq!(cache.get("missing").await.unwrap(), None);
        assert!(cache.del("existing").await.is_err());
        assert_eq!(
            cache.get("existing").await.unwrap().as_deref(),
            Some("saved")
        );
    }

    fn app() -> Router {
        let state = test_app_state(ApiConfig::default());
        route_group("/v1").router.with_state(state)
    }

    fn recording_app(calls: std::sync::Arc<Mutex<Vec<(String, Value)>>>) -> Router {
        let mut state = test_app_state(ApiConfig::default());
        state.opensearch = std::sync::Arc::new(SearchRecorder(calls));
        route_group("/v1").router.with_state(state)
    }

    fn request(method: &str, uri: &str) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(uri)
            .header("x-request-id", "req_search_test")
            .body(Body::empty())
            .unwrap()
    }

    async fn body(response: Response) -> Value {
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
    }

    #[tokio::test]
    async fn search_http_matches_node_oracle_fixture() {
        let expected: Vec<Value> =
            serde_json::from_str(include_str!("../../egdata-api/tests/fixtures/search-http-node.json"))
                .unwrap();
        let repeated_count_case = expected
            .iter()
            .find(|case| case["name"] == "cached_search_count_repeat_cache_hit")
            .cloned()
            .unwrap();
        let mut responses = Vec::new();
        for case in expected {
            let name = case["name"].as_str().unwrap();
            if name == "cached_search_count_repeat_cache_hit" {
                continue;
            }
            let request = &case["request"];
            let mut builder = Request::builder()
                .method(request["method"].as_str().unwrap())
                .uri(request["path"].as_str().unwrap())
                .header("x-request-id", "req_node_oracle");
            let body_text = if let Some(raw) = request.get("rawBody").and_then(Value::as_str) {
                if let Some(content_type) = request.get("contentType").and_then(Value::as_str) {
                    builder = builder.header("content-type", content_type);
                }
                raw.to_owned()
            } else if let Some(value) = request.get("body") {
                builder = builder.header(
                    "content-type",
                    request
                        .get("contentType")
                        .and_then(Value::as_str)
                        .unwrap_or("application/json"),
                );
                value.to_string()
            } else {
                String::new()
            };
            let input = &case["input"];
            let mut config = ApiConfig::default();
            if let Some(base) = input["publicBase"].as_str() {
                config.v1_public_base_url = base.to_owned();
            }
            if input["cursorSecret"] == false {
                config.node_env = "production".into();
                config.v1_cursor_secret = None;
            }
            let mut state = test_app_state(config);
            state.now = oracle_frozen_now;
            let search_calls = std::sync::Arc::new(Mutex::new(Vec::new()));
            state.opensearch = std::sync::Arc::new(ItemOracleSearch(
                input
                    .get("opensearchResponse")
                    .cloned()
                    .unwrap_or_else(|| json!({})),
                input.get("opensearchError").is_some(),
                search_calls.clone(),
            ));
            let cache_writes = std::sync::Arc::new(Mutex::new(Vec::new()));
            let cache_reads = std::sync::Arc::new(Mutex::new(Vec::new()));
            let cache_store = std::sync::Arc::new(Mutex::new(HashMap::new()));
            state.cache = std::sync::Arc::new(OracleCache {
                payload: input
                    .get("cachePayload")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                entries: input
                    .get("cacheEntries")
                    .and_then(Value::as_object)
                    .map(|entries| {
                        entries
                            .iter()
                            .filter_map(|(key, value)| {
                                value.as_str().map(|raw| (key.clone(), raw.to_owned()))
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                store: cache_store.clone(),
                fail_read: input["cacheReadFailure"] == true,
                fail_write: input["cacheWriteFailure"] == true,
                writes: cache_writes.clone(),
                reads: cache_reads.clone(),
            });
            let saved_reads = std::sync::Arc::new(Mutex::new(Vec::new()));
            state.saved_queries = std::sync::Arc::new(OracleCache {
                payload: None,
                entries: input
                    .get("savedQueryEntries")
                    .and_then(Value::as_object)
                    .map(|entries| {
                        entries
                            .iter()
                            .filter_map(|(key, value)| {
                                value.as_str().map(|raw| (key.clone(), raw.to_owned()))
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                store: std::sync::Arc::new(Mutex::new(HashMap::new())),
                fail_read: input["savedQueryReadFailure"] == true,
                fail_write: false,
                writes: std::sync::Arc::new(Mutex::new(Vec::new())),
                reads: saved_reads.clone(),
            });
            if let Some(matches) = input.get("vectorMatches") {
                state.vectorize = std::sync::Arc::new(FixtureVectorize(
                    serde_json::from_value(matches.clone()).unwrap(),
                ));
            }
            let mongo_rows = input
                .get("mongoRows")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let aggregate_calls = RecordedAggregate::default();
            let find_calls = RecordedFinds::default();
            let aggregate_output = input
                .get("mongoAggregateRows")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .map(bson::to_document)
                        .collect::<Result<Vec<_>, _>>()
                        .unwrap()
                });
            let changelog_counts = std::sync::Arc::default();
            state.mongo = std::sync::Arc::new(AggregateRecorder {
                changelog_counts: std::sync::Arc::clone(&changelog_counts),
                aggregates: aggregate_calls.clone(),
                finds: find_calls.clone(),
                rows: mongo_rows
                    .iter()
                    .map(bson::to_document)
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap(),
                fail_finds: input["mongoError"] == "unavailable",
                fail_count: input["countUnavailable"] == true,
                fail_localization: input["failLocalization"] == true,
                localized: input["localizationRows"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|row| bson::to_document(row).unwrap())
                    .collect(),
                fail_aggregate: input["mongoAggregateError"] == true,
                aggregate_output,
            });
            if input["vectorError"] == "configuration" {
                state.vectorize = std::sync::Arc::new(ConfigErrorVectorize);
            } else if input["vectorError"] == "upstream" {
                state.vectorize = std::sync::Arc::new(UpstreamErrorVectorize);
            } else if input["vectorError"] == "generic" {
                state.vectorize = std::sync::Arc::new(GenericErrorVectorize);
            }
            let mut app = route_group("/v1").router.with_state(state);
            if input["captureEtag"] == true {
                app = app.layer(axum::middleware::from_fn(
                    egdata_http_core::middleware::response_etag::response_etag,
                ));
            }
            if let Some(tag) = input["ifNoneMatch"].as_str() {
                builder = builder.header("if-none-match", tag);
            }
            let repeat_app = app.clone();
            let response = app
                .oneshot(builder.body(Body::from(body_text)).unwrap())
                .await
                .unwrap();
            let actual = egdata_api_test_support::capture_response(response).await;
            if actual != case["response"] {
                responses.push(format!(
                    "{name}\n  Rust {actual}\n  Node {}",
                    case["response"]
                ));
                continue;
            }
            for (collection, key) in [
                ("offers", "offerFindFilter"),
                ("sellers", "sellerFindFilter"),
                ("egs_localizations", "localizationFilter"),
                ("tags", "tagsFindQuery"),
            ] {
                if let Some(filter) = input.get(key) {
                    let finds = find_calls.lock().await;
                    let (_, actual, _) = finds
                        .iter()
                        .find(|(name, _, _)| name == collection)
                        .expect("expected Mongo lookup");
                    assert_eq!(
                        egdata_infra::bson_json::bson_doc_to_js_json(actual),
                        *filter,
                        "{name} {collection} lookup"
                    );
                }
            }
            assert_eq!(
                changelog_counts.lock().await.as_slice(),
                input
                    .get("changelogCountFilter")
                    .cloned()
                    .map(|v| bson::to_document(&v).unwrap())
                    .as_slice(),
                "{name} count filter"
            );
            if let Some(args) = input.get("changelogFindArgs") {
                let finds = find_calls.lock().await;
                let (_, query, options) = finds
                    .iter()
                    .find(|(name, _, _)| name == "changelogs_v2")
                    .expect("expected changelog lookup");
                assert_eq!(
                    egdata_infra::bson_json::bson_doc_to_js_json(query),
                    args[0],
                    "{name} changelog filter"
                );
                assert_eq!(
                    json!(options.limit),
                    args[2]["limit"],
                    "{name} changelog limit"
                );
                assert_eq!(
                    json!(options.sort),
                    args[2]["sort"],
                    "{name} changelog sort"
                );
            }
            if input["aggregateCalled"] == true {
                let captured = aggregate_calls
                    .lock()
                    .await
                    .last()
                    .cloned()
                    .expect("expected Mongo aggregation");
                assert_eq!(captured.0, "offers", "{name} aggregate collection");
                assert_eq!(
                    serde_json::to_value(captured.1).unwrap(),
                    input["aggregatePipeline"],
                    "{name} aggregate pipeline"
                );
            } else if input["aggregateCalled"] == false {
                assert!(
                    aggregate_calls.lock().await.is_empty(),
                    "{name} must not aggregate"
                );
            }
            if let Some(keys) = input.get("cacheReadKeys").and_then(Value::as_array) {
                let expected = keys
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>();
                assert_eq!(
                    *cache_reads.lock().await,
                    expected,
                    "{name} response cache read keys"
                );
            }
            if let Some(keys) = input.get("savedQueryReadKeys").and_then(Value::as_array) {
                let expected = keys
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|key| key.strip_prefix("q:").unwrap_or(key).to_owned())
                    .collect::<Vec<_>>();
                assert_eq!(
                    *saved_reads.lock().await,
                    expected,
                    "{name} saved query read keys"
                );
            }
            if let Some(call) = input.get("opensearchRequest") {
                assert_eq!(
                    search_calls.lock().await.last(),
                    Some(&(
                        call["index"].as_str().unwrap().to_owned(),
                        call["body"].clone()
                    )),
                    "{name} OpenSearch request"
                );
            } else if input["opensearchCalled"] == false {
                assert!(
                    search_calls.lock().await.is_empty(),
                    "{name} should skip OpenSearch"
                );
            }
            if let Some(expected_key) = input.get("cacheWriteKey").and_then(Value::as_str) {
                assert_eq!(
                    cache_writes
                        .lock()
                        .await
                        .last()
                        .map(|(key, _, _)| key.as_str()),
                    Some(expected_key),
                    "{name} cache key"
                );
                assert_eq!(
                    cache_writes.lock().await.last().map(|(_, _, ttl)| *ttl),
                    input["cacheWriteTtl"].as_u64(),
                    "{name} cache TTL"
                );
            }
            if let Some(expected_payload) = input.get("cacheWriteValue").and_then(Value::as_str) {
                let expected: Value = serde_json::from_str(expected_payload).unwrap();
                let actual: Value =
                    serde_json::from_str(&cache_writes.lock().await.last().unwrap().1).unwrap();
                assert_eq!(actual, expected, "{name} cache write payload");
            }
            if name == "cached_search_count_uncached_eu_facets" {
                assert_eq!(
                    cache_writes.lock().await[0].1,
                    input["cacheWriteValue"].as_str().unwrap(),
                    "serialized count cache payload"
                );
                let expected_write = input["cacheWriteValue"].as_str().unwrap();
                assert_eq!(
                    repeated_count_case["input"]["cacheHitFromPriorWrite"], expected_write,
                    "repeat fixture must consume the first Node write"
                );
                let key = input["cacheWriteKey"].as_str().unwrap();
                assert_eq!(
                    cache_store.lock().await.get(key).map(String::as_str),
                    Some(expected_write)
                );
                let request = repeated_count_case["request"]["path"].as_str().unwrap();
                let repeated = repeat_app
                    .oneshot(
                        Request::builder()
                            .method("GET")
                            .uri(request)
                            .header("x-request-id", "req_node_oracle")
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                let repeated = egdata_api_test_support::capture_response(repeated).await;
                assert_eq!(
                    repeated, repeated_count_case["response"],
                    "cached count repeat response"
                );
                assert_eq!(
                    aggregate_calls.lock().await.len(),
                    1,
                    "repeat cache hit must skip another Mongo aggregation"
                );
                assert_eq!(
                    cache_reads
                        .lock()
                        .await
                        .iter()
                        .filter(|read| read.as_str() == key)
                        .count(),
                    2,
                    "both count reads use the same cached result key"
                );
            }
            if (name.starts_with("multisearch_sellers_") || name.starts_with("multisearch_items_"))
                && !name.contains("cache_hit")
                && !name.contains("service_unavailable")
                && !name.contains("database_error")
                && !name.contains("rejects_long_query")
                && !name.contains("rejects_long_type")
                && !name.contains("rejects_unknown_query")
                && !name.contains("cursor_filter_mismatch")
                && !name.contains("cache_write_failure")
            {
                let ttl = if name.starts_with("multisearch_items_") {
                    60
                } else {
                    300
                };
                assert_eq!(
                    cache_writes.lock().await.last().map(|(_, _, ttl)| *ttl),
                    Some(ttl),
                    "{name} cache TTL"
                );
            }
        }
        assert!(responses.is_empty(), "{}", responses.join("\n"));
    }

    fn oracle_frozen_now() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::from_timestamp_millis(1_794_873_600_000).unwrap()
    }

    #[tokio::test]
    async fn search_routes_reject_unknown_query_keys_and_keep_operation_specific_filters() {
        let response = app()
            .oneshot(request(
                "GET",
                "/v1/multisearch/items?query=abc&unexpected=1",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), 400);
        assert_eq!(
            response.headers()["content-type"],
            "application/problem+json"
        );
        assert_eq!(body(response).await["code"], "INVALID_QUERY");

        let response = app()
            .oneshot(request("GET", "/v1/search/tags?unexpected=1"))
            .await
            .unwrap();
        assert_eq!(response.status(), 400);
        assert_eq!(body(response).await["code"], "INVALID_QUERY");
    }

    #[tokio::test]
    async fn changelog_recent_view_uses_mongo_and_returns_cursor_metadata() {
        let calls = std::sync::Arc::new(Mutex::new(Vec::new()));
        let response = recording_app(calls.clone())
            .oneshot(request("GET", "/v1/search/changelog?limit=2"))
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let value = body(response).await;
        assert_eq!(value["data"], json!([]));
        assert_eq!(value["meta"]["query"], "");
        assert_eq!(value["meta"]["pagination"]["limit"], 2);
        assert_eq!(value["meta"]["pagination"]["hasMore"], false);
        assert!(
            calls.lock().await.is_empty(),
            "recent changes must not query OpenSearch"
        );
    }

    #[tokio::test]
    async fn changelog_recent_cache_and_continuation_use_node_bson_keyset() {
        let oid = bson::oid::ObjectId::parse_str("111111111111111111111111").unwrap();
        let timestamp = bson::DateTime::parse_rfc3339_str("2026-11-17T00:00:00Z").unwrap();
        let mongo = std::sync::Arc::new(AggregateRecorder {
            rows: vec![
                bson::doc! {"_id":oid,"timestamp":timestamp,"metadata":{"contextType":"offer"}},
                bson::doc! {"_id":bson::oid::ObjectId::new(),"timestamp":timestamp},
            ],
            ..Default::default()
        });
        let cache = std::sync::Arc::new(Mutex::new(HashMap::new()));
        let search_calls = std::sync::Arc::new(Mutex::new(Vec::new()));
        let mut state = test_app_state(ApiConfig::default());
        state.mongo = mongo.clone();
        state.cache = std::sync::Arc::new(OracleCache {
            store: cache.clone(),
            ..Default::default()
        });
        state.opensearch = std::sync::Arc::new(SearchRecorder(search_calls.clone()));
        let app = route_group("/v1").router.with_state(state);
        let path = "/v1/search/changelog?limit=1&type=offer&id=offer-1";
        let first = app.clone().oneshot(request("GET", path)).await.unwrap();
        assert_eq!(first.status(), 200);
        let first = body(first).await;
        assert_eq!(first["data"].as_array().unwrap().len(), 1);
        assert_eq!(first["data"][0]["_id"], oid.to_hex());
        assert_eq!(first["data"][0]["timestamp"], "2026-11-17T00:00:00.000Z");
        assert_eq!(first["meta"]["pagination"]["hasMore"], true);
        let token = first["meta"]["pagination"]["nextCursor"].as_str().unwrap();
        let key = v1_cache_key(
            "search.changelog",
            &BTreeMap::from([
                ("id", json!("offer-1")),
                ("type", json!("offer")),
                ("limit", json!(1)),
                ("cursor", Value::Null),
            ]),
        );
        let stored: Value = serde_json::from_str(cache.lock().await.get(&key).unwrap()).unwrap();
        assert_eq!(stored["hits"], first["data"]);
        assert_eq!(stored["pagination"], first["meta"]["pagination"]);
        assert_eq!(
            body(app.clone().oneshot(request("GET", path)).await.unwrap()).await,
            first
        );
        assert_eq!(mongo.finds.lock().await.len(), 1);
        let second = app
            .oneshot(request("GET", &format!("{path}&cursor={token}")))
            .await
            .unwrap();
        assert_eq!(second.status(), 200);
        let finds = mongo.finds.lock().await;
        assert_eq!(finds.len(), 2);
        assert_eq!(finds[0].0, "changelogs_v2");
        assert_eq!(
            finds[0].1,
            bson::doc! {"metadata.contextType":"offer", "metadata.contextId":"offer-1"}
        );
        assert_eq!(finds[0].2.limit, Some(2));
        assert_eq!(finds[0].2.sort, Some(bson::doc! {"timestamp":-1,"_id":1}));
        assert_eq!(
            finds[1].1,
            bson::doc! {
                "metadata.contextType":"offer", "metadata.contextId":"offer-1",
                "$or":[
                    {"timestamp":{"$lt":timestamp}}, {"timestamp":Bson::Null},
                    {"$and":[{"timestamp":{"$eq":timestamp}},{"_id":{"$gt":oid}}]},
                    {"$and":[{"timestamp":{"$eq":timestamp}},{"_id":Bson::Null}]},
                ]
            }
        );
        assert!(search_calls.lock().await.is_empty());
    }

    #[tokio::test]
    async fn changelog_query_validation_matches_zod_issues() {
        let response = app()
            .oneshot(request(
                "GET",
                &format!(
                    "/v1/search/changelog?type={}&id={}&unexpected=x",
                    "x".repeat(101),
                    "x".repeat(201)
                ),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), 400);
        let response = body(response).await;
        assert_eq!(
            response["detail"],
            "One or more query parameters are invalid or not supported."
        );
        assert_eq!(
            response["errors"],
            json!([
                {"parameter":"type","pointer":"/type","code":"TOO_BIG","message":"Too big: expected string to have <=100 characters"},
                {"parameter":"id","pointer":"/id","code":"TOO_BIG","message":"Too big: expected string to have <=200 characters"},
                {"code":"UNRECOGNIZED_KEYS","message":"Unrecognized key: \"unexpected\""}
            ])
        );
    }

    #[tokio::test]
    async fn changelog_text_search_matches_v1_query_body_and_raw_hit_shape() {
        let calls = std::sync::Arc::new(Mutex::new(Vec::new()));
        let response = recording_app(calls.clone())
            .oneshot(request(
                "GET",
                "/v1/search/changelog?query=hello&type=item&id=item-1&limit=1",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let value = body(response).await;
        assert_eq!(value["data"][0]["_id"], "offer-a");
        assert!(value["data"][0].get("document").is_none());
        assert_eq!(value["meta"]["query"], "hello");
        assert_eq!(value["meta"]["result"]["tookMs"], 3);
        assert_eq!(value["meta"]["result"]["timedOut"], false);
        let sent = calls.lock().await;
        assert_eq!(
            sent.len(),
            1,
            "v1 changelog performs one OpenSearch request"
        );
        assert_eq!(sent[0].0, "egdata.changelog");
        assert_eq!(
            sent[0].1["query"]["bool"]["must"][0]["query_string"]["query"],
            "hello"
        );
        assert_eq!(
            sent[0].1["query"]["bool"]["must_not"][0]["term"]["metadata.contextType.keyword"],
            "file"
        );
        assert_eq!(
            sent[0].1["query"]["bool"]["must_not"][1]["term"]["metadata.contextType.keyword"],
            "achievements"
        );
        assert_eq!(
            sent[0].1["query"]["bool"]["must_not"][2]["term"]["metadata.contextType.keyword"],
            "item"
        );
        assert_eq!(
            sent[0].1["query"]["bool"]["must_not"][3]["term"]["metadata.contextId.keyword"],
            "item-1"
        );
        assert_eq!(
            sent[0].1["sort"][1]["metadata.contextId.keyword"]["order"],
            "asc"
        );
        assert_eq!(sent[0].1["size"], 2);
    }

    #[tokio::test]
    async fn cursor_is_signed_and_bound_to_filters_and_operation() {
        let calls = std::sync::Arc::new(Mutex::new(Vec::new()));
        let invalid = recording_app(calls.clone())
            .oneshot(request(
                "GET",
                "/v1/multisearch/offers?query=rogue&cursor=invalid.token",
            ))
            .await
            .unwrap();
        assert_eq!(invalid.status(), 400);
        assert_eq!(body(invalid).await["code"], "INVALID_CURSOR");

        let binding = CursorBinding {
            operation: "multisearch.offers".into(),
            filters: Some(BTreeMap::from([("query".into(), json!("rogue"))])),
            ordering: "lastModifiedDate:desc,id:asc".into(),
            country: "US".into(),
            locale: "en-US".into(),
            limit: 1,
        };
        let token = egdata_core::v1::encode_cursor_with(
            &binding,
            &[
                CursorSortValue::from("2026-01-01T00:00:00Z"),
                CursorSortValue::from("offer-a"),
            ],
            Some("egdata-v1-local-cursor-secret-do-not-use-in-production"),
            chrono::Utc::now().timestamp_millis(),
        )
        .unwrap();
        let changed = recording_app(calls)
            .oneshot(request(
                "GET",
                &format!("/v1/multisearch/offers?query=other&limit=1&cursor={token}"),
            ))
            .await
            .unwrap();
        assert_eq!(changed.status(), 400);
        assert_eq!(body(changed).await["code"], "CURSOR_MISMATCH");
    }

    #[tokio::test]
    async fn post_search_normalizes_filter_body_to_bodyless_get_redirect() {
        let req = Request::builder()
            .method("POST")
            .uri("/v1/search")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"title":"hello world","limit":5}"#))
            .unwrap();
        let response = app().oneshot(req).await.unwrap();
        assert_eq!(response.status(), 303);
        assert_eq!(
            response.headers()["location"],
            "https://api.egdata.app/v1/search?country=US&limit=5&locale=en-US&title=hello+world"
        );
        assert!(
            response
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn get_search_path_dispatches_to_search_handler() {
        let mut req = request("GET", "/v1/search?title=roguelike");
        req.extensions_mut().insert(V1RequestContext {
            request_id: "gateway-request".into(),
            key: None,
        });
        let response = recording_app(Default::default())
            .oneshot(req)
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["x-request-id"], "gateway-request");
        let result = body(response).await;
        assert!(result["data"].is_array());
        assert_eq!(result["meta"]["pagination"]["limit"], 20);
    }

    #[tokio::test]
    async fn cached_query_count_uses_regional_mongo_facets_and_bad_cache_is_not_found() {
        let cache_values=std::sync::Arc::new(Mutex::new(HashMap::from([
            ("known".into(),r#"{"title":"Test Game","offerType":"BASE_GAME","tags":["tag1"],"price":{"min":2,"max":50},"pastGiveaways":true}"#.into()),
            ("broken".into(),"{".into()),
        ])));
        let pipeline = RecordedAggregate::default();
        let mut state = test_app_state(ApiConfig::default());
        state.saved_queries = std::sync::Arc::new(OracleCache {
            store: cache_values,
            ..Default::default()
        });
        state.mongo = std::sync::Arc::new(AggregateRecorder {
            aggregates: pipeline.clone(),
            ..Default::default()
        });
        let app = route_group("/v1").router.with_state(state);
        let response = app
            .clone()
            .oneshot(request("GET", "/v1/search/known/count?country=DE"))
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let result = body(response).await["data"].clone();
        assert_eq!(result["total"], 2);
        assert_eq!(result["tagCounts"][0]["_id"], "tag1");
        assert_eq!(result["priceRange"]["currency"], "EUR");
        let captured = pipeline.lock().await.last().cloned().unwrap();
        assert_eq!(captured.0, "offers");
        let query = serde_json::to_value(captured.1).unwrap().to_string();
        assert!(query.contains("EURO"));
        assert!(query.contains("pricev2"));
        assert!(query.contains("freegames"));
        assert!(query.contains("tagCounts"));
        let missing = app
            .oneshot(request("GET", "/v1/search/broken/count"))
            .await
            .unwrap();
        assert_eq!(missing.status(), 404);
        assert_eq!(body(missing).await["code"], "SEARCH_QUERY_NOT_FOUND");
    }

    #[tokio::test]
    async fn offer_search_sends_regional_filters_and_search_after_cursor() {
        let calls = std::sync::Arc::new(Mutex::new(Vec::new()));
        let first = recording_app(calls.clone())
            .oneshot(request("GET", "/v1/multisearch/offers?query=rogue&country=DE&limit=1&onSale=true&priceMin=2&sortBy=priceAsc"))
            .await.unwrap();
        assert_eq!(first.status(), 200);
        let first_body = body(first).await;
        assert_eq!(first_body["data"].as_array().unwrap().len(), 1);
        assert_eq!(first_body["meta"]["pagination"]["hasMore"], true);
        let cursor = first_body["meta"]["pagination"]["nextCursor"]
            .as_str()
            .unwrap()
            .to_string();
        let sent = calls.lock().await;
        assert_eq!(sent[0].0, "egdata.offers");
        assert_eq!(sent[0].1["size"], 2);
        assert!(
            sent[0]
                .1
                .to_string()
                .contains("prices.EURO.price.discountPrice")
        );
        assert!(sent[0].1.to_string().contains("prices.EURO.price.discount"));
        drop(sent);

        let second = recording_app(calls.clone()).oneshot(request("GET", &format!("/v1/multisearch/offers?query=rogue&country=DE&limit=1&onSale=true&priceMin=2&sortBy=priceAsc&cursor={cursor}"))).await.unwrap();
        assert_eq!(second.status(), 200);
        let sent = calls.lock().await;
        assert_eq!(
            sent[1].1["search_after"],
            json!(["2026-01-02T00:00:00Z", "offer-a"])
        );
    }

    #[tokio::test]
    async fn search_v2_uses_its_own_query_facets_defaults_and_serialized_cards() {
        let calls = std::sync::Arc::new(Mutex::new(Vec::new()));
        let response = recording_app(calls.clone())
            .oneshot(request(
                "GET",
                "/v1/search?title=%20rogue%20&facets=minimal&country=DE",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let result = body(response).await;
        assert_eq!(result["data"][0]["id"], "offer-a");
        assert!(result["data"][0]["price"].is_object());
        assert_eq!(result["meta"]["pagination"]["limit"], 20);
        assert_eq!(result["meta"]["country"], "DE");
        let sent = calls.lock().await;
        assert_eq!(sent[0].0, "egdata.offers");
        let query = &sent[0].1;
        assert_eq!(
            query,
            &json!({
                "size": 21,
                "track_total_hits": true,
                "query": {"bool": {
                    "must": [{"bool": {"should": [
                        {"multi_match": {
                            "query": "rogue",
                            "fields": ["title^4", "title.synonym^3", "developerDisplayName^2", "publisherDisplayName^2", "tags.name", "description"],
                            "type": "best_fields",
                            "fuzziness": "AUTO",
                            "operator": "and"
                        }},
                        {"match_phrase": {"title": {"query": "rogue", "boost": 10, "slop": 2}}}
                    ], "minimum_should_match": 1}}],
                    "filter": []
                }},
                "sort": [
                    {"_score": {"order": "desc"}},
                    {"id.keyword": {"order": "asc", "missing": "_last"}}
                ],
                "aggregations": {
                    "offerType": {"terms": {"field": "offerType.keyword", "size": 100}},
                    "technologies": {"terms": {"field": "lastBuilds.technologies.technology.keyword", "size": 1000}},
                    "priceStats": {"stats": {"field": "prices.EURO.price.discountPrice"}}
                }
            })
        );
    }

    #[tokio::test]
    async fn natural_language_validates_body_and_uses_canonical_requested_locale() {
        let mut invalid = Request::builder()
            .method("POST")
            .uri("/v1/search/natural-language")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"query":"rpg","unknown":true}"#))
            .unwrap();
        invalid
            .headers_mut()
            .insert("x-request-id", "req_search_test".parse().unwrap());
        let response = app().oneshot(invalid).await.unwrap();
        assert_eq!(response.status(), 400);
        assert_eq!(body(response).await["code"], "INVALID_BODY");

        let request = Request::builder()
            .method("POST")
            .uri("/v1/search/natural-language?locale=de-de")
            .header("content-type", "application/json")
            .header("x-request-id", "req_search_test")
            .body(Body::from(r#"{"query":"  role playing  ","topK":2}"#))
            .unwrap();
        let response = app().oneshot(request).await.unwrap();
        assert_eq!(response.status(), 200);
        let result = body(response).await;
        assert_eq!(result["data"], json!([]));
        assert_eq!(result["meta"]["query"], "role playing");
        assert_eq!(result["meta"]["locale"], "de-DE");
        assert_eq!(result["meta"]["count"], 0);
    }

    #[tokio::test]
    async fn search_v2_normalizes_filter_binding_and_uses_node_cache_key() {
        let calls = std::sync::Arc::new(Mutex::new(Vec::new()));
        let cache_values = std::sync::Arc::new(Mutex::new(HashMap::new()));
        let mut state = test_app_state(ApiConfig::default());
        state.opensearch = std::sync::Arc::new(SearchRecorder(calls.clone()));
        state.cache = std::sync::Arc::new(OracleCache {
            store: cache_values.clone(),
            ..Default::default()
        });
        let app = route_group("/v1").router.with_state(state.clone());
        let response = app
            .clone()
            .oneshot(request(
                "GET",
                "/v1/search?limit=1&sortDir=asc&tags=b,a,a&priceMin=2&facets=none",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let result = body(response).await;
        assert_eq!(result["meta"]["pagination"]["hasMore"], true);
        let token = result["meta"]["pagination"]["nextCursor"].as_str().unwrap();
        let binding = CursorBinding {
            operation: "search.offers".into(),
            filters: Some(BTreeMap::from([
                ("title".into(), Value::Null),
                ("offerType".into(), Value::Null),
                ("tags".into(), json!(["a", "b"])),
                ("categories".into(), json!([])),
                ("customAttributes".into(), json!([])),
                ("technologies".into(), json!([])),
                ("seller".into(), Value::Null),
                ("developerDisplayName".into(), Value::Null),
                ("publisherDisplayName".into(), Value::Null),
                ("refundType".into(), Value::Null),
                ("isCodeRedemptionOnly".into(), Value::Null),
                ("excludeBlockchain".into(), Value::Null),
                ("onSale".into(), Value::Null),
                ("pastGiveaways".into(), Value::Null),
                ("isLowestPrice".into(), Value::Null),
                ("isLowestPriceEver".into(), Value::Null),
                ("price".into(), json!({"min":2})),
            ])),
            ordering: "lastModifiedDate:desc,id:asc".into(),
            country: "US".into(),
            locale: "en-US".into(),
            limit: 1,
        };
        assert!(
            decode_cursor_with(
                token,
                &binding,
                cursor_secret(&state).as_deref(),
                chrono::Utc::now().timestamp_millis()
            )
            .is_ok()
        );
        let search_body = calls.lock().await[0].1.clone();
        assert_eq!(search_body["sort"][0]["lastModifiedDate"]["order"], "desc");
        assert_eq!(
            search_body["sort"][0]["lastModifiedDate"]["missing"],
            "_last"
        );
        assert_eq!(
            search_body["query"]["bool"]["filter"][0]["terms_set"]["tags.id.keyword"]["terms"],
            json!(["a", "b"])
        );
        assert_eq!(
            search_body["query"]["bool"]["filter"][1]["range"]["prices.US.price.discountPrice"],
            json!({"gte":2})
        );
        let key = cache_values.lock().await.keys().next().cloned().unwrap();
        assert!(key.starts_with("v1:search.offers:"));
        assert!(key.contains(r#""tags":["a","b"]"#));
        assert!(key.contains(r#""price":{"min":2}"#));
        let response = app
            .oneshot(request(
                "GET",
                "/v1/search?limit=1&sortDir=asc&tags=b,a,a&priceMin=2&facets=none",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(calls.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn search_v2_reads_the_literal_node_cache_payload_without_searching() {
        let calls = std::sync::Arc::new(Mutex::new(Vec::new()));
        let filters = json!({
            "title": null, "offerType": null, "tags": [], "categories": [],
            "customAttributes": [], "technologies": [], "seller": null,
            "developerDisplayName": null, "publisherDisplayName": null,
            "refundType": null, "isCodeRedemptionOnly": null,
            "excludeBlockchain": null, "onSale": null, "pastGiveaways": null,
            "isLowestPrice": null, "isLowestPriceEver": null, "price": null
        });
        let parts = BTreeMap::from([
            ("region", json!("US")),
            ("locale", json!("en-US")),
            ("limit", json!(20)),
            ("cursor", Value::Null),
            ("filters", filters),
            ("ordering", json!("lastModifiedDate:desc,id:asc")),
            ("facets", json!("none")),
            ("fields", json!("full")),
        ]);
        let key = v1_cache_key("search.offers", &parts);
        let node_payload = r#"{"offers":[{"id":"cached-offer","price":null}],"pagination":{"limit":20,"hasMore":false,"nextCursor":null},"facets":{"offerType":{"buckets":[]}},"result":{"tookMs":17,"timedOut":false}}"#;
        let cache_values =
            std::sync::Arc::new(Mutex::new(HashMap::from([(key, node_payload.into())])));
        let mut state = test_app_state(ApiConfig::default());
        state.opensearch = std::sync::Arc::new(SearchRecorder(calls.clone()));
        state.cache = std::sync::Arc::new(OracleCache {
            store: cache_values.clone(),
            ..Default::default()
        });
        let response = route_group("/v1")
            .router
            .with_state(state)
            .oneshot(request("GET", "/v1/search"))
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let result = body(response).await;
        assert_eq!(result["data"][0]["id"], "cached-offer");
        assert_eq!(result["meta"]["pagination"]["limit"], 20);
        assert_eq!(result["meta"]["facets"]["offerType"]["buckets"], json!([]));
        assert_eq!(result["meta"]["result"]["tookMs"], 17);
        assert!(calls.lock().await.is_empty());
        assert_eq!(cache_values.lock().await.len(), 1);
    }
}
