use super::super::{
    Routes,
    catalog::{
        self, Page, can_localize, checked_ordered_offer, localize_projected_offers, primitive_id,
    },
    common::*,
};
use crate::state::AppState;
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{StatusCode, Uri},
    response::Response,
};
use bson::{Bson, doc};
use egdata_core::ports::MongoFindOptions;
use egdata_infra::bson_json::{bson_doc_to_js_json, bson_to_js_json};
use serde_json::{Value, json};
use std::collections::HashSet;

pub(super) fn routes() -> Routes {
    Routes::new("")
        .get("/items-from-offer/{id}", items)
        .get("/base-game/{namespace}", base_game)
        .get("/changelog", changelog)
        .post("/ping", ping)
}

async fn items(State(s): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let key = format!("items-from-offer:{id}");
    if let Some(hit) = cached(&s, &key).await? {
        return Ok(cache_header(ok(&hit), ONE_MINUTE));
    }
    let pipeline = vec![
        doc! {"$match":{"id":id}},
        doc! {"$unwind":{"path":"$items","preserveNullAndEmptyArrays":true}},
        doc! {"$lookup":{"from":"items","localField":"items.id","foreignField":"id","as":"itemDetails"}},
        doc! {"$unwind":{"path":"$itemDetails","preserveNullAndEmptyArrays":true}},
        doc! {"$lookup":{"from":"items","let":{"offerId":"$id"},"pipeline":[{"$match":{"$expr":{"$and":[{"$isArray":"$linkedOffers"},{"$in":["$$offerId","$linkedOffers"]}]}}}],"as":"linkedItems"}},
        doc! {"$group":{"_id":"$_id","offerItems":{"$push":"$itemDetails"},"linkedItems":{"$first":"$linkedItems"}}},
        doc! {"$project":{"_id":0,"items":{"$filter":{"input":{"$concatArrays":["$offerItems","$linkedItems"]},"as":"item","cond":{"$ne":["$$item",Bson::Null]}}}}},
    ];
    let docs = s.mongo.aggregate("offers", pipeline).await?;
    let mut rows = Vec::new();
    let mut seen = HashSet::new();
    for doc in docs {
        let value = doc.get("items").ok_or(Error::Internal)?;
        for item in value
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_else(|| std::slice::from_ref(value))
        {
            if matches!(item, Bson::Null | Bson::Undefined) {
                return Err(Error::Internal);
            }
            let id = item.as_document().and_then(|doc| doc.get("id"));
            if primitive_id(id).is_some_and(|key| !seen.insert(key)) {
                continue;
            }
            let mut fields = super::enumerable_fields(&bson_to_js_json(item));
            if let Some(attributes) = fields.get_mut("customAttributes") {
                *attributes = super::item_attributes(attributes)?;
            }
            rows.push(Value::Object(fields));
        }
    }
    let value = Value::Array(rows);
    store(&s, &key, &value, 604800).await?;
    Ok(cache_header(ok(&value), ONE_MINUTE))
}
async fn base_game(
    State(s): State<AppState>,
    Path(namespace): Path<String>,
    uri: Uri,
) -> Result<Response> {
    let locale = catalog::locale(&catalog::query(&uri))?;
    if matches!(
        namespace.as_str(),
        "epic" | "SeaQA" | "d5241c76f178492ea1540fce45616757"
    ) {
        return Err(Error::Json(
            StatusCode::NOT_FOUND,
            json!({"error":"Internal namespace"}),
        ));
    }
    let mut filter =
        doc! {"namespace":{"$eq":namespace},"offerType":"BASE_GAME","prePurchase":{"$ne":true}};
    let row = match s.mongo.find_one("offers", filter.clone(), None).await? {
        Some(row) => row,
        None => {
            filter.insert("prePurchase", true);
            s.mongo
                .find_one("offers", filter, None)
                .await?
                .ok_or_else(|| not_found("Game not found"))?
        }
    };
    let projected = checked_ordered_offer(&bson_doc_to_js_json(&row))?;
    let rows =
        localize_projected_offers(&s, vec![(can_localize(&row), projected)], &locale, true).await?;
    Ok(ok(&rows[0]))
}
async fn changelog(State(s): State<AppState>, uri: Uri) -> Result<Response> {
    let page = Page::new(&catalog::query(&uri), 10, 50);
    let options = MongoFindOptions {
        sort: Some(doc! {"timestamp":-1}),
        limit: page.limit,
        skip: Some(page.skip(0)?),
        ..Default::default()
    };
    Ok(cache_header(
        ok(&Value::Array(
            many(&s, "changelogs_v2", doc! {}, options).await?,
        )),
        ONE_MINUTE,
    ))
}

async fn ping(State(s): State<AppState>, bytes: Bytes) -> Result<Response> {
    let fail = || {
        Error::Json(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"message":"error"}),
        )
    };
    let text = String::from_utf8_lossy(bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes));
    let body: Value = serde_json::from_str(&text).map_err(|_| fail())?;
    let pong = || ok(&json!({"message":"pong"}));
    if body.is_null() {
        return Err(fail());
    }
    let location = match body.get("location") {
        None | Some(Value::Null) => return Ok(pong()),
        Some(Value::String(value))
            if value.is_empty() || value.starts_with("http://localhost:5173") =>
        {
            return Ok(pong());
        }
        Some(Value::String(value)) => value,
        _ => return Err(fail()),
    };
    let session = body
        .get("session")
        .filter(|v| !v.is_null())
        .ok_or_else(fail)?;
    let timestamp = match &session["lastActiveAt"] {
        // BSON writes an invalid JavaScript Date as zero milliseconds.
        Value::Number(n) => n
            .as_f64()
            .filter(|v| v.abs() <= 8_640_000_000_000_000.)
            .unwrap_or(0.) as i64,
        Value::Bool(v) => i64::from(*v),
        value => {
            let text = egdata_core::v1::serialization::js_string(value);
            crate::v1::offer_price_history::cursor_date(&text).map_or(0, |d| d.timestamp_millis())
        }
    };
    let mut event = doc! {};
    for field in ["event", "location", "params", "userId"] {
        if let Some(v) = body.get(field) {
            event.insert(field, bson::to_bson(v).map_err(|_| fail())?);
        }
    }
    if let Some(id) = session.get("id") {
        event.insert("session", bson::to_bson(id).map_err(|_| fail())?);
    }
    event.insert("timestamp", bson::DateTime::from_millis(timestamp));
    event.insert("createdAt", bson::DateTime::from_chrono((s.now)()));
    event.insert("updatedAt", bson::DateTime::from_chrono((s.now)()));
    s.mongo
        .insert_one("events", event)
        .await
        .map_err(|_| fail())?;
    // GA receives the original JSON field types. Missing properties disappear
    // when the JS client serializes its Measurement Protocol body.
    let mut params = serde_json::Map::from_iter([("page_location".into(), json!(location))]);
    params.extend(super::enumerable_fields(&body["params"]));
    for (field, key) in [("session_id", "id"), ("timestamp_millis", "lastActiveAt")] {
        if let Some(value) = session.get(key) {
            params.insert(field.into(), value.clone());
        } else {
            params.shift_remove(field);
        }
    }
    let number = |value: Option<&Value>| match value {
        None => f64::NAN,
        Some(Value::Null) => 0.,
        Some(Value::Bool(b)) => u8::from(*b) as f64,
        Some(v) => {
            crate::v1::system::js_string_number(&egdata_core::v1::serialization::js_string(v))
        }
    };
    let delta = number(session.get("lastActiveAt")) - number(session.get("startedAt"));
    let duration = if delta.is_finite() {
        serde_json::from_str(&egdata_core::v1::query::format_js_number(delta))?
    } else {
        Value::Null
    };
    params.insert("engagement_time_msec".into(), duration);
    let mut event = json!({});
    if let Some(name) = body.get("event") {
        event["name"] = name.clone();
    }
    event["params"] = Value::Object(params);
    let mut measurement = json!({});
    if let Some(id) = body.get("userId") {
        measurement["client_id"] = id.clone();
        measurement["user_id"] = id.clone();
    }
    measurement["events"] = json!([event]);
    let _ = s.ga.send_measurement(&measurement).await;
    Ok(pong())
}
