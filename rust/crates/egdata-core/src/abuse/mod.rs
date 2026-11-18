//! Anti-abuse scoring engine, PoW sessions, search/hydration classification, and trials.

pub mod operations;
pub mod pow;
pub mod scorer;
pub mod search;
pub mod trial;
pub mod version;

pub use operations::{
    HYDRATION_ROUTES, PartialHydrationResource, logical_operations, offer_hydration_resource,
};
pub use pow::{
    CHALLENGE_TTL_MS, PowChallenge, PowSessionService, RedeemedSession, SESSION_TTL_MS,
    SUSPICIOUS_TTL_MS, SessionClaims, verify_proof_of_work,
};
pub use scorer::{
    APPEND_WINDOW_SCRIPT, AbuseAssessment, AbuseEvent, AbuseResource, AbuseScorer, ExpiringLru,
    MAX_EVENTS, TRAP_TTL_MS, WINDOW_MS, analyze_events, score_events,
};
pub use search::{SEARCH_ABUSE_FILTERS, normalized_title_hash, search_abuse_resource};
pub use trial::{
    AbuseTrial, MAX_TRIAL_DURATION_MS, TRIAL_KEY, TrialMatcher, TrialRoute, parse_trial,
};
pub use version::{ABUSE_VERSION, RISK_PREFIX, risk_redis_keys};
