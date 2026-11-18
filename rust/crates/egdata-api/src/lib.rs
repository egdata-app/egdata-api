//! Axum HTTP server for `/v1`, `/graphql`, legacy REST routes, middleware, and OpenAPI generation.

mod graphql;
pub mod legacy;
pub mod middleware;
pub mod openapi;
pub mod operations;
pub mod runtime;
pub mod runtime_adapters;
pub mod state;
pub mod v1;

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
