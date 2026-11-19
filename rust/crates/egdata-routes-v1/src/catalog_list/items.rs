use super::*;
use crate::item_serialization::stored_item;
use axum::body::to_bytes;

pub(super) fn route_group(prefix: &str) -> RouteGroup {
    RouteGroup::new(prefix)
        .get("/items", list)
        .get("/items/{id}", detail)
        .get("/items/{id}/assets", assets)
        .get("/items/{id}/builds", builds)
        .get("/items/{id}/changelog", changelog)
        .get("/items/{id}/offer", offer)
        .post("/items/bulk", bulk)
        .post("/items/bulk/offers", bulk_offers)
}
const PAGE_KEYS: &[&str] = &["limit", "cursor"];
const REGIONAL_KEYS: &[&str] = &["country", "locale"];

// BSON symbols are promoted to strings by the Node driver. ObjectIds and
// numbers serialize as item IDs too, but fail the route's typeof string check.
fn stored_text(value: Option<&Bson>) -> Option<&str> {
    match value? {
        Bson::String(text) | Bson::Symbol(text) => Some(text),
        _ => None,
    }
}

fn item_list_meta(rows: &Value) -> Value {
    let mut meta = json!({});
    if let Some(count) = crate::system::cached_length(rows) {
        meta["count"] = count;
    }
    meta
}

fn item_page_response(req: &Request, uri: &Uri, rid: String, page: Value) -> Response {
    let Some(data) = page.get("data").filter(|v| !v.is_null()) else {
        return internal(uri, rid);
    };
    let mut meta = item_list_meta(data);
    if let Some(pagination) = page.get("pagination") {
        meta["pagination"] = pagination.clone();
    }
    json_success(req.method(), uri.path(), &rid, data.clone(), Some(meta))
}

async fn list(State(s): State<AppState>, req: Request) -> Response {
    let uri = req.uri().clone();
    let id = req_id(req.extensions().get());
    let q = match query(&uri, PAGE_KEYS, id.clone()) {
        Ok(q) => q,
        Err(r) => return *r,
    };
    let p = match parse_pagination_map(&q, 100) {
        Ok(p) => p,
        Err(e) => return error(e, &uri, id),
    };
    let bind = binding(
        "items.list",
        Some(BTreeMap::new()),
        "lastModifiedDate:desc,id:asc",
        "",
        "",
        p.limit,
    );
    let mut parts = BTreeMap::new();
    parts.insert("limit", json!(p.limit));
    parts.insert("cursor", json!(p.cursor));
    let key = v1_cache_key("items.list", &parts);
    let cached = v1_cache_get(s.cache.as_ref(), &key).await;
    let mut result = if let Some(v) = cached.clone() {
        v
    } else {
        let last = match p
            .cursor
            .as_deref()
            .map(|x| decode_for(&s, x, &bind))
            .transpose()
        {
            Ok(v) => v,
            Err(e) => return error(e, &uri, id),
        };
        let mut filter = Document::new();
        if let Some(t) = last {
            match filter_after(&*ITEM_SORT, &t) {
                Ok(f) => filter = f,
                Err(e) => return error(e, &uri, id),
            }
        }
        let (rows, total) = match counted_page(
            &s,
            "items.list",
            &[],
            60,
            "items",
            Some(doc! {}),
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
            Err(e) => return error(e, &uri, id),
        };
        let (rows, more) = page_result(rows, p.limit);
        let data: Vec<_> = rows.iter().map(stored_item).collect();
        let next = if let Some(d) = rows.last().filter(|_| more) {
            let date = d
                .get("lastModifiedDate")
                .and_then(crate::offer_price_history::stored_date);
            let idv = stored_text(d.get("id")).map(str::to_owned);
            match encode_for(&s, &bind, &[date.into(), idv.into()]) {
                Ok(v) => Some(v),
                Err(e) => return error(e, &uri, id),
            }
        } else {
            None
        };
        json!({"data":data,"pagination":page_meta(p.limit,more,next).with_total(total)})
    };
    if cached.is_none() {
        v1_cache_set(s.cache.as_ref(), &key, &result, 60).await;
    } else if result.get("pagination").is_none()
        && let Some(page) = result.pointer("/meta/pagination").cloned()
    {
        // The previous Rust list cache stored the entire response envelope.
        result["pagination"] = page;
    }
    item_page_response(&req, &uri, id, result)
}
async fn detail(State(s): State<AppState>, Path(id_path): Path<String>, req: Request) -> Response {
    let uri = req.uri().clone();
    let rid = req_id(req.extensions().get());
    if let Err(r) = query(&uri, &[], rid.clone()) {
        return *r;
    };
    let idv = match require_id_param(Some(&id_path), "id") {
        Ok(x) => x,
        Err(e) => return error(e, &uri, rid),
    };
    let mut parts = BTreeMap::new();
    parts.insert("id", json!(idv));
    let key = v1_cache_key("items.get", &parts);
    let cached = v1_cache_get(s.cache.as_ref(), &key).await;
    let result = if let Some(v) = cached.clone() {
        v
    } else {
        let found = match s
            .mongo
            .find_one(
                "items",
                doc! {"$or":[{"_id":{"$eq":&idv}},{"id":{"$eq":&idv}}]},
                None,
            )
            .await
        {
            Ok(v) => v,
            Err(_) => return internal(&uri, rid),
        };
        found.as_ref().map(stored_item).unwrap_or(Value::Null)
    };
    if cached.is_none() {
        v1_cache_set(s.cache.as_ref(), &key, &result, 300).await;
    }
    if !crate::system::js_truthy(&result) {
        return error(
            egdata_core::v1::not_found("ITEM_NOT_FOUND", format!("No item matches '{idv}'.")),
            &uri,
            rid,
        );
    }
    json_success(req.method(), uri.path(), &rid, result, None)
}
async fn assets(State(s): State<AppState>, Path(idv): Path<String>, req: Request) -> Response {
    let uri = req.uri().clone();
    let rid = req_id(req.extensions().get());
    if let Err(r) = query(&uri, &[], rid.clone()) {
        return *r;
    };
    let idv = match require_id_param(Some(&idv), "id") {
        Ok(id) => id,
        Err(e) => return error(e, &uri, rid),
    };
    let mut parts = BTreeMap::new();
    parts.insert("id", json!(idv));
    let key = v1_cache_key("items.assets", &parts);
    let rows = if let Some(v) = v1_cache_get(s.cache.as_ref(), &key).await {
        v
    } else {
        match s
            .mongo
            .find_many("assets", doc! {"itemId":&idv}, MongoFindOptions::default())
            .await
        {
            Ok(r) => {
                let j: Vec<_> = r.into_iter().map(|d| serialize_value(&bjson(d))).collect();
                v1_cache_set(s.cache.as_ref(), &key, &json!(j), 300).await;
                Value::Array(j)
            }
            Err(_) => return internal(&uri, rid),
        }
    };
    let meta = item_list_meta(&rows);
    json_success(req.method(), uri.path(), &rid, rows, Some(meta))
}

async fn builds(State(s): State<AppState>, Path(idv): Path<String>, req: Request) -> Response {
    let uri = req.uri().clone();
    let rid = req_id(req.extensions().get());
    if let Err(r) = query(&uri, &[], rid.clone()) {
        return *r;
    };
    let idv = match require_id_param(Some(&idv), "id") {
        Ok(id) => id,
        Err(e) => return error(e, &uri, rid),
    };
    let cache_key = v1_cache_key("items.builds", &BTreeMap::from([("id", json!(idv))]));
    let cached = v1_cache_get(s.cache.as_ref(), &cache_key).await;
    let result = if let Some(value) = cached.clone() {
        value
    } else {
        let item = match s
            .mongo
            .find_one("items", doc! {"id":{"$eq":&idv}}, None)
            .await
        {
            Ok(v) => v,
            Err(_) => return internal(&uri, rid),
        };
        let Some(item) = item else {
            v1_cache_set(s.cache.as_ref(), &cache_key, &Value::Null, 120).await;
            return error(
                egdata_core::v1::not_found("ITEM_NOT_FOUND", format!("No item matches '{idv}'.")),
                &uri,
                rid,
            );
        };
        let app_ids: Vec<_> = item
            .get_array("releaseInfo")
            .into_iter()
            .flatten()
            .filter_map(|release| release.as_document()?.get("appId"))
            .filter_map(|id| stored_text(Some(id)))
            .collect();
        let mut output = Vec::new();
        if !app_ids.is_empty() {
            let rows = match s
                .mongo
                .find_many(
                    "builds",
                    doc! {"appName":{"$in":app_ids}},
                    MongoFindOptions::default(),
                )
                .await
            {
                Ok(r) => r,
                Err(_) => return internal(&uri, rid),
            };
            use futures::{StreamExt, stream::FuturesUnordered};
            let mut pending = FuturesUnordered::new();
            let mut first_error = None;
            output.resize(rows.len(), Value::Null);
            for (index, doc) in rows.into_iter().enumerate() {
                let mongo = &s.mongo;
                let mut lookup = Box::pin(async move {
                    let platform = crate::builds::stored::platform(&doc)?;
                    let app_name = doc.get("appName").unwrap_or(&Bson::Null);
                    let asset = mongo
                        .find_one(
                            "assets",
                            doc! {"artifactId":{"$eq":app_name},"platform":{"$eq":platform}},
                            None,
                        )
                        .await
                        .map_err(|_| crate::system::internal_error())?
                        .map(bjson);
                    let summary =
                        crate::builds::stored_build_summary(&bjson(doc), asset.as_ref())?;
                    Ok::<_, ProblemError>((index, serialize_value(&summary)))
                });
                // Promise.all starts every lookup, rejects on the first error, and keeps input order.
                match futures::poll!(lookup.as_mut()) {
                    std::task::Poll::Ready(Ok((index, value))) => output[index] = value,
                    std::task::Poll::Ready(Err(e)) => {
                        first_error.get_or_insert(e);
                    }
                    std::task::Poll::Pending => pending.push(lookup),
                }
            }
            if let Some(e) = first_error {
                return error(e, &uri, rid);
            }
            while let Some(result) = pending.next().await {
                match result {
                    Ok((index, value)) => output[index] = value,
                    Err(e) => return error(e, &uri, rid),
                }
            }
        }
        let result = json!(output);
        v1_cache_set(s.cache.as_ref(), &cache_key, &result, 120).await;
        result
    };
    let meta = item_list_meta(&result);
    json_success(req.method(), uri.path(), &rid, result, Some(meta))
}
async fn changelog(State(s): State<AppState>, Path(idv): Path<String>, req: Request) -> Response {
    let uri = req.uri().clone();
    let rid = req_id(req.extensions().get());
    let q = match query(&uri, PAGE_KEYS, rid.clone()) {
        Ok(q) => q,
        Err(r) => return *r,
    };
    let p = match parse_pagination_map(&q, 100) {
        Ok(v) => v,
        Err(e) => return error(e, &uri, rid),
    };
    let idv = match require_id_param(Some(&idv), "id") {
        Ok(id) => id,
        Err(e) => return error(e, &uri, rid),
    };
    let cache_key = v1_cache_key(
        "items.changelog",
        &BTreeMap::from([
            ("id", json!(idv.clone())),
            ("limit", json!(p.limit)),
            ("cursor", json!(p.cursor.clone())),
        ]),
    );
    if let Some(cached) = v1_cache_get(s.cache.as_ref(), &cache_key).await {
        return item_page_response(&req, &uri, rid, cached);
    }
    let item = match s
        .mongo
        .find_one("items", doc! {"id":{"$eq":&idv}}, None)
        .await
    {
        Ok(v) => v,
        Err(_) => return internal(&uri, rid),
    };
    let Some(_item) = item else {
        v1_cache_set(s.cache.as_ref(), &cache_key, &Value::Null, 60).await;
        return error(
            egdata_core::v1::not_found("ITEM_NOT_FOUND", format!("No item matches '{idv}'.")),
            &uri,
            rid,
        );
    };
    let assets = match s
        .mongo
        .find_many("assets", doc! {"itemId":&idv}, MongoFindOptions::default())
        .await
    {
        Ok(v) => v,
        Err(_) => return internal(&uri, rid),
    };
    let mut ctx = vec![Bson::String(idv.clone())];
    let mut aids = Vec::new();
    for a in &assets {
        if let Some(x) = stored_text(a.get("artifactId")) {
            aids.push(Bson::String(x.into()));
            ctx.push(Bson::String(x.into()));
        }
    }
    if !aids.is_empty() {
        let builds = match s
            .mongo
            .find_many(
                "builds",
                doc! {"appName":{"$in":aids}},
                MongoFindOptions::default(),
            )
            .await
        {
            Ok(v) => v,
            Err(_) => return internal(&uri, rid),
        };
        for build in builds {
            let Some(id) = build
                .get("_id")
                .and_then(egdata_core::v1::serialization::stored_identifier)
            else {
                return internal(&uri, rid);
            };
            ctx.push(Bson::String(id));
        }
    }
    let bind = binding(
        "items.changelog",
        Some(obj([(String::from("id"), json!(ctx.first()))])),
        "timestamp:desc,_id:desc",
        "",
        "",
        p.limit,
    );
    let last = match p
        .cursor
        .as_deref()
        .map(|c| decode_for(&s, c, &bind))
        .transpose()
    {
        Ok(x) => x,
        Err(e) => return error(e, &uri, rid),
    };
    let mut matchdoc = doc! {"metadata.contextId":{"$in":ctx}};
    let base = matchdoc.clone();
    if let Some(t) = last {
        // The changelog route destructures two cursor fields before building its keyset.
        let fields = [
            t.first()
                .map_or(Bson::Null, |v| cursor_sort_bson(v, "timestamp")),
            t.get(1)
                .map_or(Bson::Undefined, |v| cursor_sort_bson(v, "_id")),
        ];
        let f = mongo_keyset_filter(&*CHANGELOG_SORT, &fields)
            .expect("two changelog sort fields and cursor values");
        matchdoc = doc! {"$and":[matchdoc,f]};
    }
    let pipeline = vec![
        doc! {"$match":matchdoc},
        doc! {"$sort":mongo_sort_spec(&*CHANGELOG_SORT)},
        doc! {"$limit":i64::from(p.limit)+1},
        doc! {"$lookup":{"from":"items","let":{"contextId":"$metadata.contextId"},"pipeline":[{"$match":{"$expr":{"$eq":["$id","$$contextId"]}}}],"as":"itemDoc"}},
        doc! {"$lookup":{"from":"assets","let":{"contextId":"$metadata.contextId"},"pipeline":[{"$match":{"$expr":{"$eq":["$artifactId","$$contextId"]}}}],"as":"assetDoc"}},
        doc! {"$lookup":{"from":"builds","let":{"contextId":"$metadata.contextId"},"pipeline":[{"$match":{"$expr":{"$eq":[{"$toString":"$_id"},"$$contextId"]}}}],"as":"buildDoc"}},
        doc! {"$addFields":{"document":{"$switch":{"branches":[{"case":{"$eq":["$metadata.contextType","item"]},"then":{"$arrayElemAt":["$itemDoc",0]}},{"case":{"$eq":["$metadata.contextType","asset"]},"then":{"$arrayElemAt":["$assetDoc",0]}},{"case":{"$eq":["$metadata.contextType","build"]},"then":{"$arrayElemAt":["$buildDoc",0]}}],"default":Bson::Null}}}},
        doc! {"$project":{"_id":1,"metadata":1,"timestamp":1,"document":1}},
    ];
    let (rows, total) = match counted_page(
        &s,
        "items.changelog",
        &[("id", json!(idv))],
        60,
        "changelogs_v2",
        Some(base),
        PageRead::Aggregate(pipeline),
    )
    .await
    {
        Ok(result) => result,
        Err(e) => return error(e, &uri, rid),
    };
    let (rows, more) = page_result(rows, p.limit);
    let next = if let Some(d) = rows.last().filter(|_| more) {
        let date = d
            .get("timestamp")
            .and_then(crate::offer_price_history::stored_date);
        let id = d
            .get("_id")
            .filter(|value| crate::item_serialization::truthy(value))
            .and_then(egdata_core::v1::serialization::stored_identifier);
        match encode_for(&s, &bind, &[date.into(), id.into()]) {
            Ok(v) => Some(v),
            Err(e) => return error(e, &uri, rid),
        }
    } else {
        None
    };
    let cached =
        json!({"data":json_docs(rows),"pagination":page_meta(p.limit,more,next).with_total(total)});
    v1_cache_set(s.cache.as_ref(), &cache_key, &cached, 60).await;
    item_page_response(&req, &uri, rid, cached)
}

async fn offer(State(s): State<AppState>, Path(idv): Path<String>, req: Request) -> Response {
    let uri = req.uri().clone();
    let rid = req_id(req.extensions().get());
    let q = match query(&uri, REGIONAL_KEYS, rid.clone()) {
        Ok(q) => q,
        Err(r) => return *r,
    };
    let rp = match regional_params(
        q.get("country").map(String::as_str),
        q.get("locale").map(String::as_str),
    ) {
        Ok(v) => v,
        Err(e) => return error(e, &uri, rid),
    };
    let idv = match require_id_param(Some(&idv), "id") {
        Ok(id) => id,
        Err(e) => return error(e, &uri, rid),
    };
    let cache_key = v1_cache_key(
        "items.offer",
        &BTreeMap::from([
            ("id", json!(idv.clone())),
            ("region", json!(rp.region.clone())),
            ("locale", json!(rp.locale.clone())),
        ]),
    );
    let cached = v1_cache_get(s.cache.as_ref(), &cache_key).await;
    if let Some(cached) = cached {
        if cached["status"] == "item_not_found" {
            return error(
                egdata_core::v1::not_found("ITEM_NOT_FOUND", format!("No item matches '{idv}'.")),
                &uri,
                rid,
            );
        }
        if cached["status"] == "offer_not_found" {
            return error(
                egdata_core::v1::not_found(
                    "ITEM_OFFER_NOT_FOUND",
                    format!(
                        "No base-game offer is available for item '{idv}' in {}.",
                        rp.country
                    ),
                ),
                &uri,
                rid,
            );
        }
        let mut meta = json!({"country":rp.country,"region":rp.region,"locale":rp.locale});
        let extra = egdata_http_core::shared::json::spread(&cached["localization"]);
        meta.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let mut envelope = json!({});
        if let Some(offer) = cached.get("offer") {
            envelope["data"] = offer.clone();
        }
        envelope["meta"] = meta;
        return crate::helpers::json_envelope_response(
            req.method(),
            uri.path(),
            &rid,
            envelope,
        );
    }
    let item = match s
        .mongo
        .find_one("items", doc! {"id":{"$eq":&idv}}, None)
        .await
    {
        Ok(v) => v,
        Err(_) => return internal(&uri, rid),
    };
    if item.is_none() {
        v1_cache_set(
            s.cache.as_ref(),
            &cache_key,
            &json!({"status":"item_not_found"}),
            60,
        )
        .await;
        return error(
            egdata_core::v1::not_found("ITEM_NOT_FOUND", format!("No item matches '{idv}'.")),
            &uri,
            rid,
        );
    }
    let subs = match s
        .mongo
        .find_many(
            "offersubitems",
            doc! {"subItems.id":&idv},
            MongoFindOptions {
                projection: Some(doc! {"_id":1}),
                ..Default::default()
            },
        )
        .await
    {
        Ok(v) => v,
        Err(_) => return internal(&uri, rid),
    };
    let sub_ids: Vec<_> = subs
        .iter()
        .map(|d| d.get("_id").cloned().unwrap_or(Bson::Null))
        .collect();
    let offers = match s
        .mongo
        .find_many(
            "offers",
            doc! {"id":{"$in":sub_ids},"offerType":"BASE_GAME"},
            MongoFindOptions::default(),
        )
        .await
    {
        Ok(v) => v,
        Err(_) => return internal(&uri, rid),
    };
    let eligible: Vec<_> = offers
        .into_iter()
        .filter(|doc| catalog_offer_eligible(doc, &rp.country))
        .collect();
    let selected = if eligible.len() == 1 {
        eligible.into_iter().next()
    } else {
        eligible
            .into_iter()
            .find(|o| o.get_bool("prePurchase") != Ok(true))
    };
    let Some(selected) = selected else {
        v1_cache_set(
            s.cache.as_ref(),
            &cache_key,
            &json!({"status":"offer_not_found"}),
            60,
        )
        .await;
        return error(
            egdata_core::v1::not_found(
                "ITEM_OFFER_NOT_FOUND",
                format!(
                    "No base-game offer is available for item '{idv}' in {}.",
                    rp.country
                ),
            ),
            &uri,
            rid,
        );
    };
    let offer_id = selected.get("id").cloned().unwrap_or(Bson::Null);
    let price = match crate::offers::current_price(&s, offer_id, &rp.region).await {
        Ok(value) => value,
        Err(e) => return error(e, &uri, rid),
    };
    let localized =
        match crate::system::localize_ordered_rows(&s, &[selected], &rp.locale).await {
            Ok(mut rows) => rows.pop().unwrap(),
            Err(e) => return error(e, &uri, rid),
        };
    let out = serialize_offer(&localized, price.as_ref(), true);
    let localization = egdata_core::v1::serialization::localization_meta(Some(&localized));
    v1_cache_set(
        s.cache.as_ref(),
        &cache_key,
        &json!({"status":"ok","offer":out.clone(),"localization":localization.clone()}),
        60,
    )
    .await;
    let mut meta = json!({"country":rp.country,"region":rp.region,"locale":rp.locale});
    meta.as_object_mut()
        .unwrap()
        .extend(localization.as_object().unwrap().clone());
    json_success(req.method(), uri.path(), &rid, out, Some(meta))
}

async fn body_ids(req: Request) -> Result<Vec<String>, ProblemError> {
    egdata_core::v1::require_json_content_type(
        req.headers()
            .get(http::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
    )?;
    let value = match to_bytes(req.into_body(), usize::MAX)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    {
        Some(value) => value,
        None => {
            return Err(ProblemError::new(
                400,
                "MALFORMED_JSON",
                "The request body is not valid JSON.",
            ));
        }
    };
    let Some(obj) = value.as_object() else {
        return Err(ProblemError::new(
            400,
            "INVALID_BODY",
            "The request body must be a JSON object with an `items` array of strings.",
        )
        .with_errors(vec![ProblemIssue {
            pointer: Some("".into()),
            parameter: None,
            code: "INVALID".into(),
            message: "Expected an object.".into(),
        }]));
    };
    let unexpected: Vec<_> = obj
        .keys()
        .filter(|k| k.as_str() != "items")
        .cloned()
        .collect();
    if !unexpected.is_empty() {
        let fields = unexpected.join(", ");
        return Err(ProblemError::new(
            400,
            "INVALID_BODY",
            format!("The request body contains unsupported field(s): {fields}."),
        )
        .with_errors(
            unexpected
                .iter()
                .map(|key| ProblemIssue {
                    pointer: Some(format!("/{key}")),
                    parameter: None,
                    code: "UNKNOWN_FIELD".into(),
                    message: format!("The `{key}` field is not supported."),
                })
                .collect(),
        ));
    };
    let Some(ids) = obj.get("items").and_then(Value::as_array) else {
        return Err(ProblemError::new(
            400,
            "INVALID_BODY",
            "The `items` field must be an array of item identifiers.",
        )
        .with_errors(vec![ProblemIssue {
            pointer: Some("/items".into()),
            parameter: None,
            code: "INVALID".into(),
            message: "Expected an array of strings.".into(),
        }]));
    };
    if ids.len() > 100 {
        return Err(ProblemError::new(
            400,
            "BULK_LIMIT_EXCEEDED",
            "At most 100 item identifiers can be resolved per request.",
        )
        .with_errors(vec![ProblemIssue {
            pointer: Some("/items".into()),
            parameter: None,
            code: "TOO_MANY_ITEMS".into(),
            message: format!(
                "The array contains {} entries; the maximum is 100.",
                ids.len()
            ),
        }]));
    };
    let mut out = Vec::new();
    for (index, v) in ids.iter().enumerate() {
        let Some(id) = v.as_str().map(str::trim) else {
            return Err(ProblemError::new(
                400,
                "INVALID_BODY",
                "Every entry in `items` must be a string.",
            )
            .with_errors(vec![ProblemIssue {
                pointer: Some(format!("/items/{index}")),
                parameter: None,
                code: "INVALID".into(),
                message: "Expected a string.".into(),
            }]));
        };
        if id.is_empty() || id.encode_utf16().count() > 200 {
            return Err(ProblemError::new(
                400,
                "INVALID_BODY",
                "Item identifiers must contain between 1 and 200 characters.",
            )
            .with_errors(vec![ProblemIssue {
                pointer: Some(format!("/items/{index}")),
                parameter: None,
                code: "INVALID".into(),
                message: "Expected a non-empty identifier of at most 200 characters.".into(),
            }]));
        };
        if !out.contains(&id.to_string()) {
            out.push(id.into())
        }
    }
    Ok(out)
}
async fn bulk(State(s): State<AppState>, req: Request) -> Response {
    let uri = req.uri().clone();
    let method = req.method().clone();
    let rid = req_id(req.extensions().get());
    if let Err(e) = parse_strict_query_uri(&uri, &[]) {
        return error(e, &uri, rid);
    }
    let ids = match body_ids(req).await {
        Ok(v) => v,
        Err(e) => return error(e, &uri, rid),
    };
    let key = v1_cache_key("items.bulk", &BTreeMap::from([("ids", json!(ids.clone()))]));
    if let Some(cached) = v1_cache_get(s.cache.as_ref(), &key).await {
        let Some(data) = cached.get("data").filter(|v| !v.is_null()) else {
            return internal(&uri, rid);
        };
        let mut meta = json!({"requested":ids.len()});
        if let Some(count) = crate::system::cached_length(data) {
            meta["found"] = count;
        }
        if let Some(missing) = cached.get("missing") {
            meta["missing"] = missing.clone();
        }
        return json_success(&method, uri.path(), &rid, data.clone(), Some(meta));
    }
    let docs = if ids.is_empty() {
        vec![]
    } else {
        match s
            .mongo
            .find_many(
                "items",
                doc! {"id":{"$in":ids.iter().map(|x| Bson::String(x.clone())).collect::<Vec<_>>()}},
                MongoFindOptions::default(),
            )
            .await
        {
            Ok(v) => v,
            Err(_) => return internal(&uri, rid),
        }
    };
    let mut by = HashMap::new();
    for d in docs {
        if let Some(Bson::String(k) | Bson::Symbol(k)) = d.get("id") {
            by.insert(k.clone(), stored_item(&d));
        }
    }
    let data: Vec<_> = ids.iter().filter_map(|id| by.get(id).cloned()).collect();
    let missing: Vec<_> = ids.iter().filter(|id| !by.contains_key(*id)).collect();
    let result = json!({"data":data,"missing":missing});
    v1_cache_set(s.cache.as_ref(), &key, &result, 60).await;
    json_success(
        &method,
        uri.path(),
        &rid,
        json!(data),
        Some(json!({"requested":ids.len(),"found":data.len(),"missing":missing})),
    )
}
fn catalog_offer_eligible(offer: &Document, country: &str) -> bool {
    let includes = |list: &[Bson]| {
        list.iter()
            .any(|value| matches!(value, Bson::String(s) | Bson::Symbol(s) if s == country))
    };
    if let Ok(whitelist) = offer.get_array("countriesWhitelist")
        && !whitelist.is_empty()
    {
        return includes(whitelist);
    }
    !offer
        .get_array("countriesBlacklist")
        .is_ok_and(|list| includes(list))
}

async fn bulk_offers(State(s): State<AppState>, req: Request) -> Response {
    let uri = req.uri().clone();
    let method = req.method().clone();
    let rid = req_id(req.extensions().get());
    let q = match query(&uri, REGIONAL_KEYS, rid.clone()) {
        Ok(q) => q,
        Err(r) => return *r,
    };
    let rp = match regional_params(
        q.get("country").map(String::as_str),
        q.get("locale").map(String::as_str),
    ) {
        Ok(v) => v,
        Err(e) => return error(e, &uri, rid),
    };
    let ids = match body_ids(req).await {
        Ok(v) => v,
        Err(e) => return error(e, &uri, rid),
    };
    let key = v1_cache_key(
        "items.bulkOffers",
        &BTreeMap::from([
            ("ids", json!(ids.clone())),
            ("country", json!(rp.country.clone())),
            ("region", json!(rp.region.clone())),
            ("locale", json!(rp.locale.clone())),
        ]),
    );
    if let Some(cached) = v1_cache_get(s.cache.as_ref(), &key).await {
        let mut meta = json!({"requested":ids.len()});
        if let Some(found) = cached.get("found") {
            meta["found"] = found.clone();
        }
        meta["country"] = rp.country.into();
        meta["region"] = rp.region.into();
        meta["locale"] = rp.locale.into();
        let mut envelope = json!({});
        if let Some(data) = cached.get("data") {
            envelope["data"] = data.clone();
        }
        envelope["meta"] = meta;
        return crate::helpers::json_envelope_response(&method, uri.path(), &rid, envelope);
    }
    let idb: Vec<_> = ids.iter().map(|x| Bson::String(x.clone())).collect();
    let direct = if ids.is_empty() {
        vec![]
    } else {
        match s
            .mongo
            .find_many(
                "offers",
                doc! {"items.id":{"$in":idb.clone()}},
                MongoFindOptions::default(),
            )
            .await
        {
            Ok(v) => v,
            Err(_) => return internal(&uri, rid.clone()),
        }
    };
    let subs = if ids.is_empty() {
        vec![]
    } else {
        match s
            .mongo
            .find_many(
                "offersubitems",
                doc! {"subItems.id":{"$in":idb}},
                MongoFindOptions {
                    projection: Some(doc! {"_id":1,"subItems":1}),
                    ..Default::default()
                },
            )
            .await
        {
            Ok(v) => v,
            Err(_) => return internal(&uri, rid.clone()),
        }
    };
    let subids: Vec<_> = subs
        .iter()
        .map(|doc| doc.get("_id").cloned().unwrap_or(Bson::Null))
        .collect();
    let nested = if subids.is_empty() {
        Vec::new()
    } else {
        match s
            .mongo
            .find_many("offers", doc! {"id":{"$in":subids}}, Default::default())
            .await
        {
            Ok(docs) => docs,
            Err(_) => return internal(&uri, rid),
        }
    };
    use crate::helpers::primitive_id;
    let nested_by_id: HashMap<_, _> = nested
        .iter()
        .filter_map(|doc| Some((primitive_id(doc.get("id"))?, doc)))
        .collect();
    let linked = subs.iter().filter_map(|sub| {
        let doc = nested_by_id.get(&primitive_id(sub.get("_id"))?)?;
        Some((*doc, sub.get("subItems")))
    });
    let requested: HashSet<_> = ids.iter().map(String::as_str).collect();
    let mut matched: HashMap<&str, (u8, &Document)> = HashMap::new();
    for (offer, links) in direct.iter().map(|d| (d, d.get("items"))).chain(linked) {
        let links = match links {
            None | Some(Bson::Null | Bson::Undefined | Bson::String(_) | Bson::Symbol(_)) => {
                continue;
            }
            Some(Bson::Array(values)) => values,
            _ => return internal(&uri, rid),
        };
        if !catalog_offer_eligible(offer, &rp.country) {
            continue;
        }
        let rank = crate::offers::item_offer_rank(offer);
        for link in links {
            if let Some(id) = stored_text(link.as_document().and_then(|d| d.get("id")))
                && requested.contains(id)
                && matched.get(id).is_none_or(|(best, _)| rank < *best)
            {
                matched.insert(id, (rank, offer));
            }
        }
    }
    let selected: Vec<_> = ids
        .iter()
        .filter_map(|id| matched.get(id.as_str()).map(|(_, doc)| (*doc).clone()))
        .collect();
    let raw_prices = if selected.is_empty() {
        Vec::new()
    } else {
        let oids: Vec<_> = selected
            .iter()
            .map(|doc| doc.get("id").cloned().unwrap_or(Bson::Null))
            .collect();
        match s
            .mongo
            .find_many(
                "pricev2",
                doc! {"offerId":{"$in":oids},"region":&rp.region},
                Default::default(),
            )
            .await
        {
            Ok(docs) => docs,
            Err(_) => return internal(&uri, rid),
        }
    };
    let prices: HashMap<_, _> = raw_prices
        .iter()
        .filter_map(|doc| Some((primitive_id(doc.get("offerId"))?, doc)))
        .collect();
    let localized = match crate::system::localize_ordered_rows(&s, &selected, &rp.locale).await
    {
        Ok(rows) => rows,
        Err(e) => return error(e, &uri, rid),
    };
    let localized_by_id: HashMap<_, _> = selected
        .iter()
        .zip(&localized)
        .filter_map(|(doc, value)| Some((primitive_id(doc.get("id"))?, value)))
        .collect();
    let mut projected = localized.iter();
    let mut output = serde_json::Map::new();
    for id in &ids {
        let value = if let Some((_, offer)) = matched.get(id.as_str()) {
            let own = projected.next().unwrap();
            let key = primitive_id(offer.get("id"));
            let localized = key
                .as_ref()
                .and_then(|key| localized_by_id.get(key).copied())
                .unwrap_or(own);
            let price = key.as_ref().and_then(|key| prices.get(key));
            let mut value = serialize_offer(localized, None, true);
            if let Some(price) = price {
                value["price"] =
                    match crate::offer_prices::serialize_stored_price((*price).clone()) {
                        Ok(value) => value,
                        Err(e) => return error(e, &uri, rid),
                    };
            }
            value
        } else {
            Value::Null
        };
        // Plain object assignment in the Node result creates no own key here.
        if id != "__proto__" {
            output.insert(id.clone(), value);
        }
    }
    let result = json!({"data":output,"found":selected.len()});
    v1_cache_set(s.cache.as_ref(), &key, &result, 60).await;
    json_success(
        &method,
        uri.path(),
        &rid,
        result["data"].clone(),
        Some(
            json!({"requested":ids.len(),"found":selected.len(),"country":rp.country,"region":rp.region,"locale":rp.locale}),
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use axum::body::Body;
    use bson::doc;
    use egdata_core::{error::CoreError, ports::MongoStorePort};
    use http_body_util::BodyExt;
    use serde_json::Value;
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;

    #[derive(Default)]
    struct ItemMongo {
        fail_reads: Option<String>,
        timed_assets: bool,
        asset_barrier: Option<Arc<tokio::sync::Barrier>>,
        pipeline: Mutex<Vec<Document>>,
        docs: Vec<Document>,
        collection_docs: HashMap<String, Vec<Document>>,
        singles: HashMap<String, Document>,
        last: Mutex<Option<(String, Document, MongoFindOptions)>>,
        one_last: Mutex<Option<(String, Document, Option<Document>)>>,
        find_one_calls: Mutex<usize>,
        asset_queries: Mutex<Vec<Value>>,
        price_queries: Mutex<Vec<Value>>,
        cache: Mutex<HashMap<String, String>>,
        cache_sets: Mutex<usize>,
        cache_ttls: Mutex<Vec<u64>>,
    }
    #[async_trait]
    impl MongoStorePort for ItemMongo {
        async fn find_one_with_options(
            &self,
            collection: &str,
            filter: Document,
            options: MongoFindOptions,
        ) -> Result<Option<Document>, CoreError> {
            if collection == "pricev2" {
                self.price_queries.lock().unwrap().push(json!({"filter":egdata_infra::bson_json::bson_doc_to_js_json(&filter),"sort":options.sort}));
            }
            self.find_one(collection, filter, options.projection).await
        }
        async fn find_one(
            &self,
            collection: &str,
            filter: Document,
            _: Option<Document>,
        ) -> Result<Option<Document>, CoreError> {
            *self.find_one_calls.lock().unwrap() += 1;
            if collection == "assets" {
                self.asset_queries
                    .lock()
                    .unwrap()
                    .push(egdata_infra::bson_json::bson_doc_to_js_json(&filter));
                if let Some(barrier) = &self.asset_barrier {
                    let name = filter
                        .get_document("artifactId")
                        .unwrap()
                        .get_str("$eq")
                        .unwrap();
                    barrier.wait().await;
                    if name == "reject" {
                        return Err(CoreError::Internal("fixture asset rejected".into()));
                    }
                    return Ok(Some(
                        doc! {"downloadSizeBytes":if name=="first" {11}else{22}},
                    ));
                }
                if self.timed_assets {
                    let name = filter
                        .get_document("artifactId")
                        .unwrap()
                        .get_str("$eq")
                        .unwrap();
                    if name == "never" {
                        std::future::pending::<()>().await;
                    }
                    if name.starts_with("delayed") {
                        tokio::task::yield_now().await;
                    }
                    if name.ends_with("reject") {
                        return Err(CoreError::Internal("asset lookup failed".into()));
                    }
                }
            }
            *self.one_last.lock().unwrap() = Some((collection.into(), filter, None));
            if self.fail_reads.as_deref() == Some(collection) {
                return Err(CoreError::Internal("fixture read failed".into()));
            }
            Ok(self.singles.get(collection).cloned())
        }
        async fn find_many(
            &self,
            collection: &str,
            filter: Document,
            options: MongoFindOptions,
        ) -> Result<Vec<Document>, CoreError> {
            let fixture = if collection == "offers"
                && filter.contains_key("id")
                && (self.collection_docs.contains_key("nestedOffers")
                    || self.fail_reads.as_deref() == Some("nestedOffers"))
            {
                "nestedOffers"
            } else {
                collection
            };
            *self.last.lock().unwrap() = Some((collection.into(), filter, options));
            if self.fail_reads.as_deref() == Some(fixture) {
                return Err(CoreError::Internal("fixture read failed".into()));
            }
            Ok(self
                .collection_docs
                .get(fixture)
                .cloned()
                .unwrap_or_else(|| self.docs.clone()))
        }
        async fn aggregate(
            &self,
            collection: &str,
            stages: Vec<Document>,
        ) -> Result<Vec<Document>, CoreError> {
            *self.pipeline.lock().unwrap() = stages;
            if self.fail_reads.as_deref() == Some(collection) {
                return Err(CoreError::Internal("fixture aggregation failed".into()));
            }
            Ok(self
                .collection_docs
                .get(collection)
                .cloned()
                .unwrap_or_default())
        }
        async fn count_documents(&self, collection: &str, _: Document) -> Result<u64, CoreError> {
            Ok(self
                .collection_docs
                .get(collection)
                .map_or(0, |rows| rows.len() as u64))
        }
        async fn distinct(&self, _: &str, _: &str, _: Document) -> Result<Vec<Bson>, CoreError> {
            Ok(vec![])
        }
        async fn insert_one(&self, _: &str, _: Document) -> Result<(), CoreError> {
            Ok(())
        }
        async fn update_one(
            &self,
            _: &str,
            _: Document,
            _: Document,
            _: bool,
        ) -> Result<u64, CoreError> {
            Ok(0)
        }
        async fn delete_one(&self, _: &str, _: Document) -> Result<u64, CoreError> {
            Ok(0)
        }
        async fn ping(&self) -> Result<bool, CoreError> {
            Ok(true)
        }
    }

    #[async_trait]
    impl egdata_core::ports::ResponseCachePort for ItemMongo {
        async fn get(&self, key: &str) -> Result<Option<String>, CoreError> {
            Ok(self.cache.lock().unwrap().get(key).cloned())
        }
        async fn set(&self, key: &str, value: &str, ttl: u64) -> Result<(), CoreError> {
            *self.cache_sets.lock().unwrap() += 1;
            self.cache_ttls.lock().unwrap().push(ttl);
            self.cache.lock().unwrap().insert(key.into(), value.into());
            Ok(())
        }
        async fn del(&self, key: &str) -> Result<(), CoreError> {
            self.cache.lock().unwrap().remove(key);
            Ok(())
        }
        async fn ping(&self) -> Result<bool, CoreError> {
            Ok(true)
        }
    }

    #[tokio::test]
    async fn item_offer_http_matches_canonical_node_oracle() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../egdata-api/tests/fixtures/catalog-http-node.json"
        ))
        .unwrap();
        for case_name in [
            "item-offer-linked",
            "item-offer-missing",
            "item-offer-no-eligible-offer",
            "item-offer-country-blocked",
            "item-offer-localized-locale-fallback",
            "item-offer-localized-translated-price",
            "item-offer-localized-bom-locale",
            "item-offer-nel-locale-rejected",
            "item-offer-invalid-locale",
            "item-offer-unknown-query",
            "item-offer-cache-hit-not-found",
            "item-offer-malformed-cache-falls-through",
        ] {
            let expected = fixture
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v["name"] == case_name)
                .unwrap();
            let input = &expected["input"];
            let mut cache = HashMap::new();
            if case_name == "item-offer-cache-hit-not-found" {
                cache.insert(
                    v1_cache_key(
                        "items.offer",
                        &BTreeMap::from([
                            ("id", json!("item-cache-hit")),
                            ("region", json!("US")),
                            ("locale", json!("en-US")),
                        ]),
                    ),
                    input["cache"].to_string(),
                );
            } else if case_name == "item-offer-malformed-cache-falls-through" {
                cache.insert(
                    v1_cache_key(
                        "items.offer",
                        &BTreeMap::from([
                            ("id", json!("item-cache-malformed")),
                            ("region", json!("US")),
                            ("locale", json!("en-US")),
                        ]),
                    ),
                    input["cache"].as_str().unwrap().to_owned(),
                );
            }
            let documents = |key: &str| -> Vec<Document> {
                input[key]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|value| bson::to_document(value).unwrap())
                    .collect()
            };
            let mut singles = HashMap::new();
            if input["item"].is_object() {
                singles.insert("items".into(), bson::to_document(&input["item"]).unwrap());
            }

            if input["price"].is_object() {
                singles.insert(
                    "pricev2".into(),
                    bson::to_document(&input["price"]).unwrap(),
                );
            }
            let localizations = if input["localization"].is_object() {
                let mut localization = bson::to_document(&input["localization"]).unwrap();
                if let Some(fetched_at) = input["localization"]["fetchedAt"].as_str() {
                    localization.insert(
                        "fetchedAt",
                        bson::DateTime::parse_rfc3339_str(fetched_at).unwrap(),
                    );
                }
                vec![localization]
            } else {
                vec![]
            };
            let mongo = Arc::new(ItemMongo {
                singles,
                collection_docs: HashMap::from([
                    ("offersubitems".into(), documents("subItems")),
                    ("offers".into(), documents("offers")),
                    ("egs_localizations".into(), localizations),
                ]),
                cache: Mutex::new(cache),
                ..Default::default()
            });
            let mut state =
                egdata_api_test_support::test_app_state(crate::state::ApiConfig::default());
            state.mongo = mongo.clone();
            state.cache = mongo;
            let app = route_group("/v1").router.with_state(state);
            let uri = expected["request"]["path"].as_str().unwrap();
            let mut request = Request::builder().uri(uri).body(Body::empty()).unwrap();
            request
                .extensions_mut()
                .insert(crate::helpers::V1RequestContext {
                    request_id: "req_node_oracle".into(),
                    key: None,
                });
            let response = app.oneshot(request).await.unwrap();
            let actual = egdata_api_test_support::capture_response(response).await;
            assert_eq!(actual, expected["response"], "{case_name}");
        }
    }

    #[tokio::test]
    async fn item_bulk_offer_cases_match_node_oracle() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../egdata-api/tests/fixtures/catalog-http-node.json"
        ))
        .unwrap();
        for case_name in [
            "item-offers-direct-linked-missing",
            "item-offers-duplicates-and-unknown",
            "item-offers-all-unknown",
            "item-offers-empty",
            "item-offers-country-blocked",
        ] {
            let expected = fixture
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v["name"] == case_name)
                .unwrap();
            let documents = |key: &str| -> Vec<Document> {
                expected["input"][key]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|value| bson::to_document(value).unwrap())
                    .collect()
            };
            let mut offers = documents("direct");
            offers.extend(documents("linkedOffers"));
            let mongo = Arc::new(ItemMongo {
                collection_docs: HashMap::from([
                    ("offersubitems".into(), documents("linked")),
                    ("offers".into(), offers),
                ]),
                ..Default::default()
            });
            let mut state =
                egdata_api_test_support::test_app_state(crate::state::ApiConfig::default());
            state.mongo = mongo.clone();
            state.cache = mongo;
            let app = route_group("/v1").router.with_state(state);
            let mut request = Request::builder()
                .method(expected["request"]["method"].as_str().unwrap())
                .uri(expected["request"]["path"].as_str().unwrap())
                .header("content-type", "application/json")
                .body(Body::from(expected["request"]["body"].to_string()))
                .unwrap();
            request
                .extensions_mut()
                .insert(crate::helpers::V1RequestContext {
                    request_id: "req_node_oracle".into(),
                    key: None,
                });
            let response = app.oneshot(request).await.unwrap();
            let actual = egdata_api_test_support::capture_response(response).await;
            assert_eq!(actual, expected["response"], "{case_name}");
        }
    }

    #[tokio::test]
    async fn item_detail_and_assets_reads_match_node_oracle() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../egdata-api/tests/fixtures/catalog-reads-http-node.json"
        ))
        .unwrap();
        for case_name in [
            "item-detail-populated",
            "item-detail-missing",
            "item-assets-populated",
            "item-assets-empty",
        ] {
            let expected = fixture
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v["name"] == case_name)
                .unwrap();
            let input = &expected["input"];
            let mut singles = HashMap::new();
            if input["item"].is_object() {
                singles.insert("items".into(), bson::to_document(&input["item"]).unwrap());
            }
            let assets: Vec<Document> = input["assets"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|v| {
                    let mut document = bson::to_document(v).unwrap();
                    if input["bsonTypes"]["sizeBytes"] == "double" {
                        document
                            .insert("sizeBytes", Bson::Double(v["sizeBytes"].as_f64().unwrap()));
                    }
                    document
                })
                .collect();
            let mongo = Arc::new(ItemMongo {
                singles,
                collection_docs: HashMap::from([("assets".into(), assets)]),
                ..Default::default()
            });
            let mut state =
                egdata_api_test_support::test_app_state(crate::state::ApiConfig::default());
            state.mongo = mongo.clone();
            state.cache = mongo.clone();
            let app = route_group("/v1").router.with_state(state);
            let mut request = Request::builder()
                .uri(expected["request"]["path"].as_str().unwrap())
                .body(Body::empty())
                .unwrap();
            request
                .extensions_mut()
                .insert(crate::helpers::V1RequestContext {
                    request_id: "req_node_oracle".into(),
                    key: None,
                });
            let response = app.oneshot(request).await.unwrap();
            let actual = egdata_api_test_support::capture_response(response).await;
            assert_eq!(actual, expected["response"], "{case_name}");
            if case_name.starts_with("item-assets") {
                assert_eq!(mongo.last.lock().unwrap().as_ref().unwrap().0, "assets");
                assert_eq!(
                    mongo.last.lock().unwrap().as_ref().unwrap().1,
                    doc! {"itemId":expected["request"]["path"].as_str().unwrap().split('/').nth(3).unwrap()}
                );
            }
            if case_name.starts_with("item-detail") {
                let call = mongo.one_last.lock().unwrap().clone().unwrap();
                assert_eq!(call.0, "items");
                assert_eq!(
                    call.1,
                    doc! {"$or":[{"_id":{"$eq":expected["request"]["path"].as_str().unwrap().split('/').nth(3).unwrap()}},{"id":{"$eq":expected["request"]["path"].as_str().unwrap().split('/').nth(3).unwrap()}}]}
                );
            }
        }
    }

    #[tokio::test]
    async fn item_list_bulk_builds_changelog_reads_match_node_oracle() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../egdata-api/tests/fixtures/catalog-reads-http-node.json"
        ))
        .unwrap();
        let names = [
            "items-list-populated",
            "items-list-empty",
            "items-bulk-populated",
            "item-builds-empty",
            "item-changelog-empty",
        ];
        for expected in fixture.as_array().unwrap().iter().filter(|entry| {
            let name = entry["name"].as_str().unwrap();
            name.starts_with("item-wave-") || names.contains(&name)
        }) {
            let name = expected["name"].as_str().unwrap();
            let input = &expected["input"];
            let document = |value: &Value| {
                Bson::try_from(value.clone())
                    .unwrap()
                    .as_document()
                    .unwrap()
                    .clone()
            };
            let documents = input["items"]
                .as_array()
                .into_iter()
                .flatten()
                .map(document)
                .collect::<Vec<_>>();
            let mut singles = HashMap::new();
            if input["item"].is_object() {
                singles.insert("items".into(), document(&input["item"]));
            }
            if input["sortedPrice"].is_object() {
                singles.insert("pricev2".into(), document(&input["sortedPrice"]));
            }
            let assets = input["assets"]
                .as_array()
                .into_iter()
                .flatten()
                .map(document)
                .collect();
            let mongo = Arc::new(ItemMongo {
                docs: documents.clone(),
                singles,
                fail_reads: input["failReads"].as_str().map(str::to_owned),
                timed_assets: input["timedAssets"] == true,
                asset_barrier: input["assetBarrier"]
                    .as_u64()
                    .map(|n| Arc::new(tokio::sync::Barrier::new(n as usize))),
                collection_docs: {
                    let mut by_collection =
                        HashMap::from([("items".into(), documents), ("assets".into(), assets)]);
                    for (name, key) in [
                        ("changelogs_v2", "historyRows"),
                        ("offers", "offers"),
                        ("offersubitems", "subItems"),
                        ("nestedOffers", "nestedOffers"),
                        ("builds", "builds"),
                        ("pricev2", "prices"),
                    ] {
                        if let Some(rows) = input[key].as_array() {
                            by_collection.insert(
                                name.into(),
                                rows.iter()
                                    .map(|value| bson::to_document(value).unwrap())
                                    .collect(),
                            );
                        }
                    }
                    by_collection
                },
                ..Default::default()
            });
            if let (Some(key), Some(payload)) =
                (input["cacheKey"].as_str(), input.get("cachePayload"))
            {
                mongo
                    .cache
                    .lock()
                    .unwrap()
                    .insert(key.into(), payload.to_string());
            }
            let mut state =
                egdata_api_test_support::test_app_state(crate::state::ApiConfig::default());
            state.now = || {
                chrono::DateTime::parse_from_rfc3339("2026-11-17T00:00:00Z")
                    .unwrap()
                    .to_utc()
            };
            state.mongo = mongo.clone();
            state.cache = mongo.clone();
            let full = input["middleware"] == true;
            let routes = if full {
                crate::router(&state)
            } else {
                route_group("/v1").router
            };
            let app = routes.with_state(state);
            let method = expected["request"]["method"].as_str().unwrap_or("GET");
            let mut builder = Request::builder()
                .method(method)
                .uri(expected["request"]["path"].as_str().unwrap());
            if full {
                builder = builder
                    .header("x-egdata-key-id", "key_oracle")
                    .header("x-egdata-key-tier", "free")
                    .header("x-request-id", "req_node_oracle");
                if let Some(tag) = input["ifNoneMatch"].as_str() {
                    builder = builder.header("if-none-match", tag);
                }
            }
            if method == "POST" {
                builder = builder.header(
                    "content-type",
                    expected["request"]["contentType"]
                        .as_str()
                        .unwrap_or("application/json"),
                );
            }
            let body = expected["request"]["rawBody"]
                .as_str()
                .map(|s| Body::from(s.to_owned()))
                .or_else(|| {
                    expected["request"]
                        .get("body")
                        .map(|v| Body::from(v.to_string()))
                })
                .unwrap_or_else(Body::empty);
            let body = if input["interruptedBody"] == true {
                Body::from_stream(futures::stream::once(async {
                    Err::<axum::body::Bytes, _>(std::io::Error::other("request body interrupted"))
                }))
            } else {
                body
            };
            let mut request = builder.body(body).unwrap();
            request
                .extensions_mut()
                .insert(crate::helpers::V1RequestContext {
                    request_id: "req_node_oracle".into(),
                    key: None,
                });
            let response =
                tokio::time::timeout(std::time::Duration::from_secs(3), app.oneshot(request))
                    .await
                    .expect("an asset failure must not wait for an unresponsive sibling")
                    .unwrap();
            let actual = egdata_api_test_support::capture_response(response).await;
            assert_eq!(actual, expected["response"], "{name}");
            if let Some(queries) = input.get("assetQueries") {
                assert_eq!(
                    json!(*mongo.asset_queries.lock().unwrap()),
                    *queries,
                    "{name} asset joins"
                );
            }
            if let Some(queries) = input.get("priceQueries") {
                assert_eq!(
                    json!(*mongo.price_queries.lock().unwrap()),
                    *queries,
                    "{name} latest price query"
                );
            }
            if let Some(pipeline) = input.get("pipeline") {
                let captured: Vec<_> = mongo
                    .pipeline
                    .lock()
                    .unwrap()
                    .iter()
                    .map(egdata_infra::bson_json::bson_doc_to_js_json)
                    .collect();
                assert_eq!(json!(captured), *pipeline, "{name} history aggregate");
                if let Some(expected) = input.get("wireMatch") {
                    assert_eq!(
                        mongo.pipeline.lock().unwrap()[0]
                            .get_document("$match")
                            .unwrap(),
                        &bson::to_document(expected).unwrap(),
                        "{name} BSON match"
                    );
                }
            }
            if let Some(args) = input["queries"]["itemFind"].get(0) {
                let last = mongo.last.lock().unwrap();
                if let Some((collection, filter, options)) = &*last {
                    assert_eq!(collection, "items", "{name} item lookup");
                    if let Some(expected) = input.get("wireFilter") {
                        assert_eq!(
                            filter,
                            &bson::to_document(expected).unwrap(),
                            "{name} BSON filter"
                        );
                    }
                    assert_eq!(
                        egdata_infra::bson_json::bson_doc_to_js_json(filter),
                        args[0],
                        "{name} item filter"
                    );
                    if args.get(2).is_some() {
                        assert_eq!(json!(options.limit), args[2]["limit"], "{name} item limit");
                        assert_eq!(json!(options.sort), args[2]["sort"], "{name} item sort");
                    }
                }
            }
            if let Some(write) = input.get("cacheWrite") {
                if write.is_null() {
                    // The independent total cache still fills when the page aggregate fails.
                    let expected = usize::from(name.ends_with("history-aggregate-outage"));
                    assert_eq!(
                        *mongo.cache_sets.lock().unwrap(),
                        expected,
                        "{name} unexpected cache write"
                    );
                } else {
                    let key = write[0].as_str().unwrap();
                    let cache = mongo.cache.lock().unwrap();
                    let payload: Value = serde_json::from_str(&cache[key]).unwrap();
                    assert_eq!(payload, write[1], "{name} cache payload");
                    assert_eq!(
                        mongo.cache_ttls.lock().unwrap().last().copied(),
                        write[2].as_u64(),
                        "{name} cache TTL"
                    );
                }
            }
            if name.starts_with("items-list") {
                let call = mongo.last.lock().unwrap().clone().unwrap();
                assert_eq!(call.0, "items");
                assert_eq!(call.2.sort, Some(doc! {"lastModifiedDate":-1,"id":1}));
            }
        }
    }

    #[tokio::test]
    async fn list_uses_stable_keyset_query_and_serializes_the_bounded_page() {
        let mongo = Arc::new(ItemMongo {
            docs: vec![
                doc! {"id":"item-a","title":"A","lastModifiedDate":bson::DateTime::from_millis(20)},
                doc! {"id":"item-b","title":"B","lastModifiedDate":bson::DateTime::from_millis(10)},
            ],
            ..Default::default()
        });
        let mut state =
            egdata_api_test_support::test_app_state(crate::state::ApiConfig::default());
        state.mongo = mongo.clone();
        let app = route_group("/v1").router.with_state(state);
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/v1/items?limit=1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(body["data"][0]["id"], "item-a");
        assert_eq!(body["meta"]["pagination"]["hasMore"], true);
        assert!(body["meta"]["pagination"]["nextCursor"].as_str().is_some());
        let last = mongo.last.lock().unwrap().clone().unwrap();
        assert_eq!(last.0, "items");
        assert_eq!(last.1, Document::new());
        assert_eq!(last.2.limit, Some(2));
        assert_eq!(last.2.sort, Some(doc! {"lastModifiedDate":-1,"id":1}));
    }

    #[tokio::test]
    async fn builds_cache_miss_populates_node_shaped_result_and_hit_skips_mongo() {
        let mongo = Arc::new(ItemMongo {
            singles: HashMap::from([(
                "items".to_owned(),
                doc! {"id":"item-a","releaseInfo":[{"appId":"app-a"}]},
            )]),
            docs: vec![doc! {
                "_id":"build-a",
                "appName":"app-a",
                "buildVersion":"1.2.3",
                "labelName":"prod-Windows",
                "hash":"source-hash",
                "technologies":["Unreal"],
            }],
            ..Default::default()
        });
        let mut state =
            egdata_api_test_support::test_app_state(crate::state::ApiConfig::default());
        state.mongo = mongo.clone();
        state.cache = mongo.clone();
        let app = route_group("/v1").router.with_state(state);
        let request = || {
            Request::builder()
                .uri("/v1/items/%20item-a%20/builds")
                .body(Body::empty())
                .unwrap()
        };
        let response = app.clone().oneshot(request()).await.unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let first: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(first["data"][0]["id"], "build-a");
        assert_eq!(first["data"][0]["appName"], "app-a");
        assert_eq!(first["data"][0]["buildVersion"], "1.2.3");
        assert_eq!(first["data"][0]["platform"], "Windows");
        assert_eq!(first["data"][0]["manifest"]["status"], "legacy_unverified");
        assert_eq!(first["meta"]["count"], 1);
        assert_eq!(*mongo.cache_sets.lock().unwrap(), 1);
        assert_eq!(*mongo.cache_ttls.lock().unwrap(), vec![120]);
        assert_eq!(*mongo.find_one_calls.lock().unwrap(), 2);

        let response = app.clone().oneshot(request()).await.unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let second: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(second, first);
        assert_eq!(*mongo.cache_sets.lock().unwrap(), 1);
        assert_eq!(*mongo.find_one_calls.lock().unwrap(), 2);

        let too_long = "x".repeat(201);
        let response = app
            .oneshot(
                Request::builder()
                    .uri(format!("/v1/items/{too_long}/builds"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(*mongo.cache_sets.lock().unwrap(), 1);
        assert_eq!(*mongo.find_one_calls.lock().unwrap(), 2);
    }

    #[tokio::test]
    async fn unknown_query_key_is_a_problem_and_does_not_touch_mongo() {
        let mongo = Arc::new(ItemMongo::default());
        let mut state =
            egdata_api_test_support::test_app_state(crate::state::ApiConfig::default());
        state.mongo = mongo.clone();
        let app = route_group("/v1").router.with_state(state);
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/v1/items?sort=title")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
        let body: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(body["code"], "INVALID_QUERY");
        assert!(mongo.last.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn missing_cursor_secret_returns_problem_when_another_page_exists() {
        let mongo = Arc::new(ItemMongo {
            singles: HashMap::from([("items".into(), doc! {"id":"item-a"})]),
            collection_docs: HashMap::from([
                ("assets".into(), vec![]),
                (
                    "changelogs_v2".into(),
                    vec![
                        doc! {"_id":"change-a","timestamp":bson::DateTime::from_millis(20)},
                        doc! {"_id":"change-b","timestamp":bson::DateTime::from_millis(10)},
                    ],
                ),
            ]),
            docs: vec![
                doc! {"id":"item-a","lastModifiedDate":bson::DateTime::from_millis(20)},
                doc! {"id":"item-b","lastModifiedDate":bson::DateTime::from_millis(10)},
            ],
            ..Default::default()
        });
        let mut state = egdata_api_test_support::test_app_state(crate::state::ApiConfig {
            v1_cursor_secret: None,
            ..Default::default()
        });
        state.mongo = mongo;
        let app = route_group("/v1").router.with_state(state);
        for uri in ["/v1/items?limit=1", "/v1/items/item-a/changelog?limit=1"] {
            let response = app
                .clone()
                .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                axum::http::StatusCode::SERVICE_UNAVAILABLE
            );
            let body: Value =
                serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                    .unwrap();
            assert_eq!(body["code"], "CURSOR_NOT_CONFIGURED");
        }
    }

    #[tokio::test]
    async fn item_list_reads_pagination_from_previous_rust_cache_entries() {
        let store = Arc::new(ItemMongo::default());
        let key = v1_cache_key(
            "items.list",
            &BTreeMap::from([("limit", json!(1)), ("cursor", Value::Null)]),
        );
        let data = json!([{"id":"cached"}]);
        let meta = json!({"count":1,"pagination":{"limit":1,"hasMore":true,"nextCursor":"saved"}});
        store
            .cache
            .lock()
            .unwrap()
            .insert(key, json!({"data":data,"meta":meta}).to_string());
        let mut state =
            egdata_api_test_support::test_app_state(crate::state::ApiConfig::default());
        state.cache = store.clone();
        state.mongo = store.clone();
        let response = route_group("/v1")
            .router
            .with_state(state)
            .oneshot(
                Request::builder()
                    .uri("/v1/items?limit=1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(body["data"], data);
        assert_eq!(body["meta"], meta);
        assert!(store.last.lock().unwrap().is_none());
        assert_eq!(*store.cache_sets.lock().unwrap(), 0);
    }

    #[tokio::test]
    async fn bulk_cache_hit_reads_node_payload_without_mongo_or_refreshing_ttl() {
        let store = Arc::new(ItemMongo::default());
        let ids = vec!["item-node".to_string()];
        let key = v1_cache_key("items.bulk", &BTreeMap::from([("ids", json!(ids))]));
        store.cache.lock().unwrap().insert(
            key,
            json!({"data":[{"id":"item-node","title":"From Node"}],"missing":[]}).to_string(),
        );
        let mut state =
            egdata_api_test_support::test_app_state(crate::state::ApiConfig::default());
        state.mongo = store.clone();
        state.cache = store.clone();
        let app = route_group("/v1").router.with_state(state);
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/items/bulk")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"items":["item-node"]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let body: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(body["data"][0]["title"], "From Node");
        assert_eq!(body["meta"]["missing"], json!([]));
        assert!(store.last.lock().unwrap().is_none());
        assert_eq!(*store.cache_sets.lock().unwrap(), 0);
    }

    #[tokio::test]
    async fn bulk_offers_cache_hit_reads_node_payload_without_mongo_or_refreshing_ttl() {
        let store = Arc::new(ItemMongo::default());
        let ids = vec!["item-node".to_string()];
        let regional = regional_params(None, None).unwrap();
        let key = v1_cache_key(
            "items.bulkOffers",
            &BTreeMap::from([
                ("ids", json!(ids)),
                ("country", json!(regional.country)),
                ("region", json!(regional.region)),
                ("locale", json!(regional.locale)),
            ]),
        );
        store.cache.lock().unwrap().insert(
            key,
            json!({"data":{"item-node":null},"found":0}).to_string(),
        );
        let mut state =
            egdata_api_test_support::test_app_state(crate::state::ApiConfig::default());
        state.mongo = store.clone();
        state.cache = store.clone();
        let app = route_group("/v1").router.with_state(state);
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/items/bulk/offers")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"items":["item-node"]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let body: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(body["data"]["item-node"], Value::Null);
        assert_eq!(body["meta"]["found"], 0);
        assert!(store.last.lock().unwrap().is_none());
        assert_eq!(*store.cache_sets.lock().unwrap(), 0);
    }

    #[tokio::test]
    async fn bulk_validation_matches_node_generated_fixtures() {
        let fixtures: Vec<Value> = serde_json::from_str(include_str!(
            "../../../egdata-api/tests/fixtures/items-bulk-validation.json"
        ))
        .unwrap();
        for fixture in fixtures {
            let mut value = fixture["body"].clone();
            if fixture["name"] == "too_many" {
                value["items"] = json!(vec!["x"; 101]);
            }
            let request = Request::builder()
                .uri("/v1/items/bulk")
                .header("content-type", "application/json")
                .body(Body::from(value.to_string()))
                .unwrap();
            let response = error(
                body_ids(request).await.unwrap_err(),
                &"/v1/items/bulk".parse().unwrap(),
                String::new(),
            );
            let problem: Value =
                serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                    .unwrap();
            assert_eq!(
                problem["code"], fixture["expected"]["code"],
                "{}",
                fixture["name"]
            );
            assert_eq!(
                problem["detail"], fixture["expected"]["detail"],
                "{}",
                fixture["name"]
            );
            assert_eq!(
                problem["errors"], fixture["expected"]["errors"],
                "{}",
                fixture["name"]
            );
        }
        let id = "😀".repeat(100);
        let request = Request::builder()
            .uri("/v1/items/bulk")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"items":[format!(" {id} "),id]}).to_string(),
            ))
            .unwrap();
        assert_eq!(body_ids(request).await.unwrap(), vec![id]);
    }
}
