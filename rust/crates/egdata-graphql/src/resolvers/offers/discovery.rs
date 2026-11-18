use super::*;

pub(super) async fn resolve(
    field: &str,
    args: &Value,
    services: &GraphqlServices,
) -> Result<Option<Value>> {
    let db = services.mongo.as_ref();
    let region = country_to_region(args["country"].as_str(), "US");
    let limit = clamp(
        args.get("limit"),
        if field == "upcoming" {
            15
        } else {
            DEFAULT_PAGE_SIZE
        },
        MAX_PAGE_SIZE,
    );
    let page = clamp(args.get("page"), 1, MAX_PAGE);
    let skip = ((page - 1) * limit) as u64;
    let page_options = |sort: Document| MongoFindOptions {
        sort: Some(sort),
        skip: Some(skip),
        limit: Some(limit as i64),
        ..Default::default()
    };
    let (rows, collection, filter, locale) = match field {
        "upcoming" => {
            let locale = resolve_locale(args, &Value::Null)?;
            let now = bson::DateTime::from_chrono((services.now)());
            let end =
                bson::DateTime::parse_rfc3339_str("2099-01-01T00:00:00Z").expect("valid cutoff");
            let pipeline = vec![
                doc! {"$match":{
                    "releaseDate":{"$gt":now,"$ne":Bson::Null,"$lt":end},
                    "offerType":{"$in":["BASE_GAME","DLC"]}
                }},
                doc! {"$sort":{"releaseDate":1}},
                doc! {"$skip":skip as i64},
                doc! {"$limit":limit as i64},
            ];
            let rows = db
                .aggregate("offers", pipeline)
                .await
                .map_err(internal_error)?;
            let elements = localize_ordered_offers(db, ordered(&rows), &locale).await?;
            let total = db
                .count_documents("offers", doc! {"releaseDate":{"$gt":now}})
                .await
                .map_err(internal_error)?;
            return Ok(Some(
                json!({"elements":elements,"total":total,"page":page,"limit":limit}),
            ));
        }
        "latestReleased" => {
            let locale = resolve_locale(args, &Value::Null)?;
            let now = bson::DateTime::from_chrono((services.now)());
            let filter = doc! {
                "effectiveDate":{"$lte":now},
                "offerType":{"$in":["BASE_GAME","DLC"]},
                "releaseDate":{"$ne":Bson::Null,"$lte":now}
            };
            let rows = db
                .find_many("offers", filter, page_options(doc! {"releaseDate":-1}))
                .await
                .map_err(internal_error)?;
            (
                ordered(&rows),
                "offers",
                doc! {"releaseDate":{"$ne":Bson::Null},"offerType":{"$in":["BASE_GAME"]}},
                locale,
            )
        }
        "topSellers" | "topWishlisted" => {
            let locale = resolve_locale(args, &Value::Null)?;
            let collection_id = if field == "topSellers" {
                "top-sellers"
            } else {
                "top-wishlisted"
            };
            let filter = doc! {"collectionId":collection_id,"position":{"$gt":0}};
            let positions = db
                .find_many(
                    "game_positions",
                    filter.clone(),
                    page_options(doc! {"position":1}),
                )
                .await
                .map_err(internal_error)?;
            let ids = values(&positions, "offerId");
            let offers = db
                .find_many("offers", doc! {"id":{"$in":ids}}, Default::default())
                .await
                .map_err(internal_error)?;
            let mut rows = ordered(&offers);
            for row in &mut rows {
                if let Some(position) = positions
                    .iter()
                    .find(|p| p.get_str("offerId").ok() == row["id"].as_str())
                    .and_then(|p| p.get("position"))
                {
                    row["position"] = bson_to_serialized_json(position);
                }
            }
            rows.sort_by(|a, b| {
                a["position"]
                    .as_f64()
                    .zip(b["position"].as_f64())
                    .and_then(|(a, b)| a.partial_cmp(&b))
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            (rows, "game_positions", filter, locale)
        }
        "featuredDiscounts" => {
            let locale = resolve_locale(args, &Value::Null)?;
            let positions = db
                .find_many(
                    "game_positions",
                    doc! {"position":{"$gt":0}},
                    MongoFindOptions {
                        sort: Some(doc! {"position":1}),
                        limit: Some(200),
                        ..Default::default()
                    },
                )
                .await
                .map_err(internal_error)?;
            let ids = values(&positions, "offerId");
            let (offers, prices) = tokio::try_join!(
                db.find_many(
                    "offers",
                    doc! {"id":{"$in":&ids},"offerType":{"$in":["BASE_GAME","DLC"]}},
                    Default::default()
                ),
                db.find_many(
                    "pricev2",
                    doc! {"offerId":{"$in":ids},"region":region,"price.discount":{"$gt":0}},
                    Default::default()
                )
            )
            .map_err(internal_error)?;
            let rows = offers
                .iter()
                .filter(|o| prices.iter().any(|p| p.get("offerId") == o.get("id")))
                .take(20)
                .map(ordered_offer)
                .collect();
            return Ok(Some(Value::Array(
                localize_ordered_offers(db, rows, &locale).await?,
            )));
        }
        "event" => {
            let locale = resolve_locale(args, &Value::Null)?;
            let id = required_string(args, "id")?;
            if db
                .find_one("tags", doc! {"id":{"$eq":id},"groupName":"event"}, None)
                .await
                .map_err(internal_error)?
                .is_none()
            {
                return Ok(Some(Value::Null));
            }
            let filter = doc! {"tags":{"$elemMatch":{"id":{"$eq":id}}}};
            let pipeline = vec![
                doc! {"$match":filter.clone()},
                doc! {"$lookup":{
                    "from":"pricev2","let":{"offerId":"$id"},"as":"price",
                    "pipeline":[
                        {"$match":{"$expr":{"$and":[{"$eq":["$offerId","$$offerId"]},{"$eq":["$region",region]}]}}},
                        {"$sort":{"updatedAt":-1}},
                        {"$limit":1}
                    ]
                }},
                doc! {"$unwind":{"path":"$price","preserveNullAndEmptyArrays":true}},
                doc! {"$sort":{"price.price.discount":-1}},
                doc! {"$skip":skip as i64},
                doc! {"$limit":limit as i64},
            ];
            let rows = db
                .aggregate("offers", pipeline)
                .await
                .map_err(internal_error)?;
            let elements = localize_ordered_offers(db, ordered(&rows), &locale).await?;
            let total = db
                .count_documents("offers", filter)
                .await
                .map_err(internal_error)?;
            return Ok(Some(
                json!({"elements":elements,"total":total,"page":page,"limit":limit}),
            ));
        }
        "genres" => {
            let locale = resolve_locale(args, &Value::Null)?;
            let now = bson::DateTime::from_chrono((services.now)());
            return Ok(Some(genres(db, now, &locale).await?));
        }
        "latestAchievements" => {
            let locale = resolve_locale(args, &Value::Null)?;
            let now = bson::DateTime::from_chrono((services.now)());
            return Ok(Some(latest_achievements(db, now, region, &locale).await?));
        }
        _ => return Ok(None),
    };
    let elements = localize_ordered_offers(db, rows, &locale).await?;
    let total = db
        .count_documents(collection, filter)
        .await
        .map_err(internal_error)?;
    Ok(Some(
        json!({"elements":elements,"total":total,"page":page,"limit":limit}),
    ))
}

fn values(rows: &[Document], field: &str) -> Vec<Bson> {
    rows.iter()
        .map(|row| row.get(field).cloned().unwrap_or(Bson::Null))
        .collect()
}

fn ordered(rows: &[Document]) -> Vec<Value> {
    rows.iter().map(ordered_offer).collect()
}

async fn genres(db: &dyn MongoStorePort, now: bson::DateTime, locale: &str) -> Result<Value> {
    let genres = db
        .find_many(
            "tags",
            doc! {"groupName":"genre","status":"ACTIVE"},
            Default::default(),
        )
        .await
        .map_err(internal_error)?;
    let results = futures::future::try_join_all(genres.iter().map(|genre| async move {
        let id = genre.get("id").cloned().unwrap_or(Bson::Null);
        let filter = doc! {
            "tags":{"$elemMatch":{"id":id}},
            "offerType":"BASE_GAME",
            "releaseDate":{"$lte":now}
        };
        let options = MongoFindOptions {
            sort: Some(doc! {"releaseDate":-1}),
            limit: Some(3),
            ..Default::default()
        };
        let rows = db
            .find_many("offers", filter, options)
            .await
            .map_err(internal_error)?;
        let offers =
            localize_offers(db, rows.iter().map(document_to_json).collect(), locale).await?;
        let summaries = offers.iter().map(genre_offer).collect::<Result<Vec<_>>>()?;
        Ok::<_, Error>(json!({"genre":document_to_json(genre),"offers":summaries}))
    }))
    .await?;
    Ok(Value::Array(results))
}

fn genre_offer(offer: &Value) -> Result<Value> {
    let mut summary = serde_json::Map::new();
    for field in ["id", "title"] {
        if let Some(value) = offer.get(field) {
            summary.insert(field.into(), value.clone());
        }
    }
    let images = offer["keyImages"]
        .as_array()
        .ok_or_else(|| Error::new("Cannot read properties of undefined (reading 'find')"))?;
    let image = [
        "OfferImageTall",
        "Thumbnail",
        "DieselGameBoxTall",
        "DieselStoreFrontTall",
    ]
    .into_iter()
    .find_map(|ty| images.iter().find(|image| image["type"] == ty))
    .or_else(|| images.first());
    if let Some(image) = image {
        summary.insert("image".into(), image.clone());
    }
    Ok(Value::Object(summary))
}

async fn latest_achievements(
    db: &dyn MongoStorePort,
    now: bson::DateTime,
    region: &str,
    locale: &str,
) -> Result<Value> {
    let mut found = Vec::new();
    for page in 0..10 {
        let filter =
            doc! {"offerType":{"$in":["BASE_GAME"]},"tags.id":"19847","effectiveDate":{"$lte":now}};
        let options = MongoFindOptions {
            sort: Some(doc! {"effectiveDate":-1}),
            skip: Some(page * 15),
            limit: Some(15),
            ..Default::default()
        };
        let rows = db
            .find_many("offers", filter, options)
            .await
            .map_err(internal_error)?;
        if rows.is_empty() {
            break;
        }
        let (sets, _prices) = tokio::try_join!(
            db.find_many(
                "achievementsets",
                doc! {"sandboxId":{"$in":values(&rows,"namespace")},"isBase":true},
                Default::default()
            ),
            db.find_many(
                "pricev2",
                doc! {"offerId":{"$in":values(&rows,"id")},"region":region},
                Default::default()
            )
        )
        .map_err(internal_error)?;
        found.extend(
            rows.iter()
                .filter(|row| {
                    sets.iter()
                        .any(|set| set.get("sandboxId") == row.get("namespace"))
                })
                .map(ordered_offer),
        );
        if found.len() >= 20 || rows.len() < 15 {
            break;
        }
    }
    found.truncate(20);
    Ok(Value::Array(
        localize_ordered_offers(db, found, locale).await?,
    ))
}
