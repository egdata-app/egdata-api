//! HTTP middleware stack for `egdata-api`.

pub mod anti_abuse;
pub mod compression;
pub mod cors;
pub mod edge_cache;
pub mod jwt;
pub mod origin_auth;
pub mod rate_limit;
pub mod request_logger;
pub mod response_etag;
pub mod route_template;
pub mod v1_context;

#[cfg(test)]
pub(crate) mod test_support;
