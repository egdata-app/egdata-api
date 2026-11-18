use super::*;
use crate::v1::system::js_truthy;
use egdata_core::v1::{serialization::js_string, trim_js_whitespace};
use std::collections::HashSet;

pub(super) fn response(value: &Value) -> Response {
    let mut r = cache_header(
        ok(value),
        "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
    );
    r.headers_mut().insert(
        "cdn-cache-control",
        "public, max-age=300, stale-while-revalidate=3600"
            .parse()
            .unwrap(),
    );
    r
}
// The legacy route uses JavaScript '+' for persisted IGDB and XP values.
fn sum(total: &mut Value, add: Option<&Value>) {
    let zero = json!(0);
    let add = add.filter(|v| js_truthy(v)).unwrap_or(&zero);
    if total.is_string() || add.is_string() || add.is_array() || add.is_object() {
        *total = json!(format!("{}{}", js_string(total), js_string(add)));
    } else {
        *total = json!(
            total.as_f64().unwrap_or_default() + crate::v1::system::js_number_or_zero(Some(add))
        );
    }
}
pub(super) async fn detail(
    State(s): State<AppState>,
    Path(slug): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Response> {
    let q = query(&uri);
    let locale = locale(&q)?;
    let region = region(&uri, &headers)?;
    let page = Page::new(&q, 20, 50);
    let expand = q.get("expand").is_some_and(|s| {
        matches!(
            trim_js_whitespace(s).to_ascii_lowercase().as_str(),
            "true" | "1" | "full"
        )
    });
    let key = format!(
        "franchises:{slug}:{region}:{}:{}:{}:v0.1",
        page.key(),
        locale_cache_segment(&locale),
        if expand { "full" } else { "card" }
    );
    let start = (s.now)();
    if let Some(hit) = cached(&s, &key).await? {
        return Ok(response(&hit));
    }
    let filter = match bson::oid::ObjectId::parse_str(&slug) {
        Ok(id) => doc! {"$or":[{"_id":id},{"_id":{"$eq":&slug}}]},
        Err(_) => doc! {"_id":{"$eq":&slug}},
    };
    let franchise = s
        .mongo
        .find_one("franchises", filter, None)
        .await?
        .ok_or_else(|| not_found("Franchise not found"))?;
    let ids = franchise
        .get("offers")
        .filter(|v| js_truthy(&bson_to_js_json(v)))
        .cloned()
        .unwrap_or_else(|| Bson::Array(Vec::new()));
    let total = match &ids {
        Bson::Array(ids) => Some(json!(ids.len())),
        Bson::String(ids) => Some(json!(ids.encode_utf16().count())),
        Bson::Document(doc) => doc.get("length").map(bson_to_js_json),
        _ => None,
    };
    let has_offers = !total.as_ref().is_some_and(|v| v.as_f64() == Some(0.0));
    let franchise = bson_doc_to_js_json(&franchise);
    let mut result = json!({});
    for (key, field) in [
        ("id", "_id"),
        ("name", "name"),
        ("lastUpdated", "lastUpdated"),
    ] {
        if let Some(v) = franchise.get(field) {
            result[key] = v.clone();
        }
    }
    let mut stats = json!({"totalTimeHastily":0,"totalTimeNormally":0,"totalTimeCompletely":0,"totalAchievements":0,"totalXp":0,"gamesCount":0});
    let mut elements = vec![];
    if has_offers {
        let filter = doc! {"id":{"$in":&ids}};
        let offers = s
            .mongo
            .find_many(
                "offers",
                filter.clone(),
                MongoFindOptions {
                    limit: page.limit,
                    skip: Some(page.skip(0)?),
                    sort: Some(doc! {"releaseDate":-1}),
                    ..Default::default()
                },
            )
            .await?;
        let basic = s
            .mongo
            .find_many(
                "offers",
                filter,
                MongoFindOptions {
                    projection: Some(doc! {"id":1,"namespace":1}),
                    ..Default::default()
                },
            )
            .await?;
        let mut seen = HashSet::new();
        let namespaces = basic
            .iter()
            .filter_map(|row| row.get("namespace"))
            .filter(|id| {
                js_truthy(&bson_to_js_json(id))
                    && primitive_id(Some(id)).is_none_or(|key| seen.insert(key))
            })
            .cloned()
            .collect::<Vec<_>>();
        let ns_count = namespaces.len();
        let page_ids = field_values(&offers, "id");
        let prices = s
            .mongo
            .find_many(
                "pricev2",
                doc! {"offerId":{"$in":page_ids},"region":region},
                Default::default(),
            )
            .await?;
        elements = offer_rows(&s, &offers, &locale, Some(&price_map(&prices))).await?;
        let sets = many(
            &s,
            "achievementsets",
            doc! {"sandboxId":{"$in":namespaces},"isBase":true},
            Default::default(),
        )
        .await?;
        let mut n = 0;
        for set in &sets {
            let mut xp = json!(0);
            if let Some(achievements) = set.get("achievements").filter(|v| !v.is_null()) {
                for achievement in achievements.as_array().ok_or(Error::Internal)? {
                    if achievement.is_null() {
                        return Err(Error::Internal);
                    }
                    n += 1;
                    sum(&mut xp, achievement.get("xp"));
                }
            }
            sum(&mut stats["totalXp"], Some(&xp));
        }
        stats["totalAchievements"] = json!(n);
        let entries = s
            .mongo
            .find_many("igdbs", doc! {"offerId":{"$in":&ids}}, Default::default())
            .await?;
        let mut unique = HashSet::new();
        let mut count = 0;
        for entry in &entries {
            let Some(id) = entry.get("igdbId") else {
                continue;
            };
            let row = bson_doc_to_js_json(entry);
            if !js_truthy(&bson_to_js_json(id))
                || !js_truthy(&row["timeToBeat"])
                || primitive_id(Some(id)).is_some_and(|key| !unique.insert(key))
            {
                continue;
            }
            count += 1;
            for (key, field) in [
                ("totalTimeHastily", "hastily"),
                ("totalTimeNormally", "normally"),
                ("totalTimeCompletely", "completely"),
            ] {
                sum(&mut stats[key], row["timeToBeat"].get(field));
            }
        }
        stats["gamesCount"] = json!(if count == 0 { ns_count } else { count });
    }
    result["elements"] = Value::Array(elements);
    result["stats"] = stats;
    result["page"] = json!(page.page);
    result["limit"] = json!(page.limit);
    if let Some(total) = total {
        result["total"] = total;
    }
    let mut resp = response(&result);
    if has_offers {
        store(
            &s,
            &key,
            &result,
            get_localized_cache_ttl_seconds(&result, 3600),
        )
        .await?;
        resp.headers_mut().insert(
            "server-timing",
            format!("db;dur={}", ((s.now)() - start).num_milliseconds())
                .parse()
                .unwrap(),
        );
    }
    Ok(resp)
}
