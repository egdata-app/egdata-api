//! Changelog and community reviews for a single offer.
use super::catalog_list::{PageRead, counted_page};
use super::{
    RouteGroup,
    helpers::{parse_strict_query_uri, parse_validated_query, read_response},
    offer_metadata::{assets_for_items, items_for_offer},
    offer_price_history::{cursor_date, date_keyset, date_page, parse_iso_timestamp},
    offer_prices::require,
    offers::cached,
    system::{doc_to_json, internal_error},
};
use crate::state::AppState;
use axum::{
    extract::{Path, Request, State},
    http::Uri,
    response::Response,
};
use bson::{Bson, Document, doc};
use chrono::Datelike;
use egdata_core::{ports::MongoFindOptions, v1::*};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap};

const CHANGELOG: &str = "offer-details.changelog";
const REVIEWS: &str = "offer-details.reviews";

pub fn route_group(prefix: &str) -> RouteGroup {
    RouteGroup::new(prefix)
        .get("/offers/{id}/changelog", |s, p, r| {
            dispatch(s, p, r, Activity::Changelog)
        })
        .get("/offers/{id}/changelog/stats", |s, p, r| {
            dispatch(s, p, r, Activity::Stats)
        })
        .get("/offers/{id}/reviews", |s, p, r| {
            dispatch(s, p, r, Activity::Reviews)
        })
        .get("/offers/{id}/reviews-summary", |s, p, r| {
            dispatch(s, p, r, Activity::Summary)
        })
}

enum Activity {
    Changelog,
    Stats,
    Reviews,
    Summary,
}

async fn dispatch(
    State(state): State<AppState>,
    Path(raw): Path<String>,
    req: Request,
    kind: Activity,
) -> Response {
    let result = match require_id_param(Some(&raw), "id") {
        Err(e) => Err(e),
        Ok(id) => match kind {
            Activity::Changelog => changelog(&state, req.uri(), &id).await,
            Activity::Stats => stats(&state, req.uri(), &id).await,
            Activity::Reviews => reviews(&state, req.uri(), &id).await,
            Activity::Summary => summary(&state, req.uri(), &id).await,
        },
    };
    read_response(&req, result)
}

fn issue(key: &str, code: &str, message: String) -> ProblemIssue {
    ProblemIssue {
        parameter: Some(key.into()),
        pointer: Some(format!("/{key}")),
        code: code.into(),
        message,
    }
}

fn binding(
    operation: &str,
    date_field: &str,
    limit: u32,
    parts: &[(&str, Value)],
) -> CursorBinding {
    CursorBinding {
        operation: operation.into(),
        ordering: format!("{date_field}:desc,_id:desc"),
        country: "US".into(),
        locale: "en-US".into(),
        limit,
        filters: Some(
            parts
                .iter()
                .map(|(k, v)| ((*k).to_owned(), v.clone()))
                .collect(),
        ),
    }
}

pub(super) fn string_field(row: &Value, key: &str) -> String {
    match row.get(key) {
        None => "undefined".into(),
        Some(v) => serialization::js_string(v),
    }
}

fn changelog_joins(pipeline: &mut Vec<Document>) {
    let mut branches = Vec::new();
    for (kind, collection, field) in [
        ("offer", "offers", "$id"),
        ("item", "items", "$id"),
        ("asset", "assets", "$artifactId"),
    ] {
        let alias = format!("{kind}Doc");
        pipeline.push(
            doc! {"$lookup":{"from":collection,"let":{"contextId":"$metadata.contextId"},
            "pipeline":[{"$match":{"$expr":{"$eq":[field,"$$contextId"]}}}],"as":&alias}},
        );
        branches.push(doc!{"case":{"$eq":["$metadata.contextType",kind]},"then":{"$arrayElemAt":[format!("${alias}"),0]}});
    }
    pipeline.push(
        doc! {"$addFields":{"document":{"$switch":{"branches":branches,"default":Bson::Null}}}},
    );
    pipeline.push(doc! {"$project":{"_id":1,"metadata":1,"timestamp":1,"document":1}});
}

async fn changelog(state: &AppState, uri: &Uri, id: &str) -> Result<(Value, Value), ProblemError> {
    let query = parse_validated_query(uri, &["limit", "cursor", "query", "type", "field"], |p| {
        [("query", 200), ("type", 100), ("field", 200)]
            .into_iter()
            .filter_map(|(k, n)| {
                p.get(k).filter(|s| s.encode_utf16().count() > n).map(|_| {
                    issue(
                        k,
                        "TOO_BIG",
                        format!("Too big: expected string to have <={n} characters"),
                    )
                })
            })
            .collect()
    })?;
    let page = parse_pagination_map(&query, 50)?;
    let text = |key: &str| {
        query
            .get(key)
            .map(|v| trim_js_whitespace(v))
            .filter(|v| !v.is_empty())
    };
    let (search, kind, field) = (text("query"), text("type"), text("field"));
    let filters = [
        ("offerId", json!(id)),
        ("query", json!(search)),
        ("type", json!(kind)),
        ("field", json!(field)),
    ];
    let binding = binding(CHANGELOG, "timestamp", page.limit, &filters);
    let key = BTreeMap::from([
        ("id", json!(id)),
        ("cursor", json!(page.cursor)),
        ("limit", json!(page.limit)),
        ("query", json!(search)),
        ("type", json!(kind)),
        ("field", json!(field)),
    ]);
    let response=cached(state,CHANGELOG,key,60,||async {
        let offer=require(state,id,Some(doc!{"id":1,"items":1})).await?;
        let items=items_for_offer(state,id,&offer).await?;
        let assets=assets_for_items(state,&items).await?;
        let ids=std::iter::once(id.to_owned()).chain(items.iter().map(|r|string_field(r,"id")))
            .chain(assets.iter().map(|r|string_field(r,"artifactId"))).collect::<Vec<_>>();
        let mut criteria=doc!{"metadata.contextId":{"$in":ids}};
        if let Some(value)=&search {criteria.insert("$text",doc!{"$search":value});}
        if let Some(value)=&kind {criteria.insert("metadata.changes.changeType",value);}
        if let Some(value)=&field {criteria.insert("metadata.changes.field",value);}
        let mut pipeline=vec![doc!{"$match":&criteria}];
        if let Some(keyset)=date_keyset(state,&page,&binding,"timestamp")? {pipeline.push(doc!{"$match":keyset});}
        pipeline.push(doc!{"$sort":{"timestamp":-1,"_id":-1}});
        pipeline.push(doc!{"$limit":i64::from(page.limit)+1});
        changelog_joins(&mut pipeline);
        let (rows,total)=counted_page(state,CHANGELOG,&[("id",json!(id)),("query",json!(search)),("type",json!(kind)),("field",json!(field))],60,"changelogs_v2",Some(criteria),PageRead::Aggregate(pipeline)).await?;
        let (rows,pagination)=date_page(state,rows,&binding,"timestamp",&["offerId","query","type","field"])?;
        Ok(json!({"elements":rows.into_iter().map(doc_to_json).collect::<Vec<_>>(),"pagination":pagination.with_total(total)}))
    }).await?;
    Ok((
        response["elements"].clone(),
        json!({"pagination":response["pagination"]}),
    ))
}

async fn stats(state: &AppState, uri: &Uri, id: &str) -> Result<(Value, Value), ProblemError> {
    let query = parse_validated_query(uri, &["from", "to"], |p| {
        ["from", "to"]
            .into_iter()
            .filter_map(|key| match p.get(key).map(String::as_str) {
                None => Some(issue(
                    key,
                    "INVALID_TYPE",
                    "Invalid input: expected string, received undefined".into(),
                )),
                Some("") => Some(issue(
                    key,
                    "TOO_SMALL",
                    "Too small: expected string to have >=1 characters".into(),
                )),
                _ => None,
            })
            .collect()
    })?;
    let timestamp = |key: &str| {
        parse_iso_timestamp(egdata_core::v1::trim_js_whitespace(&query[key])).ok_or_else(|| {
            bad_request(
                "INVALID_TIMESTAMP",
                format!("The `{key}` parameter must be an ISO 8601 timestamp such as 2025-01-31T00:00:00Z."),
                None,
            )
        })
    };
    let (from, to) = (timestamp("from")?, timestamp("to")?);
    if from > to {
        return Err(bad_request(
            "INVALID_TIMESTAMP",
            "The `from` timestamp must not be later than `to`.",
            None,
        ));
    }
    let bounds = json!({"from":serialization::js_iso_datetime(from),"to":serialization::js_iso_datetime(to)});
    let key = BTreeMap::from([
        ("id", json!(id)),
        ("from", bounds["from"].clone()),
        ("to", bounds["to"].clone()),
    ]);
    let load = || async {
        require(state, id, Some(doc! {"id":1})).await?;
        let criteria = doc! {
            "metadata.contextId":id,
            "timestamp":{"$gte":bson::DateTime::from_chrono(from),"$lte":bson::DateTime::from_chrono(to)}
        };
        let options = MongoFindOptions {
            projection: Some(doc! {"timestamp":1,"metadata.changes":1}),
            sort: Some(doc! {"timestamp":-1}),
            ..Default::default()
        };
        let rows = state
            .mongo
            .find_many("changelogs_v2", criteria, options)
            .await
            .map_err(|_| internal_error())?;
        let (mut days, mut weekdays, mut types, mut fields) =
            (Map::new(), Map::new(), Map::new(), Map::new());
        for row in rows {
            // The Node cursorDate helper only counts timestamps stored as strings.
            if let Ok(raw) = row.get_str("timestamp")
                && let Some(dt) = cursor_date(raw)
            {
                count(&mut days, dt.format("%Y-%m-%d").to_string());
                count(
                    &mut weekdays,
                    dt.weekday().num_days_from_sunday().to_string(),
                );
            }
            let raw = egdata_infra::bson_json::bson_doc_to_js_json(&row);
            for change in raw["metadata"]["changes"].as_array().into_iter().flatten() {
                for (key, counts) in [("changeType", &mut types), ("field", &mut fields)] {
                    if !change[key].is_null() {
                        count(counts, string_field(change, key));
                    }
                }
            }
        }
        Ok(
            json!({"dailyChanges":days,"weekdayChanges":weekdays,"changeTypes":types,"changeFields":fields}),
        )
    };
    let data = cached(state, "offer-details.changelog-stats", key, 60, load).await?;
    Ok((data, bounds))
}

fn count(map: &mut Map<String, Value>, key: String) {
    let entry = map.entry(key).or_insert(json!(0));
    *entry = json!(entry.as_u64().unwrap() + 1);
}

fn verified_filter(id: &str, verified: Option<bool>) -> Document {
    let mut filter = doc! {"id":id};
    if let Some(value) = verified {
        filter.insert("verified", value);
    }
    filter
}

fn verified_meta(verified: Option<bool>) -> Value {
    verified.map_or_else(|| json!({}), |verified| json!({"verified":verified}))
}

async fn reviews(state: &AppState, uri: &Uri, id: &str) -> Result<(Value, Value), ProblemError> {
    let query = parse_strict_query_uri(uri, &["limit", "cursor", "verified"])?;
    let verified = parse_boolean(query.get("verified").map(String::as_str), "verified")?;
    let page = parse_pagination_map(&query, 25)?;
    let binding = binding(
        REVIEWS,
        "createdAt",
        page.limit,
        &[("offerId", json!(id)), ("verified", json!(verified))],
    );
    let key = BTreeMap::from([
        ("id", json!(id)),
        ("verified", json!(verified)),
        ("limit", json!(page.limit)),
        ("cursor", json!(page.cursor)),
    ]);
    let response = cached(state, REVIEWS, key, 60, || async {
        let mut filter = verified_filter(id, verified);
        let base = filter.clone();
        if let Some(keyset) = date_keyset(state, &page, &binding, "createdAt")? {
            filter.extend(keyset);
        }
        let (rows, total) = counted_page(
            state,
            REVIEWS,
            &[("id", json!(id)), ("verified", json!(verified))],
            60,
            "reviews",
            Some(base),
            PageRead::Find(
                filter,
                MongoFindOptions {
                    sort: Some(doc! {"createdAt":-1,"_id":-1}),
                    limit: Some(i64::from(page.limit) + 1),
                    ..Default::default()
                },
            ),
        )
        .await?;
        let (rows, pagination) =
            date_page(state, rows, &binding, "createdAt", &["offerId", "verified"])?;
        let mut elements: Vec<_> = rows.into_iter().map(doc_to_json).collect();
        let mut ids = Vec::new();
        for row in &elements {
            if !row["userId"].is_null() {
                let id = string_field(row, "userId");
                if !id.is_empty() && !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
        let mut users = HashMap::new();
        if !ids.is_empty() {
            for row in state
                .mongo
                .find_many(
                    "epic",
                    doc! {"accountId":{"$in":ids}},
                    MongoFindOptions::default(),
                )
                .await
                .map_err(|_| internal_error())?
            {
                let user = doc_to_json(row);
                users.insert(string_field(&user, "accountId"), user);
            }
        }
        for row in &mut elements {
            row["user"] = users
                .get(&string_field(row, "userId"))
                .cloned()
                .unwrap_or(Value::Null);
        }
        Ok(json!({"elements":elements,"pagination":pagination.with_total(total)}))
    })
    .await?;
    let mut meta = verified_meta(verified);
    meta["pagination"] = response["pagination"].clone();
    Ok((response["elements"].clone(), meta))
}

async fn summary(state: &AppState, uri: &Uri, id: &str) -> Result<(Value, Value), ProblemError> {
    let query = parse_strict_query_uri(uri, &["verified"])?;
    let verified = parse_boolean(query.get("verified").map(String::as_str), "verified")?;
    let key = BTreeMap::from([("id", json!(id)), ("verified", json!(verified))]);
    let load = || async {
        let group = doc! {"$group":{
            "_id":Bson::Null,
            "total":{"$sum":1},
            "averageRating":{"$avg":"$rating"},
            "recommended":{"$sum":{"$cond":["$recommended",1,0]}}
        }};
        let pipeline = vec![doc! {"$match":verified_filter(id,verified)}, group];
        let rows = state
            .mongo
            .aggregate("reviews", pipeline)
            .await
            .map_err(|_| internal_error())?;
        let stats = rows
            .first()
            .map(egdata_infra::bson_json::bson_doc_to_js_json)
            .unwrap_or(Value::Null);
        let total = stats["total"].as_f64().unwrap_or_default();
        let recommended = stats["recommended"].as_f64().unwrap_or_default();
        let ratio = |n: f64| if total > 0.0 { n / total } else { 0.0 };
        let score = if total > 0.0 {
            stats["averageRating"].as_f64().unwrap_or_default()
        } else {
            0.0
        };
        Ok(
            json!({"overallScore":score,"recommendedPercentage":ratio(recommended),"notRecommendedPercentage":ratio(total-recommended),"totalReviews":total}),
        )
    };
    let data = cached(state, "offer-details.reviews-summary", key, 300, load).await?;
    Ok((data, verified_meta(verified)))
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn offer_activity_http_node_oracle() {
        egdata_api_oracle::replay_mongo_oracle(include_str!(
            "../../egdata-api/tests/fixtures/offer-activity-http-node.json"
        ))
        .await;
    }
}
