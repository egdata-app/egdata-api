//! Country codes, Epic pricing regions, country-to-region resolution, and age-rating mappings.

use serde::Serialize;

/// Metadata for an Epic Games Store pricing region.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionInfo {
    pub currency_code: &'static str,
    pub description: &'static str,
    pub countries: &'static [&'static str],
}

/// All 251 ISO-3166-1 alpha-2 country codes recognized by the Epic Games Store API.
pub const COUNTRIES: &[&str] = &[
    "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AN", "AO", "AQ", "AR", "AS", "AT", "AU", "AW", "AX",
    "AZ", "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BL", "BM", "BN", "BO", "BQ", "BR",
    "BS", "BT", "BV", "BW", "BY", "BZ", "CA", "CC", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM",
    "CN", "CO", "CR", "CU", "CV", "CW", "CX", "CY", "CZ", "DE", "DJ", "DK", "DM", "DO", "DZ", "EC",
    "EE", "EG", "EH", "ER", "ES", "ET", "FI", "FJ", "FK", "FM", "FO", "FR", "GA", "GB", "GD", "GE",
    "GF", "GG", "GH", "GI", "GL", "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GU", "GW", "GY", "HK",
    "HM", "HN", "HR", "HT", "HU", "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IR", "IS", "IT", "JE",
    "JM", "JO", "JP", "KE", "KG", "KH", "KI", "KM", "KN", "KP", "KR", "KW", "KY", "KZ", "LA", "LB",
    "LC", "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY", "MA", "MC", "MD", "ME", "MF", "MG", "MH",
    "MK", "ML", "MM", "MN", "MO", "MP", "MQ", "MR", "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ",
    "NA", "NC", "NE", "NF", "NG", "NI", "NL", "NO", "NP", "NR", "NU", "NZ", "OM", "PA", "PE", "PF",
    "PG", "PH", "PK", "PL", "PM", "PN", "PR", "PS", "PT", "PW", "PY", "QA", "RE", "RO", "RS", "RU",
    "RW", "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM", "SN", "SO", "SR",
    "SS", "ST", "SV", "SX", "SY", "SZ", "TC", "TD", "TF", "TG", "TH", "TJ", "TK", "TL", "TM", "TN",
    "TO", "TR", "TT", "TV", "TW", "TZ", "UA", "UG", "UM", "US", "UY", "UZ", "VA", "VC", "VE", "VG",
    "VI", "VN", "VU", "WF", "WS", "XK", "YE", "YT", "ZA", "ZM", "ZW",
];

/// All 52 Epic pricing regions in canonical key order.
pub const REGIONS: &[(&str, RegionInfo)] = &[
    (
        "AE",
        RegionInfo {
            currency_code: "AED",
            description: "United Arab Emirates",
            countries: &["AE"],
        },
    ),
    (
        "AFRICA",
        RegionInfo {
            currency_code: "USD",
            description: "Africa",
            countries: &[
                "LR", "TZ", "DJ", "LS", "YE", "UG", "MA", "DZ", "MG", "ML", "EH", "MR", "MU", "MW",
                "MZ", "ER", "AO", "ET", "NA", "ZM", "NE", "NG", "ZW", "BF", "RW", "BI", "BJ", "SC",
                "SD", "BW", "SL", "KE", "GA", "SN", "SO", "SS", "CD", "ST", "GH", "KM", "CF", "CG",
                "CI", "GM", "SZ", "GN", "GQ", "CM", "GW", "TD", "TG", "CV", "TN",
            ],
        },
    ),
    (
        "ANZ",
        RegionInfo {
            currency_code: "USD",
            description: "Oceania",
            countries: &[
                "CC", "TV", "MP", "NR", "FJ", "HM", "FM", "NU", "PW", "CK", "GU", "SB", "WF", "CX",
                "PG", "TK", "NF", "MH", "TO", "WS", "KI", "PN", "VU",
            ],
        },
    ),
    (
        "AR",
        RegionInfo {
            currency_code: "USD",
            description: "Argentina",
            countries: &["AR"],
        },
    ),
    (
        "AU",
        RegionInfo {
            currency_code: "AUD",
            description: "Australia",
            countries: &["AU"],
        },
    ),
    (
        "BG",
        RegionInfo {
            currency_code: "BGN",
            description: "Bulgaria",
            countries: &["BG"],
        },
    ),
    (
        "BR2",
        RegionInfo {
            currency_code: "BRL",
            description: "Brazil",
            countries: &["BR"],
        },
    ),
    (
        "CA",
        RegionInfo {
            currency_code: "CAD",
            description: "Canada",
            countries: &["CA"],
        },
    ),
    (
        "CH",
        RegionInfo {
            currency_code: "CHF",
            description: "Switzerland",
            countries: &["CH", "LI"],
        },
    ),
    (
        "CIS",
        RegionInfo {
            currency_code: "USD",
            description: "CIS",
            countries: &["UZ", "TJ", "MD", "TM", "AZ", "KG", "AM", "GE"],
        },
    ),
    (
        "CL2",
        RegionInfo {
            currency_code: "CLP",
            description: "Chile",
            countries: &["CL"],
        },
    ),
    (
        "CN2",
        RegionInfo {
            currency_code: "CNY",
            description: "China",
            countries: &["CN"],
        },
    ),
    (
        "CO2",
        RegionInfo {
            currency_code: "COP",
            description: "Colombia",
            countries: &["CO"],
        },
    ),
    (
        "CR2",
        RegionInfo {
            currency_code: "CRC",
            description: "Costa Rica",
            countries: &["CR"],
        },
    ),
    (
        "CZ",
        RegionInfo {
            currency_code: "CZK",
            description: "Czechia",
            countries: &["CZ"],
        },
    ),
    (
        "DK",
        RegionInfo {
            currency_code: "DKK",
            description: "Denmark",
            countries: &["DK"],
        },
    ),
    (
        "EAST",
        RegionInfo {
            currency_code: "USD",
            description: "Middle East/Central Asia",
            countries: &[
                "MN", "EG", "PS", "JO", "AF", "SY", "IQ", "IR", "MV", "LY", "LB", "PK", "OM", "LK",
            ],
        },
    ),
    (
        "EURO",
        RegionInfo {
            currency_code: "EUR",
            description: "Europe",
            countries: &[
                "DE", "BE", "FI", "PT", "LT", "FO", "LU", "HR", "LV", "FR", "MC", "SI", "ME", "SK",
                "SM", "IE", "MK", "EE", "AD", "GL", "MT", "IS", "AL", "GR", "IT", "VA", "ES", "AT",
                "RE", "XK", "CY", "NL", "BA",
            ],
        },
    ),
    (
        "GB",
        RegionInfo {
            currency_code: "GBP",
            description: "United Kingdom",
            countries: &["GB", "GG", "GI", "IM", "JE"],
        },
    ),
    (
        "HK2",
        RegionInfo {
            currency_code: "HKD",
            description: "Hong Kong",
            countries: &["HK"],
        },
    ),
    (
        "HU",
        RegionInfo {
            currency_code: "HUF",
            description: "Hungary",
            countries: &["HU"],
        },
    ),
    (
        "ID2",
        RegionInfo {
            currency_code: "IDR",
            description: "Indonesia",
            countries: &["ID"],
        },
    ),
    (
        "IL",
        RegionInfo {
            currency_code: "ILS",
            description: "Israel",
            countries: &["IL"],
        },
    ),
    (
        "IN2",
        RegionInfo {
            currency_code: "INR",
            description: "India",
            countries: &["IN"],
        },
    ),
    (
        "JP",
        RegionInfo {
            currency_code: "JPY",
            description: "Japan",
            countries: &["JP"],
        },
    ),
    (
        "KR2",
        RegionInfo {
            currency_code: "KRW",
            description: "South Korea",
            countries: &["KR"],
        },
    ),
    (
        "KZ",
        RegionInfo {
            currency_code: "KZT",
            description: "Kazakhstan",
            countries: &["KZ"],
        },
    ),
    (
        "LATAM",
        RegionInfo {
            currency_code: "USD",
            description: "Latin America/Caribbean",
            countries: &[
                "TT", "BB", "PR", "JM", "FK", "HN", "PY", "DM", "DO", "BM", "HT", "BO", "BS", "SH",
                "BZ", "GD", "EC", "SR", "KN", "SV", "MS", "AG", "AI", "GT", "VC", "AN", "TC", "VE",
                "PA", "GY", "CU", "AW", "LC", "NI",
            ],
        },
    ),
    (
        "MIDEAST",
        RegionInfo {
            currency_code: "USD",
            description: "Bahrain/Kuwait",
            countries: &["BH", "KW"],
        },
    ),
    (
        "MX2",
        RegionInfo {
            currency_code: "MXN",
            description: "Mexico",
            countries: &["MX"],
        },
    ),
    (
        "MY2",
        RegionInfo {
            currency_code: "MYR",
            description: "Malaysia",
            countries: &["MY"],
        },
    ),
    (
        "NO",
        RegionInfo {
            currency_code: "NOK",
            description: "Norway",
            countries: &["NO"],
        },
    ),
    (
        "NZ",
        RegionInfo {
            currency_code: "NZD",
            description: "New Zealand",
            countries: &["NZ"],
        },
    ),
    (
        "PE2",
        RegionInfo {
            currency_code: "PEN",
            description: "Peru",
            countries: &["PE"],
        },
    ),
    (
        "PH2",
        RegionInfo {
            currency_code: "PHP",
            description: "Philippines",
            countries: &["PH"],
        },
    ),
    (
        "PL",
        RegionInfo {
            currency_code: "PLN",
            description: "Poland",
            countries: &["PL"],
        },
    ),
    (
        "QA",
        RegionInfo {
            currency_code: "QAR",
            description: "Qatar",
            countries: &["QA"],
        },
    ),
    (
        "RO",
        RegionInfo {
            currency_code: "RON",
            description: "Romania",
            countries: &["RO"],
        },
    ),
    (
        "ROW",
        RegionInfo {
            currency_code: "USD",
            description: "Rest of World",
            countries: &[
                "RS", "BL", "BQ", "BV", "SJ", "UM", "MF", "YT", "GF", "MQ", "KP", "SX", "IO", "GP",
                "GS", "KY", "AQ", "VG", "AS", "TF", "VI", "CW", "NC", "PF", "AX", "PM",
            ],
        },
    ),
    (
        "RU",
        RegionInfo {
            currency_code: "RUB",
            description: "Russia",
            countries: &["RU", "BY"],
        },
    ),
    (
        "SA",
        RegionInfo {
            currency_code: "SAR",
            description: "Saudi Arabia",
            countries: &["SA"],
        },
    ),
    (
        "SE",
        RegionInfo {
            currency_code: "SEK",
            description: "Sweden",
            countries: &["SE"],
        },
    ),
    (
        "SEA",
        RegionInfo {
            currency_code: "USD",
            description: "Southeast Asia",
            countries: &["MM", "MO", "NP", "BD", "BT", "LA", "TL", "BN", "KH"],
        },
    ),
    (
        "SG2",
        RegionInfo {
            currency_code: "SGD",
            description: "Singapore",
            countries: &["SG"],
        },
    ),
    (
        "TH2",
        RegionInfo {
            currency_code: "THB",
            description: "Thailand",
            countries: &["TH"],
        },
    ),
    (
        "TR",
        RegionInfo {
            currency_code: "TRY",
            description: "Turkey",
            countries: &["TR"],
        },
    ),
    (
        "TW2",
        RegionInfo {
            currency_code: "TWD",
            description: "Taiwan",
            countries: &["TW"],
        },
    ),
    (
        "UA",
        RegionInfo {
            currency_code: "UAH",
            description: "Ukraine",
            countries: &["UA"],
        },
    ),
    (
        "US",
        RegionInfo {
            currency_code: "USD",
            description: "United States",
            countries: &["US"],
        },
    ),
    (
        "UY2",
        RegionInfo {
            currency_code: "UYU",
            description: "Uruguay",
            countries: &["UY"],
        },
    ),
    (
        "VN2",
        RegionInfo {
            currency_code: "VND",
            description: "Vietnam",
            countries: &["VN"],
        },
    ),
    (
        "ZA2",
        RegionInfo {
            currency_code: "ZAR",
            description: "South Africa",
            countries: &["ZA"],
        },
    ),
];

/// Age rating systems mapped to their applicable country codes.
pub const AGE_RATINGS_COUNTRIES: &[(&str, &[&str])] = &[
    ("ESRB", &["US", "CA", "MX"]),
    (
        "PEGI",
        &[
            "AD", "AL", "AT", "BE", "BG", "CY", "CZ", "DK", "EE", "ES", "FI", "FR", "GB", "GR",
            "HU", "IE", "IS", "IT", "LT", "LU", "LV", "MT", "NL", "NO", "PL", "PT", "RO", "SE",
            "SI", "SK", "CH", "IL",
        ],
    ),
    ("USK", &["DE"]),
    ("CERO", &["JP"]),
    ("ACB", &["AU"]),
    ("ClassInd", &["BR"]),
    ("GRAC", &["KR"]),
    ("RTC", &["MX"]),
    ("NMC", &["AE"]),
    ("FVLB", &["NZ"]),
    ("MDA", &["SG"]),
    ("FPB", &["ZA"]),
];

/// Look up an Epic pricing region by its region code (e.g. `"EURO"`, `"US"`).
pub fn get_region(region: &str) -> Option<&'static RegionInfo> {
    REGIONS
        .iter()
        .find(|(key, _)| *key == region)
        .map(|(_, info)| info)
}

/// Resolve an Epic country code (e.g. `"US"`, `"FR"`, `"AR"`) to the pricing region key,
/// falling back to `fallback` (typically `"US"`) for missing or unknown input.
pub fn country_to_region<'a>(country: Option<&str>, fallback: &'a str) -> &'a str {
    let Some(code) = country.filter(|value| !value.is_empty()) else {
        return fallback;
    };

    REGIONS
        .iter()
        .find(|(_, info)| info.countries.contains(&code))
        .map(|(key, _)| *key)
        .unwrap_or(fallback)
}

/// Look up the country codes associated with an age rating system (e.g. `"ESRB"`, `"PEGI"`).
pub fn age_ratings_countries(system: &str) -> Option<&'static [&'static str]> {
    AGE_RATINGS_COUNTRIES
        .iter()
        .find(|(key, _)| *key == system)
        .map(|(_, countries)| *countries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn countries_and_regions_have_expected_cardinality() {
        assert_eq!(COUNTRIES.len(), 251);
        assert_eq!(REGIONS.len(), 52);
        assert_eq!(AGE_RATINGS_COUNTRIES.len(), 12);

        let all_countries: HashSet<&str> = COUNTRIES.iter().copied().collect();
        assert_eq!(all_countries.len(), 251);

        let region_countries: HashSet<&str> = REGIONS
            .iter()
            .flat_map(|(_, info)| info.countries.iter().copied())
            .collect();
        assert_eq!(region_countries, all_countries);
    }

    #[test]
    fn country_to_region_maps_known_countries() {
        assert_eq!(country_to_region(Some("US"), "US"), "US");
        assert_eq!(country_to_region(Some("FR"), "US"), "EURO");
        assert_eq!(country_to_region(Some("DE"), "US"), "EURO");
        assert_eq!(country_to_region(Some("ES"), "US"), "EURO");
        assert_eq!(country_to_region(Some("IT"), "US"), "EURO");
        assert_eq!(country_to_region(Some("AR"), "US"), "AR");
        assert_eq!(country_to_region(Some("AE"), "US"), "AE");
        assert_eq!(country_to_region(Some("NG"), "US"), "AFRICA");
        assert_eq!(country_to_region(Some("BR"), "US"), "BR2");
    }

    #[test]
    fn country_to_region_uses_fallback_for_missing_or_unknown() {
        assert_eq!(country_to_region(Some("ZZ"), "US"), "US");
        assert_eq!(country_to_region(Some("XX"), "US"), "US");
        assert_eq!(country_to_region(None, "US"), "US");
        assert_eq!(country_to_region(Some(""), "US"), "US");
        assert_eq!(country_to_region(Some("ZZ"), "EURO"), "EURO");
        assert_eq!(country_to_region(None, "EURO"), "EURO");
    }

    #[test]
    fn get_region_and_age_ratings_lookup() {
        let euro = get_region("EURO").expect("EURO exists");
        assert_eq!(euro.currency_code, "EUR");
        assert_eq!(euro.description, "Europe");
        assert!(euro.countries.contains(&"ES"));
        assert!(get_region("UNKNOWN").is_none());

        assert_eq!(age_ratings_countries("ESRB"), Some(&["US", "CA", "MX"][..]));
        assert_eq!(age_ratings_countries("USK"), Some(&["DE"][..]));
        assert!(age_ratings_countries("UNKNOWN").is_none());
    }
}
