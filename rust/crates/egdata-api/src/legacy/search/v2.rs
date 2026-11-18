use super::{
    super::{
        catalog::ordered_offer,
        common::*,
        system::{query, selected_country},
    },
    input::{SearchParams, get_params, parsed, post_params},
};
use crate::{
    state::AppState,
    v1::{
        search::{offer_filters, text_matches},
        system::localize_offers,
    },
};
use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{HeaderMap, StatusCode, Uri, header},
    response::Response,
};
use egdata_core::{
    countries::REGIONS,
    localization::{get_localized_cache_ttl_seconds, locale_cache_segment, parse_locale},
    v1::{query::SearchV2Input, serialization::node_json, trim_js_whitespace},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub(super) async fn get(State(s): State<AppState>, uri: Uri) -> Result<Response> {
    let q = get_params(&uri);
    handle(&s, uri, None, q).await
}
pub(super) async fn post(
    State(s): State<AppState>,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mut res = match handle(&s, uri, Some(headers), post_params(&body)).await {
        Ok(r) => r,
        Err(e) => axum::response::IntoResponse::into_response(e),
    };
    res.headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    res
}
fn aggregations(facets: &str, region: &str) -> Option<Value> {
    if facets == "none" {
        return None;
    }
    let mut a = json!({
        "offerType":{"terms":{"field":"offerType.keyword","size":100}},
        "technologies":{"terms":{"field":"lastBuilds.technologies.technology.keyword","size":if facets=="full"{10000}else{1000}}},
        "price_stats":{"stats":{"field":format!("prices.{region}.price.discountPrice")}}
    });
    if facets == "full" {
        for (key, field, size) in [
            ("tags", "tags.name.keyword", 10000),
            ("developer", "developerDisplayName.keyword", 1000),
            ("publisher", "publisherDisplayName.keyword", 1000),
            ("seller", "seller.name.keyword", 1000),
        ] {
            a[key] = json!({"terms":{"field":field,"size":size}})
        }
    }
    Some(a)
}
fn order(input: &SearchV2Input, region: &str, filter: &mut Vec<Value>) -> Vec<Value> {
    let title = input.title.as_deref().is_some_and(|s| !s.is_empty());
    let mut direction = input.sort_dir.map(|d| d.as_str()).unwrap_or("desc");
    let field = match input.sort_by.map(|f| f.as_str()) {
        Some("price" | "priceAsc" | "priceDesc") => format!("prices.{region}.price.discountPrice"),
        Some("discount") => format!("prices.{region}.price.discount"),
        Some("discountPercent") => {
            format!("prices.{region}.appliedRules.discountSetting.discountPercentage")
        }
        Some("priceUpdatedAt") => format!("prices.{region}.updatedAt"),
        Some("upcoming") => {
            direction = if direction == "asc" { "desc" } else { "asc" };
            filter.push(json!({"range":{"releaseDate":{"gte":"now"}}}));
            "releaseDate".into()
        }
        Some("releaseDate") => {
            filter.push(
                json!({"range":{"releaseDate":{if direction=="desc"{"lte"}else{"gte"}:"now"}}}),
            );
            "releaseDate".into()
        }
        Some("giveawayDate") => {
            filter.push(json!({"exists":{"field":"freeEntries"}}));
            "freeEntries.endDate".into()
        }
        Some(k) => k.into(),
        None => {
            direction = "desc";
            if title {
                "_score".into()
            } else {
                "lastModifiedDate".into()
            }
        }
    };
    let mut sort = vec![json!({field:{"order":direction}})];
    if title {
        sort.push(json!({"_score":{"order":"desc"}}));
    }
    sort
}
fn search_response(result: &Value) -> Response {
    let mut res = cache_header(
        ok(result),
        "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
    );
    res.headers_mut().insert(
        "cdn-cache-control",
        "public, max-age=300, stale-while-revalidate=3600"
            .parse()
            .unwrap(),
    );
    res
}
async fn handle(
    s: &AppState,
    uri: Uri,
    headers: Option<HeaderMap>,
    raw: SearchParams,
) -> Result<Response> {
    let locale = parse_locale(query(&uri, "locale").as_deref())
        .map_err(|e| Error::Json(StatusCode::BAD_REQUEST, json!({"message":e.to_string()})))?;
    let country = selected_country(&uri, headers.as_ref().unwrap_or(&HeaderMap::new()));
    let (country, region) = REGIONS
        .iter()
        .find(|(_, r)| r.countries.contains(&country.as_str()))
        .map(|(code, _)| (country.as_str(), *code))
        .unwrap_or(("US", "US"));
    let q = parsed(raw)?;
    let expand = query(&uri, "expand").is_some_and(|v| {
        matches!(
            trim_js_whitespace(&v).to_ascii_lowercase().as_str(),
            "true" | "1" | "full"
        )
    });
    if headers.is_some() {
        let mut pairs = q.to_query_params();
        pairs.push(("country".into(), country.into()));
        if locale != "en-US" {
            pairs.push(("locale".into(), locale));
        }
        if expand {
            pairs.push(("expand".into(), "true".into()));
        }
        pairs.sort_by(|a, b| a.0.cmp(&b.0));
        let qs = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(pairs)
            .finish();
        return Ok(Response::builder()
            .status(StatusCode::SEE_OTHER)
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::LOCATION, format!("/search/v2/search?{qs}"))
            .body(Body::empty())
            .unwrap());
    }
    let facets = q.facets.as_str();
    let must = text_matches(q.title.as_deref().filter(|s| !s.is_empty()));
    let mut filter = offer_filters(&json!(q), region, false, true);
    let sort = order(&q, region, &mut filter);
    let aggs = aggregations(facets, region);
    let (page, limit) = (q.page, q.limit);
    let signature = json!({"region":region,"facets":facets,"expand":expand,"must":must,"filter":filter,"sort":sort,"aggregations":aggs,"page":page,"limit":limit});
    let key = format!(
        "search:v2:{:x}:{}",
        Sha256::digest(node_json(&signature).as_bytes()),
        locale_cache_segment(&locale)
    );
    if let Some(mut result) = cached(s, &key).await? {
        let meta = result
            .get_mut("meta")
            .and_then(Value::as_object_mut)
            .ok_or(Error::Internal)?;
        meta.insert("cached".into(), json!(true));
        return Ok(search_response(&result));
    }
    let from: Value = serde_json::from_str(&egdata_core::v1::query::format_js_number(
        (page - 1) as f64 * limit as f64,
    ))?;
    let mut body = json!({"from":from,"size":limit,"query":{"bool":{"must":must,"filter":filter}},"sort":sort});
    if let Some(a) = &aggs {
        body["aggregations"] = a.clone();
    }
    let os = s.opensearch.search("egdata.offers", &body).await?;
    let hits = os
        .pointer("/hits/hits")
        .and_then(Value::as_array)
        .ok_or(Error::Internal)?;
    let mut offers = Vec::new();
    let mut prices = std::collections::HashMap::new();
    for hit in hits {
        let doc = hit
            .get("_source")
            .filter(|v| v.is_object())
            .ok_or(Error::Internal)?;
        prices.insert(doc["id"].clone(), doc["prices"][region].clone());
        offers.push(Value::Object(ordered_offer(doc)));
    }
    for offer in &mut offers {
        offer["price"] = prices.get(&offer["id"]).cloned().unwrap_or(Value::Null);
    }
    let offers = localize_offers(s, &offers, &locale).await?;
    let mut response_aggs = json!({});
    if let Some(a) = aggs.as_ref().and_then(Value::as_object) {
        for k in a.keys() {
            if let Some(v) = os["aggregations"].get(k) {
                response_aggs[k] = v.clone();
            }
        }
    }
    let mut result = json!({});
    if let Some(v) = os
        .pointer("/hits/total")
        .filter(|v| v.is_number())
        .or_else(|| os.pointer("/hits/total/value"))
    {
        result["total"] = v.clone();
    }
    result["offers"] = json!(offers);
    result["page"] = json!(page);
    result["limit"] = json!(limit);
    result["aggregations"] = response_aggs;
    let mut meta = json!({});
    if let Some(v) = os.get("took") {
        meta["ms"] = v.clone();
    }
    if let Some(v) = os.get("timed_out") {
        meta["timed_out"] = v.clone();
    }
    meta["cached"] = json!(false);
    result["meta"] = meta;
    store(
        s,
        &key,
        &result,
        get_localized_cache_ttl_seconds(&result, 3600),
    )
    .await?;
    Ok(search_response(&result))
}

#[cfg(test)]
#[tokio::test]
async fn legacy_search_v2_http_node_oracle() {
    crate::v1::mongo_read_oracle::replay_legacy_oracle(include_str!(
        "../../../tests/fixtures/legacy-search-http-node.json"
    ))
    .await;
}
