//! Core domain logic, models, serialization contracts, and async I/O traits for egdata.

pub mod abuse;
pub mod attributes;
pub mod bson_json;
pub mod builds;
pub mod catalog;
pub mod countries;
pub mod error;
pub mod localization;
pub mod ports;
pub mod pricing;
pub mod sitemap;
pub mod v1;

pub fn workspace_ready() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_workspace_ready() {
        assert!(workspace_ready());
    }
}
