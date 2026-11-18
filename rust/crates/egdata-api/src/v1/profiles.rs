//! Profile, achievement, leaderboard, and player-game endpoints.
//!
//! These handlers intentionally use the shared Mongo, Epic, and response-cache
//! ports. Profile data is public; no session token is consulted by the Node
//! handlers for these operations.

use std::collections::{BTreeMap, HashMap, HashSet};

use axum::{
    Extension,
    extract::{Path, State},
    http::{HeaderMap, Method, Uri},
    response::Response,
};
use bson::{Bson, Document, doc};
use egdata_core::{
    ports::{MongoAggregateOptions, MongoFindOptions},
    v1::{
        CursorBinding, CursorSortValue, MongoSortField, NullsOrder, ProblemError, SortDirection,
        decode_cursor_with, encode_cursor_with_filter_order, iso_or_null, mongo_keyset_filter,
        mongo_sort_spec, parse_boolean, parse_pagination_map, require_id_param, trim_page,
    },
};
use rand::Rng;
use serde_json::{Value, json};

use super::{
    RouteGroup,
    helpers::{
        V1ErrorResponse, V1RequestContext, json_success, parse_strict_query_uri,
        parse_validated_query, search_query_issues, v1_cache_get, v1_cache_key, v1_cache_set,
    },
};
use crate::state::AppState;

const BASE: &str = "US";
const LOCALE: &str = "en-US";
const PROFILE_TTL: u64 = 60;
const ACHIEVEMENTS_TTL: u64 = 3600;
const SANDBOX_TTL: u64 = 60;
const RARE_TTL: u64 = 86400;
const RARE_SANDBOX_TTL: u64 = 3600;
const INFO_TTL: u64 = 300;
const GAMES_TTL: u64 = 60;

pub fn route_group(prefix: &str) -> RouteGroup {
    RouteGroup::new(prefix)
        .get("/profiles/leaderboard", leaderboard)
        .get("/profiles/{id}/achievements", achievements)
        .get(
            "/profiles/{id}/achievements/{sandboxId}",
            sandbox_achievements,
        )
        .get("/profiles/{id}/rare-achievements", rare_achievements)
        .get(
            "/profiles/{id}/rare-achievements/{sandboxId}",
            rare_sandbox_achievements,
        )
        .get("/profiles/{id}/information", information)
        .get("/profiles/{id}/games", games)
        .get("/profiles/{id}/random-game", random_game)
        .get("/profiles/{id}", profile_detail)
}

fn request_id(ctx: Option<Extension<V1RequestContext>>, headers: &HeaderMap) -> String {
    ctx.map(|Extension(c)| c.request_id.clone())
        .or_else(|| {
            headers
                .get("x-request-id")
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
        })
        .unwrap_or_default()
}
fn not_found(code: &str, detail: String) -> ProblemError {
    ProblemError::new(404, code, detail)
}
fn cache_key(op: &str, values: &[(&str, Value)]) -> String {
    let parts = values
        .iter()
        .map(|(k, v)| (*k, v.clone()))
        .collect::<BTreeMap<_, _>>();
    v1_cache_key(op, &parts)
}
fn cursor_binding(operation: &str, filters: Value, ordering: &str, limit: u32) -> CursorBinding {
    CursorBinding {
        operation: operation.into(),
        filters: filters
            .as_object()
            .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
        ordering: ordering.into(),
        country: BASE.into(),
        locale: LOCALE.into(),
        limit,
    }
}
fn cursor_values(
    state: &AppState,
    binding: &CursorBinding,
    token: &str,
) -> Result<Vec<Value>, ProblemError> {
    decode_cursor_with(
        token,
        binding,
        state.config.v1_cursor_secret.as_deref(),
        (state.now)().timestamp_millis(),
    )
    .map(|items| {
        items
            .into_iter()
            .map(|x| match x {
                CursorSortValue::Null => Value::Null,
                CursorSortValue::Number(n) => Value::Number(n),
                CursorSortValue::String(s) => Value::String(s),
            })
            .collect()
    })
}
fn cursor_token(
    state: &AppState,
    binding: &CursorBinding,
    values: Vec<Value>,
) -> Result<String, ProblemError> {
    let values = values
        .into_iter()
        .map(|v| match v {
            Value::Number(n) => CursorSortValue::Number(n),
            Value::String(s) => CursorSortValue::String(s),
            _ => CursorSortValue::Null,
        })
        .collect::<Vec<_>>();
    let filter_order: &[&str] = match binding.operation.as_str() {
        "profiles.games" => &["profileId", "sort", "platinum"],
        "profiles.achievements" => &["profileId"],
        _ => &[],
    };
    encode_cursor_with_filter_order(
        binding,
        &values,
        state.config.v1_cursor_secret.as_deref(),
        (state.now)().timestamp_millis(),
        filter_order,
    )
}
fn doc_json(d: Document) -> Value {
    egdata_core::v1::bson_to_serialized_json(&Bson::Document(d))
}
fn docs_json(docs: Vec<Document>) -> Vec<Value> {
    docs.into_iter().map(doc_json).collect()
}
fn pipeline(values: Vec<Value>) -> Vec<Document> {
    values
        .into_iter()
        .filter_map(|v| bson::to_document(&v).ok())
        .collect()
}
fn fail(error: ProblemError, uri: &Uri, id: String) -> V1ErrorResponse {
    V1ErrorResponse {
        error,
        path: uri.path().into(),
        request_id: (!id.is_empty()).then_some(id),
    }
}
fn parse_page(uri: &Uri, maximum: u32) -> Result<(u32, Option<String>), ProblemError> {
    let q = parse_strict_query_uri(uri, &["limit", "cursor"])?;
    let p = parse_pagination_map(&q, maximum)?;
    Ok((p.limit, p.cursor))
}
fn id_or_error(raw: String, key: &str) -> Result<String, ProblemError> {
    require_id_param(Some(&raw), key)
}
fn result(method: Method, uri: Uri, id: String, data: Value, meta: Option<Value>) -> Response {
    json_success(&method, uri.path(), &id, data, meta)
}
pub(crate) fn leaderboard_stages() -> Vec<Value> {
    vec![
        json!({"$project":{"epicAccountId":1,"sandboxId":1,"totalXP":1,"totalUnlocked":1,"playerAwards":1}}),
        json!({"$group":{"_id":{"player":"$epicAccountId","sandbox":"$sandboxId"},"xpForSandbox":{"$max":"$totalXP"},"unlockedForSandbox":{"$max":"$totalUnlocked"},"awardsForSandbox_arr":{"$push":"$playerAwards"}}}),
        json!({"$addFields":{"awardsForSandbox":{"$reduce":{"input":"$awardsForSandbox_arr","initialValue":[],"in":{"$setUnion":["$$value","$$this"]}}}}}),
        json!({"$project":{"awardsForSandbox_arr":0}}),
        json!({"$group":{"_id":"$_id.player","xpEarned":{"$sum":"$xpForSandbox"},"achievementsWon":{"$sum":"$unlockedForSandbox"},"awards_arr":{"$push":"$awardsForSandbox"}}}),
        json!({"$addFields":{"awards":{"$reduce":{"input":"$awards_arr","initialValue":[],"in":{"$setUnion":["$$value","$$this"]}}},"awardsEarned":{"$size":{"$reduce":{"input":"$awards_arr","initialValue":[],"in":{"$setUnion":["$$value","$$this"]}}}}}}),
        json!({"$project":{"awards_arr":0}}),
        json!({"$addFields":{"awardsByType":{"$arrayToObject":{"$map":{"input":{"$setUnion":{"$map":{"input":"$awards","as":"a","in":"$$a.awardType"}}},"as":"type","in":{"k":"$$type","v":{"$size":{"$filter":{"input":"$awards","as":"a","cond":{"$eq":["$$a.awardType","$$type"]}}}}}}}}}}),
        json!({"$lookup":{"from":"epic","localField":"_id","foreignField":"accountId","as":"player"}}),
        json!({"$unwind":{"path":"$player","preserveNullAndEmptyArrays":true}}),
        json!({"$setWindowFields":{"sortBy":{"xpEarned":-1},"output":{"rank":{"$rank":{}}}}}),
        json!({"$project":{"_id":0,"rank":1,"accountId":"$_id","displayName":"$player.displayName","xpEarned":1,"achievementsWon":1,"awardsEarned":1,"awardsByType":1}}),
    ]
}

async fn leaderboard(
    State(s): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let id = request_id(ctx, &headers);
    let (limit, cursor) = parse_page(&uri, 100).map_err(|e| fail(e, &uri, id.clone()))?;
    let binding = cursor_binding("profiles.leaderboard", json!({}), "rank:asc,id:asc", limit);
    let key = cache_key(
        "profiles.leaderboard",
        &[("limit", json!(limit)), ("cursor", json!(cursor))],
    );
    let payload = if let Some(v) = v1_cache_get(s.cache.as_ref(), &key).await {
        v
    } else {
        let last = cursor
            .as_deref()
            .map(|c| cursor_values(&s, &binding, c))
            .transpose()
            .map_err(|e| fail(e, &uri, id.clone()))?;
        let mut stages = leaderboard_stages();
        if let Some(last) = last {
            let tuple = last
                .into_iter()
                .map(|v| Bson::try_from(v).unwrap_or(Bson::Null))
                .collect::<Vec<_>>();
            let filter = mongo_keyset_filter(
                &[
                    MongoSortField::new("rank", SortDirection::Asc, NullsOrder::First),
                    MongoSortField::new("accountId", SortDirection::Asc, NullsOrder::First),
                ],
                &tuple,
            )
            .map_err(|e| fail(e, &uri, id.clone()))?;
            stages.push(json!({"$match":filter}));
        }
        stages.push(json!({"$sort":{"rank":1,"accountId":1}}));
        stages.push(json!({"$limit":limit+1}));
        let rows = s
            .mongo
            .aggregate_with_options("player-achievements", pipeline(stages), disk_aggregation())
            .await
            .map_err(|_| fail(super::system::internal_error(), &uri, id.clone()))?;
        let page = trim_page(
            rows.into_iter().map(doc_json).collect::<Vec<_>>(),
            limit as usize,
        );
        let entries = page.items;
        let last = entries.last();
        let next = if page.has_more {
            last.map(|r| {
                cursor_token(
                    &s,
                    &binding,
                    vec![
                        r.get("rank")
                            .filter(|r| r.is_number())
                            .cloned()
                            .unwrap_or(Value::Null),
                        r["accountId"].clone(),
                    ],
                )
            })
            .transpose()
            .map_err(|e| fail(e, &uri, id.clone()))?
        } else {
            None
        };
        let v = json!({"entries":entries,"pagination":{"limit":limit,"hasMore":page.has_more,"nextCursor":next}});
        v1_cache_set(s.cache.as_ref(), &key, &v, PROFILE_TTL).await;
        v
    };
    Ok(result(
        Method::GET,
        uri,
        id,
        payload["entries"].clone(),
        Some(json!({"pagination":payload["pagination"]})),
    ))
}

async fn cached_identity(
    s: &AppState,
    id: &str,
    ttl: u64,
) -> Result<Option<Value>, egdata_core::error::CoreError> {
    let key = cache_key(
        "profiles.identity",
        &[("id", json!(id)), ("ttl", json!(ttl))],
    );
    if let Some(profile) = v1_cache_get(s.cache.as_ref(), &key).await {
        return Ok(Some(profile));
    }
    let profile = s.epic.get_user(id).await?;
    v1_cache_set(
        s.cache.as_ref(),
        &key,
        profile.as_ref().unwrap_or(&Value::Null),
        ttl,
    )
    .await;
    Ok(profile)
}

fn disk_aggregation() -> MongoAggregateOptions {
    MongoAggregateOptions {
        allow_disk_use: Some(true),
        ..Default::default()
    }
}

fn profile_avatar(profile: &Value, db_profile: &Value) -> Value {
    let stored = db_profile["avatarUrl"]["variants"]
        .as_array()
        .and_then(|v| v.first())
        .filter(|v| !v.is_null());
    let size = |key: &str| stored.unwrap_or(&profile["avatar"][key]);
    json!({"small":size("small"),"medium":size("medium"),"large":size("large")})
}

fn nullable_string(value: &Value) -> String {
    if value.is_null() {
        String::new()
    } else {
        egdata_core::v1::serialization::js_string(value)
    }
}

fn distinct_ids<'a>(rows: impl IntoIterator<Item = &'a Value>, field: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    rows.into_iter()
        .map(|r| nullable_string(&r[field]))
        .filter(|id| !id.is_empty() && seen.insert(id.clone()))
        .collect()
}

pub(crate) fn number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.,
        Value::Bool(b) => f64::from(i32::from(*b)),
        Value::Number(n) => n.as_f64().unwrap(),
        v => {
            let text = egdata_core::v1::serialization::js_string(v);
            super::system::js_string_number(&text)
        }
    }
}

async fn build_achievements_summary(
    s: &AppState,
    account_id: &str,
) -> Result<Value, egdata_core::error::CoreError> {
    let rows = s
        .mongo
        .find_many(
            "player-achievements",
            doc! {"epicAccountId":account_id},
            MongoFindOptions::default(),
        )
        .await?;
    if rows.is_empty() {
        return Ok(json!({"__typename":"AchievementsSummaryResponse","status":200,"data":[]}));
    }
    let row_json = docs_json(rows);
    let string = nullable_string;
    let ids = distinct_ids(&row_json, "sandboxId");
    if ids.is_empty() {
        return Ok(json!({"__typename":"AchievementsSummaryResponse","status":200,"data":[]}));
    }
    let (sandboxes, offers, sets) = tokio::try_join!(
        s.mongo.find_many(
            "sandboxes",
            doc! {"_id":{"$in":&ids}},
            MongoFindOptions::default()
        ),
        s.mongo.find_many(
            "offers",
            doc! {"namespace":{"$in":&ids},"offerType":"BASE_GAME"},
            MongoFindOptions::default()
        ),
        s.mongo.find_many(
            "achievementsets",
            doc! {"sandboxId":{"$in":&ids}},
            MongoFindOptions::default()
        ),
    )?;
    let parents = sandboxes
        .iter()
        .filter_map(|s| s.get("parent"))
        .filter(|id| !matches!(id, Bson::Null | Bson::Undefined))
        .cloned()
        .collect::<Vec<_>>();
    let sandboxes = docs_json(sandboxes);
    let mut products = HashSet::new();
    if !parents.is_empty() {
        for p in docs_json(
            s.mongo
                .find_many(
                    "products",
                    doc! {"_id":{"$in":parents}},
                    MongoFindOptions::default(),
                )
                .await?,
        ) {
            products.insert(string(&p["_id"]));
        }
    }
    let sandboxes = sandboxes
        .iter()
        .map(|s| (string(&s["_id"]), s))
        .collect::<HashMap<_, _>>();
    let mut first_offer = HashMap::new();
    for offer in docs_json(offers) {
        first_offer
            .entry(string(&offer["namespace"]))
            .or_insert(offer);
    }
    let mut totals = HashMap::<String, (usize, f64)>::new();
    for set in docs_json(sets) {
        let (total, xp) = totals.entry(string(&set["sandboxId"])).or_default();
        if let Some(achievements) = set["achievements"].as_array() {
            *total += achievements.len();
            *xp += achievements
                .iter()
                .map(|ach| number(ach.get("xp").filter(|v| !v.is_null()).unwrap_or(&ach["XP"])))
                .sum::<f64>();
        }
    }
    let mut data = Vec::new();
    for row in row_json {
        let id = string(&row["sandboxId"]);
        let Some(sandbox) = sandboxes.get(&id) else {
            continue;
        };
        if !products.contains(&string(&sandbox["parent"])) {
            continue;
        }
        let Some(offer) = first_offer.get(&id) else {
            continue;
        };
        let (total, xp) = totals.get(&id).copied().unwrap_or_default();
        data.push(json!({"playerAwards":row.get("playerAwards").filter(|v|!v.is_null()).cloned().unwrap_or(json!([])),"totalXP":row["totalXP"],"totalUnlocked":row["totalUnlocked"],"sandboxId":row["sandboxId"],"baseOfferForSandbox":{"id":egdata_core::v1::serialization::string_id(&offer["id"]),"namespace":offer["namespace"],"keyImages":offer.get("keyImages").filter(|v|!v.is_null()).cloned().unwrap_or(json!([]))},"product":{"name":offer["title"],"slug":offer["productSlug"]},"productAchievements":{"totalAchievements":total,"totalProductXP":xp}}));
    }
    Ok(json!({"__typename":"AchievementsSummaryResponse","status":200,"data":data}))
}
async fn profile_detail(
    State(s): State<AppState>,
    Path(raw): Path<String>,
    headers: HeaderMap,
    uri: Uri,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let rid = request_id(ctx, &headers);
    let id = id_or_error(raw, "id").map_err(|e| fail(e, &uri, rid.clone()))?;
    let key = cache_key("profiles.detail", &[("id", json!(id))]);
    let data = if let Some(v) = v1_cache_get(s.cache.as_ref(), &key).await {
        v
    } else {
        let profile = s
            .epic
            .get_user(&id)
            .await
            .map_err(|_| fail(super::system::internal_error(), &uri, rid.clone()))?
            .ok_or_else(|| {
                fail(
                    not_found(
                        "PROFILE_NOT_FOUND",
                        format!("No Epic profile was found for '{id}'."),
                    ),
                    &uri,
                    rid.clone(),
                )
            })?;
        let dbp = s
            .mongo
            .find_one("epic", doc! {"accountId":{"$eq":&id}}, None)
            .await
            .map_err(|_| fail(super::system::internal_error(), &uri, rid.clone()))?;
        let reviews = s
            .mongo
            .count_documents("reviews", doc! {"userId":&id})
            .await
            .map_err(|_| fail(super::system::internal_error(), &uri, rid.clone()))?;
        let achievements = build_achievements_summary(&s, &id)
            .await
            .map_err(|_| fail(super::system::internal_error(), &uri, rid.clone()))?;
        let mut out = profile.as_object().cloned().unwrap_or_default();
        let p = dbp
            .as_ref()
            .map(|d| doc_json(d.clone()))
            .unwrap_or(Value::Null);
        // Node spreads the Epic profile, then adds achievements before the
        // database-backed identity fields. Preserve insertion order because
        // the mounted v1 ETag hashes the serialized response bytes.
        out.insert("achievements".into(), achievements);
        out.insert("avatar".into(), profile_avatar(&profile, &p));
        out.insert(
            "linkedAccounts".into(),
            p.get("linkedAccounts").cloned().unwrap_or(Value::Null),
        );
        out.insert(
            "creationDate".into(),
            egdata_core::v1::serialization::date_value(&p["creationDate"]),
        );
        out.insert("reviews".into(), json!(reviews));
        let v = Value::Object(out);
        v1_cache_set(s.cache.as_ref(), &key, &v, PROFILE_TTL).await;
        v
    };
    Ok(result(Method::GET, uri, rid, data, None))
}

fn achievements_pipeline(
    id: &str,
    last: Option<Vec<Value>>,
    limit: u32,
) -> Result<Vec<Document>, ProblemError> {
    let mut stages = vec![
        json!({"$match":{"epicAccountId":id}}),
        json!({"$unwind":"$playerAchievements"}),
        json!({"$match":{"playerAchievements.playerAchievement.unlocked":true}}),
        json!({"$addFields":{"unlockDate":"$playerAchievements.playerAchievement.unlockDate"}}),
        json!({"$group":{"_id":{"achievementName":"$playerAchievements.playerAchievement.achievementName","sandboxId":"$playerAchievements.playerAchievement.sandboxId"},"doc":{"$first":"$$ROOT"},"latestUnlockDate":{"$max":"$unlockDate"}}}),
        json!({"$replaceRoot":{"newRoot":"$doc"}}),
        json!({"$addFields":{"sortUnlockDate":{"$convert":{"input":"$unlockDate","to":"date","onError":null,"onNull":null}}}}),
        json!({"$lookup":{"from":"achievementsets","let":{"achievementName":"$playerAchievements.playerAchievement.achievementName","sandboxId":"$playerAchievements.playerAchievement.sandboxId"},"pipeline":[{"$match":{"$expr":{"$eq":["$sandboxId","$$sandboxId"]}}},{"$unwind":"$achievements"},{"$match":{"$expr":{"$eq":["$achievements.name","$$achievementName"]}}},{"$project":{"_id":0,"achievementDetails":"$achievements"}}],"as":"achievementDetails"}}),
        json!({"$unwind":{"path":"$achievementDetails","preserveNullAndEmptyArrays":false}}),
        json!({"$project":{"_id":0,"achievementName":"$playerAchievements.playerAchievement.achievementName","unlockDate":"$playerAchievements.playerAchievement.unlockDate","XP":"$playerAchievements.playerAchievement.XP","sandboxId":"$playerAchievements.playerAchievement.sandboxId","isBase":"$playerAchievements.playerAchievement.isBase","achievementDetails":"$achievementDetails.achievementDetails","sortUnlockDate":1}}),
    ];
    if let Some(values) = last {
        let mut tuple = Vec::new();
        for (i, v) in values.into_iter().enumerate() {
            if i == 0 {
                tuple.push(
                    v.as_str()
                        .and_then(|s| bson::DateTime::parse_rfc3339_str(s).ok())
                        .map(Bson::DateTime)
                        .unwrap_or(Bson::Null),
                );
            } else {
                tuple.push(Bson::try_from(v).unwrap_or(Bson::Null));
            }
        }
        let filter = mongo_keyset_filter(
            &[
                MongoSortField::new("sortUnlockDate", SortDirection::Desc, NullsOrder::Last),
                MongoSortField::new("sandboxId", SortDirection::Asc, NullsOrder::First),
                MongoSortField::new("achievementName", SortDirection::Asc, NullsOrder::First),
            ],
            &tuple,
        )?;
        stages.push(json!({"$match":filter}));
    }
    stages.push(json!({"$sort":{"sortUnlockDate":-1,"sandboxId":1,"achievementName":1}}));
    stages.push(json!({"$limit":limit+1}));
    Ok(pipeline(stages))
}

async fn achievements(
    State(s): State<AppState>,
    Path(raw): Path<String>,
    headers: HeaderMap,
    uri: Uri,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let rid = request_id(ctx, &headers);
    let id = id_or_error(raw, "id").map_err(|e| fail(e, &uri, rid.clone()))?;
    let (limit, cursor) = parse_page(&uri, 100).map_err(|e| fail(e, &uri, rid.clone()))?;
    let binding = cursor_binding(
        "profiles.achievements",
        json!({"profileId":id}),
        "unlockDate:desc,sandboxId:asc,achievementName:asc",
        limit,
    );
    let key = cache_key(
        "profiles.achievements",
        &[
            ("id", json!(id)),
            ("limit", json!(limit)),
            ("cursor", json!(cursor)),
        ],
    );
    let count_key = cache_key("profiles.achievements.count", &[("id", json!(id))]);
    let payload = if let Some(v) = v1_cache_get(s.cache.as_ref(), &key).await {
        v
    } else {
        let last = cursor
            .as_deref()
            .map(|c| cursor_values(&s, &binding, c))
            .transpose()
            .map_err(|e| fail(e, &uri, rid.clone()))?;
        let rows = s
            .mongo
            .aggregate_with_options(
                "player-achievements",
                achievements_pipeline(&id, last, limit).map_err(|e| fail(e, &uri, rid.clone()))?,
                disk_aggregation(),
            )
            .await
            .map_err(|_| fail(super::system::internal_error(), &uri, rid.clone()))?;
        let page = trim_page(docs_json(rows), limit as usize);
        let has_more = page.has_more;
        let records = page.items;
        let count = if let Some(v) = v1_cache_get(s.cache.as_ref(), &count_key).await {
            v
        } else {
            let count_rows=s.mongo.aggregate("player-achievements",pipeline(vec![json!({"$match":{"epicAccountId":id}}),json!({"$unwind":"$playerAchievements"}),json!({"$match":{"playerAchievements.playerAchievement.unlocked":true}}),json!({"$group":{"_id":{"achievementName":"$playerAchievements.playerAchievement.achievementName","sandboxId":"$playerAchievements.playerAchievement.sandboxId"}}}),json!({"$count":"count"})])).await.map_err(|_|fail(super::system::internal_error(),&uri,rid.clone()))?;
            let count = json!(
                count_rows
                    .into_iter()
                    .next()
                    .map(|row| number(&doc_json(row)["count"]))
                    .unwrap_or(0.)
            );
            v1_cache_set(
                s.cache.as_ref(),
                &count_key,
                &json!(count),
                ACHIEVEMENTS_TTL,
            )
            .await;
            count
        };
        let sandbox_ids = distinct_ids(&records, "sandboxId");
        let offers = if sandbox_ids.is_empty() {
            vec![]
        } else {
            s.mongo.find_many("offers",doc!{"namespace":{"$in":sandbox_ids},"offerType":{"$in":["BASE_GAME","DLC"]},"prePurchase":{"$ne":true}},MongoFindOptions::default()).await.map_err(|_|fail(super::system::internal_error(),&uri,rid.clone()))?
        };
        let mut offer_by_sandbox = HashMap::<String, Value>::new();
        for offer in docs_json(offers) {
            let key = nullable_string(&offer["namespace"]);
            if offer_by_sandbox.get(&key).is_none_or(|prior| {
                prior["offerType"] != "BASE_GAME" && offer["offerType"] == "BASE_GAME"
            }) {
                offer_by_sandbox.insert(key, offer);
            }
        }
        let achievements = records
            .iter()
            .map(|row| {
                let details = egdata_core::v1::serialize_value(
                    row.get("achievementDetails").unwrap_or(&Value::Null),
                );
                let offer = offer_by_sandbox
                    .get(&nullable_string(&row["sandboxId"]))
                    .map(egdata_core::v1::serialize_value);
                let unlock = row
                    .get("unlockDate")
                    .filter(|v| !v.is_null())
                    .or_else(|| row.get("sortUnlockDate"))
                    .cloned()
                    .unwrap_or(Value::Null);
                let mut detail = details.as_object().cloned().unwrap_or_default();
                detail.insert("unlocked".into(), json!(true));
                detail.insert(
                    "unlockDate".into(),
                    egdata_core::v1::serialization::date_value(&unlock),
                );
                detail.insert("offer".into(), offer.unwrap_or(Value::Null));
                Value::Object(detail)
            })
            .collect::<Vec<_>>();
        let next = if has_more {
            records
                .last()
                .map(|r| {
                    cursor_token(
                        &s,
                        &binding,
                        vec![
                            json!(iso_or_null(r.get("sortUnlockDate").unwrap_or(&Value::Null))),
                            r.get("sandboxId").cloned().unwrap_or(Value::Null),
                            r.get("achievementName").cloned().unwrap_or(Value::Null),
                        ],
                    )
                })
                .transpose()
                .map_err(|e| fail(e, &uri, rid.clone()))?
        } else {
            None
        };
        let v = json!({"achievements":achievements,"count":count,"pagination":{"limit":limit,"hasMore":has_more,"nextCursor":next}});
        v1_cache_set(s.cache.as_ref(), &key, &v, ACHIEVEMENTS_TTL).await;
        v
    };
    Ok(result(
        Method::GET,
        uri,
        rid,
        json!({"achievements":payload["achievements"],"count":payload["count"]}),
        Some(json!({"pagination":payload["pagination"]})),
    ))
}

async fn sandbox_achievements(
    State(s): State<AppState>,
    Path((raw, sandbox)): Path<(String, String)>,
    headers: HeaderMap,
    uri: Uri,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let rid = request_id(ctx, &headers);
    let id = id_or_error(raw, "id").map_err(|e| fail(e, &uri, rid.clone()))?;
    let sandbox = id_or_error(sandbox, "sandboxId").map_err(|e| fail(e, &uri, rid.clone()))?;
    let key = cache_key(
        "profiles.achievements.sandbox",
        &[("id", json!(id)), ("sandboxId", json!(sandbox))],
    );
    let data = if let Some(v) = v1_cache_get(s.cache.as_ref(), &key).await {
        v
    } else {
        let rows = s
            .mongo
            .find_many(
                "player-achievements",
                doc! {"epicAccountId":&id,"sandboxId":&sandbox},
                MongoFindOptions::default(),
            )
            .await
            .map_err(|_| fail(super::system::internal_error(), &uri, rid.clone()))?;
        let rows = docs_json(rows);
        let set_ids = distinct_ids(
            rows.iter()
                .filter_map(|r| r["achievementSets"].as_array())
                .flatten(),
            "achievementSetId",
        );
        let sets = if set_ids.is_empty() {
            vec![]
        } else {
            s.mongo
                .find_many(
                    "achievementsets",
                    doc! {"achievementSetId":{"$in":set_ids }},
                    MongoFindOptions::default(),
                )
                .await
                .map_err(|_| fail(super::system::internal_error(), &uri, rid.clone()))?
        };
        let v = json!({"playerAchievements":rows,"sandboxAchievements":docs_json(sets)});
        v1_cache_set(s.cache.as_ref(), &key, &v, SANDBOX_TTL).await;
        v
    };
    Ok(result(Method::GET, uri, rid, data, None))
}

fn rare_rows(rows: Vec<Document>) -> Value {
    let mut rows = docs_json(rows);
    for row in &mut rows {
        if let Some(date) = row.get_mut("unlockDate") {
            *date = egdata_core::v1::serialization::date_value(date)
        }
    }
    Value::Array(rows)
}
pub(crate) fn rare_pipeline(filter: Value, limit: Option<u32>) -> Vec<Value> {
    let mut p = vec![
        json!({"$match":filter}),
        json!({"$unwind":"$playerAchievements"}),
        json!({"$match":{"playerAchievements.playerAchievement.unlocked":true}}),
        json!({"$lookup":{"from":"achievementsets","let":{"setId":"$playerAchievements.playerAchievement.achievementSetId","name":"$playerAchievements.playerAchievement.achievementName"},"pipeline":[{"$match":{"$expr":{"$eq":["$achievementSetId","$$setId"]}}},{"$unwind":"$achievements"},{"$match":{"$expr":{"$eq":["$achievements.name","$$name"]}}},{"$project":{"_id":0,"sandboxId":1,"achievementSetId":1,"achievement":"$achievements"}}],"as":"achDoc"}}),
        json!({"$unwind":"$achDoc"}),
        json!({"$replaceRoot":{"newRoot":{"$mergeObjects":["$achDoc.achievement",{"sandboxId":"$achDoc.sandboxId","achievementSetId":"$achDoc.achievementSetId","unlocked":true,"unlockDate":"$playerAchievements.playerAchievement.unlockDate"}]}}}),
    ];
    if limit == Some(25) {
        p.extend([
            json!({"$group":{"_id":null,"rare25":{"$topN":{"n":25,"sortBy":{"completedPercent":1},"output":"$$ROOT"}}}}),
            json!({"$unwind":"$rare25"}),
            json!({"$replaceRoot":{"newRoot":"$rare25"}}),
            json!({"$lookup":{"from":"offers","let":{"sbx":"$sandboxId"},"pipeline":[{"$match":{"$expr":{"$and":[{"$eq":["$namespace","$$sbx"]},{"$eq":["$offerType","BASE_GAME"]},{"$eq":["$isCodeRedemptionOnly",false]}]}}},{"$sort":{"isDisplayable":-1,"title":1,"lastModifiedDate":-1}},{"$limit":1},{"$project":{"_id":0,"id":1,"namespace":1,"keyImages":1,"title":1,"productSlug":1}}],"as":"offer"}}),
            json!({"$unwind":{"path":"$offer","preserveNullAndEmptyArrays":true}}),
        ]);
    } else if let Some(n) = limit {
        p.push(json!({"$sort":{"completedPercent":1}}));
        p.push(json!({"$limit":n}));
    }
    p
}
async fn rare_achievements(
    State(s): State<AppState>,
    Path(raw): Path<String>,
    headers: HeaderMap,
    uri: Uri,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let rid = request_id(ctx, &headers);
    let id = id_or_error(raw, "id").map_err(|e| fail(e, &uri, rid.clone()))?;
    let key = cache_key("profiles.rareAchievements", &[("id", json!(id))]);
    let rows = if let Some(v) = v1_cache_get(s.cache.as_ref(), &key).await {
        v.as_array().cloned().unwrap_or_default()
    } else {
        let f = json!({"epicAccountId":id,"playerAchievements":{"$elemMatch":{"playerAchievement.unlocked":true}}});
        let r = s
            .mongo
            .aggregate_with_options(
                "player-achievements",
                pipeline(rare_pipeline(f, Some(25))),
                disk_aggregation(),
            )
            .await
            .map_err(|_| fail(super::system::internal_error(), &uri, rid.clone()))?;
        let v = rare_rows(r);
        v1_cache_set(s.cache.as_ref(), &key, &v, RARE_TTL).await;
        v.as_array().cloned().unwrap_or_default()
    };
    Ok(result(Method::GET, uri, rid, json!(rows), None))
}
async fn rare_sandbox_achievements(
    State(s): State<AppState>,
    Path((raw, sandbox)): Path<(String, String)>,
    headers: HeaderMap,
    uri: Uri,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let rid = request_id(ctx, &headers);
    let id = id_or_error(raw, "id").map_err(|e| fail(e, &uri, rid.clone()))?;
    let sandbox = id_or_error(sandbox, "sandboxId").map_err(|e| fail(e, &uri, rid.clone()))?;
    let key = cache_key(
        "profiles.rareAchievements.sandbox",
        &[("id", json!(id)), ("sandboxId", json!(sandbox))],
    );
    let rows = if let Some(v) = v1_cache_get(s.cache.as_ref(), &key).await {
        v.as_array().cloned().unwrap_or_default()
    } else {
        let r = s
            .mongo
            .aggregate(
                "player-achievements",
                pipeline(rare_pipeline(
                    json!({"epicAccountId":id,"sandboxId":sandbox}),
                    Some(3),
                )),
            )
            .await
            .map_err(|_| fail(super::system::internal_error(), &uri, rid.clone()))?;
        let v = rare_rows(r);
        v1_cache_set(s.cache.as_ref(), &key, &v, RARE_SANDBOX_TTL).await;
        v.as_array().cloned().unwrap_or_default()
    };
    Ok(result(Method::GET, uri, rid, json!(rows), None))
}

async fn information(
    State(s): State<AppState>,
    Path(raw): Path<String>,
    headers: HeaderMap,
    uri: Uri,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let rid = request_id(ctx, &headers);
    let id = id_or_error(raw, "id").map_err(|e| fail(e, &uri, rid.clone()))?;
    let profile = cached_identity(&s, &id, 3600)
        .await
        .map_err(|_| fail(super::system::internal_error(), &uri, rid.clone()))?;
    let profile = profile.ok_or_else(|| {
        fail(
            not_found(
                "PROFILE_NOT_FOUND",
                format!("No Epic profile was found for '{id}'."),
            ),
            &uri,
            rid.clone(),
        )
    })?;
    let dbp = s
        .mongo
        .find_one("epic", doc! {"accountId":{"$eq":&id}}, None)
        .await
        .map_err(|_| fail(super::system::internal_error(), &uri, rid.clone()))?;
    let donations = s
        .mongo
        .find_many(
            "key-codes",
            doc! {"accountId":{"$eq":&id}},
            MongoFindOptions::default(),
        )
        .await
        .map_err(|_| fail(super::system::internal_error(), &uri, rid.clone()))?;
    let statkey = cache_key("profiles.information.stats", &[("id", json!(id))]);
    let stats = if let Some(v) = v1_cache_get(s.cache.as_ref(), &statkey).await {
        v
    } else {
        let rows=s.mongo.aggregate("player-achievements",pipeline(vec![json!({"$match":{"epicAccountId":id}}),json!({"$group":{"_id":"$sandboxId","playerAwards":{"$first":"$playerAwards"},"totalUnlocked":{"$first":"$totalUnlocked"},"totalXP":{"$first":"$totalXP"}}}),json!({"$group":{"_id":null,"totalGames":{"$sum":1},"totalPlayerAwards":{"$sum":{"$size":{"$ifNull":["$playerAwards",[]]}}},"totalAchievements":{"$sum":{"$ifNull":["$totalUnlocked",0]}},"totalXP":{"$sum":{"$ifNull":["$totalXP",0]}}}})])).await.map_err(|_|fail(super::system::internal_error(),&uri,rid.clone()))?;
        let count = s
            .mongo
            .count_documents("reviews", doc! {"userId":&id})
            .await
            .map_err(|_| fail(super::system::internal_error(), &uri, rid.clone()))?;
        let r = rows
            .first()
            .map(|d| doc_json(d.clone()))
            .unwrap_or(json!({}));
        let awards = number(&r["totalPlayerAwards"]);
        let v = json!({"totalGames":number(&r["totalGames"]),"totalAchievements":number(&r["totalAchievements"]),"totalPlayerAwards":awards,"totalXP":number(&r["totalXP"])+awards*250.,"reviewsCount":count});
        v1_cache_set(s.cache.as_ref(), &statkey, &v, INFO_TTL).await;
        v
    };
    let p = dbp.map(doc_json).unwrap_or(Value::Null);
    let mut out = profile.as_object().cloned().unwrap_or_default();
    out.insert("stats".into(), stats);
    out.insert("avatar".into(), profile_avatar(&profile, &p));
    out.insert(
        "linkedAccounts".into(),
        p.get("linkedAccounts").cloned().unwrap_or(Value::Null),
    );
    out.insert(
        "creationDate".into(),
        egdata_core::v1::serialization::date_value(&p["creationDate"]),
    );
    out.insert(
        "donations".into(),
        json!(
            donations
                .iter()
                .filter_map(|d| d.get_array("details").ok())
                .flatten()
                .map(egdata_core::v1::bson_to_serialized_json)
                .collect::<Vec<_>>()
        ),
    );
    out.insert(
        "discord".into(),
        json!(match &p["discordId"] {
            Value::Null => false,
            Value::Bool(v) => *v,
            Value::Number(n) => n.as_f64() != Some(0.),
            Value::String(s) => !s.is_empty(),
            _ => true,
        }),
    );
    Ok(result(Method::GET, uri, rid, Value::Object(out), None))
}

fn games_sort_fields(sort: &str) -> Vec<MongoSortField> {
    let (primary, direction, nulls) = match sort {
        "alphabetical" => ("product.name", SortDirection::Asc, NullsOrder::First),
        "xp" => ("totalXP", SortDirection::Desc, NullsOrder::Last),
        "achievements" => ("totalUnlocked", SortDirection::Desc, NullsOrder::Last),
        _ => (
            "completionPercentage",
            SortDirection::Desc,
            NullsOrder::Last,
        ),
    };
    let mut fields = vec![MongoSortField::new(primary, direction, nulls)];
    if sort != "alphabetical" {
        fields.push(MongoSortField::new(
            "product.name",
            SortDirection::Asc,
            NullsOrder::First,
        ));
    }
    fields.push(MongoSortField::new(
        "sandboxId",
        SortDirection::Asc,
        NullsOrder::First,
    ));
    fields
}

fn games_pipeline(
    id: &str,
    platinum: bool,
    sort: &str,
    last: Option<Vec<Value>>,
    limit: u32,
) -> Result<Vec<Document>, ProblemError> {
    let mut stages = vec![
        json!({"$match":{"epicAccountId":id}}),
        json!({"$group":{"_id":"$sandboxId","totalUnlocked":{"$max":"$totalUnlocked"},"totalXP":{"$max":"$totalXP"},"playerAwards_arr":{"$push":"$playerAwards"}}}),
        json!({"$addFields":{"playerAwards":{"$reduce":{"input":"$playerAwards_arr","initialValue":[],"in":{"$setUnion":["$$value","$$this"]}}}}}),
        json!({"$project":{"playerAwards_arr":0}}),
    ];
    if platinum {
        stages.push(json!({"$match":{"$expr":{"$gt":[{"$size":"$playerAwards"},0]}}}));
    }
    stages.extend([
        json!({"$lookup":{"from":"offers","let":{"sbx":"$_id"},"pipeline":[{"$match":{"$expr":{"$and":[{"$eq":["$namespace","$$sbx"]},{"$eq":["$offerType","BASE_GAME"]},{"$eq":["$isCodeRedemptionOnly",false]}]}}},{"$sort":{"isDisplayable":-1,"title":1,"lastModifiedDate":-1}},{"$limit":1},{"$project":{"_id":0,"id":1,"namespace":1,"keyImages":1,"title":1,"productSlug":1}}],"as":"offer"}}),
        json!({"$unwind":{"path":"$offer","preserveNullAndEmptyArrays":true}}),
        json!({"$lookup":{"from":"achievementsets","localField":"_id","foreignField":"sandboxId","as":"achievementSets"}}),
        json!({"$addFields":{"totalAchievements":{"$sum":{"$map":{"input":"$achievementSets","as":"s","in":{"$size":{"$ifNull":["$$s.achievements",[]]}}}}},"totalProductXP":{"$sum":{"$map":{"input":"$achievementSets","as":"s","in":{"$reduce":{"input":{"$ifNull":["$$s.achievements",[]]},"initialValue":0,"in":{"$add":["$$value","$$this.xp"]}}}}}}}}),
        json!({"$addFields":{"productAchievements":{"totalAchievements":"$totalAchievements","totalProductXP":"$totalProductXP"},"completionPercentage":{"$cond":[{"$eq":["$totalAchievements",0]},0,{"$divide":["$totalUnlocked","$totalAchievements"]}]},"baseOfferForSandbox":{"id":"$offer.id","namespace":"$offer.namespace","keyImages":"$offer.keyImages"},"product":{"name":"$offer.title","slug":"$offer.productSlug"},"sandboxId":"$_id"}}),
        json!({"$project":{"_id":0,"offer":0,"achievementSets":0,"totalAchievements":0,"totalProductXP":0}}),
    ]);
    if let Some(values) = last {
        let sort_fields = games_sort_fields(sort);
        let tuple = values
            .into_iter()
            .map(|v| bson::Bson::try_from(v).unwrap_or(Bson::Null))
            .collect::<Vec<_>>();
        let filter = mongo_keyset_filter(&sort_fields, &tuple)?;
        stages.push(json!({"$match":filter}));
    }
    let sort_doc = mongo_sort_spec(&games_sort_fields(sort));
    stages.push(json!({"$sort":sort_doc}));
    stages.push(json!({"$limit":limit + 1}));
    Ok(pipeline(stages))
}

async fn games(
    State(s): State<AppState>,
    Path(raw): Path<String>,
    headers: HeaderMap,
    uri: Uri,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let rid = request_id(ctx, &headers);
    let id = id_or_error(raw, "id").map_err(|e| fail(e, &uri, rid.clone()))?;
    let mut q = parse_validated_query(&uri, &["limit", "cursor", "sort", "platinum"], |params| {
        const SORTS: &[&str] = &["completion", "alphabetical", "xp", "achievements"];
        if params
            .get("sort")
            .is_some_and(|value| !SORTS.contains(&value.as_str()))
        {
            return vec![egdata_core::v1::ProblemIssue {
                parameter: Some("sort".into()),
                pointer: Some("/sort".into()),
                code: "INVALID_VALUE".into(),
                message: format!(
                    "Invalid option: expected one of {}",
                    SORTS
                        .iter()
                        .map(|s| format!(r#""{s}""#))
                        .collect::<Vec<_>>()
                        .join("|")
                ),
            }];
        }
        Vec::new()
    })
    .map_err(|e| fail(e, &uri, rid.clone()))?;
    let (limit, cursor) = parse_pagination_map(&q, 100)
        .map(|p| (p.limit, p.cursor))
        .map_err(|e| fail(e, &uri, rid.clone()))?;
    let sort = q.remove("sort").unwrap_or_else(|| "completion".into());
    let platinum = parse_boolean(q.get("platinum").map(String::as_str), "platinum")
        .map_err(|e| fail(e, &uri, rid.clone()))?
        .unwrap_or(false);
    let order = match sort.as_str() {
        "alphabetical" => "product.name:asc,sandboxId:asc",
        "xp" => "totalXP:desc,product.name:asc,sandboxId:asc",
        "achievements" => "totalUnlocked:desc,product.name:asc,sandboxId:asc",
        _ => "completionPercentage:desc,product.name:asc,sandboxId:asc",
    };
    let binding = cursor_binding(
        "profiles.games",
        json!({"profileId":id,"sort":sort,"platinum":platinum}),
        order,
        limit,
    );
    let key = cache_key(
        "profiles.games",
        &[
            ("id", json!(id)),
            ("limit", json!(limit)),
            ("cursor", json!(cursor)),
            ("sort", json!(sort)),
            ("platinum", json!(platinum)),
        ],
    );
    let payload = if let Some(v) = v1_cache_get(s.cache.as_ref(), &key).await {
        v
    } else {
        let profile = cached_identity(&s, &id, 60)
            .await
            .map_err(|_| fail(super::system::internal_error(), &uri, rid.clone()))?;
        if profile.is_none() {
            return Err(fail(
                not_found(
                    "PROFILE_NOT_FOUND",
                    format!("No Epic profile was found for '{id}'."),
                ),
                &uri,
                rid,
            ));
        }
        let last = cursor
            .as_deref()
            .map(|c| cursor_values(&s, &binding, c))
            .transpose()
            .map_err(|e| fail(e, &uri, rid.clone()))?;
        let rows = s
            .mongo
            .aggregate_with_options(
                "player-achievements",
                games_pipeline(&id, platinum, &sort, last, limit)
                    .map_err(|e| fail(e, &uri, rid.clone()))?,
                MongoAggregateOptions {
                    collation: (sort == "alphabetical").then(|| doc! {"locale":"en","strength":2}),
                    ..disk_aggregation()
                },
            )
            .await
            .map_err(|_| fail(super::system::internal_error(), &uri, rid.clone()))?;
        let page = trim_page(docs_json(rows), limit as usize);
        let items = page.items;
        let next = if page.has_more {
            items
                .last()
                .map(|r| {
                    cursor_token(
                        &s,
                        &binding,
                        games_sort_fields(&sort)
                            .iter()
                            .map(|field| {
                                match field.field.as_str() {
                                    "product.name" => r.pointer("/product/name"),
                                    "sandboxId" => r.get("sandboxId"),
                                    numeric => r.get(numeric).filter(|value| value.is_number()),
                                }
                                .cloned()
                                .unwrap_or(Value::Null)
                            })
                            .collect(),
                    )
                })
                .transpose()
                .map_err(|e| fail(e, &uri, rid.clone()))?
        } else {
            None
        };
        let v = json!({"achievements":items,"pagination":{"limit":limit,"hasMore":page.has_more,"nextCursor":next}});
        v1_cache_set(s.cache.as_ref(), &key, &v, GAMES_TTL).await;
        v
    };
    Ok(result(
        Method::GET,
        uri,
        rid,
        json!({"achievements":payload["achievements"]}),
        Some(json!({"pagination":payload["pagination"]})),
    ))
}

async fn random_game(
    State(s): State<AppState>,
    Path(raw): Path<String>,
    headers: HeaderMap,
    uri: Uri,
    ctx: Option<Extension<V1RequestContext>>,
) -> Result<Response, V1ErrorResponse> {
    let rid = request_id(ctx, &headers);
    let id = id_or_error(raw, "id").map_err(|e| fail(e, &uri, rid.clone()))?;
    let q = parse_validated_query(&uri, &["sandbox"], |q| {
        search_query_issues(q, "sandbox", &[])
    })
    .map_err(|e| fail(e, &uri, rid.clone()))?;
    let sandbox = q
        .get("sandbox")
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .map(str::to_owned);
    let key = cache_key(
        "profiles.randomGame",
        &[
            ("id", json!(id)),
            ("sandbox", json!(sandbox.as_deref().unwrap_or("random"))),
        ],
    );
    let offer = if let Some(v) = v1_cache_get(s.cache.as_ref(), &key).await {
        v
    } else {
        let profile = cached_identity(&s, &id, 60)
            .await
            .map_err(|_| fail(super::system::internal_error(), &uri, rid.clone()))?;
        if profile.is_none() {
            return Err(fail(
                not_found(
                    "PROFILE_NOT_FOUND",
                    format!("No Epic profile was found for '{id}'."),
                ),
                &uri,
                rid,
            ));
        }
        let saved = if let Some(sb) = &sandbox {
            s.mongo
                .find_one(
                    "player-achievements",
                    doc! {"epicAccountId":{"$eq":&id},"sandboxId":{"$eq":sb}},
                    None,
                )
                .await
                .map_err(|_| fail(super::system::internal_error(), &uri, rid.clone()))?
        } else {
            let filter = doc! {"epicAccountId":{"$eq":&id}};
            let total = s
                .mongo
                .count_documents("player-achievements", filter.clone())
                .await
                .map_err(|_| fail(super::system::internal_error(), &uri, rid.clone()))?;
            if total == 0 {
                return Err(fail(
                    not_found(
                        "PROFILE_ACHIEVEMENTS_NOT_FOUND",
                        format!("No achievements were found for '{id}'."),
                    ),
                    &uri,
                    rid,
                ));
            }
            let skip = rand::rng().random_range(0..total);
            s.mongo
                .find_many(
                    "player-achievements",
                    filter,
                    MongoFindOptions {
                        skip: Some(skip),
                        limit: Some(1),
                        ..Default::default()
                    },
                )
                .await
                .map_err(|_| fail(super::system::internal_error(), &uri, rid.clone()))?
                .into_iter()
                .next()
        };
        let saved = saved.ok_or_else(|| {
            let detail = match sandbox.as_deref() {
                Some(sb) => format!("No achievements were found for '{id}' in sandbox '{sb}'."),
                None => format!("No achievements were found for '{id}'."),
            };
            fail(
                not_found("PROFILE_SANDBOX_ACHIEVEMENTS_NOT_FOUND", detail),
                &uri,
                rid.clone(),
            )
        })?;
        let sandbox_id = saved.get("sandboxId");
        let id_filter = doc! {"$eq":sandbox_id.cloned().unwrap_or(Bson::Null)};
        let sb = sandbox_id
            .map(|b| {
                egdata_core::v1::serialization::js_string(
                    &egdata_core::v1::bson_to_serialized_json(b),
                )
            })
            .unwrap_or_else(|| "undefined".into());
        let sandbox_record = s
            .mongo
            .find_one("sandboxes", doc! {"_id":&id_filter}, None)
            .await
            .map_err(|_| fail(super::system::internal_error(), &uri, rid.clone()))?;
        if sandbox_record.is_none() {
            return Err(fail(
                not_found(
                    "SANDBOX_NOT_FOUND",
                    format!("No sandbox was found for '{sb}'."),
                ),
                &uri,
                rid,
            ));
        }
        let offer = s
            .mongo
            .find_one(
                "offers",
                doc! {"namespace":id_filter,"offerType":"BASE_GAME"},
                None,
            )
            .await
            .map_err(|_| fail(super::system::internal_error(), &uri, rid.clone()))?;
        let offer = offer.ok_or_else(|| {
            fail(
                not_found(
                    "OFFER_NOT_FOUND",
                    format!("No base-game offer was found for sandbox '{sb}'."),
                ),
                &uri,
                rid.clone(),
            )
        })?;
        let v = doc_json(offer);
        v1_cache_set(s.cache.as_ref(), &key, &v, 360).await;
        v
    };
    Ok(result(Method::GET, uri, rid, offer, None))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn profile_storage_and_cache_edges_match_node() {
        super::super::mongo_read_oracle::replay_mongo_oracle(include_str!(
            "../../tests/fixtures/v1-profile-edges.json"
        ))
        .await;
    }

    #[tokio::test]
    async fn profile_service_failures_return_canonical_problems() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../tests/fixtures/v1-profile-edges.json"))
                .unwrap();
        let mut failures = Vec::new();
        for case in &cases {
            if case["response"]["status"] != 200
                || case["name"]
                    .as_str()
                    .unwrap()
                    .starts_with("v1 profile baseline ")
            {
                continue;
            }
            for (index, entry) in case["trace"].as_array().unwrap().iter().enumerate() {
                let call = &entry["call"];
                if call.get("collection").is_none() && call["method"] != "epicUser" {
                    continue;
                }
                let mut failure = case.clone();
                failure["name"] =
                    json!(format!("{} fault {index}", case["name"].as_str().unwrap()));
                failure["trace"][index]["error"] = json!(true);
                failure["failedRead"] = json!(true);
                let path = case["request"]["path"]
                    .as_str()
                    .unwrap()
                    .split('?')
                    .next()
                    .unwrap();
                let expected = cases
                    .iter()
                    .find(|c| c["response"]["status"] == 500 && c["request"]["path"] == path)
                    .unwrap();
                failure["response"] = expected["response"].clone();
                failures.push(failure);
            }
        }
        super::super::mongo_read_oracle::replay_mongo_oracle(
            &serde_json::to_string(&failures).unwrap(),
        )
        .await;
    }

    #[test]
    fn standalone_handler_uses_request_id_header_without_context() {
        let mut headers = HeaderMap::new();
        assert!(request_id(None, &headers).is_empty());
        headers.insert("x-request-id", "request-from-gateway".parse().unwrap());
        assert_eq!(request_id(None, &headers), "request-from-gateway");
    }

    #[test]
    fn uncapped_rarity_pipeline_retains_all_unlocked_achievements() {
        let filter = json!({"epicAccountId":"player"});
        let pipeline = rare_pipeline(filter.clone(), None);
        assert_eq!(pipeline[0], json!({"$match":filter}));
        assert!(
            pipeline
                .iter()
                .all(|stage| stage.get("$limit").is_none() && stage.get("$group").is_none())
        );
    }
}
