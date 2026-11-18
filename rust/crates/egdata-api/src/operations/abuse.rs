use crate::middleware::anti_abuse::{cohort_report, pow_counters};
use anyhow::{Context, Result, ensure};
use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use clap::Subcommand;
use egdata_core::abuse::trial::{TRIAL_KEY, parse_trial};
use egdata_infra::redis_store::{
    COHORT_PREFIX, SUMMARY_PREFIX, connect_redis_manager, telemetry_config,
};
use redis::AsyncCommands;
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Debug, Subcommand)]
pub enum Action {
    Report {
        #[arg(long,default_value_t=60,value_parser=clap::value_parser!(u16).range(1..=1440))]
        minutes: u16,
    },
    Cohorts {
        #[arg(long)]
        day: Option<NaiveDate>,
    },
    Status,
    StartTrial {
        #[arg(long)]
        id: String,
        #[arg(long)]
        fingerprint: String,
        #[arg(long, default_value = "offer-details")]
        route: String,
        #[arg(long,default_value_t=120,value_parser=clap::value_parser!(u32).range(1..=900))]
        seconds: u32,
    },
    StopTrial {
        #[arg(long)]
        id: String,
    },
}
fn iso(ms: i64) -> Result<String> {
    Ok(DateTime::from_timestamp_millis(ms)
        .context("Invalid trial timestamp")?
        .to_rfc3339_opts(SecondsFormat::Millis, true))
}
#[derive(Default)]
struct Summary {
    buckets: usize,
    totals: BTreeMap<String, i64>,
    scopes: BTreeMap<String, BTreeMap<String, i64>>,
    routes: indexmap::IndexMap<String, [i64; 2]>,
}
impl Summary {
    fn add(&mut self, row: impl IntoIterator<Item = (String, i64)>) {
        let mut row = row.into_iter().peekable();
        self.buckets += usize::from(row.peek().is_some());
        for (key, value) in row {
            if key.starts_with("__") {
                continue;
            }
            let parts: Vec<_> = key.split('|').collect();
            let metric = *parts.last().unwrap_or(&key.as_str());
            *self.totals.entry(metric.into()).or_default() += value;
            if let [scope, _, _, _, _] = parts.as_slice() {
                *self
                    .scopes
                    .entry((*scope).into())
                    .or_default()
                    .entry(metric.into())
                    .or_default() += value;
                let counts = self.routes.entry(parts[..4].join("|")).or_default();
                match metric {
                    "requests" => counts[0] += value,
                    "bodyBytes" => counts[1] += value,
                    _ => (),
                }
            }
        }
    }
    fn finish(self, minutes: u16, now: i64) -> Result<Value> {
        let by_scope: BTreeMap<_, _> = self
            .scopes
            .iter()
            .map(|(k, v)| (k, pow_counters(v)))
            .collect();
        let mut routes: Vec<_> = self.routes.into_iter().collect();
        routes.sort_by_key(|(_, counts)| std::cmp::Reverse(counts[1]));
        let routes:Vec<_>=routes.into_iter().take(40).map(|(group,[requests,bytes])|json!({"group":group,"requests":requests,"bodyBytes":bytes})).collect();
        Ok(
            json!({"observedAt":iso(now)?,"requestedMinutes":minutes,"bucketsWithData":self.buckets,"totals":self.totals,"pow":{"totals":pow_counters(&self.totals),"byScope":by_scope,"limitations":"Request/attempt counts, not unique puzzles or users. Accepted proof replays count again. passedWithSession means admitted to a route, not successful browser recovery. Old buckets have no PoW coverage; inspect observedResponses. No browser failures, abandonment or Cloudflare cache hits are recorded. Handshakes use the global mode scope; scoped-trial handshakes appear under observe."},"routes":routes,"limitations":"Origin response-body bytes as consumed after app compression; excludes cache hits, transport overhead and requests rejected before anti-abuse. Best-effort summaries, not a billing report."}),
        )
    }
}
pub(super) async fn run(action: Action, env: &BTreeMap<String, String>) -> Result<()> {
    let config = telemetry_config(|k| env.get(k).cloned())?;
    let mut redis = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        connect_redis_manager(&config),
    )
    .await
    .context("Telemetry Redis connection timed out")?
    .context("Could not connect to telemetry Redis")?;
    let now = Utc::now();
    let ms = now.timestamp_millis();
    let mode = env
        .get("ANTI_ABUSE_MODE")
        .map(String::as_str)
        .unwrap_or("off");
    let canaries = env.get("ANTI_ABUSE_CANARIES").is_some_and(|v| v == "true");
    let output = match action {
        Action::Report { minutes } => {
            let mut summary = Summary::default();
            for start in (0..minutes).step_by(30) {
                let mut pipe = redis::pipe();
                for offset in start..minutes.min(start + 30) {
                    pipe.hgetall(format!(
                        "{SUMMARY_PREFIX}{}",
                        ms / 60000 - i64::from(offset)
                    ));
                }
                let rows: Vec<Vec<(String, i64)>> = pipe
                    .query_async(&mut redis)
                    .await
                    .context("Unable to read summary bucket")?;
                for row in rows {
                    summary.add(row)
                }
            }
            summary.finish(minutes, Utc::now().timestamp_millis())?
        }
        Action::Cohorts { day } => {
            let day = day.unwrap_or_else(|| now.date_naive());
            ensure!(
                matches!((now.date_naive() - day).num_days(), 0 | 1),
                "day must be today or yesterday in UTC"
            );
            let at = day.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp() / 86400;
            let rows = redis
                .hgetall(format!("{COHORT_PREFIX}{at}"))
                .await
                .context("Unable to read cohort")?;
            let mut report = serde_json::to_value(cohort_report(&rows, ms))?;
            report["observedAt"] = json!(iso(ms)?);
            report["day"] = json!(day);
            report
        }
        Action::Status => {
            let raw: Option<String> = redis
                .get(TRIAL_KEY)
                .await
                .context("Unable to read active trial")?;
            let trial=parse_trial(raw.as_deref(),ms).map(|t|->Result<_>{Ok(json!({"id":t.id,"expiresAt":iso(t.expires_at)?,"route":t.route,"fingerprints":t.fingerprints.len()}))}).transpose()?;
            json!({"mode":mode,"canaries":canaries,"trial":trial})
        }
        Action::StartTrial {
            id,
            route,
            fingerprint,
            seconds,
        } => {
            ensure!(
                mode == "observe" && !canaries,
                "A scoped trial requires observe mode with canaries disabled"
            );
            let ttl = i64::from(seconds) * 1000;
            let raw=json!({"id":id,"createdAt":ms,"expiresAt":ms+ttl,"route":route,"fingerprints":[fingerprint]}).to_string();
            let trial = parse_trial(Some(&raw), ms)
                .context("Invalid trial ID, fingerprint, route or duration")?;
            let set: Option<String> = redis::cmd("SET")
                .arg(TRIAL_KEY)
                .arg(serde_json::to_string(&trial)?)
                .arg("PX")
                .arg(ttl)
                .arg("NX")
                .query_async(&mut redis)
                .await
                .context("Unable to start trial")?;
            ensure!(
                set.is_some(),
                "Another trial exists; stop it by ID or wait for expiry"
            );
            json!({"started":trial.id,"expiresAt":iso(trial.expires_at)?,"route":trial.route})
        }
        Action::StopTrial { id } => {
            ensure!(
                !id.is_empty()
                    && id.len() <= 64
                    && id
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_')),
                "A trial ID is required"
            );
            let stopped:i64=redis::Script::new("local v=redis.call('GET',KEYS[1]); if v and cjson.decode(v).id == ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0").key(TRIAL_KEY).arg(&id).invoke_async(&mut redis).await.context("Unable to stop trial")?;
            json!({"id":id,"stopped":stopped==1,"rollbackWithinSeconds":2})
        }
    };
    println!("{}", serde_json::to_string_pretty(&output)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn report_aggregates_requests_bytes_and_pow_by_scope() {
        let mut totals = Summary::default();
        totals.add(BTreeMap::new());
        totals.add(BTreeMap::from([
            ("observe|GET|offers|200|requests".into(), 3),
            ("observe|GET|offers|200|bodyBytes".into(), 8),
            ("observe|GET|offers|200|pow:issued".into(), 2),
            ("global".into(), 5),
            ("__reserved".into(), 10),
        ]));
        let report = totals.finish(2, 0).unwrap();
        assert_eq!(report["bucketsWithData"], 1);
        assert_eq!(
            report["routes"][0],
            json!({"group":"observe|GET|offers|200","requests":3,"bodyBytes":8})
        );
        assert_eq!(report["totals"]["global"], 5);
        assert!(report["totals"].get("__reserved").is_none());
    }
}
