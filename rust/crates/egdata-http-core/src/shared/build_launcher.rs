
use std::collections::HashSet;

use bson::{Document, doc};
use egdata_core::ports::MongoFindOptions;
use egdata_core::v1::{ProblemError, ProblemIssue};
use serde_json::{Value, json};

use crate::shared::system::internal_error;
use crate::state::AppState;
use egdata_infra::bson_json::bson_doc_to_js_json;

pub fn validate(mut body: Value) -> Result<Vec<Value>, ProblemError> {
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

pub async fn resolve_candidate(
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

pub fn malformed() -> ProblemError {
    ProblemError::new(400, "MALFORMED_JSON", "The request body is not valid JSON.")
}

pub fn issue(path: &[String], code: &str, message: String) -> ProblemIssue {
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

pub fn invalid_type(value: Option<&Value>, expected: &str, path: &[String]) -> ProblemIssue {
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

pub fn check_keys(value: &Value, keys: &[&str], path: &[String], issues: &mut Vec<ProblemIssue>) {
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

pub fn text_field(
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

pub async fn find(
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

pub fn string(value: &Value) -> String {
    if value.is_null() {
        String::new()
    } else {
        egdata_core::v1::serialization::js_string(value)
    }
}

pub async fn identity(
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

pub fn classify(item: &Value, offers: &[Value]) -> Option<&'static str> {
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

pub fn attributes(item: &Value, offers: &[Value]) -> Value {
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

pub fn boolean(attributes: &Value, key: &str, fallback: bool) -> bool {
    match attributes[key].as_str() {
        Some(v) if v.eq_ignore_ascii_case("true") => true,
        Some(v) if v.eq_ignore_ascii_case("false") => false,
        _ => fallback,
    }
}

pub fn process_names(value: &Value) -> Vec<String> {
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

#[derive(Debug)]
pub enum Identity {
    Found(Value),
    Missing,
    Ambiguous,
}

pub async fn offers_for_item(state: &AppState, id: &str) -> Result<Vec<Value>, ProblemError> {
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

pub async fn main_game(
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
    let id = crate::v1_helpers::primitive_id(item.get("id"));
    let items: Vec<_> = items
        .iter()
        .filter(|row| id.is_none() || crate::v1_helpers::primitive_id(row.get("id")) != id)
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
