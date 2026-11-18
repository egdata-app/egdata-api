//! Anti-abuse sliding-window scorer, weights, thresholds, and bounded expiring LRU.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};

use super::operations::logical_operations;

pub const WINDOW_MS: i64 = 60_000;
pub const MAX_EVENTS: usize = 128;
pub const TRAP_TTL_MS: i64 = 600_000;

/// Atomic sliding window Redis Lua script shared across API instances.
pub const APPEND_WINDOW_SCRIPT: &str = r#"
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local event = cjson.decode(ARGV[1])
-- Use arrival time, not worker processing time (queueing must not manufacture
-- robotic intervals). Clamp future clock skew; hosts should use NTP.
event.at = math.min(event.at, now)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - 60000)
if event.at > now - 60000 then
  redis.call('ZADD', KEYS[1], event.at, ARGV[2] .. '|' .. cjson.encode(event))
end
redis.call('ZREMRANGEBYRANK', KEYS[1], 0, -129)
redis.call('PEXPIRE', KEYS[1], 60000)
if event.trap then redis.call('SET', KEYS[2], '1', 'PX', 600000) end
return {redis.call('ZRANGE', KEYS[1], 0, -1), redis.call('EXISTS', KEYS[2])}
"#;

/// Normalized resource descriptor attached to an anti-abuse event.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AbuseResource {
    pub route: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hydration_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hydration_route: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_hit: Option<bool>,
}

/// Recorded request telemetry event inside a 60s sliding window.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AbuseEvent {
    #[serde(flatten)]
    pub resource: AbuseResource,
    pub at: i64,
    pub deep: bool,
    pub support: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resources: Option<Vec<AbuseResource>>,
    pub mismatch: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trap: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
}

/// Risk assessment score (`0.0..=1.0`) and diagnostic reason tags.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AbuseAssessment {
    pub score: f64,
    pub reasons: Vec<String>,
}

#[derive(Debug)]
struct LruEntry<T> {
    value: T,
    expires_at: i64,
}

/// Bounded LRU cache whose entries expire lazily on lookup.
#[derive(Debug)]
pub struct ExpiringLru<T> {
    capacity: usize,
    entries: HashMap<String, LruEntry<T>>,
    order: VecDeque<String>,
}

impl<T: Clone> ExpiringLru<T> {
    /// Creates an expiring LRU with at most `capacity` entries.
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            entries: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    fn remove_from_order(&mut self, key: &str) {
        self.order.retain(|k| k != key);
    }

    /// Retrieves a non-expired value and promotes it to most-recently-used.
    pub fn get(&mut self, key: &str, now_ms: i64) -> Option<T> {
        let expired = match self.entries.get(key) {
            Some(entry) => entry.expires_at <= now_ms,
            None => return None,
        };
        self.remove_from_order(key);
        if expired {
            self.entries.remove(key);
            return None;
        }
        self.order.push_back(key.to_string());
        self.entries.get(key).map(|entry| entry.value.clone())
    }

    /// Inserts or refreshes a value with `ttl_ms` lifetime.
    pub fn set(&mut self, key: impl Into<String>, value: T, ttl_ms: i64, now_ms: i64) {
        if self.capacity == 0 {
            return;
        }
        let key = key.into();
        if self.entries.contains_key(&key) {
            self.remove_from_order(&key);
        }
        self.entries.insert(
            key.clone(),
            LruEntry {
                value,
                expires_at: now_ms + ttl_ms,
            },
        );
        self.order.push_back(key);
        if self.entries.len() > self.capacity
            && let Some(oldest) = self.order.pop_front()
        {
            self.entries.remove(&oldest);
        }
    }
}

fn strip_filter_hash(route: &str) -> &str {
    if route.len() >= 65 {
        let split = route.len() - 65;
        let suffix = &route[split..];
        if suffix.starts_with(':')
            && suffix[1..]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return &route[..split];
        }
    }
    route
}

fn resource_key(resource: &AbuseResource, include_filters: bool) -> String {
    let route = if include_filters {
        resource.route.as_str()
    } else {
        strip_filter_hash(&resource.route)
    };
    let id = resource
        .item_id
        .as_deref()
        .or(resource.hydration_id.as_deref())
        .unwrap_or("");
    serde_json::to_string(&[route, id]).expect("string tuple serializes")
}

/// Evaluates an event window into an anti-abuse risk score and reason list.
pub fn analyze_events(events: &[AbuseEvent]) -> AbuseAssessment {
    let mut sorted = events.to_vec();
    sorted.sort_by_key(|event| event.at);

    if sorted.iter().any(|event| event.trap == Some(true)) {
        return AbuseAssessment {
            score: 1.0,
            reasons: vec!["canary".to_string()],
        };
    }

    let count = sorted.len();
    if count == 0 {
        return AbuseAssessment {
            score: 0.0,
            reasons: Vec::new(),
        };
    }

    let mismatch = sorted
        .iter()
        .map(|event| event.mismatch)
        .fold(f64::NEG_INFINITY, f64::max);

    let deep: Vec<&AbuseEvent> = sorted.iter().filter(|event| event.deep).collect();
    let resources: Vec<(&AbuseResource, i64)> = deep
        .iter()
        .flat_map(|event| {
            let list: &[AbuseResource] = match event.resources.as_deref() {
                Some(items) if !items.is_empty() => items,
                _ => std::slice::from_ref(&event.resource),
            };
            list.iter().map(move |resource| (resource, event.at))
        })
        .collect();

    let mut distinct_pages: HashMap<String, HashSet<u32>> = HashMap::new();
    for (resource, _) in &resources {
        let Some(page) = resource.page.filter(|&p| p >= 1) else {
            continue;
        };
        let key = resource_key(resource, true);
        distinct_pages.entry(key).or_default().insert(page);
    }
    let page_sweep = distinct_pages.values().any(|pages| pages.len() >= 10);

    // Ten pages must be observable before the legacy twelve-event warm-up ends.
    if count < 12 && !page_sweep {
        return AbuseAssessment {
            score: 0.3_f64.min(mismatch),
            reasons: if mismatch != 0.0 {
                vec!["transport-mismatch".to_string()]
            } else {
                Vec::new()
            },
        };
    }

    let operations = logical_operations(&sorted);
    let logical_deep: Vec<&AbuseEvent> = operations.iter().filter(|event| event.deep).collect();
    let mut route_counts: HashMap<String, usize> = HashMap::new();
    for event in &logical_deep {
        let list: &[AbuseResource] = match event.resources.as_deref() {
            Some(items) if !items.is_empty() => items,
            _ => std::slice::from_ref(&event.resource),
        };
        let keys: HashSet<String> = list
            .iter()
            .map(|resource| resource_key(resource, false))
            .collect();
        for key in keys {
            *route_counts.entry(key).or_insert(0) += 1;
        }
    }
    let route_hammering = route_counts.values().any(|&c| c >= 120);

    let support = sorted.iter().filter(|event| event.support).count();
    let ratio = deep.len() as f64 / (deep.len() + support).max(1) as f64;

    let gaps: Vec<f64> = operations
        .windows(2)
        .map(|pair| (pair[1].at - pair[0].at).max(0) as f64)
        .collect();
    let mean = if gaps.is_empty() {
        0.0
    } else {
        gaps.iter().sum::<f64>() / gaps.len() as f64
    };
    let variance = if gaps.is_empty() {
        0.0
    } else {
        gaps.iter().map(|gap| (gap - mean).powi(2)).sum::<f64>() / gaps.len() as f64
    };
    let cv = if mean > 0.0 {
        variance.sqrt() / mean
    } else {
        0.0
    };
    let regular = gaps.len() >= 8 && (50.0..2000.0).contains(&mean) && cv < 0.15;
    let high_volume = logical_deep.len() >= 60;

    let mut sequential = 0_usize;
    let mut pages: HashMap<&str, (u32, i64, usize)> = HashMap::new();
    for (resource, at) in &resources {
        let Some(page) = resource.page else {
            continue;
        };
        let prev = pages.get(resource.route.as_str()).copied();
        if prev.is_some_and(|(prev_page, _, _)| prev_page == page) {
            continue;
        }
        let steps = match prev {
            Some((prev_page, prev_at, prev_steps))
                if page == prev_page + 1 && (*at - prev_at) < 5000 =>
            {
                prev_steps + 1
            }
            _ => 0,
        };
        sequential = sequential.max(steps);
        pages.insert(resource.route.as_str(), (page, *at, steps));
    }

    let unique = resources
        .iter()
        .filter_map(|(resource, _)| resource.item_id.as_deref().filter(|s| !s.is_empty()))
        .collect::<HashSet<_>>()
        .len();

    let title_searches: Vec<&AbuseResource> = operations
        .iter()
        .filter(|event| event.deep)
        .flat_map(|event| event.resources.as_deref().unwrap_or(&[]))
        .filter(|resource| {
            resource.search == Some(true)
                && resource
                    .title_hash
                    .as_deref()
                    .is_some_and(|s| !s.is_empty())
        })
        .collect();
    let distinct_titles = title_searches
        .iter()
        .filter_map(|resource| resource.title_hash.as_deref())
        .collect::<HashSet<_>>()
        .len();
    let search_times: Vec<i64> = resources
        .iter()
        .filter(|(resource, _)| {
            resource.search == Some(true)
                && resource
                    .title_hash
                    .as_deref()
                    .is_some_and(|s| !s.is_empty())
        })
        .map(|(_, at)| *at)
        .collect();
    let title_sweep = distinct_titles >= 18
        && (distinct_titles as f64 / title_searches.len() as f64) >= 0.8
        && search_times
            .iter()
            .copied()
            .max()
            .zip(search_times.iter().copied().min())
            .is_some_and(|(max_t, min_t)| max_t - min_t >= 25_000);

    let sweep = sequential >= 8 || unique >= 60 || title_sweep || page_sweep || route_hammering;

    let large_searches: Vec<u32> = resources
        .iter()
        .filter_map(|(resource, _)| {
            if resource.search == Some(true) && resource.limit.unwrap_or(0) >= 50 {
                resource.limit
            } else {
                None
            }
        })
        .collect();
    let large_search_volume = large_searches.len() >= 20
        && large_searches.iter().map(|&l| u64::from(l)).sum::<u64>() >= 1500;

    let mut reasons = Vec::new();
    if ratio >= 0.95 {
        reasons.push("deep-only".to_string());
    } else if ratio >= 0.8 {
        reasons.push("mostly-deep".to_string());
    }
    if sequential >= 8 {
        reasons.push("sequential-pages".to_string());
    }
    if page_sweep {
        reasons.push("page-sweep".to_string());
    }
    if route_hammering {
        reasons.push("route-hammering".to_string());
    }
    if unique >= 60 {
        reasons.push("unique-id-sweep".to_string());
    }
    if title_sweep {
        reasons.push("title-lookup-sweep".to_string());
    }
    if regular {
        reasons.push("regular-intervals".to_string());
    }
    if high_volume {
        reasons.push("high-volume".to_string());
    }
    if large_search_volume {
        reasons.push("large-search-volume".to_string());
    }
    if mismatch != 0.0 {
        reasons.push("transport-mismatch".to_string());
    }

    // Deep-only traffic or a common TLS profile alone must never convict.
    let ratio_weight = if sweep || regular || high_volume || large_search_volume {
        if ratio >= 0.95 {
            0.2
        } else if ratio >= 0.8 {
            0.1
        } else {
            0.0
        }
    } else {
        0.0
    };
    let score = (ratio_weight
        + if sweep { 0.45 } else { 0.0 }
        + if regular { 0.2 } else { 0.0 }
        + if high_volume { 0.2 } else { 0.0 }
        + if large_search_volume { 0.2 } else { 0.0 }
        + mismatch.min(0.15))
    .min(1.0);

    AbuseAssessment { score, reasons }
}

/// Convenience helper returning only the numeric risk score.
pub fn score_events(events: &[AbuseEvent]) -> f64 {
    analyze_events(events).score
}

/// Pure in-memory anti-abuse scoring state tracking local windows, risks, and canary traps.
#[derive(Debug)]
pub struct AbuseScorer {
    windows: ExpiringLru<Vec<AbuseEvent>>,
    risks: ExpiringLru<AbuseAssessment>,
    traps: ExpiringLru<bool>,
}

impl AbuseScorer {
    /// Creates an `AbuseScorer` with LRU cache capacity `capacity` (default 5000).
    pub fn new(capacity: usize) -> Self {
        Self {
            windows: ExpiringLru::new(capacity),
            risks: ExpiringLru::new(capacity),
            traps: ExpiringLru::new(capacity),
        }
    }

    /// Returns the maximum current risk score across `keys`.
    pub fn risk(&mut self, keys: &[String], now_ms: i64) -> f64 {
        let mut max_risk = 0.0_f64;
        for key in keys {
            let r = if self.traps.get(key, now_ms) == Some(true) {
                1.0
            } else {
                self.risks
                    .get(key, now_ms)
                    .map_or(0.0, |assessment| assessment.score)
            };
            max_risk = max_risk.max(r);
        }
        max_risk
    }

    /// Returns deduplicated diagnostic reasons across `keys`.
    pub fn reasons(&mut self, keys: &[String], now_ms: i64) -> Vec<String> {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for key in keys {
            if self.traps.get(key, now_ms) == Some(true) {
                if seen.insert("canary".to_string()) {
                    out.push("canary".to_string());
                }
            } else if let Some(assessment) = self.risks.get(key, now_ms) {
                for reason in assessment.reasons {
                    if seen.insert(reason.clone()) {
                        out.push(reason);
                    }
                }
            }
        }
        out
    }

    /// Marks `keys` as canary-trapped for `TRAP_TTL_MS`.
    pub fn trap(&mut self, keys: &[String], now_ms: i64) {
        for key in keys {
            self.traps.set(key.clone(), true, TRAP_TTL_MS, now_ms);
        }
    }

    /// Updates local sliding windows for `keys` with `event` and returns the local assessment per key.
    pub fn record_local(
        &mut self,
        keys: &[String],
        event: &AbuseEvent,
        now_ms: i64,
    ) -> Vec<(String, AbuseAssessment)> {
        if event.trap == Some(true) {
            self.trap(keys, now_ms);
        }
        let mut assessments = Vec::with_capacity(keys.len());
        for key in keys {
            let mut local: Vec<AbuseEvent> = self
                .windows
                .get(key, now_ms)
                .unwrap_or_default()
                .into_iter()
                .chain(std::iter::once(event.clone()))
                .filter(|entry| entry.at > now_ms - WINDOW_MS)
                .collect();
            local.sort_by_key(|entry| entry.at);
            if local.len() > MAX_EVENTS {
                let start = local.len() - MAX_EVENTS;
                local = local.split_off(start);
            }
            self.windows
                .set(key.clone(), local.clone(), WINDOW_MS, now_ms);
            let assessment = analyze_events(&local);
            self.risks
                .set(key.clone(), assessment.clone(), WINDOW_MS, now_ms);
            assessments.push((key.clone(), assessment));
        }
        assessments
    }

    /// Merges shared store state into the cached risk assessment if higher than local.
    pub fn merge_shared(
        &mut self,
        key: &str,
        shared_events: &[AbuseEvent],
        trapped: bool,
        now_ms: i64,
    ) -> AbuseAssessment {
        let candidate = if trapped {
            AbuseAssessment {
                score: 1.0,
                reasons: vec!["canary".to_string()],
            }
        } else {
            analyze_events(shared_events)
        };
        let current = self.risks.get(key, now_ms);
        let best = match current {
            Some(existing) if existing.score >= candidate.score => existing,
            _ => candidate,
        };
        self.risks
            .set(key.to_string(), best.clone(), WINDOW_MS, now_ms);
        best
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_event(at: i64, route: &str, deep: bool, support: bool) -> AbuseEvent {
        AbuseEvent {
            resource: AbuseResource {
                route: route.to_string(),
                ..Default::default()
            },
            at,
            deep,
            support,
            resources: None,
            mismatch: 0.0,
            trap: None,
            method: Some("GET".into()),
        }
    }

    #[test]
    fn test_expiring_lru() {
        let mut lru: ExpiringLru<i32> = ExpiringLru::new(2);
        lru.set("a", 1, 100, 1000);
        lru.set("b", 2, 100, 1000);
        assert_eq!(lru.get("a", 1050), Some(1)); // promotes a
        lru.set("c", 3, 100, 1050); // evicts b
        assert_eq!(lru.get("b", 1050), None);
        assert_eq!(lru.get("a", 1050), Some(1));
        assert_eq!(lru.get("a", 1150), None); // expired

        lru.set("c", 30, 100, 1060); // update existing
        assert_eq!(lru.get("c", 1060), Some(30));

        let mut zero: ExpiringLru<i32> = ExpiringLru::new(0);
        zero.set("x", 1, 100, 1000);
        assert_eq!(zero.get("x", 1000), None);
    }

    #[test]
    fn test_analyze_events_empty_canary_and_warmup() {
        assert_eq!(
            analyze_events(&[]),
            AbuseAssessment {
                score: 0.0,
                reasons: vec![]
            }
        );

        let mut trapped = mk_event(1000, "/offers", true, false);
        trapped.trap = Some(true);
        assert_eq!(score_events(&[trapped]), 1.0);

        let mut warm = mk_event(1000, "/offers", true, false);
        warm.mismatch = 0.5;
        let res = analyze_events(&[warm]);
        assert!((res.score - 0.3).abs() < 1e-9);
        assert_eq!(res.reasons, vec!["transport-mismatch"]);

        let clean_warm = mk_event(1000, "/offers", true, false);
        assert_eq!(score_events(&[clean_warm]), 0.0);
    }

    #[test]
    fn test_analyze_events_signals_and_weights() {
        // 1. Page sweep (< 12 events still triggers when >= 10 distinct pages!)
        // Vary gaps so `regular-intervals` does not fire simultaneously.
        let page_sweep_events: Vec<AbuseEvent> = (1..=10)
            .map(|p| {
                let offset = if p % 2 == 0 { 0 } else { 100 };
                let mut e = mk_event(1000 + (p as i64) * 500 + offset, "/offers", true, false);
                e.resource.page = Some(p);
                e
            })
            .collect();
        let ps = analyze_events(&page_sweep_events);
        assert!(ps.reasons.contains(&"page-sweep".to_string()));
        assert!(ps.reasons.contains(&"sequential-pages".to_string()));
        assert!(ps.reasons.contains(&"deep-only".to_string()));
        assert!((ps.score - (0.2 + 0.45)).abs() < 1e-9);

        // 2. Regular intervals + mostly-deep (ratio 0.8..0.95)
        let mut regular_events: Vec<AbuseEvent> = (0..10)
            .map(|i| mk_event(1000 + i * 500, "/offers", true, false))
            .collect();
        // Add 2 support events -> 10 / 12 = 0.833 (mostly-deep)
        regular_events.push(mk_event(6000, "/health", false, true));
        regular_events.push(mk_event(6500, "/health", false, true));
        let reg = analyze_events(&regular_events);
        assert!(reg.reasons.contains(&"regular-intervals".to_string()));
        assert!(reg.reasons.contains(&"mostly-deep".to_string()));
        assert!((reg.score - (0.1 + 0.2)).abs() < 1e-9);

        // 3. Unique ID sweep + high volume
        let unique_events: Vec<AbuseEvent> = (0..120)
            .map(|i| {
                let mut e = mk_event(1000 + (i as i64) * 10, "/offers/{id}", true, false);
                e.resource.item_id = Some(format!("id-{i}"));
                e
            })
            .collect();
        let uq = analyze_events(&unique_events);
        assert!(uq.reasons.contains(&"unique-id-sweep".to_string()));
        assert!(uq.reasons.contains(&"high-volume".to_string()));
        assert!((uq.score - 0.85).abs() < 1e-9);

        // 3b. Route hammering (120 hits to same route/resource, even with varying filter hashes)
        let hammer_events: Vec<AbuseEvent> = (0..120)
            .map(|i| {
                mk_event(
                    1000 + (i as i64) * 10,
                    &format!("/search/v2/search:{:064x}", i + 1),
                    true,
                    false,
                )
            })
            .collect();
        let hm = analyze_events(&hammer_events);
        assert!(hm.reasons.contains(&"route-hammering".to_string()));

        // 4. Title lookup sweep + large search volume
        let title_events: Vec<AbuseEvent> = (0..20)
            .map(|i| {
                let mut e = mk_event(
                    1000 + (i as i64) * 2000,
                    &format!("/search/v2/search:{:064x}", i + 1),
                    true,
                    false,
                );
                e.resource.search = Some(true);
                e.resource.limit = Some(100);
                e.resource.title_hash = Some(format!("{:064x}", i + 1));
                e
            })
            .collect();
        let tl = analyze_events(&title_events);
        assert!(tl.reasons.contains(&"title-lookup-sweep".to_string()));
        assert!(tl.reasons.contains(&"large-search-volume".to_string()));

        // 5. Duplicate page skips sequential increment, deep-only alone does not convict
        let mut benign: Vec<AbuseEvent> = (0..14)
            .map(|i| {
                let mut e = mk_event(1000 + (i as i64) * 4000, "/offers", true, false);
                e.resource.page = Some(1);
                e
            })
            .collect();
        benign[0].mismatch = 0.05;
        let ben = analyze_events(&benign);
        assert!((ben.score - 0.05).abs() < 1e-9);
        assert!(ben.reasons.contains(&"deep-only".to_string()));
        assert!(ben.reasons.contains(&"transport-mismatch".to_string()));

        // 6. Multi-resource GraphQL batch + ratio < 0.8 + collapsed single logical op (gaps empty)
        // + route with non-hex 65-char suffix
        let mut collapsed_search: Vec<AbuseEvent> = (0..12)
            .map(|i| {
                let mut e = mk_event(
                    1000 + (i as i64) * 100,
                    "/offers:nothex0000000000000000000000000000000000000000000000000000000000",
                    true,
                    false,
                );
                e.resource.search = Some(true);
                e
            })
            .collect();
        // Zero-gap check: only 1 logical operation -> gaps.is_empty()!
        let single_op = analyze_events(&collapsed_search);
        assert_eq!(single_op.score, 0.0);

        // Ratio < 0.8 (10 deep page sweep + 5 support = 10/15 = 0.66)
        let mut mixed: Vec<AbuseEvent> = (1..=10)
            .map(|p| {
                let mut e = mk_event(1000 + (p as i64) * 500, "/offers", true, false);
                e.resources = Some(vec![AbuseResource {
                    route: "/offers".into(),
                    page: Some(p),
                    ..Default::default()
                }]);
                e
            })
            .collect();
        for i in 0..5 {
            mixed.push(mk_event(10_000 + i * 3000, "/health", false, true));
        }
        let mx = analyze_events(&mixed);
        assert!((mx.score - 0.45).abs() < 1e-9);

        // Zero mean gap (all events at same timestamp)
        collapsed_search.iter_mut().for_each(|e| {
            e.at = 5000;
            e.resource.search = None;
        });
        let same_ts = analyze_events(&collapsed_search);
        assert!(!same_ts.reasons.contains(&"regular-intervals".to_string()));
    }

    #[test]
    fn test_abuse_scorer_state() {
        let mut scorer = AbuseScorer::new(100);
        let keys = vec!["ip:1".to_string(), "fp:1".to_string()];
        let now = 100_000_i64;

        let e = mk_event(now, "/offers", true, false);
        scorer.record_local(&keys, &e, now);
        assert_eq!(scorer.risk(&keys, now), 0.0);
        assert!(scorer.reasons(&keys, now).is_empty());

        // Non-trapped cached assessment with reasons
        let seeded: Vec<AbuseEvent> = (1..=10)
            .map(|p| {
                let mut ev = mk_event(now + (p as i64) * 400, "/offers", true, false);
                ev.resource.page = Some(p);
                ev
            })
            .collect();
        let merged_clean = scorer.merge_shared("fp:seeded", &seeded, false, now);
        assert!(merged_clean.score > 0.0);
        scorer.merge_shared("fp:seeded2", &seeded, false, now);
        assert!(
            !scorer
                .reasons(
                    &["fp:seeded".into(), "fp:seeded2".into(), "fp:unknown".into()],
                    now
                )
                .is_empty()
        );

        // Merge shared trapped state
        let merged = scorer.merge_shared("ip:1", &[], true, now);
        assert_eq!(merged.score, 1.0);
        assert_eq!(scorer.risk(&keys, now), 1.0);
        assert_eq!(scorer.reasons(&keys, now), vec!["canary"]);

        // Merge shared non-trapped does not downgrade higher cached score
        let kept = scorer.merge_shared("ip:1", std::slice::from_ref(&e), false, now);
        assert_eq!(kept.score, 1.0);

        // Trap event sets trap LRU (and deduplicates "canary" across multiple trapped keys)
        let mut trap_ev = mk_event(now + 100, "/canary", true, false);
        trap_ev.trap = Some(true);
        scorer.record_local(&["fp:2".into(), "fp:3".into()], &trap_ev, now + 100);
        assert_eq!(scorer.risk(&["fp:2".into()], now + 100), 1.0);
        assert_eq!(
            scorer.reasons(&["fp:2".into(), "fp:3".into()], now + 100),
            vec!["canary"]
        );

        // Test > MAX_EVENTS truncation
        let mut big_scorer = AbuseScorer::new(10);
        for i in 0..135_i64 {
            big_scorer.record_local(
                &["k".into()],
                &mk_event(now + i, "/x", false, true),
                now + i,
            );
        }
        assert_eq!(big_scorer.risk(&["k".into()], now + 200), 0.0);
    }
}
