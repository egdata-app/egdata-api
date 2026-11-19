use super::*;
use crate::helpers::json_envelope_response;
use crate::system::{
    cached_length, js_number_or_zero, js_primitive_string, js_truthy, regional_offer_prices,
    serialize_priced_offers,
};

pub(super) fn route_group(prefix: &str) -> RouteGroup {
    RouteGroup::new(prefix)
        .get("/sellers", list)
        .get("/sellers/{id}", offers)
        .get("/sellers/{id}/cover", cover)
        .get("/sellers/{id}/stats", stats)
}
const LIST_TTL: u64 = 3600;
const OFFER_TTL: u64 = 60;
const COVER_TTL: u64 = 300;
const STATS_TTL: u64 = 3600;
fn aggregate_count(rows: &[Document]) -> f64 {
    match rows.first().and_then(|row| row.get("count")) {
        Some(Bson::Double(n)) => *n,
        Some(Bson::Int64(n)) => *n as f64,
        Some(Bson::DateTime(date)) => date.timestamp_millis() as f64,
        Some(Bson::Decimal128(n)) => n
            .to_string()
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite())
            .unwrap_or(0.0),
        value => {
            let json = value.map(egdata_infra::bson_json::bson_to_js_json);
            let number = js_number_or_zero(json.as_ref());
            if number.is_finite() { number } else { 0.0 }
        }
    }
}

async fn priced_offers(
    state: &AppState,
    rows: &[Document],
    region: &str,
    locale: &str,
) -> Result<(Vec<Value>, Value), ProblemError> {
    let prices = if rows.is_empty() {
        Vec::new()
    } else {
        regional_offer_prices(state, rows, region).await?
    };
    serialize_priced_offers(state, rows, &prices, locale).await
}

fn seller_name(seller: &Value) -> std::borrow::Cow<'_, str> {
    match &seller["name"] {
        Value::Null => "".into(),
        Value::String(name) => name.as_str().into(),
        value => js_primitive_string(value).into(),
    }
}

fn cached_truncated(total: Option<&Value>, count: Option<&Value>) -> bool {
    // JS compares two strings lexically, including arrays converted to strings.
    fn comparable(value: &Value) -> (Option<String>, f64) {
        match value {
            Value::String(_) | Value::Array(_) | Value::Object(_) => {
                let text = egdata_core::v1::serialization::js_string(value);
                let number = crate::system::js_string_number(&text);
                (Some(text), number)
            }
            _ => (None, js_number_or_zero(Some(value))),
        }
    }
    let (Some(total), Some(count)) = (total, count) else {
        return false;
    };
    let (left_text, left) = comparable(total);
    let (right_text, right) = comparable(count);
    match (left_text, right_text) {
        (Some(left), Some(right)) => left.encode_utf16().cmp(right.encode_utf16()).is_gt(),
        _ => left > right,
    }
}

fn parse_reg(
    q: &BTreeMap<String, String>,
) -> Result<egdata_core::v1::RegionalParams, ProblemError> {
    regional_params(
        q.get("country").map(String::as_str),
        q.get("locale").map(String::as_str),
    )
}
async fn list(State(s): State<AppState>, req: Request) -> Response {
    let uri = req.uri().clone();
    let rid = req_id(req.extensions().get());
    if let Err(r) = query(&uri, &[], rid.clone()) {
        return *r;
    };
    let key = v1_cache_key("sellers.list", &BTreeMap::new());
    let cached = v1_cache_get(s.cache.as_ref(), &key).await;
    let cache_miss = cached.is_none();
    let result = if let Some(v) = cached {
        v
    } else {
        let vals = match s.mongo.distinct("offers", "seller", Document::new()).await {
            Ok(v) => v,
            Err(_) => return internal(&uri, rid),
        };
        let collator = match super::super::collation::for_locale(&s.config.collation_locale) {
            Ok(collator) => collator,
            Err(e) => return error(e, &uri, rid),
        };
        let mut seen = HashSet::new();
        let mut sellers = Vec::new();
        for raw in vals {
            let v = serialize_seller(&egdata_core::v1::serialization::bson_to_serialized_json(
                &raw,
            ));
            if let Some(id) = v
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                && seen.insert(id.to_string())
            {
                sellers.push(v);
            }
        }
        sellers.sort_by(|a, b| {
            collator
                .compare(&seller_name(a), &seller_name(b))
                .then_with(|| {
                    collator.compare(
                        a.get("id").and_then(Value::as_str).unwrap_or(""),
                        b.get("id").and_then(Value::as_str).unwrap_or(""),
                    )
                })
        });
        let total = sellers.len();
        sellers.truncate(5000);
        json!({"sellers":sellers,"total":total})
    };
    if cache_miss {
        v1_cache_set(s.cache.as_ref(), &key, &result, LIST_TTL).await;
    }
    let sellers = &result["sellers"];
    if sellers.is_null() {
        return internal(&uri, rid);
    }
    let count = cached_length(sellers);
    let total = result.get("total");
    let mut meta = json!({});
    if let Some(count) = &count {
        meta["count"] = count.clone();
    }
    if let Some(total) = total {
        meta["total"] = total.clone();
    }
    meta["truncated"] = json!(cached_truncated(total, count.as_ref()));
    json_success(req.method(), uri.path(), &rid, sellers.clone(), Some(meta))
}
async fn offers(State(s): State<AppState>, Path(seller): Path<String>, req: Request) -> Response {
    let uri = req.uri().clone();
    let rid = req_id(req.extensions().get());
    let allowed = [
        "country",
        "locale",
        "limit",
        "cursor",
        "offerType",
        "ignoredSandboxes",
    ];
    let q = match crate::helpers::parse_validated_query(&uri, &allowed, |params| {
        if params
            .get("offerType")
            .is_some_and(|value| value.encode_utf16().count() > 64)
        {
            vec![ProblemIssue {
                pointer: Some("/offerType".into()),
                parameter: Some("offerType".into()),
                code: "TOO_BIG".into(),
                message: "Too big: expected string to have <=64 characters".into(),
            }]
        } else {
            vec![]
        }
    }) {
        Ok(q) => q,
        Err(e) => return error(e, &uri, rid),
    };
    let p = match parse_pagination_map(&q, 100) {
        Ok(p) => p,
        Err(e) => return error(e, &uri, rid),
    };
    let rp = match parse_reg(&q) {
        Ok(rp) => rp,
        Err(e) => return error(e, &uri, rid),
    };
    let seller = match require_id_param(Some(&seller), "id") {
        Ok(id) => id,
        Err(e) => return error(e, &uri, rid),
    };
    let typ = q
        .get("offerType")
        .map(|value| egdata_core::v1::trim_js_whitespace(value).to_owned())
        .filter(|value| !value.is_empty());
    let ignored = egdata_core::v1::parse_csv(q.get("ignoredSandboxes").map(String::as_str))
        .unwrap_or_default();
    let filters = obj([
        (String::from("offerType"), json!(typ.clone())),
        (String::from("ignoredSandboxes"), json!(ignored.clone())),
    ]);
    let cache_filters = json!({"offerType":typ,"ignoredSandboxes":ignored});
    let bind = binding(
        "sellers.offers",
        Some(filters.clone()),
        OFFER_ORDERING,
        &rp.country,
        &rp.locale,
        p.limit,
    );
    let mut keyparts = BTreeMap::new();
    keyparts.insert("id", json!(seller));
    keyparts.insert("region", json!(rp.region));
    keyparts.insert("locale", json!(rp.locale));
    keyparts.insert("limit", json!(p.limit));
    keyparts.insert("cursor", json!(p.cursor));
    keyparts.insert("filters", cache_filters.clone());
    let key = v1_cache_key("sellers.offers", &keyparts);
    let cached = v1_cache_get(s.cache.as_ref(), &key).await;
    let cache_miss = cached.is_none();
    let result = if let Some(v) = cached {
        v
    } else {
        let mut filter = doc! {"seller.id":&seller};
        if let Some(t) = typ {
            filter.insert("offerType", t);
        }
        if !ignored.is_empty() {
            filter.insert(
                "namespace",
                doc! {"$nin":ignored.into_iter().map(Bson::String).collect::<Vec<_>>()},
            );
        }
        let base = filter.clone();
        if let Some(cursor) = p.cursor.as_deref() {
            let last = match decode_for(&s, cursor, &bind) {
                Ok(v) => v,
                Err(e) => return error(e, &uri, rid),
            };
            let f = match filter_after(&*ITEM_SORT, &last) {
                Ok(v) => v,
                Err(e) => return error(e, &uri, rid),
            };
            filter = doc! {"$and":[filter,f]};
        }
        let (rows, total) = match counted_page(
            &s,
            "sellers.offers",
            &[("id", json!(seller)), ("filters", cache_filters)],
            OFFER_TTL,
            "offers",
            Some(base),
            PageRead::Find(
                filter,
                MongoFindOptions {
                    sort: Some(mongo_sort_spec(&*ITEM_SORT)),
                    limit: Some(i64::from(p.limit) + 1),
                    ..Default::default()
                },
            ),
        )
        .await
        {
            Ok(result) => result,
            Err(e) => return error(e, &uri, rid),
        };
        let (page, more) = page_result(rows, p.limit);
        let (output, localization) = match priced_offers(&s, &page, &rp.region, &rp.locale).await {
            Ok(value) => value,
            Err(e) => return error(e, &uri, rid),
        };
        let next = if let Some(o) = page.last().filter(|_| more) {
            match encode_for(
                &s,
                &bind,
                &[
                    o.get("lastModifiedDate")
                        .map(egdata_infra::bson_json::bson_to_js_json)
                        .and_then(|value| iso_or_null(&value))
                        .into(),
                    o.get_str("id").ok().map(str::to_owned).into(),
                ],
            ) {
                Ok(v) => Some(v),
                Err(e) => return error(e, &uri, rid),
            }
        } else {
            None
        };
        json!({"offers":output,"pagination":page_meta(p.limit,more,next).with_total(total),"localization":localization})
    };
    if cache_miss {
        v1_cache_set(s.cache.as_ref(), &key, &result, OFFER_TTL).await;
    }
    let mut meta = merge_metadata(
        json!({"country":rp.country,"region":rp.region,"locale":rp.locale}),
        result["localization"].clone(),
    );
    if let Some(value) = result.get("pagination") {
        meta["pagination"] = value.clone();
    }
    let mut body = json!({});
    if let Some(offers) = result.get("offers") {
        body["data"] = offers.clone();
    }
    body["meta"] = meta;
    json_envelope_response(req.method(), uri.path(), &rid, body)
}
async fn cover(State(s): State<AppState>, Path(seller): Path<String>, req: Request) -> Response {
    let uri = req.uri().clone();
    let rid = req_id(req.extensions().get());
    let q = match query(&uri, &["country", "locale"], rid.clone()) {
        Ok(v) => v,
        Err(r) => return *r,
    };
    let rp = match parse_reg(&q) {
        Ok(v) => v,
        Err(e) => return error(e, &uri, rid),
    };
    let seller = match require_id_param(Some(&seller), "id") {
        Ok(id) => id,
        Err(e) => return error(e, &uri, rid),
    };
    let mut parts = BTreeMap::new();
    parts.insert("id", json!(seller));
    parts.insert("region", json!(rp.region));
    parts.insert("locale", json!(rp.locale));
    let key = v1_cache_key("sellers.cover", &parts);
    let cached = v1_cache_get(s.cache.as_ref(), &key).await;
    let cache_miss = cached.is_none();
    let result = if let Some(v) = cached {
        v
    } else {
        let top = match s
            .mongo
            .find_many(
                "game_positions",
                doc! {"collectionId":"top-sellers","position":{"$gt":0}},
                MongoFindOptions::default(),
            )
            .await
        {
            Ok(v) => v,
            Err(_) => return internal(&uri, rid),
        };
        let ids: Vec<_> = top
            .iter()
            .map(|row| row.get("offerId").cloned().unwrap_or(Bson::Null))
            .collect();
        let mut rows = {
            match s
                .mongo
                .find_many(
                    "offers",
                    doc! {"id":{"$in":ids},"seller.id":&seller},
                    MongoFindOptions {
                        sort: Some(doc! {"lastModifiedDate":-1}),
                        limit: Some(5),
                        ..Default::default()
                    },
                )
                .await
            {
                Ok(v) => v,
                Err(_) => return internal(&uri, rid),
            }
        };
        if rows.is_empty() {
            rows = match s
                .mongo
                .find_many(
                    "offers",
                    doc! {"seller.id":&seller},
                    MongoFindOptions {
                        sort: Some(doc! {"lastModifiedDate":-1}),
                        limit: Some(5),
                        ..Default::default()
                    },
                )
                .await
            {
                Ok(v) => v,
                Err(_) => return internal(&uri, rid),
            }
        };
        let (data, localization) = match priced_offers(&s, &rows, &rp.region, &rp.locale).await {
            Ok(value) => value,
            Err(e) => return error(e, &uri, rid),
        };
        json!({"offers":data,"localization":localization})
    };
    if cache_miss {
        v1_cache_set(s.cache.as_ref(), &key, &result, COVER_TTL).await;
    }
    let offers = &result["offers"];
    if offers.is_null() {
        return internal(&uri, rid);
    }
    let mut meta = json!({});
    if let Some(length) = cached_length(offers) {
        meta["count"] = length;
    }
    let meta = merge_metadata(
        meta,
        json!({"country":rp.country,"region":rp.region,"locale":rp.locale}),
    );
    json_success(
        req.method(),
        uri.path(),
        &rid,
        offers.clone(),
        Some(merge_metadata(meta, result["localization"].clone())),
    )
}
async fn stats(State(s): State<AppState>, Path(seller): Path<String>, req: Request) -> Response {
    let uri = req.uri().clone();
    let rid = req_id(req.extensions().get());
    if let Err(r) = query(&uri, &[], rid.clone()) {
        return *r;
    };
    let seller = match require_id_param(Some(&seller), "id") {
        Ok(id) => id,
        Err(e) => return error(e, &uri, rid),
    };
    let mut parts = BTreeMap::new();
    parts.insert("id", json!(seller));
    let key = v1_cache_key("sellers.stats", &parts);
    let cached = v1_cache_get(s.cache.as_ref(), &key).await;
    let cache_miss = cached.is_none();
    let result = if let Some(v) = cached {
        v
    } else {
        let doc = match s
            .mongo
            .find_one("sellers", doc! {"_id":&seller}, None)
            .await
        {
            Ok(v) => v,
            Err(_) => return internal(&uri, rid),
        };
        let Some(doc) = doc else {
            v1_cache_set(s.cache.as_ref(), &key, &Value::Null, STATS_TTL).await;
            return missing_seller(&seller, &uri, rid);
        };
        let (offers, items, games) = tokio::join!(
            s.mongo
                .count_documents("offers", doc! {"seller.id":&seller}),
            s.mongo
                .count_documents("items", doc! {"developerId":&seller}),
            s.mongo.aggregate(
                "offers",
                vec![
                    doc! {"$match":{"seller.id":&seller,"offerType":"BASE_GAME"}},
                    doc! {"$sort":{"lastModifiedDate":-1}},
                    doc! {"$group":{"_id":"$namespace","offer":{"$first":"$$ROOT"}}},
                    doc! {"$replaceRoot":{"newRoot":"$offer"}},
                    doc! {"$count":"count"},
                ]
            ),
        );
        let (Ok(offers), Ok(items), Ok(agg)) = (offers, items, games) else {
            return internal(&uri, rid);
        };
        let games = aggregate_count(&agg);
        let count_lookup = |field: &str| {
            vec![
                doc! {"$lookup":{"from":"offers","localField":field,"foreignField":"id","as":"offer"}},
                doc! {"$unwind":"$offer"},
                doc! {"$match":{"offer.seller.id":&seller}},
                doc! {"$group":{"_id":format!("${field}")}},
                doc! {"$count":"count"},
            ]
        };
        let free = match s
            .mongo
            .aggregate_with_options(
                "freegames",
                count_lookup("id"),
                egdata_core::ports::MongoAggregateOptions {
                    allow_disk_use: Some(true),
                    ..Default::default()
                },
            )
            .await
        {
            Ok(v) => aggregate_count(&v),
            Err(_) => return internal(&uri, rid),
        };
        let mobile = match s
            .mongo
            .aggregate_with_options(
                "mobile-freebies",
                count_lookup("offerId"),
                egdata_core::ports::MongoAggregateOptions {
                    allow_disk_use: Some(true),
                    ..Default::default()
                },
            )
            .await
        {
            Ok(v) => aggregate_count(&v),
            Err(_) => return internal(&uri, rid),
        };
        json!({"offers":offers,"items":items,"games":games,"freegames":free+mobile,"seller":serialize_seller(&bjson(doc))})
    };
    if cache_miss {
        v1_cache_set(s.cache.as_ref(), &key, &result, STATS_TTL).await;
    }
    if !js_truthy(&result) {
        return missing_seller(&seller, &uri, rid);
    }
    json_success(req.method(), uri.path(), &rid, result, None)
}

fn missing_seller(seller: &str, uri: &Uri, rid: String) -> Response {
    error(
        egdata_core::v1::not_found("SELLER_NOT_FOUND", format!("No seller matches '{seller}'.")),
        uri,
        rid,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use egdata_api_test_support::test_app_state;
    use crate::state::ApiConfig;
    use egdata_api_oracle::RecordedReads;
    use axum::body::Body;
    use std::sync::Arc;
    use tower::ServiceExt;

    #[tokio::test]
    async fn seller_directory_reports_an_unavailable_collator() {
        let state = test_app_state(ApiConfig {
            collation_locale: "invalid_locale!".into(),
            ..Default::default()
        });
        let response = crate::router(&state)
            .with_state(state)
            .oneshot(
                Request::builder()
                    .uri("/v1/sellers")
                    .header("x-egdata-key-id", "key_oracle")
                    .header("x-egdata-key-tier", "free")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            axum::http::StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    #[test]
    fn aggregate_count_accepts_large_integer_results() {
        assert_eq!(aggregate_count(&[doc! {"count":3_i64}]), 3.0);
        assert_eq!(aggregate_count(&[doc! {"count":3_i32}]), 3.0);
        assert_eq!(aggregate_count(&[Document::new()]), 0.0);
        assert_eq!(aggregate_count(&[]), 0.0);
    }

    #[tokio::test]
    async fn original_seller_examples_match_node_responses_and_service_calls() {
        let traces: Vec<Value> = serde_json::from_str(include_str!(
            "../../../egdata-api/tests/fixtures/seller-edge-http-node.json"
        ))
        .unwrap();
        for source in [
            include_str!("../../../egdata-api/tests/fixtures/catalog-http-node.json"),
            include_str!("../../../egdata-api/tests/fixtures/seller-reads-http-node.json"),
        ] {
            let originals: Vec<Value> = serde_json::from_str(source).unwrap();
            for case in originals
                .iter()
                .filter(|case| case["name"].as_str().unwrap().starts_with("seller-"))
            {
                let name = format!("original-{}", case["name"].as_str().unwrap());
                let trace = traces.iter().find(|entry| entry["name"] == name).unwrap();
                if let Some(filters) = case["input"].get("mongoFilters") {
                    let observed: Vec<_> = trace["trace"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|entry| &entry["call"])
                        .filter(|call| call["method"] == "many")
                        .map(|call| json!({"collection":call["collection"],"filter":call["query"]}))
                        .collect();
                    assert_eq!(&json!(observed), filters, "{name}");
                }
                let reads = Arc::new(RecordedReads::from_case(trace));
                let mut state = test_app_state(ApiConfig {
                    collation_locale: "en-US".into(),
                    ..Default::default()
                });
                state.mongo = reads.clone();
                state.cache = reads.clone();
                let app = route_group("/v1").router.with_state(state);
                let mut request = Request::builder()
                    .uri(case["request"]["path"].as_str().unwrap())
                    .body(Body::empty())
                    .unwrap();
                request.extensions_mut().insert(V1RequestContext {
                    request_id: "req_node_oracle".into(),
                    key: None,
                });
                let response = app.oneshot(request).await.unwrap();
                assert_eq!(
                    egdata_api_test_support::capture_response(response).await,
                    case["response"],
                    "{name}"
                );
                reads.assert_finished();
            }
        }
    }
}
