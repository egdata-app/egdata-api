//! ISO dates accepted by Node offer query validation and stored catalog serialization.
use chrono::{DateTime, Duration, Local, NaiveDate, Offset, TimeZone, Utc};
use regex::Regex;
use std::sync::LazyLock;

static ISO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
    r"^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]{1,3}))?)?(Z|[+-][0-9]{2}:[0-9]{2})?)?$"
).unwrap()
});

/// Match Date parsing on the ISO timestamp forms accepted by offer detail routes.
/// Bare dates use UTC. Times without an explicit zone use the origin's local zone.
pub fn parse_iso_timestamp(value: &str) -> Option<DateTime<Utc>> {
    let fields = ISO.captures(value)?;
    // All captures contain at most four decimal digits.
    let number = |index| {
        fields
            .get(index)
            .map_or(0u32, |s| s.as_str().parse().unwrap())
    };
    let year = number(1) as i32;
    let day = number(3);
    let (hour, minute, second) = (number(4), number(5), number(6));
    let fraction = fields.get(7).map_or("", |s| s.as_str());
    let millis = number(7) * 10u32.pow(3 - fraction.len() as u32);
    if !(1..=31).contains(&day)
        || hour > 24
        || minute > 59
        || second > 59
        || (hour == 24 && (minute != 0 || second != 0 || millis != 0))
    {
        return None;
    }
    let local = NaiveDate::from_ymd_opt(year, number(2), 1)?.and_time(chrono::NaiveTime::MIN)
        + Duration::days((day - 1).into())
        + Duration::hours(hour.into())
        + Duration::minutes(minute.into())
        + Duration::seconds(second.into())
        + Duration::milliseconds(millis.into());
    match fields.get(8).map(|s| s.as_str()) {
        None if fields.get(4).is_none() => Some(local.and_utc()),
        Some("Z") => Some(local.and_utc()),
        Some(zone) => {
            let hours: u32 = zone[1..3].parse().unwrap();
            let minutes: u32 = zone[4..6].parse().unwrap();
            if hours > 23 || minutes > 59 {
                return None;
            }
            let offset = Duration::minutes(i64::from(60 * hours + minutes));
            Some(
                if zone.starts_with('-') {
                    local + offset
                } else {
                    local - offset
                }
                .and_utc(),
            )
        }
        None => {
            if let Some(dt) = Local.from_local_datetime(&local).earliest() {
                return Some(dt.to_utc());
            }
            // During a DST gap JS uses the offset immediately before the transition.
            let before = Local
                .from_local_datetime(&(local - Duration::days(1)))
                .earliest()?;
            Some(
                local.and_utc()
                    - Duration::seconds(i64::from(before.offset().fix().local_minus_utc())),
            )
        }
    }
}
