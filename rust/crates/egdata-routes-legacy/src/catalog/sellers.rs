use super::*;
use bson::Document;

pub(super) async fn list(State(s): State<AppState>) -> Result<Response> {
    let result = s.mongo.distinct("offers", "seller", doc! {}).await?;
    Ok(ok(&Value::Array(
        result.iter().map(bson_to_js_json).collect(),
    )))
}
pub(super) async fn offers(
    State(s): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Response> {
    let q = query(&uri);
    let locale = locale(&q)?;
    let region = region(&uri, &headers)?;
    let p = Page::new(&q, 0, i64::MAX);
    let ignored = q.get("ignoredSandboxes").map(String::as_str).unwrap_or("");
    let kind = q.get("offerType");
    let key = format!(
        "sellers:{id}:{region}:{}:{}:{ignored}:{}",
        p.key(),
        kind.map_or("undefined", String::as_str),
        locale_cache_segment(&locale)
    );
    if let Some(value) = cached(&s, &key).await? {
        return Ok(cache_header(ok(&value), ONE_MINUTE));
    }
    let mut filter =
        doc! {"seller.id":&id,"namespace":{"$nin":ignored.split(',').collect::<Vec<_>>()}};
    if let Some(k) = kind.filter(|v| !v.is_empty()) {
        filter.insert("offerType", k);
    }
    let rows = many(
        &s,
        "offers",
        filter,
        MongoFindOptions {
            sort: Some(doc! {"lastModifiedDate":-1}),
            limit: p.limit.filter(|v| *v != 0),
            skip: Some(p.skip(1)?),
            ..Default::default()
        },
    )
    .await?;
    let result = Value::Array(priced_offers(&s, &rows, region, &locale, false).await?);
    store(
        &s,
        &key,
        &result,
        get_localized_cache_ttl_seconds(&result, 3600),
    )
    .await?;
    Ok(ok(&result))
}
pub(super) async fn cover(
    State(s): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Response> {
    let q = query(&uri);
    let locale = locale(&q)?;
    let region = region(&uri, &headers)?;
    let key = format!(
        "sellers:{id}:cover:{region}:{}",
        locale_cache_segment(&locale)
    );
    if let Some(value) = cached(&s, &key).await? {
        return Ok(cache_header(ok(&value), ONE_MINUTE));
    }
    let top = many(
        &s,
        "game_positions",
        doc! {"collectionId":"top-sellers","position":{"$gt":0}},
        Default::default(),
    )
    .await?;
    let ids = top
        .iter()
        .filter_map(|v| v["offerId"].as_str())
        .collect::<Vec<_>>();
    let sort = MongoFindOptions {
        sort: Some(doc! {"lastModifiedDate":-1}),
        ..Default::default()
    };
    let mut rows = many(
        &s,
        "offers",
        doc! {"id":{"$in":ids},"seller.id":&id},
        sort.clone(),
    )
    .await?;
    if rows.is_empty() {
        rows = many(
            &s,
            "offers",
            doc! {"seller.id":id},
            MongoFindOptions {
                limit: Some(5),
                ..sort
            },
        )
        .await?;
    } else {
        rows.truncate(5);
    }
    let result = Value::Array(priced_offers(&s, &rows, region, &locale, false).await?);
    store(
        &s,
        &key,
        &result,
        get_localized_cache_ttl_seconds(&result, 3600),
    )
    .await?;
    Ok(ok(&result))
}
async fn free_count(s: &AppState, collection: &str, key: &str, id: &str) -> Result<i64> {
    let result=s.mongo.aggregate_with_options(collection,vec![
        doc!{"$lookup":{"from":"offers","localField":key,"foreignField":"id","as":"offer"}},
        doc!{"$unwind":"$offer"},doc!{"$match":{"offer.seller.id":id}},
        doc!{"$group":{"_id":format!("${key}")}},doc!{"$count":"count"}
    ],egdata_core::ports::MongoAggregateOptions{allow_disk_use:Some(true),..Default::default()}).await?;
    Ok(count(&result))
}
fn count(docs: &[Document]) -> i64 {
    docs.first()
        .map(bson_doc_to_js_json)
        .and_then(|v| v["count"].as_i64())
        .unwrap_or_default()
}
pub(super) async fn stats(State(s): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let key = format!("sellers:{id}:stats:v1.1");
    if let Some(hit) = cached(&s, &key).await? {
        return Ok(cache_header(ok(&hit), ONE_MINUTE));
    }
    let seller = one(&s, "sellers", doc! {"_id":&id})
        .await?
        .ok_or_else(|| not_found("Seller not found"))?;
    let (offers, items, games) = tokio::try_join!(
        s.mongo.count_documents("offers", doc! {"seller.id":&id}),
        s.mongo.count_documents("items", doc! {"developerId":&id}),
        s.mongo.aggregate(
            "offers",
            vec![
                doc! {"$match":{"seller.id":&id,"offerType":"BASE_GAME"}},
                doc! {"$sort":{"lastModifiedDate":-1}},
                doc! {"$group":{"_id":"$namespace","offer":{"$first":"$$ROOT"}}},
                doc! {"$replaceRoot":{"newRoot":"$offer"}},
                doc! {"$count":"count"}
            ]
        )
    )?;
    let desktop = free_count(&s, "freegames", "id", &id).await?;
    let mobile = free_count(&s, "mobile-freebies", "offerId", &id).await?;
    let value = json!({"offers":offers,"items":items,"games":count(&games),"freegames":desktop+mobile,"seller":seller});
    store(&s, &key, &value, 3600).await?;
    Ok(ok(&value))
}
