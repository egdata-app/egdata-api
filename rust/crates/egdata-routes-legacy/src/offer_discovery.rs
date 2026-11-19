//! Discovery lists mounted below /offers, including their offset pagination and cache policies.
use super::{
    Routes,
    catalog::{Page, locale, ordered_offer, query, region},
    common::*,
    offer_relations::{card, prices_by_id},
};
use crate::{state::AppState};
use egdata_http_core::shared::system::localize_offers;
use axum::{
    extract::{Path, State},
    http::{HeaderMap, Uri},
    response::Response,
};
use bson::{Bson, Document, doc};
use egdata_core::{
    localization::{get_localized_cache_ttl_seconds, locale_cache_segment},
    ports::MongoFindOptions,
};
use egdata_infra::bson_json::bson_doc_to_js_json;
use serde_json::{Value, json};
use std::collections::HashMap;
mod ranked;

pub(super) fn routes() -> Routes {
    Routes::new("/offers")
        .get("", list)
        .get("/events/{id}", event)
        .get("/upcoming", list)
        .get("/latest-released", list)
        .get("/genres", genres)
        .get("/top-sellers", ranked::top)
        .get("/top-wishlisted", ranked::top)
        .get("/featured-discounts", ranked::featured)
        .get("/latest-achievements", ranked::achievements)
}

#[cfg(test)]
#[tokio::test]
async fn legacy_offer_discovery_http_node_oracle() {
    egdata_api_oracle::replay_legacy_oracle(include_str!(
        "../../egdata-api/tests/fixtures/legacy-offer-discovery-http-node.json"
    ))
    .await;
}

fn minute(value: &Value) -> Response {
    cache_header(ok(value), ONE_MINUTE)
}
fn bson(value: &Value) -> Bson {
    bson::to_bson(value).unwrap_or(Bson::Null)
}
fn field(rows: &[Value], key: &str) -> Vec<Bson> {
    rows.iter().map(|v| bson(&v[key])).collect()
}
fn options(sort: Document, skip: Option<u64>, limit: Option<i64>) -> MongoFindOptions {
    MongoFindOptions {
        sort: Some(sort),
        skip,
        limit,
        ..Default::default()
    }
}
async fn save(state: &AppState, key: &str, value: &Value, ttl: u64) -> Result<Response> {
    store(
        state,
        key,
        value,
        get_localized_cache_ttl_seconds(value, ttl),
    )
    .await?;
    Ok(minute(value))
}
fn timed(
    mut response: Response,
    state: &AppState,
    start: chrono::DateTime<chrono::Utc>,
) -> Response {
    response.headers_mut().insert(
        "server-timing",
        format!("db;dur={}", ((state.now)() - start).num_milliseconds())
            .parse()
            .unwrap(),
    );
    response
}
struct View {
    locale: String,
    expand: bool,
}
impl View {
    fn new(q: &HashMap<String, String>) -> Result<Self> {
        Ok(Self {
            locale: locale(q)?,
            expand: q.get("expand").is_some_and(|v| {
                matches!(
                    v.trim().to_ascii_lowercase().as_str(),
                    "true" | "1" | "full"
                )
            }),
        })
    }
    fn key(&self) -> String {
        format!(
            "{}:{}",
            locale_cache_segment(&self.locale),
            if self.expand { "full" } else { "card" }
        )
    }
    async fn localize(&self, state: &AppState, rows: &[Value]) -> Result<Vec<Value>> {
        Ok(localize_offers(state, rows, &self.locale).await?)
    }
}

async fn list(State(state): State<AppState>, uri: Uri, headers: HeaderMap) -> Result<Response> {
    let name = uri
        .path()
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("offers");
    page(&state, name, None, &uri, &headers).await
}
async fn event(
    State(state): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Response> {
    page(&state, "event", Some(&id), &uri, &headers).await
}
async fn page(
    state: &AppState,
    name: &str,
    event_id: Option<&str>,
    uri: &Uri,
    headers: &HeaderMap,
) -> Result<Response> {
    let start = (state.now)();
    let q = query(uri);
    let view = View::new(&q)?;
    let region = region(uri, headers)?;
    let params = Page::new(&q, if name == "upcoming" { 15 } else { 10 }, 50);
    let prefix = event_id
        .map(|id| format!("event:{id}"))
        .unwrap_or_else(|| name.into());
    let version = if matches!(name, "upcoming" | "latest-released") {
        ":v0.2"
    } else {
        ""
    };
    let key = format!("{prefix}:{region}:{}:{}{version}", params.key(), view.key());
    if let Some(hit) = cached(state, &key).await? {
        return Ok(minute(&hit));
    }
    let skip = params.skip(0)?;
    let limit = params.limit.ok_or(Error::Internal)?;
    let event = if let Some(id) = event_id {
        Some(
            one(state, "tags", doc! {"id":id,"groupName":"event"})
                .await?
                .ok_or_else(|| not_found("Event not found"))?,
        )
    } else {
        None
    };
    let now = || bson::DateTime::from_chrono((state.now)());
    let (rows, filter) = match name {
        "offers" | "latest-released" => {
            let latest = name == "latest-released";
            let filter = if latest {
                doc! {"effectiveDate":{"$lte":now()},"offerType":{"$in":["BASE_GAME","DLC"]},"releaseDate":{"$ne":Bson::Null,"$lte":now()}}
            } else {
                doc! {}
            };
            let offers = many(
                state,
                "offers",
                filter,
                options(
                    if latest {
                        doc! {"releaseDate":-1}
                    } else {
                        doc! {"lastModifiedDate":-1}
                    },
                    Some(skip),
                    Some(limit),
                ),
            )
            .await?;
            let prices = many(
                state,
                "pricev2",
                doc! {"offerId":{"$in":field(&offers,"id")},"region":region},
                Default::default(),
            )
            .await?;
            let prices = prices_by_id(&prices);
            let rows = offers
                .iter()
                .map(|o| card(o, o["id"].as_str().and_then(|id| prices.get(id)).copied()))
                .collect::<Vec<_>>();
            (
                rows,
                if latest {
                    doc! {"releaseDate":{"$ne":Bson::Null},"offerType":{"$in":["BASE_GAME"]}}
                } else {
                    doc! {}
                },
            )
        }
        _ => {
            let (filter, count, sort) = if let Some(id) = event_id {
                let predicate = doc! {"tags":{"$elemMatch":{"id":id}}};
                (
                    predicate.clone(),
                    predicate,
                    doc! {"price.price.discount":-1},
                )
            } else {
                (
                    doc! {"releaseDate":{"$gt":now(),"$ne":Bson::Null,"$lt":bson::DateTime::from_millis(4_070_908_800_000_i64)},"offerType":{"$in":["BASE_GAME","DLC"]}},
                    doc! {"effectiveDate":{"$gt":now()}},
                    doc! {"releaseDate":1},
                )
            };
            let mut joins = vec![
                doc! {"$match":{"$expr":{"$and":[{"$eq":["$offerId","$$offerId"]},{"$eq":["$region",region]}]}}},
            ];
            if event_id.is_some() {
                joins.push(doc! {"$sort":{"updatedAt":-1}});
            }
            joins.push(doc! {"$limit":1});
            let mut pipeline = vec![
                doc! {"$match":filter},
                doc! {"$lookup":{"from":"pricev2","let":{"offerId":"$id"},"pipeline":joins,"as":"price"}},
                doc! {"$unwind":{"path":"$price","preserveNullAndEmptyArrays":true}},
                doc! {"$sort":sort},
                doc! {"$skip":skip as i64},
                doc! {"$limit":limit},
            ];
            if event_id.is_some() {
                pipeline.push(doc!{"$project":{"_id":0,"id":1,"namespace":1,"title":1,"seller":1,"developerDisplayName":1,"publisherDisplayName":1,"keyImages":1,"price":1,"offerType":1,"productSlug":1,"urlSlug":1,"releaseDate":1,"effectiveDate":1,"lastModifiedDate":1,"prePurchase":1}});
            }
            let docs = state.mongo.aggregate("offers", pipeline).await?;
            let rows = docs
                .iter()
                .map(bson_doc_to_js_json)
                .map(|row| {
                    if event_id.is_some() && view.expand {
                        row
                    } else {
                        card(&row, row.get("price"))
                    }
                })
                .collect();
            (rows, count)
        }
    };
    let elements = view.localize(state, &rows).await?;
    let count = state.mongo.count_documents("offers", filter).await?;
    let value = match name {
        "offers" => json!({"elements":elements,"page":params.page,"limit":limit,"total":count}),
        "event" => {
            json!({"elements":elements,"title":event.as_ref().and_then(|e|e["name"].as_str()).unwrap_or(""),"limit":limit,"start":skip,"page":params.page,"count":count})
        }
        _ => {
            json!({"elements":elements,"limit":limit,"start":skip,"page":params.page,"count":count})
        }
    };
    let response = save(
        state,
        &key,
        &value,
        match name {
            "upcoming" => 360,
            "event" => 3600,
            _ => 60,
        },
    )
    .await?;
    Ok(if name == "latest-released" {
        response
    } else {
        timed(response, state, start)
    })
}

async fn genres(State(state): State<AppState>, uri: Uri) -> Result<Response> {
    let view = View::new(&query(&uri))?;
    let tags = many(
        &state,
        "tags",
        doc! {"groupName":"genre","status":"ACTIVE"},
        Default::default(),
    )
    .await?;
    let load = |genre: Value| {
        let state = &state;
        let view = &view;
        async move {
            let offers=many(state,"offers",doc!{"tags":{"$elemMatch":{"id":bson(&genre["id"])}},"offerType":"BASE_GAME","releaseDate":{"$lte":bson::DateTime::from_chrono((state.now)())}},options(doc!{"releaseDate":-1},None,Some(3))).await?;
            let rows = offers
                .iter()
                .map(|o| {
                    let mut row = json!({});
                    for key in ["id", "namespace", "title"] {
                        if let Some(value) = o.get(key) {
                            row[key] = value.clone();
                        }
                    }
                    let images = o["keyImages"].as_array().ok_or(Error::Internal)?;
                    if let Some(image) = [
                        "OfferImageTall",
                        "Thumbnail",
                        "DieselGameBoxTall",
                        "DieselStoreFrontTall",
                    ]
                    .iter()
                    .find_map(|kind| images.iter().find(|image| image["type"] == *kind))
                    .or(images.first())
                    {
                        row["image"] = image.clone();
                    }
                    Ok(row)
                })
                .collect::<Result<Vec<_>>>()?;
            let mut localized = view.localize(state, &rows).await?;
            for row in &mut localized {
                row.as_object_mut().unwrap().shift_remove("namespace");
            }
            Ok::<_, Error>(json!({"genre":genre,"offers":localized}))
        }
    };
    Ok(minute(&Value::Array(
        futures::future::try_join_all(tags.into_iter().map(load)).await?,
    )))
}
