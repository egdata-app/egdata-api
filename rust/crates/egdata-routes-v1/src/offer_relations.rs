//! Offer relationship reads from `src/v1/routes/offer-details.ts`.
use super::{
    RouteGroup,
    helpers::{parse_strict_query_uri, read_response},
    offer_prices,
    offer_prices::one,
    offers,
    system::{
        cached_length, internal_error, localize_ordered_rows, serialize_stored_localized_offer,
        stored_string_key, stored_text,
    },
};
use crate::state::AppState;
use axum::{
    extract::{Path, Request, State},
    http::Uri,
};
use bson::{Bson, Document, doc};
use egdata_core::{
    ports::MongoFindOptions,
    v1::{ProblemError, localization_meta, not_found, regional_params, serialize_value},
};
use serde_json::{Value, json};
use std::collections::HashMap;

const DYNAMIC_TTL: u64 = 60;
const STABLE_TTL: u64 = 3600;
const COLLECTION_PREFIX: &str = "com.epicgames.app.collectionOfferIds.";
const RELATED_LIMIT: i64 = 25;
const SUGGESTION_LIMIT: i64 = 25;

async fn many(
    state: &AppState,
    collection: &str,
    filter: Document,
    options: MongoFindOptions,
) -> Result<Vec<Document>, ProblemError> {
    state
        .mongo
        .find_many(collection, filter, options)
        .await
        .map_err(|_| internal_error())
}

enum Relation {
    Related,
    Suggestions,
    Collection,
    Bundle,
    InBundle,
    HasPrepurchase,
    HasRegular,
}

pub fn route_group(prefix: &str) -> RouteGroup {
    RouteGroup::new(prefix)
        .get(
            "/offers/{id}/related",
            |State(s), Path(id): Path<String>, r: Request| async move {
                let out = dispatch(&s, r.uri(), &id, Relation::Related).await;
                read_response(&r, out)
            },
        )
        .get(
            "/offers/{id}/suggestions",
            |State(s), Path(id): Path<String>, r: Request| async move {
                let out = dispatch(&s, r.uri(), &id, Relation::Suggestions).await;
                read_response(&r, out)
            },
        )
        .get(
            "/offers/{id}/collection",
            |State(s), Path(id): Path<String>, r: Request| async move {
                let out = dispatch(&s, r.uri(), &id, Relation::Collection).await;
                read_response(&r, out)
            },
        )
        .get(
            "/offers/{id}/collections/{collection}",
            |State(s), Path((id, collection)): Path<(String, String)>, r: Request| async move {
                let out = match (
                    egdata_core::v1::require_id_param(Some(&id), "id"),
                    egdata_core::v1::require_id_param(Some(&collection), "collection"),
                ) {
                    (Ok(id), Ok(collection)) => collection_entry(&s, &id, &collection).await,
                    (Err(error), _) | (_, Err(error)) => Err(error),
                };
                read_response(&r, out)
            },
        )
        .get(
            "/offers/{id}/bundle",
            |State(s), Path(id): Path<String>, r: Request| async move {
                let out = dispatch(&s, r.uri(), &id, Relation::Bundle).await;
                read_response(&r, out)
            },
        )
        .get(
            "/offers/{id}/in-bundle",
            |State(s), Path(id): Path<String>, r: Request| async move {
                let out = dispatch(&s, r.uri(), &id, Relation::InBundle).await;
                read_response(&r, out)
            },
        )
        .get(
            "/offers/{id}/has-prepurchase",
            |State(s), Path(id): Path<String>, r: Request| async move {
                let out = dispatch(&s, r.uri(), &id, Relation::HasPrepurchase).await;
                read_response(&r, out)
            },
        )
        .get(
            "/offers/{id}/has-regular",
            |State(s), Path(id): Path<String>, r: Request| async move {
                let out = dispatch(&s, r.uri(), &id, Relation::HasRegular).await;
                read_response(&r, out)
            },
        )
}

async fn dispatch(
    state: &AppState,
    uri: &Uri,
    raw_id: &str,
    relation: Relation,
) -> Result<(Value, Value), ProblemError> {
    let id = egdata_core::v1::require_id_param(Some(raw_id), "id")?;
    let query = parse_strict_query_uri(uri, &["country", "locale"])?;
    let region = regional_params(
        query.get("country").map(String::as_str),
        query.get("locale").map(String::as_str),
    )?;
    match relation {
        Relation::Related => related(state, &id, &region).await,
        Relation::Suggestions => suggestions(state, &id, &region).await,
        Relation::Collection => collection(state, &id, &region).await,
        Relation::Bundle => bundle(state, &id, &region).await,
        Relation::InBundle => in_bundle(state, &id, &region).await,
        Relation::HasPrepurchase => has_prepurchase(state, &id, &region).await,
        Relation::HasRegular => has_regular(state, &id, &region).await,
    }
}

async fn cached<F, Fut>(
    state: &AppState,
    operation: &str,
    parts: &[(&str, Value)],
    ttl: u64,
    load: F,
) -> Result<Value, ProblemError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<Value, ProblemError>>,
{
    offers::cached(
        state,
        operation,
        parts
            .iter()
            .map(|(key, value)| (*key, value.clone()))
            .collect(),
        ttl,
        load,
    )
    .await
}

fn regional_meta(
    region: &egdata_core::v1::RegionalParams,
    count: Option<Value>,
    limit: Option<usize>,
    localization: &Value,
) -> Value {
    let mut meta = offers::regional_meta(region);
    if let Some(count) = count {
        meta["count"] = count;
    }
    if let Some(limit) = limit {
        meta["limit"] = json!(limit);
    }
    meta.as_object_mut()
        .unwrap()
        .append(egdata_http_core::shared::json::spread(localization).as_object_mut().unwrap());
    meta
}

async fn serialize_list(
    state: &AppState,
    rows: &[Document],
    region: &str,
    locale: &str,
) -> Result<(Vec<Value>, Value), ProblemError> {
    let ids = rows
        .iter()
        .map(|row| stored_string_key(row.get("id")))
        .collect::<Result<Vec<_>, _>>()?;
    let prices = load_prices(state, &ids, region).await?;
    let matches = ids.iter().map(|id| prices.get(id)).collect::<Vec<_>>();
    serialize_with_prices(state, rows, &matches, locale).await
}

async fn load_prices(
    state: &AppState,
    ids: &[String],
    region: &str,
) -> Result<HashMap<String, Document>, ProblemError> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    many(
        state,
        "pricev2",
        doc! {"offerId":{"$in":ids}, "region":region},
        MongoFindOptions::default(),
    )
    .await?
    .into_iter()
    .map(|price| Ok((stored_string_key(price.get("offerId"))?, price)))
    .collect()
}

async fn serialize_with_prices(
    state: &AppState,
    rows: &[Document],
    prices: &[Option<&Document>],
    locale: &str,
) -> Result<(Vec<Value>, Value), ProblemError> {
    let localized = localize_ordered_rows(state, rows, locale).await?;
    let meta = localization_meta(localized.first());
    let offers = rows
        .iter()
        .zip(&localized)
        .zip(prices)
        .map(|((row, offer), price)| serialize_stored_localized_offer(row, offer, price.cloned()))
        .collect::<Result<_, _>>()?;
    Ok((offers, meta))
}

fn list_response(
    mut payload: Value,
    region: &egdata_core::v1::RegionalParams,
    limit: Option<usize>,
) -> Result<(Value, Value), ProblemError> {
    let offers = payload.get_mut("offers").ok_or_else(internal_error)?.take();
    if offers.is_null() {
        return Err(internal_error());
    }
    let count = cached_length(&offers);
    Ok((
        offers,
        regional_meta(region, count, limit, &payload["localization"]),
    ))
}

async fn related(
    state: &AppState,
    id: &str,
    region: &egdata_core::v1::RegionalParams,
) -> Result<(Value, Value), ProblemError> {
    let payload = cached(
        state,
        "offer-details.related",
        &[
            ("id", json!(id)),
            ("region", json!(region.region)),
            ("locale", json!(region.locale)),
        ],
        DYNAMIC_TTL,
        || async {
            let offer = offer_prices::require_stored(state, id, Some(doc! {"id":1,"namespace":1})).await?;
            let rows = many(
                state,
                "offers",
                doc! {"namespace":offer.get("namespace").cloned().unwrap_or(Bson::Null),"id":{"$ne":id}},
                MongoFindOptions {
                    limit: Some(RELATED_LIMIT),
                    ..Default::default()
                },
            )
            .await?;
            let (offers, localization) =
                serialize_list(state, &rows, &region.region, &region.locale).await?;
            Ok(json!({"offers":offers,"localization":localization}))
        },
    )
    .await?;
    list_response(payload, region, Some(RELATED_LIMIT as usize))
}

async fn suggestions(
    state: &AppState,
    id: &str,
    region: &egdata_core::v1::RegionalParams,
) -> Result<(Value, Value), ProblemError> {
    let load = || async {
        // Query with the original BSON tag IDs. The public serializer stringifies
        // nested id fields, but the catalog contains both numeric and string tag IDs.
        let offer = state
            .mongo
            .find_one(
                "offers",
                doc! {"id":{"$eq":id}},
                Some(doc! {"id":1,"namespace":1,"tags":1}),
            )
            .await
            .map_err(|_| internal_error())?
            .ok_or_else(|| not_found("OFFER_NOT_FOUND", "No offer exists with this ID."))?;
        let mut tag_ids = Vec::new();
        for tag in offer.get_array("tags").into_iter().flatten() {
            if tag == &Bson::Null {
                return Err(internal_error());
            }
            if let Some(id) = tag
                .as_document()
                .and_then(|d| d.get("id"))
                .filter(|id| !matches!(id, Bson::Null | Bson::Undefined))
            {
                tag_ids.push(id.clone());
            }
        }
        let tags = state
            .mongo
            .find_many(
                "tags",
                doc! {"id":{"$in":tag_ids}},
                MongoFindOptions::default(),
            )
            .await
            .map_err(|_| internal_error())?;
        let genre_ids = tags
            .iter()
            .filter(|tag| tag.get("groupName").and_then(stored_text) == Some("genre"))
            .map(|tag| tag.get("id").cloned().unwrap_or(Bson::Null))
            .collect::<Vec<_>>();
        let rows = many(state, "offers", doc! {"tags":{"$elemMatch":{"id":{"$in":genre_ids}}},"id":{"$ne":id},"namespace":{"$ne":offer.get("namespace").cloned().unwrap_or(Bson::Null)},"offerType":{"$in":["BASE_GAME","DLC"]}}, MongoFindOptions { limit:Some(SUGGESTION_LIMIT), sort:Some(doc! {"lastModifiedDate":-1}), ..Default::default() }).await?;
        let (offers, localization) =
            serialize_list(state, &rows, &region.region, &region.locale).await?;
        Ok(json!({"offers":offers,"localization":localization}))
    };
    let payload = cached(
        state,
        "offer-details.suggestions",
        &[
            ("id", json!(id)),
            ("region", json!(region.region)),
            ("locale", json!(region.locale)),
        ],
        DYNAMIC_TTL,
        load,
    )
    .await?;
    list_response(payload, region, Some(SUGGESTION_LIMIT as usize))
}

async fn collection(
    state: &AppState,
    id: &str,
    region: &egdata_core::v1::RegionalParams,
) -> Result<(Value, Value), ProblemError> {
    let payload = cached(
        state,
        "offer-details.collection",
        &[
            ("id", json!(id)),
            ("region", json!(region.region)),
            ("locale", json!(region.locale)),
        ],
        DYNAMIC_TTL,
        || async {
            let offer = offer_prices::require_stored(state, id, None).await?;
            if !offer
                .get_array("categories")
                .is_ok_and(|items| items.iter().any(|v| stored_text(v) == Some("collections")))
            {
                return Err(not_found(
                    "COLLECTION_NOT_FOUND",
                    "This offer does not belong to a collection.",
                ));
            }
            let ids = offer
                .get_array("customAttributes")
                .into_iter()
                .flatten()
                .filter_map(Bson::as_document)
                .filter(|attribute| {
                    attribute
                        .get("key")
                        .and_then(stored_text)
                        .is_some_and(|key| key.starts_with(COLLECTION_PREFIX))
                })
                .map(|attribute| stored_string_key(attribute.get("value")))
                .collect::<Result<Vec<_>, _>>()?;
            if ids.is_empty() {
                return Err(not_found(
                    "COLLECTION_NOT_FOUND",
                    "This offer does not belong to a collection.",
                ));
            }
            let rows = many(
                state,
                "offers",
                doc! {"id":{"$in":ids}},
                MongoFindOptions::default(),
            )
            .await?;
            let (offers, localization) =
                serialize_list(state, &rows, &region.region, &region.locale).await?;
            Ok(json!({"offers":offers,"localization":localization}))
        },
    )
    .await?;
    list_response(payload, region, None)
}

async fn collection_entry(
    state: &AppState,
    id: &str,
    collection_id: &str,
) -> Result<(Value, Value), ProblemError> {
    let data = cached(
        state,
        "offer-details.collection-entry",
        &[("id", json!(id)), ("collection", json!(collection_id))],
        STABLE_TTL,
        || async {
            offer_prices::require(state, id, Some(doc! {"id":1})).await?;
            let entry = one(
                state,
                "game_positions",
                doc! {"collectionId":collection_id,"offerId":id},
                None,
            );
            let collection = one(state, "collections_v2", doc! {"_id":collection_id}, None);
            let (entry, collection) = tokio::join!(biased; entry, collection);
            let (entry, collection) = (entry?, collection?);
            if entry.is_null() || collection.is_null() {
                return Err(not_found(
                    "COLLECTION_ENTRY_NOT_FOUND",
                    "This offer has no entry in the requested collection.",
                ));
            }
            let mut result = serialize_value(&entry);
            result["name"] = collection.get("name").cloned().unwrap_or(Value::Null);
            Ok(result)
        },
    )
    .await?;
    Ok((data, json!({})))
}

async fn bundle(
    state: &AppState,
    id: &str,
    region: &egdata_core::v1::RegionalParams,
) -> Result<(Value, Value), ProblemError> {
    let load = || async {
        let offer = offer_prices::require_stored(state, id, None).await?;
        if !matches!(
            offer.get("offerType").and_then(stored_text),
            Some("BUNDLE" | "Bundle")
        ) {
            return Err(not_found("BUNDLE_NOT_FOUND", "This offer is not a bundle."));
        }
        let bundle = state
            .mongo
            .find_one("bundles", doc! {"_id":id}, None)
            .await
            .map_err(|_| internal_error())?
            .ok_or_else(|| {
                not_found(
                    "BUNDLE_NOT_FOUND",
                    "No bundle contents are stored for this offer.",
                )
            })?;
        let ids = bundle
            .get_array("offers")
            .into_iter()
            .flatten()
            .map(|value| stored_string_key(Some(value)))
            .collect::<Result<Vec<_>, _>>()?;
        let (main_price, bundle_offers, prices) = tokio::join!(
            biased;
            load_price(state, id, &region.region),
            many(
                state,
                "offers",
                doc! {"id":{"$in":&ids}},
                MongoFindOptions::default()
            ),
            load_prices(state, &ids, &region.region)
        );
        let main_price = main_price?;
        let (bundle_offers, prices) = (bundle_offers?, prices?);
        let matches = bundle_offers
            .iter()
            .map(|row| Ok(prices.get(&stored_string_key(row.get("id"))?)))
            .collect::<Result<Vec<_>, ProblemError>>()?;
        let (serialized, localized_meta) =
            serialize_with_prices(state, &bundle_offers, &matches, &region.locale).await?;
        let field = |key| {
            main_price
                .as_ref()
                .and_then(|price| price.get(key))
                .filter(|v| !matches!(v, Bson::Null | Bson::Undefined))
                .cloned()
        };
        let mut total = doc! {"discount":0,"discountPrice":0,"originalPrice":0,"basePayoutPrice":0,"currencyCode":"USD","basePayoutCurrencyCode":"USD","payoutCurrencyExchangeRate":1};
        for price in matches.into_iter().flatten() {
            let nested = price.get_document("price").ok();
            let Some(nested) = nested else {
                continue;
            };
            for key in [
                "discount",
                "discountPrice",
                "originalPrice",
                "basePayoutPrice",
            ] {
                total.insert(key, add_price_amount(total.get(key), nested.get(key))?);
            }
            for key in [
                "currencyCode",
                "basePayoutCurrencyCode",
                "payoutCurrencyExchangeRate",
            ] {
                if let Some(v) = nested
                    .get(key)
                    .filter(|v| !matches!(v, Bson::Null | Bson::Undefined))
                {
                    total.insert(key, v.clone());
                }
            }
        }
        let total = doc! {"country":&region.country,"region":&region.region,"offerId":id,"namespace":field("namespace").or_else(||offer.get("namespace").cloned()).unwrap_or(Bson::Null),"updatedAt":field("updatedAt").unwrap_or(Bson::Null),"appliedRules":[],"price": total};
        let mut payload = json!({"offers":serialized,"localization":localized_meta});
        for (key, price) in [("bundlePrice", main_price), ("totalPrice", Some(total))] {
            payload[key] = price
                .map(offer_prices::serialize_stored_price)
                .transpose()?
                .unwrap_or(Value::Null);
        }
        Ok(payload)
    };
    let data = cached(
        state,
        "offer-details.bundle",
        &[
            ("id", json!(id)),
            ("region", json!(region.region)),
            ("locale", json!(region.locale)),
        ],
        DYNAMIC_TTL,
        load,
    )
    .await?;
    if data["offers"].is_null() {
        return Err(internal_error());
    }
    let count = cached_length(&data["offers"]);
    let mut output = json!({"offers":data["offers"]});
    for key in ["bundlePrice", "totalPrice"] {
        if let Some(value) = data.get(key) {
            output[key] = value.clone();
        }
    }
    Ok((
        output,
        regional_meta(region, count, None, &data["localization"]),
    ))
}

// The Node accumulator uses + on the stored minor units before serialization.
// Older price records can contain strings, in which case addition concatenates.
fn add_price_amount(left: Option<&Bson>, right: Option<&Bson>) -> Result<Bson, ProblemError> {
    let zero = Bson::Int32(0);
    let left = left.unwrap_or(&zero);
    let right = right
        .filter(|v| !matches!(v, Bson::Null | Bson::Undefined))
        .unwrap_or(&zero);
    let numeric = |v: &Bson| match v {
        Bson::Boolean(b) => Some(u8::from(*b) as f64),
        Bson::Int32(n) => Some(*n as f64),
        Bson::Int64(n) if n.unsigned_abs() <= 1 << 53 => Some(*n as f64),
        Bson::Double(n) => Some(*n),
        _ => None,
    };
    Ok(match (numeric(left), numeric(right)) {
        (Some(a), Some(b)) => Bson::Double(a + b),
        // The running value is created here as a number or a string.
        _ => Bson::String(
            egdata_core::v1::serialization::stored_identifier(left).unwrap()
                + &stored_string_key(Some(right))?,
        ),
    })
}

async fn in_bundle(
    state: &AppState,
    id: &str,
    region: &egdata_core::v1::RegionalParams,
) -> Result<(Value, Value), ProblemError> {
    let payload = cached(
        state,
        "offer-details.in-bundle",
        &[
            ("id", json!(id)),
            ("region", json!(region.region)),
            ("locale", json!(region.locale)),
        ],
        DYNAMIC_TTL,
        || async {
            offer_prices::require(state, id, Some(doc! {"id":1})).await?;
            let bundles = many(
                state,
                "bundles",
                doc! {"offers":id},
                MongoFindOptions::default(),
            )
            .await?;
            let ids = bundles
                .iter()
                .map(|bundle| stored_string_key(bundle.get("_id")))
                .collect::<Result<Vec<_>, _>>()?;
            if ids.is_empty() {
                return Ok(json!({"offers":[],"localization":{}}));
            }
            let rows = many(
                state,
                "offers",
                doc! {"id":{"$in":&ids}},
                MongoFindOptions::default(),
            )
            .await?;
            let by_id = rows
                .into_iter()
                .map(|row| Ok((stored_string_key(row.get("id"))?, row)))
                .collect::<Result<HashMap<_, _>, ProblemError>>()?;
            let ordered = ids
                .iter()
                .filter_map(|id| by_id.get(id).cloned())
                .collect::<Vec<_>>();
            let (offers, localization) =
                serialize_list(state, &ordered, &region.region, &region.locale).await?;
            Ok(json!({"offers":offers,"localization":localization}))
        },
    )
    .await?;
    list_response(payload, region, None)
}

async fn has_prepurchase(
    state: &AppState,
    id: &str,
    region: &egdata_core::v1::RegionalParams,
) -> Result<(Value, Value), ProblemError> {
    let load = || async {
        let offer =
            offer_prices::require_stored(state, id, Some(doc! {"id":1,"namespace":1})).await?;
        let found = state.mongo.find_one("offers", doc! {"namespace":offer.get("namespace").cloned().unwrap_or(Bson::Null),"offerType":"BASE_GAME","prePurchase":true,"id":{"$ne":id}}, None).await.map_err(|_| internal_error())?;
        let Some(found) = found else {
            return Ok(json!({"hasPrepurchase":false,"offer":null,"localization":{}}));
        };
        let price = load_price(state, &stored_string_key(found.get("id"))?, &region.region).await?;
        let (serialized, localization) =
            serialize_related_offer(state, &found, price, &region.locale).await?;
        Ok(json!({"hasPrepurchase":true,"offer":serialized,"localization":localization}))
    };
    let payload = cached(
        state,
        "offer-details.has-prepurchase",
        &[
            ("id", json!(id)),
            ("region", json!(region.region)),
            ("locale", json!(region.locale)),
        ],
        DYNAMIC_TTL,
        load,
    )
    .await?;
    Ok(edition_response(&payload, "hasPrepurchase", region))
}

async fn has_regular(
    state: &AppState,
    id: &str,
    region: &egdata_core::v1::RegionalParams,
) -> Result<(Value, Value), ProblemError> {
    let load = || async {
        let offer = offer_prices::require_stored(
            state,
            id,
            Some(doc! {"id":1,"namespace":1,"offerType":1,"prePurchase":1}),
        )
        .await?;
        if offer.get("offerType").and_then(stored_text) != Some("BASE_GAME")
            || offer.get_bool("prePurchase") != Ok(true)
        {
            return Ok(json!({"isPrepurchase":false,"offer":null,"localization":{}}));
        }
        let found = state.mongo.find_one("offers", doc! {"namespace":offer.get("namespace").cloned().unwrap_or(Bson::Null),"offerType":"BASE_GAME","prePurchase":{"$ne":true},"id":{"$ne":id}}, None).await.map_err(|_| internal_error())?;
        let Some(found) = found else {
            return Ok(json!({"isPrepurchase":false,"offer":null,"localization":{}}));
        };
        let price = load_price(state, &stored_string_key(found.get("id"))?, &region.region).await?;
        let (serialized, localization) =
            serialize_related_offer(state, &found, price, &region.locale).await?;
        Ok(json!({"isPrepurchase":true,"offer":serialized,"localization":localization}))
    };
    let payload = cached(
        state,
        "offer-details.has-regular",
        &[
            ("id", json!(id)),
            ("region", json!(region.region)),
            ("locale", json!(region.locale)),
        ],
        DYNAMIC_TTL,
        load,
    )
    .await?;
    Ok(edition_response(&payload, "isPrepurchase", region))
}

fn edition_response(
    payload: &Value,
    flag: &str,
    region: &egdata_core::v1::RegionalParams,
) -> (Value, Value) {
    let mut data = json!({});
    if let Some(value) = payload.get(flag) {
        data[flag] = value.clone();
    }
    if super::search::js_truthy(&payload["offer"]) {
        data["offer"] = payload["offer"].clone();
    }
    (
        data,
        regional_meta(region, None, None, &payload["localization"]),
    )
}

async fn load_price(
    state: &AppState,
    id: &str,
    region: &str,
) -> Result<Option<Document>, ProblemError> {
    state
        .mongo
        .find_one_with_options(
            "pricev2",
            doc! {"offerId":{"$eq":id},"region":{"$eq":region}},
            MongoFindOptions {
                sort: Some(doc! {"updatedAt":-1}),
                ..Default::default()
            },
        )
        .await
        .map_err(|_| internal_error())
}

async fn serialize_related_offer(
    state: &AppState,
    offer: &Document,
    price: Option<Document>,
    locale: &str,
) -> Result<(Value, Value), ProblemError> {
    let localized = localize_ordered_rows(state, std::slice::from_ref(offer), locale).await?;
    Ok((
        serialize_stored_localized_offer(offer, &localized[0], price)?,
        localization_meta(localized.first()),
    ))
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn offer_relations_http_node_oracle() {
        egdata_api_oracle::replay_mongo_oracle(include_str!(
            "../../egdata-api/tests/fixtures/offer-relations-http-node.json"
        ))
        .await;
    }
}
