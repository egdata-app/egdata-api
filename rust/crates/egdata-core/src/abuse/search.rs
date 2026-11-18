//! Search filter normalization and resource key generation for anti-abuse tracking.

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

use super::scorer::AbuseResource;

/// Semantic search filters included in the traversal identity hash.
pub const SEARCH_ABUSE_FILTERS: &[&str] = &[
    "title",
    "offerType",
    "tags",
    "categories",
    "customAttributes",
    "seller",
    "developerDisplayName",
    "publisherDisplayName",
    "refundType",
    "isCodeRedemptionOnly",
    "excludeBlockchain",
    "onSale",
    "pastGiveaways",
    "isLowestPrice",
    "isLowestPriceEver",
    "sortBy",
    "sortDir",
    "technologies",
    "price",
    "spt",
];

/// Normalizes a search title and hashes it with SHA-256 when at least 3 chars remain.
pub fn normalized_title_hash(title: Option<&str>) -> Option<String> {
    let raw = title?;
    let trimmed = raw.trim();
    let collapsed = trimmed.split_whitespace().collect::<Vec<_>>().join(" ");
    let lowered = collapsed.to_lowercase();
    if lowered.chars().count() < 3 {
        return None;
    }
    Some(hex::encode(Sha256::digest(lowered.as_bytes())))
}

fn canonical(value: &Value, depth: usize) -> Value {
    if depth > 3 {
        return Value::Null;
    }
    match value {
        Value::String(s) => Value::String(s.chars().take(512).collect()),
        Value::Number(n) => Value::Number(n.clone()),
        Value::Bool(b) => Value::Bool(*b),
        Value::Array(items) => {
            let mut normalized: Vec<Value> = items
                .iter()
                .take(100)
                .map(|entry| canonical(entry, depth + 1))
                .collect();
            normalized.sort_by(|a, b| {
                let sa = serde_json::to_string(a).unwrap_or_default();
                let sb = serde_json::to_string(b).unwrap_or_default();
                sa.cmp(&sb)
            });
            Value::Array(normalized)
        }
        Value::Object(map) => {
            let sorted: BTreeMap<&str, &Value> = map.iter().map(|(k, v)| (k.as_str(), v)).collect();
            let mut out = Map::new();
            for (k, v) in sorted.into_iter().take(32) {
                out.insert(k.to_string(), canonical(v, depth + 1));
            }
            Value::Object(out)
        }
        Value::Null => Value::Null,
    }
}

/// Builds a bounded `AbuseResource` representing a search traversal query.
pub fn search_abuse_resource(
    filters: &Value,
    page: i64,
    limit: i64,
    region: &str,
    locale: &str,
) -> Option<AbuseResource> {
    if page < 1 || limit < 1 {
        return None;
    }
    let obj = filters.as_object();
    let profile: Vec<Value> = SEARCH_ABUSE_FILTERS
        .iter()
        .map(|&key| {
            let val = obj.and_then(|m| m.get(key)).unwrap_or(&Value::Null);
            json!([key, canonical(val, 0)])
        })
        .collect();
    let serialized =
        serde_json::to_string(&json!([region, locale, profile])).expect("json array serializes");
    let query_hash = hex::encode(Sha256::digest(serialized.as_bytes()));
    let title = obj.and_then(|m| m.get("title")).and_then(Value::as_str);

    Some(AbuseResource {
        route: format!("/search/v2/search:{query_hash}"),
        page: Some(page as u32),
        item_id: None,
        limit: Some(limit.min(100) as u32),
        search: Some(true),
        title_hash: normalized_title_hash(title),
        hydration_id: None,
        hydration_route: None,
        cache_hit: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalized_title_hash() {
        assert_eq!(normalized_title_hash(None), None);
        assert_eq!(normalized_title_hash(Some("  ab ")), None);
        let h1 = normalized_title_hash(Some("  Alan   Wake  ")).unwrap();
        let h2 = normalized_title_hash(Some("alan wake")).unwrap();
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);
    }

    #[test]
    fn test_search_abuse_resource() {
        assert!(search_abuse_resource(&json!({}), 0, 10, "US", "en-US").is_none());
        assert!(search_abuse_resource(&json!({}), 1, 0, "US", "en-US").is_none());

        let f1 = json!({
            "title": "Cyberpunk",
            "tags": ["b", "a"],
            "onSale": true,
            "price": { "max": 2000, "min": 500 },
            "extra": "ignored",
            "deep": { "a": { "b": { "c": { "d": "too-deep" } } } }
        });
        let f2 = json!({
            "title": "Cyberpunk",
            "tags": ["a", "b"],
            "onSale": true,
            "price": { "min": 500, "max": 2000 },
            "otherExtra": 123
        });

        let r1 = search_abuse_resource(&f1, 1, 250, "US", "en-US").unwrap();
        let r2 = search_abuse_resource(&f2, 1, 100, "US", "en-US").unwrap();
        assert_eq!(r1.route, r2.route);
        assert!(r1.route.starts_with("/search/v2/search:"));
        assert_eq!(r1.limit, Some(100));
        assert_eq!(r1.search, Some(true));
        assert!(r1.title_hash.is_some());

        // Deep nesting > depth 3 collapses to null
        let deep = json!({
            "price": { "a": { "b": { "c": { "d": "clamped" } } } }
        });
        let r3 = search_abuse_resource(&deep, 2, 20, "EURO", "de-DE").unwrap();
        assert_eq!(r3.page, Some(2));
        assert_eq!(r3.title_hash, None);
    }
}
