//! Origin compression matching `compress({ threshold: 512 })` in `src/index.ts`.
use axum::{
    body::HttpBody,
    extract::Request,
    http::{HeaderValue, StatusCode, header},
    middleware::Next,
    response::Response,
};
use tower_http::compression::predicate::Predicate;

#[derive(Clone)]
struct BeforeCompression {
    vary: Vec<HeaderValue>,
    encoded: bool,
}

pub async fn remember_compression_headers(req: Request, next: Next) -> Response {
    let mut response = next.run(req).await;
    let original = BeforeCompression {
        vary: response
            .headers()
            .get_all(header::VARY)
            .iter()
            .cloned()
            .collect(),
        encoded: response.headers().contains_key(header::CONTENT_ENCODING),
    };
    response.extensions_mut().insert(original);
    response
}

/// Hono's compression middleware computes the application ETag first, then weakens it after
/// compressing the representation. Apply that same change outside Tower compression.
pub async fn weaken_encoded_etag(req: Request, next: Next) -> Response {
    let mut response = next.run(req).await;
    let Some(original) = response.extensions_mut().remove::<BeforeCompression>() else {
        return response;
    };
    if !original.encoded
        && response.headers().contains_key(header::CONTENT_ENCODING)
        && let Some(etag) = response
            .headers()
            .get(header::ETAG)
            .and_then(|value| value.to_str().ok())
        && !etag.starts_with("W/")
        && let Ok(value) = HeaderValue::from_str(&format!("W/{etag}"))
    {
        response.headers_mut().insert(header::ETAG, value);
    }
    // Tower adds Vary for its own negotiation; Hono leaves the downstream
    // headers alone. In particular GraphQL GETs already vary on Accept-Encoding.
    response.headers_mut().remove(header::VARY);
    for value in original.vary {
        response.headers_mut().append(header::VARY, value);
    }
    response
}

/// Hono selects gzip first by substring inclusion, then deflate; q values and case are ignored.
pub async fn canonicalize_accept_encoding(mut req: Request, next: Next) -> Response {
    let supplied = req
        .headers()
        .get(header::ACCEPT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let selected = if supplied.contains("gzip") {
        "gzip"
    } else if supplied.contains("deflate") {
        "deflate"
    } else {
        "identity"
    };
    req.headers_mut()
        .insert(header::ACCEPT_ENCODING, HeaderValue::from_static(selected));
    next.run(req).await
}

/// Content and size predicate aligned with Hono's `shouldCompress` and threshold checks.
#[derive(Debug, Clone, Copy)]
pub struct NodeCompressionPredicate;

impl Predicate for NodeCompressionPredicate {
    fn should_compress<B>(&self, response: &http::Response<B>) -> bool
    where
        B: HttpBody,
    {
        let headers = response.headers();
        if response.status() == StatusCode::NO_CONTENT
            || response.status() == StatusCode::NOT_MODIFIED
            || headers.contains_key(header::CONTENT_ENCODING)
            || headers.contains_key(header::TRANSFER_ENCODING)
            || headers.contains_key(header::CONTENT_RANGE)
            || headers
                .get(header::CACHE_CONTROL)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| {
                    value
                        .split(',')
                        .any(|item| item.trim().eq_ignore_ascii_case("no-transform"))
                })
            || response.body().size_hint().exact() == Some(0)
        {
            return false;
        }

        let Some(content_type) = headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
        else {
            return false;
        };
        let media_type = content_type
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let compressible = (media_type.starts_with("text/") && media_type != "text/event-stream")
            || media_type == "application/json"
            || media_type == "application/xml"
            || media_type == "application/javascript"
            || media_type.ends_with("+json")
            || media_type.ends_with("+xml");
        if !compressible {
            return false;
        }

        headers
            .get(header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .is_none_or(|size| size >= 512)
    }
}
