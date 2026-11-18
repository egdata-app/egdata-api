use super::relationships::{array, ids, localized};
use super::{GraphqlServices, arg_string, js_truthy, offers, pagination};
use async_graphql::Result;
use bson::{Document, doc, oid::ObjectId};
use egdata_core::{
    attributes::order_offers_object,
    countries::{AGE_RATINGS_COUNTRIES, country_to_region},
    localization::{get_localized_cache_ttl_seconds, locale_cache_segment},
    ports::MongoFindOptions,
};
use serde_json::{Value, json};
use std::collections::HashSet;

fn ordered(offer: Value) -> Value {
    offer
        .as_object()
        .map(|o| json!(order_offers_object(o)))
        .unwrap_or(Value::Null)
}

fn distinct(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|v| !v.is_empty() && seen.insert(v.clone()))
        .collect()
}

fn releases(items: &[Value]) -> impl Iterator<Item = (&Value, &Value)> {
    items.iter().flat_map(|item| {
        array(&item["releaseInfo"])
            .iter()
            .map(move |release| (item, release))
    })
}

fn app_ids(items: &[Value]) -> Vec<String> {
    distinct(releases(items).filter_map(|(_, r)| r["appId"].as_str().map(str::to_owned)))
}

fn platforms(v: &Value) -> impl Iterator<Item = &str> {
    array(&v["platform"]).iter().filter_map(Value::as_str)
}

fn millis(date: &Value) -> i64 {
    date.as_i64()
        .or_else(|| {
            chrono::DateTime::parse_from_rfc3339(date.as_str()?)
                .ok()
                .map(|d| d.timestamp_millis())
        })
        .unwrap_or(0)
}

async fn primary(id: &str, s: &GraphqlServices) -> Result<(&'static str, Value, Value)> {
    let base = doc! {"namespace":{"$eq":id},"offerType":"BASE_GAME"};
    let mut regular = base.clone();
    regular.extend(doc! {"prePurchase":{"$ne":true},"isCodeRedemptionOnly":false});
    if let Some(offer) = s.one("offers", regular).await? {
        return Ok(("offer", offer, Value::Null));
    }
    let mut preorder = base;
    preorder.insert("prePurchase", true);
    if let Some(offer) = s.one("offers", preorder).await? {
        return Ok(("offer", offer, Value::Null));
    }
    if let Some(item)=s.one("items",doc!{"namespace":{"$eq":id},"entitlementType":"EXECUTABLE","releaseInfo.0":{"$exists":true}}).await? {
        return Ok(("item",Value::Null,item));
    }
    Ok(("none", Value::Null, Value::Null))
}

fn virtual_platforms<'a>(
    items: &'a [Value],
    assets: &[Value],
) -> Vec<(&'a Value, &'a Value, &'a str)> {
    let artifacts: HashSet<_> = assets.iter().map(|a| a["artifactId"].as_str()).collect();
    releases(items)
        .filter(|(_, r)| !artifacts.contains(&r["appId"].as_str()))
        .flat_map(|(i, r)| platforms(r).map(move |p| (i, r, p)))
        .collect()
}

async fn stats(
    offers: u64,
    items: &[Value],
    sets: &[Value],
    assets: &[Value],
    s: &GraphqlServices,
) -> Result<Value> {
    let builds = s
        .mongo
        .count_documents("builds", doc! {"appName":{"$in":app_ids(items)}})
        .await?;
    Ok(
        json!({"offers":offers,"items":items.len(),"assets":assets.len()+virtual_platforms(items,assets).len(),"builds":builds,
        "achievements":sets.iter().map(|v|array(&v["achievements"]).len()).sum::<usize>()}),
    )
}

pub(super) async fn resolve(
    field: &str,
    parent: &Value,
    args: &Value,
    s: &GraphqlServices,
) -> Result<Value> {
    if field == "sandboxHub" {
        return hub(args, s).await;
    }
    let id = parent["_id"].as_str().unwrap_or_default();
    let (limit, page, skip) = pagination(args, 10, 100);
    let filter = doc! {"namespace":id};
    let options = |sort: Document| MongoFindOptions {
        sort: Some(sort),
        limit: Some(limit as i64),
        skip: Some(skip),
        ..Default::default()
    };
    match field {
        "offers" => {
            let locale = offers::resolve_locale(args, parent)?;
            let rows = s
                .rows(
                    "offers",
                    filter.clone(),
                    options(doc! {"lastModifiedDate":-1}),
                )
                .await?;
            let elements = offers::localize_ordered_offers(
                s.mongo.as_ref(),
                rows.into_iter().map(ordered).collect(),
                &locale,
            )
            .await?;
            let total = s.mongo.count_documents("offers", filter).await?;
            Ok(json!({"elements":elements,"total":total,"page":page,"limit":limit}))
        }
        "baseGame" => {
            let locale = offers::resolve_locale(args, parent)?;
            let (_, offer, item) = primary(id, s).await?;
            if offer.is_null() {
                Ok(item)
            } else {
                Ok(
                    offers::localize_ordered_offers(
                        s.mongo.as_ref(),
                        vec![ordered(offer)],
                        &locale,
                    )
                    .await?
                    .pop()
                    .unwrap_or(Value::Null),
                )
            }
        }
        "achievements" => {
            let mut result = s
                .loaders
                .one(super::loaders::Lookup::Achievements, id)
                .await?;
            result
                .as_array_mut()
                .expect("achievement set loader groups rows into lists")
                .truncate(100);
            Ok(result)
        }
        "stats" => {
            let (offers, items, sets, assets) = tokio::try_join!(
                async {
                    Ok::<_, async_graphql::Error>(
                        s.mongo.count_documents("offers", filter.clone()).await?,
                    )
                },
                s.rows("items", filter.clone(), Default::default()),
                s.rows("achievementsets", doc! {"sandboxId":id}, Default::default()),
                s.rows("assets", filter.clone(), Default::default())
            )?;
            stats(offers, &items, &sets, &assets, s).await
        }
        "assets" => {
            let items = s
                .rows(
                    "items",
                    filter.clone(),
                    MongoFindOptions {
                        projection: Some(doc! {"id":1,"namespace":1,"releaseInfo":1,"title":1}),
                        ..Default::default()
                    },
                )
                .await?;
            let mut assets = s
                .rows(
                    "assets",
                    filter,
                    MongoFindOptions {
                        sort: Some(doc! {"updatedAt":-1}),
                        ..Default::default()
                    },
                )
                .await?;
            for (item, release, platform) in virtual_platforms(&items, &assets) {
                let mut asset = json!({"artifactId":release["appId"],"downloadSizeBytes":0,"installedSizeBytes":0,"platform":platform,"_id":ObjectId::new().to_hex(),"updatedAt":"1970-01-01T00:00:00.000Z"});
                for (out, key) in [
                    ("itemId", "id"),
                    ("namespace", "namespace"),
                    ("title", "title"),
                ] {
                    if let Some(value) = item.get(key) {
                        asset[out] = value.clone();
                    }
                }
                assets.push(asset);
            }
            assets.sort_by_key(|r| std::cmp::Reverse(millis(&r["updatedAt"])));
            if let Some(wanted) = args["platform"].as_str().filter(|v| !v.is_empty()) {
                assets.retain(|a| wanted.split(',').any(|p| Some(p) == a["platform"].as_str()));
            }
            let total = assets.len();
            let elements = assets
                .into_iter()
                .skip(skip as usize)
                .take(limit)
                .collect::<Vec<_>>();
            Ok(json!({"elements":elements,"total":total,"count":total,"limit":limit,"page":page}))
        }
        "builds" => {
            let selected = args["platform"]
                .as_str()
                .unwrap_or_default()
                .split(',')
                .filter(|v| !v.is_empty())
                .collect::<Vec<_>>();
            let mut query = filter;
            if !selected.is_empty() {
                query.insert(
                    "releaseInfo",
                    doc! {"$elemMatch":{"platform":{"$in":selected.clone()}}},
                );
            }
            let items = s
                .rows(
                    "items",
                    query,
                    MongoFindOptions {
                        projection: Some(doc! {"releaseInfo":1}),
                        ..Default::default()
                    },
                )
                .await?;
            let app_ids = releases(&items)
                .filter(|(_, r)| selected.is_empty() || platforms(r).any(|p| selected.contains(&p)))
                .filter_map(|(_, r)| r["appId"].as_str().filter(|v| !v.is_empty()))
                .collect::<Vec<_>>();
            let filter = doc! {"appName":{"$in":app_ids}};
            let rows = s
                .rows("builds", filter.clone(), options(doc! {"updatedAt":-1}))
                .await?;
            let total = s.mongo.count_documents("builds", filter).await?;
            Ok(json!({"elements":rows,"total":total,"limit":limit,"page":page}))
        }
        _ => Ok(Value::Null),
    }
}

fn first(values: &[&Value]) -> Value {
    values
        .iter()
        .find(|v| js_truthy(v))
        .map(|v| (*v).clone())
        .unwrap_or(Value::Null)
}

fn offer_precedence(offer: &Value) -> (usize, std::cmp::Reverse<i64>) {
    let rank = match offer["offerType"].as_str() {
        Some("BASE_GAME") => 0,
        Some("EDITION") => 1,
        Some("BUNDLE") => 2,
        Some("DLC") => 3,
        Some("ADD_ON" | "ADDON") => 4,
        Some("PASS") => 5,
        Some("SEASON") => 6,
        Some("DEMO") => 7,
        _ => 99,
    };
    (
        rank,
        std::cmp::Reverse(millis(&first(&[
            &offer["releaseDate"],
            &offer["effectiveDate"],
            &offer["creationDate"],
        ]))),
    )
}

async fn hub(args: &Value, s: &GraphqlServices) -> Result<Value> {
    let id = arg_string(args, "id")?;
    let locale = offers::resolve_locale(args, &Value::Null)?;
    let country = args["country"]
        .as_str()
        .filter(|v| !v.is_empty())
        .unwrap_or("US");
    let clamp = |key: &str| args[key].as_i64().unwrap_or(8).clamp(1, 24);
    let offer_limit = clamp("offerLimit");
    let update_limit = clamp("updateLimit");
    let key = format!(
        "sandboxHub:{id}:{country}:{offer_limit}:{update_limit}:{}",
        locale_cache_segment(&locale)
    );
    if let Some(hit) = s.cache.get(&key).await?
        && let Ok(value) = serde_json::from_str(&hit)
    {
        return Ok(value);
    }
    let Some(mut sandbox) = s.one("sandboxes", doc! {"_id":{"$eq":id}}).await? else {
        s.cache.set(&key, "null", 3600).await?;
        return Ok(Value::Null);
    };
    let (kind, offer, item) = primary(id, s).await?;
    let filter = doc! {"namespace":id};
    let (items, sets, raw_offers) = tokio::try_join!(
        s.rows("items", filter.clone(), Default::default()),
        s.rows("achievementsets", doc! {"sandboxId":id}, Default::default()),
        s.rows(
            "offers",
            filter,
            MongoFindOptions {
                sort: Some(doc! {"lastModifiedDate":-1}),
                limit: Some(offer_limit * 3),
                ..Default::default()
            }
        )
    )?;
    let apps = app_ids(&items);
    let mut contexts = vec![id.to_owned()];
    contexts.extend(ids(&raw_offers, "id"));
    contexts.extend(ids(&items, "id"));
    contexts.extend(apps.clone());
    let tags = distinct(raw_offers.iter().flat_map(|v| ids(array(&v["tags"]), "id")));
    let updates = |key: &str| MongoFindOptions {
        sort: Some(doc! {key:-1}),
        limit: Some(update_limit),
        ..Default::default()
    };
    let (price, stats, builds, changes, genres) = tokio::try_join!(
        async {
            if offer.is_null() {
                Ok(None)
            } else {
                s.one("pricev2",doc!{"offerId":{"$eq":offer["id"].as_str()},"region":{"$eq":country_to_region(Some(country),"US")}}).await
            }
        },
        async {
            let filter = doc! {"namespace":id};
            let (offers, assets) = tokio::try_join!(
                async {
                    Ok::<_, async_graphql::Error>(
                        s.mongo.count_documents("offers", filter.clone()).await?,
                    )
                },
                s.rows("assets", filter.clone(), Default::default())
            )?;
            stats(offers, &items, &sets, &assets, s).await
        },
        async {
            if apps.is_empty() {
                Ok(Vec::new())
            } else {
                s.rows(
                    "builds",
                    doc! {"appName":{"$in":apps}},
                    updates("updatedAt"),
                )
                .await
            }
        },
        s.rows(
            "changelogs_v2",
            doc! {"metadata.contextId":{"$in":contexts}},
            updates("timestamp")
        ),
        async {
            if tags.is_empty() {
                Ok(Vec::new())
            } else {
                s.rows(
                    "tags",
                    doc! {"id":{"$in":tags},"groupName":"genre"},
                    Default::default(),
                )
                .await
            }
        }
    )?;
    let platforms = distinct(
        releases(&items)
            .flat_map(|(_, r)| platforms(r).map(str::to_owned))
            .chain(
                array(&offer["tags"])
                    .iter()
                    .filter(|tag| tag["groupName"] == "platform")
                    .filter_map(|tag| tag["name"].as_str().map(str::to_owned)),
            ),
    );
    let primary = localized(offer, &locale, s).await?;
    let mut featured = raw_offers;
    featured.sort_by_key(offer_precedence);
    featured.truncate(offer_limit as usize);
    let featured = offers::localize_offers(s.mongo.as_ref(), featured, &locale).await?;
    let rating = AGE_RATINGS_COUNTRIES
        .iter()
        .find(|(_, cs)| cs.contains(&country))
        .map_or("Generic", |(k, _)| k);
    let all = sets
        .iter()
        .flat_map(|r| array(&r["achievements"]))
        .collect::<Vec<_>>();
    let score = |a: &&Value| {
        let n = a.get("score").filter(|v| !v.is_null()).unwrap_or(&a["xp"]);
        n.as_f64()
            .or_else(|| n.as_str()?.parse().ok())
            .filter(|v| v.is_finite())
            .unwrap_or(0.)
    };
    let achievements = json!({"sets":sets.len(),"total":all.len(),"baseTotal":sets.iter().filter(|r|js_truthy(&r["isBase"])).map(|r|array(&r["achievements"]).len()).sum::<usize>(),"xp":all.iter().map(score).sum::<f64>()});
    sandbox["locale"] = json!(locale);
    let mut hub = json!({"id":id,"namespace":id,"title":first(&[&primary["title"],&item["title"],&sandbox["displayName"],&sandbox["name"],&json!(id)]),
        "description":first(&[&primary["description"],&primary["longDescription"],&item["description"],&sandbox["displayName"]]).as_str().unwrap_or(""),
        "primaryKind":kind,"primaryOffer":primary,"primaryItem":item,"sandbox":sandbox,"price":price,"seller":primary["seller"],
        "developer":first(&[&primary["developerDisplayName"],&item["developer"]]),"publisher":first(&[&primary["publisherDisplayName"]]),
        "keyImages":first(&[&primary["keyImages"],&item["keyImages"],&json!([])]),"genres":genres,"platforms":platforms,"stats":stats,
        "featuredOffers":featured,"recentBuilds":builds,"recentChanges":changes,"ageRating":first(&[&sandbox["ageGatings"][rating],&sandbox["ageGatings"]["Generic"]]),"achievements":achievements});
    for (key, skey, okey) in [
        ("created", "createdAt", "creationDate"),
        ("updated", "updatedAt", "lastModifiedDate"),
    ] {
        let v = first(&[&sandbox[key], &sandbox[skey], &primary[okey], &item[okey]]);
        if !v.is_null() {
            hub[key] = v;
        }
    }
    s.cache
        .set(
            &key,
            &egdata_core::v1::serialization::node_json(&hub),
            get_localized_cache_ttl_seconds(&hub, 3600),
        )
        .await?;
    Ok(hub)
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use egdata_core::{
        error::CoreError,
        ports::{EpicStorePort, MongoDocumentStream, MongoStorePort, ResponseCachePort},
    };
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct MockSandboxStore {
        cache: Mutex<HashMap<String, String>>,
        sandboxes: Mutex<Vec<Document>>,
        offers: Mutex<Vec<Document>>,
        items: Mutex<Vec<Document>>,
        assets: Mutex<Vec<Document>>,
        fail_collection: Mutex<Option<&'static str>>,
    }

    #[async_trait]
    impl MongoStorePort for MockSandboxStore {
        async fn find_one(
            &self,
            collection: &str,
            _filter: Document,
            _projection: Option<Document>,
        ) -> std::result::Result<Option<Document>, CoreError> {
            Ok(match collection {
                "sandboxes" => self.sandboxes.lock().unwrap().first().cloned(),
                _ => None,
            })
        }
        async fn find_many(
            &self,
            collection: &str,
            _filter: Document,
            _options: MongoFindOptions,
        ) -> std::result::Result<Vec<Document>, CoreError> {
            if self.fail_collection.lock().unwrap().as_deref() == Some(collection) {
                return Err(CoreError::Internal("mock find_many failed".into()));
            }
            Ok(match collection {
                "offers" => self.offers.lock().unwrap().clone(),
                "items" => self.items.lock().unwrap().clone(),
                "assets" => self.assets.lock().unwrap().clone(),
                _ => vec![],
            })
        }
        async fn find_stream(
            &self,
            _: &str,
            _: Document,
            _: MongoFindOptions,
        ) -> std::result::Result<MongoDocumentStream, CoreError> {
            Ok(Box::pin(futures::stream::empty()))
        }
        async fn aggregate(
            &self,
            _: &str,
            _: Vec<Document>,
        ) -> std::result::Result<Vec<Document>, CoreError> {
            Ok(vec![])
        }
        async fn count_documents(
            &self,
            collection: &str,
            _: Document,
        ) -> std::result::Result<u64, CoreError> {
            if self.fail_collection.lock().unwrap().as_deref() == Some(collection) {
                return Err(CoreError::Internal("mock count failed".into()));
            }
            Ok(0)
        }
        async fn distinct(
            &self,
            _: &str,
            _: &str,
            _: Document,
        ) -> std::result::Result<Vec<bson::Bson>, CoreError> {
            Ok(vec![])
        }
        async fn insert_one(&self, _: &str, _: Document) -> std::result::Result<(), CoreError> {
            Ok(())
        }
        async fn update_one(
            &self,
            _: &str,
            _: Document,
            _: Document,
            _: bool,
        ) -> std::result::Result<u64, CoreError> {
            Ok(0)
        }
        async fn delete_one(&self, _: &str, _: Document) -> std::result::Result<u64, CoreError> {
            Ok(0)
        }
        async fn ping(&self) -> std::result::Result<bool, CoreError> {
            Ok(true)
        }
    }

    #[async_trait]
    impl ResponseCachePort for MockSandboxStore {
        async fn get(&self, key: &str) -> std::result::Result<Option<String>, CoreError> {
            Ok(self.cache.lock().unwrap().get(key).cloned())
        }
        async fn set(
            &self,
            key: &str,
            value: &str,
            _ttl: u64,
        ) -> std::result::Result<(), CoreError> {
            self.cache
                .lock()
                .unwrap()
                .insert(key.to_owned(), value.to_owned());
            Ok(())
        }
        async fn del(&self, _: &str) -> std::result::Result<(), CoreError> {
            Ok(())
        }
        async fn ping(&self) -> std::result::Result<bool, CoreError> {
            Ok(true)
        }
    }

    #[async_trait]
    impl EpicStorePort for MockSandboxStore {
        async fn graphql(&self, _: &str, _: &Value) -> std::result::Result<Value, CoreError> {
            Ok(Value::Null)
        }
        async fn featured_games(&self) -> std::result::Result<Vec<Value>, CoreError> {
            Ok(vec![])
        }
    }

    #[tokio::test]
    async fn sandbox_covers_precedence_platform_filter_empty_hub_and_cache() {
        // Cover offer_precedence for every variant.
        let types = [
            "BASE_GAME",
            "EDITION",
            "BUNDLE",
            "DLC",
            "ADD_ON",
            "PASS",
            "SEASON",
            "DEMO",
            "OTHER",
        ];
        let ranks: Vec<_> = types
            .iter()
            .map(|ty| offer_precedence(&json!({"offerType": ty, "creationDate": 1000})).0)
            .collect();
        assert_eq!(ranks, vec![0, 1, 2, 3, 4, 5, 6, 7, 99]);

        let store = Arc::new(MockSandboxStore::default());
        let services = GraphqlServices::new(store.clone(), store.clone(), store.clone());

        // primary returns ("none", Null, Null) and baseGame returns Null.
        assert_eq!(
            resolve(
                "baseGame",
                &json!({"_id": "sb-none"}),
                &json!({}),
                &services
            )
            .await
            .unwrap(),
            Value::Null
        );

        // Sandbox.assets platform filter.
        *store.assets.lock().unwrap() = vec![
            bson::to_document(&json!({"artifactId": "a1", "platform": "Windows", "updatedAt": "2025-01-01T00:00:00Z"})).unwrap(),
            bson::to_document(&json!({"artifactId": "a2", "platform": "Mac", "updatedAt": "2025-01-01T00:00:00Z"})).unwrap(),
        ];
        let assets = resolve(
            "assets",
            &json!({"_id": "sb-1"}),
            &json!({"platform": "Mac"}),
            &services,
        )
        .await
        .unwrap();
        assert_eq!(assets["total"], 1);

        // sandboxHub: malformed cache payload falls through, populated sandbox with no primary offer, no apps, no tags.
        store.cache.lock().unwrap().insert(
            "sandboxHub:sb-empty:US:8:8:en".into(),
            "{invalid json".into(),
        );
        *store.sandboxes.lock().unwrap() = vec![
            bson::to_document(&json!({"_id": "sb-empty", "displayName": "Empty Hub"})).unwrap(),
        ];
        let hub_res = resolve(
            "sandboxHub",
            &Value::Null,
            &json!({"id": "sb-empty"}),
            &services,
        )
        .await
        .unwrap();
        assert_eq!(hub_res["primaryKind"], "none");
        assert_eq!(hub_res["title"], "Empty Hub");

        // Cache hit on second call.
        let hit = resolve(
            "sandboxHub",
            &Value::Null,
            &json!({"id": "sb-empty"}),
            &services,
        )
        .await
        .unwrap();
        assert_eq!(hit["title"], "Empty Hub");

        // Sandbox.assets without platform filter.
        let all_assets = resolve("assets", &json!({"_id": "sb-1"}), &json!({}), &services)
            .await
            .unwrap();
        assert_eq!(all_assets["total"], 2);

        // Error branches inside stats and sandboxHub try_join! calls.
        *store.fail_collection.lock().unwrap() = Some("items");
        assert!(
            resolve("stats", &json!({"_id": "sb-1"}), &json!({}), &services)
                .await
                .is_err()
        );
        store.cache.lock().unwrap().clear();
        assert!(
            resolve(
                "sandboxHub",
                &Value::Null,
                &json!({"id": "sb-empty"}),
                &services
            )
            .await
            .is_err()
        );
        *store.fail_collection.lock().unwrap() = Some("changelogs_v2");
        assert!(
            resolve(
                "sandboxHub",
                &Value::Null,
                &json!({"id": "sb-empty"}),
                &services
            )
            .await
            .is_err()
        );
        *store.fail_collection.lock().unwrap() = Some("assets");
        assert!(
            resolve(
                "sandboxHub",
                &Value::Null,
                &json!({"id": "sb-empty"}),
                &services
            )
            .await
            .is_err()
        );

        // Exercise remaining trait stubs on MockSandboxStore.
        assert!(
            store
                .find_one("other", Document::new(), None)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .find_stream("c", Document::new(), Default::default())
                .await
                .is_ok()
        );
        assert!(store.aggregate("c", vec![]).await.unwrap().is_empty());
        assert!(
            store
                .distinct("c", "f", Document::new())
                .await
                .unwrap()
                .is_empty()
        );
        assert!(store.insert_one("c", Document::new()).await.is_ok());
        assert_eq!(
            store
                .update_one("c", Document::new(), Document::new(), false)
                .await
                .unwrap(),
            0
        );
        assert_eq!(store.delete_one("c", Document::new()).await.unwrap(), 0);
        assert!(MongoStorePort::ping(store.as_ref()).await.unwrap());
        assert!(store.del("k").await.is_ok());
        assert!(ResponseCachePort::ping(store.as_ref()).await.unwrap());
        assert!(store.graphql("q", &Value::Null).await.unwrap().is_null());
        assert!(store.featured_games().await.unwrap().is_empty());
    }
}
