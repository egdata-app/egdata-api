//! Offer metadata endpoints migrated from `src/v1/routes/offer-details.ts`.
pub use egdata_http_core::shared::offer_metadata::*;

use super::{
    RouteGroup,
    helpers::{parse_strict_query_uri, read_response},
    offer_prices::{one, require as require_offer, require_stored},
    offers,
    offers::find as many,
    system::{doc_to_json, internal_error, js_truthy},
};
use crate::state::AppState;
use axum::{
    extract::{Path, Request, State},
    http::Uri,
};
use bson::{Document, doc};
use egdata_core::v1::serialization::{js_array_index, js_string};
use egdata_core::{
    attributes::{FeatureTag, get_game_features},
    ports::MongoFindOptions,
    v1::{ProblemError, canonical_country, not_found, parse_boolean, serialize_value},
};
use indexmap::IndexMap;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};

const TTL: u64 = 3600;

pub fn route_group(prefix: &str) -> RouteGroup {
    RouteGroup::new(prefix)
        .get(
            "/offers/{id}/franchises",
            |State(s), Path(id): Path<String>, r: Request| {
                dispatch(s, id, r, Operation::Franchises)
            },
        )
        .get(
            "/offers/{id}/features",
            |State(s), Path(id): Path<String>, r: Request| dispatch(s, id, r, Operation::Features),
        )
        .get(
            "/offers/{id}/assets",
            |State(s), Path(id): Path<String>, r: Request| dispatch(s, id, r, Operation::Assets),
        )
        .get(
            "/offers/{id}/items",
            |State(s), Path(id): Path<String>, r: Request| dispatch(s, id, r, Operation::Items),
        )
        .get(
            "/offers/{id}/mappings",
            |State(s), Path(id): Path<String>, r: Request| dispatch(s, id, r, Operation::Mappings),
        )
        .get(
            "/offers/{id}/media",
            |State(s), Path(id): Path<String>, r: Request| dispatch(s, id, r, Operation::Media),
        )
        .get(
            "/offers/{id}/age-rating",
            |State(s), Path(id): Path<String>, r: Request| dispatch(s, id, r, Operation::AgeRating),
        )
        .get(
            "/offers/{id}/genres",
            |State(s), Path(id): Path<String>, r: Request| dispatch(s, id, r, Operation::Genres),
        )
        .get(
            "/offers/{id}/technologies",
            |State(s), Path(id): Path<String>, r: Request| {
                dispatch(s, id, r, Operation::Technologies)
            },
        )
        .get(
            "/offers/{id}/builds",
            |State(s), Path(id): Path<String>, r: Request| dispatch(s, id, r, Operation::Builds),
        )
}

#[derive(Clone, Copy)]
enum Operation {
    Franchises,
    Features,
    Assets,
    Items,
    Mappings,
    Media,
    AgeRating,
    Genres,
    Technologies,
    Builds,
}
async fn dispatch(
    state: AppState,
    id: String,
    request: Request,
    op: Operation,
) -> axum::response::Response {
    let result = match egdata_core::v1::require_id_param(Some(&id), "id") {
        Ok(id) => execute(&state, request.uri(), &id, op).await,
        Err(error) => Err(error),
    };
    read_response(&request, result)
}
pub(super) async fn items_for_offer(
    state: &AppState,
    id: &str,
    offer: &Value,
) -> Result<Vec<Value>, ProblemError> {
    Ok(stored_items_for_offer(state, id, offer)
        .await?
        .into_iter()
        .map(doc_to_json)
        .collect())
}

async fn stored_items_for_offer(
    state: &AppState,
    id: &str,
    offer: &Value,
) -> Result<Vec<Document>, ProblemError> {
    let sub_items = many(
        state,
        "offersubitems",
        doc! {"_id":id},
        MongoFindOptions {
            projection: Some(doc! {"_id":1,"subItems":1}),
            ..Default::default()
        },
    )
    .await?;
    let ids = offer_item_ids(offer, &sub_items)?;
    let filter = doc! {"$or":[{"id":{"$in":ids}},{"linkedOffers":id}]};
    state
        .mongo
        .find_many("items", filter, MongoFindOptions::default())
        .await
        .map_err(|_| internal_error())
}

pub(super) fn offer_item_ids(
    offer: &Value,
    sub_items: &[Value],
) -> Result<Vec<String>, ProblemError> {
    let mut ids = Vec::new();
    let mut append = |items: &[Value]| -> Result<(), ProblemError> {
        for item in items {
            if item.is_null() {
                return Err(internal_error());
            }
            ids.push(super::offer_details::string_field(item, "id"));
        }
        Ok(())
    };
    if let Some(items) = offer["items"].as_array() {
        append(items)?;
    }
    for entry in sub_items {
        append(entry["subItems"].as_array().ok_or_else(internal_error)?)?;
    }
    Ok(ids)
}
pub(super) async fn assets_for_items(
    state: &AppState,
    items: &[Value],
) -> Result<Vec<Value>, ProblemError> {
    let ids = items
        .iter()
        .map(|item| super::offer_details::string_field(item, "id"))
        .collect();
    assets_for_ids(state, ids).await
}

pub(super) async fn assets_for_ids(
    state: &AppState,
    ids: Vec<String>,
) -> Result<Vec<Value>, ProblemError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    many(
        state,
        "assets",
        doc! {"itemId":{"$in":ids}},
        MongoFindOptions::default(),
    )
    .await
}
async fn execute(
    state: &AppState,
    uri: &Uri,
    id: &str,
    op: Operation,
) -> Result<(Value, Value), ProblemError> {
    if matches!(op, Operation::AgeRating) {
        return age_rating(state, uri, id).await;
    }
    let name = match op {
        Operation::Franchises => "franchises",
        Operation::Features => "features",
        Operation::Assets => "assets",
        Operation::Items => "items",
        Operation::Mappings => "mappings",
        Operation::Media => "media",
        Operation::Genres => "genres",
        Operation::Technologies => "technologies",
        Operation::Builds => "builds",
        Operation::AgeRating => unreachable!(),
    };
    let value = offers::cached(
        state,
        &format!("offer-details.{name}"),
        BTreeMap::from([("id", json!(id))]),
        TTL,
        || async move {
            match op {
                Operation::Franchises => franchises(state, id).await,
                Operation::Features => features(state, id).await,
                Operation::Assets => assets(state, id).await,
                Operation::Items => items(state, id).await,
                Operation::Mappings => {
                    single(
                        state,
                        id,
                        "mappings",
                        "MAPPINGS_NOT_FOUND",
                        "No store mappings are stored for this offer.",
                    )
                    .await
                }
                Operation::Media => {
                    single(
                        state,
                        id,
                        "media",
                        "MEDIA_NOT_FOUND",
                        "No media is stored for this offer.",
                    )
                    .await
                }
                Operation::Genres => genres(state, id).await,
                Operation::Technologies => technologies(state, id).await,
                Operation::Builds => builds(state, id).await,
                Operation::AgeRating => unreachable!(),
            }
        },
    )
    .await?;
    let mut meta = json!({});
    if matches!(
        op,
        Operation::Franchises
            | Operation::Assets
            | Operation::Items
            | Operation::Genres
            | Operation::Technologies
            | Operation::Builds
    ) {
        match &value {
            Value::Array(rows) => meta["count"] = rows.len().into(),
            Value::String(s) => meta["count"] = s.encode_utf16().count().into(),
            Value::Null => return Err(internal_error()),
            value => {
                if let Some(length) = value.get("length") {
                    meta["count"] = length.clone();
                }
            }
        }
        if matches!(op, Operation::Builds) {
            meta["limit"] = 50.into();
        }
    }
    Ok((value, meta))
}
async fn franchises(s: &AppState, id: &str) -> Result<Value, ProblemError> {
    require_offer(s, id, Some(doc! {"id":1})).await?;
    let rows = many(
        s,
        "franchises",
        doc! {"offers":id},
        MongoFindOptions::default(),
    )
    .await?;
    if rows.is_empty() {
        return Ok(json!([]));
    }
    let mut seen = HashSet::new();
    let ids = rows
        .iter()
        .filter_map(|f| f["offers"].as_array())
        .flatten()
        .map(js_string)
        .filter(|id| seen.insert(id.clone()))
        .collect::<Vec<_>>();
    let offers = many(
        s,
        "offers",
        doc! {"id":{"$in":ids}},
        MongoFindOptions {
            projection: Some(doc! {"id":1,"namespace":1}),
            ..Default::default()
        },
    )
    .await?;
    let namespaces = offers
        .into_iter()
        .map(|mut o| {
            (
                super::offer_details::string_field(&o, "id"),
                o["namespace"].take(),
            )
        })
        .collect::<HashMap<_, _>>();
    Ok(json!(
        rows.into_iter()
            .filter(|f| f["offers"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|id| namespaces.get(&js_string(id)))
                .filter(|namespace| js_truthy(namespace))
                .collect::<HashSet<_>>()
                .len()
                > 1)
            .map(|f| serialize_value(&f))
            .collect::<Vec<_>>()
    ))
}
async fn features(s: &AppState, id: &str) -> Result<Value, ProblemError> {
    let offer = require_offer(s, id, Some(doc! {"items":1,"tags":1})).await?;
    let items = stored_items_for_offer(s, id, &offer).await?;
    Ok(json!(game_features(&items, &offer)?))
}

pub use egdata_http_core::shared::offers::stored_truthy;


pub(super) fn game_features(
    items: &[Document],
    offer: &Value,
) -> Result<egdata_core::attributes::GameFeatures, ProblemError> {
    let attrs = feature_attributes(items)?;
    let tags = offer["tags"].as_array().into_iter().flatten();
    Ok(features_for_tags(&attrs, tags))
}

pub(super) fn features_for_tags<'a>(
    attrs: &std::collections::BTreeMap<String, egdata_core::attributes::AttributeValue>,
    tags: impl IntoIterator<Item = &'a Value>,
) -> egdata_core::attributes::GameFeatures {
    let mut ordered = IndexMap::new();
    for tag in tags {
        let Some(id_value) = tag.get("id").filter(|value| !value.is_null()) else {
            continue;
        };
        let id = js_string(id_value);
        let name = if tag.get("name").is_some_and(|value| !value.is_null()) {
            super::offer_details::string_field(tag, "name")
        } else {
            String::new()
        };
        let feature_tag = FeatureTag {
            id: id.clone(),
            name,
        };
        ordered.insert(id, feature_tag);
    }
    let mut tags: Vec<_> = ordered.into_values().collect();
    tags.sort_by_cached_key(|tag| js_array_index(&tag.id).unwrap_or(u32::MAX));
    get_game_features(attrs, &tags)
}

pub(super) fn age_system(country: &str) -> &'static str {
    egdata_core::countries::AGE_RATINGS_COUNTRIES
        .iter()
        .find(|(_, countries)| countries.contains(&country))
        .map(|(system, _)| *system)
        .unwrap_or("Generic")
}

pub(super) fn matching_genres(offer_tags: &[Value], active_tags: &[Value]) -> Vec<Value> {
    let ids = active_tags
        .iter()
        .map(|tag| super::offer_details::string_field(tag, "id"))
        .collect::<HashSet<_>>();
    offer_tags
        .iter()
        .filter(|tag| ids.contains(&super::offer_details::string_field(tag, "id")))
        .map(serialize_value)
        .collect()
}
async fn assets(s: &AppState, id: &str) -> Result<Value, ProblemError> {
    let offer = require_offer(s, id, Some(doc! {"items":1})).await?;
    let items = items_for_offer(s, id, &offer).await?;
    Ok(json!(
        assets_for_items(s, &items)
            .await?
            .iter()
            .map(serialize_value)
            .collect::<Vec<_>>()
    ))
}
async fn items(s: &AppState, id: &str) -> Result<Value, ProblemError> {
    let offer = require_offer(s, id, Some(doc! {"items":1})).await?;
    Ok(json!(
        items_for_offer(s, id, &offer)
            .await?
            .iter()
            .map(serialize_value)
            .collect::<Vec<_>>()
    ))
}
async fn single(
    s: &AppState,
    id: &str,
    collection: &str,
    code: &str,
    detail: &str,
) -> Result<Value, ProblemError> {
    require_offer(s, id, Some(doc! {"id":1})).await?;
    let value = one(s, collection, doc! {"_id":id}, None).await?;
    if value.is_null() {
        return Err(not_found(code, detail));
    }
    Ok(value)
}
async fn age_rating(s: &AppState, u: &Uri, id: &str) -> Result<(Value, Value), ProblemError> {
    let q = parse_strict_query_uri(u, &["country", "single"])?;
    let country = canonical_country(q.get("country").map(String::as_str))?;
    let single = parse_boolean(q.get("single").map(String::as_str), "single")?.unwrap_or(false);
    let value = offers::cached(
        s,
        "offer-details.age-rating",
        BTreeMap::from([
            ("id", json!(id)),
            ("country", json!(country)),
            ("single", json!(single)),
        ]),
        TTL,
        || async {
            let offer = require_stored(s, id, Some(doc! {"namespace":1})).await?;
            let namespace = offer.get("namespace").cloned().unwrap_or(bson::Bson::Null);
            let sandbox = s
                .mongo
                .find_one("sandboxes", doc! {"_id":namespace}, None)
                .await
                .map_err(|_| internal_error())?
                .ok_or_else(|| {
                    not_found("SANDBOX_NOT_FOUND", "No sandbox exists for this offer.")
                })?;
            let ratings = sandbox
                .get("ageGatings")
                .filter(|value| super::item_serialization::truthy(value))
                .ok_or_else(|| {
                    not_found(
                        "AGE_RATING_NOT_FOUND",
                        "No age ratings are stored for this offer.",
                    )
                })?;
            if !single {
                return Ok(egdata_core::v1::bson_to_serialized_json(ratings));
            }
            let system = age_system(&country);
            let selected = ratings
                .as_document()
                .and_then(|fields| fields.get(system))
                .filter(|value| !matches!(value, bson::Bson::Null | bson::Bson::Undefined))
                .ok_or_else(|| {
                    not_found(
                        "AGE_RATING_NOT_FOUND",
                        format!("No {system} age rating is stored for this offer."),
                    )
                })?;
            Ok(doc_to_json(doc! {system: selected.clone()}))
        },
    )
    .await?;
    Ok((value, json!({"country":country,"single":single})))
}
async fn genres(s: &AppState, id: &str) -> Result<Value, ProblemError> {
    let offer = require_offer(s, id, Some(doc! {"tags":1})).await?;
    let tags = many(
        s,
        "tags",
        doc! {"groupName":"genre","status":"ACTIVE"},
        MongoFindOptions::default(),
    )
    .await?;
    let offer_tags = offer["tags"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    if offer_tags.iter().any(Value::is_null) {
        return Err(internal_error());
    }
    Ok(json!(matching_genres(offer_tags, &tags)))
}
async fn technologies(s: &AppState, id: &str) -> Result<Value, ProblemError> {
    let offer = require_offer(s, id, Some(doc! {"items":1})).await?;
    let items = items_for_offer(s, id, &offer).await?;
    let assets = assets_for_items(s, &items).await?;
    let names = assets
        .iter()
        .map(|a| super::offer_details::string_field(a, "artifactId"))
        .collect::<Vec<_>>();
    if names.is_empty() {
        return Ok(json!([]));
    }
    let pipeline = vec![
        doc! {"$match":{"appName":{"$in":&names}}},
        doc! {"$sort":{"createdAt":-1}},
        doc! {"$group":{"_id":"$appName","doc":{"$first":"$$ROOT"}}},
    ];
    let rows = s
        .mongo
        .aggregate("builds", pipeline)
        .await
        .map_err(|_| internal_error())?;
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for row in rows {
        let build = doc_to_json(row);
        if let Some(technologies) = build["doc"]["technologies"].as_array() {
            for technology in technologies {
                let name = technology.get("technology");
                // JS compares object-valued identifiers by reference, including across BSON rows.
                let distinct = name.is_some_and(|v| v.is_array() || v.is_object());
                if js_truthy(technology) && (distinct || seen.insert(name.cloned())) {
                    out.push(serialize_value(technology));
                }
            }
        }
    }
    Ok(json!(out))
}
async fn builds(s: &AppState, id: &str) -> Result<Value, ProblemError> {
    let offer = require_offer(s, id, Some(doc! {"items":1})).await?;
    let items = items_for_offer(s, id, &offer).await?;
    let assets = assets_for_items(s, &items).await?;
    let names = assets
        .iter()
        .map(|a| super::offer_details::string_field(a, "artifactId"))
        .collect::<Vec<_>>();
    if names.is_empty() {
        return Ok(json!([]));
    }
    let rows = s
        .mongo
        .find_many(
            "builds",
            doc! {"appName":{"$in":&names}},
            MongoFindOptions {
                sort: Some(doc! {"updatedAt":-1}),
                limit: Some(50),
                ..Default::default()
            },
        )
        .await
        .map_err(|_| internal_error())?;
    let summaries = rows
        .iter()
        .map(|row| build_summary_value(&egdata_infra::bson_json::bson_doc_to_js_json(row)))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Value::Array(summaries))
}

/// This read includes older builds with string IDs and omitted manifest fields.
pub(crate) fn build_summary_value(build: &Value) -> Result<Value, ProblemError> {
    let non_null = |field: &str| build.get(field).filter(|value| !value.is_null());
    let id = non_null("_id")
        .map(egdata_core::v1::serialization::js_string)
        .ok_or_else(internal_error)?;
    let platform = match non_null("platform") {
        Some(platform) => platform.clone(),
        None => {
            let label = build["labelName"].as_str().ok_or_else(internal_error)?;
            json!(label.rsplit('-').next().unwrap_or("Unknown"))
        }
    };
    let mut summary = json!({"id":id,"_id":id});
    for key in ["appName", "buildVersion", "labelName"] {
        summary[key] = build[key].clone();
    }
    summary["platform"] = platform;
    summary["hash"] = build["hash"].clone();
    summary["firstSeenAt"] = non_null("firstSeenAt")
        .unwrap_or(&build["createdAt"])
        .clone();
    summary["lastSeenAt"] = non_null("lastSeenAt")
        .unwrap_or(&build["updatedAt"])
        .clone();
    for key in [
        "createdAt",
        "updatedAt",
        "downloadSizeBytes",
        "installedSizeBytes",
    ] {
        summary[key] = build[key].clone();
    }
    summary["technologies"] = non_null("technologies")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let mut manifest = json!({
        "status":non_null("manifestStatus").cloned().unwrap_or(json!("legacy_unverified")),
        "canonicalHash":build["manifestId"]
    });
    manifest["sourceHash"] = non_null("sourceManifestHash")
        .unwrap_or(&build["hash"])
        .clone();
    for (key, field) in [
        ("parserVersion", "manifestParserVersion"),
        ("processedAt", "manifestProcessedAt"),
        ("fileCount", "manifestFileCount"),
        ("fileBytes", "manifestFileBytes"),
        ("errorCode", "manifestErrorCode"),
    ] {
        manifest[key] = build[field].clone();
    }
    summary["manifest"] = manifest;
    Ok(serialize_value(&summary))
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn offer_metadata_http_node_oracle() {
        egdata_api_oracle::replay_mongo_oracle(include_str!(
            "../../egdata-api/tests/fixtures/offer-metadata-http-node.json"
        ))
        .await;
    }
}
