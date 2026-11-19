//! Read-only offer insight endpoints migrated from `src/v1/routes/offer-details.ts`.
pub use egdata_http_core::shared::offer_insights::*;

use std::collections::BTreeMap;

use axum::{
    extract::{Path, Request, State},
    http::Uri,
    response::Response,
};
use bson::{Bson, doc};
use egdata_core::{
    ports::MongoFindOptions,
    v1::{ProblemError, not_found, serialize_value},
};
use serde_json::{Map, Value, json};

use super::{
    RouteGroup,
    helpers::read_response,
    offer_details::string_field,
    offer_prices::{one, require_stored},
    offers,
    offers::find as many,
    system::{doc_to_json, internal_error, js_truthy},
};
use crate::state::AppState;

const TTL: u64 = 3600;
const OFFER_MISSING: &str = "No offer exists with this ID.";

#[derive(Clone, Copy)]
enum Insight {
    Achievements,
    Giveaways,
    Ratings,
    Tops,
    Polls,
    Hltb,
    Igdb,
    Overview,
    Requirements,
}

pub fn route_group(prefix: &str) -> RouteGroup {
    RouteGroup::new(prefix)
        .get(
            "/offers/{id}/achievements",
            |State(s), Path(id), r: Request| dispatch(s, id, r, Insight::Achievements),
        )
        .get(
            "/offers/{id}/giveaways",
            |State(s), Path(id), r: Request| dispatch(s, id, r, Insight::Giveaways),
        )
        .get("/offers/{id}/ratings", |State(s), Path(id), r: Request| {
            dispatch(s, id, r, Insight::Ratings)
        })
        .get("/offers/{id}/tops", |State(s), Path(id), r: Request| {
            dispatch(s, id, r, Insight::Tops)
        })
        .get("/offers/{id}/polls", |State(s), Path(id), r: Request| {
            dispatch(s, id, r, Insight::Polls)
        })
        .get("/offers/{id}/hltb", |State(s), Path(id), r: Request| {
            dispatch(s, id, r, Insight::Hltb)
        })
        .get("/offers/{id}/igdb", |State(s), Path(id), r: Request| {
            dispatch(s, id, r, Insight::Igdb)
        })
        .get("/offers/{id}/overview", |State(s), Path(id), r: Request| {
            dispatch(s, id, r, Insight::Overview)
        })
        .get(
            "/offers/{id}/requirements",
            |State(s), Path(id), r: Request| dispatch(s, id, r, Insight::Requirements),
        )
}

async fn dispatch(state: AppState, raw_id: String, request: Request, op: Insight) -> Response {
    let id = match egdata_core::v1::require_id_param(Some(&raw_id), "id") {
        Ok(id) => id,
        Err(error) => return read_response(&request, Err(error)),
    };
    let uri = request.uri().clone();
    let result = match op {
        Insight::Achievements => achievements(&state, &id).await,
        Insight::Giveaways => giveaways(&state, &id).await,
        Insight::Ratings => ratings(&state, &id).await,
        Insight::Tops => tops(&state, &id).await,
        Insight::Polls => polls(&state, &id).await,
        Insight::Hltb => hltb(&state, &id).await,
        Insight::Igdb => igdb(&state, &id).await,
        Insight::Overview => overview(&state, &uri, &id).await,
        Insight::Requirements => requirements(&state, &id).await,
    };
    read_response(&request, result)
}

async fn achievements(state: &AppState, id: &str) -> Result<(Value, Value), ProblemError> {
    let data = offers::cached(state, "offer-details.achievements", BTreeMap::from([("id", json!(id))]), TTL, || async {
        let offer = require_stored(state, id, Some(doc! {"namespace":1,"offerType":1})).await?;
        let rows = many(
            state,
            "achievementsets",
            doc! {"sandboxId":offer.get("namespace").cloned().unwrap_or(Bson::Null),"isBase":offer.get_str("offerType") == Ok("BASE_GAME")},
            MongoFindOptions::default(),
        )
        .await?;
        Ok(Value::Array(rows))
    })
    .await?;
    let count = data.as_array().map_or(0, Vec::len);
    Ok((data, json!({"count":count})))
}

async fn giveaways(state: &AppState, id: &str) -> Result<(Value, Value), ProblemError> {
    let data = offers::cached(
        state,
        "offer-details.giveaways",
        BTreeMap::from([("id", json!(id))]),
        TTL,
        || async {
            super::offer_prices::require(state, id, Some(doc! {"id":1})).await?;
            let rows = many(
                state,
                "freegames",
                doc! {"id":id},
                MongoFindOptions {
                    sort: Some(doc! {"startDate":-1}),
                    ..Default::default()
                },
            )
            .await?;
            Ok(Value::Array(rows))
        },
    )
    .await?;
    let count = data.as_array().map_or(0, Vec::len);
    Ok((data, json!({"count":count})))
}

async fn ratings(state: &AppState, id: &str) -> Result<(Value, Value), ProblemError> {
    let data = offers::cached(
        state,
        "offer-details.ratings",
        BTreeMap::from([("id", json!(id))]),
        TTL,
        || async {
            let offer = require_stored(state, id, Some(doc! {"namespace":1})).await?;
            let sandbox = state
                .mongo
                .find_one(
                    "sandboxes",
                    doc! {"_id":offer.get("namespace").cloned().unwrap_or(Bson::Null)},
                    None,
                )
                .await
                .map_err(|_| internal_error())?
                .ok_or_else(|| {
                    not_found("SANDBOX_NOT_FOUND", "No sandbox exists for this offer.")
                })?;
            let product = state
                .mongo
                .find_one(
                    "products",
                    doc! {"_id":sandbox.get("parent").cloned().unwrap_or(Bson::Null)},
                    None,
                )
                .await
                .map_err(|_| internal_error())?
                .ok_or_else(|| {
                    not_found(
                        "PRODUCT_NOT_FOUND",
                        "No store product exists for this offer.",
                    )
                })?;
            let slug = product.get("slug").cloned().unwrap_or(Bson::Null);
            let found = one(state, "ratings", doc! {"_id":slug}, None).await?;
            if found.is_null() {
                return Err(not_found(
                    "RATINGS_NOT_FOUND",
                    "No player ratings are stored for this product.",
                ));
            }
            Ok(found)
        },
    )
    .await?;
    Ok((data, json!({})))
}

async fn tops(state: &AppState, id: &str) -> Result<(Value, Value), ProblemError> {
    let data = offers::cached(
        state,
        "offer-details.tops",
        BTreeMap::from([("id", json!(id))]),
        TTL,
        || async {
            super::offer_prices::require(state, id, Some(doc! {"id":1})).await?;
            let rows = many(
                state,
                "game_positions",
                doc! {"offerId":id},
                MongoFindOptions::default(),
            )
            .await?;
            let mut result = Map::new();
            for row in rows {
                let Some(collection) = row.get("collectionId").filter(|v| !v.is_null()) else {
                    continue;
                };
                let collection = egdata_core::v1::serialization::js_string(collection);
                // Assigning this inherited setter on a plain JS object does not add an own key.
                if collection == "__proto__" {
                    continue;
                }
                result.insert(
                    collection,
                    row.get("position").cloned().unwrap_or(Value::Null),
                );
            }
            Ok(Value::Object(result))
        },
    )
    .await?;
    let count = data.as_object().map_or(0, Map::len);
    Ok((data, json!({"count":count})))
}

async fn polls(state: &AppState, id: &str) -> Result<(Value, Value), ProblemError> {
    let poll = offers::cached(
        state,
        "offer-details.polls",
        BTreeMap::from([("id", json!(id))]),
        TTL,
        || async {
            let offer = require_stored(state, id, Some(doc! {"namespace":1})).await?;
            let namespace = offer.get("namespace").cloned().unwrap_or(Bson::Null);
            let sandbox = one(state, "sandboxes", doc! {"_id":&namespace}, None).await?;
            if sandbox.is_null() {
                return Err(not_found(
                    "SANDBOX_NOT_FOUND",
                    "No sandbox exists for this offer.",
                ));
            }
            one(state, "ratings_polls", doc! {"_id":namespace}, None).await
        },
    )
    .await?;
    Ok((json!({"poll":poll}), json!({})))
}

async fn igdb(state: &AppState, id: &str) -> Result<(Value, Value), ProblemError> {
    let data = offers::cached(
        state,
        "offer-details.igdb",
        BTreeMap::from([("id", json!(id))]),
        TTL,
        || async {
            super::offer_prices::require(state, id, Some(doc! {"id":1})).await?;
            let found = one(state, "igdb", doc! {"offerId":id}, None).await?;
            if found.is_null() {
                return Err(not_found(
                    "IGDB_NOT_FOUND",
                    "No IGDB data is stored for this offer.",
                ));
            }
            Ok(found)
        },
    )
    .await?;
    Ok((data, json!({})))
}

async fn hltb(state: &AppState, id: &str) -> Result<(Value, Value), ProblemError> {
    let data = offers::cached(
        state,
        "offer-details.hltb",
        BTreeMap::from([("id", json!(id))]),
        TTL,
        || async {
            super::offer_prices::require(state, id, Some(doc! {"id":1})).await?;
            let found = one(state, "hltbs", doc! {"_id":id}, None).await?;
            if !js_truthy(&found["hltbId"]) || found["hltbId"] == "00000" {
                return Err(not_found(
                    "HLTB_NOT_FOUND",
                    "No HowLongToBeat data is stored for this offer.",
                ));
            }
            Ok(found)
        },
    )
    .await?;
    Ok((data, json!({})))
}

async fn overview(state: &AppState, uri: &Uri, id: &str) -> Result<(Value, Value), ProblemError> {
    let query = super::helpers::parse_strict_query_uri(uri, &["country", "locale"])?;
    let region = egdata_core::v1::regional_params(
        query.get("country").map(String::as_str),
        query.get("locale").map(String::as_str),
    )?;
    let payload = offers::cached(
        state,
        "offer-details.overview",
        BTreeMap::from([
            ("id", json!(id)),
            ("region", json!(region.region)),
            ("locale", json!(region.locale)),
        ]),
        300,
        || async { load_overview(state, id, &region).await },
    )
    .await?;
    let mut meta = offers::regional_meta(&region);
    if let Some(localization) = payload["localization"].as_object() {
        meta.as_object_mut().unwrap().extend(localization.clone());
    }
    Ok((payload["data"].clone(), meta))
}

async fn load_overview(
    state: &AppState,
    id: &str,
    region: &egdata_core::v1::RegionalParams,
) -> Result<Value, ProblemError> {
    let detail = offers::cached_detail(state, region, id).await?;
    if detail.is_null() {
        return Err(not_found("OFFER_NOT_FOUND", OFFER_MISSING));
    }
    let offer = &detail["offer"];
    let namespace = Bson::try_from(offer["namespace"].clone()).unwrap_or(Bson::Null);
    let (media, igdb, subitems, sandbox, giveaways, genre_tags) = tokio::join!(
        biased;
        one(state, "media", doc! {"_id":id}, None),
        one(state, "igdb", doc! {"offerId":id}, None),
        many(
            state,
            "offersubitems",
            doc! {"_id":id},
            MongoFindOptions {
                projection: Some(doc! {"_id":1,"subItems":1}),
                ..Default::default()
            }
        ),
        one(state, "sandboxes", doc! {"_id":&namespace}, None),
        many(
            state,
            "freegames",
            doc! {"id":id},
            MongoFindOptions {
                sort: Some(doc! {"startDate":-1}),
                ..Default::default()
            }
        ),
        many(
            state,
            "tags",
            doc! {"groupName":"genre","status":"ACTIVE"},
            MongoFindOptions::default()
        ),
    );
    let (media, igdb, subitems, sandbox, giveaways, genre_tags) =
        (media?, igdb?, subitems?, sandbox?, giveaways?, genre_tags?);
    let item_ids = super::offer_metadata::offer_item_ids(offer, &subitems)?;
    let items = state
        .mongo
        .find_many(
            "items",
            doc! {"$or":[{"id":{"$in":item_ids}},{"linkedOffers":id}]},
            MongoFindOptions::default(),
        )
        .await
        .map_err(|_| internal_error())?;
    let ids = items
        .iter()
        .map(|item| match item.get("id") {
            None | Some(Bson::Undefined) => "undefined".to_owned(),
            Some(value) => egdata_core::v1::serialization::stored_identifier(value)
                .unwrap_or_else(|| "null".to_owned()),
        })
        .collect();
    let assets = super::offer_metadata::assets_for_ids(state, ids).await?;
    let builds = if assets.is_empty() {
        Vec::new()
    } else {
        let app_names = assets
            .iter()
            .map(|v| string_field(v, "artifactId"))
            .collect::<Vec<_>>();
        let pipeline = vec![
            doc! {"$match":{"appName":{"$in":app_names}}},
            doc! {"$sort":{"createdAt":-1}},
            doc! {"$group":{"_id":"$appName","doc":{"$first":"$$ROOT"}}},
        ];
        state
            .mongo
            .aggregate("builds", pipeline)
            .await
            .map_err(|_| internal_error())?
            .into_iter()
            .filter_map(|row| row.get_document("doc").ok().cloned())
            .map(doc_to_json)
            .collect::<Vec<_>>()
    };
    let poll = one(state, "ratings_polls", doc! {"_id":namespace}, None).await?;
    let mut age_rating = Value::Null;
    if let Some(age) = sandbox.get("ageGatings").and_then(Value::as_object) {
        let system = super::offer_metadata::age_system(&region.country);
        if let Some(value) = age.get(system).filter(|v| !v.is_null()) {
            age_rating = json!({system:value});
        }
    }
    let tags = offer["tags"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    if tags.iter().any(Value::is_null) {
        return Err(internal_error());
    }
    let genres = super::offer_metadata::matching_genres(tags, &genre_tags);
    let features = json!(super::offer_metadata::game_features(&items, offer)?);
    let technologies = dedupe_technologies(&builds);
    Ok(
        json!({"data":{"offer":offer,"price":offer.get("price").cloned().unwrap_or(Value::Null),"media":media,"igdb":igdb,"features":features,"ageRating":age_rating,"giveaways":giveaways,"polls":poll,"genres":genres,"technologies":technologies},"localization":detail["localization"]}),
    )
}

fn dedupe_technologies(builds: &[Value]) -> Vec<Value> {
    let mut result: Vec<&Value> = Vec::new();
    for entry in builds
        .iter()
        .flat_map(|b| b["technologies"].as_array())
        .flatten()
        .filter(|e| js_truthy(e))
    {
        let key = entry.get("technology");
        // JS strictly compares scalar keys. Arrays and objects read from distinct
        // Mongo documents always have distinct identities.
        if key.is_some_and(|k| k.is_array() || k.is_object())
            || !result.iter().any(|e| e.get("technology") == key)
        {
            result.push(entry);
        }
    }
    result.into_iter().map(serialize_value).collect()
}

async fn requirements(state: &AppState, id: &str) -> Result<(Value, Value), ProblemError> {
    let data = offers::cached(
        state,
        "offer-details.requirements",
        BTreeMap::from([("id", json!(id))]),
        TTL,
        || async {
            let offer = require_stored(state, id, Some(doc! {"namespace":1})).await?;
            let namespace = offer.get("namespace").unwrap_or(&Bson::Null);
            let (windows, macos) = tokio::join!(biased;
                requirements_for_platform(state, namespace, id, "windows", RequirementsWire::V1),
                requirements_for_platform(state, namespace, id, "macos", RequirementsWire::V1)
            );
            let (windows, macos) = (windows?, macos?);
            if windows.is_null() && macos.is_null() {
                return Err(not_found(
                    "REQUIREMENTS_NOT_FOUND",
                    "No system requirements are stored for this offer.",
                ));
            }
            Ok(json!({"windows":serialize_value(&windows),"macos":serialize_value(&macos)}))
        },
    )
    .await?;
    Ok((data, json!({})))
}





#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn offer_insights_http_node_oracle() {
        egdata_api_oracle::replay_mongo_oracle(include_str!(
            "../../egdata-api/tests/fixtures/offer-insights-http-node.json"
        ))
        .await;
    }
}
