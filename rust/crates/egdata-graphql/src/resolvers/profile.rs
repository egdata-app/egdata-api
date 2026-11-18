//! Public player profiles. Redis entries are shared across requests; in-flight
//! profile reads and aggregation results are shared only within one execution.
mod aggregation;
use super::{GraphqlServices, arg_string, js_truthy, pagination, relationships::array};
use async_graphql::{Error, Result};
use bson::doc;
use egdata_core::{
    catalog::{CatalogCollation, node_collator},
    v1::serialization::node_json,
};
use serde_json::{Value, json};
use std::{
    cmp::Ordering,
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex},
};
use tokio::sync::OnceCell;

#[derive(Default)]
pub(super) struct ProfileRequestCache(Mutex<HashMap<String, Arc<OnceCell<Result<Value>>>>>);

impl ProfileRequestCache {
    fn memo<'a>(
        &'a self,
        key: String,
        load: impl Future<Output = Result<Value>> + 'a,
    ) -> impl Future<Output = Result<Value>> + 'a {
        let load = Box::pin(load);
        async move {
            let cell = self.0.lock().unwrap().entry(key).or_default().clone();
            cell.get_or_init(|| load).await.clone()
        }
    }
}

fn cached<'a>(
    s: &'a GraphqlServices,
    id: &str,
    key: &str,
    ttl: u64,
    load: impl Future<Output = Result<Value>> + 'a,
) -> impl Future<Output = Result<Value>> + 'a {
    let key = format!("graphql:profile:{id}:{key}:v2");
    s.profile_cache.memo(key.clone(), async move {
        if let Some(stored) = s.cache.get(&key).await?.filter(|text| !text.is_empty()) {
            return serde_json::from_str(&stored).map_err(|e| Error::new(e.to_string()));
        }
        let value = load.await?;
        s.cache.set(&key, &node_json(&value), ttl).await?;
        Ok(value)
    })
}

async fn identity(s: &GraphqlServices, id: &str) -> Result<Value> {
    cached(s,id,"identity",3600,async {
        let Some(epic)=s.epic.get_user(id).await? else {return Ok(Value::Null)};
        let (row,count)=tokio::try_join!(
            s.one("epic",doc!{"accountId":{"$eq":id}}),
            async { Ok::<_,Error>(s.mongo.count_documents("reviews",doc!{"userId":id}).await?) }
        )?;
        let row=row.unwrap_or(Value::Null);
        let avatar=|size:&str| row.pointer("/avatarUrl/variants/0").filter(|v|!v.is_null()).unwrap_or(&epic["avatar"][size]).clone();
        Ok(json!({"accountId":id,"displayName":epic["displayName"],"avatar":{"small":avatar("small"),"medium":avatar("medium"),"large":avatar("large")},"linkedAccounts":row["linkedAccounts"],"creationDate":row["creationDate"],"reviewsCount":count}))
    }).await
}

fn number(v: &Value) -> f64 {
    match v {
        Value::String(s) => crate::schema::js_number(s).unwrap_or(f64::NAN),
        Value::Number(n) => n.as_f64().unwrap_or(0.),
        Value::Bool(b) => f64::from(i32::from(*b)),
        Value::Null => 0.,
        Value::Array(items) if items.is_empty() => 0.,
        Value::Array(items) if items.len() == 1 && !items[0].is_boolean() => number(&items[0]),
        _ => f64::NAN,
    }
}
fn numeric(n: f64) -> Value {
    if n.fract() == 0. && n.abs() < i64::MAX as f64 {
        json!(n as i64)
    } else {
        json!(n)
    }
}
fn descending(a: &Value, b: &Value, key: &str) -> Ordering {
    number(&b[key]).total_cmp(&number(&a[key]))
}

fn compare_games(a: &Value, b: &Value, sort: &str, collator: &CatalogCollation) -> Ordering {
    let by_name = || {
        collator
            .compare(
                a["title"].as_str().unwrap_or_default(),
                b["title"].as_str().unwrap_or_default(),
            )
            .then_with(|| {
                collator.compare(
                    a["sandboxId"].as_str().unwrap_or_default(),
                    b["sandboxId"].as_str().unwrap_or_default(),
                )
            })
    };
    if sort == "ALPHABETICAL" {
        return by_name();
    }
    let first = match sort {
        "XP" => descending(a, b, "earnedXP"),
        "ACHIEVEMENTS" => descending(a, b, "unlocked"),
        _ => Ordering::Equal,
    };
    first
        .then_with(|| descending(a, b, "completionPercent"))
        .then_with(|| descending(a, b, "earnedXP"))
        .then_with(|| descending(a, b, "unlocked"))
        .then_with(by_name)
}

async fn games(s: &GraphqlServices, id: &str, filter: &str, sort: &str) -> Result<Value> {
    let key = format!("games:{filter}:{sort}");
    cached(s, id, &key, 60, async {
        let data = aggregation::load(s, id).await?;
        let mut games = array(&data["games"]).to_vec();
        games.retain(|g| {
            let completion = number(&g["completionPercent"]);
            let progress =
                number(&g["unlocked"]) > 0. && completion < 100. && !js_truthy(&g["hasPlatinum"]);
            match filter {
                "COMPLETED" => completion >= 100.,
                "IN_PROGRESS" => progress,
                "NEAR_PLATINUM" => progress && completion >= 80.,
                "PLATINUM" => js_truthy(&g["hasPlatinum"]),
                _ => true,
            }
        });
        let collator = node_collator();
        games.sort_by(|a, b| compare_games(a, b, sort, &collator));
        Ok(Value::Array(games))
    })
    .await
}

async fn highlights(s: &GraphqlServices, id: &str, reviews: &Value) -> Result<Value> {
    let key = format!("highlights:reviews:{}", node_json(reviews));
    cached(s,id,&key,300,async {
        let games=games(s,id,"ALL","COMPLETION").await?;
        let games=array(&games);
        let platinums=games.iter().map(|g|g["platinumCount"].as_f64().unwrap_or_else(||f64::from(i32::from(js_truthy(&g["hasPlatinum"]))))).sum::<f64>();
        let xp=games.iter().map(|g|number(&g["earnedXP"])).sum::<f64>()+platinums*250.;
        Ok(json!({"level":numeric((xp/250.).floor()),"totalXP":numeric(xp),"totalGames":games.len(),"totalAchievements":numeric(games.iter().map(|g|number(&g["unlocked"])).sum()),"totalPlatinums":numeric(platinums),"reviewsCount":reviews}))
    }).await
}

fn slice(items: &[Value], skip: u64, limit: usize) -> Value {
    Value::Array(
        items
            .iter()
            .skip(skip as usize)
            .take(limit)
            .cloned()
            .collect(),
    )
}

pub(super) async fn resolve(
    parent_type: &str,
    field: &str,
    parent: &Value,
    args: &Value,
    s: &GraphqlServices,
) -> Result<Option<Value>> {
    if parent_type == "Query" {
        return Ok(Some(identity(s, arg_string(args, "id")?).await?));
    }
    let id = parent["accountId"].as_str().unwrap_or_default();
    let filter = args["filter"].as_str().unwrap_or("ALL");
    let sort = args["sort"].as_str().unwrap_or("COMPLETION");
    let (limit, page, skip) = pagination(
        args,
        match field {
            "featuredGames" => 6,
            "featuredAchievements" => 8,
            "achievements" => 25,
            _ => 12,
        },
        100,
    );
    let result = match field {
        "highlights" => highlights(s, id, &parent["reviewsCount"]).await?,
        "heroGame" => {
            let games = games(s, id, "ALL", "COMPLETION").await?;
            let collator = node_collator();
            array(&games)
                .iter()
                .min_by(|a, b| {
                    js_truthy(&b["imageUrl"])
                        .cmp(&js_truthy(&a["imageUrl"]))
                        .then_with(|| compare_games(a, b, "COMPLETION", &collator))
                })
                .cloned()
                .unwrap_or(Value::Null)
        }
        "games" | "featuredGames" => {
            let games = games(s, id, filter, sort).await?;
            let games = array(&games);
            if field == "featuredGames" {
                slice(games, 0, limit)
            } else {
                json!({"elements":slice(games,skip,limit),"total":games.len(),"page":page,"limit":limit})
            }
        }
        "featuredAchievements" | "recentActivity" => {
            let (field_name, key, ttl) = if field == "recentActivity" {
                ("activity", format!("activity:{limit}:{page}"), 60)
            } else {
                (
                    "achievements",
                    format!("featured-achievements:{limit}"),
                    3600,
                )
            };
            cached(s, id, &key, ttl, async {
                let data = aggregation::load(s, id).await?;
                Ok(slice(
                    array(&data[field_name]),
                    if field == "recentActivity" { skip } else { 0 },
                    limit,
                ))
            })
            .await?
        }
        "achievements" => {
            let data = aggregation::load(s, id).await?;
            let items = array(&data["achievements"]);
            json!({"elements":slice(items,skip,limit),"total":items.len(),"page":page,"limit":limit})
        }
        _ => return Ok(None),
    };
    Ok(Some(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use egdata_core::{
        error::CoreError,
        ports::{
            EpicStorePort, MongoDocumentStream, MongoFindOptions, MongoStorePort, ResponseCachePort,
        },
    };
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering as AtomicOrdering};

    #[derive(Default)]
    struct MockBackend {
        cache: Mutex<HashMap<String, String>>,
        fail_cache_get: AtomicBool,
        fail_cache_set: AtomicBool,
        fail_epic: AtomicBool,
        fail_mongo: AtomicBool,
        fail_reviews: AtomicBool,
        epic_user: Mutex<Option<Value>>,
        epic_row: Mutex<Option<Value>>,
        reviews_count: Mutex<u64>,
        player_rows: Mutex<Vec<bson::Document>>,
        offers: Mutex<Vec<bson::Document>>,
        achievement_sets: Mutex<Vec<bson::Document>>,
        player_reads: AtomicUsize,
    }

    #[async_trait]
    impl ResponseCachePort for MockBackend {
        async fn get(&self, key: &str) -> std::result::Result<Option<String>, CoreError> {
            if self.fail_cache_get.load(AtomicOrdering::SeqCst) {
                return Err(CoreError::Internal("cache get failed".into()));
            }
            Ok(self.cache.lock().unwrap().get(key).cloned())
        }
        async fn set(
            &self,
            key: &str,
            value: &str,
            _ttl: u64,
        ) -> std::result::Result<(), CoreError> {
            if self.fail_cache_set.load(AtomicOrdering::SeqCst) {
                return Err(CoreError::Internal("cache set failed".into()));
            }
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
    impl EpicStorePort for MockBackend {
        async fn graphql(&self, _: &str, _: &Value) -> std::result::Result<Value, CoreError> {
            Ok(Value::Null)
        }
        async fn featured_games(&self) -> std::result::Result<Vec<Value>, CoreError> {
            Ok(vec![])
        }
        async fn get_user(&self, _id: &str) -> std::result::Result<Option<Value>, CoreError> {
            if self.fail_epic.load(AtomicOrdering::SeqCst) {
                return Err(CoreError::Internal("epic failed".into()));
            }
            Ok(self.epic_user.lock().unwrap().clone())
        }
    }

    #[async_trait]
    impl MongoStorePort for MockBackend {
        async fn find_one(
            &self,
            collection: &str,
            _filter: bson::Document,
            _projection: Option<bson::Document>,
        ) -> std::result::Result<Option<bson::Document>, CoreError> {
            if self.fail_mongo.load(AtomicOrdering::SeqCst) {
                return Err(CoreError::Internal("mongo failed".into()));
            }
            Ok(match collection {
                "epic" => self
                    .epic_row
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|v| bson::to_document(v).unwrap()),
                _ => None,
            })
        }
        async fn find_many(
            &self,
            collection: &str,
            _filter: bson::Document,
            _options: MongoFindOptions,
        ) -> std::result::Result<Vec<bson::Document>, CoreError> {
            if self.fail_mongo.load(AtomicOrdering::SeqCst) {
                return Err(CoreError::Internal("mongo failed".into()));
            }
            Ok(match collection {
                "player-achievements" => {
                    self.player_reads.fetch_add(1, AtomicOrdering::SeqCst);
                    self.player_rows.lock().unwrap().clone()
                }
                "offers" => self.offers.lock().unwrap().clone(),
                "achievementsets" => self.achievement_sets.lock().unwrap().clone(),
                _ => vec![],
            })
        }
        async fn find_stream(
            &self,
            _: &str,
            _: bson::Document,
            _: MongoFindOptions,
        ) -> std::result::Result<MongoDocumentStream, CoreError> {
            Ok(Box::pin(futures::stream::empty()))
        }
        async fn aggregate(
            &self,
            _: &str,
            _: Vec<bson::Document>,
        ) -> std::result::Result<Vec<bson::Document>, CoreError> {
            Ok(vec![])
        }
        async fn count_documents(
            &self,
            _: &str,
            _: bson::Document,
        ) -> std::result::Result<u64, CoreError> {
            if self.fail_reviews.load(AtomicOrdering::SeqCst) {
                return Err(CoreError::Internal("reviews unavailable".into()));
            }
            Ok(*self.reviews_count.lock().unwrap())
        }
        async fn distinct(
            &self,
            _: &str,
            _: &str,
            _: bson::Document,
        ) -> std::result::Result<Vec<bson::Bson>, CoreError> {
            Ok(vec![])
        }
        async fn insert_one(
            &self,
            _: &str,
            _: bson::Document,
        ) -> std::result::Result<(), CoreError> {
            Ok(())
        }
        async fn update_one(
            &self,
            _: &str,
            _: bson::Document,
            _: bson::Document,
            _: bool,
        ) -> std::result::Result<u64, CoreError> {
            Ok(0)
        }
        async fn delete_one(
            &self,
            _: &str,
            _: bson::Document,
        ) -> std::result::Result<u64, CoreError> {
            Ok(0)
        }
        async fn ping(&self) -> std::result::Result<bool, CoreError> {
            Ok(true)
        }
    }

    fn services(backend: &Arc<MockBackend>) -> GraphqlServices {
        GraphqlServices::new(backend.clone(), backend.clone(), backend.clone())
    }

    #[tokio::test]
    async fn profile_children_share_aggregation_failures_and_preserve_identity_errors() {
        let backend = Arc::new(MockBackend::default());
        let service = services(&backend);
        let parent = json!({"accountId":"fixture","reviewsCount":0});
        backend.fail_mongo.store(true, AtomicOrdering::SeqCst);
        for field in [
            "games",
            "highlights",
            "heroGame",
            "featuredAchievements",
            "achievements",
            "recentActivity",
        ] {
            let error = resolve("Profile", field, &parent, &json!({}), &service)
                .await
                .unwrap_err();
            assert!(error.message.contains("mongo failed"));
        }
        backend.fail_mongo.store(false, AtomicOrdering::SeqCst);
        backend.fail_reviews.store(true, AtomicOrdering::SeqCst);
        *backend.epic_user.lock().unwrap() = Some(json!({"displayName":"fixture"}));
        let error = resolve(
            "Query",
            "profile",
            &Value::Null,
            &json!({"id":"fixture"}),
            &service,
        )
        .await
        .unwrap_err();
        assert!(error.message.contains("reviews unavailable"));
        let missing = resolve("Query", "profile", &Value::Null, &json!({}), &service)
            .await
            .unwrap_err();
        assert_eq!(missing.message, "Missing string argument id");
    }

    #[tokio::test]
    async fn hero_sort_breaks_matching_art_and_completion_ties_with_unlock_count() {
        let backend = Arc::new(MockBackend::default());
        let games = json!([
            {"sandboxId":"a","title":"First","imageUrl":"first","earnedXP":15,"unlocked":1,"completionPercent":0},
            {"sandboxId":"b","title":"Second","imageUrl":"second","earnedXP":15,"unlocked":2,"completionPercent":0}
        ]);
        backend.cache.lock().unwrap().insert(
            "graphql:profile:fixture:games:ALL:COMPLETION:v2".into(),
            games.to_string(),
        );
        let hero = resolve(
            "Profile",
            "heroGame",
            &json!({"accountId":"fixture"}),
            &json!({}),
            &services(&backend),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(hero, games[1]);
    }

    #[tokio::test]
    async fn profile_identity_caches_hits_misses_and_failures() {
        let backend = Arc::new(MockBackend::default());

        // Missing epic user caches null.
        let s = services(&backend);
        assert_eq!(
            resolve("Query", "profile", &Value::Null, &json!({"id": "p1"}), &s)
                .await
                .unwrap(),
            Some(Value::Null)
        );
        assert_eq!(
            backend
                .cache
                .lock()
                .unwrap()
                .get("graphql:profile:p1:identity:v2")
                .map(String::as_str),
            Some("null")
        );

        // Cache hit returns stored value directly.
        assert_eq!(
            resolve(
                "Query",
                "profile",
                &Value::Null,
                &json!({"id": "p1"}),
                &services(&backend)
            )
            .await
            .unwrap(),
            Some(Value::Null)
        );

        // Populated epic user with DB row vs without DB row.
        backend.cache.lock().unwrap().clear();
        *backend.epic_user.lock().unwrap() = Some(json!({
            "displayName": "Player Two",
            "avatar": { "small": "s", "medium": "m", "large": "l" }
        }));
        *backend.epic_row.lock().unwrap() = Some(json!({
            "avatarUrl": { "variants": ["db-v"] },
            "linkedAccounts": { "steam": true },
            "creationDate": "2024-01-01T00:00:00.000Z"
        }));
        *backend.reviews_count.lock().unwrap() = 3;
        let populated = resolve(
            "Query",
            "profile",
            &Value::Null,
            &json!({"id": "p2"}),
            &services(&backend),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(populated["avatar"]["small"], "db-v");
        assert_eq!(populated["reviewsCount"], 3);

        // Error paths: cache get fail, cache set fail, epic fail, invalid cached JSON.
        backend.fail_cache_get.store(true, AtomicOrdering::SeqCst);
        assert!(
            resolve(
                "Query",
                "profile",
                &Value::Null,
                &json!({"id": "p3"}),
                &services(&backend)
            )
            .await
            .is_err()
        );
        backend.fail_cache_get.store(false, AtomicOrdering::SeqCst);

        backend.fail_cache_set.store(true, AtomicOrdering::SeqCst);
        assert!(
            resolve(
                "Query",
                "profile",
                &Value::Null,
                &json!({"id": "p3"}),
                &services(&backend)
            )
            .await
            .is_err()
        );
        backend.fail_cache_set.store(false, AtomicOrdering::SeqCst);

        backend.fail_epic.store(true, AtomicOrdering::SeqCst);
        assert!(
            resolve(
                "Query",
                "profile",
                &Value::Null,
                &json!({"id": "p3"}),
                &services(&backend)
            )
            .await
            .is_err()
        );
        backend.fail_epic.store(false, AtomicOrdering::SeqCst);

        backend
            .cache
            .lock()
            .unwrap()
            .insert("graphql:profile:p3:identity:v2".into(), "{bad json".into());
        assert!(
            resolve(
                "Query",
                "profile",
                &Value::Null,
                &json!({"id": "p3"}),
                &services(&backend)
            )
            .await
            .is_err()
        );
    }

    #[tokio::test]
    async fn profile_aggregation_filters_sorts_and_edge_cases() {
        let backend = Arc::new(MockBackend::default());
        let parent = json!({ "accountId": "p-empty", "reviewsCount": 1 });

        // Empty player-achievements returns empty collections and null heroGame.
        let s_empty = services(&backend);
        assert_eq!(
            resolve("Profile", "heroGame", &parent, &json!({}), &s_empty)
                .await
                .unwrap(),
            Some(Value::Null)
        );
        assert_eq!(
            resolve("Profile", "highlights", &parent, &json!({}), &s_empty)
                .await
                .unwrap(),
            Some(json!({
                "level": 0, "totalXP": 0, "totalGames": 0,
                "totalAchievements": 0, "totalPlatinums": 0, "reviewsCount": 1
            }))
        );
        assert_eq!(
            resolve("Profile", "unknownField", &parent, &json!({}), &s_empty)
                .await
                .unwrap(),
            None
        );

        // Rich dataset exercising normalization merges, tie-breakers, image fallback, rarity & percent rounding.
        *backend.player_rows.lock().unwrap() = vec![
            // Empty sandboxId skipped
            bson::to_document(&json!({ "sandboxId": "" })).unwrap(),
            // Sandbox A: 2 duplicate rows merged, platinum award, 2 achievements
            bson::to_document(&json!({
                "sandboxId": "sb-a",
                "totalUnlocked": 1,
                "totalXP": 50,
                "playerAwards": [{ "awardType": "PLATINUM", "achievementSetId": "set-a", "unlockedDateTime": "2024-02-01T00:00:00Z" }],
                "playerAchievements": [
                    { "playerAchievement": { "sandboxId": "sb-a", "achievementSetId": "set-a", "achievementName": "a1", "unlocked": false, "unlockDate": "2024-01-01T00:00:00Z", "XP": 10 } },
                    { "playerAchievement": { "sandboxId": "sb-a", "achievementSetId": "set-a", "achievementName": "missing", "unlocked": true } }
                ]
            })).unwrap(),
            bson::to_document(&json!({
                "sandboxId": "sb-a",
                "totalUnlocked": 2,
                "totalXP": 150,
                "playerAwards": [{ "awardType": "PLATINUM", "achievementSetId": "set-a", "unlockedDateTime": "2024-02-01T00:00:00Z" }],
                "playerAchievements": [
                    { "playerAchievement": { "sandboxId": "sb-a", "achievementSetId": "set-a", "achievementName": "a1", "unlocked": true, "unlockDate": "2024-01-02T00:00:00Z", "XP": 50 } },
                    { "playerAchievement": { "sandboxId": "sb-a", "achievementSetId": "set-a", "achievementName": "a2", "unlocked": true, "unlockDate": "2024-01-03T00:00:00Z", "XP": 100 } },
                    { "playerAchievement": { "sandboxId": "sb-a", "achievementSetId": "set-a", "achievementName": "a3", "unlocked": true, "unlockDate": "2024-01-01T00:00:00Z", "XP": 100 } }
                ]
            })).unwrap(),
            // Merge where old unlockDate >= next unlockDate
            bson::to_document(&json!({
                "sandboxId": "sb-a",
                "totalUnlocked": 2,
                "totalXP": 150,
                "playerAchievements": [
                    { "playerAchievement": { "sandboxId": "sb-a", "achievementSetId": "set-a", "achievementName": "a1", "unlocked": true, "unlockDate": "2024-01-01T00:00:00Z", "XP": 20 } }
                ]
            })).unwrap(),
            // Sandbox B: NEAR_PLATINUM (85%), no imageUrl, product.name fallback title
            bson::to_document(&json!({
                "sandboxId": "sb-b",
                "totalUnlocked": 17,
                "totalXP": 300,
                "playerAchievements": [
                    { "playerAchievement": { "sandboxId": "sb-b", "achievementName": "b1", "unlocked": true, "unlockDate": 1700000000000_i64 } }
                ]
            })).unwrap(),
            // Sandbox C: IN_PROGRESS (50%), fallback sandboxId title, 0 total achievements in set -> sb-d
            bson::to_document(&json!({
                "sandboxId": "sb-c",
                "totalUnlocked": 1,
                "totalXP": 10,
                "playerAchievements": []
            })).unwrap(),
            // Sandbox D: 0 total achievements -> completionPercent 0, non-displayable offer chosen over nothing
            bson::to_document(&json!({
                "sandboxId": "sb-d",
                "totalUnlocked": 0,
                "totalXP": 0,
                "playerAchievements": []
            })).unwrap(),
        ];

        *backend.offers.lock().unwrap() = vec![
            bson::to_document(&json!({ "namespace": "", "title": "Skip" })).unwrap(),
            bson::to_document(&json!({
                "namespace": "sb-a", "title": "Alpha", "isDisplayable": false, "lastModifiedDate": "2024-01-01T00:00:00Z",
                "keyImages": []
            })).unwrap(),
            bson::to_document(&json!({
                "namespace": "sb-a", "title": "Alpha Display", "isDisplayable": true, "lastModifiedDate": "2024-01-02T00:00:00Z",
                "keyImages": [{ "type": "FallbackType", "url": "https://img/a.png" }]
            })).unwrap(),
            bson::to_document(&json!({
                "namespace": "sb-b", "product": { "name": "Beta Product" }, "isDisplayable": true,
                "keyImages": []
            })).unwrap(),
        ];

        *backend.achievement_sets.lock().unwrap() = vec![
            bson::to_document(&json!({
                "sandboxId": "sb-a", "achievementSetId": "other-set",
                "achievements": [{ "name": "a1", "score": 999 }]
            })).unwrap(),
            bson::to_document(&json!({
                "sandboxId": "sb-a", "achievementSetId": "set-a",
                "achievements": [
                    { "name": "a1", "unlockedDisplayName": " ", "displayName": "A1", "completedPercent": 0.5, "xp": 50 },
                    { "name": "a2", "title": "A2", "description": "desc2", "iconUrl": "https://icon/2", "completedPercent": 15.0, "XP": 100 },
                    { "name": "a3", "completedPercent": 15.0, "score": 100 }
                ]
            })).unwrap(),
            bson::to_document(&json!({
                "sandboxId": "sb-b",
                "achievements": (0..20).map(|i| json!({ "name": format!("b{i}"), "completedPercent": "not-a-num", "xp": 15 })).collect::<Vec<_>>()
            })).unwrap(),
            bson::to_document(&json!({
                "sandboxId": "sb-c",
                "achievements": [{ "name": "c1", "xp": 10 }, { "name": "c2", "xp": 10 }]
            })).unwrap(),
        ];

        let p2 = json!({ "accountId": "p-rich", "reviewsCount": 2 });
        let s = services(&backend);

        // Concurrent sibling queries share aggregation in-flight!
        let empty_args = json!({});
        let lim2 = json!({ "limit": 2 });
        let paged2 = json!({ "limit": 2, "page": 1 });
        let (h, hero, fg, fa, ra, ach) = tokio::try_join!(
            resolve("Profile", "highlights", &p2, &empty_args, &s),
            resolve("Profile", "heroGame", &p2, &empty_args, &s),
            resolve("Profile", "featuredGames", &p2, &lim2, &s),
            resolve("Profile", "featuredAchievements", &p2, &lim2, &s),
            resolve("Profile", "recentActivity", &p2, &paged2, &s),
            resolve("Profile", "achievements", &p2, &paged2, &s),
        )
        .unwrap();

        assert_eq!(backend.player_reads.load(AtomicOrdering::SeqCst), 2);
        assert_eq!(h.unwrap()["totalPlatinums"], 1);
        assert_eq!(hero.unwrap()["sandboxId"], "sb-a");
        assert_eq!(fg.unwrap().as_array().unwrap().len(), 2);
        assert_eq!(fa.unwrap().as_array().unwrap().len(), 2);
        assert_eq!(ra.unwrap().as_array().unwrap().len(), 2);
        assert_eq!(ach.unwrap()["total"], 4);

        // Exercise all filters and sorts.
        for filter in [
            "ALL",
            "COMPLETED",
            "IN_PROGRESS",
            "NEAR_PLATINUM",
            "PLATINUM",
        ] {
            for sort in ["COMPLETION", "ALPHABETICAL", "XP", "ACHIEVEMENTS"] {
                let res = resolve(
                    "Profile",
                    "games",
                    &p2,
                    &json!({ "filter": filter, "sort": sort, "limit": 10, "page": 1 }),
                    &s,
                )
                .await
                .unwrap()
                .unwrap();
                assert!(res["elements"].is_array());
            }
        }

        // Legacy highlights fallback when cached games omit platinumCount, and numeric/number helpers.
        backend.cache.lock().unwrap().insert(
            "graphql:profile:p-legacy:games:ALL:COMPLETION:v2".into(),
            json!([
                { "earnedXP": "10.5", "unlocked": true, "hasPlatinum": true },
                { "earnedXP": [5], "unlocked": [], "hasPlatinum": false },
                { "earnedXP": 0, "unlocked": null, "hasPlatinum": false }
            ])
            .to_string(),
        );
        let legacy_h = resolve(
            "Profile",
            "highlights",
            &json!({ "accountId": "p-legacy", "reviewsCount": 0 }),
            &json!({}),
            &services(&backend),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(legacy_h["totalPlatinums"], 1);
        assert!(legacy_h["totalXP"].is_number());
        assert!(number(&json!({})).is_nan());
        assert!(number(&json!([1, 2])).is_nan());
        assert!(numeric((i64::MAX as f64) * 2.0).is_number());

        // Cover compare_games sandboxId tie-breaker, aggregation string/percent(1.125),
        // and Mongo error paths in identity & aggregation try_join!.
        let collator = node_collator();
        assert_eq!(
            compare_games(
                &json!({"title": "Same", "sandboxId": "a", "completionPercent": 50, "earnedXP": 10, "unlocked": 1}),
                &json!({"title": "Same", "sandboxId": "b", "completionPercent": 50, "earnedXP": 10, "unlocked": 1}),
                "ALPHABETICAL",
                &collator,
            ),
            Ordering::Less
        );

        let tie_backend = Arc::new(MockBackend::default());
        *tie_backend.player_rows.lock().unwrap() = vec![
            bson::to_document(&json!({
                "sandboxId": "sb-tie",
                "totalUnlocked": 1,
                "totalXP": 10,
                "playerAwards": [{ "awardType": 1, "achievementSetId": "s", "unlockedDateTime": "2024-01-01T00:00:00Z" }],
                "playerAchievements": [
                    { "playerAchievement": { "sandboxId": "sb-tie", "achievementName": "t1", "unlocked": true } }
                ]
            })).unwrap(),
        ];
        *tie_backend.achievement_sets.lock().unwrap() = vec![
            bson::to_document(&json!({
                "sandboxId": "sb-tie",
                "achievements": [{ "name": "t1", "completedPercent": 1.125 }]
            }))
            .unwrap(),
        ];
        let tie_games = resolve(
            "Profile",
            "games",
            &json!({"accountId": "p-tie"}),
            &json!({}),
            &services(&tie_backend),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(
            tie_games["elements"][0]["rarestAchievements"][0]["rarityPercent"],
            1.13
        );

        // Mongo errors in identity try_join! and aggregation try_join!.
        *tie_backend.epic_user.lock().unwrap() = Some(json!({"displayName": "X", "avatar": {}}));
        tie_backend.fail_mongo.store(true, AtomicOrdering::SeqCst);
        assert!(
            resolve(
                "Query",
                "profile",
                &Value::Null,
                &json!({"id": "p-err"}),
                &services(&tie_backend)
            )
            .await
            .is_err()
        );
        struct FailOffersMongo(Arc<MockBackend>);
        #[async_trait]
        impl MongoStorePort for FailOffersMongo {
            async fn find_one(
                &self,
                _: &str,
                _: bson::Document,
                _: Option<bson::Document>,
            ) -> std::result::Result<Option<bson::Document>, CoreError> {
                Ok(None)
            }
            async fn find_many(
                &self,
                collection: &str,
                _: bson::Document,
                _: MongoFindOptions,
            ) -> std::result::Result<Vec<bson::Document>, CoreError> {
                if collection == "offers" {
                    return Err(CoreError::Internal("offers failed".into()));
                }
                Ok(self.0.player_rows.lock().unwrap().clone())
            }
            async fn find_stream(
                &self,
                _: &str,
                _: bson::Document,
                _: MongoFindOptions,
            ) -> std::result::Result<MongoDocumentStream, CoreError> {
                Ok(Box::pin(futures::stream::empty()))
            }
            async fn aggregate(
                &self,
                _: &str,
                _: Vec<bson::Document>,
            ) -> std::result::Result<Vec<bson::Document>, CoreError> {
                Ok(vec![])
            }
            async fn count_documents(
                &self,
                _: &str,
                _: bson::Document,
            ) -> std::result::Result<u64, CoreError> {
                Ok(0)
            }
            async fn distinct(
                &self,
                _: &str,
                _: &str,
                _: bson::Document,
            ) -> std::result::Result<Vec<bson::Bson>, CoreError> {
                Ok(vec![])
            }
            async fn insert_one(
                &self,
                _: &str,
                _: bson::Document,
            ) -> std::result::Result<(), CoreError> {
                Ok(())
            }
            async fn update_one(
                &self,
                _: &str,
                _: bson::Document,
                _: bson::Document,
                _: bool,
            ) -> std::result::Result<u64, CoreError> {
                Ok(0)
            }
            async fn delete_one(
                &self,
                _: &str,
                _: bson::Document,
            ) -> std::result::Result<u64, CoreError> {
                Ok(0)
            }
            async fn ping(&self) -> std::result::Result<bool, CoreError> {
                Ok(true)
            }
        }
        let fail_offers_s = GraphqlServices::new(
            Arc::new(FailOffersMongo(tie_backend.clone())),
            tie_backend.clone(),
            tie_backend.clone(),
        );
        assert!(
            resolve(
                "Profile",
                "achievements",
                &json!({"accountId": "p-err2"}),
                &json!({}),
                &fail_offers_s
            )
            .await
            .is_err()
        );

        // Exercise remaining trait stubs on MockBackend & FailOffersMongo.
        assert!(tie_backend.del("k").await.is_ok());
        assert!(ResponseCachePort::ping(tie_backend.as_ref()).await.unwrap());
        assert!(tie_backend.graphql("q", &Value::Null).await.is_ok());
        assert!(tie_backend.featured_games().await.is_ok());
        assert!(
            tie_backend
                .find_stream("c", bson::Document::new(), Default::default())
                .await
                .is_ok()
        );
        assert!(tie_backend.aggregate("c", vec![]).await.is_ok());
        assert!(
            tie_backend
                .distinct("c", "f", bson::Document::new())
                .await
                .is_ok()
        );
        assert!(
            tie_backend
                .insert_one("c", bson::Document::new())
                .await
                .is_ok()
        );
        assert!(
            tie_backend
                .update_one("c", bson::Document::new(), bson::Document::new(), false)
                .await
                .is_ok()
        );
        assert!(
            tie_backend
                .delete_one("c", bson::Document::new())
                .await
                .is_ok()
        );
        assert!(MongoStorePort::ping(tie_backend.as_ref()).await.unwrap());
        let fo = FailOffersMongo(tie_backend.clone());
        assert!(
            fo.find_one("c", bson::Document::new(), None)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            fo.find_stream("c", bson::Document::new(), Default::default())
                .await
                .is_ok()
        );
        assert!(fo.aggregate("c", vec![]).await.is_ok());
        assert_eq!(
            fo.count_documents("c", bson::Document::new())
                .await
                .unwrap(),
            0
        );
        assert!(fo.distinct("c", "f", bson::Document::new()).await.is_ok());
        assert!(fo.insert_one("c", bson::Document::new()).await.is_ok());
        assert_eq!(
            fo.update_one("c", bson::Document::new(), bson::Document::new(), false)
                .await
                .unwrap(),
            0
        );
        assert_eq!(fo.delete_one("c", bson::Document::new()).await.unwrap(), 0);
        assert!(MongoStorePort::ping(&fo).await.unwrap());
    }
}
