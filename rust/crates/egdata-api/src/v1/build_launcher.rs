//! Bounded launcher metadata resolution, shared with the eventual legacy route.
//! Source: src/routes/build-launcher-records.ts.
use super::{
    RouteGroup,
    helpers::{V1RequestContext, json_success, parse_strict_query_uri, problem_response},
    system::internal_error,
};
use crate::state::AppState;
use axum::{
    body::to_bytes,
    extract::{Request, State},
    http::header,
    response::Response,
};
use bson::{Document, doc};
use egdata_core::{
    ports::MongoFindOptions,
    v1::{ProblemError, ProblemIssue, require_json_content_type},
};
use egdata_infra::bson_json::bson_doc_to_js_json;
use serde_json::{Value, json};
use std::collections::HashSet;

pub fn route_group(prefix: &str) -> RouteGroup {
    RouteGroup::new(prefix).post("/builds/resolve-launcher-records", resolve)
}
async fn resolve(State(state): State<AppState>, request: Request) -> Response {
    let uri = request.uri().clone();
    let method = request.method().clone();
    let id = request
        .extensions()
        .get::<V1RequestContext>()
        .map(|c| c.request_id.clone())
        .unwrap_or_default();
    let result = async {
        parse_strict_query_uri(&uri, &[])?;
        require_json_content_type(
            request
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
        )?;
        let bytes = to_bytes(request.into_body(), usize::MAX)
            .await
            .map_err(|_| malformed())?;
        let body: Value = serde_json::from_slice(&bytes).map_err(|_| malformed())?;
        let candidates = validate(body)?;
        let mut results = Vec::new();
        for candidate in candidates {
            results.push(resolve_candidate(&state, &candidate).await?);
        }
        Ok::<_, ProblemError>(results)
    }
    .await;
    match result {
        Ok(results) => json_success(
            &method,
            uri.path(),
            &id,
            json!({"results":results}),
            Some(json!({"count":results.len()})),
        ),
        Err(e) => problem_response(&e, uri.path(), Some(&id)),
    }
}
fn malformed() -> ProblemError {
    ProblemError::new(400, "MALFORMED_JSON", "The request body is not valid JSON.")
}
fn issue(path: &[String], code: &str, message: String) -> ProblemIssue {
    ProblemIssue {
        parameter: path.first().cloned(),
        pointer: (!path.is_empty()).then(|| {
            format!(
                "/{}",
                path.iter()
                    .map(|p| p.replace('~', "~0").replace('/', "~1"))
                    .collect::<Vec<_>>()
                    .join("/")
            )
        }),
        code: code.into(),
        message,
    }
}
fn invalid_type(value: Option<&Value>, expected: &str, path: &[String]) -> ProblemIssue {
    let received = match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    };
    issue(
        path,
        "INVALID_TYPE",
        format!("Invalid input: expected {expected}, received {received}"),
    )
}
fn check_keys(value: &Value, keys: &[&str], path: &[String], issues: &mut Vec<ProblemIssue>) {
    let object = value
        .as_object()
        .expect("strict key checks follow object validation");
    let unknown: Vec<_> = object
        .keys()
        .filter(|k| !keys.contains(&k.as_str()))
        .collect();
    if !unknown.is_empty() {
        issues.push(issue(
            path,
            "UNRECOGNIZED_KEYS",
            format!(
                "Unrecognized {}: {}",
                if unknown.len() == 1 { "key" } else { "keys" },
                unknown
                    .iter()
                    .map(|s| serde_json::to_string(s).unwrap())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        ));
    }
}
fn text_field(
    object: &mut Value,
    key: &str,
    min: usize,
    max: usize,
    path: &[String],
    issues: &mut Vec<ProblemIssue>,
) {
    let mut path = path.to_vec();
    path.push(key.into());
    let Some(value) = object.get(key).and_then(Value::as_str) else {
        issues.push(invalid_type(object.get(key), "string", &path));
        if let Some(values) = object.get(key).and_then(Value::as_array) {
            if values.len() < min {
                issues.push(issue(
                    &path,
                    "TOO_SMALL",
                    format!("Too small: expected array to have >={min} items"),
                ));
            }
            if values.len() > max {
                issues.push(issue(
                    &path,
                    "TOO_BIG",
                    format!("Too big: expected array to have <={max} items"),
                ));
            }
        }
        return;
    };
    let value = egdata_core::v1::trim_js_whitespace(value).to_owned();
    let len = value.encode_utf16().count();
    if len < min {
        issues.push(issue(
            &path,
            "TOO_SMALL",
            format!("Too small: expected string to have >={min} characters"),
        ));
    }
    if len > max {
        issues.push(issue(
            &path,
            "TOO_BIG",
            format!("Too big: expected string to have <={max} characters"),
        ));
    }
    object[key] = json!(value);
}
pub(crate) fn validate(mut body: Value) -> Result<Vec<Value>, ProblemError> {
    let mut issues = Vec::new();
    if !body.is_object() {
        issues.push(invalid_type(Some(&body), "object", &[]));
    } else {
        match body.get_mut("candidates") {
            Some(Value::Array(candidates)) => {
                for (i, candidate) in candidates.iter_mut().enumerate() {
                    let path = vec!["candidates".into(), i.to_string()];
                    if !candidate.is_object() {
                        issues.push(invalid_type(Some(candidate), "object", &path));
                        continue;
                    }
                    text_field(candidate, "requestId", 1, 128, &path, &mut issues);
                    text_field(candidate, "buildAppName", 1, 256, &path, &mut issues);
                    text_field(candidate, "buildVersion", 0, 512, &path, &mut issues);
                    if candidate["platform"] != "Windows" {
                        let mut p = path.clone();
                        p.push("platform".into());
                        issues.push(issue(
                            &p,
                            "INVALID_VALUE",
                            "Invalid input: expected \"Windows\"".into(),
                        ));
                    }
                    if let Some(hint) = candidate.get_mut("catalogHint") {
                        let mut p = path.clone();
                        p.push("catalogHint".into());
                        if !hint.is_object() {
                            issues.push(invalid_type(Some(hint), "object", &p));
                        } else {
                            for key in ["artifactId", "catalogItemId", "catalogNamespace"] {
                                text_field(hint, key, 1, 256, &p, &mut issues);
                            }
                            check_keys(
                                hint,
                                &["artifactId", "catalogItemId", "catalogNamespace"],
                                &p,
                                &mut issues,
                            );
                        }
                    }
                    check_keys(
                        candidate,
                        &[
                            "requestId",
                            "buildAppName",
                            "buildVersion",
                            "platform",
                            "catalogHint",
                        ],
                        &path,
                        &mut issues,
                    );
                }
                if candidates.is_empty() {
                    issues.push(issue(
                        &["candidates".into()],
                        "TOO_SMALL",
                        "Too small: expected array to have >=1 items".into(),
                    ));
                }
                if candidates.len() > 100 {
                    issues.push(issue(
                        &["candidates".into()],
                        "TOO_BIG",
                        "Too big: expected array to have <=100 items".into(),
                    ));
                }
            }
            value => {
                issues.push(invalid_type(
                    value.as_deref(),
                    "array",
                    &["candidates".into()],
                ));
                // Zod's length checks also run on an invalid string input.
                if let Some(Value::String(value)) = value {
                    let len = value.encode_utf16().count();
                    if len == 0 {
                        issues.push(issue(
                            &["candidates".into()],
                            "TOO_SMALL",
                            "Too small: expected string to have >=1 characters".into(),
                        ));
                    }
                    if len > 100 {
                        issues.push(issue(
                            &["candidates".into()],
                            "TOO_BIG",
                            "Too big: expected string to have <=100 characters".into(),
                        ));
                    }
                }
            }
        }
        check_keys(&body, &["candidates"], &[], &mut issues);
        // Zod skips refinements after a non-continuable type/value/strict-key error.
        if issues
            .iter()
            .all(|e| e.code == "TOO_SMALL" || e.code == "TOO_BIG")
            && let Some(candidates) = body["candidates"].as_array()
        {
            let mut seen = HashSet::new();
            if candidates
                .iter()
                .any(|c| !seen.insert(c["requestId"].as_str().unwrap_or("")))
            {
                issues.push(issue(
                    &[],
                    "CUSTOM",
                    "requestId values must be unique".into(),
                ));
            }
        }
    }
    if !issues.is_empty() {
        return Err(ProblemError::new(400,"INVALID_BODY","One or more candidates are invalid or not supported. Each candidate must carry a unique `requestId`, a Windows platform, and bounded metadata without paths or manifest bytes.").with_errors(issues));
    }
    Ok(std::mem::take(body["candidates"].as_array_mut().unwrap()))
}
async fn find(
    state: &AppState,
    c: &str,
    f: Document,
    projection: Option<Document>,
) -> Result<Vec<Document>, ProblemError> {
    state
        .mongo
        .find_many(
            c,
            f,
            MongoFindOptions {
                projection,
                ..Default::default()
            },
        )
        .await
        .map_err(|_| internal_error())
}
fn string(value: &Value) -> String {
    if value.is_null() {
        String::new()
    } else {
        egdata_core::v1::serialization::js_string(value)
    }
}
#[derive(Debug)]
enum Identity {
    Found(Value),
    Missing,
    Ambiguous,
}
async fn identity(
    state: &AppState,
    item: &Value,
    preferred: Option<&str>,
) -> Result<Identity, ProblemError> {
    let assets = find(
        state,
        "assets",
        doc! {"itemId":{"$eq":string(&item["id"])}},
        None,
    )
    .await?;
    let selected: Vec<_> = assets
        .iter()
        .filter(|a| {
            string(&bson_doc_to_js_json(a)["platform"]).eq_ignore_ascii_case("windows")
                && preferred.is_none_or(|p| a.get_str("artifactId").ok() == Some(p))
        })
        .collect();
    if preferred.is_some() && selected.is_empty() {
        return Ok(Identity::Missing);
    }
    if selected.len() > 1 {
        return Ok(Identity::Ambiguous);
    }
    let artifact = preferred.map(str::to_owned).unwrap_or_else(|| {
        selected
            .first()
            .map(|a| string(&bson_doc_to_js_json(a)["artifactId"]))
            .unwrap_or_default()
    });
    let item_id = string(&item["id"]);
    let ns = string(&item["namespace"]);
    if artifact.is_empty() || item_id.is_empty() || ns.is_empty() {
        return Ok(Identity::Missing);
    }
    Ok(Identity::Found(
        json!({"artifactId":artifact,"catalogItemId":item_id,"catalogNamespace":ns}),
    ))
}
async fn offers_for_item(state: &AppState, id: &str) -> Result<Vec<Value>, ProblemError> {
    let mut offers = find(
        state,
        "offers",
        doc! {"items.id":{"$eq":id},"offerType":{"$in":["BASE_GAME","DLC"]}},
        None,
    )
    .await?;
    let sub = state
        .mongo
        .find_many(
            "offersubitems",
            doc! {"subItems.id":{"$eq":id}},
            MongoFindOptions {
                projection: Some(doc! {"_id":1}),
                ..Default::default()
            },
        )
        .await
        .map_err(|_| internal_error())?;
    if !sub.is_empty() {
        let ids: Vec<_> = sub
            .into_iter()
            .map(|mut row| row.remove("_id").unwrap_or(bson::Bson::Null))
            .collect();
        offers.extend(
            find(
                state,
                "offers",
                doc! {"id":{"$in":ids},"offerType":{"$in":["BASE_GAME","DLC"]}},
                None,
            )
            .await?,
        );
    }
    let mut unique = indexmap::IndexMap::new();
    for offer in &offers {
        let offer = bson_doc_to_js_json(offer);
        let id = string(
            offer
                .get("id")
                .filter(|v| !v.is_null())
                .unwrap_or(&offer["_id"]),
        );
        if id.is_empty() {
            continue;
        }
        unique.insert(id, offer);
    }
    Ok(unique.into_values().collect())
}
fn classify(item: &Value, offers: &[Value]) -> Option<&'static str> {
    let categories: Vec<_> = item["categories"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| c.as_str().or_else(|| c["path"].as_str()))
        .map(str::to_lowercase)
        .collect();
    if categories.iter().any(|p| p.contains("digitalextra")) {
        return Some("digital-extra");
    }
    if offers.iter().any(|o| o["offerType"] == "DLC")
        || categories
            .iter()
            .any(|p| p.contains("addon") || p.contains("dlc"))
    {
        return Some("addon");
    }
    if offers.iter().any(|o| o["offerType"] == "BASE_GAME")
        || (item["entitlementType"] == "EXECUTABLE" && item["itemType"] != "DURABLE")
    {
        return Some("base-game");
    }
    None
}
async fn main_game(
    state: &AppState,
    item: &Document,
    offers: &[Value],
) -> Result<Identity, ProblemError> {
    let base: Vec<_> = offers
        .iter()
        .filter(|o| o["offerType"] == "BASE_GAME")
        .collect();
    if base.len() != 1 {
        return Ok(if base.is_empty() {
            Identity::Missing
        } else {
            Identity::Ambiguous
        });
    }
    let ids: Vec<_> = base[0]["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.get("id"))
        .map(egdata_core::v1::serialization::js_string)
        .filter(|s| !s.is_empty())
        .collect();
    let items = find(state, "items", doc! {"id":{"$in":ids}}, None).await?;
    let id = super::helpers::primitive_id(item.get("id"));
    let items: Vec<_> = items
        .iter()
        .filter(|row| id.is_none() || super::helpers::primitive_id(row.get("id")) != id)
        .collect();
    let executable: Vec<_> = items
        .iter()
        .copied()
        .filter(|i| i.get_str("entitlementType").ok() == Some("EXECUTABLE"))
        .collect();
    let choices = if executable.is_empty() {
        items
    } else {
        executable
    };
    if choices.len() != 1 {
        return Ok(if choices.is_empty() {
            Identity::Missing
        } else {
            Identity::Ambiguous
        });
    }
    identity(state, &bson_doc_to_js_json(choices[0]), None).await
}
fn attributes(item: &Value, offers: &[Value]) -> Value {
    let mut out = serde_json::Map::new();
    for source in std::iter::once(item).chain(offers.iter()) {
        for attr in source["customAttributes"].as_array().into_iter().flatten() {
            if let (Some(key), Some(value)) = (attr["key"].as_str(), attr["value"].as_str())
                && !key.is_empty()
            {
                out.insert(key.into(), json!(value));
            }
        }
    }
    Value::Object(out)
}
fn boolean(attributes: &Value, key: &str, fallback: bool) -> bool {
    match attributes[key].as_str() {
        Some(v) if v.eq_ignore_ascii_case("true") => true,
        Some(v) if v.eq_ignore_ascii_case("false") => false,
        _ => fallback,
    }
}
fn process_names(value: &Value) -> Vec<String> {
    let Some(raw) = value
        .as_str()
        .filter(|s| !egdata_core::v1::trim_js_whitespace(s).is_empty())
    else {
        return vec![];
    };
    if let Ok(Value::Array(values)) = serde_json::from_str::<Value>(raw) {
        return values
            .into_iter()
            .filter_map(|v| v.as_str().filter(|s| !s.is_empty()).map(str::to_owned))
            .collect();
    }
    raw.split(',')
        .map(egdata_core::v1::trim_js_whitespace)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}
pub(crate) async fn resolve_candidate(
    state: &AppState,
    candidate: &Value,
) -> Result<Value, ProblemError> {
    let status = |s: &str| json!({"requestId":candidate["requestId"],"status":s});
    let hint = candidate.get("catalogHint");
    let query = if let Some(h) = hint {
        doc! {"id": {"$eq": string(&h["catalogItemId"])}, "namespace": {"$eq": string(&h["catalogNamespace"])}}
    } else {
        doc! {"releaseInfo": {"$elemMatch": {"appId": {"$eq": string(&candidate["buildAppName"])}, "platform": {"$regex": bson::Regex {pattern: "^Win".into(), options: "i".into()}}}}}
    };
    let items = find(state, "items", query, None).await?;
    if items.is_empty() {
        return Ok(status("not-found"));
    }
    if items.len() > 1 {
        return Ok(status("ambiguous"));
    }
    let item = &bson_doc_to_js_json(&items[0]);
    let identity = match identity(state, item, hint.and_then(|h| h["artifactId"].as_str())).await? {
        Identity::Found(v) => v,
        Identity::Missing => return Ok(status("unsupported")),
        Identity::Ambiguous => return Ok(status("ambiguous")),
    };
    let offers = offers_for_item(state, identity["catalogItemId"].as_str().unwrap()).await?;
    let Some(kind) = classify(item, &offers) else {
        return Ok(status("unsupported"));
    };
    let main = if kind == "base-game" {
        Value::Null
    } else {
        match main_game(state, &items[0], &offers).await? {
            Identity::Found(v) => v,
            Identity::Missing => return Ok(status("unsupported")),
            Identity::Ambiguous => return Ok(status("ambiguous")),
        }
    };
    let attrs = attributes(item, &offers);
    let mut record = identity;
    record["displayName"] = json!(string(
        item.get("title")
            .filter(|v| !v.is_null())
            .unwrap_or(&record["artifactId"])
    ));
    record["kind"] = json!(kind);
    record["appCategories"] = json!(match kind {
        "base-game" => vec!["public", "games", "applications"],
        "digital-extra" => vec!["digitalextras", "applications"],
        _ => vec!["addons"],
    });
    record["mainGame"] = main;
    record["mandatoryAppFolderName"] = json!(egdata_core::v1::trim_js_whitespace(
        attrs["FolderName"].as_str().unwrap_or("")
    ));
    record["canRunOffline"] = json!(boolean(&attrs, "CanRunOffline", true));
    record["requiresAuth"] = json!(boolean(&attrs, "RequiresAuth", true));
    record["ownershipToken"] = json!(boolean(&attrs, "OwnershipToken", false));
    record["ignoredProcessNames"] = json!(process_names(&attrs["IgnoredProcessNames"]));
    Ok(json!({"requestId":candidate["requestId"],"status":"resolved","record":record}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::v1::mongo_read_oracle::RecordedReads;
    use crate::{middleware::test_support::test_app_state, state::ApiConfig};
    use axum::{body::Body, http::StatusCode};
    use bson::Bson;
    use std::sync::Arc;
    use tower::ServiceExt;
    fn candidate() -> Value {
        json!({"requestId":"r","buildAppName":"app","buildVersion":"1","platform":"Windows","catalogHint":{"artifactId":"artifact","catalogItemId":"item","catalogNamespace":"ns"}})
    }
    fn item_query() -> Document {
        doc! {"id":{"$eq":"item"},"namespace":{"$eq":"ns"}}
    }
    fn asset_query(id: &str) -> Document {
        doc! {"itemId":{"$eq":id}}
    }
    fn direct_query() -> Document {
        doc! {"items.id":{"$eq":"item"},"offerType":{"$in":["BASE_GAME","DLC"]}}
    }
    fn sub_query() -> Document {
        doc! {"subItems.id":{"$eq":"item"}}
    }
    fn state(steps: Vec<(&str, Document, Vec<Document>)>) -> (AppState, Arc<RecordedReads>) {
        let trace:Vec<_>=steps.into_iter().map(|(collection, filter, rows)| {
            let options=if collection=="offersubitems" {json!({"projection":{"_id":1}})} else {json!({})};
            json!({"call":{"method":"many","collection":collection,"query":Bson::Document(filter).into_relaxed_extjson(),"options":options},
                "result":rows.into_iter().map(|doc|Bson::Document(doc).into_relaxed_extjson()).collect::<Vec<_>>()})
        }).collect();
        let store = Arc::new(RecordedReads::from_case(
            &json!({"name":"launcher record selection","trace":trace}),
        ));
        let mut state = test_app_state(ApiConfig::default());
        state.mongo = store.clone();
        (state, store)
    }
    #[tokio::test]
    async fn registered_launcher_selections_match_node() {
        crate::v1::mongo_read_oracle::replay_mongo_oracle(include_str!(
            "../../tests/fixtures/launcher-selection-http-node.json"
        ))
        .await;
    }

    #[test]
    fn validation_matches_node_zod_fixtures() {
        let fixtures: Vec<Value> = serde_json::from_str(include_str!(
            "../../tests/fixtures/launcher-validation.json"
        ))
        .unwrap();
        for (i, fixture) in fixtures.into_iter().enumerate() {
            match validate(fixture["input"].clone()) {
                Ok(actual) => assert_eq!(json!(actual), fixture["output"], "fixture {i}"),
                Err(error) => assert_eq!(
                    json!(error.errors.as_ref().unwrap()),
                    fixture["errors"],
                    "fixture {i}"
                ),
            }
        }
    }
    #[tokio::test]
    async fn returns_individual_not_found_ambiguous_and_unsupported_results() {
        for (rows, assets, expected) in [
            (vec![], None, "not-found"),
            (vec![doc! {}, doc! {}], None, "ambiguous"),
            (
                vec![doc! {"id":"item","namespace":"ns"}],
                Some(vec![]),
                "unsupported",
            ),
            (
                vec![doc! {"id":"item","namespace":"ns"}],
                Some(vec![
                    doc! {"platform":"Windows","artifactId":"artifact"},
                    doc! {"platform":"windows","artifactId":"artifact"},
                ]),
                "ambiguous",
            ),
        ] {
            let mut steps = vec![("items", item_query(), rows)];
            if let Some(assets) = assets {
                steps.push(("assets", asset_query("item"), assets));
            }
            let (state, store) = state(steps);
            assert_eq!(
                resolve_candidate(&state, &candidate()).await.unwrap(),
                json!({"requestId":"r","status":expected})
            );
            store.assert_finished();
        }
    }
    #[tokio::test]
    async fn resolves_base_game_with_offer_attribute_precedence() {
        let item = doc! {"id":"item","namespace":"ns","title":"Game","entitlementType":"EXECUTABLE","customAttributes":[{"key":"CanRunOffline","value":"true"},{"key":"FolderName","value":" Folder "}]};
        let offer = doc! {"id":"offer","offerType":"BASE_GAME","customAttributes":[{"key":"CanRunOffline","value":"FALSE"},{"key":"IgnoredProcessNames","value":"[\"keep\",\"\",5,\" spaced \"]"},{"key":"OwnershipToken","value":"true"}]};
        let (state, store) = state(vec![
            ("items", item_query(), vec![item]),
            (
                "assets",
                asset_query("item"),
                vec![
                    doc! {"platform":"Linux","artifactId":"other"},
                    doc! {"platform":"Windows","artifactId":"artifact"},
                ],
            ),
            ("offers", direct_query(), vec![offer]),
            ("offersubitems", sub_query(), vec![]),
        ]);
        let result = resolve_candidate(&state, &candidate()).await.unwrap();
        assert_eq!(
            result,
            json!({"requestId":"r","status":"resolved","record":{"artifactId":"artifact","catalogItemId":"item","catalogNamespace":"ns","displayName":"Game","kind":"base-game","appCategories":["public","games","applications"],"mainGame":null,"mandatoryAppFolderName":"Folder","canRunOffline":false,"requiresAuth":true,"ownershipToken":true,"ignoredProcessNames":["keep"," spaced "]}})
        );
        store.assert_finished();
    }
    #[tokio::test]
    async fn indirect_lookup_preserves_database_id_types_and_later_offer_values() {
        let object_id = bson::oid::ObjectId::new();
        let (state, store) = state(vec![
            (
                "offers",
                direct_query(),
                vec![doc! {"id":42_i32,"title":"old"}, doc! {"id":"second"}],
            ),
            (
                "offersubitems",
                sub_query(),
                vec![doc! {"_id":42_i32}, doc! {"_id":object_id}],
            ),
            (
                "offers",
                doc! {"id":{"$in":[42_i32,object_id]},"offerType":{"$in":["BASE_GAME","DLC"]}},
                vec![doc! {"id":"42","title":"updated"}, doc! {"id":""}],
            ),
        ]);
        assert_eq!(
            offers_for_item(&state, "item").await.unwrap(),
            vec![json!({"id":"42","title":"updated"}), json!({"id":"second"})]
        );
        store.assert_finished();
    }

    #[tokio::test]
    async fn indirect_addon_resolves_executable_parent_and_classifies_digital_extras_first() {
        let item =
            doc! {"id":"item","namespace":"ns","categories":[{"path":"DigitalExtra/soundtrack"}]};
        let base = doc! {"id":"base","offerType":"BASE_GAME","items":[{"id":"item"},{"id":"parent"},{"id":"extra"}]};
        let (state, store) = state(vec![
            ("items", item_query(), vec![item]),
            (
                "assets",
                asset_query("item"),
                vec![doc! {"platform":"Windows","artifactId":"artifact"}],
            ),
            (
                "offers",
                direct_query(),
                vec![doc! {"id":"dlc","offerType":"DLC"}],
            ),
            ("offersubitems", sub_query(), vec![doc! {"_id":"base"}]),
            (
                "offers",
                doc! {"id":{"$in":["base"]},"offerType":{"$in":["BASE_GAME","DLC"]}},
                vec![base],
            ),
            (
                "items",
                doc! {"id":{"$in":["item","parent","extra"]}},
                vec![
                    doc! {"id":"parent","namespace":"ns","entitlementType":"EXECUTABLE"},
                    doc! {"id":"extra","namespace":"ns"},
                ],
            ),
            (
                "assets",
                asset_query("parent"),
                vec![doc! {"artifactId":"parent-artifact","platform":"Windows"}],
            ),
        ]);
        let result = resolve_candidate(&state, &candidate()).await.unwrap();
        assert_eq!(result["record"]["kind"], "digital-extra");
        assert_eq!(
            result["record"]["mainGame"],
            json!({"artifactId":"parent-artifact","catalogItemId":"parent","catalogNamespace":"ns"})
        );
        store.assert_finished();
    }
    #[tokio::test]
    async fn unhinted_candidates_use_literal_app_id_and_windows_regex() {
        let query = doc! {"releaseInfo":{"$elemMatch":{"appId":{"$eq":"app.*"},"platform":{"$regex":bson::Regex{pattern:"^Win".into(),options:"i".into()}}}}};
        let (state, store) = state(vec![("items", query, vec![])]);
        let mut c = candidate();
        c.as_object_mut().unwrap().shift_remove("catalogHint");
        c["buildAppName"] = json!("app.*");
        assert_eq!(
            resolve_candidate(&state, &c).await.unwrap()["status"],
            "not-found"
        );
        store.assert_finished();
    }
    #[tokio::test]
    async fn http_validates_before_database_and_returns_bounded_results() {
        let (state, store) = state(vec![("items", item_query(), vec![])]);
        let app = super::super::router(&state).with_state(state);
        for (query, body, expected) in [
            (
                "?unknown=x",
                json!({"candidates":[candidate()]}),
                StatusCode::BAD_REQUEST,
            ),
            ("", json!({"candidates":[]}), StatusCode::BAD_REQUEST),
            ("", json!({"candidates":[candidate()]}), StatusCode::OK),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/v1/builds/resolve-launcher-records{query}"))
                        .method("POST")
                        .header("content-type", "application/json")
                        .header("x-egdata-key-id", "key_test1234")
                        .header("x-egdata-key-tier", "free")
                        .body(Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
            let body: Value =
                serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                    .unwrap();
            if expected == StatusCode::OK {
                assert_eq!(
                    body["data"],
                    json!({"results":[{"requestId":"r","status":"not-found"}]})
                );
                assert_eq!(body["meta"]["count"], 1);
            }
        }
        store.assert_finished();
    }
    #[tokio::test]
    async fn interrupted_launcher_bodies_return_each_routes_validation_error() {
        for (path, expected) in [
            ("/builds/resolve-launcher-records", "VALIDATION_ERROR"),
            ("/v1/builds/resolve-launcher-records", "MALFORMED_JSON"),
        ] {
            let (state, store) = state(vec![]);
            let request = Request::post(path)
                .header("x-egdata-key-id", "key_test1234")
                .header("x-egdata-key-tier", "free")
                .header("content-type", "application/json")
                .body(Body::from_stream(futures::stream::once(async {
                    Err::<axum::body::Bytes, _>(std::io::Error::other("fixture connection closed"))
                })))
                .unwrap();
            let app = if path.starts_with("/v1/") {
                crate::v1::router(&state).with_state(state)
            } else {
                crate::runtime::application(state)
            };
            let res = app.oneshot(request).await.unwrap();
            assert_eq!(res.status(), StatusCode::BAD_REQUEST);
            let body: Value =
                serde_json::from_slice(&to_bytes(res.into_body(), usize::MAX).await.unwrap())
                    .unwrap();
            assert_eq!(body.get("error").unwrap_or(&body)["code"], expected);
            store.assert_finished();
        }
    }

    #[test]
    fn attribute_and_category_edge_cases_match_source() {
        assert_eq!(process_names(&json!("a, b, , c")), vec!["a", "b", "c"]);
        assert!(process_names(&Value::Null).is_empty());
        assert!(
            classify(
                &json!({"entitlementType":"EXECUTABLE","itemType":"DURABLE"}),
                &[]
            )
            .is_none()
        );
        assert_eq!(
            classify(&json!({"categories":["games/addon"]}), &[]),
            Some("addon")
        );
        assert_eq!(
            classify(&json!({}), &[json!({"offerType":"BASE_GAME"})]),
            Some("base-game")
        );
    }
}
