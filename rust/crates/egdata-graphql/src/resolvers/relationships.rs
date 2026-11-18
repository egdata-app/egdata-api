use super::{GraphqlServices, js_truthy, offers, pagination};
use async_graphql::Result;
use bson::doc;
use egdata_core::ports::MongoFindOptions;
use serde_json::{Value, json};

pub(super) fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_default()
}

pub(super) fn ids(rows: &[Value], key: &str) -> Vec<String> {
    rows.iter()
        .filter_map(|row| row[key].as_str().map(str::to_owned))
        .collect()
}

pub(super) async fn localized(
    offer: Value,
    locale: &str,
    services: &GraphqlServices,
) -> Result<Value> {
    if offer.is_null() {
        return Ok(Value::Null);
    }
    Ok(
        offers::localize_offers(services.mongo.as_ref(), vec![offer], locale)
            .await?
            .pop()
            .unwrap_or(Value::Null),
    )
}

pub(super) async fn document(
    parent: &Value,
    args: &Value,
    services: &GraphqlServices,
) -> Result<Value> {
    let locale = offers::resolve_locale(args, &Value::Null)?;
    if js_truthy(&parent["document"]) {
        let document = parent["document"].clone();
        return if js_truthy(&document["offerType"]) {
            localized(document, &locale, services).await
        } else {
            Ok(document)
        };
    }
    let meta = &parent["metadata"];
    let (collection, key) = match meta["contextType"].as_str() {
        Some("item") => ("items", "id"),
        Some("asset") => ("assets", "artifactId"),
        Some("offer") => ("offers", "id"),
        _ => return Ok(Value::Null),
    };
    let document = services
        .one(collection, doc! {key:{"$eq":meta["contextId"].as_str()}})
        .await?
        .unwrap_or(Value::Null);
    if collection == "offers" {
        localized(document, &locale, services).await
    } else {
        Ok(document)
    }
}

pub(super) async fn item_offers(
    field: &str,
    parent: &Value,
    args: &Value,
    s: &GraphqlServices,
) -> Result<Value> {
    let locale = offers::resolve_locale(args, &Value::Null)?;
    let id = parent["id"].as_str();
    if field == "offers" {
        let rows = s
            .rows(
                "offers",
                doc! {"items.id":id},
                MongoFindOptions {
                    limit: Some(100),
                    ..Default::default()
                },
            )
            .await?;
        return Ok(Value::Array(
            offers::localize_offers(s.mongo.as_ref(), rows, &locale).await?,
        ));
    }
    let subitems = s
        .rows(
            "offersubitems",
            doc! {"subItems.id":id},
            MongoFindOptions {
                projection: Some(doc! {"_id":1}),
                ..Default::default()
            },
        )
        .await?;
    let rows = s
        .rows(
            "offers",
            doc! {"id":{"$in":ids(&subitems,"_id")},"offerType":"BASE_GAME"},
            Default::default(),
        )
        .await?;
    let selected = rows
        .iter()
        .find(|row| !js_truthy(&row["prePurchase"]))
        .or_else(|| rows.first())
        .cloned()
        .unwrap_or(Value::Null);
    localized(selected, &locale, s).await
}

pub(super) async fn changelog(
    ty: &str,
    parent: &Value,
    args: &Value,
    s: &GraphqlServices,
) -> Result<Value> {
    let mut contexts = Vec::new();
    match ty {
        "Item" => {
            let id = parent["id"].as_str().unwrap_or_default();
            let assets = s
                .rows("assets", doc! {"itemId":id}, Default::default())
                .await?;
            let artifacts = ids(&assets, "artifactId");
            let builds = s
                .rows(
                    "builds",
                    doc! {"appName":{"$in":&artifacts}},
                    Default::default(),
                )
                .await?;
            contexts.push(id.to_owned());
            contexts.extend(artifacts);
            contexts.extend(ids(&builds, "_id"));
        }
        "Offer" => {
            let id = parent["id"]
                .as_str()
                .filter(|v| !v.is_empty())
                .or(parent["_id"].as_str())
                .unwrap_or_default();
            let links = s
                .rows("offersubitems", doc! {"_id":id}, Default::default())
                .await?;
            let mut linked = ids(array(&parent["items"]), "id");
            for row in links {
                linked.extend(ids(array(&row["subItems"]), "id"));
            }
            let items = s
                .rows(
                    "items",
                    doc! {"$or":[{"id":{"$in":linked}},{"linkedOffers":id}]},
                    Default::default(),
                )
                .await?;
            let item_ids = ids(&items, "id");
            let assets = s
                .rows(
                    "assets",
                    doc! {"itemId":{"$in":&item_ids}},
                    Default::default(),
                )
                .await?;
            contexts.push(id.to_owned());
            contexts.extend(item_ids);
            contexts.extend(ids(&assets, "artifactId"));
        }
        _ => {
            let id = parent["_id"].as_str().unwrap_or_default();
            let offers = s
                .rows(
                    "offers",
                    doc! {"namespace":id},
                    MongoFindOptions {
                        sort: Some(doc! {"lastModifiedDate":-1}),
                        limit: Some(100),
                        ..Default::default()
                    },
                )
                .await?;
            let linked = offers
                .iter()
                .flat_map(|offer| ids(array(&offer["items"]), "id"))
                .collect::<Vec<_>>();
            let items = s
                .rows(
                    "items",
                    doc! {"$or":[{"id":{"$in":linked}},{"namespace":id}]},
                    MongoFindOptions {
                        projection: Some(doc! {"id":1,"releaseInfo":1}),
                        limit: Some(100),
                        ..Default::default()
                    },
                )
                .await?;
            let item_ids = ids(&items, "id");
            let assets = s
                .rows(
                    "assets",
                    doc! {"itemId":{"$in":&item_ids}},
                    Default::default(),
                )
                .await?;
            let apps = items
                .iter()
                .flat_map(|item| ids(array(&item["releaseInfo"]), "appId"))
                .collect::<Vec<_>>();
            let builds = s
                .rows(
                    "builds",
                    doc! {"appName":{"$in":apps}},
                    MongoFindOptions {
                        sort: Some(doc! {"updatedAt":-1}),
                        limit: Some(500),
                        ..Default::default()
                    },
                )
                .await?;
            contexts.push(id.to_owned());
            contexts.extend(ids(&offers, "id"));
            contexts.extend(item_ids);
            contexts.extend(ids(&assets, "artifactId"));
            contexts.extend(ids(&builds, "_id"));
        }
    }
    let filter = doc! {"metadata.contextId":{"$in":contexts}};
    let (limit, page, skip) = pagination(args, 10, 100);
    let total = s
        .mongo
        .count_documents("changelogs_v2", filter.clone())
        .await?;
    let rows = s
        .rows(
            "changelogs_v2",
            filter,
            MongoFindOptions {
                sort: Some(doc! {"timestamp":-1}),
                skip: Some(skip),
                limit: Some(limit as i64),
                ..Default::default()
            },
        )
        .await?;
    Ok(
        json!({"elements":rows,"totalCount":total,"totalPages":total.div_ceil(limit as u64),"hasNextPage":page*limit<total as usize,"hasPreviousPage":page>1}),
    )
}
