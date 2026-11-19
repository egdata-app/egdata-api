//! Offer listing, discovery, detail and read-only bulk operations.
//! Parity source: `src/v1/routes/offers.ts` and `src/v1/services/offers.ts`.
pub use egdata_http_core::shared::offers::*;

use super::catalog_list::{PageRead, counted_page};
use super::{
    RouteGroup,
    helpers::{
        V1RequestContext, json_envelope_response, parse_strict_query_uri, problem_response,
        v1_cache_get, v1_cache_key, v1_cache_set,
    },
    system::{
        cursor_date_bson, cursor_scalar_bson, doc_to_json, docs_to_json, internal_error,
        localize_offers,
    },
};
use crate::state::AppState;
use axum::{
    body::to_bytes,
    extract::{Path, Request, State},
    http::{Uri, header},
    response::Response,
};
use bson::{Bson, doc};
use egdata_core::v1::serialization::js_string;
use egdata_core::{ports::MongoFindOptions, v1::*};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    future::Future,
};

#[derive(Clone, Copy)]
enum ListKind {
    All,
    Upcoming,
    Released,
}

enum Operation {
    List(ListKind),
    Detail(String),
    Events,
    Event(String),
    Genres,
    Top(&'static str),
    Featured,
    Achievements,
    Slugs,
    Exists,
}

pub fn route_group(prefix: &str) -> RouteGroup {
    RouteGroup::new(prefix)
        .get("/offers", |State(s), r| {
            dispatch(s, r, Operation::List(ListKind::All))
        })
        .get("/offers/events", |State(s), r| {
            dispatch(s, r, Operation::Events)
        })
        .get(
            "/offers/events/{id}",
            |State(s), Path(id): Path<String>, r| dispatch(s, r, Operation::Event(id)),
        )
        .get("/offers/upcoming", |State(s), r| {
            dispatch(s, r, Operation::List(ListKind::Upcoming))
        })
        .get("/offers/latest-released", |State(s), r| {
            dispatch(s, r, Operation::List(ListKind::Released))
        })
        .get("/offers/genres", |State(s), r| {
            dispatch(s, r, Operation::Genres)
        })
        .get("/offers/top-wishlisted", |State(s), r| {
            dispatch(s, r, Operation::Top("top-wishlisted"))
        })
        .get("/offers/top-sellers", |State(s), r| {
            dispatch(s, r, Operation::Top("top-sellers"))
        })
        .get("/offers/featured-discounts", |State(s), r| {
            dispatch(s, r, Operation::Featured)
        })
        .get("/offers/latest-achievements", |State(s), r| {
            dispatch(s, r, Operation::Achievements)
        })
        .post("/offers/slugs", |State(s), r| {
            dispatch(s, r, Operation::Slugs)
        })
        .post("/offers/exists", |State(s), r| {
            dispatch(s, r, Operation::Exists)
        })
        .get("/offers/{id}", |State(s), Path(id): Path<String>, r| {
            dispatch(s, r, Operation::Detail(id))
        })
}

async fn dispatch(state: AppState, request: Request, op: Operation) -> Response {
    let method = request.method().clone();
    let uri = request.uri().clone();
    let id = request
        .extensions()
        .get::<V1RequestContext>()
        .map(|c| c.request_id.clone())
        .unwrap_or_default();
    let result = match op {
        Operation::Slugs | Operation::Exists => {
            bulk(&state, request, matches!(op, Operation::Slugs)).await
        }
        _ => get(&state, &uri, op).await,
    };
    match result {
        Ok((data, meta)) => {
            let mut envelope = Map::new();
            if let Some(data) = data {
                envelope.insert("data".into(), data);
            }
            envelope.insert("meta".into(), meta);
            json_envelope_response(&method, uri.path(), &id, Value::Object(envelope))
        }
        Err(error) => problem_response(&error, uri.path(), Some(&id)),
    }
}

type Payload = Result<(Option<Value>, Value), ProblemError>;
const LIST_KEYS: &[&str] = &["limit", "cursor", "country", "locale"];

async fn get(state: &AppState, uri: &Uri, op: Operation) -> Payload {
    let keys: &[&str] = match op {
        Operation::Events => &[],
        Operation::Genres => &["locale"],
        Operation::Top(_) => &["locale", "limit", "cursor"],
        Operation::Detail(_) | Operation::Featured | Operation::Achievements => {
            &["country", "locale"]
        }
        _ => LIST_KEYS,
    };
    let query = parse_strict_query_uri(uri, keys)?;
    let region = regional_params(
        query.get("country").map(String::as_str),
        query.get("locale").map(String::as_str),
    )?;
    match op {
        Operation::List(kind) => list(state, &query, &region, kind).await,
        Operation::Detail(id) => detail(state, &region, &id).await,
        Operation::Events => {
            let events = find(
                state,
                "tags",
                doc! {"groupName":"event", "status":"ACTIVE"},
                MongoFindOptions::default(),
            )
            .await?;
            Ok((Some(json!(events)), json!({"count": events.len()})))
        }
        Operation::Event(id) => event(state, &query, &region, &id).await,
        Operation::Genres => genres(state, &region.locale).await,
        Operation::Top(collection) => top(state, &query, &region, collection).await,
        Operation::Featured => featured(state, &region).await,
        Operation::Achievements => achievements(state, &region).await,
        Operation::Slugs | Operation::Exists => unreachable!("bulk dispatched separately"),
    }
}


pub(super) async fn cached<F, Fut>(
    state: &AppState,
    operation: &str,
    parts: BTreeMap<&str, Value>,
    ttl: u64,
    loader: F,
) -> Result<Value, ProblemError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Value, ProblemError>>,
{
    let key = v1_cache_key(operation, &parts);
    if let Some(value) = v1_cache_get(state.cache.as_ref(), &key).await {
        return Ok(value);
    }
    let value = loader().await?;
    v1_cache_set(state.cache.as_ref(), &key, &value, ttl).await;
    Ok(value)
}

pub(super) fn regional_meta(region: &RegionalParams) -> Value {
    json!({"country": region.country, "region": region.region, "locale": region.locale})
}

pub(super) fn ordered(raw: &Value) -> Value {
    ordered_with_attributes(raw, attributes_to_object(&raw["customAttributes"]))
}




fn id(value: &Value, field: &str) -> String {
    string_id(&value[field]).as_str().unwrap_or("").to_owned()
}

pub(super) async fn prices(
    state: &AppState,
    rows: &[Value],
    region: &str,
) -> Result<HashMap<String, Value>, ProblemError> {
    let ids: Vec<_> = rows.iter().map(|row| id(row, "id")).collect();
    prices_by_ids(state, &ids, region).await
}

pub(super) async fn prices_by_ids(
    state: &AppState,
    ids: &[String],
    region: &str,
) -> Result<HashMap<String, Value>, ProblemError> {
    let rows = find(
        state,
        "pricev2",
        doc! {"offerId":{"$in":ids},"region":region},
        MongoFindOptions::default(),
    )
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| (id(&row, "offerId"), row))
        .collect())
}

pub(super) async fn localized_with_prices(
    state: &AppState,
    rows: &[Value],
    prices: &HashMap<String, Value>,
    locale: &str,
) -> Result<Vec<Value>, ProblemError> {
    let ordered: Vec<_> = rows
        .iter()
        .map(|row| {
            let mut offer = checked_ordered(row)?;
            offer["price"] = prices.get(&id(row, "id")).cloned().unwrap_or(Value::Null);
            Ok(offer)
        })
        .collect::<Result<_, ProblemError>>()?;
    localize_offers(state, &ordered, locale).await
}

pub(super) fn serialized(rows: &[Value]) -> Vec<Value> {
    rows.iter()
        .map(|row| serialize_offer(row, row.get("price"), true))
        .collect()
}

pub(super) fn binding(
    operation: &str,
    filters: BTreeMap<String, Value>,
    ordering: &str,
    region: &RegionalParams,
    limit: u32,
) -> CursorBinding {
    CursorBinding {
        operation: operation.into(),
        filters: Some(filters),
        ordering: ordering.into(),
        country: region.country.clone(),
        locale: region.locale.clone(),
        limit,
    }
}

pub(super) fn decode(
    state: &AppState,
    page: &Pagination,
    binding: &CursorBinding,
) -> Result<Option<CursorSortTuple>, ProblemError> {
    page.cursor
        .as_ref()
        .map(|cursor| {
            decode_cursor_with(
                cursor,
                binding,
                state.config.v1_cursor_secret.as_deref(),
                (state.now)().timestamp_millis(),
            )
        })
        .transpose()
}

pub(super) fn pagination(
    state: &AppState,
    binding: &CursorBinding,
    has_more: bool,
    tuple: CursorSortTuple,
    total: Value,
) -> Result<Value, ProblemError> {
    let next = if has_more {
        Some(encode_cursor_with(
            binding,
            &tuple,
            state.config.v1_cursor_secret.as_deref(),
            (state.now)().timestamp_millis(),
        )?)
    } else {
        None
    };
    Ok(json!(
        page_meta(binding.limit, has_more, next).with_total(total)
    ))
}

pub(super) fn scalar(value: &Value) -> CursorSortValue {
    match value {
        Value::String(s) => s.clone().into(),
        Value::Number(n) => CursorSortValue::Number(n.clone()),
        _ => CursorSortValue::Null,
    }
}

fn date_sort(field: &str, direction: SortDirection) -> Vec<MongoSortField> {
    vec![
        MongoSortField::new(field, direction, NullsOrder::Last),
        MongoSortField::new("id", SortDirection::Asc, NullsOrder::Last),
    ]
}

async fn list(
    state: &AppState,
    query: &BTreeMap<String, String>,
    region: &RegionalParams,
    kind: ListKind,
) -> Payload {
    let (operation, field, direction, maximum) = match kind {
        ListKind::All => ("offers.list", "lastModifiedDate", SortDirection::Desc, 100),
        ListKind::Upcoming => ("offers.upcoming", "releaseDate", SortDirection::Asc, 50),
        ListKind::Released => (
            "offers.latest-released",
            "releaseDate",
            SortDirection::Desc,
            50,
        ),
    };
    let page = parse_pagination_map(query, maximum)?;
    let ordering = format!(
        "{field}:{},id:asc",
        if direction == SortDirection::Asc {
            "asc"
        } else {
            "desc"
        }
    );
    let binding = binding(operation, BTreeMap::new(), &ordering, region, page.limit);
    let sort = date_sort(field, direction);
    let mut parts = BTreeMap::from([
        ("region", json!(region.region)),
        ("locale", json!(region.locale)),
        ("limit", json!(page.limit)),
        ("cursor", json!(page.cursor)),
    ]);
    if matches!(kind, ListKind::All) {
        parts.insert("filters", json!({}));
    }
    let result = cached(state,operation,parts,60,|| async {
        let now = bson::DateTime::from_chrono((state.now)());
        let mut filter = match kind {
            ListKind::All => doc! {},
            ListKind::Upcoming => doc! {"releaseDate":{"$gt":now,"$ne":Bson::Null,"$lt":bson::DateTime::parse_rfc3339_str("2099-01-01T00:00:00Z").expect("fixed timestamp")},"offerType":{"$in":["BASE_GAME","DLC"]}},
            ListKind::Released => doc! {"effectiveDate":{"$lte":now},"offerType":{"$in":["BASE_GAME","DLC"]},"releaseDate":{"$ne":Bson::Null,"$lte":now}},
        };
        let base = filter.clone();
        if let Some(last) = decode(state,&page,&binding)? {
            let tuple: Vec<_> = last.iter().enumerate().map(|(i,v)| if i==0 {cursor_date_bson(v)} else {cursor_scalar_bson(v)}).collect();
            filter.extend(mongo_keyset_filter(&sort,&tuple)?);
        }
        let count_parts = if matches!(kind,ListKind::All) {vec![("filters",json!({}))]} else {vec![]};
        let (rows,total) = counted_page(state,operation,&count_parts,60,"offers",Some(base),
            PageRead::Find(filter,MongoFindOptions{sort:Some(mongo_sort_spec(&sort)),limit:Some(i64::from(page.limit)+1),..Default::default()})).await?;
        let trimmed = trim_page(rows,page.limit as usize);
        let prices = super::system::regional_offer_prices(state, &trimmed.items, &region.region).await?;
        let (offers, locale_meta) = super::system::serialize_priced_offers(state,&trimmed.items,&prices,&region.locale).await?;
        let mut tuple = Vec::new();
        if let Some(row) = trimmed.items.last().filter(|_| trimmed.has_more) {
            let row = doc_to_json(row.clone());
            let date = super::system::sitemap_date(row.get(field))?;
            let id = if matches!(kind, ListKind::All) {scalar(&row["id"])} else {offer_identifier(&row).into()};
            tuple = vec![scalar(&json!(date)), id];
        }
        let mut result = json!({"pagination":pagination(state,&binding,trimmed.has_more,tuple,total)?});
        if matches!(kind,ListKind::All) {
            result["offers"] = Value::Array(offers);
            result["localization"] = locale_meta;
            result["cacheTtl"] = json!(egdata_core::localization::get_localized_cache_ttl_seconds(&result["offers"],60));
        } else { result["elements"] = Value::Array(offers); }
        Ok(result)
    }).await?;
    let mut meta = regional_meta(region);
    let field = if matches!(kind, ListKind::All) {
        if result["localization"].is_null() {
            return Err(internal_error());
        }
        if let Some(localization) = result["localization"].as_object() {
            meta.as_object_mut().unwrap().extend(localization.clone());
        }
        "offers"
    } else {
        "elements"
    };
    copy_field(&result, &mut meta, "pagination");
    Ok((result.get(field).cloned(), meta))
}

fn copy_field(from: &Value, to: &mut Value, field: &str) {
    if let Some(value) = from.get(field) {
        to[field] = value.clone();
    }
}

// This service's whitelist takes precedence, exactly as offerCountryEligible in
// v1/services/offers.ts (the legacy pricing helper has a different policy).

pub(super) fn country_eligible(offer: &Value, country: &str) -> bool {
    if let Some(list) = offer["countriesWhitelist"]
        .as_array()
        .filter(|list| !list.is_empty())
    {
        return list.iter().any(|value| value == country);
    }
    !offer["countriesBlacklist"]
        .as_array()
        .is_some_and(|list| list.iter().any(|value| value == country))
}

pub(super) async fn current_price(
    state: &AppState,
    offer_id: impl Into<Bson>,
    region: &str,
) -> Result<Option<Value>, ProblemError> {
    state
        .mongo
        .find_one_with_options(
            "pricev2",
            doc! {"offerId":offer_id.into(),"region":region},
            MongoFindOptions {
                sort: Some(doc! {"updatedAt":-1}),
                ..Default::default()
            },
        )
        .await
        .map_err(|_| internal_error())?
        .map(super::offer_prices::serialize_stored_price)
        .transpose()
}

pub(super) async fn cached_detail(
    state: &AppState,
    region: &RegionalParams,
    offer_id: &str,
) -> Result<Value, ProblemError> {
    let parts = BTreeMap::from([
        ("id", json!(offer_id)),
        ("country", json!(region.country)),
        ("region", json!(region.region)),
        ("locale", json!(region.locale)),
    ]);
    let load = || async {
        let Some(raw) = state
            .mongo
            .find_one("offers", doc! {"id":offer_id}, None)
            .await
            .map_err(|_| internal_error())?
        else {
            return Ok(Value::Null);
        };
        let raw = doc_to_json(raw);
        let price = if country_eligible(&raw, &region.country) {
            current_price(state, offer_id, &region.region).await?
        } else {
            None
        };
        let localized = localize_offers(state, &[checked_ordered(&raw)?], &region.locale).await?;
        let offer = &localized[0];
        let mut serialized = serialize_offer(offer, None, true);
        serialized["price"] = price.unwrap_or(Value::Null);
        Ok(json!({
            "offer":serialized,
            "localization":localization_meta(Some(offer)),
            "cacheTtl":egdata_core::localization::get_localized_cache_ttl_seconds(offer,60)
        }))
    };
    cached(state, "offers.detail", parts, 60, load).await
}

async fn detail(state: &AppState, region: &RegionalParams, offer_id: &str) -> Payload {
    let result = cached_detail(state, region, offer_id).await?;
    if !super::system::js_truthy(&result) {
        return Err(not_found(
            "OFFER_NOT_FOUND",
            "No offer exists with this ID.",
        ));
    }
    let mut meta = json!({"country":region.country,"region":region.region});
    if let Some(localization) = result["localization"].as_object() {
        meta.as_object_mut().unwrap().extend(localization.clone());
    }
    Ok((result.get("offer").cloned(), meta))
}

async fn event(
    state: &AppState,
    query: &BTreeMap<String, String>,
    region: &RegionalParams,
    event_id: &str,
) -> Payload {
    let page = parse_pagination_map(query, 50)?;
    let binding = binding(
        "offers.event",
        BTreeMap::from([("event".into(), json!(event_id))]),
        "price.discount:desc,id:asc",
        region,
        page.limit,
    );
    let event = state
        .mongo
        .find_one("tags", doc! {"id":event_id,"groupName":"event"}, None)
        .await
        .map_err(|_| internal_error())?
        .ok_or_else(|| not_found("EVENT_NOT_FOUND", "No active event exists with this ID."))?;
    let parts = BTreeMap::from([
        ("id", json!(event_id)),
        ("region", json!(region.region)),
        ("locale", json!(region.locale)),
        ("limit", json!(page.limit)),
        ("cursor", json!(page.cursor)),
    ]);
    let result=cached(state,"offers.event",parts,60,||async {
        let mut pipeline=vec![doc!{"$match":{"tags":{"$elemMatch":{"id":event_id}}}},doc!{"$lookup":{"from":"pricev2","let":{"offerId":"$id"},"pipeline":[{"$match":{"$expr":{"$and":[{"$eq":["$offerId","$$offerId"]},{"$eq":["$region",&region.region]}]}}},{"$sort":{"updatedAt":-1}},{"$limit":1}],"as":"price"}},doc!{"$unwind":{"path":"$price","preserveNullAndEmptyArrays":true}},doc!{"$addFields":{"sortDiscount":{"$ifNull":["$price.price.discount",Bson::Null]}}}];
        if let Some(last)=decode(state,&page,&binding)? {
            let discount=last.first().map(cursor_scalar_bson).unwrap_or(Bson::Null);
            let last_id=last.get(1).and_then(CursorSortValue::as_str).unwrap_or("");
            let filter=if discount==Bson::Null {doc!{"sortDiscount":Bson::Null,"id":{"$gt":last_id}}} else {
                doc!{"$or":[{"sortDiscount":{"$lt":discount.clone()}},{"sortDiscount":discount,"id":{"$gt":last_id}},{"sortDiscount":Bson::Null}]}
            };
            pipeline.push(doc!{"$match":filter});
        }
        pipeline.push(doc!{"$sort":{"sortDiscount":-1,"id":1}});pipeline.push(doc!{"$limit":i64::from(page.limit)+1});
        let (rows,total)=counted_page(state,"offers.event",&[("id",json!(event_id))],60,"offers",Some(doc!{"tags":{"$elemMatch":{"id":event_id}}}),PageRead::Aggregate(pipeline)).await?;
        let rows=docs_to_json(rows);
        let trimmed=trim_page(rows,page.limit as usize);
        let price_map=trimmed.items.iter().map(|row|(id(row,"id"),row["price"].clone())).collect();
        let localized=localized_with_prices(state,&trimmed.items,&price_map,&region.locale).await?;
        let tuple=trimmed.items.last().map(|row|vec![scalar(&row["sortDiscount"]),id(row,"id").into()]).unwrap_or_default();
        Ok(json!({"elements":serialized(&localized),"pagination":pagination(state,&binding,trimmed.has_more,tuple,total)?,"title":doc_to_json(event).get("name").filter(|v|!v.is_null()).map(js_string).unwrap_or_default()}))
    }).await?;
    let mut meta = regional_meta(region);
    copy_field(&result, &mut meta, "title");
    copy_field(&result, &mut meta, "pagination");
    Ok((result.get("elements").cloned(), meta))
}

async fn genres(state: &AppState, locale: &str) -> Payload {
    let genres = find(
        state,
        "tags",
        doc! {"groupName":"genre","status":"ACTIVE"},
        MongoFindOptions::default(),
    )
    .await?;
    let mut results = Vec::new();
    for genre in &genres {
        let offers=find(state,"offers",doc!{"tags":{"$elemMatch":{"id":bson::to_bson(&genre["id"]).map_err(|_|internal_error())?}},"offerType":"BASE_GAME","releaseDate":{"$lte":bson::DateTime::from_chrono((state.now)())}},MongoFindOptions{limit:Some(3),sort:Some(doc!{"releaseDate":-1}),..Default::default()}).await?;
        let rows:Vec<_>=offers.iter().map(|offer| {
            let images=offer["keyImages"].as_array();
            let image=["OfferImageTall","Thumbnail","DieselGameBoxTall","DieselStoreFrontTall"].iter().find_map(|kind| images.and_then(|imgs|imgs.iter().find(|img|img["type"]==*kind)))
                .or_else(||images.and_then(|imgs|imgs.first())).cloned().unwrap_or(Value::Null);
            json!({"id":offer["id"],"namespace":offer["namespace"],"title":offer["title"],"image":image})
        }).collect();
        let mut localized = localize_offers(state, &rows, locale).await?;
        for row in &mut localized {
            row.as_object_mut().unwrap().shift_remove("namespace");
        }
        results.push(json!({"genre":genre,"offers":localized.iter().map(serialize_value).collect::<Vec<_>>()}));
    }
    Ok((
        Some(json!(results)),
        json!({"locale":locale,"count":results.len()}),
    ))
}

async fn top(
    state: &AppState,
    query: &BTreeMap<String, String>,
    region: &RegionalParams,
    collection: &str,
) -> Payload {
    let page = parse_pagination_map(query, 10)?;
    let operation = format!("offers.{collection}");
    let binding = binding(
        &operation,
        BTreeMap::from([("collectionId".into(), json!(collection))]),
        "position:asc,offerId:asc",
        region,
        page.limit,
    );
    let sort = vec![
        MongoSortField::new("position", SortDirection::Asc, NullsOrder::Last),
        MongoSortField::new("offerId", SortDirection::Asc, NullsOrder::Last),
    ];
    let parts = BTreeMap::from([
        ("locale", json!(region.locale)),
        ("limit", json!(page.limit)),
        ("cursor", json!(page.cursor)),
    ]);
    let result=cached(state,&operation,parts,300,||async {
        let mut filter=doc!{"collectionId":collection,"position":{"$gt":0}};
        let base=filter.clone();
        if let Some(last)=decode(state,&page,&binding)? {filter.extend(mongo_keyset_filter(&sort,&last.iter().map(cursor_scalar_bson).collect::<Vec<_>>())?);}
        let (positions,total)=counted_page(state,&operation,&[],300,"game_positions",Some(base),PageRead::Find(filter,MongoFindOptions{limit:Some(i64::from(page.limit)+1),sort:Some(mongo_sort_spec(&sort)),..Default::default()})).await?;
        let positions=docs_to_json(positions);
        let trimmed=trim_page(positions,page.limit as usize);
        let ids:Vec<_>=trimmed.items.iter().map(|row|id(row,"offerId")).collect();
        let offers=find(state,"offers",doc!{"id":{"$in":ids}},MongoFindOptions::default()).await?;
        let by_id:HashMap<_,_>=offers.iter().map(|row|(id(row,"id"),row)).collect();
        let positions:HashMap<_,_>=trimmed.items.iter().map(|row|(id(row,"offerId"),row["position"].clone())).collect();
        let rows:Vec<_>=trimmed.items.iter().filter_map(|pos|by_id.get(&id(pos,"offerId"))).map(|row|checked_ordered(row)).collect::<Result<_,_>>()?;
        let localized=localize_offers(state,&rows,&region.locale).await?;
        let elements:Vec<_>=localized.iter().map(|row|{let mut value=serialize_offer(row,None,true);value["position"]=positions.get(&id(row,"id")).cloned().unwrap_or(Value::Null);value}).collect();
        let tuple=trimmed.items.last().map(|row|vec![scalar(&row["position"]),id(row,"offerId").into()]).unwrap_or_default();
        Ok(json!({"elements":elements,"pagination":pagination(state,&binding,trimmed.has_more,tuple,total)?}))
    }).await?;
    let mut meta = json!({"locale": region.locale});
    copy_field(&result, &mut meta, "pagination");
    Ok((result.get("elements").cloned(), meta))
}

async fn featured(state: &AppState, region: &RegionalParams) -> Payload {
    let result=cached(state,"offers.featured-discounts",BTreeMap::from([("region",json!(region.region)),("locale",json!(region.locale))]),60,||async {
        let featured=find(state,"game_positions",doc!{"position":{"$gt":0}},MongoFindOptions{limit:Some(200),sort:Some(doc!{"position":1}),..Default::default()}).await?;
        if featured.is_empty(){return Ok(json!([]));}
        let ids:Vec<_>=featured.iter().map(|row|id(row,"offerId")).collect();
        let (offers,prices)=tokio::join!(find(state,"offers",doc!{"id":{"$in":&ids},"offerType":{"$in":["BASE_GAME","DLC"]}},MongoFindOptions::default()),find(state,"pricev2",doc!{"offerId":{"$in":&ids},"region":&region.region,"price.discount":{"$gt":0}},MongoFindOptions::default()));
        let prices:HashMap<_,_>=prices?.into_iter().map(|row|(id(&row,"offerId"),row)).collect();
        let positions:HashMap<_,_>=featured.iter().map(|row|(id(row,"offerId"),row["position"].clone())).collect();
        let mut matching:Vec<_>=offers?.into_iter().filter(|row|prices.contains_key(&id(row,"id"))&&positions.contains_key(&id(row,"id"))).collect();
        matching.sort_by(|a,b|positions[&id(a,"id")].as_f64().unwrap_or(0.0).total_cmp(&positions[&id(b,"id")].as_f64().unwrap_or(0.0)));matching.truncate(20);
        let localized=localized_with_prices(state,&matching,&prices,&region.locale).await?;
        Ok(json!(localized.iter().map(|row|{let mut value=serialize_offer(row,row.get("price"),true);value["position"]=positions[&id(row,"id")].clone();value}).collect::<Vec<_>>()))
    }).await?;
    counted(result, region)
}

async fn achievements(state: &AppState, region: &RegionalParams) -> Payload {
    let result=cached(state,"offers.latest-achievements",BTreeMap::from([("region",json!(region.region)),("locale",json!(region.locale))]),60,||async {
        let mut selected=Vec::new();let mut selected_achievements=Vec::new();let mut selected_prices=HashMap::new();
        for iteration in 0..10u64 {
            let offers=find(state,"offers",doc!{"offerType":{"$in":["BASE_GAME"]},"tags.id":"19847","effectiveDate":{"$lte":bson::DateTime::from_chrono((state.now)())}},MongoFindOptions{sort:Some(doc!{"effectiveDate":-1}),skip:Some(iteration*15),limit:Some(15),..Default::default()}).await?;
            let namespaces:Vec<_>=offers.iter().map(|row|id(row,"namespace")).collect();
            let (achievements,prices)=tokio::join!(find(state,"achievementsets",doc!{"sandboxId":{"$in":namespaces},"isBase":true},MongoFindOptions::default()),prices(state,&offers,&region.region));
            let achievements=achievements.unwrap_or_default();let prices=prices.unwrap_or_default();
            for offer in &offers {
                if let Some(achievement)=achievements.iter().find(|entry|entry["sandboxId"]==offer["namespace"]) {
                    selected.push(offer.clone());selected_achievements.push(achievement.clone());
                    if let Some(price)=prices.get(&id(offer,"id")){selected_prices.insert(id(offer,"id"),price.clone());}
                    if selected.len()>=20 {break;}
                }
            }
            if selected.len()>=20||offers.len()<15{break;}
        }
        let localized=localized_with_prices(state,&selected,&selected_prices,&region.locale).await?;
        Ok(json!(localized.iter().enumerate().map(|(i,row)|{let mut value=serialize_offer(row,row.get("price"),true);value["achievements"]=serialize_value(&selected_achievements[i]);value}).collect::<Vec<_>>()))
    }).await?;
    counted(result, region)
}

fn counted(result: Value, region: &RegionalParams) -> Payload {
    let mut meta = regional_meta(region);
    let length = match &result {
        Value::Array(rows) => Some(json!(rows.len())),
        Value::String(text) => Some(json!(text.encode_utf16().count())),
        value => value.get("length").cloned(),
    };
    if let Some(length) = length {
        meta["count"] = length;
    }
    Ok((Some(result), meta))
}

async fn bulk(state: &AppState, request: Request, slugs: bool) -> Payload {
    require_json_content_type(
        request
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|h| h.to_str().ok()),
    )?;
    // This endpoint has its own bounded array schema, matching readJsonBody; do
    // not inherit Axum Json's unrelated 2 MiB default rejection/envelope.
    let bytes = to_bytes(request.into_body(), usize::MAX)
        .await
        .map_err(|_| {
            ProblemError::new(400, "MALFORMED_JSON", "The request body is not valid JSON.")
        })?;
    let text = String::from_utf8_lossy(bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes));
    let (field, min, max, max_len, detail) = if slugs {
        (
            "slugs",
            1,
            100,
            300,
            "Provide `slugs` as an array of 1-100 non-empty strings.",
        )
    } else {
        (
            "offers",
            0,
            200,
            100,
            "Provide `offers` as an array of up to 200 non-empty strings.",
        )
    };
    let invalid = || ProblemError::new(400, "INVALID_BODY", detail);
    // RawValue validates JSON syntax without narrowing its numbers to f64. A
    // syntactically valid overflowing number is a schema error, as in JSON.parse.
    let raw: &serde_json::value::RawValue = serde_json::from_str(&text).map_err(|_| {
        ProblemError::new(400, "MALFORMED_JSON", "The request body is not valid JSON.")
    })?;
    let mut object: BTreeMap<String, &serde_json::value::RawValue> =
        serde_json::from_str(raw.get()).map_err(|_| invalid())?;
    if object.len() != 1 {
        return Err(invalid());
    }
    let field = object.remove(field).ok_or_else(invalid)?;
    let values: Vec<String> = serde_json::from_str(field.get()).map_err(|_| invalid())?;
    if !(min..=max).contains(&values.len()) {
        return Err(invalid());
    }
    let mut ids = Vec::with_capacity(values.len());
    for value in &values {
        let value = trim_js_whitespace(value);
        if value.is_empty() || value.encode_utf16().count() > max_len {
            return Err(invalid());
        }
        ids.push(value.to_owned());
    }
    if slugs {
        return resolve_slugs(state, ids).await;
    }
    let mut seen = HashSet::new();
    ids.retain(|id| seen.insert(id.clone()));
    let existing = find(
        state,
        "offers",
        doc! {"id":{"$in":&ids}},
        MongoFindOptions {
            projection: Some(doc! {"id":1,"_id":0}),
            ..Default::default()
        },
    )
    .await?;
    let existing: HashSet<_> = existing.iter().map(offer_identifier).collect();
    Ok((
        Some(
            json!({"existingOffers":ids.iter().filter(|id|existing.contains(*id)).collect::<Vec<_>>(),"nonExistingOffers":ids.iter().filter(|id|!existing.contains(*id)).collect::<Vec<_>>()}),
        ),
        json!({"requested":ids.len(),"existing":existing.len()}),
    ))
}



fn matches_slug(offer: &Value, slug: &str, home: &str) -> Result<bool, ProblemError> {
    let matches = |value: &Value| value == slug || value == home;
    if matches(&offer["productSlug"]) || matches(&offer["urlSlug"]) {
        return Ok(true);
    }
    for field in ["offerMappings", "customAttributes"] {
        let entries = &offer[field];
        if entries.is_null() {
            continue;
        }
        let entries = entries.as_array().ok_or_else(internal_error)?;
        for entry in entries {
            if entry.is_null() {
                return Err(internal_error());
            }
            let matched = if field == "offerMappings" {
                matches(&entry["pageSlug"])
            } else {
                matches!(
                    entry["key"].as_str(),
                    Some("slug" | "com.epicgames.app.productSlug")
                ) && matches(&entry["value"])
            };
            if matched {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

async fn resolve_slugs(state: &AppState, slugs: Vec<String>) -> Payload {
    let expanded: Vec<_> = slugs
        .iter()
        .flat_map(|slug| {
            [
                Bson::String(slug.clone()),
                Bson::String(format!("{slug}/home")),
            ]
        })
        .collect();
    let offers = slug_candidates(state, &expanded).await?;
    let mut elements = Vec::with_capacity(slugs.len());
    let mut found = 0;
    for slug in &slugs {
        let home = format!("{slug}/home");
        let mut element = json!({"slug":slug,"id":null,"namespace":null});
        for candidate in &offers {
            if matches_slug(candidate, slug, &home)? {
                element["id"] = json!(offer_identifier(candidate));
                element["namespace"] = candidate["namespace"].clone();
                found += 1;
                break;
            }
        }
        elements.push(element);
    }
    Ok((
        Some(Value::Array(elements)),
        json!({"found":found,"requested":slugs.len()}),
    ))
}

#[cfg(test)]
#[path = "offers_tests.rs"]
mod tests;
