//! Current and ISO-week collection positions (`src/v1/routes/collections.ts`).
use super::{
    RouteGroup,
    helpers::{parse_strict_query_uri, read_envelope_response},
    offers,
    system::{
        cursor_scalar_bson, internal_error, localize_ordered_rows,
        serialize_stored_localized_offer, stored_string_key,
    },
};
use crate::state::AppState;
use axum::{
    extract::{Path, Request, State},
    http::Uri,
};
use bson::{Bson, Document, doc};
use chrono::{DateTime, Duration, NaiveDate, Utc, Weekday};
use egdata_core::{ports::MongoFindOptions, v1::*};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};

pub fn route_group(prefix: &str) -> RouteGroup {
    RouteGroup::new(prefix)
        .get(
            "/collections/{slug}",
            |State(state), Path(slug): Path<String>, request: Request| async move {
                let result = collection(&state, request.uri(), &slug, None).await;
                read_envelope_response(&request, result)
            },
        )
        .get(
            "/collections/{slug}/{week}",
            |State(state), Path((slug, week)): Path<(String, String)>, request: Request| async move {
                let result = collection(&state, request.uri(), &slug, Some(&week)).await;
                read_envelope_response(&request, result)
            },
        )
}

struct Week<'a> {
    label: &'a str,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
}

fn parse_week(raw: &str) -> Result<Week<'_>, ProblemError> {
    let label = trim_js_whitespace(raw);
    let bytes = label.as_bytes();
    if bytes.len() != 7
        || bytes[4] != b'W'
        || !bytes[..4].iter().chain(&bytes[5..]).all(u8::is_ascii_digit)
    {
        return Err(bad_request(
            "INVALID_WEEK",
            "The `week` path parameter must use the YYYYWNN format, for example 2025W31.",
            None,
        ));
    }
    let year = label[..4].parse::<i32>().unwrap();
    let week = label[5..].parse::<u32>().unwrap();
    // Date.UTC treats years 00..99 as 1900..1999, so they fail Node's round trip.
    let date = NaiveDate::from_isoywd_opt(year, week, Weekday::Mon)
        .filter(|_| year >= 100)
        .ok_or_else(|| {
            bad_request(
                "INVALID_WEEK",
                format!("The week '{label}' does not exist in the ISO calendar."),
                None,
            )
        })?;
    let start = date.and_time(chrono::NaiveTime::MIN).and_utc();
    Ok(Week {
        label,
        start,
        end: start + Duration::weeks(1),
    })
}

fn week_pipeline(
    id: &bson::Bson,
    week: &Week<'_>,
    keyset: Option<Document>,
    limit: i64,
) -> Vec<Document> {
    let mut pipeline = vec![
        doc! {"$match":{"collectionId":id.clone()}},
        doc! {"$unwind":"$positions"},
        doc! {"$match":{"positions.date":{"$gte":bson::DateTime::from_chrono(week.start),"$lt":bson::DateTime::from_chrono(week.end)},"positions.position":{"$gt":0}}},
        doc! {"$sort":{"positions.date":-1}},
        doc! {"$group":{"_id":"$offerId","positions":{"$push":"$positions"},"latest":{"$first":"$positions"},"previous":{"$first":"$previous"}}},
        doc! {"$project":{"_id":0,"offerId":"$_id","positions":1,"position":"$latest.position","previous":1}},
        doc! {"$match":{"position":{"$gt":0}}},
    ];
    if let Some(filter) = keyset {
        pipeline.push(doc! {"$match":filter});
    }
    pipeline.extend([
        doc! {"$sort":{"position":1,"offerId":1}},
        doc! {"$limit":limit},
    ]);
    pipeline
}

async fn collection(
    state: &AppState,
    uri: &Uri,
    slug: &str,
    week: Option<&str>,
) -> Result<Value, ProblemError> {
    let slug = require_id_param(Some(slug), "slug")?;
    let week = week.map(parse_week).transpose()?;
    let query = parse_strict_query_uri(uri, &["country", "locale", "limit", "cursor"])?;
    let region = regional_params(
        query.get("country").map(String::as_str),
        query.get("locale").map(String::as_str),
    )?;
    let page = parse_pagination_map(&query, 100)?;
    let collection = state
        .mongo
        .find_one("collections_v2", doc! {"_id":&slug}, None)
        .await
        .map_err(|_| internal_error())?
        .ok_or_else(|| {
            not_found(
                "COLLECTION_NOT_FOUND",
                "No collection exists with this slug.",
            )
        })?;
    let operation = if week.is_some() {
        "collections.week"
    } else {
        "collections.positions"
    };
    let mut filters = BTreeMap::from([("slug".into(), json!(slug))]);
    let mut cache = BTreeMap::from([
        ("slug", json!(slug)),
        ("region", json!(region.region)),
        ("locale", json!(region.locale)),
        ("limit", json!(page.limit)),
        ("cursor", json!(page.cursor)),
    ]);
    if let Some(ref week) = week {
        filters.insert("week".into(), json!(week.label));
        cache.insert("week", json!(week.label));
    }
    let binding = offers::binding(
        operation,
        filters,
        "position:asc,id:asc",
        &region,
        page.limit,
    );
    let load_page = || async {
        let sort = ["position", "offerId"]
            .map(|field| MongoSortField::new(field, SortDirection::Asc, NullsOrder::Last));
        let keyset = offers::decode(state, &page, &binding)?
            .map(|last| {
                mongo_keyset_filter(
                    &sort,
                    &last.iter().map(cursor_scalar_bson).collect::<Vec<_>>(),
                )
            })
            .transpose()?;
        let limit = i64::from(page.limit) + 1;
        let id = collection.get("_id").ok_or_else(internal_error)?;
        let rows = if let Some(ref week) = week {
            state
                .mongo
                .aggregate("game_positions", week_pipeline(id, week, keyset, limit))
                .await
                .map_err(|_| internal_error())?
        } else {
            let mut filter = doc! {"collectionId":id.clone(),"position":{"$gt":0}};
            if let Some(keyset) = keyset {
                filter.extend(keyset);
            }
            state
                .mongo
                .find_many(
                    "game_positions",
                    filter,
                    MongoFindOptions {
                        sort: Some(mongo_sort_spec(&sort)),
                        limit: Some(limit),
                        ..Default::default()
                    },
                )
                .await
                .map_err(|_| internal_error())?
        };
        let positions = trim_page(rows, page.limit as usize);
        let ids = positions
            .items
            .iter()
            .map(|row| nullish_string(row.get("offerId")))
            .collect::<Result<Vec<_>, _>>()?;
        let (offers, prices) = tokio::join!(
            state
                .mongo
                .find_many("offers", doc! {"id":{"$in":&ids}}, Default::default()),
            state.mongo.find_many(
                "pricev2",
                doc! {"offerId":{"$in":&ids},"region":&region.region},
                Default::default()
            ),
        );
        let offers = offers.map_err(|_| internal_error())?;
        let prices = prices.map_err(|_| internal_error())?;
        let mut by_id = HashMap::new();
        for offer in &offers {
            by_id.insert(stored_string_key(offer.get("id"))?, offer);
        }
        let mut prices_by_id = HashMap::new();
        for price in prices {
            prices_by_id.insert(stored_string_key(price.get("offerId"))?, price);
        }
        let mut ranked = Vec::new();
        for (id, position) in ids.iter().zip(&positions.items) {
            if let Some(&offer) = by_id.get(id) {
                ranked.push((position, offer, prices_by_id.get(id)));
            }
        }
        let selected: Vec<_> = ranked.iter().map(|(_, offer, _)| *offer).collect();
        let localized = localize_ordered_rows(state, &selected, &region.locale).await?;
        let mut data = Vec::with_capacity(ranked.len());
        for ((position, source, price), offer) in ranked.into_iter().zip(&localized) {
            let mut entry = serialize_stored_localized_offer(source, offer, price.cloned())?;
            let get = |field| position.get(field).unwrap_or(&Bson::Null);
            entry["position"] = egdata_core::bson_json::bson_to_js_json(get("position"));
            entry["previousPosition"] = egdata_core::bson_json::bson_to_js_json(get("previous"));
            let metadata = if week.is_some() {
                let history = match get("positions") {
                    Bson::Null | Bson::Undefined => Bson::Array(Vec::new()),
                    value => value.clone(),
                };
                doc! {
                    "offerId": get("offerId"),
                    "position": get("position"),
                    "previous": get("previous"),
                    "positions": history,
                }
            } else {
                position.clone()
            };
            entry["metadata"] = serialization::bson_to_serialized_json(&Bson::Document(metadata));
            data.push(entry);
        }
        let tuple = if positions.has_more {
            let last = positions.items.last().expect("positive page limit");
            let rank = match last.get("position") {
                Some(value @ (Bson::Document(_) | Bson::Array(_))) => {
                    serialization::js_string_number(&stored_string_key(Some(value))?)
                }
                Some(value) => super::offer_regional_price::stored_number(value),
                None => f64::NAN,
            };
            vec![
                offers::scalar(&json!(rank)),
                stored_string_key(last.get("offerId"))?.into(),
            ]
        } else {
            vec![]
        };
        let pagination = offers::pagination(state, &binding, positions.has_more, tuple)?;
        let title = nullish_string(collection.get("name"))?;
        let updated_at = collection
            .get("updatedAt")
            .and_then(serialization::bson_iso_or_null);
        let mut payload =
            json!({"data":data,"pagination":pagination,"title":title,"updatedAt":updated_at});
        if let Some(week) = &week {
            payload["start"] = json!(serialization::js_iso_datetime(week.start));
            payload["end"] = json!(serialization::js_iso_datetime(week.end));
        }
        Ok(payload)
    };
    let mut payload = offers::cached(state, operation, cache, 60, load_page).await?;
    let mut meta = offers::regional_meta(&region);
    let fields = if week.is_some() {
        &["title", "updatedAt", "start", "end", "pagination"][..]
    } else {
        &["title", "updatedAt", "pagination"][..]
    };
    for &name in fields {
        if let Some(v) = payload.get_mut(name) {
            meta[name] = v.take();
        }
    }
    let mut envelope = json!({});
    if let Some(data) = payload.get_mut("data") {
        envelope["data"] = data.take();
    }
    envelope["meta"] = meta;
    Ok(envelope)
}

fn nullish_string(value: Option<&Bson>) -> Result<String, ProblemError> {
    match value {
        None | Some(Bson::Null | Bson::Undefined) => Ok(String::new()),
        _ => stored_string_key(value),
    }
}
