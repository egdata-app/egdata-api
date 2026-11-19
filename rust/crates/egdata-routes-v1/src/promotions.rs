//! Promotions, regional offer pages and localized covers.
use super::{
    RouteGroup,
    helpers::{
        parse_strict_query_uri, parse_validated_query, read_envelope_response, read_response,
    },
    offers,
    system::{
        cached_length, internal_error, localize_ordered_rows, serialize_stored_localized_offer,
        stored_string_key,
    },
};
use crate::state::AppState;
use axum::{
    extract::{Path, Request, State},
    http::Uri,
};
use bson::{Bson, Document, doc};
use egdata_core::{ports::MongoFindOptions, v1::*};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub fn route_group(prefix: &str) -> RouteGroup {
    RouteGroup::new(prefix)
        .get("/promotions", |State(state), req: Request| async move {
            let result = list(&state, req.uri()).await;
            read_response(&req, result)
        })
        .get(
            "/promotions/{id}",
            |State(state), Path(id): Path<String>, req: Request| async move {
                let result = promotion(&state, req.uri(), &id).await;
                read_envelope_response(&req, result)
            },
        )
        .get(
            "/promotions/{id}/cover",
            |State(state), Path(id): Path<String>, req: Request| async move {
                let result = cover(&state, req.uri(), &id).await;
                read_response(&req, result)
            },
        )
}

type Payload = Result<(Value, Value), ProblemError>;

async fn list(state: &AppState, uri: &Uri) -> Payload {
    let query = parse_strict_query_uri(uri, &["limit"])?;
    let limit = parse_limit(query.get("limit").map(String::as_str), 100)?;
    let data = offers::cached(
        state,
        "promotions.list",
        BTreeMap::from([("limit", json!(limit))]),
        300,
        || async {
            Ok(json!(
                offers::find(
                    state,
                    "tags",
                    doc! {"groupName":"event","status":"ACTIVE"},
                    MongoFindOptions {
                        limit: Some(limit.into()),
                        sort: Some(doc! {"referenceCount":-1}),
                        ..Default::default()
                    }
                )
                .await?
            ))
        },
    )
    .await?;
    let mut meta = json!({});
    if let Some(count) = cached_length(&data) {
        meta["count"] = count;
    }
    meta["limit"] = limit.into();
    Ok((data, meta))
}

const SORT_FIELDS: &[&str] = &[
    "releaseDate",
    "lastModifiedDate",
    "effectiveDate",
    "creationDate",
    "viewableDate",
    "pcReleaseDate",
    "upcoming",
    "price",
];

fn search_filter(id: &str, q: Option<&str>) -> Document {
    let mut filter = doc! {"tags":{"$elemMatch":{"id":id}}};
    if let Some(q) = q {
        let mut pattern = String::new();
        for ch in q.chars() {
            if r".*+?^${}()|[]\".contains(ch) {
                pattern.push('\\');
            }
            pattern.push(ch);
        }
        filter.insert("title", doc! {"$regex":pattern,"$options":"i"});
    }
    filter
}

fn price_base(filter: Document, region: &str) -> Vec<Document> {
    vec![
        doc! {"$match":filter},
        doc! {"$lookup":{"from":"pricev2","let":{"offerId":"$id"},"pipeline":[{"$match":{"$expr":{"$and":[{"$eq":["$offerId","$$offerId"]},{"$eq":["$region",region]}]}}},{"$sort":{"updatedAt":-1}},{"$limit":1}],"as":"priceDoc"}},
        doc! {"$unwind":"$priceDoc"},
        doc! {"$addFields":{"_priceSort":{"$ifNull":["$priceDoc.price.discountPrice",Bson::Null]}}},
        doc! {"$addFields":{"_priceNull":{"$cond":[{"$eq":["$_priceSort",Bson::Null]},1,0]}}},
    ]
}
fn price_pipeline(
    mut pipeline: Vec<Document>,
    direction: SortDirection,
    last: Option<&[Value]>,
    limit: i64,
) -> Vec<Document> {
    let sort = [
        MongoSortField::new("_priceNull", SortDirection::Asc, NullsOrder::Last),
        MongoSortField::new("_priceSort", direction, NullsOrder::Last),
        MongoSortField::new("id", SortDirection::Asc, NullsOrder::Last),
    ];
    if let Some(tuple) = last {
        let price = tuple.first().map(cursor_bson).unwrap_or(Bson::Null);
        let id = tuple
            .get(1)
            .filter(|v| !v.is_null())
            .map(serialization::js_string)
            .unwrap_or_default();
        let after = mongo_keyset_filter(
            &sort,
            &[
                Bson::Int32(i32::from(price == Bson::Null)),
                price,
                Bson::String(id),
            ],
        )
        .expect("three price sort fields and cursor values");
        pipeline.push(doc! {"$match":after});
    }
    pipeline.extend([doc! {"$sort":mongo_sort_spec(&sort)}, doc! {"$limit":limit}]);
    pipeline
}

// Cursors carry JSON, so Extended JSON-looking objects in a signed tuple
// remain plain Mongo documents instead of becoming a new BSON scalar.
fn cursor_bson(value: &Value) -> Bson {
    match value {
        Value::Object(fields) => Bson::Document(
            fields
                .iter()
                .map(|(key, v)| (key.clone(), cursor_bson(v)))
                .collect(),
        ),
        Value::Array(values) => Bson::Array(values.iter().map(cursor_bson).collect()),
        _ => bson::to_bson(value).expect("JSON scalar"),
    }
}

fn sort_value(row: &Document, field: &str) -> Result<Value, ProblemError> {
    let value = row.get(if field == "price" {
        "_priceSort"
    } else {
        field
    });
    if field == "price" {
        return Ok(value
            .map(egdata_infra::bson_json::bson_to_js_json)
            .unwrap_or(Value::Null));
    }
    if field == "upcoming" {
        return Ok(value.and_then(Bson::as_bool).map(i32::from).into());
    }
    Ok(match value {
        None | Some(Bson::Null | Bson::Undefined) => Value::Null,
        Some(Bson::DateTime(date)) => serialization::js_iso_millis(date.timestamp_millis())
            .ok_or_else(internal_error)?
            .into(),
        Some(Bson::String(s) | Bson::Symbol(s)) => serialization::parse_stored_timestamp(s)
            .map(serialization::js_iso_datetime)
            .unwrap_or_else(|| s.clone())
            .into(),
        Some(v @ Bson::Int32(_) | v @ Bson::Double(_)) => {
            egdata_infra::bson_json::bson_to_js_json(v)
        }
        Some(v @ Bson::Int64(n)) if n.unsigned_abs() <= 1 << 53 => {
            egdata_infra::bson_json::bson_to_js_json(v)
        }
        Some(v) => stored_string_key(Some(v))?.into(),
    })
}

async fn promotion(state: &AppState, uri: &Uri, raw: &str) -> Result<Value, ProblemError> {
    let id = require_id_param(Some(raw), "id")?;
    let query = parse_validated_query(
        uri,
        &[
            "q", "sortBy", "sortDir", "country", "locale", "limit", "cursor",
        ],
        |params| {
            super::helpers::search_query_issues(
                params,
                "q",
                &[("sortBy", SORT_FIELDS), ("sortDir", &["asc", "desc"])],
            )
        },
    )?;
    let region = regional_params(
        query.get("country").map(String::as_str),
        query.get("locale").map(String::as_str),
    )?;
    let page = parse_pagination_map(&query, 50)?;
    let q = query
        .get("q")
        .map(|v| trim_js_whitespace(v))
        .filter(|v| !v.is_empty());
    let field = query
        .get("sortBy")
        .map(String::as_str)
        .unwrap_or("lastModifiedDate");
    let dir = query.get("sortDir").map(String::as_str).unwrap_or("desc");
    let direction = if dir == "asc" {
        SortDirection::Asc
    } else {
        SortDirection::Desc
    };
    let event = state
        .mongo
        .find_one("tags", doc! {"id":&id}, None)
        .await
        .map_err(|_| internal_error())?
        .ok_or_else(|| not_found("PROMOTION_NOT_FOUND", "No promotion exists with this ID."))?;
    let binding = offers::binding(
        "promotions.offers",
        BTreeMap::from([("id".into(), json!(id)), ("q".into(), json!(q))]),
        &format!("{field}:{dir},id:asc"),
        &region,
        page.limit,
    );
    let parts = BTreeMap::from([
        ("id", json!(id)),
        ("region", json!(region.region)),
        ("locale", json!(region.locale)),
        ("limit", json!(page.limit)),
        ("cursor", json!(page.cursor)),
        ("q", json!(q)),
        ("sortBy", json!(field)),
        ("sortDir", json!(dir)),
    ]);
    let load_page = || async {
        let last = page
            .cursor
            .as_deref()
            .map(|raw| {
                cursor::decode_search_cursor(
                    raw,
                    &binding,
                    state.config.v1_cursor_secret.as_deref(),
                    (state.now)().timestamp_millis(),
                )
            })
            .transpose()?;
        let limit = i64::from(page.limit) + 1;
        let mut filter = search_filter(&id, q);
        let (rows, total) = if field == "price" {
            let base = price_base(filter, &region.region);
            let pipeline = price_pipeline(base.clone(), direction, last.as_deref(), limit);
            let parts = [
                ("id", json!(id)),
                ("q", json!(q)),
                ("region", json!(region.region)),
                ("sortBy", json!("price")),
            ];
            tokio::join!(
                state.mongo.aggregate("offers", pipeline),
                super::counts::aggregate(state, "promotions.offers", &parts, 60, "offers", base)
            )
        } else {
            let nulls = if dir == "asc" {
                NullsOrder::First
            } else {
                NullsOrder::Last
            };
            let sort = [
                MongoSortField::new(field, direction, nulls),
                MongoSortField::new("id", SortDirection::Asc, NullsOrder::Last),
            ];
            let base = filter.clone();
            if let Some(last) = &last {
                let first = match last.first() {
                    None | Some(Value::Null) => Bson::Null,
                    Some(v) if field == "upcoming" => Bson::Boolean(super::system::js_truthy(v)),
                    Some(Value::String(s)) => Bson::DateTime(
                        serialization::parse_stored_timestamp(s)
                            .map(bson::DateTime::from_chrono)
                            .unwrap_or_else(|| bson::DateTime::from_millis(0)),
                    ),
                    Some(v) => cursor_bson(v),
                };
                filter.extend(
                    mongo_keyset_filter(
                        &sort,
                        &[first, last.get(1).map(cursor_bson).unwrap_or(Bson::Null)],
                    )
                    .expect("two promotion sort fields and cursor values"),
                );
            }
            let parts = [
                ("id", json!(id)),
                ("q", json!(q)),
                ("sortBy", json!("default")),
            ];
            tokio::join!(
                state.mongo.find_many(
                    "offers",
                    filter,
                    MongoFindOptions {
                        sort: Some(mongo_sort_spec(&sort)),
                        limit: Some(limit),
                        ..Default::default()
                    },
                ),
                super::counts::documents(state, "promotions.offers", &parts, 60, "offers", base)
            )
        };
        let rows = rows.map_err(|_| internal_error())?;
        let total = total?;
        let rows = trim_page(rows, page.limit as usize);
        let keys = rows
            .items
            .iter()
            .map(|row| stored_string_key(row.get("id")))
            .collect::<Result<Vec<_>, _>>()?;
        let ids: Vec<_> = rows
            .items
            .iter()
            .zip(&keys)
            .map(|(row, key)| match row.get("id") {
                None | Some(Bson::Null | Bson::Undefined) => "",
                _ => key.as_str(),
            })
            .collect();
        let prices = state
            .mongo
            .find_many(
                "pricev2",
                doc! {"offerId":{"$in":ids},"region":&region.region},
                Default::default(),
            )
            .await
            .map_err(|_| internal_error())?;
        let mut by_id = BTreeMap::new();
        for price in &prices {
            by_id.insert(stored_string_key(price.get("offerId"))?, price);
        }
        let localized = localize_ordered_rows(state, &rows.items, &region.locale).await?;
        let data = rows
            .items
            .iter()
            .zip(&localized)
            .zip(&keys)
            .map(|((row, localized), key)| {
                let nested = (field == "price").then(|| row.get("priceDoc")).flatten();
                let price = match nested {
                    None | Some(Bson::Null | Bson::Undefined) => by_id.get(key).copied().cloned(),
                    Some(Bson::Document(price)) => Some(price.clone()),
                    // Node tests membership of amount fields with the JS 'in' operator.
                    Some(
                        Bson::String(_)
                        | Bson::Symbol(_)
                        | Bson::Double(_)
                        | Bson::Int32(_)
                        | Bson::Boolean(_),
                    ) => return Err(internal_error()),
                    Some(Bson::Int64(n)) if n.unsigned_abs() <= 1 << 53 => {
                        return Err(internal_error());
                    }
                    Some(Bson::Array(entries)) => Some(
                        entries
                            .iter()
                            .enumerate()
                            .map(|(i, v)| (i.to_string(), v.clone()))
                            .collect(),
                    ),
                    Some(Bson::ObjectId(id)) => {
                        let buffer: Document = id
                            .bytes()
                            .into_iter()
                            .enumerate()
                            .map(|(i, b)| (i.to_string(), i32::from(b).into()))
                            .collect();
                        Some(doc! {"buffer":buffer})
                    }
                    Some(object) => Some(
                        bson::to_document(&bson_to_serialized_json(object)).unwrap_or_default(),
                    ),
                };
                serialize_stored_localized_offer(row, localized, price)
            })
            .collect::<Result<Vec<_>, ProblemError>>()?;
        let next = if let Some(last) = rows.items.last().filter(|_| rows.has_more) {
            let tuple = [
                sort_value(last, field)?,
                Value::String(keys.last().unwrap().clone()),
            ];
            Some(cursor::encode_search_cursor(
                &binding,
                &tuple,
                state.config.v1_cursor_secret.as_deref(),
                (state.now)().timestamp_millis(),
                &[],
            )?)
        } else {
            None
        };
        let title = event
            .get("name")
            .filter(|v| !matches!(v, Bson::Null | Bson::Undefined))
            .map(|v| stored_string_key(Some(v)))
            .transpose()?
            .unwrap_or_default();
        Ok(
            json!({"data":data,"pagination":page_meta(page.limit,rows.has_more,next).with_total(total),"title":title,"start":page.cursor.is_none().then_some(0)}),
        )
    };
    let payload = offers::cached(state, "promotions.offers", parts, 60, load_page).await?;
    let mut meta = offers::regional_meta(&region);
    for field in ["title", "start", "pagination"] {
        if let Some(value) = payload.get(field) {
            meta[field] = value.clone();
        }
    }
    let mut envelope = json!({});
    if let Some(data) = payload.get("data") {
        envelope["data"] = data.clone();
    }
    envelope["meta"] = meta;
    Ok(envelope)
}

async fn cover(state: &AppState, uri: &Uri, raw: &str) -> Payload {
    let id = require_id_param(Some(raw), "id")?;
    let query = parse_strict_query_uri(uri, &["locale"])?;
    let locale = canonical_locale(query.get("locale").map(String::as_str))?;
    let data = offers::cached(
        state,
        "promotions.cover",
        BTreeMap::from([("id", json!(id)), ("locale", json!(locale))]),
        3600,
        || async {
            let tagged = state
                .mongo
                .find_many(
                    "offers",
                    search_filter(&id, None),
                    MongoFindOptions {
                        projection: Some(doc! {"namespace":1}),
                        ..Default::default()
                    },
                )
                .await
                .map_err(|_| internal_error())?;
            let namespaces: Vec<_> = tagged
                .iter()
                .filter_map(|row| match row.get("namespace") {
                    Some(Bson::String(s) | Bson::Symbol(s)) => Some(s.as_str()),
                    _ => None,
                })
                .collect();
            let Some(offer) = state
                .mongo
                .find_one(
                    "offers",
                    doc! {"namespace":{"$in":namespaces},"offerType":"BASE_GAME"},
                    None,
                )
                .await
                .map_err(|_| internal_error())?
            else {
                return Ok(Value::Null);
            };
            let localized = localize_ordered_rows(state, &[&offer], &locale).await?;
            serialize_stored_localized_offer(&offer, &localized[0], None)
        },
    )
    .await?;
    if !super::system::js_truthy(&data) {
        return Err(not_found(
            "PROMOTION_COVER_NOT_FOUND",
            "The promotion has no base-game offer to use as a cover.",
        ));
    }
    Ok((data, json!({"locale":locale})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn promotion_sort_dates_outside_js_time_clip_are_rejected() {
        let field = "lastModifiedDate";
        let row = doc! {field:bson::DateTime::from_millis(8_640_000_000_000_001)};
        assert_eq!(sort_value(&row, field).unwrap_err().status, 500);
    }
}
