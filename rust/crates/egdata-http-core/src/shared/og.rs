
use std::collections::HashSet;

use bson::{Bson, Document, doc};
use egdata_core::error::CoreError;
use egdata_core::ports::MongoFindOptions;
use serde_json::Value;

use crate::state::AppState;
use crate::v1_helpers::primitive_id;
use egdata_infra::og_renderer::parse_og_date;

pub fn format_og_date(value: Option<&Value>) -> String {
    egdata_infra::og_renderer::format_og_date_str(value.and_then(Value::as_str))
}

pub fn format_thousands_en_us(n: u64) -> String {
    group_digits(&n.to_string())
}

pub fn offer_card_price(amount: Option<f64>, currency: &str) -> Option<String> {
    match amount {
        Some(0.0) => Some("Free".to_string()),
        Some(a) if a.is_finite() && a > 0.0 => (currency.len() == 3
            && currency.bytes().all(|b| b.is_ascii_alphabetic()))
        .then(|| format_currency_en_us(a, currency)),
        _ => Some("Unavailable".to_string()),
    }
}

pub fn asset_detail(platform: Option<&Value>) -> String {
    platform
        .filter(|p| super::system::js_truthy(p))
        .map_or_else(
            || "Latest download".to_string(),
            |p| format!("{} download", egdata_core::v1::serialization::js_string(p)),
        )
}

pub fn latest_og_download(
    assets: &[Value],
    build: Option<&Value>,
) -> (Option<f64>, Option<Value>) {
    let assets = assets
        .iter()
        .map(|asset| bson::to_document(asset).unwrap())
        .collect::<Vec<_>>();
    let build = build.map(|build| bson::to_document(build).unwrap());
    latest_stored_download(&assets, build.as_ref()).unwrap()
}

pub async fn offer_card_download(
    state: &AppState,
    id: &str,
    offer: &Document,
    subitems: &[Document],
) -> Result<(Option<f64>, Option<Value>), CoreError> {
    let direct = match offer.get("items") {
        None | Some(Bson::Null | Bson::Undefined) => &[][..],
        Some(Bson::Array(items)) => items.as_slice(),
        _ => return Err(CoreError::Internal("Invalid offer items".into())),
    };
    let mut direct_ids = HashSet::new();
    let mut ids = Vec::with_capacity(direct.len());
    for entry in direct {
        let id = nested_item_id(entry)?;
        if let Some(key) = primitive_id(id) {
            direct_ids.insert(key);
        }
        ids.push(id.cloned().unwrap_or(Bson::Null));
    }
    for record in subitems {
        let entries = record
            .get_array("subItems")
            .map_err(|_| CoreError::Internal("Invalid offer subitems".into()))?;
        for entry in entries {
            ids.push(nested_item_id(entry)?.cloned().unwrap_or(Bson::Null));
        }
    }
    let items = state
        .mongo
        .find_many(
            "items",
            doc! { "$or": [ { "id": { "$in": ids } }, { "linkedOffers": id } ] },
            MongoFindOptions {
                projection: Some(doc! { "id": 1 }),
                ..Default::default()
            },
        )
        .await?;
    let item_ids: Vec<_> = items
        .into_iter()
        .map(|mut item| item.remove("id").unwrap_or(Bson::Null))
        .collect();
    let mut assets = state
        .mongo
        .find_many(
            "assets",
            doc! { "itemId": { "$in": item_ids } },
            MongoFindOptions::default(),
        )
        .await?;
    let is_direct = |asset: &Document| {
        primitive_id(asset.get("itemId")).is_some_and(|id| direct_ids.contains(&id))
    };
    if assets.iter().any(is_direct) {
        assets.retain(is_direct);
    }
    let mut seen = HashSet::new();
    let artifact_ids: Vec<_> = assets
        .iter()
        .filter_map(|asset| {
            let id = asset.get("artifactId");
            primitive_id(id)
                .is_none_or(|key| seen.insert(key))
                .then(|| id.cloned().unwrap_or(Bson::Null))
        })
        .collect();
    let build = if artifact_ids.is_empty() {
        None
    } else {
        state
            .mongo
            .find_many(
                "builds",
                doc! { "appName": { "$in": artifact_ids } },
                MongoFindOptions {
                    sort: Some(doc! { "createdAt": -1, "_id": -1 }),
                    limit: Some(1),
                    ..Default::default()
                },
            )
            .await?
            .into_iter()
            .next()
    };
    if build
        .as_ref()
        .is_some_and(|b| present(b.get("_id")).is_none())
    {
        return Err(CoreError::Internal("Invalid build for offer card".into()));
    }
    latest_stored_download(&assets, build.as_ref())
}

pub fn group_digits(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (idx, ch) in s.chars().rev().enumerate() {
        if idx > 0 && idx % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out.chars().rev().collect()
}

pub fn format_currency_en_us(amount_minor: f64, currency: &str) -> String {
    // Intl formats the shortest decimal representation of the JS division, then
    // rounds half up to the currency's display precision, including historic codes.
    let currency = currency.to_ascii_uppercase();
    let precision = match currency.as_str() {
        "ADP" | "AFN" | "ALL" | "BIF" | "BYR" | "CLP" | "COP" | "DJF" | "ESP" | "GNF" | "HUF"
        | "IDR" | "IQD" | "IRR" | "ISK" | "ITL" | "JPY" | "KMF" | "KPW" | "KRW" | "LAK" | "LBP"
        | "LUF" | "MGA" | "MGF" | "MMK" | "MRO" | "PYG" | "RWF" | "SLL" | "SOS" | "STD" | "SYP"
        | "TMM" | "TRL" | "UGX" | "UYI" | "VND" | "VUV" | "XAF" | "XOF" | "XPF" | "YER" | "ZMK"
        | "ZWD" => 0,
        "BHD" | "JOD" | "KWD" | "LYD" | "OMR" | "TND" => 3,
        "CLF" | "UYW" => 4,
        _ => 2,
    };
    let numeric = decimal_price(amount_minor / 100.0, precision);
    match currency.as_str() {
        "USD" => format!("${numeric}"),
        "EUR" => format!("€{numeric}"),
        "GBP" => format!("£{numeric}"),
        "JPY" => format!("¥{numeric}"),
        "CNY" => format!("CN¥{numeric}"),
        "KRW" => format!("₩{numeric}"),
        "INR" => format!("₹{numeric}"),
        "VND" => format!("₫{numeric}"),
        "ILS" => format!("₪{numeric}"),
        "PHP" => format!("₱{numeric}"),
        "BRL" => format!("R${numeric}"),
        "CAD" => format!("CA${numeric}"),
        "AUD" => format!("A${numeric}"),
        "MXN" => format!("MX${numeric}"),
        "HKD" => format!("HK${numeric}"),
        "NZD" => format!("NZ${numeric}"),
        "TWD" => format!("NT${numeric}"),
        "XCD" => format!("EC${numeric}"),
        "XXX" => format!("¤{numeric}"),
        "XCG" => format!("Cg.\u{00a0}{numeric}"),
        "XAF" => format!("FCFA\u{00a0}{numeric}"),
        "XOF" => format!("F\u{202f}CFA\u{00a0}{numeric}"),
        "XPF" => format!("CFPF\u{00a0}{numeric}"),
        other => format!("{other}\u{00a0}{numeric}"),
    }
}

pub fn present(value: Option<&Bson>) -> Option<&Bson> {
    value.filter(|value| !matches!(value, Bson::Null | Bson::Undefined))
}

pub fn latest_stored_download(
    assets: &[Document],
    build: Option<&Document>,
) -> Result<(Option<f64>, Option<Value>), CoreError> {
    let label;
    let (bytes, platform) = if let Some(build) = build {
        let platform = if let Some(p) = present(build.get("platform")) {
            p
        } else {
            label = Bson::String(
                build
                    .get_str("labelName")
                    .map_err(|_| CoreError::Internal("Invalid build label".into()))?
                    .rsplit('-')
                    .next()
                    .unwrap_or_default()
                    .to_string(),
            );
            &label
        };
        let same = |left, right| {
            primitive_id(left).is_some_and(|key| primitive_id(right) == Some(key))
                && !matches!(left, Some(Bson::Double(n)) if n.is_nan())
        };
        let matching: Vec<_> = assets
            .iter()
            .filter(|a| same(a.get("artifactId"), build.get("appName")))
            .collect();
        let asset = matching
            .iter()
            .copied()
            .find(|a| same(a.get("platform"), Some(platform)))
            .or_else(|| {
                matching.iter().copied().find(|a| {
                    !a.get("platform")
                        .is_some_and(crate::shared::system::truthy)
                })
            })
            .or_else(|| {
                (platform.as_str() == Some("Unknown") && matching.len() == 1).then(|| matching[0])
            });
        let bytes = present(build.get("downloadSizeBytes"))
            .or_else(|| asset?.get("downloadSizeBytes"))
            .and_then(og_number);
        let platform = if platform.as_str() == Some("Unknown") {
            asset.and_then(|a| a.get("platform"))
        } else {
            Some(platform)
        };
        (bytes, platform)
    } else {
        let best = assets
            .iter()
            .min_by_key(|a| std::cmp::Reverse(asset_timestamp_millis(a)));
        (
            best.and_then(|a| a.get("downloadSizeBytes"))
                .and_then(og_number),
            best.and_then(|a| a.get("platform")),
        )
    };
    Ok((
        bytes,
        platform.map(egdata_infra::bson_json::bson_to_js_json),
    ))
}

pub fn nested_item_id(entry: &Bson) -> Result<Option<&Bson>, CoreError> {
    if matches!(entry, Bson::Null | Bson::Undefined) {
        return Err(CoreError::Internal("Null item reference".into()));
    }
    Ok(entry.as_document().and_then(|doc| doc.get("id")))
}

pub fn decimal_price(amount: f64, precision: usize) -> String {
    use egdata_core::v1::query::format_js_number;
    use num_bigint::BigUint;

    let decimal = format_js_number(amount);
    let (mantissa, exponent) = decimal
        .split_once('e')
        .map_or((decimal.as_str(), 0), |(m, e)| {
            (m, e.parse::<i32>().expect("finite JS number exponent"))
        });
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits: BigUint = format!("{whole}{fraction}")
        .parse()
        .expect("unsigned decimal digits");
    let shift = exponent + precision as i32 - fraction.len() as i32;
    let factor = BigUint::from(10u8).pow(shift.unsigned_abs());
    let rounded = if shift >= 0 {
        digits * factor
    } else {
        (digits + &factor / 2u8) / factor
    };
    let padded = format!("{rounded:0width$}", width = precision + 1);
    let (whole, fraction) = padded.split_at(padded.len() - precision);
    let grouped = group_digits(whole);
    if fraction.is_empty() {
        grouped
    } else {
        format!("{grouped}.{fraction}")
    }
}

pub fn og_number(value: &Bson) -> Option<f64> {
    match value {
        Bson::Int32(n) => Some(f64::from(*n)),
        Bson::Int64(n) if n.unsigned_abs() <= 1 << 53 => Some(*n as f64),
        Bson::Double(n) => Some(*n),
        _ => None,
    }
}

pub fn asset_timestamp_millis(asset: &Document) -> i64 {
    let value = present(asset.get("updatedAt")).or_else(|| asset.get("createdAt"));
    match value {
        Some(Bson::String(s)) => parse_og_date(s).map_or(0, |dt| dt.timestamp_millis()),
        Some(Bson::DateTime(dt)) => dt.timestamp_millis(),
        Some(Bson::Boolean(b)) => i64::from(*b),
        Some(value) => og_number(value)
            .filter(|ms| ms.abs() <= 8.64e15)
            .map_or(0, |ms| ms as i64),
        None => 0,
    }
}
