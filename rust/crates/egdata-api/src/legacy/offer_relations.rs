//! Offer relationships share legacy ordered offer documents, localization and regional prices.
use super::{
    Routes,
    catalog::ordered_offer,
    common::*,
    system::{query, selected_region},
};
use crate::{state::AppState, v1::system::localize_offers};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode, Uri},
    response::Response,
};
use bson::{Bson, doc};
use egdata_core::{
    localization::{get_localized_cache_ttl_seconds, locale_cache_segment, parse_locale},
    ports::MongoFindOptions,
    v1::serialization::js_iso_datetime,
};
use egdata_infra::bson_json::bson_doc_to_js_json;
use serde_json::{Value, json};
use std::collections::HashMap;

pub(super) fn routes() -> Routes {
    Routes::new("/offers/{id}")
        .get("/collection", relation)
        .get("/bundle", relation)
        .get("/in-bundle", relation)
        .get("/related", relation)
        .get("/suggestions", relation)
        .get("/has-regular", relation)
        .get("/has-prepurchase", relation)
}

#[cfg(test)]
#[tokio::test]
async fn legacy_offer_relations_http_node_oracle() {
    crate::v1::mongo_read_oracle::replay_legacy_oracle(include_str!(
        "../../tests/fixtures/legacy-offer-relations-http-node.json"
    ))
    .await;
}

fn minute(value: &Value) -> Response {
    cache_header(ok(value), ONE_MINUTE)
}
fn bson(value: &Value) -> Bson {
    bson::to_bson(value).unwrap_or(Bson::Null)
}

pub(super) fn card(offer: &Value, price: Option<&Value>) -> Value {
    let mut row = ordered_offer(offer);
    row.insert("price".into(), price.cloned().unwrap_or(Value::Null));
    Value::Object(row)
}

pub(super) fn prices_by_id(rows: &[Value]) -> HashMap<&str, &Value> {
    rows.iter()
        .filter_map(|row| Some((row["offerId"].as_str()?, row)))
        .collect()
}

struct Relation<'a> {
    state: &'a AppState,
    id: &'a str,
    region: &'static str,
    locale: String,
}

impl Relation<'_> {
    async fn cards(&self, offers: &[Value], prices: &HashMap<&str, &Value>) -> Result<Value> {
        let rows = offers
            .iter()
            .map(|o| card(o, o["id"].as_str().and_then(|id| prices.get(id)).copied()))
            .collect::<Vec<_>>();
        Ok(Value::Array(
            localize_offers(self.state, &rows, &self.locale).await?,
        ))
    }
    async fn offer(&self) -> Result<Value> {
        one(self.state, "offers", doc! {"id":self.id})
            .await?
            .ok_or_else(|| not_found("Offer not found"))
    }
    async fn members(&self, ids: Bson) -> (Vec<Value>, Vec<Value>) {
        let (offers, prices) = tokio::join!(
            many(
                self.state,
                "offers",
                doc! {"id":{"$in":&ids}},
                Default::default()
            ),
            many(
                self.state,
                "pricev2",
                doc! {"offerId":{"$in":ids},"region":self.region},
                Default::default()
            )
        );
        (offers.unwrap_or_default(), prices.unwrap_or_default())
    }
    async fn discovery(&self, related: bool) -> Result<Value> {
        let (filter, sort) = if related {
            let found = self
                .state
                .mongo
                .find_one(
                    "offers",
                    doc! {"id":self.id},
                    Some(doc! {"namespace":1,"id":1}),
                )
                .await?
                .ok_or_else(|| not_found("Offer not found"))?;
            let offer = bson_doc_to_js_json(&found);
            (
                doc! {"namespace":bson(&offer["namespace"]),"id":{"$ne":bson(&offer["id"])}},
                None,
            )
        } else {
            let offer = self.offer().await?;
            let tags = offer["tags"]
                .as_array()
                .ok_or(Error::Internal)?
                .iter()
                .map(|t| bson(&t["id"]))
                .collect::<Vec<_>>();
            let tags = many(
                self.state,
                "tags",
                doc! {"id":{"$in":tags}},
                Default::default(),
            )
            .await?;
            let genres = tags
                .iter()
                .filter(|t| t["groupName"] == "genre")
                .map(|t| bson(&t["id"]))
                .collect::<Vec<_>>();
            (
                doc! {"tags":{"$elemMatch":{"id":{"$in":genres}}},"id":{"$ne":self.id},"namespace":{"$ne":bson(&offer["namespace"])},"offerType":{"$in":["BASE_GAME","DLC"]}},
                Some(doc! {"lastModifiedDate":-1}),
            )
        };
        let offers = many(
            self.state,
            "offers",
            filter,
            MongoFindOptions {
                limit: Some(25),
                sort,
                ..Default::default()
            },
        )
        .await?;
        let ids = offers.iter().map(|o| bson(&o["id"])).collect::<Vec<_>>();
        let prices = many(
            self.state,
            "pricev2",
            doc! {"offerId":{"$in":ids},"region":self.region},
            Default::default(),
        )
        .await?;
        self.cards(&offers, &prices_by_id(&prices)).await
    }
    async fn collection(&self, offer: Value) -> Result<Value> {
        let ids: Vec<_> = offer["customAttributes"]
            .as_array()
            .ok_or(Error::Internal)?
            .iter()
            .filter(|a| {
                a["key"]
                    .as_str()
                    .is_some_and(|k| k.starts_with("com.epicgames.app.collectionOfferIds."))
            })
            .map(|a| bson(&a["value"]))
            .collect();
        if ids.is_empty() {
            return Err(not_found("Selected offer does not have a collection"));
        }
        let (offers, prices) = self.members(Bson::Array(ids)).await;
        self.cards(&offers, &prices_by_id(&prices)).await
    }
    async fn bundle(&self) -> Result<Value> {
        let (offer, main_price) = tokio::join!(
            self.offer(),
            one(
                self.state,
                "pricev2",
                doc! {"offerId":self.id,"region":self.region}
            )
        );
        let offer = offer.map_err(|_| not_found("Offer not found"))?;
        let main_price = main_price.ok().flatten().unwrap_or(Value::Null);
        if offer["offerType"] != "BUNDLE" && offer["offerType"] != "Bundle" {
            return Err(not_found("Selected offer is not a bundle"));
        }
        let bundle = one(self.state, "bundles", doc! {"_id":bson(&offer["id"])})
            .await?
            .ok_or_else(|| not_found("Bundle not found"))?;
        let ids = bundle
            .get("offers")
            .filter(|v| !v.is_null())
            .map(bson)
            .unwrap_or_else(|| Bson::Array(vec![]));
        let (offers, prices) = self.members(ids).await;
        let prices = prices_by_id(&prices);
        let members = self.cards(&offers, &prices).await?;
        let base = |key: &str, default: Value| {
            main_price
                .get(key)
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or(default)
        };
        let mut total = json!({
            "country":base("country",json!("US")),"offerId":self.id,"region":base("region",json!("US")),
            "namespace":base("namespace",json!("epic")),"updatedAt":base("updatedAt",json!(js_iso_datetime((self.state.now)()))),
            "price":{"discount":0,"discountPrice":0,"originalPrice":0,"basePayoutPrice":0,"currencyCode":"USD","basePayoutCurrencyCode":"USD","payoutCurrencyExchangeRate":1},"appliedRules":[]
        });
        for row in &offers {
            let Some(price) = row["id"].as_str().and_then(|id| prices.get(id)) else {
                continue;
            };
            let source = price["price"].as_object().ok_or(Error::Internal)?;
            let accumulated = total["price"].as_object_mut().unwrap();
            for key in [
                "discount",
                "discountPrice",
                "originalPrice",
                "basePayoutPrice",
            ] {
                let sum = accumulated[key].as_f64().unwrap_or(0.)
                    + source.get(key).and_then(Value::as_f64).unwrap_or(0.);
                accumulated.insert(key.into(), json!(sum));
            }
            for key in [
                "currencyCode",
                "basePayoutCurrencyCode",
                "payoutCurrencyExchangeRate",
            ] {
                if let Some(current) = source.get(key) {
                    accumulated.insert(key.into(), current.clone());
                } else {
                    accumulated.shift_remove(key);
                }
            }
        }
        Ok(json!({"offers":members,"totalPrice":total,"bundlePrice":main_price}))
    }
    async fn in_bundle(&self) -> Result<Value> {
        let bundles = self
            .state
            .mongo
            .find_many("bundles", doc! {"offers":self.id}, Default::default())
            .await?;
        let mut offers = Vec::new();
        let mut prices = Vec::new();
        for bundle in bundles {
            let id = bundle.get("_id").cloned().unwrap_or(Bson::Null);
            let (offer, price) = tokio::join!(
                one(self.state, "offers", doc! {"id":&id}),
                one(
                    self.state,
                    "pricev2",
                    doc! {"offerId":id,"region":self.region}
                )
            );
            if let Ok(Some(offer)) = offer {
                prices.push(price.ok().flatten());
                offers.push(offer);
            }
        }
        let rows = offers
            .iter()
            .zip(&prices)
            .map(|(o, p)| card(o, p.as_ref()))
            .collect::<Vec<_>>();
        Ok(Value::Array(
            localize_offers(self.state, &rows, &self.locale).await?,
        ))
    }
    async fn purchase(&self, regular: bool, key: &str) -> Result<Response> {
        let offer = self.offer().await?;
        if regular && (offer["offerType"] != "BASE_GAME" || offer["prePurchase"] != true) {
            return Ok(ok(&json!({"isPrepurchase":false})));
        }
        let field = if regular {
            "isPrepurchase"
        } else {
            "hasPrepurchase"
        };
        let filter = doc! {"namespace":bson(&offer["namespace"]),"offerType":"BASE_GAME","prePurchase":if regular{Bson::Document(doc!{"$ne":true})}else{Bson::Boolean(true)},"id":{"$ne":self.id}};
        let Some(found) = one(self.state, "offers", filter).await? else {
            // These two legacy handlers cache a bare boolean on a negative lookup.
            store(self.state, key, &json!(regular), 3600).await?;
            return Ok(minute(&json!({field:false})));
        };
        let price = one(
            self.state,
            "pricev2",
            doc! {"offerId":bson(&found["id"]),"region":self.region},
        )
        .await?;
        let offer = localize_offers(self.state, &[card(&found, price.as_ref())], &self.locale)
            .await?
            .pop()
            .unwrap();
        self.save(key, json!({field:true,"offer":offer}), 3600)
            .await
    }
    async fn save(&self, key: &str, value: Value, ttl: u64) -> Result<Response> {
        store(
            self.state,
            key,
            &value,
            get_localized_cache_ttl_seconds(&value, ttl),
        )
        .await?;
        Ok(minute(&value))
    }
}

async fn relation(
    State(state): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Response> {
    let locale = parse_locale(query(&uri, "locale").as_deref())
        .map_err(|e| Error::Json(StatusCode::BAD_REQUEST, json!({"message":e.to_string()})))?;
    let region = selected_region(&uri, &headers)
        .map(|(code, _)| code)
        .ok_or_else(|| not_found("Country not found"))?;
    let locale_key = locale_cache_segment(&locale);
    let rel = Relation {
        state: &state,
        id: &id,
        region,
        locale,
    };
    let name = uri
        .path()
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("");
    let collection = if name == "collection" {
        let offer = rel.offer().await?;
        if !offer["categories"]
            .as_array()
            .is_some_and(|categories| categories.iter().any(|c| c == "collections"))
        {
            return Err(not_found("Selected offer does not have a collection"));
        }
        Some(offer)
    } else {
        None
    };
    let prefix = match name {
        "collection" => "collection-offers",
        "related" => "related-offers",
        v => v,
    };
    let key = if matches!(name, "has-regular" | "has-prepurchase") {
        format!("{prefix}:{id}:{region}:{locale_key}")
    } else {
        let expanded = query(&uri, "expand").is_some_and(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "true" | "1" | "full"
            )
        });
        format!(
            "{prefix}:{id}:{region}:{locale_key}:{}:v0.2",
            if expanded { "full" } else { "card" }
        )
    };
    if let Some(hit) = cached(&state, &key).await? {
        return Ok(minute(&hit));
    }
    let value = match name {
        "collection" => rel.collection(collection.unwrap()).await?,
        "bundle" => rel.bundle().await?,
        "in-bundle" => rel.in_bundle().await?,
        "has-regular" | "has-prepurchase" => {
            return rel.purchase(name == "has-regular", &key).await;
        }
        "related" | "suggestions" => rel.discovery(name == "related").await?,
        _ => return Err(Error::Internal),
    };
    rel.save(
        &key,
        value,
        if matches!(name, "related" | "suggestions") {
            60
        } else {
            3600
        },
    )
    .await
}
