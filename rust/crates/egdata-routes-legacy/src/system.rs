use super::{Routes, internal_error, json_response};
use crate::{state::AppState};
use egdata_http_core::shared::catalog::{MAX_REQUEST_BYTES, hydration_response, parse_hydration_request};
use axum::{
    body::{Body, Bytes, to_bytes},
    extract::{Path, Request, State},
    http::{HeaderMap, StatusCode, Uri, header},
    response::Response,
};
use bson::doc;
use egdata_core::{
    countries::{COUNTRIES, REGIONS, RegionInfo},
    error::CoreError,
    v1::serialization::node_json,
};
use egdata_infra::bson_json::bson_doc_to_js_json;
use serde_json::{Value, json};
use std::{future::Future, sync::LazyLock, time::Duration};

const ROBOTS: &str = "User-agent: *\nDisallow: /\nAllow: /sitemap.xml\nAllow: /sitemap.xml?*\nAllow: /promotions-sitemap.xml\nAllow: /profiles/sitemap.xml\nAllow: /sandboxes/sitemap.xml\nAllow: /sandboxes/sitemap.xml?*\nAllow: /items/sitemap.xml\nAllow: /items/sitemap.xml?*\nAllow: /offers/*/og\nAllow: /items/*/og\nAllow: /sandboxes/*/og\n";

pub(super) fn routes() -> Routes {
    Routes::new("")
        .get("/countries", countries)
        .get("/regions", regions)
        .get("/region", region)
        .get("/health", health)
        .get("/ping", || async {
            json_response(StatusCode::OK, &json!({"message":"pong"}))
        })
        .get("/ui", swagger_ui)
        .get("/robots.txt", robots)
        .get("/open-api.json", contract)
        .get("/doc", contract)
        .get("/tags", tags)
        .get("/offer-by-slug/{slug}", offer_by_slug)
        .post("/catalog/hydrate", hydrate)
}

pub(super) fn query(uri: &Uri, key: &str) -> Option<String> {
    url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.into_owned())
}

pub(super) fn selected_country(uri: &Uri, headers: &HeaderMap) -> String {
    query(uri, "country")
        .or_else(|| {
            headers
                .get(header::COOKIE)?
                .to_str()
                .ok()?
                .split(';')
                .find_map(|cookie| {
                    let (k, v) = cookie.split_once('=')?;
                    if k.trim() != "EGDATA_COUNTRY" {
                        return None;
                    }
                    let value = v.trim();
                    let value = value
                        .strip_prefix('"')
                        .and_then(|v| v.strip_suffix('"'))
                        .unwrap_or(value);
                    if !value
                        .bytes()
                        .all(|b| matches!(b,b' '|b'!'|b'#'..=b':'|b'<'..=b'['|b']'..=b'~'))
                    {
                        return None;
                    }
                    Some(
                        urlencoding::decode(value)
                            .map(|v| v.into_owned())
                            .unwrap_or_else(|_| value.to_owned()),
                    )
                })
        })
        .unwrap_or_else(|| "US".to_owned())
}
pub(super) fn selected_region(
    uri: &Uri,
    headers: &HeaderMap,
) -> Option<(&'static str, RegionInfo)> {
    let country = selected_country(uri, headers);
    REGIONS
        .iter()
        .copied()
        .find(|(_, region)| region.countries.contains(&country.as_str()))
}

pub(super) fn missing_country() -> Response {
    json_response(
        StatusCode::NOT_FOUND,
        &json!({"message":"Country not found"}),
    )
}
pub(super) fn cache_control(mut response: Response, value: &'static str) -> Response {
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static(value),
    );
    response
}
async fn countries() -> Response {
    cache_control(
        json_response(StatusCode::OK, &json!(COUNTRIES)),
        "public, max-age=60",
    )
}
async fn regions() -> Response {
    let values = REGIONS
        .iter()
        .map(|(k, v)| (k.to_string(), json!(v)))
        .collect();
    cache_control(
        json_response(StatusCode::OK, &Value::Object(values)),
        "public, max-age=60",
    )
}
async fn region(uri: Uri, headers: HeaderMap) -> Response {
    let Some((code, info)) = selected_region(&uri, &headers) else {
        return missing_country();
    };
    cache_control(
        json_response(
            StatusCode::OK,
            &json!({"region":{"code":code,"currencyCode":info.currency_code,"description":info.description,"countries":info.countries}}),
        ),
        "public, max-age=60",
    )
}
async fn health(State(state): State<AppState>) -> Response {
    async fn probe(
        future: impl Future<Output = Result<bool, CoreError>>,
        now: fn() -> chrono::DateTime<chrono::Utc>,
    ) -> Value {
        let start = now();
        match tokio::time::timeout(Duration::from_secs(5), future).await {
            Ok(Ok(true)) => json!({"status":"ok","latency":(now()-start).num_milliseconds()}),
            _ => json!({"status":"error","latency":null}),
        }
    }
    let redis = probe(state.saved_queries.ping(), state.now).await;
    let mongodb = probe(state.mongo.ping(), state.now).await;
    let ok = redis["status"] == "ok" && mongodb["status"] == "ok";
    json_response(
        if ok {
            StatusCode::OK
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        },
        &json!({"status":if ok{"ok"}else{"error"},"services":{"redis":redis,"mongodb":mongodb}}),
    )
}
async fn robots() -> Response {
    Response::builder()
        .header(header::CONTENT_TYPE, "text/plain")
        .header(header::CACHE_CONTROL, "public, max-age=60")
        .body(Body::from(ROBOTS))
        .unwrap()
}
async fn contract() -> Response {
    static BYTES: LazyLock<Bytes> =
        LazyLock::new(|| Bytes::from(node_json(&egdata_openapi::build_legacy_document())));
    Response::builder()
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(BYTES.clone()))
        .unwrap()
}
async fn swagger_ui() -> Response {
    Response::builder()
        .header(header::CONTENT_TYPE, "text/html; charset=UTF-8")
        .body(Body::from(include_str!("swagger.html")))
        .unwrap()
}
async fn tags(State(state): State<AppState>, uri: Uri) -> Response {
    let filter = query(&uri, "group")
        .filter(|s| !s.is_empty())
        .map(|s| doc! {"groupName":s})
        .unwrap_or_default();
    match state
        .mongo
        .find_many("tags", filter, Default::default())
        .await
    {
        Ok(rows) => json_response(
            StatusCode::OK,
            &Value::Array(rows.iter().map(bson_doc_to_js_json).collect()),
        ),
        Err(_) => internal_error(),
    }
}
async fn offer_by_slug(State(state): State<AppState>, Path(slug): Path<String>) -> Response {
    match state
        .mongo
        .find_one("offers", doc! {"offerMappings.pageSlug":{"$eq":slug}}, None)
        .await
    {
        Ok(Some(row)) => {
            let value = bson_doc_to_js_json(&row);
            let mut body = json!({});
            if let Some(id) = value.get("id") {
                body["id"] = id.clone();
            }
            json_response(StatusCode::OK, &body)
        }
        Ok(None) => json_response(StatusCode::NOT_FOUND, &json!({"message":"Offer not found"})),
        Err(_) => internal_error(),
    }
}
async fn hydrate(State(state): State<AppState>, req: Request) -> Response {
    let too_large = || {
        cache_control(
            json_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                &json!({"error":{"code":"CATALOG_HYDRATION_TOO_LARGE","message":"The catalog hydration request is too large."}}),
            ),
            "no-store",
        )
    };
    if req
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|s| s.to_str().ok())
        .and_then(|s| s.trim().parse::<f64>().ok())
        .is_some_and(|n| n.is_finite() && n > MAX_REQUEST_BYTES as f64)
    {
        return too_large();
    }
    let body = match to_bytes(req.into_body(), MAX_REQUEST_BYTES).await {
        Ok(body) => body,
        Err(_) => return too_large(),
    };
    let decoded = String::from_utf8_lossy(&body);
    if decoded.len() > MAX_REQUEST_BYTES {
        return too_large();
    }
    let value = serde_json::from_str(decoded.trim_start_matches('\u{feff}'))
        .ok()
        .and_then(parse_hydration_request);
    match value {
        Some(request) => {
            let mut response = hydration_response(state, request);
            response
                .headers_mut()
                .insert("x-content-type-options", "nosniff".parse().unwrap());
            response
        }
        None => cache_control(
            json_response(
                StatusCode::BAD_REQUEST,
                &json!({"error":{"code":"CATALOG_HYDRATION_INVALID_REQUEST","message":"The catalog hydration request is invalid."}}),
            ),
            "no-store",
        ),
    }
}

#[cfg(test)]
#[tokio::test]
async fn legacy_system_http_node_oracle() {
    egdata_api_oracle::replay_legacy_oracle(include_str!(
        "../../egdata-api/tests/fixtures/legacy-system-http-node.json"
    ))
    .await;
}
