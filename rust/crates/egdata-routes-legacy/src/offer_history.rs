//! Legacy offer changelog and review queries.
use super::{
    Routes,
    catalog::{Page, query},
    common::*,
};
use crate::state::AppState;
use axum::{
    extract::{Path, State},
    http::{HeaderMap, Uri, header},
    response::Response,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use bson::{Bson, Document, doc};
use chrono::{Datelike, Local};
use egdata_core::{
    ports::MongoFindOptions,
    v1::serialization::{js_iso_datetime, stored_identifier},
};
use egdata_infra::bson_json::bson_doc_to_js_json;
use serde_json::{Map, Value, json};

pub(super) fn routes() -> Routes {
    Routes::new("/offers")
        .get("/{id}/changelog", changelog)
        .get("/{id}/changelog/stats", stats)
        .get("/{id}/reviews", reviews)
}

#[cfg(test)]
#[tokio::test]
async fn legacy_offer_history_http_node_oracle() {
    egdata_api_oracle::replay_legacy_oracle(include_str!(
        "../../egdata-api/tests/fixtures/legacy-offer-history-http-node.json"
    ))
    .await;
}

fn reference_ids(doc: &bson::Document, field: &str) -> Result<Vec<Bson>> {
    doc.get_array(field)
        .map_err(|_| Error::Internal)?
        .iter()
        .map(|v| {
            if matches!(v, Bson::Null | Bson::Undefined) {
                return Err(Error::Internal);
            }
            Ok(v.as_document()
                .and_then(|d| d.get("id"))
                .cloned()
                .unwrap_or(Bson::Null))
        })
        .collect()
}
fn changelog_pipeline(criteria: Document, p: &Page) -> Vec<Document> {
    let mut pipeline = vec![
        doc! {"$match":criteria},
        doc! {"$sort":{"timestamp":-1}},
        doc! {"$skip":p.page.zip(p.limit).map(|(page,limit)|(page-1).saturating_mul(limit))},
        doc! {"$limit":p.limit},
    ];
    let mut branches = Vec::new();
    for (kind, coll, field) in [
        ("offer", "offers", "$id"),
        ("item", "items", "$id"),
        ("asset", "assets", "$artifactId"),
    ] {
        let output = format!("{kind}Doc");
        pipeline.push(doc!{"$lookup":{"from":coll,"let":{"contextId":"$metadata.contextId"},"pipeline":[{"$match":{"$expr":{"$eq":[field,"$$contextId"]}}}],"as":&output}});
        branches.push(doc!{"case":{"$eq":["$metadata.contextType",kind]},"then":{"$arrayElemAt":[format!("${output}"),0]}});
    }
    pipeline.extend([
        doc! {"$addFields":{"document":{"$switch":{"branches":branches,"default":Bson::Null}}}},
        doc! {"$project":{"_id":1,"metadata":1,"timestamp":1,"document":1}},
    ]);
    pipeline
}

async fn changelog(
    State(s): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
) -> Result<Response> {
    let q = query(&uri);
    let p = Page::new(&q, 10, 50);
    let arg = |k: &str| q.get(k).map_or("undefined", String::as_str);
    let key = format!(
        "changelog:{id}:{}:{}:{}:{}",
        p.key(),
        arg("query"),
        arg("type"),
        arg("field")
    );
    if let Some(hit) = cached(&s, &key).await? {
        return Ok(cache_header(ok(&hit), ONE_MINUTE));
    }
    let offer = s
        .mongo
        .find_one("offers", doc! {"id":&id}, None)
        .await?
        .ok_or_else(|| not_found("Offer not found"))?;
    let subs = s
        .mongo
        .find_many(
            "offersubitems",
            doc! {"_id":&id},
            MongoFindOptions {
                projection: Some(doc! {"_id":1,"subItems":1}),
                ..Default::default()
            },
        )
        .await?;
    let mut item_ids = reference_ids(&offer, "items")?;
    for sub in subs {
        item_ids.extend(reference_ids(&sub, "subItems")?);
    }
    let items = s
        .mongo
        .find_many(
            "items",
            doc! {"$or":[{"id":{"$in":item_ids}},{"linkedOffers":&id}]},
            Default::default(),
        )
        .await?;
    let item_ids = super::catalog::field_values(&items, "id");
    let assets = s
        .mongo
        .find_many(
            "assets",
            doc! {"itemId":{"$in":&item_ids}},
            Default::default(),
        )
        .await?;
    let mut all_ids = vec![Bson::String(id)];
    all_ids.extend(item_ids);
    all_ids.extend(super::catalog::field_values(&assets, "artifactId"));
    let mut criteria = doc! {"metadata.contextId":{"$in":all_ids}};
    if let Some(text) = q.get("query").filter(|v| !v.is_empty()) {
        criteria.insert("$text", doc! {"$search":text});
    }
    for (param, field) in [
        ("type", "metadata.changes.changeType"),
        ("field", "metadata.changes.field"),
    ] {
        if let Some(v) = q.get(param).filter(|v| !v.is_empty()) {
            criteria.insert(field, v);
        }
    }
    let total = s
        .mongo
        .count_documents("changelogs_v2", criteria.clone())
        .await?;
    let rows = s
        .mongo
        .aggregate("changelogs_v2", changelog_pipeline(criteria, &p))
        .await?;
    let pages = (total as f64 / p.limit.map_or(f64::NAN, |v| v as f64)).ceil();
    let page = p.page.map_or(f64::NAN, |v| v as f64);
    let result = json!({"elements":rows.iter().map(bson_doc_to_js_json).collect::<Vec<_>>(),"page":p.page,"limit":p.limit,"totalCount":total,"totalPages":pages,"hasNextPage":page<pages,"hasPreviousPage":page>1.});
    store(&s, &key, &result, 60).await?;
    Ok(cache_header(ok(&result), ONE_MINUTE))
}
fn increment(map: &mut Map<String, Value>, key: String) {
    let v = map.entry(key).or_insert(json!(0));
    *v = json!(v.as_u64().unwrap() + 1);
}
async fn stats(State(s): State<AppState>, Path(id): Path<String>, uri: Uri) -> Result<Response> {
    let q = query(&uri);
    let (Some(from), Some(to)) = (
        q.get("from").filter(|v| !v.is_empty()),
        q.get("to").filter(|v| !v.is_empty()),
    ) else {
        return Ok(ok(&json!({"message":"Missing from or to query parameter"})));
    };
    let (Some(from), Some(to)) = (
        super::offer_prices::legacy_date(from),
        super::offer_prices::legacy_date(to),
    ) else {
        return Ok(ok(&json!({"message":"Invalid from or to query parameter"})));
    };
    let key = format!(
        "changelog-stats:{id}:{}:{}",
        js_iso_datetime(from),
        js_iso_datetime(to)
    );
    if let Some(hit) = cached(&s, &key).await? {
        return Ok(cache_header(ok(&hit), ONE_MINUTE));
    }
    let criteria = doc! {"metadata.contextId":id,"timestamp":{"$gte":bson::DateTime::from_chrono(from),"$lte":bson::DateTime::from_chrono(to)}};
    let changes = s
        .mongo
        .find_many(
            "changelogs_v2",
            criteria,
            MongoFindOptions {
                sort: Some(doc! {"timestamp":-1}),
                ..Default::default()
            },
        )
        .await?;
    let (mut days, mut weekdays, mut types, mut fields) =
        (Map::new(), Map::new(), Map::new(), Map::new());
    for row in changes {
        let dt = row
            .get_datetime("timestamp")
            .map_err(|_| Error::Internal)?
            .to_chrono();
        increment(&mut days, dt.format("%Y-%m-%d").to_string());
        increment(
            &mut weekdays,
            dt.with_timezone(&Local)
                .weekday()
                .num_days_from_sunday()
                .to_string(),
        );
        let entries = row
            .get_document("metadata")
            .and_then(|metadata| metadata.get_array("changes"))
            .map_err(|_| Error::Internal)?;
        for change in entries {
            if matches!(change, Bson::Null | Bson::Undefined) {
                return Err(Error::Internal);
            }
            for (counts, field) in [(&mut types, "changeType"), (&mut fields, "field")] {
                let key = match change.as_document().and_then(|doc| doc.get(field)) {
                    None | Some(Bson::Undefined) => "undefined".into(),
                    Some(value) => stored_identifier(value).unwrap_or_else(|| "null".into()),
                };
                increment(counts, key);
            }
        }
    }
    // The legacy cache stores the field counts alone. Warm reads return that payload.
    store(&s, &key, &json!(fields), 3600).await?;
    Ok(ok(
        &json!({"dailyChanges":days,"weekdayChanges":weekdays,"changeTypes":types,"changeFields":fields}),
    ))
}

async fn review_account(s: &AppState, headers: &HeaderMap) -> Option<String> {
    let cookies = egdata_infra::auth_pg::parse_cookies(
        headers
            .get(header::COOKIE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default(),
    );
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty())
        .or_else(|| cookies.get("EPIC_AUTH").map(String::as_str))?;
    let token = token.strip_prefix("Bearer ").unwrap_or(token);
    let mut parts = token.split('.');
    let decode = |s: &str| serde_json::from_slice::<Value>(&URL_SAFE_NO_PAD.decode(s).ok()?).ok();
    decode(parts.next()?)?.as_object()?;
    let payload = decode(parts.next()?)?;
    parts.next()?;
    if parts.next().is_some()
        || ["sub", "appid"]
            .iter()
            .any(|&k| payload[k].as_str().is_none_or(str::is_empty))
    {
        return None;
    }
    // Claims only establish the shape of an Epic token. Identity comes from tokenInfo.
    s.epic.token_account(token).await.ok().flatten()
}
async fn reviews(
    State(s): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Response> {
    let q = query(&uri);
    let p = Page::new(&q, 10, 25);
    let account = review_account(&s, &headers).await;
    let mut filter = doc! {"id":&id,"userId":{"$ne":account.as_deref()}};
    if let Some(v) = q.get("verified").and_then(|v| v.parse::<bool>().ok()) {
        filter.insert("verified", v);
    }
    let mut rows = many(
        &s,
        "reviews",
        filter.clone(),
        MongoFindOptions {
            sort: Some(doc! {"createdAt":-1}),
            limit: p.limit,
            skip: Some(p.skip(0)?),
            ..Default::default()
        },
    )
    .await?;
    if let Some(account) = account
        && let Some(mine) = one(&s, "reviews", doc! {"userId":account,"id":id}).await?
    {
        rows.insert(0, mine);
    }
    let users = many(
        &s,
        "epic",
        doc! {"accountId":{"$in":rows.iter().map(|row| super::common::node_bson(&row["userId"])).collect::<Vec<_>>()}},
        Default::default(),
    )
    .await?;
    for row in &mut rows {
        row["user"] = users
            .iter()
            .find(|user| user.get("accountId") == row.get("userId"))
            .cloned()
            .unwrap_or(Value::Null);
    }
    let total = s.mongo.count_documents("reviews", filter).await?;
    Ok(cache_header(
        ok(&json!({"elements":rows,"page":p.page,"total":total,"limit":p.limit})),
        ONE_MINUTE,
    ))
}
