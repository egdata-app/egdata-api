use super::*;

fn position_map(rows: &[Value]) -> HashMap<&str, &Value> {
    rows.iter()
        .filter_map(|row| Some((row["offerId"].as_str()?, row.get("position")?)))
        .collect()
}
fn sorted_position(rows: &mut [Value], positions: &HashMap<&str, &Value>) {
    let rank = |o: &Value| {
        o["id"]
            .as_str()
            .and_then(|id| positions.get(id))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.)
    };
    rows.sort_by(|a, b| rank(a).total_cmp(&rank(b)));
}
fn set_position(row: &mut Value, positions: &HashMap<&str, &Value>) {
    if let Some(position) = row["id"].as_str().and_then(|id| positions.get(id)) {
        row["position"] = (*position).clone();
    }
}

pub(super) async fn top(State(state): State<AppState>, uri: Uri) -> Result<Response> {
    let start = (state.now)();
    let name = uri.path().trim_end_matches('/').rsplit('/').next().unwrap();
    let q = query(&uri);
    let view = View::new(&q)?;
    let params = Page::new(&q, 10, 10);
    let key = format!("{name}:{}:{}:v0.2", params.key(), view.key());
    if let Some(hit) = cached(&state, &key).await? {
        return Ok(minute(&hit));
    }
    let filter = doc! {"collectionId":name,"position":{"$gt":0}};
    let ranked = many(
        &state,
        "game_positions",
        filter.clone(),
        options(doc! {"position":1}, Some(params.skip(0)?), params.limit),
    )
    .await?;
    let mut offers = many(
        &state,
        "offers",
        doc! {"id":{"$in":field(&ranked,"offerId")}},
        Default::default(),
    )
    .await?;
    if ranked.is_empty() {
        return Ok(timed(
            minute(&json!({"elements":[],"page":params.page,"limit":params.limit,"total":0})),
            &state,
            start,
        ));
    }
    let positions = position_map(&ranked);
    sorted_position(&mut offers, &positions);
    let mut elements = if view.expand {
        let rows = offers
            .iter()
            .map(|offer| {
                let mut row = Value::Object(ordered_offer(offer));
                set_position(&mut row, &positions);
                row
            })
            .collect::<Vec<_>>();
        view.localize(&state, &rows).await?
    } else {
        let rows = offers
            .iter()
            .map(|offer| card(offer, None))
            .collect::<Vec<_>>();
        let mut localized = view.localize(&state, &rows).await?;
        for row in &mut localized {
            set_position(row, &positions);
        }
        localized
    };
    let count_filter = if name == "top-wishlisted" {
        doc! {"position":{"$gt":0}}
    } else {
        filter
    };
    let total = state
        .mongo
        .count_documents("game_positions", count_filter)
        .await?;
    let value = json!({"elements":std::mem::take(&mut elements),"page":params.page,"limit":params.limit,"total":total});
    Ok(timed(
        save(&state, &key, &value, 3600).await?,
        &state,
        start,
    ))
}

pub(super) async fn featured(
    State(state): State<AppState>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Response> {
    let view = View::new(&query(&uri))?;
    let region = region(&uri, &headers)?;
    let key = format!("featured-discounts:{region}:{}:v0.4", view.key());
    if let Some(hit) = cached(&state, &key).await? {
        return Ok(minute(&hit));
    }
    let ranked = many(
        &state,
        "game_positions",
        doc! {"position":{"$gt":0}},
        options(doc! {"position":1}, None, Some(200)),
    )
    .await?;
    if ranked.is_empty() {
        return Ok(minute(&json!([])));
    }
    let ids = field(&ranked, "offerId");
    let (mut offers, prices) = tokio::try_join!(
        many(
            &state,
            "offers",
            doc! {"id":{"$in":&ids},"offerType":{"$in":["BASE_GAME","DLC"]}},
            Default::default()
        ),
        many(
            &state,
            "pricev2",
            doc! {"offerId":{"$in":ids},"region":region,"price.discount":{"$gt":0}},
            options(doc! {"updatedAt":-1}, None, None)
        )
    )?;
    let positions = position_map(&ranked);
    let prices = prices_by_id(&prices);
    offers.retain(|o| {
        o["id"]
            .as_str()
            .is_some_and(|id| positions.contains_key(id) && prices.contains_key(id))
    });
    sorted_position(&mut offers, &positions);
    offers.truncate(20);
    let rows = offers
        .into_iter()
        .map(|mut row| {
            let price = prices[row["id"].as_str().unwrap()];
            if view.expand {
                row["price"] = price.clone();
                set_position(&mut row, &positions);
                row
            } else {
                card(&row, Some(price))
            }
        })
        .collect::<Vec<_>>();
    let mut result = view.localize(&state, &rows).await?;
    if !view.expand {
        for row in &mut result {
            set_position(row, &positions);
        }
    }
    save(&state, &key, &Value::Array(result), 3600).await
}

pub(super) async fn achievements(
    State(state): State<AppState>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Response> {
    let view = View::new(&query(&uri))?;
    let region = region(&uri, &headers)?;
    let key = format!("latest-achievements:{region}:{}:v0.2", view.key());
    if let Some(hit) = cached(&state, &key).await? {
        return Ok(minute(&hit));
    }
    let mut skip = 0;
    let mut rows = Vec::new();
    let mut extras = Vec::new();
    while rows.len() < 20 {
        let offers=many(&state,"offers",doc!{"offerType":{"$in":["BASE_GAME"]},"tags.id":"19847","effectiveDate":{"$lte":bson::DateTime::from_chrono((state.now)())}},options(doc!{"effectiveDate":-1},Some(skip),Some(15))).await?;
        let (ach, prices) = tokio::join!(
            many(
                &state,
                "achievementsets",
                doc! {"sandboxId":{"$in":field(&offers,"namespace")},"isBase":true},
                Default::default()
            ),
            many(
                &state,
                "pricev2",
                doc! {"offerId":{"$in":field(&offers,"id")},"region":region},
                Default::default()
            )
        );
        let achievements = ach.unwrap_or_default();
        let price_rows = prices.unwrap_or_default();
        let prices = prices_by_id(&price_rows);
        for offer in &offers {
            if rows.len() == 20 {
                break;
            }
            let Some(achievement) = achievements
                .iter()
                .find(|a| a.get("sandboxId") == offer.get("namespace"))
            else {
                continue;
            };
            let price = offer["id"].as_str().and_then(|id| prices.get(id)).copied();
            let row = if view.expand {
                let mut row = Value::Object(ordered_offer(offer));
                row["achievements"] = achievement.clone();
                row["price"] = price.cloned().unwrap_or(Value::Null);
                row
            } else {
                extras.push(achievement.clone());
                card(offer, price)
            };
            rows.push(row);
        }
        if offers.len() < 15 {
            break;
        }
        skip += 15;
    }
    let mut result = view.localize(&state, &rows).await?;
    for (offer, set) in result.iter_mut().zip(extras) {
        offer["achievements"] = set;
    }
    save(&state, &key, &Value::Array(result), 3600).await
}
