use super::*;
use rand::RngExt;

fn primitive_id(id: &Bson) -> bool {
    matches!(
        id,
        Bson::String(_)
            | Bson::Int32(_)
            | Bson::Double(_)
            | Bson::Int64(_)
            | Bson::Boolean(_)
            | Bson::Null
    )
}

pub(super) async fn sandbox_achievements(
    State(s): State<AppState>,
    Path((id, sandbox)): Path<(String, String)>,
) -> Result<Response> {
    let key = format!("epic-profile:{id}:{sandbox}:v0.1");
    if let Some(hit) = cached(&s, &key).await? {
        return Ok(ok(&hit, Some(PUBLIC)));
    }
    let player = s
        .mongo
        .find_many(
            "player-achievements",
            doc! {"epicAccountId":&id,"sandboxId":&sandbox},
            Default::default(),
        )
        .await?;
    let mut ids = Vec::<Bson>::new();
    for doc in &player {
        for set in doc
            .get_array("achievementSets")
            .map_err(|_| Error::Internal)?
        {
            if matches!(set, Bson::Null | Bson::Undefined) {
                return Err(Error::Internal);
            }
            let id = set
                .as_document()
                .and_then(|s| s.get("achievementSetId"))
                .cloned()
                .unwrap_or(Bson::Null);
            // Driver objects are separate references even when their BSON values match.
            if !primitive_id(&id) || !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    let definitions = many(&s, "achievementsets", doc! {"achievementSetId":{"$in":ids}}).await?;
    Ok(ok(
        &json!({"playerAchievements":values(player),"sandboxAchievements":definitions}),
        None,
    ))
}

pub(super) async fn rare(State(s): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let filter = json!({"epicAccountId":id,"playerAchievements":{"$elemMatch":{"playerAchievement.unlocked":true}}});
    rare_rows(
        &s,
        format!("epic-profile:{id}:rare-achievements:v2"),
        filter,
        25,
    )
    .await
}
pub(super) async fn rare_sandbox(
    State(s): State<AppState>,
    Path((id, sandbox)): Path<(String, String)>,
) -> Result<Response> {
    let filter = json!({"epicAccountId":id,"sandboxId":sandbox});
    rare_rows(
        &s,
        format!("epic-profile:{id}:{sandbox}:rare-achievements:v2"),
        filter,
        3,
    )
    .await
}
async fn rare_rows(s: &AppState, key: String, filter: Value, count: u32) -> Result<Response> {
    if let Some(hit) = cached(s, &key).await? {
        return Ok(ok(&hit, Some(PUBLIC)));
    }
    let stages = egdata_http_core::shared::profiles::rare_pipeline(filter, Some(count));
    let rows = json!(values(
        aggregate(s, stages, (count == 25).then_some(true), None).await?
    ));
    save(s, &key, &rows, if count == 25 { 86400 } else { 3600 }).await?;
    Ok(ok(&rows, Some(PUBLIC)))
}

/// Numeric prefix consumed by JavaScript parseInt. The achievements route
/// allows implicit hexadecimal; the games route explicitly sets radix ten.
fn page_number(uri: &Uri, key: &str, default: f64, implicit_radix: bool) -> f64 {
    let Some(raw) = query(uri, key) else {
        return default;
    };
    let value = raw.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    let unsigned = value.trim_start_matches(['+', '-']);
    if value.len() - unsigned.len() > 1 {
        return f64::NAN;
    }
    let (radix, digits) = if implicit_radix
        && unsigned
            .get(..2)
            .is_some_and(|s| s.eq_ignore_ascii_case("0x"))
    {
        (16, &unsigned[2..])
    } else {
        (10, unsigned)
    };
    let digits = digits
        .chars()
        .take_while(|c| c.is_digit(radix))
        .collect::<String>();
    if digits.is_empty() {
        return f64::NAN;
    }
    let n = digits.chars().fold(0., |n, c| {
        n * f64::from(radix) + f64::from(c.to_digit(radix).unwrap())
    });
    if value.starts_with('-') { -n } else { n }
}
fn limit100(n: f64) -> f64 {
    if n.is_nan() { n } else { n.min(100.) }
}

pub(super) async fn achievements(
    State(s): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
) -> Result<Response> {
    let limit = limit100(page_number(&uri, "limit", 25., true));
    let page = limit100(page_number(&uri, "page", 1., true));
    let skip = (page - 1.) * limit;
    let (rows, count) = tokio::join!(
        aggregate(&s, pipelines::achievements(&id, skip, limit), None, None),
        aggregate(&s, pipelines::achievement_count(&id), None, None)
    );
    let (rows, count) = (rows?, values(count?));
    let namespaces = rows
        .iter()
        .map(|row| row.get("sandboxId").cloned().unwrap_or(Bson::Null))
        .collect::<Vec<_>>();
    let offers = s.mongo.find_many("offers",
        doc!{"namespace":{"$in":namespaces},"offerType":{"$in":["BASE_GAME","DLC"]},"prePurchase":{"$ne":true}},
        Default::default()).await?;
    let mut achievements = Vec::with_capacity(rows.len());
    for (index, row) in rows.iter().enumerate() {
        let namespace = row.get("sandboxId");
        let mut matches = offers.iter().filter(|offer| {
            let other = offer.get("namespace");
            // JavaScript compares BSON driver objects by reference, including ObjectIds.
            namespace.is_none_or(primitive_id)
                && other.is_none_or(primitive_id)
                && namespace == other
        });
        let base_game = |offer: &&Document| offer.get_str("offerType") == Ok("BASE_GAME");
        // Node re-sorts the array for every achievement. Its comparator reverses
        // the base games each time and keeps DLCs in their original order.
        let preferred = if index % 2 == 0 {
            matches.clone().rfind(base_game)
        } else {
            matches.clone().find(base_game)
        };
        let selected = preferred
            .or_else(|| matches.next())
            .map(bson_doc_to_js_json);
        let row = bson_doc_to_js_json(row);
        let mut achievement = spread(&row["achievementDetails"]);
        achievement["unlocked"] = json!(true);
        if let Some(date) = row.get("unlockDate") {
            achievement["unlockDate"] = date.clone();
        }
        achievement["offer"] = selected.unwrap_or(Value::Null);
        achievements.push(achievement);
    }
    let result = json!({"achievements":achievements,"count":count.first().and_then(|v|v.get("count")).filter(|v|!v.is_null()).cloned().unwrap_or(json!(0)),"limit":limit,"page":page});
    let (limit, page) = (format_js_number(limit), format_js_number(page));
    save(
        &s,
        &format!("epic-profile:{id}:achievements:{limit}:{page}:v0.3"),
        &result,
        3600,
    )
    .await?;
    Ok(ok(&result, Some(PUBLIC)))
}

pub(super) async fn games(
    State(s): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
) -> Result<Response> {
    let page = page_number(&uri, "page", 1., false);
    let limit = page_number(&uri, "limit", 10., false);
    let platinum = query(&uri, "platinum").as_deref() == Some("true");
    let sort = query(&uri, "sort")
        .filter(|s| matches!(s.as_str(), "xp" | "achievements" | "alphabetical"))
        .unwrap_or_else(|| "completion".into());
    let key = format!(
        "epic-profile:{id}:games:page:{}:limit:{}:platinum:{platinum}:sort:{sort}",
        format_js_number(page),
        format_js_number(limit)
    );
    if let Some(hit) = cached(&s, &key).await? {
        return Ok(ok(&hit, Some(PUBLIC)));
    }
    let load = async {
        if s.epic.get_user(&id).await?.filter(truthy).is_none() {
            return Err(message(StatusCode::NOT_FOUND, "Profile not found"));
        }
        let stages = pipelines::games(&id, platinum, &sort, (page - 1.) * limit, limit);
        let collation = (sort == "alphabetical").then(|| doc! {"locale":"en","strength":2});
        let rows = values(aggregate(&s, stages, Some(true), collation).await?);
        let first = rows.first().ok_or(Error::Internal)?;
        let total = first.get("total").cloned().unwrap_or(json!(0));
        let mut result = json!({});
        if let Some(rows) = first.get("paginated") {
            result["achievements"] = rows.clone();
        }
        result["pagination"] = json!({"total":total,"page":page,"limit":limit,"totalPages":(number(&total)/limit).ceil()});
        save(&s, &key, &result, 60).await?;
        Ok(ok(&result, Some(PUBLIC)))
    };
    load.await.map_err(|e| match e {
        Error::Internal => message(StatusCode::BAD_REQUEST, "Failed to fetch achievements"),
        other => other,
    })
}
pub(super) async fn random_game(
    State(s): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
) -> Result<Response> {
    let sandbox = query(&uri, "sandbox").filter(|s| !s.is_empty());
    let key = format!(
        "epic-profile:{id}:random-game:{}",
        sandbox.as_deref().unwrap_or("random")
    );
    if let Some(hit) = cached(&s, &key).await? {
        return Ok(ok(&hit, Some(PUBLIC)));
    }
    let load = async {
        if s.epic.get_user(&id).await?.filter(truthy).is_none() {
            return Err(message(StatusCode::NOT_FOUND, "Profile not found"));
        }
        let player = if let Some(sandbox) = sandbox {
            s.mongo
                .find_one(
                    "player-achievements",
                    doc! {"epicAccountId":{"$eq":&id},"sandboxId":{"$eq":sandbox}},
                    None,
                )
                .await?
        } else {
            let filter = doc! {"epicAccountId":&id};
            let count = s
                .mongo
                .count_documents("player-achievements", filter.clone())
                .await?;
            if count == 0 {
                return Err(message(
                    StatusCode::NOT_FOUND,
                    "No achievements found for this user",
                ));
            }
            let skip = rand::rng().random_range(0..count);
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
                .await?
                .into_iter()
                .next()
        }
        .ok_or(message(
            StatusCode::NOT_FOUND,
            "No achievements found for this user in the specified sandbox",
        ))?;
        let sandbox = player.get("sandboxId").cloned().unwrap_or(Bson::Null);
        if one(&s, "sandboxes", doc! {"_id":{"$eq":&sandbox}})
            .await?
            .is_none()
        {
            return Err(message(StatusCode::NOT_FOUND, "Sandbox not found"));
        }
        let offer = one(
            &s,
            "offers",
            doc! {"namespace":{"$eq":sandbox},"offerType":"BASE_GAME"},
        )
        .await?
        .ok_or(message(StatusCode::NOT_FOUND, "Offer not found"))?;
        save(&s, &key, &offer, 360).await?;
        Ok(ok(&offer, Some(PUBLIC)))
    };
    load.await.map_err(|e| match e {
        Error::Internal => message(StatusCode::BAD_REQUEST, "Failed to fetch offer"),
        other => other,
    })
}
