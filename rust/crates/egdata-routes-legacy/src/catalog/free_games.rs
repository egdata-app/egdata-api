use super::*;

#[cfg(test)]
#[tokio::test]
async fn legacy_free_games_http_node_oracle() {
    egdata_api_oracle::replay_legacy_oracle(include_str!(
        "../../../egdata-api/tests/fixtures/legacy-free-games-http-node.json"
    ))
    .await
}
use egdata_http_core::shared::free_games::{
    free_sellers_pipeline, normalize_blacklist, normalized_giveaway, string_property,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use egdata_core::ports::MongoAggregateOptions;
use futures::future::try_join_all;
use std::{collections::HashSet, time::Instant};

pub(super) fn routes() -> Routes {
    Routes::new("/free-games")
        .get("", current)
        .get("/history", history)
        .get("/stats", stats)
        .get("/search", search)
        .get("/mobile", mobile)
        .get("/sellers", sellers)
}
fn expanded(q: &HashMap<String, String>) -> bool {
    q.get("expand").is_some_and(|s| {
        matches!(
            egdata_core::v1::trim_js_whitespace(s)
                .to_ascii_lowercase()
                .as_str(),
            "true" | "1" | "full"
        )
    })
}
fn offer_shape(offer: &Value, normalize: bool, price: Option<&Value>) -> Value {
    let mut out = offer.clone();
    if normalize {
        out["countriesBlacklist"] = normalize_blacklist(&offer["countriesBlacklist"]);
    }
    let mut out = Value::Object(ordered_offer(&out));
    if let Some(p) = price {
        out["price"] = p.clone();
    }
    out
}
async fn localized(s: &AppState, row: Value, locale: &str) -> Result<Value> {
    localize_legacy_offers(s, &[row], locale, true)
        .await?
        .pop()
        .ok_or(Error::Internal)
}
fn bson_field(row: &Value, field: &str) -> Bson {
    bson::to_bson(&row[field]).unwrap_or(Bson::Null)
}

fn member_ids(row: &Value, field: &str) -> Result<Vec<Bson>> {
    row[field]
        .as_array()
        .ok_or(Error::Internal)?
        .iter()
        .map(|item| {
            if item.is_null() {
                Err(Error::Internal)
            } else {
                Ok(bson_field(item, "id"))
            }
        })
        .collect()
}

// Independent Mongo documents cannot share a JavaScript object reference.
fn same_id(left: Option<&Value>, right: Option<&Value>) -> bool {
    !matches!(left, Some(Value::Object(_) | Value::Array(_))) && left == right
}
async fn current_entry(
    s: &AppState,
    game: Value,
    mobile: bool,
    region: &str,
    locale: &str,
    expand: bool,
) -> Result<Value> {
    let id = game[if mobile { "offerId" } else { "id" }]
        .as_str()
        .unwrap_or_default();
    let history = async {
        if mobile {
            one(s, "mobile-freebies", doc! {"offerId":id})
                .await
                .map(|v| v.unwrap_or_default())
        } else {
            many(s, "freegames", doc! {"id":id}, Default::default())
                .await
                .map(Value::Array)
        }
    };
    let (offer, price, hist) = tokio::join!(
        one(s, "offers", doc! {"id":id}),
        one(s, "pricev2", doc! {"offerId":id,"region":region}),
        history
    );
    let giveaway = normalized_giveaway(&game, id, Some(hist.unwrap_or_default()));
    let Some(offer) = offer.unwrap_or_default() else {
        return Ok(json!({"giveaway":giveaway}));
    };
    let price = price.unwrap_or_default().unwrap_or_default();
    let offer_id = bson_field(&offer, "id");
    let mut ids = member_ids(&offer, "items")?;
    let sub = many(
        s,
        "offersubitems",
        doc! {"_id":&offer_id},
        MongoFindOptions {
            projection: Some(doc! {"subItems":1}),
            ..Default::default()
        },
    )
    .await?;
    for row in &sub {
        ids.extend(member_ids(row, "subItems")?);
    }
    let items = many(
        s,
        "items",
        doc! {"$or":[{"id":{"$in":ids}},{"linkedOffers":offer_id}]},
        Default::default(),
    )
    .await?;
    let mut out = localized(
        s,
        offer_shape(&offer, true, (!expand).then_some(&price)),
        locale,
    )
    .await?;
    out["items"] = items.into();
    out["giveaway"] = giveaway;
    out["price"] = price;
    Ok(out)
}
async fn current(State(s): State<AppState>, uri: Uri, headers: HeaderMap) -> Result<Response> {
    let q = query(&uri);
    let locale = locale(&q)?;
    let region = region(&uri, &headers)?;
    let expand = expanded(&q);
    let filter = doc! {"endDate":{"$gte":bson::DateTime::from_chrono((s.now)())}};
    let opts = MongoFindOptions {
        sort: Some(doc! {"endDate":1}),
        ..Default::default()
    };
    let (mobile, desktop) = tokio::join!(
        many(&s, "mobile-freebies", filter.clone(), opts.clone()),
        many(&s, "freegames", filter, opts)
    );
    let jobs = desktop
        .unwrap_or_default()
        .into_iter()
        .map(|g| (g, false))
        .chain(mobile.unwrap_or_default().into_iter().map(|g| (g, true)));
    let rows =
        try_join_all(jobs.map(|(g, m)| current_entry(&s, g, m, region, &locale, expand))).await?;
    Ok(franchise::response(&Value::Array(rows)))
}
async fn history_inputs(
    s: &AppState,
    region: &str,
    page: Option<&Page>,
) -> Result<(Vec<Value>, Vec<Value>, Vec<Value>)> {
    let mut opts = MongoFindOptions {
        sort: Some(doc! {"endDate":-1}),
        ..Default::default()
    };
    if let Some(p) = page {
        opts.skip = Some(p.skip(0)?);
        opts.limit = p.limit;
    }
    let games = many(s, "freegames", doc! {}, opts).await?;
    let ids = games
        .iter()
        .map(|v| bson_field(v, "id"))
        .collect::<Vec<_>>();
    let (offers, prices) = tokio::join!(
        many(s, "offers", doc! {"id":{"$in":&ids}}, Default::default()),
        many(
            s,
            "pricev2",
            doc! {"offerId":{"$in":ids},"region":region},
            Default::default()
        )
    );
    Ok((
        games,
        offers.unwrap_or_default(),
        prices.unwrap_or_default(),
    ))
}
async fn history(State(s): State<AppState>, uri: Uri, headers: HeaderMap) -> Result<Response> {
    let q = query(&uri);
    let locale = locale(&q)?;
    let region = region(&uri, &headers)?;
    let page = Page::new(&q, 10, 25);
    let expand = expanded(&q);
    let key = format!(
        "giveaways-history:{region}:{}:{}:{}",
        page.key(),
        locale_cache_segment(&locale),
        if expand { "full" } else { "card" }
    );
    if let Some(hit) = cached(&s, &key).await? {
        return Ok(franchise::response(&hit));
    }
    let (games, offers, prices) = history_inputs(&s, region, Some(&page)).await?;
    let result = try_join_all(
        games
            .iter()
            .map(|game| history_entry(&s, game, &offers, &prices, &locale, expand)),
    )
    .await?;
    let result = Value::Array(result);
    store(
        &s,
        &key,
        &result,
        get_localized_cache_ttl_seconds(&result, 3600),
    )
    .await?;
    Ok(franchise::response(&result))
}
async fn history_entry(
    s: &AppState,
    game: &Value,
    offers: &[Value],
    prices: &[Value],
    locale: &str,
    expand: bool,
) -> Result<Value> {
    let id = game.get("id");
    let Some(offer) = offers.iter().find(|offer| same_id(offer.get("id"), id)) else {
        return Ok(json!({"giveaway":game}));
    };
    let price = prices
        .iter()
        .rev()
        .find(|price| same_id(price.get("offerId"), id))
        .unwrap_or(&Value::Null);
    let mut out = localized(
        s,
        offer_shape(offer, false, (!expand).then_some(price)),
        locale,
    )
    .await?;
    out["price"] = price.clone();
    out["giveaway"] = game.clone();
    Ok(out)
}
async fn mobile(State(s): State<AppState>, uri: Uri, headers: HeaderMap) -> Result<Response> {
    let locale = locale(&query(&uri))?;
    let region = region(&uri, &headers)?;
    let now = || bson::DateTime::from_chrono((s.now)());
    let games = many(
        &s,
        "mobile-freebies",
        doc! {"startDate":{"$lte":now()},"endDate":{"$gte":now()}},
        Default::default(),
    )
    .await?;
    let result = try_join_all(
        games
            .iter()
            .map(|game| mobile_entry(&s, game, region, &locale)),
    )
    .await?;
    Ok(ok(&Value::Array(result.into_iter().flatten().collect())))
}
async fn mobile_entry(
    s: &AppState,
    game: &Value,
    region: &str,
    locale: &str,
) -> Result<Option<Value>> {
    let id = bson_field(game, "offerId");
    let Some(offer) = one(s, "offers", doc! {"id":&id}).await? else {
        return Ok(None);
    };
    let price = one(s, "pricev2", doc! {"offerId":id,"region":region}).await?;
    let mut out = localized(s, offer_shape(&offer, true, None), locale).await?;
    let mut giveaway = game.clone();
    if !giveaway["platform"].is_string() {
        giveaway["platform"] = Value::Null;
    }
    out["giveaway"] = giveaway;
    out["price"] = price.unwrap_or_default();
    Ok(Some(out))
}
async fn sellers(State(s): State<AppState>) -> Result<Response> {
    let result = s
        .mongo
        .aggregate_with_options(
            "freegames",
            free_sellers_pipeline(),
            MongoAggregateOptions {
                max_time_ms: Some(60_000),
                allow_disk_use: Some(true),
                ..Default::default()
            },
        )
        .await?;
    Ok(ok(&Value::Array(
        result.iter().map(bson_doc_to_js_json).collect(),
    )))
}
fn price_sum(prices: &[Value], key: &str) -> Value {
    use egdata_core::v1::{query::format_js_number, serialization::js_string};
    let mut number = 0.0;
    let mut text: Option<String> = None;
    for row in prices {
        let field = row["price"].get(key);
        // JavaScript addition switches to concatenation once either operand is a string.
        if text.is_some()
            || matches!(
                field,
                Some(Value::String(_) | Value::Array(_) | Value::Object(_))
            )
        {
            let result = text.get_or_insert_with(|| format_js_number(number));
            result.push_str(&field.map_or_else(|| String::from("undefined"), js_string));
        } else {
            number += match field {
                None => f64::NAN,
                Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
                Some(Value::Bool(true)) => 1.0,
                _ => 0.0,
            };
        }
    }
    text.map_or_else(|| json!(number), Value::String)
}
async fn stats(State(s): State<AppState>, uri: Uri, headers: HeaderMap) -> Result<Response> {
    let region = region(&uri, &headers)?;
    let key = format!("giveaways-stats:{region}:v0.1");
    if let Some(hit) = cached(&s, &key).await? {
        return Ok(franchise::response(&hit));
    }
    let (games, offers, prices) = history_inputs(&s, region, None).await?;
    let first = &prices.first().ok_or(Error::Internal)?["price"];
    if prices.iter().any(|row| row["price"].is_null()) {
        return Err(Error::Internal);
    }
    let mut total = json!({});
    if let Some(v) = first.get("currencyCode") {
        total["currencyCode"] = v.clone();
    }
    for key in [
        "originalPrice",
        "discountPrice",
        "discount",
        "basePayoutPrice",
    ] {
        total[key] = price_sum(&prices, key);
    }
    for key in ["basePayoutCurrencyCode", "payoutCurrencyExchangeRate"] {
        if let Some(v) = first.get(key) {
            total[key] = v.clone();
        }
    }
    let mut counts = HashMap::new();
    for game in &games {
        let id = string_property(game, "id");
        if id != "__proto__" {
            *counts.entry(id).or_insert(0) += 1;
        }
    }
    let sellers: HashSet<_> = offers
        .iter()
        .filter(|o| egdata_http_core::shared::system::js_truthy(&o["seller"]))
        .map(|o| string_property(&o["seller"], "id"))
        .filter(|key| key != "__proto__")
        .collect();
    let result = json!({"totalValue":total,"totalOffers":offers.len(),"totalGiveaways":games.len(),"repeated":counts.values().filter(|&&v|v>1).count(),"sellers":sellers.len()});
    store(&s, &key, &result, 3600).await?;
    Ok(franchise::response(&result))
}
async fn search(State(s): State<AppState>, uri: Uri, headers: HeaderMap) -> Result<Response> {
    let q = query(&uri);
    let locale = locale(&q)?;
    let region = region(&uri, &headers)?;
    let page = Page::new(&q, 10, 50);
    let mut raw_query = serde_json::Map::new();
    for (k, v) in url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes()) {
        raw_query
            .entry(k.into_owned())
            .or_insert_with(|| v.into_owned().into());
    }
    let number = |v: Option<i64>| v.map(|n| n.to_string()).unwrap_or_else(|| "NaN".into());
    let key = format!(
        "free-games-search:{}:{}:{}:{}",
        STANDARD.encode(node_json(&Value::Object(raw_query))),
        number(page.limit),
        number(page.page),
        locale_cache_segment(&locale)
    );
    if let Some(hit) = cached(&s, &key).await? {
        return Ok(franchise::response(&hit));
    }
    let start = Instant::now();
    let mut must = vec![];
    let mut filter = vec![json!({"exists":{"field":"freeEntries"}})];
    let nonempty = |key: &str| q.get(key).filter(|v| !v.is_empty());
    if let Some(v) = nonempty("title") {
        must.push(json!({"multi_match":{"query":v,"fields":["title^3","description","id"]}}));
    }
    if let Some(v) = nonempty("offerType") {
        filter.push(json!({"term":{"offerType.keyword":v}}));
    }
    if let Some(v) = nonempty("tags") {
        filter.push(json!({"terms_set":{"tags.id.keyword":{"terms":v,"minimum_should_match_script":{"source":v.encode_utf16().count().to_string()}}}}));
    }
    if let Some(v) = nonempty("categories") {
        filter.push(json!({"terms":{"categories.keyword":v}}));
    }
    let sort = if let Some(sort) = nonempty("sortBy") {
        let field = match sort.as_str() {
            "giveawayDate" => "freeEntries.endDate".into(),
            "price" => format!("prices.{region}.price.discountPrice"),
            v => v.into(),
        };
        json!({field:{"order":nonempty("sortDir").map_or("desc",String::as_str)}})
    } else {
        json!({"lastModifiedDate":{"order":"desc"}})
    };
    let body = json!({"from":page.page.zip(page.limit).map(|(p,l)|p.saturating_sub(1).saturating_mul(l)),"size":page.limit,"query":{"bool":{"must":must,"filter":filter}},"sort":[sort]});
    let response = s.opensearch.search("egdata.offers", &body).await?;
    let hits = response["hits"]["hits"].as_array().ok_or(Error::Internal)?;
    if hits.iter().any(|hit| hit["_source"].is_null()) {
        return Err(Error::Internal);
    }
    let ids = hits
        .iter()
        .map(|hit| bson_field(&hit["_source"], "id"))
        .collect::<Vec<_>>();
    let prices = many(
        &s,
        "pricev2",
        doc! {"offerId":{"$in":ids},"region":region},
        Default::default(),
    )
    .await?;
    let rows = hits
        .iter()
        .map(|hit| {
            let offer = &hit["_source"];
            let price = prices
                .iter()
                .find(|p| same_id(p.get("offerId"), offer.get("id")))
                .unwrap_or(&Value::Null);
            offer_shape(offer, false, Some(price))
        })
        .collect::<Vec<_>>();
    let count = &response["hits"]["total"];
    let count = if count.is_number() {
        count.clone()
    } else {
        count
            .get("value")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| json!(0))
    };
    let result = json!({"elements":localize_legacy_offers(&s,&rows,&locale,true).await?,"page":page.page,"limit":page.limit,"total":count});
    store(
        &s,
        &key,
        &result,
        get_localized_cache_ttl_seconds(&result, 60),
    )
    .await?;
    let mut r = ok(&result);
    r.headers_mut().insert(
        "server-timing",
        format!("db;dur={}", start.elapsed().as_millis())
            .parse()
            .unwrap(),
    );
    Ok(r)
}
