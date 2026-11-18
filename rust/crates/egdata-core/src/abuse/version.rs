//! Anti-abuse version constants and Redis key helpers.

/// Incompatible fingerprint/features must not reuse earlier risk or trial state.
pub const ABUSE_VERSION: u32 = 2;
/// Key prefix for anti-abuse sliding windows and canary traps.
pub const RISK_PREFIX: &str = "egdata:abuse:v2:";

/// Returns the `[events, trap]` Redis cluster-tagged keys for an actor key.
pub fn risk_redis_keys(key: &str) -> [String; 2] {
    [
        format!("{RISK_PREFIX}{{{key}}}:events"),
        format!("{RISK_PREFIX}{{{key}}}:trap"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version_and_keys() {
        assert_eq!(ABUSE_VERSION, 2);
        assert_eq!(RISK_PREFIX, "egdata:abuse:v2:");
        assert_eq!(
            risk_redis_keys("fp:abc"),
            [
                "egdata:abuse:v2:{fp:abc}:events".to_string(),
                "egdata:abuse:v2:{fp:abc}:trap".to_string(),
            ]
        );
    }
}
