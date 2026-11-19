//! Axum HTTP server for `/v1`, `/graphql` and the legacy REST routes.
//!
//! The route surfaces live in `egdata-routes-v1` and `egdata-routes-legacy`; this crate
//! wires them into one application, owns the runtime/adapters and exposes the tooling CLI.

pub mod graphql;
pub mod openapi;
pub mod operations;
pub mod runtime;
pub mod runtime_adapters;

pub use egdata_http_core::{middleware, state};
pub use egdata_routes_legacy as legacy;
pub use egdata_routes_v1 as v1;

pub fn api_ready() -> bool {
    egdata_graphql::graphql_ready()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_api_ready() {
        assert!(api_ready());
    }
}
