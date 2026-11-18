//! Operator-controlled anti-abuse trial parsing and route matching.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

/// Redis key storing the active operator trial configuration.
pub const TRIAL_KEY: &str = "egdata:abuse:trial:v2";
/// Maximum allowed trial lifetime in milliseconds (15 minutes).
pub const MAX_TRIAL_DURATION_MS: i64 = 900_000;

/// Route family eligible for an operator anti-abuse trial.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TrialRoute {
    #[serde(rename = "offer-details")]
    OfferDetails,
    #[serde(rename = "catalog-search")]
    CatalogSearch,
}

/// Validated operator anti-abuse trial descriptor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AbuseTrial {
    pub id: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub fingerprints: Vec<String>,
    pub route: TrialRoute,
}

fn trial_id_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-zA-Z0-9_-]{1,64}$").expect("valid regex"))
}

fn fingerprint_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-f0-9]{64}$").expect("valid regex"))
}

fn offer_details_path_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^/offers/[a-f0-9]{32}$").expect("valid regex"))
}

/// Validates and parses an operator trial JSON payload from Redis.
pub fn parse_trial(raw: Option<&str>, now_ms: i64) -> Option<AbuseTrial> {
    let raw = raw.filter(|s| s.len() <= 4096)?;
    let trial: AbuseTrial = serde_json::from_str(raw).ok()?;
    if !trial_id_regex().is_match(&trial.id)
        || trial.created_at > now_ms
        || trial.expires_at <= now_ms
        || trial.expires_at <= trial.created_at
        || trial.expires_at - trial.created_at > MAX_TRIAL_DURATION_MS
    {
        return None;
    }
    if trial.fingerprints.is_empty()
        || trial.fingerprints.len() > 10
        || !trial
            .fingerprints
            .iter()
            .all(|fp| fingerprint_regex().is_match(fp))
    {
        return None;
    }
    Some(trial)
}

/// Evaluates whether incoming requests match the currently active trial.
#[derive(Debug, Clone, Default)]
pub struct TrialMatcher {
    current: Option<AbuseTrial>,
}

impl TrialMatcher {
    /// Creates a `TrialMatcher` with an optional pre-parsed trial.
    pub fn new(current: Option<AbuseTrial>) -> Self {
        Self { current }
    }

    /// Updates the active trial from a raw Redis payload.
    pub fn update_from_raw(&mut self, raw: Option<&str>, now_ms: i64) {
        self.current = parse_trial(raw, now_ms);
    }

    /// Clears any active trial.
    pub fn clear(&mut self) {
        self.current = None;
    }

    /// Returns the currently held trial if any.
    pub fn current(&self) -> Option<&AbuseTrial> {
        self.current.as_ref()
    }

    /// Returns true if `fingerprint`, `path`, and `method` match an active non-expired trial.
    pub fn matches(&self, fingerprint: &str, path: &str, method: &str, now_ms: i64) -> bool {
        let Some(ref trial) = self.current else {
            return false;
        };
        if trial.expires_at <= now_ms || !trial.fingerprints.iter().any(|fp| fp == fingerprint) {
            return false;
        }
        match trial.route {
            TrialRoute::OfferDetails => {
                method == "GET" && offer_details_path_regex().is_match(path)
            }
            TrialRoute::CatalogSearch => {
                (method == "GET" || method == "POST") && path == "/search/v2/search"
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const FP: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[test]
    fn test_parse_trial_and_matcher() {
        let now = 1_700_000_000_000_i64;
        assert!(parse_trial(None, now).is_none());
        let huge = "x".repeat(4097);
        assert!(parse_trial(Some(&huge), now).is_none());
        assert!(parse_trial(Some("not-json"), now).is_none());

        let valid = json!({
            "id": "trial-1",
            "createdAt": now - 1000,
            "expiresAt": now + 60_000,
            "fingerprints": [FP],
            "route": "offer-details"
        })
        .to_string();

        let parsed = parse_trial(Some(&valid), now).unwrap();
        assert_eq!(parsed.route, TrialRoute::OfferDetails);

        // Invalid variants
        let bad_cases = [
            json!({"id": "bad id!", "createdAt": now - 1, "expiresAt": now + 1000, "fingerprints": [FP], "route": "offer-details"}).to_string(),
            json!({"id": "t", "createdAt": now + 100, "expiresAt": now + 1000, "fingerprints": [FP], "route": "offer-details"}).to_string(),
            json!({"id": "t", "createdAt": now - 100, "expiresAt": now, "fingerprints": [FP], "route": "offer-details"}).to_string(),
            json!({"id": "t", "createdAt": now - 100, "expiresAt": now + 900_001, "fingerprints": [FP], "route": "offer-details"}).to_string(),
            json!({"id": "t", "createdAt": now - 100, "expiresAt": now + 1000, "fingerprints": [], "route": "offer-details"}).to_string(),
            json!({"id": "t", "createdAt": now - 100, "expiresAt": now + 1000, "fingerprints": ["short"], "route": "offer-details"}).to_string(),
        ];
        for bad in bad_cases {
            assert!(parse_trial(Some(&bad), now).is_none());
        }

        let mut matcher = TrialMatcher::new(None);
        assert!(!matcher.matches(FP, "/offers/0123456789abcdef0123456789abcdef", "GET", now));
        matcher.update_from_raw(Some(&valid), now);
        assert!(matcher.current().is_some());
        assert!(matcher.matches(FP, "/offers/0123456789abcdef0123456789abcdef", "GET", now));
        assert!(!matcher.matches(FP, "/offers/0123456789abcdef0123456789abcdef", "POST", now));
        assert!(!matcher.matches(
            "other",
            "/offers/0123456789abcdef0123456789abcdef",
            "GET",
            now
        ));
        assert!(!matcher.matches(
            FP,
            "/offers/0123456789abcdef0123456789abcdef",
            "GET",
            now + 60_000
        ));

        let search_json = json!({
            "id": "trial-2",
            "createdAt": now - 1000,
            "expiresAt": now + 60_000,
            "fingerprints": [FP],
            "route": "catalog-search"
        })
        .to_string();
        matcher.update_from_raw(Some(&search_json), now);
        assert!(matcher.matches(FP, "/search/v2/search", "GET", now));
        assert!(matcher.matches(FP, "/search/v2/search", "POST", now));
        assert!(!matcher.matches(FP, "/offers/0123456789abcdef0123456789abcdef", "GET", now));

        matcher.clear();
        assert!(matcher.current().is_none());
        assert_eq!(TRIAL_KEY, "egdata:abuse:trial:v2");
    }
}
