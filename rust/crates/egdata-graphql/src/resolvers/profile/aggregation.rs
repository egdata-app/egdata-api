//! Reconcile duplicate player achievement rows by sandbox before enriching them
//! with the current catalog offer and achievement definitions.
use super::{GraphqlServices, Result, Value, array, js_truthy, json, number, numeric};
use async_graphql::indexmap::IndexMap;
use bson::doc;
use egdata_core::{
    catalog::node_collator, ports::MongoFindOptions, v1::serialization::iso_or_null,
};
use std::{cmp::Ordering, collections::HashMap};

#[derive(Default)]
struct PlayerGame {
    unlocked: f64,
    xp: f64,
    awards: IndexMap<String, Value>,
    achievements: IndexMap<String, Value>,
}

fn string(v: &Value) -> String {
    if v.is_null() {
        String::new()
    } else {
        egdata_core::v1::serialization::js_string(v)
    }
}
fn time(v: &Value) -> i64 {
    if let Some(n) = v.as_i64() {
        return n;
    }
    iso_or_null(v)
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok())
        .map_or(0, |dt| dt.timestamp_millis())
}
fn stable_key(v: &Value, fields: &[&str]) -> String {
    fields
        .iter()
        .map(|field| string(&v[field]))
        .collect::<Vec<_>>()
        .join(":")
}

fn normalize(rows: &[Value]) -> IndexMap<String, PlayerGame> {
    let mut games: IndexMap<String, PlayerGame> = IndexMap::new();
    for row in rows {
        let sandbox = string(&row["sandboxId"]);
        if sandbox.is_empty() {
            continue;
        }
        let game = games.entry(sandbox).or_default();
        game.unlocked = game.unlocked.max(number(&row["totalUnlocked"]));
        game.xp = game.xp.max(number(&row["totalXP"]));
        for award in array(&row["playerAwards"]) {
            let key = stable_key(
                award,
                &["awardType", "achievementSetId", "unlockedDateTime"],
            );
            game.awards.insert(key, award.clone());
        }
        for recorded in array(&row["playerAchievements"]) {
            let next = &recorded["playerAchievement"];
            let key = stable_key(next, &["sandboxId", "achievementSetId", "achievementName"]);
            if let Some(old) = game.achievements.get_mut(&key) {
                let unlocked = js_truthy(&old["unlocked"]) || js_truthy(&next["unlocked"]);
                let latest = if time(&old["unlockDate"]) >= time(&next["unlockDate"]) {
                    old["unlockDate"].clone()
                } else {
                    next["unlockDate"].clone()
                };
                let xp = number(&old["XP"]).max(number(&next["XP"]));
                let mut combined = old.as_object().cloned().unwrap_or_default();
                if let Some(next) = next.as_object() {
                    combined.extend(next.clone());
                }
                combined.insert("unlocked".into(), json!(unlocked));
                combined.insert("unlockDate".into(), latest);
                combined.insert("XP".into(), numeric(xp));
                *old = Value::Object(combined);
            } else {
                game.achievements.insert(key, next.clone());
            }
        }
    }
    games
}

fn group(rows: &[Value]) -> HashMap<String, Vec<&Value>> {
    let mut groups = HashMap::<String, Vec<&Value>>::new();
    for row in rows {
        let id = string(
            row.get("sandboxId")
                .filter(|s| !s.is_null())
                .unwrap_or(&row["namespace"]),
        );
        if !id.is_empty() {
            groups.entry(id).or_default().push(row);
        }
    }
    groups
}

fn base_offer<'a>(offers: &[&'a Value]) -> Option<&'a Value> {
    let collator = node_collator();
    offers.iter().copied().min_by(|a, b| {
        js_truthy(&b["isDisplayable"])
            .cmp(&js_truthy(&a["isDisplayable"]))
            .then_with(|| collator.compare(&string(&a["title"]), &string(&b["title"])))
            .then_with(|| time(&b["lastModifiedDate"]).cmp(&time(&a["lastModifiedDate"])))
    })
}

fn image(offer: &Value) -> &Value {
    let images = array(&offer["keyImages"]);
    [
        "DieselStoreFrontWide",
        "OfferImageWide",
        "Thumbnail",
        "DieselGameBoxWide",
        "DieselStoreFrontTall",
        "OfferImageTall",
    ]
    .iter()
    .find_map(|kind| images.iter().find(|i| i["type"] == *kind))
    .or_else(|| images.first())
    .map(|i| &i["url"])
    .unwrap_or(&Value::Null)
}

fn first_string<'a>(row: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| row[key].as_str().filter(|s| !s.trim().is_empty()))
}
fn xp(row: &Value) -> f64 {
    ["xp", "XP", "score"]
        .iter()
        .find_map(|k| row.get(k).filter(|v| !v.is_null()))
        .map(number)
        .filter(|n| n.is_finite())
        .unwrap_or(0.)
}
fn percent(n: f64) -> Value {
    // toFixed(2) rounds the exact binary float; ties go up for positive values.
    let n = n.clamp(0., 100.);
    let rounded = if (n * 8.).fract() == 0. && (n * 4.).fract() != 0. {
        (n * 100.).round() / 100.
    } else {
        format!("{n:.2}").parse::<f64>().unwrap_or(0.)
    };
    numeric(rounded)
}
fn rarity(row: &Value) -> Value {
    let n = row.get("completedPercent").map_or(f64::NAN, number);
    percent(if !n.is_finite() {
        100.
    } else if n > 0. && n <= 1. {
        n * 100.
    } else {
        n
    })
}
fn achievement(def: &Value, unlock: &Value, sandbox: &str, title: &Value) -> Value {
    json!({
        "name":def.get("name").filter(|n|!n.is_null()).unwrap_or(&unlock["achievementName"]),
        "displayName":first_string(def,&["unlockedDisplayName","displayName","title","lockedDisplayName","name"]).unwrap_or("Unknown achievement"),
        "description":first_string(def,&["unlockedDescription","description","lockedDescription","flavorText"]),
        "iconUrl":first_string(def,&["unlockedIconLink","unlockedIcon","iconUrl","icon","iconLink","lockedIconLink","lockedIcon"]),
        "rarityPercent":rarity(def),"xp":numeric(xp(def)),"sandboxId":sandbox,"gameTitle":title,"unlockedAt":unlock["unlockDate"]
    })
}
fn by_rarity(a: &Value, b: &Value) -> Ordering {
    number(&a["rarityPercent"])
        .total_cmp(&number(&b["rarityPercent"]))
        .then_with(|| number(&b["xp"]).total_cmp(&number(&a["xp"])))
        .then_with(|| time(&b["unlockedAt"]).cmp(&time(&a["unlockedAt"])))
}

pub(super) async fn load(s: &GraphqlServices, id: &str) -> Result<Value> {
    s.profile_cache.memo(format!("profile:{id}:aggregation"),async {
        let rows=s.rows("player-achievements",doc!{"epicAccountId":{"$eq":id}},MongoFindOptions::default()).await?;
        let player_games=normalize(&rows);
        if player_games.is_empty(){return Ok(json!({"games":[],"achievements":[],"activity":[]}));}
        let ids=player_games.keys().cloned().collect::<Vec<_>>();
        let (offers,sets)=tokio::try_join!(
            s.rows("offers",doc!{"namespace":{"$in":&ids},"offerType":"BASE_GAME","isCodeRedemptionOnly":false},MongoFindOptions::default()),
            s.rows("achievementsets",doc!{"sandboxId":{"$in":ids}},MongoFindOptions::default())
        )?;
        let by_offer=group(&offers);
        let by_set=group(&sets);
        let mut games=Vec::new();
        let mut achievements=Vec::new();
        let mut activity=Vec::new();
        for (id,g) in player_games{
            let offer=base_offer(by_offer.get(&id).map(Vec::as_slice).unwrap_or_default()).unwrap_or(&Value::Null);
            let title=offer.get("title").filter(|v|!v.is_null()).or_else(||offer.pointer("/product/name").filter(|v|!v.is_null())).cloned().unwrap_or_else(||json!(id));
            let sets=by_set.get(&id).map(Vec::as_slice).unwrap_or_default();
            let total=sets.iter().map(|set|array(&set["achievements"]).len()).sum::<usize>();
            let total_xp=sets.iter().flat_map(|set|array(&set["achievements"])).map(xp).sum::<f64>();
            let mut unlocked=Vec::new();
            for unlock in g.achievements.values().filter(|a|js_truthy(&a["unlocked"])&&js_truthy(&a["achievementName"])) {
                let def=sets.iter().filter(|set|!js_truthy(&unlock["achievementSetId"])||!js_truthy(&set["achievementSetId"])||set["achievementSetId"]==unlock["achievementSetId"])
                    .find_map(|set|array(&set["achievements"]).iter().find(|a|a["name"]==unlock["achievementName"]));
                if let Some(def)=def {unlocked.push(achievement(def,unlock,&id,&title));}
            }
            unlocked.sort_by(by_rarity);
            for a in unlocked.iter().filter(|a|js_truthy(&a["unlockedAt"])) {
                activity.push(json!({"type":"ACHIEVEMENT_UNLOCKED","sandboxId":id,"gameTitle":title,"achievementName":a["displayName"],"achievementIconUrl":a["iconUrl"],"occurredAt":a["unlockedAt"]}));
            }
            for a in g.awards.values().filter(|a|js_truthy(&a["unlockedDateTime"])) {
                activity.push(json!({"type":"PLATINUM_EARNED","sandboxId":id,"gameTitle":title,"achievementName":null,"achievementIconUrl":null,"occurredAt":a["unlockedDateTime"]}));
            }
            games.push(json!({"sandboxId":id,"title":title,"imageUrl":image(offer),
                "completionPercent":percent(if total==0{0.}else{g.unlocked/total as f64*100.}),
                "unlocked":numeric(g.unlocked),"total":total,"earnedXP":numeric(g.xp),"totalXP":numeric(total_xp),
                "hasPlatinum":!g.awards.is_empty(),"platinumCount":g.awards.len(),"rarestAchievements":&unlocked[..unlocked.len().min(3)]}));
            achievements.extend(unlocked);
        }
        achievements.sort_by(by_rarity);
        activity.sort_by_key(|a|std::cmp::Reverse(time(&a["occurredAt"])));
        Ok(json!({"games":games,"achievements":achievements,"activity":activity}))
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_entries_without_details_coalesce_and_offer_ties_use_the_latest_date() {
        let normalized = normalize(&[json!({"sandboxId":"a","playerAchievements":[{},{}]})]);
        let game = &normalized["a"];
        assert_eq!(game.achievements.len(), 1);
        assert_eq!(game.achievements.first().unwrap().1["unlocked"], false);
        let newer = json!({"title":"Game","lastModifiedDate":"2021-01-01"});
        let older = json!({"title":"Game","lastModifiedDate":"2020-01-01"});
        let later_name = json!({"title":"Zoo"});
        assert_eq!(base_offer(&[&older, &later_name, &newer]), Some(&newer));
    }
}
