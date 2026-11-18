use super::*;
use futures::{StreamExt, stream::FuturesUnordered};

async fn db_profile(s: &AppState, filter: Document) -> Result<Value> {
    let row = one(s, "epic", filter.clone()).await?;
    ensure_creation_date(s, filter, row).await
}
async fn ensure_creation_date(s: &AppState, filter: Document, row: Option<Value>) -> Result<Value> {
    let mut row = row.unwrap_or(Value::Null);
    if row.is_object() && !truthy(&row["creationDate"]) {
        let now = (s.now)();
        s.mongo
            .update_one(
                "epic",
                filter,
                doc! {"$set":{"creationDate":bson::DateTime::from_chrono(now)}},
                false,
            )
            .await?;
        row["creationDate"] = json!(now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    }
    Ok(row)
}
fn merge_identity(out: &mut Value, profile: &Value, row: &Value) -> Result<()> {
    if !row["avatarUrl"].is_null() && row["avatarUrl"]["variants"].is_null() {
        return Err(Error::Internal);
    }
    let variants = &row["avatarUrl"]["variants"];
    let custom = variants
        .as_str()
        .and_then(|s| s.chars().next())
        .map(|c| json!(c.to_string()));
    let custom = custom
        .as_ref()
        .or_else(|| row.pointer("/avatarUrl/variants/0"))
        .filter(|v| !v.is_null());
    let mut avatar = json!({});
    for size in ["small", "medium", "large"] {
        if let Some(value) = custom.or_else(|| profile["avatar"].get(size)) {
            avatar[size] = value.clone();
        }
    }
    out["avatar"] = avatar;
    for key in ["linkedAccounts", "creationDate"] {
        if let Some(value) = row.get(key) {
            out[key] = value.clone();
        } else {
            out.as_object_mut()
                .expect("profile fields are an object")
                .shift_remove(key);
        }
    }
    Ok(())
}

pub(super) async fn me(State(s): State<AppState>, headers: HeaderMap) -> Response {
    use axum::response::IntoResponse;
    let response = current_profile(&s, &headers)
        .await
        .map(|value| common::ok(&value))
        .into_response();
    common::cache_header(response, "private, no-store")
}

async fn current_profile(s: &AppState, headers: &HeaderMap) -> Result<Value> {
    let cookie = headers
        .get(header::COOKIE)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    let session = s.session_verifier.verify_epic_session(cookie).await?;
    let id = session
        .as_ref()
        .and_then(|s| s.claims.get("epicAccountId"))
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or(message(StatusCode::UNAUTHORIZED, "Unauthorized"))?;
    let key = format!("epic-me:{id}");
    if let Some(hit) = cached(s, &key).await? {
        return Ok(hit);
    }
    let profile = s.epic.get_user(id).await?;
    let row = db_profile(s, doc! {"accountId":id}).await?;
    let profile = profile
        .filter(truthy)
        .ok_or(message(StatusCode::NOT_FOUND, "Profile not found"))?;
    let mut result = spread(&profile);
    merge_identity(&mut result, &profile, &row)?;
    save(s, &key, &result, 60).await?;
    Ok(result)
}

fn project(source: &Value, pairs: &[(&str, &str)]) -> Value {
    let mut result = json!({});
    for (from, to) in pairs {
        if let Some(v) = source.get(*from) {
            result[*to] = v.clone();
        }
    }
    result
}

async fn summary(s: &AppState, entry: Document) -> Result<Option<Value>> {
    let id = entry.get("sandboxId").cloned().unwrap_or(Bson::Null);
    let Some(sandbox) = s
        .mongo
        .find_one("sandboxes", doc! {"_id":{"$eq":&id}}, None)
        .await?
    else {
        return Ok(None);
    };
    let parent = sandbox.get("parent").cloned().unwrap_or(Bson::Null);
    let (product, offer, sets) = tokio::join!(
        one(s, "products", doc! {"_id":{"$eq":parent}}),
        one(
            s,
            "offers",
            doc! {"namespace":{"$eq":&id},"offerType":"BASE_GAME"}
        ),
        many(s, "achievementsets", doc! {"sandboxId":id.clone()})
    );
    let (product, offer, sets) = (product?, offer?, sets?);
    let (Some(_), Some(offer)) = (product, offer) else {
        return Ok(None);
    };
    let mut result = project(
        &bson_doc_to_js_json(&entry),
        &[
            ("playerAwards", "playerAwards"),
            ("totalXP", "totalXP"),
            ("totalUnlocked", "totalUnlocked"),
            ("sandboxId", "sandboxId"),
        ],
    );
    result["baseOfferForSandbox"] = project(
        &offer,
        &[
            ("id", "id"),
            ("namespace", "namespace"),
            ("keyImages", "keyImages"),
        ],
    );
    result["product"] = project(&offer, &[("title", "name"), ("productSlug", "slug")]);
    let mut total = 0;
    let mut xp = XpSum::Number(0.);
    for set in sets {
        let achievements = set["achievements"].as_array().ok_or(Error::Internal)?;
        total += achievements.len();
        let mut subtotal = XpSum::Number(0.);
        for achievement in achievements {
            if achievement.is_null() {
                return Err(Error::Internal);
            }
            subtotal.add_field(achievement.get("xp"));
        }
        xp.add(subtotal);
    }
    result["productAchievements"] = json!({"totalAchievements":total,"totalProductXP":xp.json()});
    Ok(Some(result))
}

/// Each reduction in the Node handler starts at zero. Older sets can contain
/// string experience values, which switch '+' to string concatenation.
enum XpSum {
    Number(f64),
    Text(String),
}
impl XpSum {
    fn add_field(&mut self, field: Option<&Value>) {
        if let Self::Text(text) = self {
            text.push_str(&field.map(js_string).unwrap_or_else(|| "undefined".into()));
        } else if let Some(value @ (Value::String(_) | Value::Array(_) | Value::Object(_))) = field
        {
            self.add(Self::Text(js_string(value)));
        } else {
            self.add(Self::Number(field.map(number).unwrap_or(f64::NAN)));
        }
    }
    fn add(&mut self, term: Self) {
        match self {
            Self::Number(a) => match term {
                Self::Number(b) => *a += b,
                Self::Text(b) => *self = Self::Text(format!("{}{b}", format_js_number(*a))),
            },
            Self::Text(a) => match term {
                Self::Number(b) => a.push_str(&format_js_number(b)),
                Self::Text(b) => a.push_str(&b),
            },
        }
    }
    fn json(&self) -> Value {
        match self {
            Self::Text(s) => json!(s),
            Self::Number(n) => json!(n),
        }
    }
}

async fn load_detail(s: &AppState, id: &str, key: &str) -> Result<Response> {
    let profile = s.epic.get_user(id).await?;
    let row = db_profile(s, doc! {"accountId":{"$eq":id}}).await?;
    let reviews = s
        .mongo
        .count_documents("reviews", doc! {"userId":id})
        .await?;
    let profile = profile
        .filter(truthy)
        .ok_or(message(StatusCode::NOT_FOUND, "Profile not found"))?;
    let entries = s
        .mongo
        .find_many(
            "player-achievements",
            doc! {"epicAccountId":id},
            Default::default(),
        )
        .await?;
    let mut pending = entries
        .into_iter()
        .map(|entry| summary(s, entry))
        .collect::<FuturesUnordered<_>>();
    let mut data = Vec::new();
    while let Some(item) = pending.next().await {
        if let Some(item) = item? {
            data.push(item);
        }
    }
    let mut result = spread(&profile);
    result["achievements"] =
        json!({"__typename":"AchievementsSummaryResponse","status":200,"data":data});
    merge_identity(&mut result, &profile, &row)?;
    result["reviews"] = json!(reviews);
    save(s, key, &result, 60).await?;
    Ok(ok(&result, Some(PUBLIC)))
}
fn profile_error(error: Error) -> Error {
    match error {
        Error::Internal => message(StatusCode::BAD_REQUEST, "Failed to fetch profile"),
        other => other,
    }
}
pub(super) async fn detail(State(s): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let key = format!("epic-profile:{id}:v0.3");
    if let Some(hit) = cached(&s, &key).await? {
        return Ok(ok(&hit, Some(PUBLIC)));
    }
    load_detail(&s, &id, &key).await.map_err(profile_error)
}

pub(super) async fn information(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response> {
    load_information(&s, &id).await.map_err(profile_error)
}
async fn load_information(s: &AppState, id: &str) -> Result<Response> {
    let epic_key = format!("epic-profile:{id}:epic-data");
    let profile = if let Some(hit) = cached(s, &epic_key).await? {
        hit
    } else {
        let Some(profile) = s.epic.get_user(id).await?.filter(truthy) else {
            return Err(message(StatusCode::NOT_FOUND, "Profile not found"));
        };
        save(s, &epic_key, &profile, 3600).await?;
        profile
    };
    if !truthy(&profile) {
        return Err(message(StatusCode::NOT_FOUND, "Profile not found"));
    }
    let filter = doc! {"accountId":{"$eq":id}};
    let (row, donations) = tokio::join!(
        one(s, "epic", filter.clone()),
        many(s, "key-codes", filter.clone())
    );
    let (row, donations) = (row?, donations?);
    let row = ensure_creation_date(s, filter, row).await?;
    let stats_key = format!("epic-profile:{id}:stats");
    let stats = if let Some(hit) = cached(s, &stats_key).await? {
        hit
    } else {
        let (rows, reviews) = tokio::join!(
            aggregate(s, pipelines::statistics(id), None, None),
            s.mongo.count_documents("reviews", doc! {"userId":id})
        );
        let rows = values(rows?);
        let first = rows.first().unwrap_or(&Value::Null);
        let count = |k: &str| {
            first
                .get(k)
                .filter(|v| truthy(v))
                .cloned()
                .unwrap_or(json!(0))
        };
        let awards = count("totalPlayerAwards");
        let total = count("totalXP");
        let bonus = 250. * number(&awards);
        let xp = if matches!(total, Value::String(_) | Value::Array(_) | Value::Object(_)) {
            json!(format!("{}{}", js_string(&total), format_js_number(bonus)))
        } else {
            json!(number(&total) + bonus)
        };
        let stats = json!({"totalGames":count("totalGames"),"totalAchievements":count("totalAchievements"),"totalPlayerAwards":awards,"totalXP":xp,"reviewsCount":reviews?});
        save(s, &stats_key, &stats, 300).await?;
        stats
    };
    let mut result = spread(&profile);
    result["stats"] = stats;
    merge_identity(&mut result, &profile, &row)?;
    result["donations"] = Value::Array(
        donations
            .into_iter()
            .flat_map(|d| match &d["details"] {
                Value::Array(rows) => rows.clone(),
                v => vec![v.clone()],
            })
            .collect(),
    );
    result["discord"] = json!(truthy(&row["discordId"]));
    Ok(ok(&result, Some("no-cache")))
}
