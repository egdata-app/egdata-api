//! async-graphql schema, DataLoaders, APQ, persisted queries, and validation for egdata.

pub mod abuse_telemetry;
pub mod persisted;
pub mod resolvers;
pub mod schema;
pub mod validation;
mod variables;

pub fn graphql_ready() -> bool {
    egdata_core::workspace_ready() && egdata_infra::infra_ready()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_graphql_ready() {
        assert!(graphql_ready());
    }
}
