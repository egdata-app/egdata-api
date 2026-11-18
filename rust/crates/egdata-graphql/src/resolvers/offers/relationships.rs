use std::collections::BTreeMap;

use egdata_core::{
    attributes::{FeatureTag, attributes_to_object_value, get_game_features},
    countries::AGE_RATINGS_COUNTRIES,
};

use super::*;

pub(super) async fn resolve(
    parent_type: &str,
    field: &str,
    parent: &Value,
    args: &Value,
    services: &GraphqlServices,
) -> Result<Option<Value>> {
    let db = services.mongo.as_ref();
    let result = match (parent_type, field) {
        ("Offer", "suggestions") => {
            let locale = resolve_locale(args, parent)?;
            let tags = reference_ids(&parent["tags"]);
            if tags.is_empty() {
                return Ok(Some(json!([])));
            }
            let genres = db
                .find_many(
                    "tags",
                    doc! {"id":{"$in":tags},"groupName":"genre"},
                    Default::default(),
                )
                .await
                .map_err(internal_error)?;
            let ids = genres
                .into_iter()
                .filter_map(|tag| tag.get("id").cloned())
                .collect::<Vec<_>>();
            let offers = db
                .find_many(
                    "offers",
                    doc! {
                        "tags":{"$elemMatch":{"id":{"$in":ids}}},
                        "id":{"$ne":parent["id"].as_str()},
                        "namespace":{"$ne":parent["namespace"].as_str()},
                        "offerType":{"$in":["BASE_GAME","DLC"]}
                    },
                    MongoFindOptions {
                        sort: Some(doc! {"lastModifiedDate":-1}),
                        limit: Some(25),
                        ..Default::default()
                    },
                )
                .await
                .map_err(internal_error)?;
            Value::Array(
                localize_ordered_offers(db, offers.iter().map(ordered_offer).collect(), &locale)
                    .await?,
            )
        }
        ("Offer", "ratings") => {
            let sandbox = db
                .find_one("sandboxes", doc! {"_id":parent["namespace"].as_str()}, None)
                .await
                .map_err(internal_error)?;
            let Some(product_id) = sandbox
                .as_ref()
                .and_then(|s| s.get("parent"))
                .filter(|id| super::super::js_truthy(&bson_to_serialized_json(id)))
            else {
                return Ok(Some(Value::Null));
            };
            let product = db
                .find_one("products", doc! {"_id":{"$eq":product_id.clone()}}, None)
                .await
                .map_err(internal_error)?;
            let Some(product) = product else {
                return Ok(Some(Value::Null));
            };
            find_one(
                db,
                "ratings",
                doc! {"_id":product.get("slug").cloned().unwrap_or(Bson::Null)},
            )
            .await?
        }
        ("Offer", "polls") => {
            find_one(
                db,
                "ratings_polls",
                doc! {"_id":{"$eq":parent["namespace"].as_str()}},
            )
            .await?
        }
        ("Offer", "hltb") => {
            find_one(db, "hltbs", doc! {"_id":{"$eq":parent["id"].as_str()}}).await?
        }
        ("Offer", "sandbox") => {
            services
                .loaders
                .one_value(Lookup::Sandbox, loader_id(parent, "namespace")?)
                .await?
        }
        ("Offer", "positions") => {
            let rows = db
                .find_many(
                    "game_positions",
                    doc! {"offerId":parent["id"].as_str()},
                    Default::default(),
                )
                .await
                .map_err(internal_error)?;
            let mut positions = serde_json::Map::new();
            for row in &rows {
                if let (Ok(collection), Some(value)) =
                    (row.get_str("collectionId"), row.get("position"))
                {
                    positions.insert(collection.into(), bson_to_serialized_json(value));
                }
            }
            Value::Object(positions)
        }
        ("Offer", "ageRating") => {
            let sandbox = find_one(
                db,
                "sandboxes",
                doc! {"_id":{"$eq":parent["namespace"].as_str()}},
            )
            .await?;
            let country = args.get("country").map_or(Some("US"), Value::as_str);
            let system = AGE_RATINGS_COUNTRIES
                .iter()
                .find(|(_, countries)| country.is_some_and(|c| countries.contains(&c)))
                .map_or("Generic", |(system, _)| *system);
            let rating = &sandbox["ageGatings"][system];
            if super::super::js_truthy(rating) {
                rating.clone()
            } else {
                Value::Null
            }
        }
        ("Offer", "features") => features(db, parent).await?,
        ("Franchise", "allOffers") => {
            let locale = resolve_locale(args, &Value::Null)?;
            let ids = parent["offers"]
                .as_array()
                .into_iter()
                .flatten()
                .take(500)
                .filter_map(Value::as_str)
                .collect::<Vec<_>>();
            let rows = db
                .find_many("offers", doc! {"id":{"$in":ids}}, Default::default())
                .await
                .map_err(internal_error)?;
            Value::Array(
                localize_ordered_offers(db, rows.iter().map(ordered_offer).collect(), &locale)
                    .await?,
            )
        }
        _ => return Ok(None),
    };
    Ok(Some(result))
}

async fn find_one(db: &dyn MongoStorePort, collection: &str, filter: Document) -> Result<Value> {
    Ok(db
        .find_one(collection, filter, None)
        .await
        .map_err(internal_error)?
        .as_ref()
        .map(document_to_json)
        .unwrap_or(Value::Null))
}

fn reference_ids(references: &Value) -> Vec<Bson> {
    references
        .as_array()
        .into_iter()
        .flatten()
        .map(|entry| bson::to_bson(&entry["id"]).unwrap_or(Bson::Null))
        .collect()
}

async fn features(db: &dyn MongoStorePort, parent: &Value) -> Result<Value> {
    let id = parent["id"].as_str();
    let subitems = db
        .find_many(
            "offersubitems",
            doc! {"_id":id},
            MongoFindOptions {
                projection: Some(doc! {"_id":1,"subItems":1}),
                ..Default::default()
            },
        )
        .await
        .map_err(internal_error)?;
    let mut ids = reference_ids(&parent["items"]);
    for row in &subitems {
        ids.extend(reference_ids(&document_to_json(row)["subItems"]));
    }
    let items = db
        .find_many(
            "items",
            doc! {"$or":[{"id":{"$in":ids}},{"linkedOffers":id}]},
            Default::default(),
        )
        .await
        .map_err(internal_error)?;
    let mut attrs = BTreeMap::new();
    for item in &items {
        attrs.extend(attributes_to_object_value(
            &document_to_json(item)["customAttributes"],
        ));
    }
    // The known feature IDs are numeric strings. JS enumerates numeric object keys in ascending order.
    let mut tags = BTreeMap::new();
    for tag in parent["tags"].as_array().into_iter().flatten() {
        if let Some(id) = tag["id"].as_str()
            && let Ok(index) = id.parse::<u32>()
            && id == index.to_string()
        {
            tags.insert(
                index,
                FeatureTag {
                    id: id.into(),
                    name: tag["name"].as_str().unwrap_or_default().into(),
                },
            );
        }
    }
    Ok(json!(get_game_features(
        &attrs,
        &tags.into_values().collect::<Vec<_>>()
    )))
}
