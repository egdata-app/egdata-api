
use bson::{Bson, Document};
use egdata_core::pricing::{PriceAvailability, PriceLike, PriceSource, to_usd_cents};
use egdata_core::v1::ProblemError;
use egdata_core::v1::serialization::{js_string_number, js_truthy, stored_identifier};
use egdata_infra::bson_json::{bson_doc_to_js_json, bson_to_js_json};
use serde_json::{Value, json};

use crate::shared::system::internal_error;

pub fn availability(offer: &Value) -> PriceAvailability {
    let values = |field: &str| {
        offer[field].as_array().map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
    };
    PriceAvailability {
        countries_whitelist: values("countriesWhitelist"),
        countries_blacklist: values("countriesBlacklist"),
    }
}

pub fn usd_number(price: &Value, source: PriceSource) -> Option<f64> {
    let input = PriceLike {
        currency_code: price["currencyCode"].as_str().map(str::to_owned),
        discount_price: price["discountPrice"].as_f64(),
        original_price: price["originalPrice"].as_f64(),
        payout_currency_exchange_rate: price["payoutCurrencyExchangeRate"].as_f64(),
    };
    to_usd_cents(&input, source)
}

pub fn usd_cents(price: &Value, original: bool) -> Value {
    let source = if original {
        PriceSource::Original
    } else {
        PriceSource::Discount
    };
    json!(usd_number(price, source))
}

pub fn stored_number(value: &Bson) -> f64 {
    match value {
        Bson::Decimal128(n) => js_string_number(&n.to_string()),
        Bson::Int64(n) => *n as f64,
        Bson::DateTime(d) => d.timestamp_millis() as f64,
        Bson::Double(n) => *n,
        Bson::Boolean(v) => i32::from(*v) as f64,
        Bson::Null => 0.0,
        other => stored_identifier(other).map_or(f64::NAN, |s| js_string_number(&s)),
    }
}

#[derive(Clone, Copy, PartialEq)]
pub enum PriceFormat {
    Legacy,
    V1,
}

pub fn price_summary(
    format: PriceFormat,
    current: &Document,
    history: &[&Document],
    live: Option<&Document>,
) -> Result<Value, ProblemError> {
    let mut discounts = Vec::with_capacity(history.len() + 1);
    for row in history.iter().copied().chain(std::iter::once(current)) {
        let price = row.get("price");
        if format == PriceFormat::Legacy
            && matches!(price, None | Some(Bson::Null | Bson::Undefined))
        {
            return Err(internal_error());
        }
        discounts.push(
            price
                .and_then(Bson::as_document)
                .and_then(|p| p.get("discountPrice"))
                .map_or(0., stored_number),
        );
    }
    let current_usd = stored_usd(current, PriceSource::Discount);
    let original_usd = stored_usd(current, PriceSource::Original);
    let mut normalized = current.clone();
    if let Ok(fields) = normalized.get_document_mut("price") {
        fields.insert(
            "basePayoutPrice",
            original_usd.map_or(Bson::Null, Bson::Double),
        );
    } else if format == PriceFormat::Legacy
        && let Some(price) = normalized.get("price")
        && matches!(
            price,
            Bson::Int32(_) | Bson::Double(_) | Bson::Boolean(_) | Bson::String(_) | Bson::Int64(_)
        )
        && !bson_to_js_json(price).is_object()
        && js_truthy(&bson_to_js_json(price))
    {
        return Err(internal_error());
    }
    let current = match format {
        PriceFormat::Legacy => bson_doc_to_js_json(&normalized),
        PriceFormat::V1 => super::offer_prices::serialize_stored_price(normalized)?,
    };
    let usd = history
        .iter()
        .copied()
        .chain(live)
        .filter_map(|row| stored_usd(row, PriceSource::Discount));
    let (min, max) = price_bounds(discounts.into_iter());
    let (min_usd, max_usd) = price_bounds(usd);
    Ok(
        json!({"currentPrice":current,"maxPrice":max,"minPrice":min,"currentPriceUsd":current_usd,"currentOriginalPriceUsd":original_usd,"maxPriceUsd":max_usd,"minPriceUsd":min_usd}),
    )
}

pub fn stored_usd(price: &Document, source: PriceSource) -> Option<f64> {
    let fields = price.get_document("price").ok()?;
    // The driver's default promotes Long to Number up to and including 2^53.
    // Larger longs and all decimals remain objects and fail the Node typeof check.
    let number = |field| match fields.get(field)? {
        Bson::Int32(n) => Some(f64::from(*n)),
        Bson::Int64(n) if n.unsigned_abs() <= (1_u64 << 53) => Some(*n as f64),
        Bson::Double(n) => Some(*n),
        _ => None,
    };
    to_usd_cents(
        &PriceLike {
            currency_code: fields.get_str("currencyCode").ok().map(str::to_owned),
            discount_price: number("discountPrice"),
            original_price: number("originalPrice"),
            payout_currency_exchange_rate: number("payoutCurrencyExchangeRate"),
        },
        source,
    )
}

pub fn price_bounds(mut values: impl Iterator<Item = f64>) -> (Option<f64>, Option<f64>) {
    let Some(first) = values.next() else {
        return (None, None);
    };
    let mut min = first;
    let mut max = first;
    for n in values {
        if n.is_nan() || min.is_nan() {
            return (None, None);
        }
        min = min.min(n);
        max = max.max(n);
    }
    (Some(min), Some(max))
}
