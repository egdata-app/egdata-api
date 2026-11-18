//! Legacy offer relationships, discovery metadata and their original Redis keys.
use super::{
    Routes,
    common::*,
    system::{query, selected_country},
};
use crate::state::AppState;
use axum::{
    body::{Body, Bytes},
    extract::{Path, State},
    http::{HeaderMap, StatusCode, Uri},
    response::Response,
};
use bson::{Bson, doc};
use egdata_core::{countries::AGE_RATINGS_COUNTRIES, ports::MongoFindOptions};
use egdata_infra::bson_json::bson_doc_to_js_json;
use serde_json::{Value, json};
use std::{collections::HashSet, future::Future};

pub(super) fn routes() -> Routes {
    Routes::new("/offers")
        .get("/events", events)
        .get("/{id}", detail)
        .post("/slugs", slugs)
        .post("/exists", exists)
        .get("/{id}/polls", polls)
        .get("/{id}/mappings", linked_document)
        .get("/{id}/media", linked_document)
        .get("/{id}/igdb", igdb)
        .get("/{id}/giveaways", giveaways)
        .get("/{id}/tops", tops)
        .get("/{id}/genres", genres)
        .get("/{id}/ratings", ratings)
        .get("/{id}/hltb", hltb)
        .get("/{id}/achievements", achievements)
        .get("/{id}/age-rating", age_rating)
        .get("/{id}/items", linked_items)
        .get("/{id}/assets", linked_items)
        .get("/{id}/features", features)
        .get("/{id}/technologies", linked_items)
        .get("/{id}/builds", linked_items)
        .get("/{id}/franchises", franchises)
        .get("/{id}/collections/{collection}", collection)
}
fn field_bson(row: &Value, key: &str) -> Bson {
    bson::to_bson(&row[key]).unwrap_or(Bson::Null)
}
fn truthy(value: &Value) -> bool {
    !value.is_null() && value != false && value.as_f64() != Some(0.0) && value != ""
}

fn error_404(message: &str) -> Error {
    Error::Json(StatusCode::NOT_FOUND, json!({"error":message}))
}
fn minute(value: &Value) -> Response {
    cache_header(ok(value), ONE_MINUTE)
}
async fn cached_minute(
    s: &AppState,
    key: String,
    ttl: u64,
    load: impl Future<Output = Result<Value>>,
) -> Result<Response> {
    if let Some(hit) = cached(s, &key).await? {
        return Ok(minute(&hit));
    }
    let value = load.await?;
    store(s, &key, &value, ttl).await?;
    Ok(minute(&value))
}
async fn events(State(s): State<AppState>) -> Result<Response> {
    Ok(minute(&json!(
        many(
            &s,
            "tags",
            doc! {"groupName":"event","status":"ACTIVE"},
            Default::default()
        )
        .await?
    )))
}
async fn linked_document(
    State(s): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
) -> Result<Response> {
    let (name, missing) = if uri.path().ends_with("/media") {
        ("media", "Media not found")
    } else {
        ("mappings", "Mappings not found")
    };
    cached_minute(&s, format!("{name}:{id}"), 86400, async {
        one(&s, name, doc! {"_id":&id})
            .await?
            .ok_or_else(|| not_found(missing))
    })
    .await
}
async fn igdb(State(s): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    Ok(ok(&one(&s, "igdb", doc! {"offerId":id})
        .await?
        .ok_or_else(|| error_404("IGDB data not found"))?))
}
async fn giveaways(State(s): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    cached_minute(&s, format!("giveaways:{id}"), 3600, async {
        Ok(json!(
            many(
                &s,
                "freegames",
                doc! {"id":id},
                MongoFindOptions {
                    sort: Some(doc! {"startDate":-1}),
                    ..Default::default()
                }
            )
            .await?
        ))
    })
    .await
}
async fn tops(State(s): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    cached_minute(&s, format!("tops:{id}:all"), 3600, async {
        let rows = many(
            &s,
            "game_positions",
            doc! {"offerId":id},
            Default::default(),
        )
        .await?;
        let mut result = serde_json::Map::new();
        for row in rows {
            let key = row
                .get("collectionId")
                .map(egdata_core::v1::serialization::js_string)
                .unwrap_or_else(|| "undefined".into());
            if let Some(position) = row.get("position") {
                result.insert(key, position.clone());
            } else {
                result.shift_remove(&key);
            }
        }
        Ok(Value::Object(result))
    })
    .await
}
async fn genres(State(s): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let offer = one(&s, "offers", doc! {"id":id})
        .await?
        .ok_or_else(|| error_404("Offer not found"))?;
    let rows = many(
        &s,
        "tags",
        doc! {"groupName":"genre","status":"ACTIVE"},
        Default::default(),
    )
    .await?;
    let tags = offer["tags"].as_array().ok_or(Error::Internal)?;
    Ok(ok(&json!(
        tags.iter()
            .filter(|t| rows.iter().any(|g| g.get("id") == t.get("id")))
            .collect::<Vec<_>>()
    )))
}
async fn ratings(State(s): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let offer = one(&s, "offers", doc! {"id":&id})
        .await?
        .ok_or_else(|| not_found("Offer not found"))?;
    cached_minute(&s, format!("ratings:{id}"), 3600, async {
        let sandbox = one(&s, "sandboxes", doc! {"_id":field_bson(&offer,"namespace")})
            .await?
            .ok_or_else(|| not_found("Sandbox not found"))?;
        let product = one(&s, "products", doc! {"_id":field_bson(&sandbox,"parent")})
            .await?
            .ok_or_else(|| not_found("Product not found"))?;
        one(&s, "ratings", doc! {"_id":field_bson(&product,"slug")})
            .await?
            .ok_or_else(|| not_found("Ratings not found"))
    })
    .await
}
async fn hltb(State(s): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    cached_minute(&s, format!("hltb:{id}"), 3600, async {
        one(&s, "offers", doc! {"id":&id})
            .await?
            .ok_or_else(|| not_found("Offer not found"))?;
        one(&s, "hltbs", doc! {"_id":id})
            .await?
            .filter(|v| {
                let id = &v["hltbId"];
                truthy(id) && id != "00000"
            })
            .ok_or_else(|| error_404("HowLongToBeat data not found for this offer"))
    })
    .await
}

async fn achievements(State(s): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let offer = s
        .mongo
        .find_one(
            "offers",
            doc! {"id":&id},
            Some(doc! {"namespace":1,"offerType":1}),
        )
        .await?
        .ok_or_else(|| not_found("Offer not found"))?;
    let key = format!("achievements:offer:{id}:v0.1");
    if let Some(hit) = cached(&s, &key).await? {
        return Ok(minute(&hit));
    }
    let rows=many(&s,"achievementsets",doc!{"sandboxId":offer.get("namespace").cloned().unwrap_or_default(),"isBase":offer.get_str("offerType")==Ok("BASE_GAME")},Default::default()).await?;
    if rows.is_empty() {
        return Ok(ok(&json!([])));
    }
    let value = Value::Array(rows);
    store(&s, &key, &value, 3600).await?;
    Ok(minute(&value))
}
async fn age_rating(
    State(s): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Response> {
    let single = query(&uri, "single").is_some_and(|s| !s.is_empty());
    let key = format!("age-rating:{id}:{}", if single { "single" } else { "all" });
    if let Some(hit) = cached(&s, &key).await? {
        return Ok(minute(&hit));
    }
    let offer = one(&s, "offers", doc! {"id":id})
        .await?
        .ok_or_else(|| not_found("Offer not found"))?;
    let sandbox = one(&s, "sandboxes", doc! {"_id":field_bson(&offer,"namespace")})
        .await?
        .ok_or_else(|| not_found("Sandbox not found"))?;
    let value = sandbox
        .get("ageGatings")
        .filter(|v| truthy(v))
        .ok_or_else(|| not_found("Sandbox not found"))?;
    if single {
        let country = selected_country(&uri, &headers);
        let rating = AGE_RATINGS_COUNTRIES
            .iter()
            .find(|(_, countries)| countries.contains(&country.as_str()))
            .map_or("Generic", |(name, _)| *name);
        return Ok(minute(
            &json!({(rating):value.get(rating).filter(|v|truthy(v)).ok_or_else(||not_found("Age rating not found"))?}),
        ));
    }
    store(&s, &key, value, 3600).await?;
    Ok(minute(value))
}

async fn franchises(State(s): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let key = format!("franchises:{id}:v0.2");
    if let Some(hit) = cached(&s, &key).await? {
        return Ok(minute(&hit));
    }
    let rows = many(&s, "franchises", doc! {"offers":id}, Default::default()).await?;
    if rows.is_empty() {
        return Ok(minute(&json!([])));
    }
    let mut seen = HashSet::new();
    let ids = rows
        .iter()
        .flat_map(|f| f["offers"].as_array())
        .flatten()
        .filter(|id| seen.insert((*id).clone()))
        .map(|id| bson::to_bson(id).unwrap_or_default())
        .collect::<Vec<_>>();
    let offers = many(
        &s,
        "offers",
        doc! {"id":{"$in":ids}},
        MongoFindOptions {
            projection: Some(doc! {"id":1,"namespace":1}),
            ..Default::default()
        },
    )
    .await?;
    let namespaces = offers
        .iter()
        .filter_map(|o| Some((o.get("id")?, o.get("namespace")?)))
        .collect::<std::collections::HashMap<_, _>>();
    let value = Value::Array(
        rows.into_iter()
            .filter(|f| {
                f["offers"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|id| namespaces.get(id))
                    .filter(|v| !v.is_null() && v.as_str() != Some(""))
                    .collect::<HashSet<_>>()
                    .len()
                    > 1
            })
            .collect(),
    );
    store(&s, &key, &value, 3600).await?;
    Ok(minute(&value))
}
async fn collection(
    State(s): State<AppState>,
    Path((id, collection)): Path<(String, String)>,
) -> Result<Response> {
    one(&s, "offers", doc! {"id":&id})
        .await?
        .ok_or_else(|| error_404("Offer not found"))?;
    let (game, collection) = tokio::join!(
        one(
            &s,
            "game_positions",
            doc! {"collectionId":&collection,"offerId":id}
        ),
        one(&s, "collections_v2", doc! {"_id":&collection})
    );
    let (Some(mut game), Some(collection)) = (game?, collection?) else {
        return Err(error_404("Game not found"));
    };
    if let Some(name) = collection.get("name") {
        game["name"] = name.clone()
    } else if let Some(row) = game.as_object_mut() {
        row.shift_remove("name");
    }
    Ok(ok(&game))
}
async fn features(State(s): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let offer = s
        .mongo
        .find_one("offers", doc! {"id": &id}, None)
        .await?
        .ok_or_else(|| not_found("Offer not found"))?;
    let subs = s
        .mongo
        .find_many(
            "offersubitems",
            doc! {"_id": &id},
            MongoFindOptions {
                projection: Some(doc! {"_id": 1, "subItems": 1}),
                ..Default::default()
            },
        )
        .await?;
    let items = super::top_reads::linked_feature_items(&s, &id, &offer, subs).await?;
    Ok(ok(&json!(super::top_reads::features_from_items(
        &items, &offer
    )?)))
}

#[cfg(test)]
#[tokio::test]
async fn legacy_offer_features_node_oracle() {
    crate::v1::mongo_read_oracle::replay_legacy_oracle(include_str!(
        "../../tests/fixtures/legacy-offer-features-http-node.json"
    ))
    .await;
}

async fn linked_items(
    State(s): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
) -> Result<Response> {
    let field = uri.path().rsplit('/').next().unwrap_or("");
    let key = match field {
        "assets" => Some(format!("assets:offer:{id}:v0.2")),
        "items" => Some(format!("items:offer:{id}")),
        "builds" => Some(format!("offer:builds:v2:{id}")),
        _ => None,
    };
    let policy = if field == "builds" {
        "public, max-age=86400"
    } else {
        ONE_MINUTE
    };
    if let Some(key) = &key
        && let Some(hit) = cached(&s, key).await?
    {
        return Ok(cache_header(ok(&hit), policy));
    }
    let offer = one(&s, "offers", doc! {"id": &id})
        .await?
        .ok_or_else(|| error_404("Offer not found"))?;
    let direct = offer["items"].as_array();
    if direct.is_none() && matches!(field, "items" | "builds" | "technologies") {
        return Err(Error::Internal);
    }
    let subs = many(
        &s,
        "offersubitems",
        doc! {"_id":&id},
        MongoFindOptions {
            projection: Some(doc! {"_id":1,"subItems":1}),
            ..Default::default()
        },
    )
    .await?;
    let mut ids: Vec<Bson> = direct
        .ok_or(Error::Internal)?
        .iter()
        .map(|v| field_bson(v, "id"))
        .collect();
    for sub in subs {
        ids.extend(
            sub["subItems"]
                .as_array()
                .ok_or(Error::Internal)?
                .iter()
                .map(|v| field_bson(v, "id")),
        );
    }
    let items = many(
        &s,
        "items",
        doc! {"$or":[{"id":{"$in":ids}},{"linkedOffers":&id}]},
        MongoFindOptions {
            projection: (field == "assets").then(|| doc! {"id":1}),
            ..Default::default()
        },
    )
    .await?;
    if field == "items" {
        return Ok(minute(&Value::Array(items)));
    }
    let item_ids = items
        .iter()
        .map(|v| field_bson(v, "id"))
        .collect::<Vec<_>>();
    let assets = many(
        &s,
        "assets",
        doc! {"itemId":{"$in":item_ids}},
        Default::default(),
    )
    .await?;
    let value = if field == "assets" {
        Value::Array(assets)
    } else {
        let apps = assets
            .iter()
            .map(|v| field_bson(v, "artifactId"))
            .collect::<Vec<_>>();
        if field == "technologies" {
            let rows = s
                .mongo
                .aggregate(
                    "builds",
                    vec![
                        doc! {"$match":{"appName":{"$in":apps}}},
                        doc! {"$sort":{"createdAt":-1}},
                        doc! {"$group":{"_id":"$appName","doc":{"$first":"$$ROOT"}}},
                    ],
                )
                .await?;
            let mut seen = HashSet::new();
            let mut tech = Vec::new();
            for row in rows {
                let row = bson_doc_to_js_json(&row);
                let build = row
                    .get("doc")
                    .filter(|doc| !doc.is_null())
                    .ok_or(Error::Internal)?;
                let Some(values) = build.get("technologies") else {
                    continue;
                };
                let entries = values
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or_else(|| std::slice::from_ref(values));
                for t in entries {
                    if truthy(t) && seen.insert(t.get("technology").cloned()) {
                        tech.push(t.clone());
                    }
                }
            }
            return Ok(ok(&Value::Array(tech)));
        }
        let builds = many(
            &s,
            "builds",
            doc! {"appName":{"$in":apps}},
            MongoFindOptions {
                sort: Some(doc! {"updatedAt":-1}),
                limit: Some(50),
                ..Default::default()
            },
        )
        .await?;
        Value::Array(
            builds
                .iter()
                .map(|build| super::builds::summary(build, None))
                .collect::<Result<_>>()?,
        )
    };
    store(&s, &key.expect("cached relationship"), &value, 3600).await?;
    Ok(cache_header(ok(&value), policy))
}

async fn detail(State(s): State<AppState>, Path(id): Path<String>, uri: Uri) -> Result<Response> {
    use egdata_core::localization::{
        get_localized_cache_ttl_seconds, locale_cache_segment, parse_locale,
    };
    let locale = parse_locale(query(&uri, "locale").as_deref())
        .map_err(|e| Error::Json(StatusCode::BAD_REQUEST, json!({"message":e.to_string()})))?;
    let started = std::time::Instant::now();
    let key = format!("offer:{id}:{}:v0.1", locale_cache_segment(&locale));
    if let Some(hit) = cached(&s, &key).await? {
        return Ok(minute(&hit));
    }
    let mut offer = one(&s, "offers", doc! {"id":id})
        .await?
        .ok_or_else(|| not_found("Offer not found or Price not found"))?;
    if offer.get("customAttributes").is_some_and(|v| v.is_array()) {
        offer["customAttributes"] = super::catalog::items::attributes(&offer["customAttributes"]);
    }
    let localized = crate::v1::system::localize_offers(&s, &[offer], &locale)
        .await?
        .remove(0);
    store(
        &s,
        &key,
        &localized,
        get_localized_cache_ttl_seconds(&localized, 60),
    )
    .await?;
    let mut res = ok(&localized);
    res.headers_mut().insert(
        "server-timing",
        format!("db;dur={}", started.elapsed().as_millis())
            .parse()
            .unwrap(),
    );
    Ok(res)
}
async fn exists(State(s): State<AppState>, body: Bytes) -> Result<Response> {
    let input: Value = serde_json::from_slice(&body)?;
    let ids = input["offers"].as_array().ok_or(Error::Internal)?;
    let rows = many(
        &s,
        "offers",
        doc! {"id":{"$in":bson::to_bson(ids).map_err(|_|Error::Internal)?}},
        MongoFindOptions {
            projection: Some(doc! {"id":1,"_id":0}),
            ..Default::default()
        },
    )
    .await?;
    let found: Vec<_> = rows.iter().map(|r| &r["id"]).collect();
    let missing: Vec<_> = ids.iter().filter(|id| !found.contains(id)).collect();
    Ok(ok(
        &json!({"existingOffers":found,"nonExistingOffers":missing}),
    ))
}
async fn slugs(State(s): State<AppState>, body: Bytes) -> Result<Response> {
    use egdata_core::v1::serialization::js_string;
    let input: Value = serde_json::from_slice(&body)?;
    if input.is_null() {
        return Err(Error::Internal);
    }
    let ids=input["slugs"].as_array().filter(|ids|!ids.is_empty()).ok_or_else(||Error::Json(StatusCode::BAD_REQUEST,json!({"message":"Missing or invalid slugs parameter. Expecting an array of strings."})))?;
    let mut expanded = Vec::with_capacity(ids.len() * 2);
    for id in ids {
        expanded.push(bson::to_bson(id).map_err(|_| Error::Internal)?);
        expanded.push(Bson::String(format!("{}/home", js_string(id))));
    }
    let candidates = crate::v1::offers::slug_candidates(&s, &expanded).await?;
    let mut result = Vec::new();
    for slug in ids {
        let home = format!("{}/home", js_string(slug));
        let matches =
            |field: Option<&Value>| field.is_some_and(|v| v == slug || v.as_str() == Some(&home));
        let found = candidates.iter().find(|row| {
            matches(row.get("productSlug"))
                || matches(row.get("urlSlug"))
                || row["offerMappings"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|m| matches(m.get("pageSlug"))))
                || row["customAttributes"].as_array().is_some_and(|a| {
                    a.iter().any(|m| {
                        (m["key"] == "com.epicgames.app.productSlug" || m["key"] == "slug")
                            && matches(m.get("value"))
                    })
                })
        });
        let mut entry = json!({"slug":slug});
        for key in ["id", "namespace"] {
            if let Some(row) = found {
                if let Some(v) = row.get(key) {
                    entry[key] = v.clone()
                }
            } else {
                entry[key] = Value::Null
            }
        }
        result.push(entry);
    }
    Ok(minute(&Value::Array(result)))
}
async fn polls(State(s): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let key = format!("polls:{id}");
    if let Some(hit) = cached(&s, &key).await? {
        return Ok(minute(&hit));
    }
    let offer = one(&s, "offers", doc! {"id":id})
        .await?
        .ok_or_else(|| not_found("Offer not found"))?;
    let filter = doc! {"_id":field_bson(&offer,"namespace")};
    one(&s, "sandboxes", filter.clone())
        .await?
        .ok_or_else(|| not_found("Sandbox not found"))?;
    let rows = many(&s, "ratings_polls", filter, Default::default()).await?;
    if let Some(value) = rows.first() {
        store(&s, &key, value, 3600).await?;
        return Ok(minute(value));
    }
    s.cache.set(&key, "", 3600).await?;
    Ok(cache_header(
        Response::builder()
            .header("content-type", "application/json")
            .body(Body::empty())
            .unwrap(),
        ONE_MINUTE,
    ))
}

#[cfg(test)]
#[tokio::test]
async fn legacy_offers_http_node_oracle() {
    crate::v1::mongo_read_oracle::replay_legacy_oracle(include_str!(
        "../../tests/fixtures/legacy-offers-http-node.json"
    ))
    .await;
}
