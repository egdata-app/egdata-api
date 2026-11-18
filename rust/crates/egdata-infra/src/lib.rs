//! Infrastructure adapters for MongoDB, Redis, Postgres, Search, Epic, Job API, and Takumi OG.

pub mod auth_pg;
pub mod bson_json;
pub mod catalog_mongo;
pub mod epic_client;
pub mod job_api;
pub mod mongo;
pub mod notifications;
pub mod og_renderer;
pub mod port_adapters;
pub mod redis_store;
pub mod search_clients;

pub fn infra_ready() -> bool {
    egdata_core::workspace_ready()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_infra_ready() {
        assert!(infra_ready());
    }
}
