//! Offer localization parsing, entity ID formatting, field overlay, and fallback cache TTL helpers.

use chrono::{DateTime, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::str::FromStr;
use std::sync::OnceLock;
use thiserror::Error;
use unic_langid::LanguageIdentifier;

/// Canonical Epic Games Store locale used as the base and fallback language.
pub const CANONICAL_LOCALE: &str = "en-US";

/// Maximum Redis cache TTL (in seconds) when any item in a response fell back to canonical text.
pub const FALLBACK_CACHE_TTL_SECONDS: u64 = 60;

/// Offer fields that may be overlaid from a localized EGS document.
pub const LOCALIZED_OFFER_FIELDS: &[&str] = &[
    "title",
    "description",
    "longDescription",
    "developerDisplayName",
    "publisherDisplayName",
    "seller",
    "tags",
    "offerMappings",
    "productSlug",
    "urlSlug",
    "url",
];

/// Error returned when a requested locale query parameter fails syntax or BCP-47 validation.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
#[error("Invalid locale parameter: {0}")]
pub struct InvalidLocaleError(pub String);

/// Localization resolution status attached to localized offer payloads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LocaleStatus {
    Canonical,
    Localized,
    Fallback,
}

/// Stored localization document from `egs_localizations`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EgsLocalization {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub mongo_id: Option<String>,
    pub entity_type: String,
    pub entity_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    pub locale: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    pub fetched_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_updated_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matches_canonical: Option<bool>,
}

/// Provenance metadata embedded on localized offers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalizationMetadata {
    pub source: String,
    pub fetched_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_updated_at: Option<DateTime<Utc>>,
}

/// Metadata attached to an offer after applying localization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalizedOfferMetadata {
    pub locale: String,
    pub locale_status: LocaleStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical_locale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub localization: Option<LocalizationMetadata>,
}

fn locale_regex() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$").expect("valid locale regex")
    })
}

/// Parse and canonicalize a requested locale string, defaulting blank/missing input to `en-US`.
pub fn parse_locale(value: Option<&str>) -> Result<String, InvalidLocaleError> {
    let requested = value.map(str::trim).unwrap_or("");
    if requested.is_empty() {
        return Ok(CANONICAL_LOCALE.to_string());
    }

    if !locale_regex().is_match(requested) {
        return Err(InvalidLocaleError(requested.to_string()));
    }

    let langid = LanguageIdentifier::from_str(requested)
        .map_err(|_| InvalidLocaleError(requested.to_string()))?;

    Ok(langid.to_string())
}

/// Compute the `namespace:id` entity identifier used to look up offer localizations.
pub fn get_offer_localization_entity_id(offer: &Value) -> Option<String> {
    let obj = offer.as_object()?;
    let id = obj.get("id")?.as_str().filter(|s| !s.is_empty())?;
    let namespace = obj.get("namespace")?.as_str().filter(|s| !s.is_empty())?;
    Some(format!("{namespace}:{id}"))
}

/// Overlay localized offer fields onto `canonical_offer` while preserving operational fields.
pub fn apply_offer_localization(
    canonical_offer: &Value,
    localization: Option<&EgsLocalization>,
    locale: &str,
) -> Value {
    let metadata = localization.map(|loc| {
        let meta = LocalizationMetadata {
            source: loc.source.clone(),
            fetched_at: loc.fetched_at,
            source_updated_at: loc.source_updated_at,
        };
        serde_json::to_value(meta).expect("LocalizationMetadata always serializes")
    });
    apply_offer_localization_fields(
        canonical_offer,
        locale,
        localization.and_then(|loc| loc.data.as_ref()),
        metadata,
    )
}

/// Project the stored localization fields and provenance in the source representation.
pub fn apply_offer_localization_fields(
    canonical_offer: &Value,
    locale: &str,
    data: Option<&Value>,
    metadata: Option<Value>,
) -> Value {
    let mut result: Map<String, Value> = canonical_offer.as_object().cloned().unwrap_or_default();

    if locale == CANONICAL_LOCALE {
        result.insert("locale".to_string(), Value::String(locale.to_string()));
        result.insert(
            "localeStatus".to_string(),
            Value::String("canonical".to_string()),
        );
        return Value::Object(result);
    }

    let Some(meta_value) = metadata else {
        result.insert("locale".to_string(), Value::String(locale.to_string()));
        result.insert(
            "localeStatus".to_string(),
            Value::String("fallback".to_string()),
        );
        result.insert(
            "canonicalLocale".to_string(),
            Value::String(CANONICAL_LOCALE.to_string()),
        );
        return Value::Object(result);
    };

    if let Some(localized_data) = data.and_then(Value::as_object) {
        for field in LOCALIZED_OFFER_FIELDS {
            if result.contains_key(*field)
                && let Some(value) = localized_data.get(*field)
            {
                result.insert((*field).to_string(), value.clone());
            }
        }
    }

    result.insert("locale".to_string(), Value::String(locale.to_string()));
    result.insert(
        "localeStatus".to_string(),
        Value::String("localized".to_string()),
    );
    result.insert(
        "canonicalLocale".to_string(),
        Value::String(CANONICAL_LOCALE.to_string()),
    );

    result.insert("localization".to_string(), meta_value);

    Value::Object(result)
}

/// Build the Redis cache-key segment for a canonicalized locale.
pub fn locale_cache_segment(locale: &str) -> String {
    format!("locale:{locale}")
}

/// Recursively detect whether any nested object in `value` has `localeStatus == "fallback"`.
pub fn has_localization_fallback(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.iter().any(has_localization_fallback),
        Value::Object(map) => {
            if map.get("localeStatus").and_then(Value::as_str) == Some("fallback") {
                return true;
            }
            map.values().any(has_localization_fallback)
        }
        _ => false,
    }
}

/// Cap `default_ttl_seconds` to [`FALLBACK_CACHE_TTL_SECONDS`] when `value` contains a fallback.
pub fn get_localized_cache_ttl_seconds(value: &Value, default_ttl_seconds: u64) -> u64 {
    if !has_localization_fallback(value) {
        return default_ttl_seconds;
    }
    default_ttl_seconds.min(FALLBACK_CACHE_TTL_SECONDS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_locale_defaults_and_canonicalizes() {
        assert_eq!(parse_locale(None).unwrap(), "en-US");
        assert_eq!(parse_locale(Some("")).unwrap(), "en-US");
        assert_eq!(parse_locale(Some("   ")).unwrap(), "en-US");
        assert_eq!(parse_locale(Some("en-us")).unwrap(), "en-US");
        assert_eq!(parse_locale(Some("es-es")).unwrap(), "es-ES");
        assert_eq!(parse_locale(Some("zh-hant")).unwrap(), "zh-Hant");
        assert_eq!(parse_locale(Some("fil")).unwrap(), "fil");
    }

    #[test]
    fn parse_locale_rejects_invalid_tags() {
        assert_eq!(
            parse_locale(Some("en_US")),
            Err(InvalidLocaleError("en_US".into()))
        );
        assert_eq!(
            parse_locale(Some("not-a-locale")),
            Err(InvalidLocaleError("not-a-locale".into()))
        );
        assert_eq!(
            parse_locale(Some("en-US-US")),
            Err(InvalidLocaleError("en-US-US".into()))
        );
    }

    #[test]
    fn entity_id_requires_non_empty_id_and_namespace() {
        assert_eq!(
            get_offer_localization_entity_id(&json!({ "id": "offer-1", "namespace": "ns" })),
            Some("ns:offer-1".into())
        );
        assert_eq!(
            get_offer_localization_entity_id(&json!({ "namespace": "ns" })),
            None
        );
        assert_eq!(
            get_offer_localization_entity_id(&json!({ "id": 123, "namespace": "ns" })),
            None
        );
        assert_eq!(
            get_offer_localization_entity_id(&json!({ "id": "", "namespace": "ns" })),
            None
        );
        assert_eq!(
            get_offer_localization_entity_id(&json!({ "id": "offer-1", "namespace": "" })),
            None
        );
        assert_eq!(
            get_offer_localization_entity_id(&json!({ "id": "offer-1" })),
            None
        );
        assert_eq!(
            get_offer_localization_entity_id(&json!("not-an-object")),
            None
        );
    }

    #[test]
    fn apply_offer_localization_handles_canonical_localized_and_fallback() {
        let offer = json!({
            "id": "offer-1",
            "namespace": "ns",
            "title": "Canonical title",
            "description": "Canonical description",
            "price": { "price": { "discountPrice": 999 } },
            "countriesWhitelist": ["US"]
        });

        let canonical = apply_offer_localization(&offer, None, "en-US");
        assert_eq!(canonical["locale"], "en-US");
        assert_eq!(canonical["localeStatus"], "canonical");
        assert!(canonical.get("canonicalLocale").is_none());

        let fallback = apply_offer_localization(&offer, None, "fr-FR");
        assert_eq!(fallback["title"], "Canonical title");
        assert_eq!(fallback["locale"], "fr-FR");
        assert_eq!(fallback["localeStatus"], "fallback");
        assert_eq!(fallback["canonicalLocale"], "en-US");
        assert!(fallback.get("localization").is_none());

        let fetched_at: DateTime<Utc> = "2026-07-01T08:41:42.413Z".parse().unwrap();
        let source_updated_at: DateTime<Utc> = "2026-06-16T07:53:22.886Z".parse().unwrap();
        let loc = EgsLocalization {
            mongo_id: None,
            entity_type: "offer".into(),
            entity_id: "ns:offer-1".into(),
            namespace: Some("ns".into()),
            locale: "es-ES".into(),
            source: "graphql.catalogOffer".into(),
            data: Some(json!({
                "title": "Titulo localizado",
                "longDescription": "Ignored because absent on canonicalOffer",
                "price": { "price": { "discountPrice": 1 } },
                "countriesWhitelist": ["ES"]
            })),
            fetched_at: Some(fetched_at),
            source_updated_at: Some(source_updated_at),
            matches_canonical: None,
        };

        let localized = apply_offer_localization(&offer, Some(&loc), "es-ES");
        assert_eq!(localized["title"], "Titulo localizado");
        assert_eq!(localized["description"], "Canonical description");
        assert_eq!(localized["price"]["price"]["discountPrice"], 999);
        assert_eq!(localized["countriesWhitelist"], json!(["US"]));
        assert!(localized.get("longDescription").is_none());
        assert_eq!(localized["locale"], "es-ES");
        assert_eq!(localized["localeStatus"], "localized");
        assert_eq!(localized["canonicalLocale"], "en-US");
        assert_eq!(localized["localization"]["source"], "graphql.catalogOffer");
        assert!(localized["localization"]["sourceUpdatedAt"].is_string());

        // Non-object canonical + loc without data/sourceUpdatedAt still works cleanly.
        let loc_min = EgsLocalization {
            mongo_id: None,
            entity_type: "offer".into(),
            entity_id: "ns:offer-1".into(),
            namespace: None,
            locale: "de-DE".into(),
            source: "graphql".into(),
            data: None,
            fetched_at: Some(fetched_at),
            source_updated_at: None,
            matches_canonical: None,
        };
        let minimal = apply_offer_localization(&json!(null), Some(&loc_min), "de-DE");
        assert_eq!(minimal["localeStatus"], "localized");
        assert!(minimal["localization"].get("sourceUpdatedAt").is_none());
    }

    #[test]
    fn cache_segment_and_fallback_ttl_behave_as_expected() {
        assert_eq!(locale_cache_segment("es-ES"), "locale:es-ES");

        let fallback_payload = json!({
            "elements": [{ "localeStatus": "fallback" }]
        });
        let localized_payload = json!({
            "elements": [{ "localeStatus": "localized" }]
        });

        assert!(has_localization_fallback(&fallback_payload));
        assert!(!has_localization_fallback(&localized_payload));
        assert!(!has_localization_fallback(&json!("primitive")));

        assert_eq!(get_localized_cache_ttl_seconds(&fallback_payload, 3600), 60);
        assert_eq!(get_localized_cache_ttl_seconds(&fallback_payload, 30), 30);
        assert_eq!(
            get_localized_cache_ttl_seconds(&localized_payload, 3600),
            3600
        );

        let loc_json = json!({
            "entityType": "offer",
            "entityId": "ns:1",
            "locale": "es-ES",
            "source": "graphql",
            "fetchedAt": "2026-07-01T08:41:42.413Z"
        });
        let loc_rt: EgsLocalization = serde_json::from_value(loc_json).unwrap();
        assert_eq!(loc_rt.locale, "es-ES");

        let meta = LocalizedOfferMetadata {
            locale: "es-ES".into(),
            locale_status: LocaleStatus::Localized,
            canonical_locale: Some("en-US".into()),
            localization: Some(LocalizationMetadata {
                source: "graphql".into(),
                fetched_at: loc_rt.fetched_at,
                source_updated_at: None,
            }),
        };
        let meta_rt: LocalizedOfferMetadata =
            serde_json::from_value(serde_json::to_value(&meta).unwrap()).unwrap();
        assert_eq!(meta_rt, meta);
    }
}
