//! Anonymous offset-based OpenSearch queries mounted below /multisearch.
use super::super::{
    Routes,
    catalog::{locale, query},
    common::*,
    system::selected_region,
};
use crate::{
    state::AppState,
    v1::{
        search::{offer_filters, text_matches},
        system::localize_offers,
    },
};
use axum::{
    extract::State,
    http::{HeaderMap, Uri},
    response::Response,
};
use bson::doc;
use egdata_core::v1::serialization::js_iso_datetime;
use serde_json::{Value, json};

#[cfg(test)]
#[tokio::test]
async fn legacy_multisearch_root_http_node_oracle() {
    crate::v1::mongo_read_oracle::replay_legacy_oracle(include_str!(
        "../../../tests/fixtures/legacy-multisearch-root-http-node.json"
    ))
    .await;
}

pub(super) fn routes() -> Routes {
    Routes::new("/multisearch")
        .get("", || async { ok(&json!({"message":"Hello, World!"})) })
        .get("/offers", offers)
        .get("/items", items)
        .get("/sellers", sellers)
}

use crate::v1::system::js_string_number as number;
fn num(n: f64) -> Value {
    if n.is_finite() && n.fract() == 0. && n.abs() <= 9_007_199_254_740_991. {
        json!(n as i64)
    } else {
        json!(n)
    }
}
fn param_number(raw: Option<&String>, default: f64) -> f64 {
    raw.map(|v| number(v))
        .filter(|n| !n.is_nan() && *n != 0.)
        .unwrap_or(default)
}

fn raw_hits(os: &Value) -> Result<Vec<Value>> {
    let hits = os
        .pointer("/hits/hits")
        .and_then(Value::as_array)
        .ok_or(Error::Internal)?;
    hits.iter()
        .map(|hit| {
            if hit.is_null() {
                return Err(Error::Internal);
            }
            let mut row = super::enumerable_fields(&hit["_source"]);
            if let Some(id) = hit.get("_id") {
                row.insert("_id".into(), id.clone());
            } else {
                row.shift_remove("_id");
            }
            Ok(Value::Object(row))
        })
        .collect()
}
fn total(os: &Value) -> Value {
    os.pointer("/hits/total")
        .filter(|v| v.is_number())
        .or_else(|| os.pointer("/hits/total/value"))
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(json!(0))
}
fn response(hits: Vec<Value>, total: Value, os: &Value, text: &str) -> Response {
    let mut result = json!({"hits":hits,"estimatedTotalHits":total});
    if let Some(ms) = os.get("took") {
        result["processingTimeMs"] = ms.clone();
    }
    result["query"] = json!(text);
    ok(&result)
}

async fn offers(State(state): State<AppState>, uri: Uri, headers: HeaderMap) -> Result<Response> {
    let q = query(&uri);
    let locale = locale(&q)?;
    let region = selected_region(&uri, &headers)
        .map(|(code, _)| code)
        .unwrap_or("US");
    let raw = q.get("query").map(String::as_str).unwrap_or_default();
    let slug = raw
        .contains("store.epicgames.com")
        .then(|| url::Url::parse(raw).ok())
        .flatten()
        .and_then(|u| {
            u.path_segments()?
                .next_back()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        });
    let text = slug.as_deref().unwrap_or(raw);
    let mut values = json!({});
    for key in [
        "offerType",
        "seller",
        "developerDisplayName",
        "publisherDisplayName",
        "refundType",
    ] {
        if let Some(v) = q.get(key) {
            values[key] = json!(v);
        }
    }
    for key in ["tags", "categories", "customAttributes"] {
        if let Some(v) = q.get(key) {
            values[key] = json!(v.split(',').filter(|p| !p.is_empty()).collect::<Vec<_>>());
        }
    }
    for key in ["isCodeRedemptionOnly", "excludeBlockchain", "pastGiveaways"] {
        values[key] = json!(q.get(key).is_some_and(|v| v == "true"));
    }
    let mut filters = offer_filters(&values, region, true, false);
    let mut range = json!({});
    for (key, bound) in [("priceMin", "gte"), ("priceMax", "lte")] {
        if let Some(v) = q.get(key).filter(|v| !v.is_empty()) {
            range[bound] = num(number(v));
        }
    }
    if range.as_object().is_some_and(|v| !v.is_empty()) {
        filters.push(json!({"range":{format!("prices.{region}.price.discountPrice"):range}}));
    }
    let sale = || json!({"range":{format!("prices.{region}.price.discount"):{"gt":0}}});
    if q.get("onSale").is_some_and(|v| v == "true") {
        filters.push(sale());
    }
    for (key, field) in [
        ("isLowestPrice", "isAtLowestPriceUS"),
        ("isLowestPriceEver", "isHistoricalLowestEverUS"),
    ] {
        if q.get(key).is_some_and(|v| v == "true") {
            filters.push(json!({"term":{field:true}}));
            if !q.contains_key("onSale") {
                filters.push(sale());
            }
        }
    }
    let dir = q.get("sortDir").map(String::as_str).unwrap_or("desc");
    let mut order = dir;
    let now = || js_iso_datetime((state.now)());
    let sort_field = match q.get("sortBy").map(String::as_str).unwrap_or("") {
        "" => {
            order = "desc";
            if text.is_empty() {
                "lastModifiedDate".into()
            } else {
                "_score".into()
            }
        }
        field @ ("price" | "priceAsc" | "priceDesc") => {
            if dir.is_empty() {
                order = if field == "priceDesc" { "desc" } else { "asc" };
            }
            format!("prices.{region}.price.discountPrice")
        }
        "discount" => format!("prices.{region}.price.discount"),
        "discountPercent" => {
            format!("prices.{region}.appliedRules.discountSetting.discountPercentage")
        }
        "upcoming" => {
            order = if dir == "asc" { "desc" } else { "asc" };
            filters.push(json!({"range":{"releaseDate":{"gte":now()}}}));
            "releaseDate".into()
        }
        "giveawayDate" => {
            filters.push(json!({"exists":{"field":"freeEntries"}}));
            "freeEntries.endDate".into()
        }
        "releaseDate" => {
            let bound = if dir == "desc" { "lte" } else { "gte" };
            filters.push(json!({"range":{"releaseDate":{bound:now()}}}));
            "releaseDate".into()
        }
        field => field.into(),
    };
    let mut sort = vec![json!({sort_field:{"order":order}})];
    if !text.is_empty() {
        sort.push(json!({"_score":{"order":"desc"}}));
    }
    let limit = param_number(q.get("limit"), 10.).min(100.);
    let page = param_number(q.get("page"), 1.).max(1.);
    let must = text_matches((!text.is_empty()).then_some(text));
    let body = json!({"from":num((page-1.)*limit),"size":num(limit),"query":{"bool":{"must":must,"filter":filters}},"sort":sort});
    let os = state.opensearch.search("egdata.offers", &body).await?;
    let hits = localize_offers(&state, &raw_hits(&os)?, &locale).await?;
    Ok(response(hits, total(&os), &os, text))
}

async fn items(State(state): State<AppState>, uri: Uri) -> Result<Response> {
    let q = query(&uri);
    let text = q.get("query").map(String::as_str).unwrap_or("");
    let must = if text.is_empty() {
        json!([])
    } else {
        json!([{"multi_match":{"query":text,"fields":["title^2","description","id"]}}])
    };
    let mut filters = vec![json!({"bool":{"must_not":{"term":{"namespace.keyword":"ue"}}}})];
    if let Some(t) = q.get("type").filter(|v| !v.is_empty()) {
        filters.push(json!({"term":{"entitlementType.keyword":t}}));
    }
    let os=state.opensearch.search("egdata.items",&json!({"query":{"bool":{"must":must,"filter":filters}},"sort":[{"lastModifiedDate":{"order":"desc"}}]})).await?;
    let mut hits = raw_hits(&os)?;
    for row in &mut hits {
        row["customAttributes"] = if crate::v1::system::js_truthy(&row["customAttributes"]) {
            super::item_attributes(&row["customAttributes"])?
        } else {
            json!({})
        };
    }
    Ok(response(hits, total(&os), &os, text))
}
async fn sellers(State(state): State<AppState>, uri: Uri) -> Result<Response> {
    let q = query(&uri);
    let text = q.get("query").map(String::as_str).unwrap_or("");
    let limit = param_number(q.get("limit"), 10.).min(100.);
    let filter = if text.is_empty() {
        json!({"match_all":{}})
    } else {
        json!({"bool":{"must":[{"match":{"seller.name":{"query":text,"fuzziness":"AUTO"}}}]}})
    };
    let os=state.opensearch.search("egdata.offers",&json!({"size":0,"query":filter,"aggs":{"sellers":{"terms":{"field":"seller.id.keyword","size":num(limit)}}}})).await?;
    let buckets = os
        .pointer("/aggregations/sellers/buckets")
        .filter(|v| !v.is_null());
    let buckets = buckets
        .map(|v| v.as_array().ok_or(Error::Internal))
        .transpose()?
        .map(Vec::as_slice)
        .unwrap_or_default();
    let ids: Vec<_> = buckets
        .iter()
        .map(|b| {
            if b.is_null() {
                Err(Error::Internal)
            } else {
                Ok(b["key"].clone())
            }
        })
        .collect::<Result<_>>()?;
    let docs = if ids.is_empty() {
        vec![]
    } else {
        many(
            &state,
            "sellers",
            doc! {"_id":{"$in":bson::to_bson(&ids).map_err(|_|Error::Internal)?}},
            Default::default(),
        )
        .await?
    };
    let map: std::collections::HashMap<_, _> = docs
        .into_iter()
        .map(|s| {
            let id = s
                .get("_id")
                .filter(|v| !v.is_null())
                .ok_or(Error::Internal)?;
            Ok((egdata_core::v1::serialization::js_string(id), s))
        })
        .collect::<Result<_>>()?;
    let hits = ids
        .iter()
        .filter_map(|id| map.get(id.as_str()?).cloned())
        .collect();
    Ok(response(hits, json!(ids.len()), &os, text))
}
