use super::*;
use axum::{body::Body, http::header};
use bson::Document;
use std::{collections::HashSet, time::Instant};

#[cfg(test)]
#[tokio::test]
async fn legacy_sandbox_http_node_oracle() {
    egdata_api_oracle::replay_legacy_oracle(include_str!(
        "../../../egdata-api/tests/fixtures/legacy-sandbox-http-node.json"
    ))
    .await
}

#[cfg(test)]
#[test]
fn virtual_asset_uses_an_object_id_for_each_platform() {
    let item = json!({"id":"i","namespace":"n","title":"Title"});
    let release = json!({"appId":"app"});
    let first = virtual_asset(&item, &release, &json!("Linux"));
    let second = virtual_asset(&item, &release, &json!("Windows"));
    let id = first["_id"].as_str().unwrap();
    assert!(bson::oid::ObjectId::parse_str(id).is_ok());
    assert_ne!(first["_id"], second["_id"]);
    assert_eq!(
        first,
        json!({"artifactId":"app","downloadSizeBytes":0,"installedSizeBytes":0,"itemId":"i","namespace":"n","platform":"Linux","_id":id,"title":"Title","__v":0,"updatedAt":"1970-01-01T00:00:00.000Z"})
    );
}

pub(super) fn routes() -> Routes {
    Routes::new("/sandboxes")
        .get("", list)
        .get("/sitemap.xml", sitemap)
        .get("/{sandboxId}", detail)
        .get("/{sandboxId}/items", item_list)
        .get("/{sandboxId}/offers", offers)
        .get("/{sandboxId}/assets", assets)
        .get("/{sandboxId}/base-game", base_game)
        .get("/{sandboxId}/achievements", achievements)
        .get("/{sandboxId}/changelog", changelog)
        .get("/{sandboxId}/builds", builds)
        .get("/{sandboxId}/stats", stats)
}

fn page(q: &HashMap<String, String>) -> Page {
    Page {
        page: integer(q.get("page"), 1),
        limit: integer(q.get("limit"), 10).map(|v| v.min(100)),
    }
}
fn param<'a>(q: &'a HashMap<String, String>, name: &str) -> &'a str {
    q.get(name).map_or("undefined", String::as_str)
}
fn page_options(p: &Page, sort: Option<Document>) -> Result<MongoFindOptions> {
    Ok(MongoFindOptions {
        sort,
        limit: p.limit,
        skip: Some(p.skip(0)?),
        ..Default::default()
    })
}
fn paginated(rows: Vec<Value>, p: &Page, count: u64) -> Value {
    json!({"elements":rows,"page":p.page,"limit":p.limit,"count":count})
}
async fn lookup(s: &AppState, id: &str) -> Result<Value> {
    one(s, "sandboxes", doc! {"_id":id})
        .await?
        .ok_or_else(|| not_found("Sandbox not found"))
}
fn elapsed(mut response: Response, kind: &str, start: Instant) -> Response {
    response.headers_mut().insert(
        "server-timing",
        format!("{kind};dur={}", start.elapsed().as_millis())
            .parse()
            .unwrap(),
    );
    response
}
async fn list(State(s): State<AppState>, uri: Uri) -> Result<Response> {
    let start = Instant::now();
    let p = page(&query(&uri));
    let key = format!("sandboxes-list:{}:v0.1", p.key());
    if let Some(hit) = cached(&s, &key).await? {
        return Ok(elapsed(ok(&hit), "cache", start));
    }
    let rows = many(
        &s,
        "namespaces",
        doc! {},
        MongoFindOptions {
            projection: Some(doc! {"_id":false,"__v":false}),
            ..page_options(&p, None)?
        },
    )
    .await?;
    let count = s.mongo.count_documents("namespaces", doc! {}).await?;
    let data = paginated(rows, &p, count);
    store(&s, &key, &data, 3600).await?;
    Ok(elapsed(ok(&data), "db", start))
}
async fn detail(State(s): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let key = format!("sandbox:{id}:v0.1");
    if let Some(hit) = cached(&s, &key).await? {
        return Ok(ok(&hit));
    }
    let data = lookup(&s, &id).await?;
    store(&s, &key, &data, 3600).await?;
    Ok(ok(&data))
}
fn filters(id: &str, q: &HashMap<String, String>, csv_fields: &[&str], platform: &str) -> Document {
    let mut filter = doc! {"namespace":id};
    for &field in csv_fields {
        if let Some(value) = q.get(field).filter(|v| !v.is_empty()) {
            filter.insert(field, doc! {"$in":value.split(',').collect::<Vec<_>>()});
        }
    }
    if let Some(value) = q.get(platform).filter(|v| !v.is_empty()) {
        filter.insert(
            "releaseInfo",
            doc! {"$elemMatch":{"platform":{"$in":value.split(',').collect::<Vec<_>>()}}},
        );
    }
    filter
}
async fn item_list(
    State(s): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
) -> Result<Response> {
    let q = query(&uri);
    let p = page(&q);
    let key = format!(
        "sandbox:{id}:items:{}:{}:{}:{}:{}",
        p.key(),
        param(&q, "entitlementType"),
        param(&q, "status"),
        param(&q, "platforms"),
        param(&q, "title")
    );
    if let Some(hit) = cached(&s, &key).await? {
        return Ok(cache_header(ok(&hit), ONE_MINUTE));
    }
    lookup(&s, &id).await?;
    let mut filter = filters(&id, &q, &["entitlementType", "status"], "platforms");
    title_filter(&mut filter, &q);
    let opts = page_options(&p, Some(doc! {"lastModified":-1}))?;
    let (count, rows) = tokio::join!(
        s.mongo.count_documents("items", filter.clone()),
        many(&s, "items", filter, opts)
    );
    let data = paginated(rows?, &p, count?);
    store(&s, &key, &data, 3600).await?;
    Ok(cache_header(ok(&data), ONE_MINUTE))
}
fn title_filter(filter: &mut Document, q: &HashMap<String, String>) {
    if let Some(title) = q.get("title").filter(|v| !v.is_empty()) {
        filter.insert("title", doc! {"$regex":title,"$options":"i"});
    }
}
async fn offers(State(s): State<AppState>, Path(id): Path<String>, uri: Uri) -> Result<Response> {
    let q = query(&uri);
    let locale = locale(&q)?;
    let p = page(&q);
    let expand = q.get("expand").is_some_and(|s| {
        matches!(
            s.trim().to_ascii_lowercase().as_str(),
            "true" | "1" | "full"
        )
    });
    let key = format!(
        "sandbox:{id}:offers:{}:{}:{}:{}:{}",
        p.key(),
        param(&q, "offerType"),
        param(&q, "title"),
        locale_cache_segment(&locale),
        if expand { "full" } else { "card" }
    );
    if let Some(hit) = cached(&s, &key).await? {
        return Ok(franchise::response(&hit));
    }
    lookup(&s, &id).await?;
    let mut filter = doc! {"namespace":&id};
    if let Some(kind) = q.get("offerType").filter(|v| !v.is_empty()) {
        filter.insert(
            "offerType",
            doc! {"$in":kind.split(',').collect::<Vec<_>>()},
        );
    }
    title_filter(&mut filter, &q);
    let opts = page_options(&p, Some(doc! {"lastModified":-1}))?;
    let (count, rows) = tokio::join!(
        s.mongo.count_documents("offers", filter.clone()),
        many(&s, "offers", filter, opts)
    );
    let (count, mut rows) = (count?, rows?);
    if !expand {
        for row in &mut rows {
            let mut card = ordered_offer(row);
            card.insert("price".into(), Value::Null);
            *row = Value::Object(card);
        }
    }
    let data = paginated(
        localize_legacy_offers(&s, &rows, &locale, !expand).await?,
        &p,
        count,
    );
    store(
        &s,
        &key,
        &data,
        get_localized_cache_ttl_seconds(&data, 3600),
    )
    .await?;
    Ok(franchise::response(&data))
}
async fn base_game(
    State(s): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Response> {
    let locale = locale(&query(&uri))?;
    let region = region(&uri, &headers)?;
    let key = format!(
        "base-game:{id}:{region}:{}:v0.1",
        locale_cache_segment(&locale)
    );
    if let Some(hit) = cached(&s, &key).await? {
        return Ok(cache_header(ok(&hit), ONE_MINUTE));
    }
    lookup(&s, &id).await?;
    let mut game=one(&s,"offers",doc!{"namespace":{"$eq":&id},"offerType":"BASE_GAME","prePurchase":{"$ne":true},"isCodeRedemptionOnly":false}).await?;
    if game.is_none() {
        game = one(
            &s,
            "offers",
            doc! {"namespace":{"$eq":&id},"offerType":"BASE_GAME","prePurchase":true},
        )
        .await?;
    }
    let data = if let Some(game) = game {
        let price = one(
            &s,
            "pricev2",
            doc! {"offerId":{"$eq":game["id"].as_str()},"region":region},
        )
        .await?;
        let mut row = ordered_offer(&game);
        row.insert("price".into(), price.unwrap_or(Value::Null));
        localize_legacy_offers(&s, &[Value::Object(row)], &locale, true)
            .await?
            .pop()
            .ok_or(Error::Internal)?
    } else {
        let mut item=one(&s,"items",doc!{"namespace":{"$eq":&id},"entitlementType":"EXECUTABLE","releaseInfo.0":{"$exists":true}}).await?.ok_or_else(||not_found("Base game not found"))?;
        item["isItem"] = true.into();
        item
    };
    store(
        &s,
        &key,
        &data,
        get_localized_cache_ttl_seconds(&data, 3600),
    )
    .await?;
    Ok(ok(&data))
}
async fn achievements(State(s): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let key = format!("sandbox:{id}:achievements:v0.1");
    if let Some(hit) = cached(&s, &key).await? {
        return Ok(ok(&hit));
    }
    lookup(&s, &id).await?;
    let data = Value::Array(
        many(
            &s,
            "achievementsets",
            doc! {"sandboxId":id},
            Default::default(),
        )
        .await?,
    );
    store(&s, &key, &data, 3600).await?;
    Ok(ok(&data))
}
fn releases(item: &Value) -> Result<&Vec<Value>> {
    item["releaseInfo"].as_array().ok_or(Error::Internal)
}
fn app_ids(items: &[Value]) -> Result<Vec<Bson>> {
    let mut ids = vec![];
    for item in items {
        for release in releases(item)? {
            ids.push(
                release["appId"]
                    .as_str()
                    .map(Bson::from)
                    .unwrap_or(Bson::Null),
            );
        }
    }
    Ok(ids)
}
async fn builds(State(s): State<AppState>, Path(id): Path<String>, uri: Uri) -> Result<Response> {
    let q = query(&uri);
    let p = page(&q);
    let key = format!(
        "sandbox:{id}:builds:v2:{}:{}",
        p.key(),
        param(&q, "platform")
    );
    if let Some(hit) = cached(&s, &key).await? {
        return Ok(ok(&hit));
    }
    lookup(&s, &id).await?;
    let items = many(
        &s,
        "items",
        filters(&id, &q, &[], "platform"),
        MongoFindOptions {
            projection: Some(doc! {"releaseInfo":1}),
            ..Default::default()
        },
    )
    .await?;
    let filter = doc! {"appName":{"$in":app_ids(&items)?}};
    let opts = page_options(&p, Some(doc! {"updatedAt":-1}))?;
    let (rows, count) = tokio::join!(
        many(&s, "builds", filter.clone(), opts),
        s.mongo.count_documents("builds", filter)
    );
    let summaries = rows?
        .iter()
        .map(|row| items::summary(row, None))
        .collect::<Result<_>>()?;
    let data = paginated(summaries, &p, count?);
    store(&s, &key, &data, 3600).await?;
    Ok(ok(&data))
}
fn each_virtual(
    items: &[Value],
    assets: &[Value],
    mut visit: impl FnMut(&Value, &Value, &Value),
) -> Result<()> {
    let actual: HashSet<_> = assets.iter().map(|v| v["artifactId"].as_str()).collect();
    for item in items {
        for release in releases(item)? {
            if !actual.contains(&release["appId"].as_str()) {
                for platform in release["platform"].as_array().ok_or(Error::Internal)? {
                    visit(item, release, platform);
                }
            }
        }
    }
    Ok(())
}
fn virtual_asset(item: &Value, release: &Value, platform: &Value) -> Value {
    let mut row = json!({});
    if let Some(id) = release.get("appId") {
        row["artifactId"] = id.clone();
    }
    row["downloadSizeBytes"] = 0.into();
    row["installedSizeBytes"] = 0.into();
    if let Some(id) = item.get("id") {
        row["itemId"] = id.clone();
    }
    if let Some(id) = item.get("namespace") {
        row["namespace"] = id.clone();
    }
    row["platform"] = platform.clone();
    row["_id"] = bson::oid::ObjectId::new().to_hex().into();
    if let Some(v) = item.get("title") {
        row["title"] = v.clone();
    }
    row["__v"] = 0.into();
    row["updatedAt"] = "1970-01-01T00:00:00.000Z".into();
    row
}
fn slice_index(value: i64, n: usize) -> usize {
    if value < 0 {
        n.saturating_sub(value.unsigned_abs() as usize)
    } else {
        n.min(value as usize)
    }
}
fn legacy_error(_: Error) -> Error {
    Error::Json(
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({"message":"Internal server error"}),
    )
}
async fn assets(State(s): State<AppState>, Path(id): Path<String>, uri: Uri) -> Result<Response> {
    let q = query(&uri);
    let p = page(&q);
    let key = format!("sandbox:{id}:assets:{}:{}", p.key(), param(&q, "platform"));
    if let Some(hit) = cached(&s, &key).await? {
        return Ok(cache_header(ok(&hit), ONE_MINUTE));
    }
    lookup(&s, &id).await?;
    async {
        let filter = doc! {"namespace":&id};
        let items = many(
            &s,
            "items",
            filter.clone(),
            MongoFindOptions {
                projection: Some(doc! {"id":1,"namespace":1,"releaseInfo":1,"title":1}),
                ..Default::default()
            },
        )
        .await?;
        let opts = MongoFindOptions {
            sort: Some(doc! {"updatedAt":-1}),
            ..Default::default()
        };
        let (rows, count) = tokio::join!(
            many(&s, "assets", filter.clone(), opts),
            s.mongo.count_documents("assets", filter)
        );
        count?;
        let mut rows = rows?;
        let mut virtuals = vec![];
        each_virtual(&items, &rows, |item, release, platform| {
            virtuals.push(virtual_asset(item, release, platform))
        })?;
        rows.extend(virtuals);
        rows.sort_by(|a, b| {
            let time = |row: &Value| {
                row["updatedAt"]
                    .as_str()
                    .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
                    .map_or(0, |v| v.timestamp_millis())
            };
            time(b).cmp(&time(a))
        });
        if let Some(platform) = q.get("platform").filter(|v| !v.is_empty()) {
            rows.retain(|row| platform.split(',').any(|p| row["platform"] == p));
        }
        let n = rows.len();
        let skip = p.page.zip(p.limit).map_or(0, |(page, limit)| {
            page.saturating_sub(1).saturating_mul(limit)
        });
        let start = slice_index(skip, n);
        let end = slice_index(
            if p.page.is_some() {
                skip.saturating_add(p.limit.unwrap_or_default())
            } else {
                0
            },
            n,
        );
        let data = paginated(
            rows.into_iter()
                .skip(start)
                .take(end.saturating_sub(start))
                .collect(),
            &p,
            n as u64,
        );
        store(&s, &key, &data, 3600).await?;
        Ok(cache_header(ok(&data), ONE_MINUTE))
    }
    .await
    .map_err(legacy_error)
}
async fn stats(State(s): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let key = format!("sandbox:{id}:stats:v0.1");
    if let Some(hit) = cached(&s, &key).await? {
        return Ok(ok(&hit));
    }
    one(&s, "sandboxes", doc! {"_id":{"$eq":&id}})
        .await?
        .ok_or_else(|| not_found("Sandbox not found"))?;
    let filter = doc! {"namespace":&id};
    let (offers, items, sets, assets) = tokio::join!(
        s.mongo.count_documents("offers", filter.clone()),
        many(&s, "items", filter.clone(), Default::default()),
        many(
            &s,
            "achievementsets",
            doc! {"sandboxId":id},
            Default::default()
        ),
        many(&s, "assets", filter, Default::default())
    );
    let (offers, items, sets, assets) = (offers?, items?, sets?, assets?);
    let mut count = assets.len();
    each_virtual(&items, &assets, |_, _, _| count += 1)?;
    let builds = many(
        &s,
        "builds",
        doc! {"appName":{"$in":app_ids(&items)?}},
        Default::default(),
    )
    .await?;
    let achievements: usize = sets
        .iter()
        .map(|row| row["achievements"].as_array().map_or(1, Vec::len))
        .sum();
    let data = json!({"offers":offers,"items":items.len(),"assets":count,"builds":builds.len(),"achievements":achievements});
    store(&s, &key, &data, 3600).await?;
    Ok(ok(&data))
}
async fn changelog(
    State(s): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
) -> Result<Response> {
    let p = Page::new(&query(&uri), 10, 50);
    let key = format!("changelog:{id}:{}", p.key());
    if let Some(hit) = cached(&s, &key).await? {
        return Ok(cache_header(ok(&hit), ONE_MINUTE));
    }
    async {
        if one(&s, "sandboxes", doc! {"_id":{"$eq":&id}})
            .await?
            .is_none()
        {
            return Ok(crate::json_response(
                StatusCode::NOT_FOUND,
                &json!({"error":"Sandbox not found"}),
            ));
        }
        let opts = MongoFindOptions {
            sort: Some(doc! {"lastModifiedDate":-1}),
            limit: Some(100),
            ..Default::default()
        };
        let offers = many(&s, "offers", doc! {"namespace":&id}, opts.clone()).await?;
        let mut offer_items = vec![];
        for offer in &offers {
            for item in offer["items"].as_array().ok_or(Error::Internal)? {
                offer_items.push(item["id"].as_str());
            }
        }
        let items = many(
            &s,
            "items",
            doc! {"$or":[{"id":{"$in":offer_items}},{"namespace":&id}]},
            MongoFindOptions {
                projection: Some(doc! {"id":1,"namespace":1,"releaseInfo":1}),
                ..opts
            },
        )
        .await?;
        let item_ids = items
            .iter()
            .filter_map(|row| row["id"].as_str())
            .collect::<Vec<_>>();
        let assets = many(
            &s,
            "assets",
            doc! {"itemId":{"$in":&item_ids}},
            Default::default(),
        )
        .await?;
        let builds = many(
            &s,
            "builds",
            doc! {"appName":{"$in":app_ids(&items)?}},
            Default::default(),
        )
        .await?;
        let build_ids = builds
            .iter()
            .map(|build| {
                build
                    .get("_id")
                    .filter(|id| !id.is_null())
                    .map(egdata_core::v1::serialization::js_string)
                    .ok_or(Error::Internal)
            })
            .collect::<Result<Vec<_>>>()?;
        let ids = std::iter::once(id.as_str())
            .chain(offers.iter().filter_map(|v| v["id"].as_str()))
            .chain(item_ids)
            .chain(assets.iter().filter_map(|v| v["artifactId"].as_str()))
            .chain(build_ids.iter().map(String::as_str))
            .collect::<Vec<_>>();
        let hits = s
            .mongo
            .aggregate("changelogs_v2", items::changelog_pipeline(&ids, &p, true)?)
            .await?
            .iter()
            .map(bson_doc_to_js_json)
            .collect::<Vec<_>>();
        let count = s
            .mongo
            .count_documents("changelogs_v2", doc! {"metadata.contextId":{"$in":ids}})
            .await?;
        let data =
            json!({"hits":hits,"estimatedTotalHits":count,"limit":p.limit,"offset":p.skip(0)?});
        store(&s, &key, &data, 60).await?;
        Ok(cache_header(ok(&data), ONE_MINUTE))
    }
    .await
    .map_err(legacy_error)
}
async fn sitemap(State(s): State<AppState>, uri: Uri) -> Result<Response> {
    let q = query(&uri);
    let body = if let Some(page) = q.get("page").filter(|v| !v.is_empty()) {
        let p = Page {
            page: integer(Some(page), 1),
            limit: Some(1000),
        };
        let rows = s
            .mongo
            .find_many(
                "sandboxes",
                doc! {},
                page_options(&p, Some(doc! {"lastModified":-1}))?,
            )
            .await?;
        let mut entries = vec![];
        for row in rows {
            let id = row
                .get("_id")
                .map(bson_to_js_json)
                .map(|v| egdata_core::v1::serialization::js_string(&v))
                .unwrap_or_else(|| "undefined".into());
            let date = egdata_infra::bson_json::bson_datetime_to_iso_string(
                *row.get_datetime("updated").map_err(|_| Error::Internal)?,
            )
            .ok_or(Error::Internal)?;
            let url = format!("https://egdata.app/sandboxes/{id}");
            let sections=["/items","/offers","/assets","/achievements"].map(|section|format!("\n            <url>\n              <loc>{url}{section}</loc>\n              <lastmod>{date}</lastmod>\n            </url>\n            ")).join("\n");
            entries.push(format!("<url>\n            <loc>{url}</loc>\n            <lastmod>{date}</lastmod>\n            </url>\n            {sections}\n            "));
        }
        format!(
            "  <urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n    {}\n  </urlset>",
            entries.join("\n")
        )
    } else {
        let count = s.mongo.count_documents("sandboxes", doc! {}).await?;
        let entries=(1..=count.div_ceil(1000)).map(|n|format!("<sitemap><loc>https://api.egdata.app/sandboxes/sitemap.xml?page={n}</loc></sitemap>")).collect::<String>();
        format!(
            "<sitemapindex xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n  {entries}\n</sitemapindex>"
        )
    };
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, "application/xml")
        .body(Body::from(format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n{body}"
        )))
        .unwrap())
}
