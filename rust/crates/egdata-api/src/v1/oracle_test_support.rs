//! HTTP response capture matching `rust/oracles/record.ts`: full body and selected headers.
use axum::response::Response;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub async fn capture_response(response: Response) -> Value {
    let status = response.status().as_u16();
    let mut headers = serde_json::Map::new();
    for name in [
        "content-type",
        "cache-control",
        "cdn-cache-control",
        "cloudflare-cdn-cache-control",
        "x-content-type-options",
        "x-request-id",
        "location",
        "retry-after",
        "allow",
        "etag",
    ] {
        if let Some(value) = response.headers().get(name) {
            headers.insert(name.into(), json!(value.to_str().unwrap()));
        }
    }
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let content_type = headers
        .get("content-type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap();
    let body = if content_type.starts_with("image/") {
        json!({"byteLength":bytes.len(),"sha256":hex::encode(Sha256::digest(&bytes))})
    } else if !bytes.is_empty()
        && (content_type == "application/json" || content_type.ends_with("+json"))
    {
        serde_json::from_slice(&bytes).unwrap()
    } else {
        json!(std::str::from_utf8(&bytes).unwrap())
    };
    json!({"status":status,"headers":headers,"body":body})
}
