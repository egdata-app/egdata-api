//! Pricing conversion, country/region eligibility checks, and currency precision rules.

use crate::countries::get_region;
use serde::{Deserialize, Serialize};

/// Selects whether to read the discounted or original price field in [`to_usd_cents`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PriceSource {
    #[default]
    Discount,
    Original,
}

/// Minimal price record projection needed for USD minor-unit conversion.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceLike {
    pub currency_code: Option<String>,
    pub discount_price: Option<f64>,
    pub original_price: Option<f64>,
    pub payout_currency_exchange_rate: Option<f64>,
}

/// Convert a regional-currency price (in minor units) to USD minor units (cents).
///
/// Uses JavaScript Number precision. Non-finite results survive aggregation
/// and become null when the HTTP response is serialized.
pub fn to_usd_cents(price: &PriceLike, source: PriceSource) -> Option<f64> {
    let raw = match source {
        PriceSource::Original => price.original_price,
        PriceSource::Discount => price.discount_price,
    }?;

    if raw < 0.0 {
        return None;
    }

    if price.currency_code.as_deref() == Some("USD") {
        return Some(raw.round());
    }

    let rate = price.payout_currency_exchange_rate?;
    if rate <= 0.0 {
        return None;
    }

    Some((raw * rate).round())
}

/// Offer country whitelist/blacklist metadata used for price availability checks.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceAvailability {
    pub countries_whitelist: Option<Vec<String>>,
    pub countries_blacklist: Option<Vec<String>>,
}

fn normalized_countries(list: Option<&[String]>) -> Vec<String> {
    list.unwrap_or(&[])
        .iter()
        .map(|value| value.to_uppercase())
        .collect()
}

/// Determine whether `country` is eligible to view/purchase `offer` prices.
pub fn is_price_country_eligible(offer: &PriceAvailability, country: &str) -> bool {
    let normalized = country.to_uppercase();
    let whitelist = normalized_countries(offer.countries_whitelist.as_deref());
    let blacklist = normalized_countries(offer.countries_blacklist.as_deref());

    !blacklist.contains(&normalized) && (whitelist.is_empty() || whitelist.contains(&normalized))
}

/// Determine whether at least one country in `region` is eligible for `offer` prices.
pub fn is_price_region_eligible(offer: &PriceAvailability, region: &str) -> bool {
    let Some(region_info) = get_region(region) else {
        return false;
    };

    region_info
        .countries
        .iter()
        .any(|country| is_price_country_eligible(offer, country))
}

/// Build a canonical JSON cache/grouping key for an offer's country availability rules.
pub fn price_availability_key(offer: &PriceAvailability) -> String {
    let mut whitelist = normalized_countries(offer.countries_whitelist.as_deref());
    whitelist.sort();
    let mut blacklist = normalized_countries(offer.countries_blacklist.as_deref());
    blacklist.sort();

    serde_json::to_string(&[whitelist, blacklist]).expect("Vec<String> always serializes")
}

const ZERO_DECIMAL_CURRENCIES: &[&str] = &[
    "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND",
    "VUV", "XAF", "XOF", "XPF",
];

const THREE_DECIMAL_CURRENCIES: &[&str] = &["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"];

/// Return the number of minor-unit decimal places for an ISO-4217 currency code.
pub fn currency_precision(currency_code: Option<&str>) -> u8 {
    let Some(code) = currency_code.filter(|value| !value.is_empty()) else {
        return 2;
    };

    let upper = code.to_uppercase();
    if ZERO_DECIMAL_CURRENCIES.contains(&upper.as_str()) {
        return 0;
    }
    if THREE_DECIMAL_CURRENCIES.contains(&upper.as_str()) {
        return 3;
    }
    2
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_usd_cents_handles_usd_and_fx_conversion() {
        let usd = PriceLike {
            currency_code: Some("USD".into()),
            discount_price: Some(1999.0),
            original_price: Some(2999.0),
            payout_currency_exchange_rate: None,
        };
        assert_eq!(to_usd_cents(&usd, PriceSource::Discount), Some(1999.0));
        assert_eq!(to_usd_cents(&usd, PriceSource::Original), Some(2999.0));

        let eur = PriceLike {
            currency_code: Some("EUR".into()),
            discount_price: Some(1000.0),
            original_price: None,
            payout_currency_exchange_rate: Some(1.1),
        };
        assert_eq!(to_usd_cents(&eur, PriceSource::Discount), Some(1100.0));

        let gbp = PriceLike {
            currency_code: Some("GBP".into()),
            discount_price: Some(1234.0),
            original_price: None,
            payout_currency_exchange_rate: Some(1.2345),
        };
        assert_eq!(
            to_usd_cents(&gbp, PriceSource::Discount),
            Some((1234.0_f64 * 1.2345).round())
        );
    }

    #[test]
    fn to_usd_cents_rejects_missing_or_invalid_inputs() {
        assert_eq!(
            to_usd_cents(
                &PriceLike {
                    currency_code: Some("EUR".into()),
                    discount_price: Some(1000.0),
                    ..Default::default()
                },
                PriceSource::Discount
            ),
            None
        );

        assert_eq!(
            to_usd_cents(
                &PriceLike {
                    currency_code: Some("EUR".into()),
                    discount_price: Some(1000.0),
                    payout_currency_exchange_rate: Some(0.0),
                    ..Default::default()
                },
                PriceSource::Discount
            ),
            None
        );

        assert!(
            to_usd_cents(
                &PriceLike {
                    currency_code: Some("EUR".into()),
                    discount_price: Some(1000.0),
                    payout_currency_exchange_rate: Some(f64::NAN),
                    ..Default::default()
                },
                PriceSource::Discount
            )
            .unwrap()
            .is_nan()
        );

        assert_eq!(
            to_usd_cents(
                &PriceLike {
                    currency_code: Some("USD".into()),
                    discount_price: None,
                    ..Default::default()
                },
                PriceSource::Discount
            ),
            None
        );

        assert_eq!(
            to_usd_cents(
                &PriceLike {
                    currency_code: Some("USD".into()),
                    discount_price: Some(-1.0),
                    ..Default::default()
                },
                PriceSource::Discount
            ),
            None
        );

        assert_eq!(
            to_usd_cents(
                &PriceLike {
                    currency_code: Some("USD".into()),
                    discount_price: Some(f64::INFINITY),
                    ..Default::default()
                },
                PriceSource::Discount
            ),
            Some(f64::INFINITY)
        );
    }

    #[test]
    fn price_eligibility_checks_whitelist_blacklist_and_regions() {
        let blacklisted = PriceAvailability {
            countries_whitelist: None,
            countries_blacklist: Some(vec!["cn".into(), "RU".into(), "BY".into()]),
        };
        assert!(!is_price_country_eligible(&blacklisted, "CN"));
        assert!(is_price_country_eligible(&blacklisted, "us"));
        assert!(!is_price_region_eligible(&blacklisted, "CN2"));
        assert!(!is_price_region_eligible(&blacklisted, "RU"));
        assert!(is_price_region_eligible(&blacklisted, "US"));
        assert!(!is_price_region_eligible(&blacklisted, "NO_SUCH_REGION"));

        let euro_es_only = PriceAvailability {
            countries_whitelist: Some(vec!["es".into()]),
            countries_blacklist: None,
        };
        assert!(is_price_country_eligible(&euro_es_only, "ES"));
        assert!(!is_price_country_eligible(&euro_es_only, "DE"));
        assert!(is_price_region_eligible(&euro_es_only, "EURO"));
        assert!(!is_price_region_eligible(&euro_es_only, "US"));
    }

    #[test]
    fn price_availability_key_normalizes_and_sorts() {
        let a = PriceAvailability {
            countries_whitelist: Some(vec!["us".into(), "ca".into()]),
            countries_blacklist: Some(vec!["ru".into(), "cn".into()]),
        };
        assert_eq!(price_availability_key(&a), r#"[["CA","US"],["CN","RU"]]"#);
        assert_eq!(
            price_availability_key(&PriceAvailability::default()),
            "[[],[]]"
        );
    }

    #[test]
    fn currency_precision_matches_iso_rules() {
        assert_eq!(currency_precision(None), 2);
        assert_eq!(currency_precision(Some("")), 2);
        assert_eq!(currency_precision(Some("usd")), 2);
        assert_eq!(currency_precision(Some("EUR")), 2);
        assert_eq!(currency_precision(Some("jpy")), 0);
        assert_eq!(currency_precision(Some("KRW")), 0);
        assert_eq!(currency_precision(Some("CLP")), 0);
        assert_eq!(currency_precision(Some("kwd")), 3);
        assert_eq!(currency_precision(Some("BHD")), 3);
    }

    #[test]
    fn pricing_types_roundtrip_json() {
        let price: PriceLike = serde_json::from_str(
            r#"{"currencyCode":"USD","discountPrice":100,"originalPrice":200,"payoutCurrencyExchangeRate":1.0}"#,
        )
        .unwrap();
        let src: PriceSource = serde_json::from_str(r#""original""#).unwrap();
        assert_eq!(to_usd_cents(&price, src), Some(200.0));

        let avail: PriceAvailability =
            serde_json::from_str(r#"{"countriesWhitelist":["US"],"countriesBlacklist":["CN"]}"#)
                .unwrap();
        assert!(is_price_country_eligible(&avail, "US"));
        assert!(!is_price_country_eligible(&avail, "CN"));
    }
}
