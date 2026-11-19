use super::*;
use egdata_http_core::shared::offers::item_offer_rank;
use egdata_http_core::shared::system::js_truthy;
use egdata_core::{
    ports::JobApiJobType,
    v1::{serialization::js_string, trim_js_whitespace},
};

pub(super) async fn regen(State(s): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    s.job_api
        .submit(JobApiJobType::ItemRegen, &json!({"id":id}), None)
        .await?;
    Ok(ok(&json!({"message":"Item regen requested"})))
}
pub(super) async fn bulk_regen(State(s): State<AppState>, body: Bytes) -> Result<Response> {
    let payload: Value = serde_json::from_slice(&body)?;
    let items = payload["items"].as_array().ok_or(Error::Internal)?;
    let jobs = items.iter().map(|id| json!({"id":id})).collect::<Vec<_>>();
    s.job_api
        .submit_batch(JobApiJobType::ItemRegen, &jobs, None)
        .await?;
    Ok(ok(&json!({"message":"Item regen requested"})))
}
pub(super) use crate::builds::summary;

pub(crate) fn attributes(value: &Value) -> Value {
    let Some(entries) = value.as_array() else {
        return if value.is_null() {
            json!({})
        } else {
            value.clone()
        };
    };
    let mut result = json!({});
    for entry in entries {
        if let Some(key) = entry["key"].as_str().filter(|k| !k.is_empty()) {
            let mut attr =
                json!({"type":entry["type"].as_str().filter(|s|!s.is_empty()).unwrap_or("STRING")});
            if let Some(v) = entry.get("value") {
                attr["value"] = v.clone();
            }
            result[key] = attr;
        }
    }
    result
}
fn item(mut raw: Value) -> Result<Value> {
    let source = &raw["customAttributes"];
    raw["customAttributes"] = if js_truthy(source) {
        egdata_http_core::shared::offers::checked_attributes(source).map_err(|_| Error::Internal)?
    } else {
        json!({})
    };
    Ok(raw)
}
pub(super) async fn list(State(s): State<AppState>, uri: Uri) -> Result<Response> {
    let p = Page::new(&query(&uri), 10, 50);
    let elements = many(
        &s,
        "items",
        doc! {},
        MongoFindOptions {
            sort: Some(doc! {"lastModifiedDate":-1}),
            skip: Some(p.skip(0)?),
            limit: p.limit,
            ..Default::default()
        },
    )
    .await?;
    let total = s.mongo.count_documents("items", doc! {}).await?;
    Ok(ok(
        &json!({"elements":elements,"page":p.page,"limit":p.limit,"total":total}),
    ))
}
pub(super) async fn detail(State(s): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    Ok(ok(&item(
        one(
            &s,
            "items",
            doc! {"$or":[{"_id":{"$eq":&id}},{"id":{"$eq":id}}]},
        )
        .await?
        .ok_or_else(|| not_found("Item not found"))?,
    )?))
}
pub(super) async fn assets(State(s): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    Ok(ok(&json!(
        many(&s, "assets", doc! {"itemId":id}, Default::default()).await?
    )))
}
pub(super) async fn builds(State(s): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let item = s
        .mongo
        .find_one("items", doc! {"id":{"$eq":id}}, None)
        .await?
        .ok_or_else(|| Error::Json(StatusCode::NOT_FOUND, json!({"error":"Item not found"})))?;
    let mut apps = Vec::new();
    for release in item.get_array("releaseInfo").map_err(|_| Error::Internal)? {
        if matches!(release, Bson::Null | Bson::Undefined) {
            return Err(Error::Internal);
        }
        apps.push(
            release
                .as_document()
                .and_then(|r| r.get("appId"))
                .cloned()
                .unwrap_or(Bson::Null),
        );
    }
    let builds = s
        .mongo
        .find_many("builds", doc! {"appName":{"$in":apps}}, Default::default())
        .await?;
    let results = futures::future::join_all(builds.iter().map(|doc| async {
        let row = bson_doc_to_js_json(doc);
        let platform = match doc.get("platform") {
            Some(platform) if *platform != Bson::Null => platform.clone(),
            _ => Bson::from(
                doc.get_str("labelName")
                    .map_err(|_| Error::Internal)?
                    .rsplit('-')
                    .next()
                    .unwrap_or_default(),
            ),
        };
        let app = doc.get("appName").cloned().unwrap_or(Bson::Null);
        let asset = one(
            &s,
            "assets",
            doc! {"artifactId":{"$eq":app},"platform":{"$eq":platform}},
        )
        .await?;
        summary(&row, asset.as_ref())
    }))
    .await
    .into_iter()
    .collect::<Result<Vec<_>>>()?;
    Ok(ok(&Value::Array(results)))
}

fn bulk_ids(bytes: &Bytes, trim: bool) -> Result<Vec<String>> {
    use serde_json::value::RawValue;
    let text = String::from_utf8_lossy(bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes));
    let Ok(raw) = serde_json::from_str::<&RawValue>(&text) else {
        return Ok(Vec::new());
    };
    let fields: HashMap<String, &RawValue> =
        serde_json::from_str(raw.get()).map_err(|_| Error::Internal)?;
    let values: Vec<&RawValue> =
        serde_json::from_str(fields.get("items").ok_or(Error::Internal)?.get())
            .map_err(|_| Error::Internal)?;
    Ok(values
        .into_iter()
        .filter_map(|v| serde_json::from_str::<String>(v.get()).ok())
        .filter_map(|id| {
            if trim {
                let value = trim_js_whitespace(&id);
                (!value.is_empty()).then(|| value.to_owned())
            } else {
                Some(id)
            }
        })
        .take(100)
        .collect())
}

pub(super) async fn bulk(State(s): State<AppState>, body: Bytes) -> Result<Response> {
    let ids = bulk_ids(&body, false)?;
    let rows = many(&s, "items", doc! {"id":{"$in":ids}}, Default::default()).await?;
    Ok(ok(&Value::Array(
        rows.into_iter().map(item).collect::<Result<Vec<_>>>()?,
    )))
}
pub(super) async fn bulk_offers(
    State(s): State<AppState>,
    uri: Uri,
    body: Bytes,
) -> Result<Response> {
    let locale = locale(&query(&uri))?;
    let ids = bulk_ids(&body, true)?;
    if ids.is_empty() {
        return Ok(ok(&json!({})));
    }
    let direct = s
        .mongo
        .find_many("offers", doc! {"items.id":{"$in":&ids}}, Default::default())
        .await?;
    let subs = s
        .mongo
        .find_many(
            "offersubitems",
            doc! {"subItems.id":{"$in":&ids}},
            MongoFindOptions {
                projection: Some(doc! {"_id":1,"subItems":1}),
                ..Default::default()
            },
        )
        .await?;
    let sub_ids = field_values(&subs, "_id");
    let secondary = if sub_ids.is_empty() {
        vec![]
    } else {
        s.mongo
            .find_many("offers", doc! {"id":{"$in":sub_ids}}, Default::default())
            .await?
    };
    let secondary_ids: HashMap<_, _> = secondary
        .iter()
        .enumerate()
        .filter_map(|(i, doc)| primitive_id(doc.get("id")).map(|key| (key, direct.len() + i)))
        .collect();
    let offers: Vec<_> = direct.iter().chain(&secondary).collect();
    let ranks: Vec<_> = offers.iter().map(|d| item_offer_rank(d)).collect();
    let mut candidates = HashMap::<String, usize>::new();
    let mut add = |members: Option<&Bson>, index: usize| -> Result<()> {
        let members = members.ok_or(Error::Internal)?;
        if matches!(members, Bson::String(_)) {
            return Ok(());
        }
        for member in members.as_array().ok_or(Error::Internal)? {
            if matches!(member, Bson::Null | Bson::Undefined) {
                return Err(Error::Internal);
            }
            if let Some(id) = member.as_document().and_then(|doc| doc.get_str("id").ok())
                && ids.iter().any(|key| key == id)
                && candidates
                    .get(id)
                    .is_none_or(|&old| ranks[index] < ranks[old])
            {
                candidates.insert(id.to_owned(), index);
            }
        }
        Ok(())
    };
    for (i, offer) in direct.iter().enumerate() {
        if let Some(members) = offer
            .get("items")
            .filter(|v| !matches!(v, Bson::Null | Bson::Undefined))
        {
            add(Some(members), i)?;
        }
    }
    for sub in &subs {
        if let Some(key) = primitive_id(sub.get("_id"))
            && let Some(&i) = secondary_ids.get(&key)
        {
            add(sub.get("subItems"), i)?;
        }
    }
    let selected: Vec<_> = ids
        .iter()
        .filter_map(|id| candidates.get(id).copied())
        .collect();
    let selected_docs: Vec<_> = selected.iter().map(|&i| offers[i]).collect();
    let localized = localized_documents(&s, &selected_docs, &locale).await?;
    // In JS, primitive offer IDs share an entry across documents, while each
    // separately read ObjectId, array or document is its own Map key.
    let map_key = |i: usize| {
        let id = primitive_id(offers[i].get("id"));
        let index = if id.is_some() { 0 } else { i };
        (id, index)
    };
    let mut by_id = HashMap::new();
    for (i, row) in selected.iter().copied().zip(localized) {
        by_id.insert(map_key(i), row);
    }
    let mut out = json!({});
    for id in &ids {
        out[id] = candidates
            .get(id)
            .map_or(Value::Null, |&i| by_id[&map_key(i)].clone());
    }
    Ok(cache_header(ok(&out), ONE_MINUTE))
}
pub(super) async fn offer(
    State(s): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
) -> Result<Response> {
    let locale = locale(&query(&uri))?;
    let key = format!("offer:item:{id}:{}", locale_cache_segment(&locale));
    if let Some(hit) = cached(&s, &key).await? {
        return Ok(cache_header(ok(&hit), ONE_HOUR));
    }
    let subs = s
        .mongo
        .find_many(
            "offersubitems",
            doc! {"subItems.id":id},
            MongoFindOptions {
                projection: Some(doc! {"_id":1}),
                ..Default::default()
            },
        )
        .await?;
    let ids = field_values(&subs, "_id");
    let rows = s
        .mongo
        .find_many(
            "offers",
            doc! {"id":{"$in":ids},"offerType":"BASE_GAME"},
            Default::default(),
        )
        .await?;
    let choice = if rows.len() == 1 {
        rows.first()
    } else {
        rows.iter().find(|o| {
            !o.get("prePurchase")
                .is_some_and(|v| js_truthy(&bson_to_js_json(v)))
        })
    };
    let choice = choice
        .ok_or_else(|| Error::Json(StatusCode::NOT_FOUND, json!({"error":"No offer found"})))?;
    let result = localized_documents(&s, &[choice], &locale)
        .await?
        .pop()
        .ok_or(Error::Internal)?;
    store(
        &s,
        &key,
        &result,
        get_localized_cache_ttl_seconds(&result, 3600),
    )
    .await?;
    Ok(cache_header(ok(&result), ONE_HOUR))
}
pub(super) async fn changelog(
    State(s): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
) -> Result<Response> {
    let p = Page::new(&query(&uri), 10, 50);
    let key = format!("changelog:{id}:{}", p.key());
    if let Some(hit) = cached(&s, &key).await? {
        return Ok(cache_header(ok(&hit), ONE_MINUTE));
    }
    one(&s, "items", doc! {"id":{"$eq":&id}})
        .await?
        .ok_or_else(|| not_found("Item not found"))?;
    let assets = s
        .mongo
        .find_many("assets", doc! {"itemId":&id}, Default::default())
        .await?;
    let assets = field_values(&assets, "artifactId");
    let builds = s
        .mongo
        .find_many(
            "builds",
            doc! {"appName":{"$in":&assets}},
            Default::default(),
        )
        .await?;
    let mut ids = vec![Bson::String(id)];
    ids.extend(assets);
    for build in builds {
        let id = build
            .get("_id")
            .filter(|v| !matches!(v, Bson::Null | Bson::Undefined))
            .ok_or(Error::Internal)?;
        ids.push(Bson::String(js_string(&bson_to_js_json(id))));
    }
    let pipeline = changelog_pipeline(&ids, &p, false)?;
    let result = Value::Array(
        s.mongo
            .aggregate("changelogs_v2", pipeline)
            .await?
            .iter()
            .map(bson_doc_to_js_json)
            .collect(),
    );
    store(&s, &key, &result, 3600).await?;
    Ok(cache_header(ok(&result), ONE_MINUTE))
}
async fn localized_documents(
    s: &AppState,
    docs: &[&bson::Document],
    locale: &str,
) -> Result<Vec<Value>> {
    let offers = docs
        .iter()
        .map(|doc| (can_localize(doc), bson_doc_to_js_json(doc)))
        .collect();
    localize_projected_offers(s, offers, locale, false).await
}

pub(super) fn changelog_pipeline<T: Clone + Into<Bson>>(
    ids: &[T],
    p: &Page,
    sandbox: bool,
) -> Result<Vec<bson::Document>> {
    let mut pipeline = vec![
        doc! {"$match":{"metadata.contextId":{"$in":ids.iter().cloned().map(Into::into).collect::<Vec<Bson>>()}}},
        doc! {"$sort":{"timestamp":-1}},
        doc! {"$skip":p.skip(0)? as i64},
        doc! {"$limit":p.limit},
    ];
    let mut branches = Vec::new();
    let build_key = if sandbox {
        Bson::from("$_id")
    } else {
        Bson::Document(doc! {"$toString":"$_id"})
    };
    let mut joins = vec![
        ("item", "items", Bson::from("$id")),
        ("asset", "assets", Bson::from("$artifactId")),
        ("build", "builds", build_key),
    ];
    if sandbox {
        joins.insert(0, ("offer", "offers", Bson::from("$id")));
    }
    for (context, collection, join_key) in joins {
        let name = format!("{context}Doc");
        pipeline.push(doc!{"$lookup":{"from":collection,"let":{"contextId":"$metadata.contextId"},"pipeline":[{"$match":{"$expr":{"$eq":[join_key,"$$contextId"]}}}],"as":&name}});
        branches.push(doc!{"case":{"$eq":["$metadata.contextType",context]},"then":{"$arrayElemAt":[format!("${name}"),0]}});
    }
    pipeline.push(
        doc! {"$addFields":{"document":{"$switch":{"branches":branches,"default":Bson::Null}}}},
    );
    pipeline.push(doc! {"$project":{"_id":1,"metadata":1,"timestamp":1,"document":1}});
    Ok(pipeline)
}

#[cfg(test)]
#[tokio::test]
async fn legacy_item_reads_match_node() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../egdata-api/tests/fixtures/legacy-item-reads-edges-http-node.json"
    ))
    .unwrap();
    let mut runs = tokio::task::JoinSet::new();
    for case in cases {
        runs.spawn(async move {
            egdata_api_oracle::replay_legacy_oracle(&json!([case]).to_string()).await;
        });
    }
    let mut failures = Vec::new();
    while let Some(result) = runs.join_next().await {
        if let Err(e) = result {
            failures.push(e.to_string());
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[cfg(test)]
#[test]
fn joins_use_driver_primitive_identity() {
    let key = |v| primitive_id(Some(&v));
    assert_eq!(key(Bson::Double(-0.0)), key(Bson::Int32(0)));
    assert_eq!(key(Bson::Int32(17)), key(Bson::Int64(17)));
    assert_ne!(key(Bson::Double(17.0)), key(Bson::String("17".into())));
    assert_ne!(primitive_id(None), key(Bson::Null));
    assert_eq!(key(Bson::Int64(i64::MAX)), None);
}
