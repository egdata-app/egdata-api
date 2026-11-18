//! Offer query and nested offer resolvers, using the canonical offer
//! localization and ordering helpers from `egdata-core`.

use async_graphql::{Error, ErrorExtensions, Result};
use bson::{Bson, Document, doc};
use egdata_core::{
    attributes::order_offers_object,
    countries::country_to_region,
    localization::{
        CANONICAL_LOCALE, EgsLocalization, LOCALIZED_OFFER_FIELDS, apply_offer_localization,
        get_offer_localization_entity_id, parse_locale,
    },
    ports::{MongoFindOptions, MongoStorePort},
    v1::serialization::bson_to_serialized_json,
};
use serde_json::{Value, json};
use std::collections::HashMap;

use super::{GraphqlServices, loaders::Lookup};
mod discovery;
mod relationships;

const DEFAULT_PAGE_SIZE: usize = 10;
const MAX_PAGE_SIZE: usize = 100;
const MAX_PAGE: usize = 10_000;

/// Execute the custom fields registered by the Node offer resolver.
pub async fn resolve(
    parent_type: &str,
    field: &str,
    parent: &Value,
    args: &Value,
    services: &GraphqlServices,
) -> Result<Option<Value>> {
    let result = match (parent_type, field) {
        ("Query", "offer") => Some(resolve_offer(parent, args, services).await?),
        ("Query", "offers") => Some(resolve_offers(args, services).await?),
        ("Offer", "price") => Some(resolve_price(parent, args, services).await?),
        ("Offer", "items") => Some(resolve_items(parent, services).await?),
        ("Offer", "franchises") => Some(resolve_franchises(parent, services).await?),
        ("Offer", "giveaways") => Some(resolve_giveaways(parent, services).await?),
        ("Offer", "related") => Some(resolve_related(parent, args, services).await?),
        ("Query", _) => discovery::resolve(field, args, services).await?,
        _ => relationships::resolve(parent_type, field, parent, args, services).await?,
    };
    Ok(result)
}

async fn resolve_offer(parent: &Value, args: &Value, services: &GraphqlServices) -> Result<Value> {
    let id = required_string(args, "id")?;
    let locale = resolve_locale(args, parent)?;
    let projection = offer_projection(args);
    let offer = services
        .mongo
        .find_one("offers", doc! { "id": id }, Some(projection))
        .await
        .map_err(internal_error)?;
    let Some(offer) = offer else {
        return Ok(Value::Null);
    };
    let offer = document_to_json(&offer);
    Ok(
        localize_offers(services.mongo.as_ref(), vec![offer], &locale)
            .await?
            .pop()
            .unwrap_or(Value::Null),
    )
}

async fn resolve_offers(args: &Value, services: &GraphqlServices) -> Result<Value> {
    let limit = clamp(args.get("limit"), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    let page = clamp(args.get("page"), 1, MAX_PAGE);
    let skip = ((page - 1) * limit) as u64;
    let country = args.get("country").and_then(Value::as_str).unwrap_or("US");
    let region = country_to_region(Some(country), "US");
    let locale = resolve_locale(args, &Value::Null)?;

    let offers = services
        .mongo
        .find_many(
            "offers",
            Document::new(),
            MongoFindOptions {
                sort: Some(doc! { "lastModifiedDate": -1 }),
                skip: Some(skip),
                limit: Some(limit as i64),
                ..MongoFindOptions::default()
            },
        )
        .await
        .map_err(internal_error)?;

    let ids = offers
        .iter()
        .map(|offer| offer.get("id").cloned().unwrap_or(Bson::Null))
        .collect::<Vec<_>>();
    let prices = services
        .mongo
        .find_many(
            "pricev2",
            doc! {
                "offerId": { "$in": ids },
                "region": region,
            },
            MongoFindOptions::default(),
        )
        .await
        .map_err(internal_error)?;

    let mut prices_by_id = HashMap::new();
    for price in &prices {
        if let Ok(id) = price.get_str("offerId") {
            prices_by_id
                .entry(id)
                .or_insert_with(|| document_to_json(price));
        }
    }
    let ordered = offers
        .iter()
        .map(|offer| {
            let mut ordered = ordered_offer(offer);
            ordered["price"] = offer
                .get_str("id")
                .ok()
                .and_then(|id| prices_by_id.get(id))
                .cloned()
                .unwrap_or(Value::Null);
            ordered
        })
        .collect::<Vec<_>>();
    let localized = localize_ordered_offers(services.mongo.as_ref(), ordered, &locale).await?;
    let total = services
        .mongo
        .count_documents("offers", Document::new())
        .await
        .map_err(internal_error)?;

    Ok(json!({
        "elements": localized,
        "total": total,
        "page": page,
        "limit": limit,
    }))
}

async fn resolve_price(parent: &Value, args: &Value, services: &GraphqlServices) -> Result<Value> {
    let id = parent.get("id");
    let region = country_to_region(args["country"].as_str(), "US");
    services.loaders.price(id, region).await
}

async fn resolve_items(parent: &Value, services: &GraphqlServices) -> Result<Value> {
    let direct = parent["items"].as_array().filter(|items| !items.is_empty());
    let subitems;
    let references = if let Some(items) = direct {
        Some(items)
    } else {
        subitems = services
            .loaders
            .one_value(Lookup::SubItems, loader_id(parent, "id")?)
            .await?;
        subitems["subItems"].as_array()
    };
    let ids = references
        .into_iter()
        .flatten()
        .filter_map(|item| item["id"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    Ok(Value::Array(
        services.loaders.many(Lookup::Item, &ids).await?,
    ))
}
async fn resolve_franchises(parent: &Value, services: &GraphqlServices) -> Result<Value> {
    let id = parent["id"].as_str();
    let rows = services
        .mongo
        .find_many(
            "franchises",
            doc! { "offers": id },
            MongoFindOptions::default(),
        )
        .await
        .map_err(internal_error)?;
    Ok(Value::Array(rows.iter().map(document_to_json).collect()))
}

async fn resolve_giveaways(parent: &Value, services: &GraphqlServices) -> Result<Value> {
    let id = parent["id"].as_str();
    let rows = services
        .mongo
        .find_many(
            "freegames",
            doc! { "id": id },
            MongoFindOptions {
                sort: Some(doc! { "startDate": -1 }),
                ..MongoFindOptions::default()
            },
        )
        .await
        .map_err(internal_error)?;
    Ok(Value::Array(rows.iter().map(document_to_json).collect()))
}

async fn resolve_related(
    parent: &Value,
    args: &Value,
    services: &GraphqlServices,
) -> Result<Value> {
    let id = parent["id"].as_str();
    let namespace = parent["namespace"].as_str();
    let locale = resolve_locale(args, parent)?;
    let rows = services
        .mongo
        .find_many(
            "offers",
            doc! { "namespace": namespace, "id": { "$ne": id } },
            MongoFindOptions {
                limit: Some(25),
                ..MongoFindOptions::default()
            },
        )
        .await
        .map_err(internal_error)?;
    let offers = rows.iter().map(ordered_offer).collect();
    Ok(Value::Array(
        localize_ordered_offers(services.mongo.as_ref(), offers, &locale).await?,
    ))
}

pub(crate) async fn localize_offers(
    mongo: &dyn MongoStorePort,
    offers: Vec<Value>,
    locale: &str,
) -> Result<Vec<Value>> {
    localize(mongo, offers, locale, false).await
}

pub(super) async fn localize_ordered_offers(
    mongo: &dyn MongoStorePort,
    offers: Vec<Value>,
    locale: &str,
) -> Result<Vec<Value>> {
    localize(mongo, offers, locale, true).await
}

async fn localize(
    mongo: &dyn MongoStorePort,
    offers: Vec<Value>,
    locale: &str,
    ordered: bool,
) -> Result<Vec<Value>> {
    if locale == CANONICAL_LOCALE || offers.is_empty() {
        return Ok(offers
            .iter()
            .map(|offer| apply_offer_localization(offer, None, locale))
            .collect());
    }

    let mut seen = std::collections::HashSet::new();
    let entity_ids = offers
        .iter()
        .filter_map(get_offer_localization_entity_id)
        .filter(|id| seen.insert(id.clone()))
        .collect::<Vec<_>>();
    let localizations = if entity_ids.is_empty() {
        Vec::new()
    } else {
        mongo
            .find_many(
                "egs_localizations",
                doc! {
                    "entityType": "offer",
                    "entityId": { "$in": entity_ids },
                    "locale": locale,
                },
                MongoFindOptions::default(),
            )
            .await
            .map_err(internal_error)?
    };
    let localizations = localizations
        .iter()
        .filter_map(|document| {
            let mut value = document_to_json(document);
            let fields = value
                .as_object_mut()
                .expect("MongoDB document serializes as an object");
            // Apollo forwards timestamps as stored, including old scalar values.
            // Parse only the fields used by the core localization projector.
            fields.shift_remove("fetchedAt");
            fields.shift_remove("sourceUpdatedAt");
            let localization = serde_json::from_value::<EgsLocalization>(value).ok()?;
            Some((localization.entity_id.clone(), (localization, document)))
        })
        .collect::<HashMap<_, _>>();

    Ok(offers
        .into_iter()
        .map(|mut offer| {
            let entity_id = get_offer_localization_entity_id(&offer);
            let source = entity_id.as_ref().and_then(|id| localizations.get(id));
            let localization = source.map(|(typed, _)| typed);
            // orderOffersObject defines localized keys even when the source field is undefined.
            // GraphQL projections of individual offers only define fields Mongo actually returned.
            if ordered && let Some(data) = localization.and_then(|loc| loc.data.as_ref()) {
                for key in LOCALIZED_OFFER_FIELDS {
                    if data.get(*key).is_some() && offer.get(*key).is_none() {
                        offer[*key] = Value::Null;
                    }
                }
            }
            let mut localized = apply_offer_localization(&offer, localization, locale);
            if let Some((_, document)) = source {
                // The typed timestamps can't distinguish a missing BSON field from null.
                // Node copies fetchedAt verbatim and only includes a truthy sourceUpdatedAt.
                let metadata = localized["localization"]
                    .as_object_mut()
                    .expect("localized result metadata");
                match document.get("fetchedAt") {
                    Some(value) => {
                        metadata.insert("fetchedAt".into(), bson_to_serialized_json(value));
                    }
                    None => {
                        metadata.shift_remove("fetchedAt");
                    }
                }
                if let Some(value) = document
                    .get("sourceUpdatedAt")
                    .map(bson_to_serialized_json)
                    .filter(super::js_truthy)
                {
                    metadata.insert("sourceUpdatedAt".into(), value);
                }
            }
            localized
        })
        .collect())
}

fn offer_projection(args: &Value) -> Document {
    let mut projection = Document::new();
    if let Some(fields) = args.get("__selectedFields").and_then(Value::as_array) {
        for field in fields.iter().filter_map(Value::as_str) {
            projection.insert(field, 1);
        }
    }
    projection.insert("id", 1);
    projection.insert("_id", 1);
    projection.insert("namespace", 1);
    projection
}

pub(crate) fn resolve_locale(args: &Value, parent: &Value) -> Result<String> {
    let requested = args
        .get("locale")
        .and_then(Value::as_str)
        .or_else(|| parent.get("locale").and_then(Value::as_str));
    parse_locale(requested).map_err(|error| {
        Error::new(error.to_string()).extend_with(|_, extensions| {
            extensions.set("code", "BAD_USER_INPUT");
            extensions.set("argumentName", "locale");
        })
    })
}

fn loader_id(parent: &Value, field: &str) -> Result<Value> {
    match parent.get(field) {
        Some(value) if !value.is_null() => Ok(value.clone()),
        value => {
            let value = if value.is_some() { "null" } else { "undefined" };
            Err(Error::new(format!(
                "The loader.load() function must be called with a value, but got: {value}."
            )))
        }
    }
}

fn required_string<'a>(args: &'a Value, field: &str) -> Result<&'a str> {
    args.get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| Error::new(format!("Missing string argument {field}")))
}

fn clamp(value: Option<&Value>, fallback: usize, max: usize) -> usize {
    let Some(value) = value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
    else {
        return fallback;
    };
    (value.trunc() as i64).clamp(1, max as i64) as usize
}

fn document_to_json(document: &Document) -> Value {
    bson_to_serialized_json(&Bson::Document(document.clone()))
}

fn ordered_offer(document: &Document) -> Value {
    let json = document_to_json(document);
    json!(order_offers_object(
        json.as_object()
            .expect("MongoDB document serializes as an object")
    ))
}

fn internal_error(error: impl std::fmt::Display) -> Error {
    Error::new(error.to_string())
}

#[cfg(test)]
mod oracle;
