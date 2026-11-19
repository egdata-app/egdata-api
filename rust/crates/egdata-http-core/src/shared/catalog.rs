
use std::collections::HashSet;
use std::convert::Infallible;
use std::sync::Arc;

use axum::{
    body::{Body, Bytes, to_bytes},
    extract::{Request, State},
    http::{StatusCode, header},
    response::Response,
};
use chrono::{SecondsFormat, Utc};
use egdata_core::v1::ProblemError;
use egdata_core::v1::require_json_content_type;
use egdata_infra::catalog_mongo::{
    CatalogHydrationIdentifier, CatalogHydrationRequest, catalog_hydration_root_key,
};
use serde_json::{Value, json};

use crate::state::AppState;
use crate::v1_helpers::{V1RequestContext, problem_response};

pub const MAX_REQUEST_BYTES: usize = 256 * 1024;

/// Match the Node boundary validator, including normalization before duplicate checks.
pub fn parse_hydration_request(mut value: Value) -> Option<CatalogHydrationRequest> {
    if value.get("schemaVersion")?.as_f64()? != 2.0 {
        return None;
    }
    value["schemaVersion"] = json!(2);
    let request: CatalogHydrationRequest = serde_json::from_value(value).ok()?;
    if request.identifiers.is_empty()
        || request.identifiers.len() > 25
        || request.known_roots.len() > 25
        || request.known_records.len() > 5000
    {
        return None;
    }
    let mut identifiers = HashSet::new();
    for identifier in &request.identifiers {
        let valid = match identifier {
            CatalogHydrationIdentifier::Item { namespace, id } => {
                bounded(namespace, 256) && bounded(id, 256)
            }
            CatalogHydrationIdentifier::Asset {
                namespace,
                artifact_id,
                platform,
            } => bounded(namespace, 256) && bounded(artifact_id, 256) && bounded(platform, 64),
            CatalogHydrationIdentifier::ReleaseApp {
                namespace,
                app_id,
                platform,
            } => bounded(namespace, 256) && bounded(app_id, 256) && bounded(platform, 64),
        };
        if !valid || !identifiers.insert(catalog_hydration_root_key(identifier)) {
            return None;
        }
    }
    let mut roots = HashSet::new();
    for root in &request.known_roots {
        if !bounded(&root.root_key, 4096)
            || !valid_hash(&root.graph_hash)
            || !roots.insert(&root.root_key)
        {
            return None;
        }
    }
    let mut records = HashSet::new();
    for record in &request.known_records {
        if !bounded(&record.record_key, 4096)
            || !valid_hash(&record.sha256)
            || !records.insert(&record.record_key)
        {
            return None;
        }
    }
    Some(request)
}

pub fn hydration_response(state: AppState, hydration: CatalogHydrationRequest) -> Response {
    // Resolve only the root being polled. Dropping the response cancels pending
    // work and never starts subsequent roots; no task or channel outlives it.
    let stream = futures::stream::unfold(
        (state.catalog_hydration, Arc::new(hydration), 0),
        move |(resolver, request, index)| async move {
            let identifier = request.identifiers.get(index)?;
            let one_root = json!({"schemaVersion": 2, "identifiers": [identifier],
                "knownRoots": request.known_roots, "knownRecords": request.known_records});
            let result = match resolver.resolve(&one_root).await {
                Ok(mut rows) if rows.len() == 1 => rows.remove(0),
                _ => root_error(
                    identifier,
                    "CATALOG_ROOT_RESOLUTION_FAILED",
                    "This catalog root could not be hydrated.",
                    (state.now)(),
                ),
            };
            let mut line = egdata_core::v1::serialization::node_json(&result);
            line.push('\n');
            if line.len() > MAX_LINE_BYTES {
                line = format!(
                    "{}\n",
                    root_error(
                        identifier,
                        "CATALOG_ROOT_TOO_LARGE",
                        "This catalog root exceeds the hydration limit.",
                        (state.now)(),
                    )
                );
            }
            Some((
                Ok::<_, Infallible>(Bytes::from(line)),
                (resolver, request, index + 1),
            ))
        },
    );
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        "application/x-ndjson; charset=utf-8".parse().unwrap(),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    response
}

pub const MAX_LINE_BYTES: usize = 2 * 1024 * 1024;

pub fn context(request: &Request) -> &V1RequestContext {
    request.extensions().get().expect("v1 context")
}

pub fn error_response(request: &Request, error: &ProblemError) -> Response {
    problem_response(
        error,
        request.uri().path(),
        Some(&context(request).request_id),
    )
}

pub fn bounded(value: &str, max: usize) -> bool {
    !egdata_core::v1::trim_js_whitespace(value).is_empty() && value.encode_utf16().count() <= max
}

pub fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn root_error(
    identifier: &CatalogHydrationIdentifier,
    code: &str,
    message: &str,
    now: chrono::DateTime<Utc>,
) -> Value {
    json!({"schemaVersion": 2, "rootKey": catalog_hydration_root_key(identifier), "identifier": identifier,
        "hydratedAt": now.to_rfc3339_opts(SecondsFormat::Millis, true), "status": "error",
        "error": {"code": code, "message": message}})
}

pub fn too_large() -> ProblemError {
    ProblemError::new(
        413,
        "CATALOG_HYDRATION_TOO_LARGE",
        "The catalog hydration request is too large (maximum 256 KiB).",
    )
}

pub async fn hydrate(State(state): State<AppState>, request: Request) -> Response {
    if let Err(error) = require_json_content_type(
        request
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|h| h.to_str().ok()),
    ) {
        return error_response(&request, &error);
    }
    if request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.parse::<f64>().ok())
        .is_some_and(|len| len.is_finite() && len > MAX_REQUEST_BYTES as f64)
    {
        return error_response(&request, &too_large());
    }
    let path = request.uri().path().to_string();
    let request_id = context(&request).request_id.clone();
    let body = match to_bytes(request.into_body(), MAX_REQUEST_BYTES).await {
        Ok(body) => body,
        Err(_) => return problem_response(&too_large(), &path, Some(&request_id)),
    };
    let value = match serde_json::from_slice::<Value>(&body) {
        Ok(value) => value,
        Err(_) => {
            return problem_response(
                &ProblemError::new(
                    400,
                    "CATALOG_HYDRATION_INVALID_REQUEST",
                    "The catalog hydration request is not valid JSON.",
                ),
                &path,
                Some(&request_id),
            );
        }
    };
    let Some(hydration) = parse_hydration_request(value) else {
        return problem_response(
            &ProblemError::new(
                400,
                "CATALOG_HYDRATION_INVALID_REQUEST",
                "The catalog hydration request is invalid.",
            ),
            &path,
            Some(&request_id),
        );
    };
    hydration_response(state, hydration)
}
