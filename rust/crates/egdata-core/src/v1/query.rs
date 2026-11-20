//! Strict `/v1` query parsing, regional normalization, and Search v2 input validation.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;
use unic_langid::LanguageIdentifier;
use url::form_urlencoded;

use super::errors::{
    ProblemError, ProblemIssue, ValidationIssue, bad_request, issues_to_problem_issues,
    unsupported_media_type,
};

/// JavaScript `Number.MIN_SAFE_INTEGER`.
pub const MIN_SAFE_INTEGER: i64 = -9_007_199_254_740_991;
/// JavaScript `Number.MAX_SAFE_INTEGER`.
pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// ISO 3166-1 alpha-2 country codes supported by the pricing API.
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

/// Epic Games Store pricing region metadata.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RegionDefinition {
    pub code: &'static str,
    pub currency_code: &'static str,
    pub description: &'static str,
    pub countries: &'static [&'static str],
}

/// Complete list of Epic Games Store pricing regions and their member countries.
pub const REGIONS: &[RegionDefinition] = &[
    RegionDefinition {
        code: "AE",
        currency_code: "AED",
        description: "United Arab Emirates",
        countries: &["AE"],
    },
    RegionDefinition {
        code: "AFRICA",
        currency_code: "USD",
        description: "Africa",
        countries: &[
            "LR", "TZ", "DJ", "LS", "YE", "UG", "MA", "DZ", "MG", "ML", "EH", "MR", "MU", "MW",
            "MZ", "ER", "AO", "ET", "NA", "ZM", "NE", "NG", "ZW", "BF", "RW", "BI", "BJ", "SC",
            "SD", "BW", "SL", "KE", "GA", "SN", "SO", "SS", "CD", "ST", "GH", "KM", "CF", "CG",
            "CI", "GM", "SZ", "GN", "GQ", "CM", "GW", "TD", "TG", "CV", "TN",
        ],
    },
    RegionDefinition {
        code: "ANZ",
        currency_code: "USD",
        description: "Oceania",
        countries: &[
            "CC", "TV", "MP", "NR", "FJ", "HM", "FM", "NU", "PW", "CK", "GU", "SB", "WF", "CX",
            "PG", "TK", "NF", "MH", "TO", "WS", "KI", "PN", "VU",
        ],
    },
    RegionDefinition {
        code: "AR",
        currency_code: "USD",
        description: "Argentina",
        countries: &["AR"],
    },
    RegionDefinition {
        code: "AU",
        currency_code: "AUD",
        description: "Australia",
        countries: &["AU"],
    },
    RegionDefinition {
        code: "BG",
        currency_code: "BGN",
        description: "Bulgaria",
        countries: &["BG"],
    },
    RegionDefinition {
        code: "BR2",
        currency_code: "BRL",
        description: "Brazil",
        countries: &["BR"],
    },
    RegionDefinition {
        code: "CA",
        currency_code: "CAD",
        description: "Canada",
        countries: &["CA"],
    },
    RegionDefinition {
        code: "CH",
        currency_code: "CHF",
        description: "Switzerland",
        countries: &["CH", "LI"],
    },
    RegionDefinition {
        code: "CIS",
        currency_code: "USD",
        description: "CIS",
        countries: &["UZ", "TJ", "MD", "TM", "AZ", "KG", "AM", "GE"],
    },
    RegionDefinition {
        code: "CL2",
        currency_code: "CLP",
        description: "Chile",
        countries: &["CL"],
    },
    RegionDefinition {
        code: "CN2",
        currency_code: "CNY",
        description: "China",
        countries: &["CN"],
    },
    RegionDefinition {
        code: "CO2",
        currency_code: "COP",
        description: "Colombia",
        countries: &["CO"],
    },
    RegionDefinition {
        code: "CR2",
        currency_code: "CRC",
        description: "Costa Rica",
        countries: &["CR"],
    },
    RegionDefinition {
        code: "CZ",
        currency_code: "CZK",
        description: "Czechia",
        countries: &["CZ"],
    },
    RegionDefinition {
        code: "DK",
        currency_code: "DKK",
        description: "Denmark",
        countries: &["DK"],
    },
    RegionDefinition {
        code: "EAST",
        currency_code: "USD",
        description: "Middle East/Central Asia",
        countries: &[
            "MN", "EG", "PS", "JO", "AF", "SY", "IQ", "IR", "MV", "LY", "LB", "PK", "OM", "LK",
        ],
    },
    RegionDefinition {
        code: "EURO",
        currency_code: "EUR",
        description: "Europe",
        countries: &[
            "DE", "BE", "FI", "PT", "LT", "FO", "LU", "HR", "LV", "FR", "MC", "SI", "ME", "SK",
            "SM", "IE", "MK", "EE", "AD", "GL", "MT", "IS", "AL", "GR", "IT", "VA", "ES", "AT",
            "RE", "XK", "CY", "NL", "BA",
        ],
    },
    RegionDefinition {
        code: "GB",
        currency_code: "GBP",
        description: "United Kingdom",
        countries: &["GB", "GG", "GI", "IM", "JE"],
    },
    RegionDefinition {
        code: "HK2",
        currency_code: "HKD",
        description: "Hong Kong",
        countries: &["HK"],
    },
    RegionDefinition {
        code: "HU",
        currency_code: "HUF",
        description: "Hungary",
        countries: &["HU"],
    },
    RegionDefinition {
        code: "ID2",
        currency_code: "IDR",
        description: "Indonesia",
        countries: &["ID"],
    },
    RegionDefinition {
        code: "IL",
        currency_code: "ILS",
        description: "Israel",
        countries: &["IL"],
    },
    RegionDefinition {
        code: "IN2",
        currency_code: "INR",
        description: "India",
        countries: &["IN"],
    },
    RegionDefinition {
        code: "JP",
        currency_code: "JPY",
        description: "Japan",
        countries: &["JP"],
    },
    RegionDefinition {
        code: "KR2",
        currency_code: "KRW",
        description: "South Korea",
        countries: &["KR"],
    },
    RegionDefinition {
        code: "KZ",
        currency_code: "KZT",
        description: "Kazakhstan",
        countries: &["KZ"],
    },
    RegionDefinition {
        code: "LATAM",
        currency_code: "USD",
        description: "Latin America/Caribbean",
        countries: &[
            "TT", "BB", "PR", "JM", "FK", "HN", "PY", "DM", "DO", "BM", "HT", "BO", "BS", "SH",
            "BZ", "GD", "EC", "SR", "KN", "SV", "MS", "AG", "AI", "GT", "VC", "AN", "TC", "VE",
            "PA", "GY", "CU", "AW", "LC", "NI",
        ],
    },
    RegionDefinition {
        code: "MIDEAST",
        currency_code: "USD",
        description: "Bahrain/Kuwait",
        countries: &["BH", "KW"],
    },
    RegionDefinition {
        code: "MX2",
        currency_code: "MXN",
        description: "Mexico",
        countries: &["MX"],
    },
    RegionDefinition {
        code: "MY2",
        currency_code: "MYR",
        description: "Malaysia",
        countries: &["MY"],
    },
    RegionDefinition {
        code: "NO",
        currency_code: "NOK",
        description: "Norway",
        countries: &["NO"],
    },
    RegionDefinition {
        code: "NZ",
        currency_code: "NZD",
        description: "New Zealand",
        countries: &["NZ"],
    },
    RegionDefinition {
        code: "PE2",
        currency_code: "PEN",
        description: "Peru",
        countries: &["PE"],
    },
    RegionDefinition {
        code: "PH2",
        currency_code: "PHP",
        description: "Philippines",
        countries: &["PH"],
    },
    RegionDefinition {
        code: "PL",
        currency_code: "PLN",
        description: "Poland",
        countries: &["PL"],
    },
    RegionDefinition {
        code: "QA",
        currency_code: "QAR",
        description: "Qatar",
        countries: &["QA"],
    },
    RegionDefinition {
        code: "RO",
        currency_code: "RON",
        description: "Romania",
        countries: &["RO"],
    },
    RegionDefinition {
        code: "ROW",
        currency_code: "USD",
        description: "Rest of World",
        countries: &[
            "RS", "BL", "BQ", "BV", "SJ", "UM", "MF", "YT", "GF", "MQ", "KP", "SX", "IO", "GP",
            "GS", "KY", "AQ", "VG", "AS", "TF", "VI", "CW", "NC", "PF", "AX", "PM",
        ],
    },
    RegionDefinition {
        code: "RU",
        currency_code: "RUB",
        description: "Russia",
        countries: &["RU", "BY"],
    },
    RegionDefinition {
        code: "SA",
        currency_code: "SAR",
        description: "Saudi Arabia",
        countries: &["SA"],
    },
    RegionDefinition {
        code: "SE",
        currency_code: "SEK",
        description: "Sweden",
        countries: &["SE"],
    },
    RegionDefinition {
        code: "SEA",
        currency_code: "USD",
        description: "Southeast Asia",
        countries: &["MM", "MO", "NP", "BD", "BT", "LA", "TL", "BN", "KH"],
    },
    RegionDefinition {
        code: "SG2",
        currency_code: "SGD",
        description: "Singapore",
        countries: &["SG"],
    },
    RegionDefinition {
        code: "TH2",
        currency_code: "THB",
        description: "Thailand",
        countries: &["TH"],
    },
    RegionDefinition {
        code: "TR",
        currency_code: "TRY",
        description: "Turkey",
        countries: &["TR"],
    },
    RegionDefinition {
        code: "TW2",
        currency_code: "TWD",
        description: "Taiwan",
        countries: &["TW"],
    },
    RegionDefinition {
        code: "UA",
        currency_code: "UAH",
        description: "Ukraine",
        countries: &["UA"],
    },
    RegionDefinition {
        code: "US",
        currency_code: "USD",
        description: "United States",
        countries: &["US"],
    },
    RegionDefinition {
        code: "UY2",
        currency_code: "UYU",
        description: "Uruguay",
        countries: &["UY"],
    },
    RegionDefinition {
        code: "VN2",
        currency_code: "VND",
        description: "Vietnam",
        countries: &["VN"],
    },
    RegionDefinition {
        code: "ZA2",
        currency_code: "ZAR",
        description: "South Africa",
        countries: &["ZA"],
    },
];

fn locale_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$").expect("valid regex"))
}

fn integer_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^-?\d+$").expect("valid regex"))
}

/// Normalizes and validates an ISO 3166-1 alpha-2 country code (defaulting to `"US"`).
pub fn canonical_country(raw: Option<&str>) -> Result<String, ProblemError> {
    let country = trim_js_whitespace(raw.unwrap_or("US")).to_uppercase();
    let is_two_upper = country.len() == 2 && country.bytes().all(|b| b.is_ascii_uppercase());
    if !is_two_upper || !COUNTRIES.contains(&country.as_str()) {
        let display = raw.unwrap_or("");
        return Err(bad_request(
            "INVALID_COUNTRY",
            format!(
                "Unknown country code '{display}'. Use an ISO 3166-1 alpha-2 code such as US or GB."
            ),
            None,
        ));
    }
    Ok(country)
}

/// Resolves the Epic pricing region code for a canonical country code.
pub fn region_for_country(country: &str) -> Option<&'static str> {
    REGIONS
        .iter()
        .find(|region| region.countries.contains(&country))
        .map(|region| region.code)
}

/// Resolved country and pricing region pair.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CountryAndRegion {
    pub country: String,
    pub region: String,
}

fn resolve_country_region(
    country: String,
    region: Option<&'static str>,
) -> Result<CountryAndRegion, ProblemError> {
    let region = region.ok_or_else(|| {
        bad_request(
            "INVALID_COUNTRY",
            format!("Country '{country}' is not mapped to an Epic pricing region."),
            None,
        )
    })?;
    Ok(CountryAndRegion {
        country,
        region: region.to_string(),
    })
}

/// Validates a country parameter and resolves its Epic pricing region.
pub fn country_and_region(raw: Option<&str>) -> Result<CountryAndRegion, ProblemError> {
    let country = canonical_country(raw)?;
    let region = region_for_country(&country);
    resolve_country_region(country, region)
}

/// Normalizes and validates a BCP 47 locale tag (defaulting to `"en-US"`).
pub fn canonical_locale(raw: Option<&str>) -> Result<String, ProblemError> {
    let value = trim_js_whitespace(raw.unwrap_or("en-US"));
    if !locale_regex().is_match(value) {
        let display = raw.unwrap_or("");
        return Err(bad_request(
            "INVALID_LOCALE",
            format!("Invalid locale '{display}'. Use a BCP 47 tag such as en-US or pt-BR."),
            None,
        ));
    }
    let parsed: LanguageIdentifier = value.parse().map_err(|_| {
        let display = raw.unwrap_or("");
        bad_request(
            "INVALID_LOCALE",
            format!("Invalid locale '{display}'. Use a BCP 47 tag such as en-US or pt-BR."),
            None,
        )
    })?;
    Ok(parsed.to_string())
}

/// Resolved regional parameters (`country`, `region`, `locale`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegionalParams {
    pub country: String,
    pub region: String,
    pub locale: String,
}

/// Resolves `country`, `region`, and `locale` query parameters together.
pub fn regional_params(
    country: Option<&str>,
    locale: Option<&str>,
) -> Result<RegionalParams, ProblemError> {
    let cr = country_and_region(country)?;
    let locale = canonical_locale(locale)?;
    Ok(RegionalParams {
        country: cr.country,
        region: cr.region,
        locale,
    })
}

/// Validates query keys strictly against `allowed_keys`, returning `INVALID_QUERY` on unknown keys.
pub fn parse_strict_query<'a, I>(
    query: I,
    allowed_keys: &[&str],
) -> Result<BTreeMap<String, String>, ProblemError>
where
    I: IntoIterator<Item = (&'a str, &'a str)>,
{
    let mut result = BTreeMap::new();
    let mut unrecognized = Vec::new();
    for (key, value) in query {
        if allowed_keys.contains(&key) {
            result.insert(key.to_string(), value.to_string());
        } else {
            unrecognized.push(ValidationIssue {
                path: vec![key.to_string()],
                message: format!("Unrecognized query parameter: `{key}`."),
                code: Some("unrecognized_keys".into()),
            });
        }
    }
    if !unrecognized.is_empty() {
        return Err(ProblemError::new(
            400,
            "INVALID_QUERY",
            "One or more query parameters are invalid or not supported.",
        )
        .with_errors(issues_to_problem_issues(&unrecognized)));
    }
    Ok(result)
}

/// Parses an optional query boolean (`true`, `1`, `false`, `0`).
pub fn parse_boolean(value: Option<&str>, name: &str) -> Result<Option<bool>, ProblemError> {
    let Some(raw) = value.filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    match raw.trim().to_ascii_lowercase().as_str() {
        "true" | "1" => Ok(Some(true)),
        "false" | "0" => Ok(Some(false)),
        _ => Err(bad_request(
            "INVALID_QUERY",
            format!("The `{name}` parameter must be true or false."),
            Some(vec![ProblemIssue {
                pointer: None,
                parameter: Some(name.to_string()),
                code: "INVALID".to_string(),
                message: "Expected a boolean.".to_string(),
            }]),
        )),
    }
}

/// Parses an optional integer query parameter within `[min, max]` (defaulting to JS safe integer bounds).
pub fn parse_integer(
    value: Option<&str>,
    name: &str,
    min: Option<i64>,
    max: Option<i64>,
) -> Result<Option<i64>, ProblemError> {
    let Some(raw) = value.filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if !integer_regex().is_match(trimmed) {
        return Err(bad_request(
            "INVALID_QUERY",
            format!("The `{name}` parameter must be an integer."),
            Some(vec![ProblemIssue {
                pointer: None,
                parameter: Some(name.to_string()),
                code: "INVALID".to_string(),
                message: "Expected an integer.".to_string(),
            }]),
        ));
    }
    let min_val = min.unwrap_or(MIN_SAFE_INTEGER);
    let max_val = max.unwrap_or(MAX_SAFE_INTEGER);
    let parsed = trimmed.parse::<i64>().ok().filter(|&v| {
        (MIN_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&v) && v >= min_val && v <= max_val
    });
    match parsed {
        Some(v) => Ok(Some(v)),
        None => Err(bad_request(
            "INVALID_QUERY",
            format!("The `{name}` parameter must be between {min_val} and {max_val}."),
            Some(vec![ProblemIssue {
                pointer: None,
                parameter: Some(name.to_string()),
                code: "INVALID".to_string(),
                message: "Out of range.".to_string(),
            }]),
        )),
    }
}

/// Parses a comma-separated string into sorted, deduplicated non-empty entries.
pub fn parse_csv(value: Option<&str>) -> Option<Vec<String>> {
    let raw = value?;
    if raw.trim().is_empty() {
        return None;
    }
    let set: BTreeSet<String> = raw
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
        .collect();
    if set.is_empty() {
        None
    } else {
        let mut entries: Vec<_> = set.into_iter().collect();
        // JavaScript Array.sort compares UTF-16 code units, including astral characters.
        entries.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        Some(entries)
    }
}

/// Validates that a JSON `Content-Type` header is present.
pub fn require_json_content_type(content_type: Option<&str>) -> Result<(), ProblemError> {
    let Some(raw) = content_type.filter(|s| !s.trim().is_empty()) else {
        return Err(unsupported_media_type(
            "A JSON request body is required. Send Content-Type: application/json.",
        ));
    };
    let media_type = raw
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if media_type != "application/json" && !media_type.ends_with("+json") {
        return Err(unsupported_media_type(
            "This endpoint accepts application/json request bodies only.",
        ));
    }
    Ok(())
}

/// JavaScript String.trim includes BOM but excludes Unicode NEL (U+0085).
pub fn trim_js_whitespace(value: &str) -> &str {
    value.trim_matches(|ch| {
        matches!(ch,
            '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
            '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
            '\u{205f}' | '\u{3000}' | '\u{feff}'
        )
    })
}

/// Validates a path identifier parameter (`name`) is non-empty and at most 200 UTF-16 code units.
pub fn require_id_param(value: Option<&str>, name: &str) -> Result<String, ProblemError> {
    let trimmed = value.map(trim_js_whitespace).unwrap_or("");
    if trimmed.is_empty() {
        return Err(bad_request(
            "MISSING_PARAMETER",
            format!("The `{name}` path parameter is required."),
            None,
        ));
    }
    if trimmed.encode_utf16().count() > 200 {
        return Err(bad_request(
            "INVALID_PARAMETER",
            format!("The `{name}` path parameter is too long."),
            None,
        ));
    }
    Ok(trimmed.to_string())
}

/// Sort fields supported by Search v2.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchV2SortBy {
    ReleaseDate,
    LastModifiedDate,
    EffectiveDate,
    CreationDate,
    ViewableDate,
    PcReleaseDate,
    Upcoming,
    PriceAsc,
    PriceDesc,
    Price,
    Discount,
    DiscountPercent,
    PriceUpdatedAt,
    GiveawayDate,
}

impl SearchV2SortBy {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ReleaseDate => "releaseDate",
            Self::LastModifiedDate => "lastModifiedDate",
            Self::EffectiveDate => "effectiveDate",
            Self::CreationDate => "creationDate",
            Self::ViewableDate => "viewableDate",
            Self::PcReleaseDate => "pcReleaseDate",
            Self::Upcoming => "upcoming",
            Self::PriceAsc => "priceAsc",
            Self::PriceDesc => "priceDesc",
            Self::Price => "price",
            Self::Discount => "discount",
            Self::DiscountPercent => "discountPercent",
            Self::PriceUpdatedAt => "priceUpdatedAt",
            Self::GiveawayDate => "giveawayDate",
        }
    }
}

/// Sort direction supported by Search v2.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchV2SortDir {
    Asc,
    Desc,
}

impl SearchV2SortDir {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Asc => "asc",
            Self::Desc => "desc",
        }
    }
}

/// Facet detail level supported by Search v2.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchV2Facets {
    Full,
    Minimal,
    #[default]
    None,
}

impl SearchV2Facets {
    pub fn from_raw(raw: Option<&str>) -> Self {
        match raw {
            Some("full") => Self::Full,
            Some("minimal") => Self::Minimal,
            _ => Self::None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Minimal => "minimal",
            Self::None => "none",
        }
    }
}

/// Optional price range bounds for Search v2.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct SearchV2PriceRange {
    pub min: Option<f64>,
    pub max: Option<f64>,
}

fn default_limit() -> i64 {
    10
}

fn default_page() -> i64 {
    1
}

/// Search v2 request input matching `src/utils/search-v2-input.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchV2Input {
    pub title: Option<String>,
    pub offer_type: Option<String>,
    pub tags: Option<Vec<String>>,
    pub categories: Option<Vec<String>>,
    pub custom_attributes: Option<Vec<String>>,
    pub technologies: Option<Vec<String>>,
    pub seller: Option<String>,
    pub developer_display_name: Option<String>,
    pub publisher_display_name: Option<String>,
    pub refund_type: Option<String>,
    pub is_code_redemption_only: Option<bool>,
    pub exclude_blockchain: Option<bool>,
    pub on_sale: Option<bool>,
    pub past_giveaways: Option<bool>,
    pub is_lowest_price: Option<bool>,
    pub is_lowest_price_ever: Option<bool>,
    pub sort_by: Option<SearchV2SortBy>,
    pub sort_dir: Option<SearchV2SortDir>,
    #[serde(default = "default_limit")]
    pub limit: i64,
    #[serde(default = "default_page")]
    pub page: i64,
    pub price: Option<SearchV2PriceRange>,
    #[serde(default)]
    pub facets: SearchV2Facets,
}

impl Default for SearchV2Input {
    fn default() -> Self {
        Self {
            title: None,
            offer_type: None,
            tags: None,
            categories: None,
            custom_attributes: None,
            technologies: None,
            seller: None,
            developer_display_name: None,
            publisher_display_name: None,
            refund_type: None,
            is_code_redemption_only: None,
            exclude_blockchain: None,
            on_sale: None,
            past_giveaways: None,
            is_lowest_price: None,
            is_lowest_price_ever: None,
            sort_by: None,
            sort_dir: None,
            limit: 10,
            page: 1,
            price: None,
            facets: SearchV2Facets::None,
        }
    }
}

fn normalize_string_list(
    values: Option<Vec<String>>,
    field: &str,
) -> Result<Option<Vec<String>>, ProblemError> {
    let Some(list) = values else {
        return Ok(None);
    };
    let mut set = BTreeSet::new();
    for entry in list {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            return Err(bad_request(
                "INVALID_QUERY",
                format!("Each entry in `{field}` must be a non-empty string."),
                Some(vec![ProblemIssue {
                    pointer: Some(format!("/{field}")),
                    parameter: Some(field.to_string()),
                    code: "TOO_SMALL".to_string(),
                    message: "String must contain at least 1 character(s).".to_string(),
                }]),
            ));
        }
        set.insert(trimmed.to_string());
    }
    Ok(Some(set.into_iter().collect()))
}

fn trim_opt(value: Option<String>) -> Option<String> {
    value.map(|s| s.trim().to_string())
}

impl SearchV2Input {
    /// Trims strings, deduplicates/sorts array filters, and clamps `limit`/`page`.
    pub fn normalize(mut self) -> Result<Self, ProblemError> {
        self.title = trim_opt(self.title);
        self.offer_type = trim_opt(self.offer_type);
        self.tags = normalize_string_list(self.tags, "tags")?;
        self.categories = normalize_string_list(self.categories, "categories")?;
        self.custom_attributes = normalize_string_list(self.custom_attributes, "customAttributes")?;
        self.technologies = normalize_string_list(self.technologies, "technologies")?;
        self.seller = trim_opt(self.seller);
        self.developer_display_name = trim_opt(self.developer_display_name);
        self.publisher_display_name = trim_opt(self.publisher_display_name);
        self.refund_type = trim_opt(self.refund_type);
        self.limit = self.limit.clamp(1, 100);
        self.page = self.page.max(1);
        Ok(self)
    }

    /// Converts normalized Search v2 input into canonical URL query parameter pairs.
    pub fn to_query_params(&self) -> Vec<(String, String)> {
        let mut params = Vec::new();
        let push_str = |out: &mut Vec<(String, String)>, key: &str, val: &Option<String>| {
            if let Some(v) = val.as_deref().filter(|s| !s.is_empty()) {
                out.push((key.to_string(), v.to_string()));
            }
        };
        let push_arr = |out: &mut Vec<(String, String)>, key: &str, val: &Option<Vec<String>>| {
            if let Some(items) = val {
                if items.iter().any(|item| item.contains(',')) {
                    for item in items {
                        out.push((format!("{key}[]"), item.clone()));
                    }
                } else if !items.is_empty() {
                    out.push((key.to_string(), items.join(",")));
                }
            }
        };
        let push_bool = |out: &mut Vec<(String, String)>, key: &str, val: Option<bool>| {
            if let Some(flag) = val {
                out.push((
                    key.to_string(),
                    if flag { "true" } else { "false" }.to_string(),
                ));
            }
        };

        push_str(&mut params, "title", &self.title);
        push_str(&mut params, "offerType", &self.offer_type);
        push_arr(&mut params, "tags", &self.tags);
        push_arr(&mut params, "categories", &self.categories);
        push_arr(&mut params, "customAttributes", &self.custom_attributes);
        push_arr(&mut params, "technologies", &self.technologies);
        push_str(&mut params, "seller", &self.seller);
        push_str(
            &mut params,
            "developerDisplayName",
            &self.developer_display_name,
        );
        push_str(
            &mut params,
            "publisherDisplayName",
            &self.publisher_display_name,
        );
        push_str(&mut params, "refundType", &self.refund_type);
        push_bool(
            &mut params,
            "isCodeRedemptionOnly",
            self.is_code_redemption_only,
        );
        push_bool(&mut params, "excludeBlockchain", self.exclude_blockchain);
        push_bool(&mut params, "onSale", self.on_sale);
        push_bool(&mut params, "pastGiveaways", self.past_giveaways);
        push_bool(&mut params, "isLowestPrice", self.is_lowest_price);
        push_bool(&mut params, "isLowestPriceEver", self.is_lowest_price_ever);

        if let Some(sort_by) = self.sort_by {
            params.push(("sortBy".to_string(), sort_by.as_str().to_string()));
        }
        if let Some(sort_dir) = self.sort_dir
            && sort_dir != SearchV2SortDir::Desc
        {
            params.push(("sortDir".to_string(), sort_dir.as_str().to_string()));
        }
        if self.limit != 10 {
            params.push(("limit".to_string(), self.limit.to_string()));
        }
        if self.page != 1 {
            params.push(("page".to_string(), self.page.to_string()));
        }
        if let Some(ref price) = self.price {
            if let Some(min) = price.min {
                params.push(("priceMin".to_string(), format_js_number(min)));
            }
            if let Some(max) = price.max {
                params.push(("priceMax".to_string(), format_js_number(max)));
            }
        }
        if self.facets != SearchV2Facets::None {
            params.push(("facets".to_string(), self.facets.as_str().to_string()));
        }

        params
    }

    /// Encodes the normalized parameters into an `application/x-www-form-urlencoded` query string.
    pub fn to_query_string(&self) -> String {
        let mut ser = form_urlencoded::Serializer::new(String::new());
        for (k, v) in self.to_query_params() {
            ser.append_pair(&k, &v);
        }
        ser.finish()
    }
}

/// Decimal spelling used by JavaScript String(number) in search query parameters.
pub fn format_js_number(value: f64) -> String {
    ryu_js::Buffer::new().format(value).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_country_and_region_and_locale() {
        assert_eq!(canonical_country(None).unwrap(), "US");
        assert_eq!(canonical_country(Some(" gb ")).unwrap(), "GB");
        assert_eq!(
            canonical_country(Some("")).unwrap_err().code,
            "INVALID_COUNTRY"
        );
        assert_eq!(
            canonical_country(Some("ZZ")).unwrap_err().code,
            "INVALID_COUNTRY"
        );

        assert_eq!(region_for_country("DE"), Some("EURO"));
        assert_eq!(region_for_country("ZZ"), None);

        let cr = country_and_region(Some("fr")).unwrap();
        assert_eq!(cr.country, "FR");
        assert_eq!(cr.region, "EURO");
        assert_eq!(
            resolve_country_region("XX".into(), None).unwrap_err().code,
            "INVALID_COUNTRY"
        );
        assert_eq!(
            country_and_region(Some("ZZ")).unwrap_err().code,
            "INVALID_COUNTRY"
        );

        assert_eq!(canonical_locale(None).unwrap(), "en-US");
        assert_eq!(canonical_locale(Some("pt-br")).unwrap(), "pt-BR");
        assert_eq!(canonical_locale(Some("zh-hans-cn")).unwrap(), "zh-Hans-CN");
        assert_eq!(
            canonical_locale(Some("en_US")).unwrap_err().code,
            "INVALID_LOCALE"
        );
        // Valid regex shape but rejected by BCP 47 parser (2-digit region is invalid)
        assert_eq!(
            canonical_locale(Some("en-00")).unwrap_err().code,
            "INVALID_LOCALE"
        );

        let reg = regional_params(Some("es"), Some("es-es")).unwrap();
        assert_eq!(
            reg,
            RegionalParams {
                country: "ES".into(),
                region: "EURO".into(),
                locale: "es-ES".into()
            }
        );
        assert_eq!(
            regional_params(Some("ZZ"), None).unwrap_err().code,
            "INVALID_COUNTRY"
        );
        assert_eq!(
            regional_params(Some("US"), Some("bad_locale"))
                .unwrap_err()
                .code,
            "INVALID_LOCALE"
        );
    }

    #[test]
    fn test_strict_query_and_scalars() {
        let valid = vec![("limit", "10"), ("cursor", "abc")];
        let parsed = parse_strict_query(valid, &["limit", "cursor"]).unwrap();
        assert_eq!(parsed.get("limit").map(String::as_str), Some("10"));

        let invalid = vec![("limit", "10"), ("bogus", "1")];
        let err = parse_strict_query(invalid, &["limit", "cursor"]).unwrap_err();
        assert_eq!(err.code, "INVALID_QUERY");
        assert_eq!(
            err.errors.as_ref().unwrap()[0].parameter.as_deref(),
            Some("bogus")
        );

        assert_eq!(parse_boolean(None, "onSale").unwrap(), None);
        assert_eq!(parse_boolean(Some(""), "onSale").unwrap(), None);
        assert_eq!(parse_boolean(Some(" TRUE "), "onSale").unwrap(), Some(true));
        assert_eq!(parse_boolean(Some("1"), "onSale").unwrap(), Some(true));
        assert_eq!(parse_boolean(Some("false"), "onSale").unwrap(), Some(false));
        assert_eq!(parse_boolean(Some("0"), "onSale").unwrap(), Some(false));
        assert_eq!(
            parse_boolean(Some("yes"), "onSale").unwrap_err().code,
            "INVALID_QUERY"
        );

        assert_eq!(parse_integer(None, "price", None, None).unwrap(), None);
        assert_eq!(parse_integer(Some(""), "price", None, None).unwrap(), None);
        assert_eq!(
            parse_integer(Some(" -5 "), "price", Some(-10), Some(10)).unwrap(),
            Some(-5)
        );
        assert_eq!(
            parse_integer(Some("12.5"), "price", None, None)
                .unwrap_err()
                .code,
            "INVALID_QUERY"
        );
        assert_eq!(
            parse_integer(Some("11"), "price", Some(0), Some(10))
                .unwrap_err()
                .code,
            "INVALID_QUERY"
        );

        assert_eq!(parse_csv(None), None);
        assert_eq!(parse_csv(Some("   ")), None);
        assert_eq!(parse_csv(Some("  ,  ")), None);
        assert_eq!(
            parse_csv(Some(" b , a , b ")),
            Some(vec!["a".into(), "b".into()])
        );
        assert_eq!(
            parse_csv(Some("\u{e000},😀,😀")),
            Some(vec!["😀".into(), "\u{e000}".into()])
        );
    }

    #[test]
    fn test_content_type_and_id_param() {
        assert!(require_json_content_type(Some("application/json; charset=utf-8")).is_ok());
        assert!(require_json_content_type(Some("application/problem+json")).is_ok());
        assert_eq!(require_json_content_type(None).unwrap_err().status, 415);
        assert_eq!(
            require_json_content_type(Some("text/plain"))
                .unwrap_err()
                .status,
            415
        );

        assert_eq!(
            require_id_param(Some("  offer-1 "), "id").unwrap(),
            "offer-1"
        );
        assert_eq!(
            require_id_param(Some("  "), "id").unwrap_err().code,
            "MISSING_PARAMETER"
        );
        let too_long = "a".repeat(201);
        assert_eq!(
            require_id_param(Some(&too_long), "id").unwrap_err().code,
            "INVALID_PARAMETER"
        );
    }

    #[test]
    fn test_search_v2_input_and_query_params() {
        let input = SearchV2Input {
            title: Some("  Cyberpunk  ".into()),
            tags: Some(vec!["b".into(), "a".into(), "b".into()]),
            categories: Some(vec!["action,rpg".into(), "indie".into()]),
            custom_attributes: Some(vec![]),
            on_sale: Some(true),
            exclude_blockchain: Some(false),
            sort_by: Some(SearchV2SortBy::PriceAsc),
            sort_dir: Some(SearchV2SortDir::Asc),
            limit: 500,
            page: 0,
            price: Some(SearchV2PriceRange {
                min: Some(100.0),
                max: Some(19.99),
            }),
            facets: SearchV2Facets::from_raw(Some("minimal")),
            ..Default::default()
        }
        .normalize()
        .unwrap();

        assert_eq!(input.title.as_deref(), Some("Cyberpunk"));
        assert_eq!(input.tags, Some(vec!["a".into(), "b".into()]));
        assert_eq!(input.limit, 100);
        assert_eq!(input.page, 1);

        let params = input.to_query_params();
        assert_eq!(
            params,
            vec![
                ("title".into(), "Cyberpunk".into()),
                ("tags".into(), "a,b".into()),
                ("categories[]".into(), "action,rpg".into()),
                ("categories[]".into(), "indie".into()),
                ("excludeBlockchain".into(), "false".into()),
                ("onSale".into(), "true".into()),
                ("sortBy".into(), "priceAsc".into()),
                ("sortDir".into(), "asc".into()),
                ("limit".into(), "100".into()),
                ("priceMin".into(), "100".into()),
                ("priceMax".into(), "19.99".into()),
                ("facets".into(), "minimal".into()),
            ]
        );
        assert!(
            input
                .to_query_string()
                .contains("categories%5B%5D=action%2Crpg")
        );

        // Default values are omitted; serde defaults work
        let deserialized: SearchV2Input = serde_json::from_str("{}").unwrap();
        assert_eq!(deserialized.limit, 10);
        assert_eq!(deserialized.page, 1);

        let paged = SearchV2Input {
            page: 2,
            price: Some(SearchV2PriceRange {
                min: None,
                max: None,
            }),
            ..Default::default()
        };
        assert_eq!(paged.to_query_params(), vec![("page".into(), "2".into())]);

        let defaults = SearchV2Input {
            sort_dir: Some(SearchV2SortDir::Desc),
            facets: SearchV2Facets::from_raw(Some("anything-else")),
            ..Default::default()
        }
        .normalize()
        .unwrap();
        assert!(defaults.to_query_params().is_empty());

        assert_eq!(SearchV2Facets::from_raw(Some("none")), SearchV2Facets::None);
        assert_eq!(SearchV2Facets::from_raw(Some("full")), SearchV2Facets::Full);
        assert_eq!(SearchV2Facets::None.as_str(), "none");
        assert_eq!(SearchV2Facets::Full.as_str(), "full");
        assert_eq!(SearchV2SortDir::Desc.as_str(), "desc");

        // All sortBy variants map cleanly
        let all_sorts = [
            SearchV2SortBy::ReleaseDate,
            SearchV2SortBy::LastModifiedDate,
            SearchV2SortBy::EffectiveDate,
            SearchV2SortBy::CreationDate,
            SearchV2SortBy::ViewableDate,
            SearchV2SortBy::PcReleaseDate,
            SearchV2SortBy::Upcoming,
            SearchV2SortBy::PriceAsc,
            SearchV2SortBy::PriceDesc,
            SearchV2SortBy::Price,
            SearchV2SortBy::Discount,
            SearchV2SortBy::DiscountPercent,
            SearchV2SortBy::PriceUpdatedAt,
            SearchV2SortBy::GiveawayDate,
        ];
        assert_eq!(all_sorts.len(), 14);
        for s in all_sorts {
            assert!(!s.as_str().is_empty());
        }

        // Empty entries in array filters fail validation
        for bad_input in [
            SearchV2Input {
                tags: Some(vec!["  ".into()]),
                ..Default::default()
            },
            SearchV2Input {
                categories: Some(vec!["".into()]),
                ..Default::default()
            },
            SearchV2Input {
                custom_attributes: Some(vec!["".into()]),
                ..Default::default()
            },
            SearchV2Input {
                technologies: Some(vec!["".into()]),
                ..Default::default()
            },
        ] {
            assert_eq!(bad_input.normalize().unwrap_err().code, "INVALID_QUERY");
        }
    }
}
