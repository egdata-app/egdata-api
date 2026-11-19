//! Anti-abuse middleware stack, PoW challenge endpoint, telemetry observations, and cohorts.
//!
//! Port target: `src/middleware/anti-abuse.ts`, `src/services/anti-abuse-runtime.ts`,
//! `src/services/abuse-observation.ts`, `src/services/pow-cohorts.ts`.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap, VecDeque},
    pin::Pin,
    sync::{
        Arc, Mutex, OnceLock, RwLock,
        atomic::{AtomicBool, AtomicI64, AtomicU64, AtomicUsize, Ordering},
    },
    task::{Context, Poll},
    time::Duration,
};

use axum::{
    Json,
    body::{Body, BodyDataStream, Bytes, HttpBody},
    extract::{Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use chrono::Utc;
use egdata_core::{
    abuse::{
        ABUSE_VERSION, AbuseEvent, AbuseResource, AbuseScorer, PowSessionService,
        SUSPICIOUS_TTL_MS, SessionClaims, TrialMatcher, offer_hydration_resource,
    },
    error::CoreError,
    ports::{
        AbuseRiskStorePort, AbuseSummaryRow, AbuseSummaryStorePort, AbuseTrialStorePort,
        PowCohortStorePort, PowCohortUpdate,
    },
    v1::serialization::node_json,
};
use futures::Stream;
use rand::RngExt;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex as AsyncMutex, watch};

use crate::{
    middleware::origin_auth::constant_time_eq,
    state::{AntiAbuseMode, ApiConfig, AppState},
};

pub const SESSION_COOKIE: &str = "__Host-egdata-session";
pub const SESSION_HEADER: &str = "x-egdata-session";
pub const COHORT_WAIT_MS: i64 = 300_000;
pub const COHORT_LIMIT: usize = 10_000;
pub const SUMMARY_TTL_SECONDS: i64 = 86_400;

const DAY_MS: i64 = 86_400_000;
const CHALLENGE_BODY_LIMIT: usize = 4096;
const MAX_SLEEPERS: usize = 512;
const SCORER_QUEUE_CAPACITY: usize = 2048;
const REDIS_COOLDOWN_MS: i64 = 5000;
const OBSERVATION_MAX_FIELDS: usize = 4096;
const OBSERVATION_MAX_MINUTES: usize = 4;
const COHORT_MAX_PENDING: usize = 2048;

pub const POW_COUNTERS: &[&str] = &[
    "observedResponses",
    "challengeRequired",
    "challengeRequested",
    "puzzlesIssued",
    "proofsSubmitted",
    "proofsAccepted",
    "proofsRejected",
    "puzzlesReplaced",
    "invalidHandshakeRequests",
    "disabledHandshakeRequests",
    "passedWithSession",
    "wouldChallenge",
    "wouldTarpit",
];

const UNSTABLE_HEADERS: &[&str] = &[
    "cookie",
    "authorization",
    SESSION_HEADER,
    "content-type",
    "content-length",
    "origin",
    "referer",
    "host",
    "connection",
    "accept-encoding",
    "priority",
    "if-none-match",
    "if-modified-since",
    "cache-control",
    "pragma",
];

const OBSERVATION_ROOTS: &[&str] = &[
    "offers",
    "items",
    "sellers",
    "sales",
    "active-sales",
    "search",
    "featured",
    "countries",
    "regions",
    "tags",
    "builds",
    "sandboxes",
    "free-games",
    "collections",
    "franchises",
    "promotions",
    "multisearch",
    "catalog",
    "changelist",
    "game-awards",
];

const KNOWN_REASONS: &[&str] = &[
    "canary",
    "deep-only",
    "mostly-deep",
    "sequential-pages",
    "page-sweep",
    "route-hammering",
    "unique-id-sweep",
    "title-lookup-sweep",
    "regular-intervals",
    "high-volume",
    "large-search-volume",
    "transport-mismatch",
];

/// Response/request extension marking an anti-abuse canary response; `response_etag` skips these.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AntiAbuseCanaryResponse(pub bool);

/// Request extension allowing GraphQL resolvers to record executed field resources.
#[derive(Clone, Default)]
pub struct AntiAbuseGraphql(Arc<Mutex<Vec<AbuseResource>>>);

impl AntiAbuseGraphql {
    pub fn record(&self, resource: AbuseResource) {
        let mut guard = self.0.lock().expect("anti_abuse_graphql mutex poisoned");
        if guard.len() < 32 {
            guard.push(resource);
        }
    }

    pub fn take(&self) -> Vec<AbuseResource> {
        let mut guard = self.0.lock().expect("anti_abuse_graphql mutex poisoned");
        std::mem::take(&mut *guard)
    }
}

/// Request extension allowing search/sandbox handlers to record catalog traversal resources.
#[derive(Clone, Default)]
pub struct AntiAbuseCatalog(Arc<Mutex<Option<AbuseResource>>>);

impl AntiAbuseCatalog {
    pub fn record(&self, resource: AbuseResource) {
        let mut guard = self.0.lock().expect("anti_abuse_catalog mutex poisoned");
        *guard = Some(resource);
    }

    pub fn take(&self) -> Option<AbuseResource> {
        let mut guard = self.0.lock().expect("anti_abuse_catalog mutex poisoned");
        guard.take()
    }
}

/// Request extension exposing the evaluated anti-abuse session and actor metadata.
#[derive(Debug, Clone)]
pub struct AntiAbuseRequestContext {
    pub fingerprint_hash: String,
    pub trusted_transport: bool,
    pub session: Option<SessionClaims>,
    pub keys: Vec<String>,
    pub risk: f64,
}

#[derive(Clone, Default)]
struct ObservationSlot(Arc<Mutex<Option<AbuseObservation>>>);

impl ObservationSlot {
    fn set(&self, observation: AbuseObservation) {
        *self.0.lock().expect("observation slot poisoned") = Some(observation);
    }

    fn take(&self) -> Option<AbuseObservation> {
        self.0.lock().expect("observation slot poisoned").take()
    }
}

/// Extracted transport fingerprint profile and mismatch diagnostics.
#[derive(Debug, Clone, PartialEq)]
pub struct FingerprintResult {
    pub fingerprint_hash: String,
    pub trusted_transport: bool,
    pub header_order: Vec<String>,
    pub mismatches: Vec<String>,
    pub risk_score: f64,
}

fn unstable_header_prefix_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"^(?:cf-|x-|apollo-|apollographql-|access-control-request-|forwarded$|traceparent$|tracestate$)",
        )
        .expect("valid regex")
    })
}

fn chrome_ua_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"Chrome/").expect("valid regex"))
}

fn legacy_cipher_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)(?:RC4|3DES|DES-CBC|AES128-SHA$|AES256-SHA$)").expect("valid regex")
    })
}

fn protected_path_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"^/(?:offers|items|sellers|sales|active-sales|builds|changelist|free-games|collections|franchises|promotions|sandboxes|game-awards|multisearch)(?:/|$)",
        )
        .expect("valid regex")
    })
}

fn support_path_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"^/(?:search(?:/tags)?|featured|countries|regions|tags|offers/(?:genres|upcoming|latest-achievements))$",
        )
        .expect("valid regex")
    })
}

fn support_prefix_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^/(?:collections|free-games)(?:/|$)").expect("valid regex"))
}

fn sandbox_offers_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^/sandboxes/[^/]+/offers$").expect("valid regex"))
}

fn canary_token_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"egcanary_[a-f0-9]{32}").expect("valid regex"))
}

fn page_digits_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\d{1,9}$").expect("valid regex"))
}

fn item_id_path_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^/(?:offers|items|sellers)/([^/]+)").expect("valid regex"))
}

fn offer_id_path_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^/offers/[^/]+$").expect("valid regex"))
}

fn hex64_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-f0-9]{64}$").expect("valid regex"))
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

fn parse_js_asn(raw: Option<&str>) -> Option<serde_json::Number> {
    let trimmed = raw?.trim();
    if trimmed.is_empty() {
        return None;
    }
    let val: f64 = trimmed.parse().ok()?;
    if !val.is_finite() || val == 0.0 {
        return None;
    }
    if val.fract() == 0.0 && val >= i64::MIN as f64 && val <= i64::MAX as f64 {
        Some(serde_json::Number::from(val as i64))
    } else {
        serde_json::Number::from_f64(val)
    }
}

/// Extracts a privacy-preserving transport fingerprint matching `extractFingerprint` in Node.
/// Header values, IP addresses, and User-Agent strings never enter the identity hash.
pub fn extract_fingerprint(headers: &HeaderMap, config: &ApiConfig) -> FingerprintResult {
    let supplied_secret = header_str(headers, "x-egdata-edge-secret").unwrap_or("");
    let forwarded = config
        .anti_abuse_edge_secret
        .as_deref()
        .filter(|s| !s.is_empty())
        .is_some_and(|expected| constant_time_eq(supplied_secret.as_bytes(), expected.as_bytes()));

    let tls_cipher = if forwarded {
        header_str(headers, "x-egdata-tls-cipher")
    } else {
        None
    };
    let tls_version = if forwarded {
        header_str(headers, "x-egdata-tls-version")
    } else {
        None
    };
    let http_protocol = if forwarded {
        header_str(headers, "x-egdata-http-protocol")
    } else {
        None
    };
    let asn = if forwarded {
        parse_js_asn(header_str(headers, "x-egdata-asn"))
    } else {
        None
    };

    let trust_bot_headers = forwarded && config.anti_abuse_trust_bot_headers;
    let ja4 = if trust_bot_headers {
        header_str(headers, "cf-ja4")
    } else {
        None
    };
    let ja3 = if trust_bot_headers {
        header_str(headers, "cf-ja3-hash")
    } else {
        None
    };

    let raw_names: Vec<String> = if let Some(edge_order) = forwarded
        .then(|| header_str(headers, "x-egdata-header-order"))
        .flatten()
    {
        let truncated: String = edge_order.chars().take(4096).collect();
        truncated
            .split(',')
            .map(|name| name.trim().to_string())
            .collect()
    } else {
        headers.keys().map(|k| k.as_str().to_string()).collect()
    };

    let header_order: Vec<String> = raw_names
        .into_iter()
        .map(|name| name.to_ascii_lowercase())
        .filter(|key| {
            !UNSTABLE_HEADERS.contains(&key.as_str())
                && !unstable_header_prefix_regex().is_match(key)
        })
        .collect();

    let structural = [
        headers.contains_key("sec-fetch-site"),
        headers.contains_key("sec-fetch-mode"),
        headers.contains_key("sec-ch-ua"),
    ];

    let non_empty = |opt: Option<&str>| opt.is_some_and(|s| !s.is_empty());
    let trusted_transport = forwarded
        && (non_empty(ja3) || non_empty(ja4) || (non_empty(tls_cipher) && non_empty(tls_version)));

    let ja_value = ja4
        .filter(|s| !s.is_empty())
        .or_else(|| ja3.filter(|s| !s.is_empty()))
        .unwrap_or("");
    let asn_value = match asn {
        Some(num) => Value::Number(num),
        None => Value::String(String::new()),
    };
    let profile = json!([
        ABUSE_VERSION,
        ja_value,
        tls_cipher.unwrap_or(""),
        tls_version.unwrap_or(""),
        http_protocol.unwrap_or(""),
        asn_value,
        header_order,
        structural,
    ]);
    let serialized = serde_json::to_string(&profile).expect("profile serializes");
    let fingerprint_hash = hex::encode(Sha256::digest(serialized.as_bytes()));

    let ua = header_str(headers, "user-agent").unwrap_or("");
    let is_chrome = chrome_ua_regex().is_match(ua);
    let mut mismatches = Vec::new();
    if is_chrome && !headers.contains_key("sec-ch-ua") {
        mismatches.push("chrome-without-client-hints".to_string());
    }
    if is_chrome
        && trusted_transport
        && http_protocol == Some("HTTP/1.1")
        && legacy_cipher_regex().is_match(tls_cipher.unwrap_or(""))
    {
        mismatches.push("browser-legacy-transport".to_string());
    }
    let risk_score = (mismatches.len() as f64 * 0.15).min(0.3);

    FingerprintResult {
        fingerprint_hash,
        trusted_transport,
        header_order,
        mismatches,
        risk_score,
    }
}

fn decode_uri_component(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hi = *bytes.get(i + 1)?;
            let lo = *bytes.get(i + 2)?;
            let hex = [hi, lo];
            let s = std::str::from_utf8(&hex).ok()?;
            let byte = u8::from_str_radix(s, 16).ok()?;
            out.push(byte);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Decodes percent-encoded path components and strips trailing slashes, matching `normalizedAbusePath`.
pub fn normalized_abuse_path(path: &str) -> String {
    match decode_uri_component(path) {
        Some(decoded) => {
            let trimmed = decoded.trim_end_matches('/');
            if trimmed.is_empty() {
                "/".to_string()
            } else {
                trimmed.to_string()
            }
        }
        None => path.to_string(),
    }
}

/// Returns `true` for catalog/deep routes and any request with pagination query parameters.
pub fn is_protected_path(path: &str, query: Option<&str>) -> bool {
    let norm = normalized_abuse_path(path);
    if protected_path_regex().is_match(&norm)
        || norm == "/catalog/hydrate"
        || norm == "/graphql"
        || norm == "/search/v2/search"
    {
        return true;
    }
    let Some(q) = query else {
        return false;
    };
    url::form_urlencoded::parse(q.as_bytes())
        .any(|(k, _)| matches!(k.as_ref(), "page" | "offset" | "cursor" | "limit"))
}

/// Returns `true` for lightweight support routes that balance deep/support traffic ratios.
pub fn is_support_path(path: &str) -> bool {
    support_path_regex().is_match(path) || support_prefix_regex().is_match(path)
}

/// Marks a response as private and uncacheable, removing any ETag header.
pub fn private_response(headers: &mut HeaderMap) {
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(
        HeaderName::from_static("cdn-cache-control"),
        HeaderValue::from_static("no-store"),
    );
    headers.insert(
        HeaderName::from_static("cloudflare-cdn-cache-control"),
        HeaderValue::from_static("no-store"),
    );
    headers.remove(header::ETAG);
}

/// Non-blocking delay cancelled automatically when the request future is dropped on disconnect.
pub async fn tarpit_delay(ms: u64) {
    if ms > 0 {
        tokio::time::sleep(Duration::from_millis(ms)).await;
    }
}

/// Observation scope matching `AbuseObservation["scope"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObservationScope {
    Observe,
    Enforce,
    Trial,
}

impl ObservationScope {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Observe => "observe",
            Self::Enforce => "enforce",
            Self::Trial => "trial",
        }
    }
}

/// Observation action matching `AbuseObservation["action"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObservationAction {
    Serve,
    Challenge,
    Tarpit,
    Handshake,
}

impl ObservationAction {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Serve => "serve",
            Self::Challenge => "challenge",
            Self::Tarpit => "tarpit",
            Self::Handshake => "handshake",
        }
    }
}

/// Observation decision matching `AbuseObservation["decision"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObservationDecision {
    Serve,
    Challenge,
    Tarpit,
}

/// PoW handshake outcome matching `AbuseObservation["handshakeOutcome"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandshakeOutcome {
    Issued,
    Accepted,
    Replaced,
    Invalid,
    Disabled,
}

/// Per-request anti-abuse telemetry record passed from middleware/challenge to `observe_response`.
#[derive(Debug, Clone, PartialEq)]
pub struct AbuseObservation {
    pub at: i64,
    pub route: String,
    pub method: String,
    pub scope: ObservationScope,
    pub action: ObservationAction,
    pub risk: f64,
    pub reasons: Vec<String>,
    pub tracked: bool,
    pub decision: Option<ObservationDecision>,
    pub session_valid: Option<bool>,
    pub cohort_fingerprint: Option<String>,
    pub handshake_outcome: Option<HandshakeOutcome>,
}

/// Extracts zero-filled PoW counter totals from raw summary fields.
pub fn pow_counters(totals: &BTreeMap<String, i64>) -> BTreeMap<&'static str, i64> {
    POW_COUNTERS
        .iter()
        .map(|&name| {
            let val = totals.get(&format!("pow:{name}")).copied().unwrap_or(0);
            (name, val)
        })
        .collect()
}

/// Fixed low-cardinality route label for telemetry summaries.
pub fn observation_route(path: &str) -> String {
    if matches!(path, "/auth/challenge" | "/search/v2/search" | "/graphql") {
        return path.to_string();
    }
    if offer_id_path_regex().is_match(path) {
        return "/offers/{id}".to_string();
    }
    if path.starts_with("/offers/") {
        return "/offers/{id}/*".to_string();
    }
    if sandbox_offers_regex().is_match(path) {
        return "/sandboxes/{id}/offers".to_string();
    }
    let root = path.split('/').nth(1).unwrap_or("");
    if OBSERVATION_ROOTS.contains(&root) {
        format!("/{root}")
    } else {
        "/other".to_string()
    }
}

/// Cohort funnel statistics returned by `cohort_report`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CohortState {
    pub first_challenge: i64,
    pub last_challenge: i64,
    pub last_puzzle: i64,
    pub last_solve: i64,
}

/// Aggregated daily PoW cohort funnel report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CohortReport {
    pub challenged: u64,
    pub solved: u64,
    pub pending: u64,
    pub no_solution_observed: u64,
    pub no_puzzle_requested: u64,
    pub puzzle_requested_unsolved: u64,
    pub waiting_period_seconds: i64,
    pub first_observed_at: Option<String>,
    pub last_observed_at: Option<String>,
    pub capacity_reached: bool,
    pub limitations: &'static str,
}

/// Summarizes a daily Redis cohort hash into funnel counters.
pub fn cohort_report(raw: &BTreeMap<String, String>, now_ms: i64) -> CohortReport {
    let mut challenged = 0;
    let mut solved = 0;
    let mut pending = 0;
    let mut no_solution_observed = 0;
    let mut no_puzzle_requested = 0;
    let mut puzzle_requested_unsolved = 0;

    for (id, value) in raw {
        if id.starts_with("__") {
            continue;
        }
        let Ok(state) = serde_json::from_str::<CohortState>(value) else {
            continue;
        };
        if state.first_challenge == 0 {
            continue;
        }
        challenged += 1;
        if state.last_solve >= state.first_challenge {
            solved += 1;
        } else if now_ms - state.first_challenge < COHORT_WAIT_MS {
            pending += 1;
        } else {
            no_solution_observed += 1;
            if state.last_puzzle >= state.first_challenge {
                puzzle_requested_unsolved += 1;
            } else {
                no_puzzle_requested += 1;
            }
        }
    }

    let parse_iso = |key: &str| {
        raw.get(key)
            .and_then(|s| s.parse::<i64>().ok())
            .and_then(chrono::DateTime::from_timestamp_millis)
            .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
    };

    CohortReport {
        challenged,
        solved,
        pending,
        no_solution_observed,
        no_puzzle_requested,
        puzzle_requested_unsolved,
        waiting_period_seconds: COHORT_WAIT_MS / 1000,
        first_observed_at: parse_iso("__firstObservedAt"),
        last_observed_at: parse_iso("__lastObservedAt"),
        capacity_reached: raw.get("__capacityReached").map(String::as_str) == Some("1"),
        limitations: "Daily trusted fingerprint cohorts, not unique clients or people. Solved means at least one accepted proof after the day's first challenge; later re-challenges do not undo it. No solution observed after five minutes does not prove deliberate ignoring. Fingerprint sharing/changes, missing edge trust, dropped telemetry and disconnects limit attribution. Enforce only; no historical backfill or scoped trials. Handshakes on the following UTC day can update a retained cohort; storage expires at the end of that following day.",
    }
}

/// Enforce-only daily PoW cohort funnel buffer & flusher.
pub struct PowCohorts {
    store: Arc<dyn PowCohortStorePort>,
    pending: Mutex<HashMap<String, PowCohortUpdate>>,
    dropped: AtomicU64,
    untracked: AtomicU64,
    store_errors: AtomicU64,
}

impl PowCohorts {
    pub fn new(store: Arc<dyn PowCohortStorePort>) -> Self {
        Self {
            store,
            pending: Mutex::new(HashMap::new()),
            dropped: AtomicU64::new(0),
            untracked: AtomicU64::new(0),
            store_errors: AtomicU64::new(0),
        }
    }

    pub fn stats(&self) -> (u64, u64, u64) {
        (
            self.dropped.load(Ordering::Relaxed),
            self.untracked.load(Ordering::Relaxed),
            self.store_errors.load(Ordering::Relaxed),
        )
    }

    pub fn record(&self, o: &AbuseObservation) {
        if o.scope != ObservationScope::Enforce {
            return;
        }
        let challenge = o.action == ObservationAction::Challenge;
        let puzzle = matches!(
            o.handshake_outcome,
            Some(HandshakeOutcome::Issued | HandshakeOutcome::Replaced)
        );
        let solve = o.handshake_outcome == Some(HandshakeOutcome::Accepted);
        if !challenge && !puzzle && !solve {
            return;
        }
        let Some(fp) = o
            .cohort_fingerprint
            .as_deref()
            .filter(|fp| hex64_regex().is_match(fp))
        else {
            self.untracked.fetch_add(1, Ordering::Relaxed);
            return;
        };

        let current = o.at.div_euclid(DAY_MS);
        let days: &[i64] = if challenge {
            &[current]
        } else {
            &[current, current - 1]
        };

        let mut pending = self.pending.lock().expect("pow_cohorts pending poisoned");
        for &day in days {
            let id = hex::encode(Sha256::digest(format!("pow-cohort:{day}:{fp}").as_bytes()));
            let key = format!("{day}:{id}");
            if !pending.contains_key(&key) {
                if pending.len() >= COHORT_MAX_PENDING {
                    self.dropped.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
                pending.insert(
                    key.clone(),
                    PowCohortUpdate {
                        day,
                        id,
                        first_challenge: 0,
                        last_challenge: 0,
                        last_puzzle: 0,
                        last_solve: 0,
                    },
                );
            }
            let row = pending.get_mut(&key).expect("inserted above");
            if challenge {
                row.first_challenge = if row.first_challenge > 0 {
                    row.first_challenge.min(o.at)
                } else {
                    o.at
                };
                row.last_challenge = row.last_challenge.max(o.at);
            }
            if puzzle {
                row.last_puzzle = row.last_puzzle.max(o.at);
            }
            if solve {
                row.last_solve = row.last_solve.max(o.at);
            }
        }
    }

    pub async fn flush(&self) {
        let rows: Vec<PowCohortUpdate> = {
            let mut pending = self.pending.lock().expect("pow_cohorts pending poisoned");
            pending.drain().map(|(_, v)| v).collect()
        };
        if rows.is_empty() {
            return;
        }
        if self.store.write(&rows).await.is_err() {
            self.store_errors.fetch_add(1, Ordering::Relaxed);
        }
    }
}

struct ObservationBuffer {
    pending: BTreeMap<i64, BTreeMap<String, i64>>,
    fields: usize,
}

/// Minute-bucketed anti-abuse observation accumulator and flusher.
pub struct AbuseObservations {
    store: Arc<dyn AbuseSummaryStorePort>,
    cohorts: Option<Arc<PowCohorts>>,
    now: fn() -> i64,
    buffer: Mutex<ObservationBuffer>,
    flush_lock: AsyncMutex<()>,
    dropped: AtomicU64,
    store_errors: AtomicU64,
}

impl AbuseObservations {
    pub fn new(
        store: Arc<dyn AbuseSummaryStorePort>,
        cohorts: Option<Arc<PowCohorts>>,
        now: fn() -> i64,
    ) -> Self {
        Self {
            store,
            cohorts,
            now,
            buffer: Mutex::new(ObservationBuffer {
                pending: BTreeMap::new(),
                fields: 0,
            }),
            flush_lock: AsyncMutex::new(()),
            dropped: AtomicU64::new(0),
            store_errors: AtomicU64::new(0),
        }
    }

    pub fn stats(&self) -> (u64, u64) {
        (
            self.dropped.load(Ordering::Relaxed),
            self.store_errors.load(Ordering::Relaxed),
        )
    }

    pub fn increment(&self, name: &str, value: i64, at_ms: Option<i64>) {
        let now_ms = (self.now)();
        let at = at_ms.unwrap_or(now_ms);
        let minute = at.div_euclid(60_000);
        if minute < now_ms.div_euclid(60_000) - 1439 {
            return;
        }

        let mut guard = self.buffer.lock().expect("observations buffer poisoned");
        let missing_minute = !guard.pending.contains_key(&minute);
        let missing_field = guard
            .pending
            .get(&minute)
            .is_none_or(|row| !row.contains_key(name));
        if missing_field {
            if guard.fields >= OBSERVATION_MAX_FIELDS
                || (missing_minute && guard.pending.len() >= OBSERVATION_MAX_MINUTES)
            {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                return;
            }
            guard.fields += 1;
        }
        let row = guard.pending.entry(minute).or_default();
        *row.entry(name.to_string()).or_insert(0) += value;
    }

    pub fn record(&self, o: &AbuseObservation, status: u16, bytes: usize, complete: bool) {
        if let Some(ref cohorts) = self.cohorts {
            cohorts.record(o);
        }
        let method = if matches!(o.method.as_str(), "GET" | "POST" | "HEAD") {
            o.method.as_str()
        } else {
            "OTHER"
        };
        let label = format!(
            "{}|{}|{}|{}",
            o.scope.as_str(),
            observation_route(&o.route),
            method,
            o.action.as_str()
        );
        let add = |name: &str, value: i64| {
            self.increment(&format!("{label}|{name}"), value, Some(o.at));
        };

        add("requests", 1);
        add("bodyBytes", bytes as i64);
        add(&format!("status:{}xx", status / 100), 1);
        let risk_bucket = ((o.risk * 10.0).floor() as i64).clamp(0, 10);
        add(&format!("risk:{risk_bucket}"), 1);
        let risk_band = if o.risk > 0.8 {
            "high"
        } else if o.risk > 0.5 {
            "suspicious"
        } else {
            "clean"
        };
        add(&format!("riskBand:{risk_band}"), 1);
        add(if complete { "complete" } else { "incomplete" }, 1);
        if !o.tracked {
            add("untracked", 1);
        }

        if o.decision.is_some() || o.handshake_outcome.is_some() {
            add("pow:observedResponses", 1);
            if o.action == ObservationAction::Challenge {
                add("pow:challengeRequired", 1);
            }
            if o.action == ObservationAction::Serve && o.session_valid == Some(true) {
                add("pow:passedWithSession", 1);
            }
            if o.scope == ObservationScope::Observe && o.action == ObservationAction::Serve {
                if o.decision == Some(ObservationDecision::Challenge) {
                    add("pow:wouldChallenge", 1);
                }
                if o.decision == Some(ObservationDecision::Tarpit) {
                    add("pow:wouldTarpit", 1);
                }
            }
            match o.handshake_outcome {
                Some(HandshakeOutcome::Issued) => {
                    add("pow:challengeRequested", 1);
                    add("pow:puzzlesIssued", 1);
                }
                Some(HandshakeOutcome::Accepted) => {
                    add("pow:proofsSubmitted", 1);
                    add("pow:proofsAccepted", 1);
                }
                Some(HandshakeOutcome::Replaced) => {
                    add("pow:proofsSubmitted", 1);
                    add("pow:proofsRejected", 1);
                    add("pow:puzzlesIssued", 1);
                    add("pow:puzzlesReplaced", 1);
                }
                Some(HandshakeOutcome::Invalid) => {
                    add("pow:invalidHandshakeRequests", 1);
                }
                Some(HandshakeOutcome::Disabled) => {
                    add("pow:disabledHandshakeRequests", 1);
                }
                None => {}
            }
        }

        let unique_reasons: BTreeSet<&str> = o.reasons.iter().map(String::as_str).collect();
        for reason in unique_reasons {
            if KNOWN_REASONS.contains(&reason) {
                add(&format!("reason:{reason}"), 1);
            }
        }
    }

    pub async fn flush(&self) {
        let _flush_guard = self.flush_lock.lock().await;
        let rows: Vec<AbuseSummaryRow> = {
            let mut guard = self.buffer.lock().expect("observations buffer poisoned");
            if guard.pending.is_empty() && self.cohorts.is_none() {
                return;
            }
            guard.fields = 0;
            std::mem::take(&mut guard.pending)
                .into_iter()
                .map(|(minute, values)| AbuseSummaryRow { minute, values })
                .collect()
        };

        let store_fut = async {
            if !rows.is_empty() && self.store.write(&rows).await.is_err() {
                self.store_errors.fetch_add(1, Ordering::Relaxed);
            }
        };
        let cohort_fut = async {
            if let Some(ref cohorts) = self.cohorts {
                cohorts.flush().await;
            }
        };
        tokio::join!(store_fut, cohort_fut);
    }
}

/// Polls operator-controlled Redis trial configuration (`egdata:abuse:trial:v2`).
pub struct AbuseTrialController {
    store: Arc<dyn AbuseTrialStorePort>,
    now: fn() -> i64,
    matcher: RwLock<TrialMatcher>,
    polling: AtomicBool,
    closed: AtomicBool,
}

impl AbuseTrialController {
    pub fn new(store: Arc<dyn AbuseTrialStorePort>, now: fn() -> i64) -> Self {
        Self {
            store,
            now,
            matcher: RwLock::new(TrialMatcher::new(None)),
            polling: AtomicBool::new(false),
            closed: AtomicBool::new(false),
        }
    }

    pub async fn poll(&self) {
        if self.closed.load(Ordering::Relaxed)
            || self
                .polling
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
        {
            return;
        }
        let result = self.store.get_trial_raw().await;
        if !self.closed.load(Ordering::Relaxed) {
            let mut guard = self.matcher.write().expect("trial matcher lock poisoned");
            match result {
                Ok(raw) => guard.update_from_raw(raw.as_deref(), (self.now)()),
                Err(_) => guard.clear(),
            }
        }
        self.polling.store(false, Ordering::SeqCst);
    }

    pub fn matches(&self, fingerprint: &str, path: &str, method: &str, now_ms: i64) -> bool {
        if self.closed.load(Ordering::Relaxed) {
            return false;
        }
        self.matcher
            .read()
            .expect("trial matcher lock poisoned")
            .matches(fingerprint, path, method, now_ms)
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.matcher
            .write()
            .expect("trial matcher lock poisoned")
            .clear();
    }
}

struct QueuedEvent {
    keys: Vec<String>,
    event: AbuseEvent,
}

/// Asynchronous sliding-window scorer backed by `egdata_core::abuse::AbuseScorer` and Redis.
pub struct AbuseScorerRuntime {
    store: Arc<dyn AbuseRiskStorePort>,
    now: fn() -> i64,
    scorer: Mutex<AbuseScorer>,
    queue: Mutex<VecDeque<QueuedEvent>>,
    drain_lock: AsyncMutex<()>,
    draining: AtomicBool,
    unavailable_until: AtomicI64,
    closed: AtomicBool,
    dropped: AtomicU64,
    store_errors: AtomicU64,
    processed: AtomicU64,
}

impl AbuseScorerRuntime {
    pub fn new(store: Arc<dyn AbuseRiskStorePort>, now: fn() -> i64, capacity: usize) -> Self {
        Self {
            store,
            now,
            scorer: Mutex::new(AbuseScorer::new(capacity)),
            queue: Mutex::new(VecDeque::new()),
            drain_lock: AsyncMutex::new(()),
            draining: AtomicBool::new(false),
            unavailable_until: AtomicI64::new(0),
            closed: AtomicBool::new(false),
            dropped: AtomicU64::new(0),
            store_errors: AtomicU64::new(0),
            processed: AtomicU64::new(0),
        }
    }

    pub fn stats(&self) -> (u64, u64, u64) {
        (
            self.dropped.load(Ordering::Relaxed),
            self.store_errors.load(Ordering::Relaxed),
            self.processed.load(Ordering::Relaxed),
        )
    }

    pub fn risk(&self, keys: &[String], now_ms: i64) -> f64 {
        self.scorer
            .lock()
            .expect("scorer mutex poisoned")
            .risk(keys, now_ms)
    }

    pub fn reasons(&self, keys: &[String], now_ms: i64) -> Vec<String> {
        self.scorer
            .lock()
            .expect("scorer mutex poisoned")
            .reasons(keys, now_ms)
    }

    pub fn trap(&self, keys: &[String], now_ms: i64) {
        self.scorer
            .lock()
            .expect("scorer mutex poisoned")
            .trap(keys, now_ms);
    }

    pub fn enqueue(self: &Arc<Self>, keys: Vec<String>, event: AbuseEvent, now_ms: i64) {
        if self.closed.load(Ordering::Relaxed) || keys.is_empty() {
            return;
        }
        let is_trap = event.trap == Some(true);
        if is_trap {
            self.trap(&keys, now_ms);
        }
        {
            let mut queue = self.queue.lock().expect("scorer queue mutex poisoned");
            if queue.len() >= SCORER_QUEUE_CAPACITY {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                if !is_trap {
                    return;
                }
                queue.pop_back();
            }
            queue.push_back(QueuedEvent { keys, event });
        }
        if !self.draining.load(Ordering::Relaxed)
            && let Ok(handle) = tokio::runtime::Handle::try_current()
        {
            let this = Arc::clone(self);
            handle.spawn(async move {
                this.drain().await;
            });
        }
    }

    async fn process_item(&self, item: QueuedEvent) {
        for key in item.keys {
            let now_ms = (self.now)();
            {
                let mut scorer = self.scorer.lock().expect("scorer mutex poisoned");
                scorer.record_local(std::slice::from_ref(&key), &item.event, now_ms);
            }
            if now_ms >= self.unavailable_until.load(Ordering::Relaxed) {
                match self.store.append(&key, &item.event).await {
                    Ok(shared) => {
                        let mut scorer = self.scorer.lock().expect("scorer mutex poisoned");
                        scorer.merge_shared(&key, &shared.events, shared.trapped, (self.now)());
                    }
                    Err(_) => {
                        self.store_errors.fetch_add(1, Ordering::Relaxed);
                        self.unavailable_until
                            .store((self.now)() + REDIS_COOLDOWN_MS, Ordering::Relaxed);
                    }
                }
            }
        }
        self.processed.fetch_add(1, Ordering::Relaxed);
    }

    /// Drains all queued scoring events serially; safe to call concurrently from tests/shutdown.
    pub async fn drain(&self) {
        let _guard = self.drain_lock.lock().await;
        self.draining.store(true, Ordering::SeqCst);
        loop {
            let next = {
                let mut queue = self.queue.lock().expect("scorer queue mutex poisoned");
                queue.pop_front()
            };
            let Some(item) = next else {
                break;
            };
            self.process_item(item).await;
            if self.processed.load(Ordering::Relaxed).is_multiple_of(32) {
                tokio::task::yield_now().await;
            }
        }
        self.draining.store(false, Ordering::SeqCst);
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.queue
            .lock()
            .expect("scorer queue mutex poisoned")
            .clear();
    }
}

#[derive(Default)]
struct SystemMetricsLast {
    dropped: u64,
    store_errors: u64,
    processed: u64,
    summary_errors: u64,
    summary_dropped: u64,
    cohort_dropped: u64,
    cohort_untracked: u64,
    cohort_store_errors: u64,
}

type TarpitDelayHook = Arc<dyn Fn(u64) + Send + Sync>;

/// Coordinated anti-abuse runtime holding PoW sessions, scorer, observations, cohorts, and trial controller.
pub struct AntiAbuseRuntime {
    pub mode: AntiAbuseMode,
    pub sessions: Option<Arc<PowSessionService>>,
    pub scorer: Arc<AbuseScorerRuntime>,
    pub cohorts: Arc<PowCohorts>,
    pub observations: Arc<AbuseObservations>,
    pub trial: Arc<AbuseTrialController>,
    now: fn() -> i64,
    sleepers: AtomicUsize,
    shutdown_tx: watch::Sender<bool>,
    metrics_last: Mutex<SystemMetricsLast>,
    tarpit_hook: Option<TarpitDelayHook>,
    fixed_tarpit_ms: Option<u64>,
}

fn utc_now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

impl AntiAbuseRuntime {
    /// Builds a new runtime from `AppState`, panicking if enabled without a valid >=32-byte `ANTI_ABUSE_SECRET`.
    pub fn new(state: &AppState) -> Self {
        Self::try_new(state).expect("ANTI_ABUSE_SECRET must contain at least 32 bytes")
    }

    /// Builds a new runtime from `AppState`, validating `ANTI_ABUSE_SECRET` when mode is not `Off`.
    pub fn try_new(state: &AppState) -> Result<Self, CoreError> {
        Self::build(state, utc_now_ms, true, None, None)
    }

    fn build(
        state: &AppState,
        now: fn() -> i64,
        spawn_background: bool,
        fixed_tarpit_ms: Option<u64>,
        tarpit_hook: Option<TarpitDelayHook>,
    ) -> Result<Self, CoreError> {
        let mode = state.config.anti_abuse_mode;
        let sessions = if mode == AntiAbuseMode::Off {
            None
        } else {
            let secret = state.config.anti_abuse_secret.as_deref().unwrap_or("");
            Some(Arc::new(PowSessionService::new(secret)?))
        };

        let cohorts = Arc::new(PowCohorts::new(state.pow_cohorts.clone()));
        let observations = Arc::new(AbuseObservations::new(
            state.abuse_summary.clone(),
            Some(cohorts.clone()),
            now,
        ));
        let scorer = Arc::new(AbuseScorerRuntime::new(state.abuse_risk.clone(), now, 5000));
        let trial = Arc::new(AbuseTrialController::new(state.abuse_trial.clone(), now));
        let (shutdown_tx, shutdown_rx) = watch::channel(false);

        let runtime = Self {
            mode,
            sessions,
            scorer,
            cohorts,
            observations,
            trial,
            now,
            sleepers: AtomicUsize::new(0),
            shutdown_tx,
            metrics_last: Mutex::new(SystemMetricsLast::default()),
            tarpit_hook,
            fixed_tarpit_ms,
        };

        if spawn_background
            && mode != AntiAbuseMode::Off
            && let Ok(handle) = tokio::runtime::Handle::try_current()
        {
            runtime.spawn_background_tasks(
                &handle,
                shutdown_rx,
                Duration::from_secs(5),
                Duration::from_secs(2),
            );
        }

        Ok(runtime)
    }

    fn spawn_background_tasks(
        &self,
        handle: &tokio::runtime::Handle,
        shutdown_rx: watch::Receiver<bool>,
        obs_period: Duration,
        trial_period: Duration,
    ) {
        let obs = self.observations.clone();
        let scorer = self.scorer.clone();
        let cohorts = self.cohorts.clone();
        let mut rx_obs = shutdown_rx.clone();
        let last = Arc::new(Mutex::new(SystemMetricsLast::default()));
        handle.spawn(async move {
            let mut interval = tokio::time::interval(obs_period);
            interval.tick().await;
            loop {
                tokio::select! {
                    _ = interval.tick() => {
                        record_system_metrics_delta(&scorer, &obs, &cohorts, &last);
                        obs.flush().await;
                    }
                    _ = rx_obs.changed() => break,
                }
            }
        });

        if self.mode == AntiAbuseMode::Observe {
            let trial = self.trial.clone();
            let mut rx_trial = shutdown_rx;
            handle.spawn(async move {
                trial.poll().await;
                let mut interval = tokio::time::interval(trial_period);
                interval.tick().await;
                loop {
                    tokio::select! {
                        _ = interval.tick() => trial.poll().await,
                        _ = rx_trial.changed() => break,
                    }
                }
            });
        }
    }

    pub fn record_metrics_delta(&self) {
        record_system_metrics_delta(
            &self.scorer,
            &self.observations,
            &self.cohorts,
            &self.metrics_last,
        );
    }

    pub fn now_ms(&self) -> i64 {
        (self.now)()
    }

    /// Stops background timers/pollers, closes trial and scorer, and triggers a final flush if a Tokio runtime is active.
    pub fn close(&self) {
        let _ = self.shutdown_tx.send(true);
        self.trial.close();
        self.scorer.close();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let obs = self.observations.clone();
            handle.spawn(async move {
                obs.flush().await;
            });
        }
    }

    /// Async shutdown flushing buffered observations and cohorts before closing scorer.
    pub async fn shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
        self.trial.close();
        self.observations.flush().await;
        self.scorer.close();
    }
}

impl Drop for AntiAbuseRuntime {
    fn drop(&mut self) {
        let _ = self.shutdown_tx.send(true);
        self.trial.close();
        self.scorer.close();
    }
}

fn record_system_metrics_delta(
    scorer: &AbuseScorerRuntime,
    observations: &AbuseObservations,
    cohorts: &PowCohorts,
    last: &Mutex<SystemMetricsLast>,
) {
    let (dropped, store_errors, processed) = scorer.stats();
    let (summary_dropped, summary_errors) = observations.stats();
    let (cohort_dropped, cohort_untracked, cohort_store_errors) = cohorts.stats();

    let mut prev_guard = last.lock().expect("metrics_last mutex poisoned");
    let prev = &mut *prev_guard;
    let entries = [
        ("dropped", dropped, &mut prev.dropped),
        ("storeErrors", store_errors, &mut prev.store_errors),
        ("processed", processed, &mut prev.processed),
        ("summaryErrors", summary_errors, &mut prev.summary_errors),
        ("summaryDropped", summary_dropped, &mut prev.summary_dropped),
        ("cohortDropped", cohort_dropped, &mut prev.cohort_dropped),
        (
            "cohortUntracked",
            cohort_untracked,
            &mut prev.cohort_untracked,
        ),
        (
            "cohortStoreErrors",
            cohort_store_errors,
            &mut prev.cohort_store_errors,
        ),
    ];

    for (name, cur, prev_val) in entries {
        let delta = cur.saturating_sub(*prev_val);
        if delta > 0 {
            observations.increment(&format!("system|{name}"), delta as i64, None);
            *prev_val = cur;
        }
    }
}

fn runtime_registry() -> &'static Mutex<HashMap<usize, Arc<AntiAbuseRuntime>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<usize, Arc<AntiAbuseRuntime>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn resolve_runtime(state: &AppState, extensions: &axum::http::Extensions) -> Arc<AntiAbuseRuntime> {
    if let Some(ext) = extensions.get::<Arc<AntiAbuseRuntime>>() {
        return Arc::clone(ext);
    }
    let key = Arc::as_ptr(&state.config) as usize;
    let mut guard = runtime_registry()
        .lock()
        .expect("runtime registry poisoned");
    Arc::clone(
        guard
            .entry(key)
            .or_insert_with(|| Arc::new(AntiAbuseRuntime::new(state))),
    )
}

fn extract_session_token(headers: &HeaderMap) -> String {
    if let Some(header_val) = header_str(headers, SESSION_HEADER) {
        return header_val.to_string();
    }
    for cookie_header in headers.get_all(header::COOKIE) {
        let Ok(raw) = cookie_header.to_str() else {
            continue;
        };
        for pair in raw.split(';') {
            let trimmed = pair.trim();
            if let Some((name, value)) = trimmed.split_once('=')
                && name.trim() == SESSION_COOKIE
            {
                let v = value.trim();
                return decode_uri_component(v).unwrap_or_else(|| v.to_string());
            }
        }
    }
    String::new()
}

fn keys_for(fp: &FingerprintResult, session_id: Option<&str>) -> Vec<String> {
    let mut keys = Vec::new();
    if fp.trusted_transport {
        keys.push(format!("fp:{}", fp.fingerprint_hash));
    }
    if let Some(sid) = session_id {
        keys.push(format!("session:{sid}"));
    }
    keys
}

fn attach_observation(resp: &mut Response, slot: Option<&ObservationSlot>, obs: AbuseObservation) {
    if let Some(slot) = slot {
        slot.set(obs.clone());
    }
    resp.extensions_mut().insert(obs);
}

fn challenge_json_response(
    status: StatusCode,
    value: &Value,
    slot: Option<&ObservationSlot>,
    obs: AbuseObservation,
) -> Response {
    let mut resp = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(node_json(value)))
        .expect("valid json response");
    private_response(resp.headers_mut());
    resp.extensions_mut().insert(AntiAbuseCanaryResponse(true));
    attach_observation(&mut resp, slot, obs);
    resp
}

/// Returns the canonical synthetic canary item record for `/items` list injection.
pub fn canary_item(canary_id: &str) -> Value {
    json!({
        "id": canary_id,
        "title": "",
        "namespace": "egdata-canary",
        "synthetic": true,
    })
}

/// Computes the synthetic canary item record for a GET `/items` request when canaries are enabled
/// in `Enforce` mode and the request carries a valid PoW session.
pub fn canary_item_for_request(state: &AppState, headers: &HeaderMap) -> Option<Value> {
    if state.config.anti_abuse_mode != AntiAbuseMode::Enforce || !state.config.anti_abuse_canaries {
        return None;
    }
    let secret = state.config.anti_abuse_secret.as_deref()?;
    let sessions = PowSessionService::new(secret).ok()?;
    let fp = extract_fingerprint(headers, &state.config);
    let token = extract_session_token(headers);
    let now_ms = (state.now)().timestamp_millis();
    sessions.verify_at(&token, &fp.fingerprint_hash, now_ms)?;
    Some(canary_item(&sessions.canary(&fp.fingerprint_hash)))
}

struct SleeperGuard<'a> {
    counter: &'a AtomicUsize,
}

impl Drop for SleeperGuard<'_> {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::Relaxed);
    }
}

fn query_pairs(query: Option<&str>) -> Vec<(String, String)> {
    query
        .map(|q| {
            url::form_urlencoded::parse(q.as_bytes())
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect()
        })
        .unwrap_or_default()
}

fn content_type_is_json(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.contains("application/json"))
}

fn inject_canary_into_body(bytes: &[u8], canary_id: &str) -> Option<Vec<u8>> {
    let mut body: Value = serde_json::from_slice(bytes).ok()?;
    let obj = body.as_object_mut()?;
    let elements = obj.get_mut("elements")?.as_array_mut()?;
    if !elements
        .iter()
        .any(|item| item.get("synthetic") == Some(&Value::Bool(true)))
    {
        elements.push(canary_item(canary_id));
    }
    Some(node_json(&body).into_bytes())
}

/// `POST /auth/challenge` PoW handshake endpoint matching `createAntiAbuse().challenge`.
pub async fn challenge(State(state): State<AppState>, req: Request) -> Response {
    let slot = req.extensions().get::<ObservationSlot>().cloned();
    if state.config.anti_abuse_mode == AntiAbuseMode::Off {
        let mut resp = (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": { "code": "ANTI_ABUSE_DISABLED" } })),
        )
            .into_response();
        resp.headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        return resp;
    }

    let runtime = resolve_runtime(&state, req.extensions());
    let now_ms = runtime.now_ms();
    let (parts, body) = req.into_parts();
    let mut observation = AbuseObservation {
        at: now_ms,
        route: "/auth/challenge".to_string(),
        method: parts.method.to_string(),
        scope: if runtime.mode == AntiAbuseMode::Enforce {
            ObservationScope::Enforce
        } else {
            ObservationScope::Observe
        },
        action: ObservationAction::Handshake,
        risk: 0.0,
        reasons: Vec::new(),
        tracked: false,
        decision: None,
        session_valid: None,
        cohort_fingerprint: None,
        handshake_outcome: Some(HandshakeOutcome::Invalid),
    };

    let Ok(raw_bytes) = axum::body::to_bytes(body, CHALLENGE_BODY_LIMIT).await else {
        return challenge_json_response(
            StatusCode::BAD_REQUEST,
            &json!({ "error": { "code": "INVALID_CHALLENGE" } }),
            slot.as_ref(),
            observation,
        );
    };

    let parsed: Value = if raw_bytes.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice(&raw_bytes) {
            Ok(Value::Object(map)) => Value::Object(map),
            _ => {
                return challenge_json_response(
                    StatusCode::BAD_REQUEST,
                    &json!({ "error": { "code": "INVALID_CHALLENGE" } }),
                    slot.as_ref(),
                    observation,
                );
            }
        }
    };

    let fp = extract_fingerprint(&parts.headers, &state.config);
    let sessions = runtime
        .sessions
        .as_ref()
        .expect("sessions initialized when anti_abuse_mode != Off");
    let token = extract_session_token(&parts.headers);
    let previous = sessions.verify_at(&token, &fp.fingerprint_hash, now_ms);
    let keys = keys_for(&fp, previous.as_ref().map(|s| s.session_id.as_str()));
    let risk = fp.risk_score.max(runtime.scorer.risk(&keys, now_ms));

    observation.risk = risk;
    observation.reasons = runtime.scorer.reasons(&keys, now_ms);
    observation.tracked = !keys.is_empty();
    observation.cohort_fingerprint = fp.trusted_transport.then(|| fp.fingerprint_hash.clone());

    let challenge_field = parsed.get("challenge");
    let nonce_field = parsed.get("nonce");
    if challenge_field.is_some() || nonce_field.is_some() {
        let (Some(challenge_str), Some(nonce_str)) = (
            challenge_field.and_then(Value::as_str),
            nonce_field.and_then(Value::as_str),
        ) else {
            return challenge_json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": { "code": "INVALID_CHALLENGE" } }),
                slot.as_ref(),
                observation,
            );
        };
        if let Some(redeemed) =
            sessions.redeem_at(challenge_str, nonce_str, &fp.fingerprint_hash, risk, now_ms)
        {
            observation.handshake_outcome = Some(HandshakeOutcome::Accepted);
            let max_age = ((redeemed.expires_at - now_ms) / 1000).max(0);
            let mut resp = challenge_json_response(
                StatusCode::OK,
                &json!({ "token": redeemed.token, "expiresAt": redeemed.expires_at }),
                slot.as_ref(),
                observation,
            );
            let cookie = format!(
                "{SESSION_COOKIE}={}; Max-Age={max_age}; Path=/; HttpOnly; Secure; SameSite=Lax",
                redeemed.token
            );
            if let Ok(val) = HeaderValue::from_str(&cookie) {
                resp.headers_mut().append(header::SET_COOKIE, val);
            }
            return resp;
        }
        observation.handshake_outcome = Some(HandshakeOutcome::Replaced);
    } else {
        observation.handshake_outcome = Some(HandshakeOutcome::Issued);
    }

    let issued = sessions.challenge_at(
        &fp.fingerprint_hash,
        risk,
        previous.as_ref().map(|s| s.session_id.as_str()),
        now_ms,
    );
    challenge_json_response(
        StatusCode::OK,
        &serde_json::to_value(issued).expect("challenge serializes"),
        slot.as_ref(),
        observation,
    )
}

/// Main anti-abuse enforcement and telemetry middleware matching `createAntiAbuse().middleware`.
pub async fn middleware(State(state): State<AppState>, mut req: Request, next: Next) -> Response {
    if state.config.anti_abuse_mode == AntiAbuseMode::Off
        || req.method() == Method::OPTIONS
        || req.uri().path() == "/auth/challenge"
    {
        return next.run(req).await;
    }

    let path = normalized_abuse_path(req.uri().path());
    let query_str = req.uri().query().map(str::to_string);
    let protected_route = is_protected_path(&path, query_str.as_deref());
    let support = is_support_path(&path);
    if !protected_route && !support {
        return next.run(req).await;
    }

    let runtime = resolve_runtime(&state, req.extensions());
    let slot = req.extensions().get::<ObservationSlot>().cloned();
    let sessions = runtime
        .sessions
        .as_ref()
        .expect("sessions initialized when anti_abuse_mode != Off");
    let now_ms = runtime.now_ms();
    let method_str = req.method().to_string();

    let fp = extract_fingerprint(req.headers(), &state.config);
    let token = extract_session_token(req.headers());
    let session = sessions.verify_at(&token, &fp.fingerprint_hash, now_ms);
    let keys = keys_for(&fp, session.as_ref().map(|s| s.session_id.as_str()));

    let search = path == "/search/v2/search" || sandbox_offers_regex().is_match(&path);
    let pairs = query_pairs(query_str.as_deref());
    let search_values = pairs
        .iter()
        .map(|(_, v)| v.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let canary_haystack = format!("{path} {search_values}");
    let requested_canaries: Vec<&str> = canary_token_regex()
        .find_iter(&canary_haystack)
        .map(|m| m.as_str())
        .collect();

    let mut event = AbuseEvent {
        resource: AbuseResource {
            route: path.chars().take(256).collect(),
            page: if !search {
                pairs.iter().find(|(k, _)| k == "page").and_then(|(_, v)| {
                    page_digits_regex()
                        .is_match(v)
                        .then(|| v.parse::<u32>().ok())
                        .flatten()
                })
            } else {
                None
            },
            item_id: item_id_path_regex()
                .captures(&path)
                .and_then(|c| c.get(1))
                .map(|m| m.as_str().chars().take(128).collect()),
            limit: None,
            search: None,
            title_hash: None,
            hydration_id: None,
            hydration_route: None,
            cache_hit: None,
        },
        at: now_ms,
        deep: protected_route && !support,
        support,
        resources: None,
        mismatch: fp.risk_score,
        trap: None,
        method: Some(method_str.clone()),
    };

    if let Some(hydration) = offer_hydration_resource(&path, &method_str, &pairs) {
        hydration.apply_to(&mut event.resource);
    }

    if !requested_canaries.is_empty() {
        let expected_canary = sessions.canary(&fp.fingerprint_hash);
        event.trap = Some(requested_canaries.iter().any(|&c| c == expected_canary));
    }
    if event.trap == Some(true) {
        runtime.scorer.trap(&keys, now_ms);
    }

    let risk = fp.risk_score.max(runtime.scorer.risk(&keys, now_ms));
    let trial = runtime.mode == AntiAbuseMode::Observe
        && fp.trusted_transport
        && runtime
            .trial
            .matches(&fp.fingerprint_hash, &path, &method_str, now_ms);
    let enforcing = runtime.mode == AntiAbuseMode::Enforce || trial;

    let decision = if protected_route && risk > 0.8 {
        ObservationDecision::Tarpit
    } else if protected_route
        && risk > 0.5
        && session
            .as_ref()
            .is_none_or(|s| now_ms - s.issued_at >= SUSPICIOUS_TTL_MS)
    {
        ObservationDecision::Challenge
    } else {
        ObservationDecision::Serve
    };

    let mut observation = AbuseObservation {
        at: event.at,
        route: path.clone(),
        method: method_str.clone(),
        scope: if trial {
            ObservationScope::Trial
        } else if runtime.mode == AntiAbuseMode::Enforce {
            ObservationScope::Enforce
        } else {
            ObservationScope::Observe
        },
        action: ObservationAction::Serve,
        risk,
        reasons: runtime.scorer.reasons(&keys, now_ms),
        tracked: !keys.is_empty(),
        decision: Some(decision),
        session_valid: Some(session.is_some()),
        cohort_fingerprint: fp.trusted_transport.then(|| fp.fingerprint_hash.clone()),
        handshake_outcome: None,
    };

    let graphql = path == "/graphql";
    let catalog_ext = if search {
        let ext = AntiAbuseCatalog::default();
        req.extensions_mut().insert(ext.clone());
        Some(ext)
    } else {
        None
    };
    let graphql_ext = if graphql {
        let ext = AntiAbuseGraphql::default();
        req.extensions_mut().insert(ext.clone());
        Some(ext)
    } else {
        None
    };

    req.extensions_mut().insert(AntiAbuseRequestContext {
        fingerprint_hash: fp.fingerprint_hash.clone(),
        trusted_transport: fp.trusted_transport,
        session: session.clone(),
        keys: keys.clone(),
        risk,
    });

    if !graphql && !search {
        runtime.scorer.enqueue(keys.clone(), event.clone(), now_ms);
    }

    if !enforcing {
        let mut resp = next.run(req).await;
        if graphql || search {
            if let Some(ref gql) = graphql_ext {
                let resources = gql.take();
                if !resources.is_empty() {
                    event.resources = Some(resources);
                }
            }
            if let Some(ref cat) = catalog_ext
                && let Some(res) = cat.take()
            {
                event.resources = Some(vec![res]);
            }
            runtime.scorer.enqueue(keys, event, now_ms);
        }
        attach_observation(&mut resp, slot.as_ref(), observation);
        return resp;
    }

    if decision == ObservationDecision::Tarpit {
        if graphql || search {
            runtime.scorer.enqueue(keys, event, now_ms);
        }
        observation.action = ObservationAction::Tarpit;
        if runtime.sleepers.load(Ordering::Relaxed) < MAX_SLEEPERS {
            let delay_ms = runtime
                .fixed_tarpit_ms
                .unwrap_or_else(|| 3000 + rand::rng().random_range(0..=2000));
            runtime.sleepers.fetch_add(1, Ordering::Relaxed);
            let _guard = SleeperGuard {
                counter: &runtime.sleepers,
            };
            if let Some(ref hook) = runtime.tarpit_hook {
                hook(delay_ms);
            } else {
                tarpit_delay(delay_ms).await;
            }
        }
        let mut resp = Response::builder()
            .status(StatusCode::NO_CONTENT)
            .header(
                HeaderName::from_static("x-egdata-mitigation"),
                HeaderValue::from_static("tarpit"),
            )
            .body(Body::empty())
            .expect("valid 204 response");
        private_response(resp.headers_mut());
        resp.extensions_mut().insert(AntiAbuseCanaryResponse(true));
        attach_observation(&mut resp, slot.as_ref(), observation);
        return resp;
    }

    if decision == ObservationDecision::Challenge {
        if graphql || search {
            runtime.scorer.enqueue(keys, event, now_ms);
        }
        observation.action = ObservationAction::Challenge;
        let mut resp = challenge_json_response(
            StatusCode::OK,
            &json!({
                "error": {
                    "code": "SESSION_CHALLENGE_REQUIRED",
                    "challengeUrl": "/auth/challenge",
                }
            }),
            slot.as_ref(),
            observation,
        );
        if session.is_none() {
            let cleared =
                format!("{SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax");
            if let Ok(val) = HeaderValue::from_str(&cleared) {
                resp.headers_mut().append(header::SET_COOKIE, val);
            }
        }
        return resp;
    }

    let inject_canary = runtime.mode == AntiAbuseMode::Enforce
        && state.config.anti_abuse_canaries
        && session.is_some()
        && path == "/items"
        && req.method() == Method::GET;

    if inject_canary {
        req.extensions_mut().insert(AntiAbuseCanaryResponse(true));
    }

    let mut resp = next.run(req).await;

    if graphql || search {
        if let Some(ref gql) = graphql_ext {
            let resources = gql.take();
            if !resources.is_empty() {
                event.resources = Some(resources);
            }
        }
        if let Some(ref cat) = catalog_ext
            && let Some(res) = cat.take()
        {
            event.resources = Some(vec![res]);
        }
        runtime.scorer.enqueue(keys, event, now_ms);
    }

    if inject_canary && resp.status() == StatusCode::OK && content_type_is_json(resp.headers()) {
        let canary_id = sessions.canary(&fp.fingerprint_hash);
        let (mut parts, body) = resp.into_parts();
        if let Ok(collected) = http_body_util::BodyExt::collect(body).await {
            let bytes = collected.to_bytes();
            let new_bytes =
                inject_canary_into_body(&bytes, &canary_id).unwrap_or_else(|| bytes.to_vec());
            parts.headers.remove(header::CONTENT_LENGTH);
            private_response(&mut parts.headers);
            let mut updated = Response::from_parts(parts, Body::from(new_bytes));
            updated
                .extensions_mut()
                .insert(AntiAbuseCanaryResponse(true));
            attach_observation(&mut updated, slot.as_ref(), observation);
            return updated;
        }
        let mut empty = Response::from_parts(parts, Body::empty());
        attach_observation(&mut empty, slot.as_ref(), observation);
        return empty;
    }

    attach_observation(&mut resp, slot.as_ref(), observation);
    resp
}

struct ObservedStream {
    inner: BodyDataStream,
    observations: Arc<AbuseObservations>,
    record: AbuseObservation,
    status: u16,
    bytes: usize,
    finished: bool,
}

impl ObservedStream {
    fn finish(&mut self, complete: bool) {
        if !self.finished {
            self.finished = true;
            self.observations
                .record(&self.record, self.status, self.bytes, complete);
        }
    }
}

impl Drop for ObservedStream {
    fn drop(&mut self) {
        self.finish(false);
    }
}

impl Stream for ObservedStream {
    type Item = Result<Bytes, axum::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match Pin::new(&mut self.inner).poll_next(cx) {
            Poll::Ready(Some(Ok(chunk))) => {
                self.bytes += chunk.len();
                Poll::Ready(Some(Ok(chunk)))
            }
            Poll::Ready(Some(Err(err))) => {
                self.finish(false);
                Poll::Ready(Some(Err(err)))
            }
            Poll::Ready(None) => {
                self.finish(true);
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

/// Outer telemetry middleware registered outside compression, skipping `/v1` and `Off` mode.
pub async fn observe_response(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Response {
    if state.config.anti_abuse_mode == AntiAbuseMode::Off {
        return next.run(req).await;
    }
    let path = req.uri().path();
    if path == "/v1" || path.starts_with("/v1/") {
        return next.run(req).await;
    }

    let runtime = resolve_runtime(&state, req.extensions());
    let slot = ObservationSlot::default();
    let is_head = req.method() == Method::HEAD;
    req.extensions_mut().insert(slot.clone());

    let mut resp = next.run(req).await;
    let record = resp
        .extensions_mut()
        .remove::<AbuseObservation>()
        .or_else(|| slot.take());
    let Some(record) = record else {
        return resp;
    };

    let status = resp.status().as_u16();
    if is_head || resp.body().is_end_stream() {
        runtime.observations.record(&record, status, 0, true);
        return resp;
    }

    let (parts, body) = resp.into_parts();
    let wrapped = ObservedStream {
        inner: body.into_data_stream(),
        observations: runtime.observations.clone(),
        record,
        status,
        bytes: 0,
        finished: false,
    };
    Response::from_parts(parts, Body::from_stream(wrapped))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::middleware::{
        compression::{
            NodeCompressionPredicate, canonicalize_accept_encoding, remember_compression_headers,
            weaken_encoded_etag,
        },
        response_etag::response_etag,
    };
    use egdata_api_test_support::{StubPorts, test_app_state};
    use async_trait::async_trait;
    use axum::{
        Extension, Router,
        routing::{get, post},
    };
    use egdata_core::{
        abuse::verify_proof_of_work,
        ports::{AbuseRiskWindow, AbuseTrialStorePort},
    };
    use http_body_util::BodyExt;
    use std::sync::atomic::AtomicI64;
    use tower::ServiceExt;

    const TEST_SECRET: &str = "test-only-secret-with-at-least-32-bytes";
    const TEST_EDGE_SECRET: &str = "test-edge-secret";
    const BASE_TIME_MS: i64 = 1_800_000_000_000;
    static TICK_CLOCK: AtomicI64 = AtomicI64::new(BASE_TIME_MS);

    fn fixed_now() -> i64 {
        BASE_TIME_MS
    }

    fn fixed_now_dt() -> chrono::DateTime<Utc> {
        chrono::DateTime::from_timestamp_millis(BASE_TIME_MS).expect("valid timestamp")
    }

    fn tick_now() -> i64 {
        TICK_CLOCK.load(Ordering::SeqCst)
    }

    fn set_tick_clock(ms: i64) {
        TICK_CLOCK.store(ms, Ordering::SeqCst);
    }

    #[derive(Default)]
    struct MockAbusePorts {
        risk_events: Mutex<HashMap<String, Vec<AbuseEvent>>>,
        trapped: AtomicBool,
        fail_risk: AtomicBool,
        fail_summary: AtomicBool,
        fail_cohorts: AtomicBool,
        fail_trial: AtomicBool,
        summary_rows: Mutex<Vec<AbuseSummaryRow>>,
        cohort_rows: Mutex<Vec<PowCohortUpdate>>,
        cohort_day_data: Mutex<BTreeMap<String, String>>,
        trial_raw: Mutex<Option<String>>,
    }

    #[async_trait]
    impl AbuseRiskStorePort for MockAbusePorts {
        async fn append(
            &self,
            key: &str,
            event: &AbuseEvent,
        ) -> Result<AbuseRiskWindow, CoreError> {
            if self.fail_risk.load(Ordering::Relaxed) {
                return Err(CoreError::Internal("risk redis down".into()));
            }
            let mut map = self.risk_events.lock().unwrap();
            let events = map.entry(key.to_string()).or_default();
            events.push(event.clone());
            Ok(AbuseRiskWindow {
                events: events.clone(),
                trapped: self.trapped.load(Ordering::Relaxed),
            })
        }
    }

    #[async_trait]
    impl AbuseSummaryStorePort for MockAbusePorts {
        async fn write(&self, rows: &[AbuseSummaryRow]) -> Result<(), CoreError> {
            if self.fail_summary.load(Ordering::Relaxed) {
                return Err(CoreError::Internal("summary redis down".into()));
            }
            self.summary_rows.lock().unwrap().extend_from_slice(rows);
            Ok(())
        }
    }

    #[async_trait]
    impl PowCohortStorePort for MockAbusePorts {
        async fn write(&self, rows: &[PowCohortUpdate]) -> Result<(), CoreError> {
            if self.fail_cohorts.load(Ordering::Relaxed) {
                return Err(CoreError::Internal("cohort redis down".into()));
            }
            self.cohort_rows.lock().unwrap().extend_from_slice(rows);
            Ok(())
        }

        async fn read_day(&self, _day: i64) -> Result<BTreeMap<String, String>, CoreError> {
            Ok(self.cohort_day_data.lock().unwrap().clone())
        }
    }

    #[async_trait]
    impl AbuseTrialStorePort for MockAbusePorts {
        async fn get_trial_raw(&self) -> Result<Option<String>, CoreError> {
            if self.fail_trial.load(Ordering::Relaxed) {
                return Err(CoreError::Internal("trial redis down".into()));
            }
            Ok(self.trial_raw.lock().unwrap().clone())
        }
    }

    fn state_with_abuse_ports(config: ApiConfig, ports: Arc<MockAbusePorts>) -> AppState {
        let mut state = test_app_state(config);
        state.now = fixed_now_dt;
        state.abuse_risk = ports.clone();
        state.abuse_summary = ports.clone();
        state.pow_cohorts = ports.clone();
        state.abuse_trial = ports;
        state
    }

    fn trusted_headers() -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("user-agent", "Chrome/130.0".parse().unwrap());
        h.insert("accept", "application/json".parse().unwrap());
        h.insert("sec-fetch-site", "same-site".parse().unwrap());
        h.insert("sec-fetch-mode", "cors".parse().unwrap());
        h.insert("sec-ch-ua", "Chromium".parse().unwrap());
        h.insert("x-egdata-edge-secret", TEST_EDGE_SECRET.parse().unwrap());
        h.insert(
            "x-egdata-tls-cipher",
            "AEAD-AES128-GCM-SHA256".parse().unwrap(),
        );
        h.insert("x-egdata-tls-version", "TLSv1.3".parse().unwrap());
        h.insert("x-egdata-http-protocol", "HTTP/2".parse().unwrap());
        h.insert("x-egdata-asn", "1234".parse().unwrap());
        h.insert("cf-ja4", "t13d1516h2_test_test".parse().unwrap());
        h
    }

    fn solve_pow(challenge: &str, difficulty: u32) -> String {
        (0_u64..)
            .map(|n| n.to_string())
            .find(|nonce| verify_proof_of_work(challenge, nonce, difficulty))
            .expect("pow nonce exists")
    }

    fn cfg(mode: AntiAbuseMode, canaries: bool) -> ApiConfig {
        ApiConfig {
            anti_abuse_mode: mode,
            anti_abuse_secret: Some(TEST_SECRET.into()),
            anti_abuse_edge_secret: Some(TEST_EDGE_SECRET.into()),
            anti_abuse_trust_bot_headers: false,
            anti_abuse_canaries: canaries,
            ..Default::default()
        }
    }

    fn build_runtime(
        state: &AppState,
        fixed_tarpit_ms: Option<u64>,
        hook: Option<TarpitDelayHook>,
    ) -> Arc<AntiAbuseRuntime> {
        build_runtime_with_now(state, fixed_now, fixed_tarpit_ms, hook)
    }

    fn build_runtime_with_now(
        state: &AppState,
        now: fn() -> i64,
        fixed_tarpit_ms: Option<u64>,
        hook: Option<TarpitDelayHook>,
    ) -> Arc<AntiAbuseRuntime> {
        Arc::new(
            AntiAbuseRuntime::build(state, now, false, fixed_tarpit_ms, hook)
                .expect("valid runtime"),
        )
    }

    #[test]
    fn fingerprint_extraction_parity_and_mismatches() {
        let mut config = cfg(AntiAbuseMode::Enforce, false);
        let base_headers = trusted_headers();
        let base = extract_fingerprint(&base_headers, &config);
        assert!(base.trusted_transport);
        assert_eq!(base.risk_score, 0.0);
        assert!(base.mismatches.is_empty());

        // Ignores cf-ja4 / cf-ja3-hash unless anti_abuse_trust_bot_headers is true
        let mut spoof_bot = base_headers.clone();
        spoof_bot.insert("cf-ja4", "spoofed".parse().unwrap());
        spoof_bot.insert("cf-ja3-hash", "spoofed-ja3".parse().unwrap());
        assert_eq!(
            extract_fingerprint(&spoof_bot, &config).fingerprint_hash,
            base.fingerprint_hash
        );

        // Unstable headers, IP, UA, and cookies do not alter the hash
        let mut rotated = base_headers.clone();
        rotated.insert("cf-connecting-ip", "9.8.7.6".parse().unwrap());
        rotated.insert("user-agent", "python-requests".parse().unwrap());
        rotated.insert("cookie", "a=b".parse().unwrap());
        rotated.insert(SESSION_HEADER, "tok".parse().unwrap());
        rotated.insert("content-type", "application/json".parse().unwrap());
        assert_eq!(
            extract_fingerprint(&rotated, &config).fingerprint_hash,
            base.fingerprint_hash
        );

        // Opt-in bot headers affect hash when forwarded
        config.anti_abuse_trust_bot_headers = true;
        let bot_a = extract_fingerprint(&base_headers, &config);
        let mut bot_b_headers = base_headers.clone();
        bot_b_headers.insert("cf-ja4", "".parse().unwrap());
        bot_b_headers.insert("cf-ja3-hash", "ja3-value".parse().unwrap());
        let bot_b = extract_fingerprint(&bot_b_headers, &config);
        assert_ne!(bot_a.fingerprint_hash, bot_b.fingerprint_hash);

        // Header order & ASN sensitivity when forwarded
        let mut order1 = base_headers.clone();
        order1.insert(
            "x-egdata-header-order",
            "accept,user-agent".parse().unwrap(),
        );
        let mut order2 = base_headers.clone();
        order2.insert(
            "x-egdata-header-order",
            "user-agent,accept".parse().unwrap(),
        );
        assert_ne!(
            extract_fingerprint(&order1, &config).fingerprint_hash,
            extract_fingerprint(&order2, &config).fingerprint_hash
        );

        // Invalid edge secret fails timing-safe check -> untrusted transport
        let mut bad_edge = base_headers.clone();
        bad_edge.insert("x-egdata-edge-secret", "wrong".parse().unwrap());
        assert!(!extract_fingerprint(&bad_edge, &config).trusted_transport);

        // Non-integer / zero / invalid ASN branches
        let mut float_asn = base_headers.clone();
        float_asn.insert("x-egdata-asn", "12.5".parse().unwrap());
        assert_ne!(
            extract_fingerprint(&float_asn, &config).fingerprint_hash,
            bot_a.fingerprint_hash
        );
        let mut zero_asn = base_headers.clone();
        zero_asn.insert("x-egdata-asn", "0".parse().unwrap());
        let mut empty_asn = base_headers.clone();
        empty_asn.insert("x-egdata-asn", "".parse().unwrap());
        assert_eq!(
            extract_fingerprint(&zero_asn, &config).fingerprint_hash,
            extract_fingerprint(&empty_asn, &config).fingerprint_hash
        );

        // Chrome without client hints + legacy transport mismatches
        let mut legacy = HeaderMap::new();
        legacy.insert("user-agent", "Chrome/130".parse().unwrap());
        legacy.insert("x-egdata-edge-secret", TEST_EDGE_SECRET.parse().unwrap());
        legacy.insert("x-egdata-tls-cipher", "AES128-SHA".parse().unwrap());
        legacy.insert("x-egdata-tls-version", "TLSv1.2".parse().unwrap());
        legacy.insert("x-egdata-http-protocol", "HTTP/1.1".parse().unwrap());
        let legacy_fp = extract_fingerprint(&legacy, &config);
        assert_eq!(
            legacy_fp.mismatches,
            vec!["chrome-without-client-hints", "browser-legacy-transport"]
        );
        // Direct tarpit_delay smoke check + sync enqueue outside Tokio runtime
        let sync_scorer = Arc::new(AbuseScorerRuntime::new(
            Arc::new(MockAbusePorts::default()),
            fixed_now,
            10,
        ));
        sync_scorer.enqueue(
            vec!["fp:sync".into()],
            AbuseEvent {
                resource: Default::default(),
                at: fixed_now(),
                deep: false,
                support: true,
                resources: None,
                mismatch: 0.0,
                trap: None,
                method: None,
            },
            fixed_now(),
        );
        assert!(legacy_fp.risk_score > 0.0);
    }

    #[test]
    fn path_classification_and_route_normalization() {
        assert_eq!(normalized_abuse_path("/%73ales/"), "/sales");
        assert_eq!(normalized_abuse_path("/"), "/");
        assert_eq!(normalized_abuse_path("/%ZZ/"), "/%ZZ/");

        assert!(is_protected_path("/offers", None));
        assert!(is_protected_path("/%73ales", None));
        assert!(is_protected_path("/active-sales", None));
        assert!(is_protected_path("/catalog/hydrate", None));
        assert!(is_protected_path("/graphql", None));
        assert!(is_protected_path("/search/v2/search", None));
        assert!(is_protected_path("/unknown", Some("page=1")));
        assert!(is_protected_path("/unknown", Some("limit=10")));
        assert!(!is_protected_path("/countries", None));
        assert!(!is_protected_path("/countries", Some("locale=en-US")));

        assert!(is_support_path("/search"));
        assert!(is_support_path("/search/tags"));
        assert!(is_support_path("/countries"));
        assert!(is_support_path("/offers/genres"));
        assert!(is_support_path("/collections/top-sellers"));
        assert!(is_support_path("/free-games/stats"));
        assert!(!is_support_path("/offers/123"));

        assert_eq!(observation_route("/auth/challenge"), "/auth/challenge");
        assert_eq!(observation_route("/search/v2/search"), "/search/v2/search");
        assert_eq!(observation_route("/graphql"), "/graphql");
        assert_eq!(observation_route("/offers/abc"), "/offers/{id}");
        assert_eq!(observation_route("/offers/abc/price"), "/offers/{id}/*");
        assert_eq!(
            observation_route("/sandboxes/sb1/offers"),
            "/sandboxes/{id}/offers"
        );
        assert_eq!(observation_route("/items/123"), "/items");
        assert_eq!(observation_route("/unknown/path"), "/other");
    }

    #[tokio::test]
    async fn off_mode_and_challenge_disabled() {
        let ports = Arc::new(MockAbusePorts::default());
        let state = state_with_abuse_ports(cfg(AntiAbuseMode::Off, false), ports);
        let runtime = AntiAbuseRuntime::new(&state);
        assert!(runtime.sessions.is_none());

        let app = Router::new()
            .route("/items", get(|| async { Json(json!({"elements": []})) }))
            .route("/auth/challenge", post(challenge))
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                middleware,
            ))
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                observe_response,
            ))
            .with_state(state);

        let item_resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/items")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(item_resp.status(), StatusCode::OK);

        let disabled = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/auth/challenge")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(disabled.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(disabled.headers()[header::CACHE_CONTROL], "no-store");
        let body: Value =
            serde_json::from_slice(&disabled.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(body["error"]["code"], "ANTI_ABUSE_DISABLED");
    }

    #[tokio::test]
    async fn secret_validation_and_runtime_lifecycle() {
        let ports = Arc::new(MockAbusePorts::default());
        let mut bad_cfg = cfg(AntiAbuseMode::Observe, false);
        bad_cfg.anti_abuse_secret = Some("short".into());
        let bad_state = state_with_abuse_ports(bad_cfg, ports.clone());
        assert!(AntiAbuseRuntime::try_new(&bad_state).is_err());

        let obs_state = state_with_abuse_ports(cfg(AntiAbuseMode::Observe, false), ports);
        let rt = AntiAbuseRuntime::new(&obs_state);
        rt.record_metrics_delta();
        rt.close();
        tokio::task::yield_now().await;
        rt.shutdown().await;
    }

    #[tokio::test]
    async fn pow_challenge_handshake_observations_and_cohorts() {
        let ports = Arc::new(MockAbusePorts::default());
        let state = state_with_abuse_ports(cfg(AntiAbuseMode::Enforce, false), ports.clone());
        let runtime = build_runtime(&state, None, None);

        let app = Router::new()
            .route("/items/{id}", get(|| async { Json(json!({"ok": true})) }))
            .route("/auth/challenge", post(challenge))
            .route("/v1/health", get(|| async { "v1-ok" }))
            .layer(axum::middleware::from_fn(response_etag))
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                middleware,
            ))
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                observe_response,
            ))
            .layer(Extension(runtime.clone()))
            .with_state(state.clone());

        let send = |method: Method, uri: &str, body: Body, extra: Vec<(&str, &str)>| {
            let mut b = Request::builder().method(method).uri(uri);
            for (k, v) in trusted_headers() {
                if let Some(name) = k {
                    b = b.header(name, v);
                }
            }
            for (k, v) in extra {
                b = b.header(k, v);
            }
            app.clone().oneshot(b.body(body).unwrap())
        };

        // 1. Issue puzzle
        let r1 = send(Method::POST, "/auth/challenge", Body::empty(), vec![])
            .await
            .unwrap();
        assert_eq!(r1.status(), StatusCode::OK);
        assert_eq!(r1.headers()[header::CACHE_CONTROL], "private, no-store");
        assert!(r1.headers().get(header::ETAG).is_none());
        let puzzle: Value =
            serde_json::from_slice(&r1.into_body().collect().await.unwrap().to_bytes()).unwrap();
        let ch = puzzle["challenge"].as_str().unwrap().to_string();
        let diff = puzzle["difficulty"].as_u64().unwrap() as u32;
        assert_eq!(diff, 16);

        // 2. Wrong nonce replaces puzzle
        let r_bad = send(
            Method::POST,
            "/auth/challenge",
            Body::from(json!({"challenge": ch, "nonce": "!"}).to_string()),
            vec![("content-type", "application/json")],
        )
        .await
        .unwrap();
        assert_eq!(r_bad.status(), StatusCode::OK);
        let replaced: Value =
            serde_json::from_slice(&r_bad.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert!(replaced["challenge"].is_string());

        // 3. Invalid JSON, non-object, bad types, oversized body -> 400 INVALID_CHALLENGE
        for bad_body in [
            Body::from("{"),
            Body::from("[]"),
            Body::from(json!({"challenge": 42, "nonce": "0"}).to_string()),
            Body::from("x".repeat(5000)),
        ] {
            let r = send(Method::POST, "/auth/challenge", bad_body, vec![])
                .await
                .unwrap();
            assert_eq!(r.status(), StatusCode::BAD_REQUEST);
            let err: Value =
                serde_json::from_slice(&r.into_body().collect().await.unwrap().to_bytes()).unwrap();
            assert_eq!(err["error"]["code"], "INVALID_CHALLENGE");
        }

        // 4. Solve and redeem -> sets Secure HttpOnly SameSite=Lax cookie
        let nonce = solve_pow(&ch, diff);
        let r_redeem = send(
            Method::POST,
            "/auth/challenge",
            Body::from(json!({"challenge": ch, "nonce": nonce}).to_string()),
            vec![("content-type", "application/json")],
        )
        .await
        .unwrap();
        assert_eq!(r_redeem.status(), StatusCode::OK);
        let set_cookie = r_redeem.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .to_string();
        assert!(set_cookie.contains(SESSION_COOKIE));
        assert!(set_cookie.contains("HttpOnly"));
        assert!(set_cookie.contains("Secure"));
        let session_json: Value =
            serde_json::from_slice(&r_redeem.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        let token = session_json["token"].as_str().unwrap().to_string();

        // 5. Pass session via Cookie header on protected route + skip /v1
        let cookie_hdr = format!("{SESSION_COOKIE}={token}");
        let r_item = send(
            Method::GET,
            "/items/game-1",
            Body::empty(),
            vec![("cookie", &cookie_hdr)],
        )
        .await
        .unwrap();
        assert_eq!(r_item.status(), StatusCode::OK);
        assert!(r_item.headers().get(header::ETAG).is_some());
        let _ = r_item.into_body().collect().await.unwrap();

        let r_v1 = send(Method::GET, "/v1/health", Body::empty(), vec![])
            .await
            .unwrap();
        assert_eq!(r_v1.status(), StatusCode::OK);

        // Flush observations & cohorts
        runtime.observations.flush().await;
        let rows = ports.summary_rows.lock().unwrap().clone();
        let mut totals = BTreeMap::new();
        for row in &rows {
            for (k, v) in &row.values {
                let metric = k.rsplit('|').next().unwrap_or(k).to_string();
                *totals.entry(metric).or_insert(0) += *v;
            }
        }
        let counters = pow_counters(&totals);
        assert_eq!(counters["challengeRequested"], 1);
        assert_eq!(counters["puzzlesIssued"], 2);
        assert_eq!(counters["proofsSubmitted"], 2);
        assert_eq!(counters["proofsAccepted"], 1);
        assert_eq!(counters["proofsRejected"], 1);
        assert_eq!(counters["puzzlesReplaced"], 1);
        assert_eq!(counters["invalidHandshakeRequests"], 4);
        assert_eq!(counters["passedWithSession"], 1);
        assert!(!ports.cohort_rows.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn enforcement_thresholds_tarpit_challenge_canary_and_trials() {
        let ports = Arc::new(MockAbusePorts::default());
        let state = state_with_abuse_ports(cfg(AntiAbuseMode::Enforce, true), ports.clone());
        let observed_delay = Arc::new(AtomicU64::new(0));
        let hook_delay = observed_delay.clone();
        let runtime = build_runtime(
            &state,
            Some(3210),
            Some(Arc::new(move |ms| {
                hook_delay.store(ms, Ordering::SeqCst);
            })),
        );

        let app = Router::new()
            .route(
                "/items",
                get(|| async { Json(json!({"elements": [{"id": "real"}], "total": 1})) }),
            )
            .route("/items/{id}", get(|| async { Json(json!({"ok": true})) }))
            .route("/countries", get(|| async { Json(json!(["US"])) }))
            .route(
                "/graphql",
                post(|Extension(gql): Extension<AntiAbuseGraphql>| async move {
                    gql.record(AbuseResource {
                        route: "/graphql/Query.offer".into(),
                        page: Some(1),
                        ..Default::default()
                    });
                    Json(json!({"data": {}}))
                }),
            )
            .route(
                "/search/v2/search",
                get(|Extension(cat): Extension<AntiAbuseCatalog>| async move {
                    cat.record(AbuseResource {
                        route: "/search/v2/search:abc".into(),
                        page: Some(1),
                        search: Some(true),
                        ..Default::default()
                    });
                    Json(json!({"elements": []}))
                }),
            )
            .route("/unlisted", get(|| async { "ok" }))
            .layer(axum::middleware::from_fn(response_etag))
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                middleware,
            ))
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                observe_response,
            ))
            .layer(Extension(runtime.clone()))
            .with_state(state.clone());

        let send = |method: Method, uri: &str, extra: Vec<(&str, &str)>| {
            let mut hdrs = trusted_headers();
            for (k, v) in extra {
                hdrs.insert(
                    HeaderName::from_bytes(k.as_bytes()).unwrap(),
                    HeaderValue::from_str(v).unwrap(),
                );
            }
            let mut req = Request::builder()
                .method(method)
                .uri(uri)
                .body(Body::empty())
                .unwrap();
            *req.headers_mut() = hdrs;
            app.clone().oneshot(req)
        };

        // Issue & solve a valid session
        let fp = extract_fingerprint(&trusted_headers(), &state.config);
        let sessions = runtime.sessions.as_ref().unwrap();
        let ch = sessions.challenge_at(&fp.fingerprint_hash, 0.0, None, fixed_now());
        let nonce = solve_pow(&ch.challenge, ch.difficulty);
        let redeemed = sessions
            .redeem_at(
                &ch.challenge,
                &nonce,
                &fp.fingerprint_hash,
                0.0,
                fixed_now(),
            )
            .unwrap();

        // GraphQL & search telemetry recording in clean Enforce mode (before trap)
        let r_gql_clean = send(Method::POST, "/graphql", vec![("x-egdata-asn", "8888")])
            .await
            .unwrap();
        assert_eq!(r_gql_clean.status(), StatusCode::OK);

        // Canary helper + middleware injection on GET /items
        let mut h = trusted_headers();
        h.insert(SESSION_HEADER, redeemed.token.parse().unwrap());
        let helper_canary = canary_item_for_request(&state, &h).unwrap();
        assert_eq!(helper_canary["synthetic"], true);
        assert_eq!(helper_canary["namespace"], "egdata-canary");

        let r_canary = send(
            Method::GET,
            "/items",
            vec![(SESSION_HEADER, &redeemed.token)],
        )
        .await
        .unwrap();
        assert_eq!(r_canary.status(), StatusCode::OK);
        assert_eq!(
            r_canary.headers()[header::CACHE_CONTROL],
            "private, no-store"
        );
        assert_eq!(r_canary.headers()["cdn-cache-control"], "no-store");
        assert_eq!(
            r_canary.headers()["cloudflare-cdn-cache-control"],
            "no-store"
        );
        assert!(r_canary.headers().get(header::ETAG).is_none());
        let canary_body: Value =
            serde_json::from_slice(&r_canary.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        let canary_id = canary_body["elements"][1]["id"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(canary_id.starts_with("egcanary_"));

        // Hitting the real canary traps and immediately tarpits (204 + X-Egdata-Mitigation: tarpit)
        let r_trap = send(
            Method::GET,
            &format!("/items/{canary_id}"),
            vec![(SESSION_HEADER, &redeemed.token)],
        )
        .await
        .unwrap();
        assert_eq!(r_trap.status(), StatusCode::NO_CONTENT);
        assert_eq!(r_trap.headers()["x-egdata-mitigation"], "tarpit");
        assert_eq!(r_trap.headers()[header::CACHE_CONTROL], "private, no-store");
        assert!(r_trap.headers().get(header::ETAG).is_none());
        assert_eq!(observed_delay.load(Ordering::SeqCst), 3210);

        // GraphQL & search telemetry recording and tarpit
        let r_gql = send(Method::POST, "/graphql", vec![]).await.unwrap();
        assert_eq!(r_gql.status(), StatusCode::NO_CONTENT);

        // New fingerprint with suspicious risk (0.6) -> 200 SESSION_CHALLENGE_REQUIRED & clears cookie if no session
        let mut h2 = trusted_headers();
        h2.insert("x-egdata-asn", "7777".parse().unwrap());
        let fp2 = extract_fingerprint(&h2, &state.config);
        let key2 = format!("fp:{}", fp2.fingerprint_hash);
        // Seed page sweep (10 pages -> score 0.65)
        for page in 1..=10 {
            let offset = if page % 2 == 0 { 0 } else { 100 };
            let ev = AbuseEvent {
                resource: AbuseResource {
                    route: "/offers".into(),
                    page: Some(page),
                    ..Default::default()
                },
                at: fixed_now() + (page as i64) * 500 + offset,
                deep: true,
                support: false,
                resources: None,
                mismatch: 0.0,
                trap: None,
                method: Some("GET".into()),
            };
            runtime.scorer.scorer.lock().unwrap().record_local(
                std::slice::from_ref(&key2),
                &ev,
                fixed_now(),
            );
        }
        let r_chal = send(Method::GET, "/sales", vec![("x-egdata-asn", "7777")])
            .await
            .unwrap();
        assert_eq!(r_chal.status(), StatusCode::OK);
        assert!(r_chal.headers().get(header::ETAG).is_none());
        assert!(
            r_chal.headers()[header::SET_COOKIE]
                .to_str()
                .unwrap()
                .contains("Max-Age=0")
        );
        let chal_body: Value =
            serde_json::from_slice(&r_chal.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(chal_body["error"]["code"], "SESSION_CHALLENGE_REQUIRED");

        // OPTIONS, HEAD, support, unlisted, and search
        let r_opt = send(Method::OPTIONS, "/items", vec![]).await.unwrap();
        assert_eq!(r_opt.status(), StatusCode::METHOD_NOT_ALLOWED);
        let r_unlisted = send(Method::GET, "/unlisted", vec![]).await.unwrap();
        assert_eq!(r_unlisted.status(), StatusCode::OK);
        let r_head = send(Method::HEAD, "/countries", vec![]).await.unwrap();
        assert_eq!(r_head.status(), StatusCode::OK);
        let r_search = send(
            Method::GET,
            "/search/v2/search",
            vec![("x-egdata-asn", "9999")],
        )
        .await
        .unwrap();
        assert_eq!(r_search.status(), StatusCode::OK);
        runtime.scorer.drain().await;

        // Observe mode + scoped trial override + Observe GraphQL/search/challenge
        let trial_ports = Arc::new(MockAbusePorts::default());
        let trial_json = json!({
            "id": "t1",
            "createdAt": fixed_now() - 1000,
            "expiresAt": fixed_now() + 60_000,
            "fingerprints": [fp.fingerprint_hash],
            "route": "offer-details"
        })
        .to_string();
        *trial_ports.trial_raw.lock().unwrap() = Some(trial_json);
        let obs_state =
            state_with_abuse_ports(cfg(AntiAbuseMode::Observe, false), trial_ports.clone());
        let obs_rt = build_runtime(&obs_state, Some(0), None);
        obs_rt.trial.poll().await;
        let offer_id = "0123456789abcdef0123456789abcdef";
        assert!(obs_rt.trial.matches(
            &fp.fingerprint_hash,
            &format!("/offers/{offer_id}"),
            "GET",
            fixed_now()
        ));

        // Seed high risk -> trial enforces tarpit even in observe mode, while non-trial route stays passive
        let mut trap_ev = AbuseEvent {
            resource: AbuseResource {
                route: "/offers".into(),
                ..Default::default()
            },
            at: fixed_now(),
            deep: true,
            support: false,
            resources: None,
            mismatch: 0.0,
            trap: Some(true),
            method: Some("GET".into()),
        };
        obs_rt
            .scorer
            .trap(&[format!("fp:{}", fp.fingerprint_hash)], fixed_now());
        trap_ev.trap = None;
        let obs_app = Router::new()
            .route("/offers/{id}", get(|| async { Json(json!({"ok": true})) }))
            .route("/items", get(|| async { Json(json!({"ok": true})) }))
            .route(
                "/graphql",
                post(|Extension(gql): Extension<AntiAbuseGraphql>| async move {
                    for i in 0..35 {
                        gql.record(AbuseResource {
                            route: format!("/graphql/Query.f{i}"),
                            ..Default::default()
                        });
                    }
                    Json(json!({"data": {}}))
                }),
            )
            .route(
                "/search/v2/search",
                get(|Extension(cat): Extension<AntiAbuseCatalog>| async move {
                    cat.record(AbuseResource {
                        route: "/search/v2/search:obs".into(),
                        page: Some(1),
                        search: Some(true),
                        ..Default::default()
                    });
                    Json(json!({"elements": []}))
                }),
            )
            .route("/auth/challenge", post(challenge))
            .layer(axum::middleware::from_fn_with_state(
                obs_state.clone(),
                middleware,
            ))
            .layer(axum::middleware::from_fn_with_state(
                obs_state.clone(),
                observe_response,
            ))
            .layer(Extension(obs_rt.clone()))
            .with_state(obs_state);

        let mut req_trial = Request::builder()
            .uri(format!("/offers/{offer_id}"))
            .body(Body::empty())
            .unwrap();
        *req_trial.headers_mut() = trusted_headers();
        let resp_trial = obs_app.clone().oneshot(req_trial).await.unwrap();
        assert_eq!(resp_trial.status(), StatusCode::NO_CONTENT);

        let mut req_passive = Request::builder()
            .uri("/items")
            .body(Body::empty())
            .unwrap();
        *req_passive.headers_mut() = trusted_headers();
        let resp_passive = obs_app.clone().oneshot(req_passive).await.unwrap();
        assert_eq!(resp_passive.status(), StatusCode::OK);
        let _ = resp_passive.into_body().collect().await.unwrap();

        let mut req_obs_gql = Request::builder()
            .method(Method::POST)
            .uri("/graphql")
            .body(Body::empty())
            .unwrap();
        *req_obs_gql.headers_mut() = trusted_headers();
        assert_eq!(
            obs_app.clone().oneshot(req_obs_gql).await.unwrap().status(),
            StatusCode::OK
        );

        let mut req_obs_search = Request::builder()
            .uri("/search/v2/search")
            .body(Body::empty())
            .unwrap();
        *req_obs_search.headers_mut() = trusted_headers();
        assert_eq!(
            obs_app
                .clone()
                .oneshot(req_obs_search)
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );

        let mut req_obs_chal = Request::builder()
            .method(Method::POST)
            .uri("/auth/challenge")
            .body(Body::empty())
            .unwrap();
        *req_obs_chal.headers_mut() = trusted_headers();
        assert_eq!(
            obs_app.oneshot(req_obs_chal).await.unwrap().status(),
            StatusCode::OK
        );

        obs_rt.observations.flush().await;
        assert!(!trial_ports.summary_rows.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn buffering_limits_error_resilience_compression_and_cohort_report() {
        let ports = Arc::new(MockAbusePorts::default());
        ports.fail_risk.store(true, Ordering::Relaxed);
        ports.fail_summary.store(true, Ordering::Relaxed);
        ports.fail_cohorts.store(true, Ordering::Relaxed);
        ports.fail_trial.store(true, Ordering::Relaxed);

        let state = state_with_abuse_ports(cfg(AntiAbuseMode::Enforce, false), ports.clone());
        let rt = build_runtime(&state, Some(1), None);

        // Trial error clears matcher
        rt.trial.poll().await;
        assert!(
            !rt.trial
                .matches("fp", "/search/v2/search", "GET", fixed_now())
        );

        // Observation limits: >4 distinct minutes & >4096 fields increment dropped
        for m in 0..6 {
            rt.observations
                .increment("metric", 1, Some(fixed_now() + m * 60_000));
        }
        for i in 0..4100 {
            rt.observations
                .increment(&format!("f{i}"), 1, Some(fixed_now()));
        }
        // Stale minute (> 1440 mins old) ignored
        rt.observations
            .increment("stale", 1, Some(fixed_now() - 1500 * 60_000));

        // Cohort untracked and >2048 cap
        rt.cohorts.record(&AbuseObservation {
            at: fixed_now(),
            route: "/items".into(),
            method: "GET".into(),
            scope: ObservationScope::Enforce,
            action: ObservationAction::Challenge,
            risk: 0.6,
            reasons: vec!["page-sweep".into()],
            tracked: false,
            decision: Some(ObservationDecision::Challenge),
            session_valid: Some(false),
            cohort_fingerprint: None,
            handshake_outcome: None,
        });
        for i in 0..2050 {
            rt.cohorts.record(&AbuseObservation {
                at: fixed_now(),
                route: "/items".into(),
                method: "GET".into(),
                scope: ObservationScope::Enforce,
                action: ObservationAction::Challenge,
                risk: 0.6,
                reasons: vec![],
                tracked: true,
                decision: Some(ObservationDecision::Challenge),
                session_valid: Some(false),
                cohort_fingerprint: Some(format!("{i:064x}")),
                handshake_outcome: None,
            });
        }

        // Scorer queue cap + Redis failure cooldown
        let ev = AbuseEvent {
            resource: AbuseResource {
                route: "/items".into(),
                ..Default::default()
            },
            at: fixed_now(),
            deep: true,
            support: false,
            resources: None,
            mismatch: 0.0,
            trap: None,
            method: Some("GET".into()),
        };
        for _ in 0..2050 {
            rt.scorer
                .enqueue(vec!["fp:test".into()], ev.clone(), fixed_now());
        }
        rt.scorer.drain().await;
        rt.observations.flush().await;
        rt.record_metrics_delta();

        assert!(rt.observations.stats().0 > 0);
        assert!(rt.observations.stats().1 > 0);
        assert!(rt.cohorts.stats().0 > 0);
        assert_eq!(rt.cohorts.stats().1, 1);
        assert!(rt.cohorts.stats().2 > 0);
        assert!(rt.scorer.stats().0 > 0);
        assert!(rt.scorer.stats().1 > 0);

        // Cohort report aggregation covering solved, pending, noPuzzleRequested, puzzleRequestedUnsolved
        let now = fixed_now();
        let raw_cohorts = BTreeMap::from([
            ("__firstObservedAt".into(), (now - 500_000).to_string()),
            ("__lastObservedAt".into(), now.to_string()),
            ("__capacityReached".into(), "1".into()),
            ("bad".into(), "not-json".into()),
            (
                "zero".into(),
                json!({"firstChallenge":0,"lastChallenge":0,"lastPuzzle":0,"lastSolve":0})
                    .to_string(),
            ),
            (
                "solved".into(),
                json!({"firstChallenge":now - 400_000,"lastChallenge":now - 400_000,"lastPuzzle":now - 390_000,"lastSolve":now - 380_000}).to_string(),
            ),
            (
                "pending".into(),
                json!({"firstChallenge":now - 10_000,"lastChallenge":now - 10_000,"lastPuzzle":0,"lastSolve":0}).to_string(),
            ),
            (
                "unsolved_no_puzzle".into(),
                json!({"firstChallenge":now - 400_000,"lastChallenge":now - 400_000,"lastPuzzle":0,"lastSolve":0}).to_string(),
            ),
            (
                "unsolved_with_puzzle".into(),
                json!({"firstChallenge":now - 400_000,"lastChallenge":now - 400_000,"lastPuzzle":now - 350_000,"lastSolve":0}).to_string(),
            ),
        ]);
        let report = cohort_report(&raw_cohorts, now);
        assert_eq!(report.challenged, 4);
        assert_eq!(report.solved, 1);
        assert_eq!(report.pending, 1);
        assert_eq!(report.no_solution_observed, 2);
        assert_eq!(report.no_puzzle_requested, 1);
        assert_eq!(report.puzzle_requested_unsolved, 1);
        assert!(report.capacity_reached);

        // Compression compatibility: observe_response outside CompressionLayer counts encoded bytes!
        ports.fail_summary.store(false, Ordering::Relaxed);
        ports.fail_risk.store(false, Ordering::Relaxed);
        let big_payload = "x".repeat(2048);
        let comp_state = state_with_abuse_ports(cfg(AntiAbuseMode::Observe, false), ports.clone());
        let comp_rt = build_runtime(&comp_state, None, None);
        let comp_app = Router::new()
            .route(
                "/items",
                get(move || {
                    let s = big_payload.clone();
                    async move { Json(json!({"data": s})) }
                }),
            )
            .layer(axum::middleware::from_fn_with_state(
                comp_state.clone(),
                middleware,
            ))
            .layer(axum::middleware::from_fn(remember_compression_headers))
            .layer(
                tower_http::compression::CompressionLayer::new()
                    .gzip(true)
                    .no_br()
                    .no_zstd()
                    .compress_when(NodeCompressionPredicate),
            )
            .layer(axum::middleware::from_fn(canonicalize_accept_encoding))
            .layer(axum::middleware::from_fn(weaken_encoded_etag))
            .layer(axum::middleware::from_fn_with_state(
                comp_state.clone(),
                observe_response,
            ))
            .layer(Extension(comp_rt.clone()))
            .with_state(comp_state);

        let comp_resp = comp_app
            .oneshot(
                Request::builder()
                    .uri("/items")
                    .header("accept-encoding", "gzip")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(comp_resp.status(), StatusCode::OK);
        assert_eq!(comp_resp.headers()["content-encoding"], "gzip");
        let compressed_bytes = comp_resp.into_body().collect().await.unwrap().to_bytes();
        assert!(compressed_bytes.len() < 512);
        comp_rt.observations.flush().await;

        let recorded_bytes: i64 = {
            let flushed = ports.summary_rows.lock().unwrap();
            flushed
                .iter()
                .flat_map(|r| r.values.iter())
                .filter(|(k, _)| k.ends_with("|bodyBytes"))
                .map(|(_, v)| *v)
                .sum()
        };
        assert_eq!(recorded_bytes, compressed_bytes.len() as i64);

        // Direct tarpit_delay smoke check
        tarpit_delay(0).await;
        tarpit_delay(1).await;
        let _unused = StubPorts;
    }

    #[tokio::test]
    async fn additional_branches_and_edge_cases_for_full_coverage() {
        set_tick_clock(BASE_TIME_MS);
        let ports = Arc::new(MockAbusePorts::default());
        let state = state_with_abuse_ports(cfg(AntiAbuseMode::Enforce, true), ports.clone());

        // canary_item_for_request negative cases
        assert!(canary_item_for_request(&state, &trusted_headers()).is_none());
        let off_state = state_with_abuse_ports(cfg(AntiAbuseMode::Off, true), ports.clone());
        assert!(canary_item_for_request(&off_state, &trusted_headers()).is_none());
        let mut no_sec_cfg = cfg(AntiAbuseMode::Enforce, true);
        no_sec_cfg.anti_abuse_secret = Some("short".into());
        let no_sec_state = state_with_abuse_ports(no_sec_cfg, ports.clone());
        assert!(canary_item_for_request(&no_sec_state, &trusted_headers()).is_none());
        let mut missing_sec_cfg = cfg(AntiAbuseMode::Enforce, true);
        missing_sec_cfg.anti_abuse_secret = None;
        let missing_sec_state = state_with_abuse_ports(missing_sec_cfg, ports.clone());
        assert!(canary_item_for_request(&missing_sec_state, &trusted_headers()).is_none());

        // inject_canary_into_body edge cases (already synthetic, non-json, non-object)
        let already = json!({"elements": [{"synthetic": true}]}).to_string();
        assert_eq!(
            serde_json::from_slice::<Value>(
                &inject_canary_into_body(already.as_bytes(), "egcanary_x").unwrap()
            )
            .unwrap()["elements"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(inject_canary_into_body(b"not-json", "egcanary_x").is_none());
        assert!(inject_canary_into_body(b"[]", "egcanary_x").is_none());

        // Direct AbuseObservations & PowCohorts branch coverage
        let obs_only = AbuseObservations::new(ports.clone(), None, tick_now);
        obs_only.flush().await; // empty without cohorts -> early return
        obs_only.record(
            &AbuseObservation {
                at: tick_now(),
                route: "/items".into(),
                method: "PUT".into(),
                scope: ObservationScope::Observe,
                action: ObservationAction::Serve,
                risk: 0.9,
                reasons: vec!["canary".into(), "unknown-reason".into()],
                tracked: false,
                decision: Some(ObservationDecision::Tarpit),
                session_valid: Some(false),
                cohort_fingerprint: None,
                handshake_outcome: Some(HandshakeOutcome::Disabled),
            },
            200,
            10,
            true,
        );
        obs_only.record(
            &AbuseObservation {
                at: tick_now(),
                route: "/items".into(),
                method: "DELETE".into(),
                scope: ObservationScope::Observe,
                action: ObservationAction::Serve,
                risk: 0.6,
                reasons: vec![],
                tracked: true,
                decision: Some(ObservationDecision::Challenge),
                session_valid: Some(false),
                cohort_fingerprint: None,
                handshake_outcome: None,
            },
            200,
            10,
            false,
        );
        obs_only.record(
            &AbuseObservation {
                at: tick_now(),
                route: "/items".into(),
                method: "GET".into(),
                scope: ObservationScope::Observe,
                action: ObservationAction::Serve,
                risk: 0.0,
                reasons: vec![],
                tracked: true,
                decision: None,
                session_valid: None,
                cohort_fingerprint: None,
                handshake_outcome: None,
            },
            200,
            10,
            true,
        );
        obs_only.flush().await;

        // PowCohorts out-of-order challenge min timestamp and non-enforce/non-event skips
        let cohorts = PowCohorts::new(ports.clone());
        let fp_hex = "a".repeat(64);
        cohorts.record(&AbuseObservation {
            at: tick_now(),
            route: "/items".into(),
            method: "GET".into(),
            scope: ObservationScope::Observe,
            action: ObservationAction::Challenge,
            risk: 0.6,
            reasons: vec![],
            tracked: true,
            decision: None,
            session_valid: None,
            cohort_fingerprint: Some(fp_hex.clone()),
            handshake_outcome: None,
        });
        cohorts.record(&AbuseObservation {
            at: tick_now(),
            route: "/items".into(),
            method: "GET".into(),
            scope: ObservationScope::Enforce,
            action: ObservationAction::Serve,
            risk: 0.1,
            reasons: vec![],
            tracked: true,
            decision: None,
            session_valid: None,
            cohort_fingerprint: Some(fp_hex.clone()),
            handshake_outcome: None,
        });
        cohorts.record(&AbuseObservation {
            at: tick_now() + 2000,
            route: "/items".into(),
            method: "GET".into(),
            scope: ObservationScope::Enforce,
            action: ObservationAction::Challenge,
            risk: 0.6,
            reasons: vec![],
            tracked: true,
            decision: None,
            session_valid: None,
            cohort_fingerprint: Some(fp_hex.clone()),
            handshake_outcome: None,
        });
        cohorts.record(&AbuseObservation {
            at: tick_now() + 1000,
            route: "/items".into(),
            method: "GET".into(),
            scope: ObservationScope::Enforce,
            action: ObservationAction::Challenge,
            risk: 0.6,
            reasons: vec![],
            tracked: true,
            decision: None,
            session_valid: None,
            cohort_fingerprint: Some(fp_hex.clone()),
            handshake_outcome: None,
        });
        cohorts.record(&AbuseObservation {
            at: tick_now() + 3000,
            route: "/auth/challenge".into(),
            method: "POST".into(),
            scope: ObservationScope::Enforce,
            action: ObservationAction::Handshake,
            risk: 0.6,
            reasons: vec![],
            tracked: true,
            decision: None,
            session_valid: None,
            cohort_fingerprint: Some(fp_hex),
            handshake_outcome: Some(HandshakeOutcome::Accepted),
        });
        cohorts.flush().await;
        cohorts.flush().await; // empty flush

        // Scorer trap preservation under queue pressure & closed state
        let scorer = Arc::new(AbuseScorerRuntime::new(ports.clone(), tick_now, 10));
        scorer.enqueue(
            vec![],
            AbuseEvent {
                resource: Default::default(),
                at: tick_now(),
                deep: false,
                support: true,
                resources: None,
                mismatch: 0.0,
                trap: None,
                method: None,
            },
            tick_now(),
        );
        let base_ev = AbuseEvent {
            resource: AbuseResource {
                route: "/items".into(),
                ..Default::default()
            },
            at: tick_now(),
            deep: true,
            support: false,
            resources: None,
            mismatch: 0.0,
            trap: None,
            method: Some("GET".into()),
        };
        for _ in 0..SCORER_QUEUE_CAPACITY {
            scorer.enqueue(vec!["fp:q".into()], base_ev.clone(), tick_now());
        }
        let mut trap_ev = base_ev.clone();
        trap_ev.trap = Some(true);
        scorer.enqueue(vec!["fp:trap".into()], trap_ev, tick_now());
        assert_eq!(scorer.risk(&["fp:trap".into()], tick_now()), 1.0);
        scorer.close();
        scorer.enqueue(vec!["fp:after_close".into()], base_ev, tick_now());

        // Incomplete response body (drop before EOF) + AntiAbuseRequestContext + fallback registry (no Extension layer)
        let fp = extract_fingerprint(&trusted_headers(), &state.config);
        let live_sessions = PowSessionService::new(TEST_SECRET).unwrap();
        let live_now = utc_now_ms();
        let live_ch = live_sessions.challenge_at(&fp.fingerprint_hash, 0.0, None, live_now);
        let live_nonce = solve_pow(&live_ch.challenge, live_ch.difficulty);
        let live_redeemed = live_sessions
            .redeem_at(
                &live_ch.challenge,
                &live_nonce,
                &fp.fingerprint_hash,
                0.0,
                live_now,
            )
            .unwrap();

        let stream_app = Router::new()
            .route(
                "/items",
                get(
                    |Extension(ctx): Extension<AntiAbuseRequestContext>| async move {
                        assert!(ctx.trusted_transport);
                        let s = futures::stream::iter([
                            Ok::<Bytes, std::io::Error>(Bytes::from_static(b"{\"elements\":")),
                            Ok::<Bytes, std::io::Error>(Bytes::from_static(b"[]}")),
                        ]);
                        (
                            [(header::CONTENT_TYPE, "application/json")],
                            Body::from_stream(s),
                        )
                    },
                ),
            )
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                middleware,
            ))
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                observe_response,
            ))
            .with_state(state.clone());

        let mut req_drop = Request::builder()
            .uri("/items")
            .header(SESSION_HEADER, &live_redeemed.token)
            .body(Body::empty())
            .unwrap();
        for (k, v) in trusted_headers() {
            if let Some(name) = k {
                req_drop.headers_mut().insert(name, v);
            }
        }
        let resp_drop = stream_app.oneshot(req_drop).await.unwrap();
        assert_eq!(resp_drop.status(), StatusCode::OK);
        drop(resp_drop); // triggers ObservedStream::drop -> finish(false)

        // Expired suspicious session (> 30s) preserves cookie (no Set-Cookie Max-Age=0)
        // and forged canary does not trap
        let key_fp = format!("fp:{}", fp.fingerprint_hash);
        let rt2 = build_runtime_with_now(&state, tick_now, Some(0), None);
        let sessions2 = rt2.sessions.as_ref().unwrap();
        let ch = sessions2.challenge_at(&fp.fingerprint_hash, 0.0, None, tick_now());
        let nonce = solve_pow(&ch.challenge, ch.difficulty);
        let redeemed = sessions2
            .redeem_at(&ch.challenge, &nonce, &fp.fingerprint_hash, 0.0, tick_now())
            .unwrap();
        for page in 1..=10 {
            let offset = if page % 2 == 0 { 0 } else { 100 };
            let ev = AbuseEvent {
                resource: AbuseResource {
                    route: "/offers".into(),
                    page: Some(page),
                    ..Default::default()
                },
                at: tick_now() + (page as i64) * 500 + offset,
                deep: true,
                support: false,
                resources: None,
                mismatch: 0.0,
                trap: None,
                method: Some("GET".into()),
            };
            rt2.scorer.scorer.lock().unwrap().record_local(
                std::slice::from_ref(&key_fp),
                &ev,
                tick_now(),
            );
        }
        set_tick_clock(tick_now() + SUSPICIOUS_TTL_MS + 1000);
        let chal_app = Router::new()
            .route("/offers", get(|| async { "ok" }))
            .route("/auth/challenge", post(challenge))
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                middleware,
            ))
            .layer(Extension(rt2.clone()))
            .with_state(state.clone());
        let mut req_exp = Request::builder()
            .uri("/offers?page=1")
            .header(SESSION_HEADER, &redeemed.token)
            .body(Body::empty())
            .unwrap();
        for (k, v) in trusted_headers() {
            if let Some(name) = k {
                req_exp.headers_mut().insert(name, v);
            }
        }
        let resp_exp = chal_app.clone().oneshot(req_exp).await.unwrap();
        assert_eq!(resp_exp.status(), StatusCode::OK);
        assert!(resp_exp.headers().get(header::SET_COOKIE).is_none());

        // Redeem on POST /auth/challenge while suspicious fails low-difficulty challenge -> replaced
        let mut req_reissue = Request::builder()
            .method(Method::POST)
            .uri("/auth/challenge")
            .header(SESSION_HEADER, &redeemed.token)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"challenge": ch.challenge, "nonce": nonce}).to_string(),
            ))
            .unwrap();
        for (k, v) in trusted_headers() {
            if let Some(name) = k {
                req_reissue.headers_mut().insert(name, v);
            }
        }
        let resp_reissue = chal_app.oneshot(req_reissue).await.unwrap();
        assert_eq!(resp_reissue.status(), StatusCode::OK);
        let reissue_json: Value =
            serde_json::from_slice(&resp_reissue.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(reissue_json["difficulty"], 20);

        // Challenge on /search/v2/search + real tarpit_delay (hook=None) + canary body stream error + ObservedStream Err/Pending + non-UTF8 cookie
        let mut bad_cookie = HeaderMap::new();
        bad_cookie.insert(
            header::COOKIE,
            HeaderValue::from_bytes(b"\xff=bad; other=1").unwrap(),
        );
        assert_eq!(extract_session_token(&bad_cookie), "");
        let mut other_cookie = HeaderMap::new();
        other_cookie.insert(header::COOKIE, "other=1".parse().unwrap());
        assert_eq!(extract_session_token(&other_cookie), "");

        assert!(ports.read_day(0).await.unwrap().is_empty());

        let rt_tarpit = build_runtime_with_now(&state, tick_now, Some(1), None);
        for page in 1..=10 {
            let offset = if page % 2 == 0 { 0 } else { 100 };
            let ev = AbuseEvent {
                resource: AbuseResource {
                    route: "/offers".into(),
                    page: Some(page),
                    ..Default::default()
                },
                at: tick_now() + (page as i64) * 500 + offset,
                deep: true,
                support: false,
                resources: None,
                mismatch: 0.0,
                trap: None,
                method: Some("GET".into()),
            };
            rt_tarpit.scorer.scorer.lock().unwrap().record_local(
                std::slice::from_ref(&key_fp),
                &ev,
                tick_now(),
            );
        }
        let search_chal_app = Router::new()
            .route("/search/v2/search", get(|| async { "ok" }))
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                middleware,
            ))
            .layer(Extension(rt_tarpit.clone()))
            .with_state(state.clone());
        let mut req_search_chal = Request::builder()
            .uri("/search/v2/search")
            .body(Body::empty())
            .unwrap();
        *req_search_chal.headers_mut() = trusted_headers();
        assert_eq!(
            search_chal_app
                .clone()
                .oneshot(req_search_chal)
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );

        // Trap -> real tarpit_delay(1).await in middleware, then sleepers cap (>= MAX_SLEEPERS) skips sleep
        rt_tarpit
            .scorer
            .trap(std::slice::from_ref(&key_fp), tick_now());
        let mut req_real_tarpit = Request::builder()
            .uri("/search/v2/search")
            .body(Body::empty())
            .unwrap();
        *req_real_tarpit.headers_mut() = trusted_headers();
        assert_eq!(
            search_chal_app
                .clone()
                .oneshot(req_real_tarpit)
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
        rt_tarpit.sleepers.store(MAX_SLEEPERS, Ordering::Relaxed);
        let mut req_capped_tarpit = Request::builder()
            .uri("/search/v2/search")
            .body(Body::empty())
            .unwrap();
        *req_capped_tarpit.headers_mut() = trusted_headers();
        assert_eq!(
            search_chal_app
                .oneshot(req_capped_tarpit)
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );

        // Canary body collection failure + ObservedStream Pending & Err
        let err_state = state_with_abuse_ports(cfg(AntiAbuseMode::Enforce, true), ports.clone());
        let err_rt = build_runtime(&err_state, Some(0), None);
        let err_sessions = err_rt.sessions.as_ref().unwrap();
        let err_ch = err_sessions.challenge_at(&fp.fingerprint_hash, 0.0, None, fixed_now());
        let err_nonce = solve_pow(&err_ch.challenge, err_ch.difficulty);
        let err_redeemed = err_sessions
            .redeem_at(
                &err_ch.challenge,
                &err_nonce,
                &fp.fingerprint_hash,
                0.0,
                fixed_now(),
            )
            .unwrap();

        let err_app = Router::new()
            .route(
                "/items",
                get(|| async {
                    let s = futures::stream::iter([Err::<Bytes, std::io::Error>(
                        std::io::Error::other("boom"),
                    )]);
                    (
                        [(header::CONTENT_TYPE, "application/json")],
                        Body::from_stream(s),
                    )
                }),
            )
            .route(
                "/countries",
                get(|| async {
                    let mut yielded_pending = false;
                    let s = futures::stream::poll_fn(move |cx| {
                        if !yielded_pending {
                            yielded_pending = true;
                            cx.waker().wake_by_ref();
                            Poll::Pending
                        } else {
                            Poll::Ready(Some(Err::<Bytes, std::io::Error>(std::io::Error::other(
                                "stream fail",
                            ))))
                        }
                    });
                    Body::from_stream(s)
                }),
            )
            .layer(axum::middleware::from_fn_with_state(
                err_state.clone(),
                middleware,
            ))
            .layer(axum::middleware::from_fn_with_state(
                err_state.clone(),
                observe_response,
            ))
            .layer(Extension(err_rt.clone()))
            .with_state(err_state);

        let mut req_canary_err = Request::builder()
            .uri("/items")
            .header(SESSION_HEADER, &err_redeemed.token)
            .body(Body::empty())
            .unwrap();
        for (k, v) in trusted_headers() {
            if let Some(name) = k {
                req_canary_err.headers_mut().insert(name, v);
            }
        }
        let resp_canary_err = err_app.clone().oneshot(req_canary_err).await.unwrap();
        assert_eq!(resp_canary_err.status(), StatusCode::OK);
        let _ = resp_canary_err.into_body().collect().await;

        let mut req_stream_err = Request::builder()
            .uri("/countries")
            .body(Body::empty())
            .unwrap();
        *req_stream_err.headers_mut() = trusted_headers();
        let resp_stream_err = err_app.oneshot(req_stream_err).await.unwrap();
        let _ = resp_stream_err.into_body().collect().await;

        // Closed trial controller edge cases
        let trial_ctrl = AbuseTrialController::new(ports, tick_now);
        trial_ctrl.close();
        trial_ctrl.poll().await;
        assert!(!trial_ctrl.matches("fp", "/search/v2/search", "GET", tick_now()));
    }

    #[tokio::test]
    async fn background_timers_tick_and_shut_down_cleanly() {
        struct SlowTrialPort(Arc<tokio::sync::Notify>);
        #[async_trait]
        impl AbuseTrialStorePort for SlowTrialPort {
            async fn get_trial_raw(&self) -> Result<Option<String>, CoreError> {
                self.0.notified().await;
                Ok(None)
            }
        }

        let ports = Arc::new(MockAbusePorts::default());
        let state = state_with_abuse_ports(cfg(AntiAbuseMode::Observe, false), ports);
        let rt = build_runtime(&state, None, None);
        let handle = tokio::runtime::Handle::current();
        let rx = rt.shutdown_tx.subscribe();
        rt.spawn_background_tasks(
            &handle,
            rx,
            Duration::from_millis(5),
            Duration::from_millis(3),
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
        rt.shutdown().await;
        tokio::task::yield_now().await;

        // Mid-poll close skips matcher update
        let notify = Arc::new(tokio::sync::Notify::new());
        let slow_ctrl = Arc::new(AbuseTrialController::new(
            Arc::new(SlowTrialPort(notify.clone())),
            fixed_now,
        ));
        let c2 = slow_ctrl.clone();
        let handle = tokio::spawn(async move {
            c2.poll().await;
        });
        tokio::task::yield_now().await;
        // Concurrent poll is skipped by CAS
        slow_ctrl.poll().await;
        slow_ctrl.close();
        notify.notify_one();
        handle.await.unwrap();
    }
}
