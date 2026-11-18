//! Catalog hydration keys, deterministic hashing, and catalog graph projection.

use crate::v1::serialization::js_array_index;
use chrono::{DateTime, NaiveDate, NaiveDateTime, SecondsFormat, Utc};
use icu_collator::{Collator, CollatorBorrowed};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};
use std::borrow::Borrow;
use std::collections::{BTreeSet, HashMap};
use thiserror::Error;

pub struct CatalogCollation {
    collator: CollatorBorrowed<'static>,
}

impl CatalogCollation {
    pub fn for_locale(locale: &str) -> Result<Self, String> {
        let locale = locale
            .parse::<icu_locale_core::Locale>()
            .map_err(|_| format!("invalid ICU locale: {locale}"))?;
        Collator::try_new(locale.into(), Default::default())
            .map(|collator| Self { collator })
            .map_err(|_| "unsupported ICU locale".into())
    }

    pub fn compare(&self, left: &str, right: &str) -> std::cmp::Ordering {
        self.collator.compare(left, right)
    }
}

/// Use the Node host locale, overridden by `NODE_ICU_LOCALE` when configured.
pub fn node_collator() -> CatalogCollation {
    let locale = std::env::var("NODE_ICU_LOCALE")
        .ok()
        .or_else(sys_locale::get_locale);
    collator_for_host(locale.as_deref())
}

fn collator_for_host(locale: Option<&str>) -> CatalogCollation {
    CatalogCollation::for_locale(locale.unwrap_or("en-US"))
        .or_else(|_| CatalogCollation::for_locale("en-US"))
        .expect("en-US ICU collator is available")
}

/// Current NDJSON catalog hydration wire schema version.
pub const CATALOG_HYDRATION_SCHEMA_VERSION: u8 = 2;

/// Maximum identifiers accepted in a single hydration request.
pub const CATALOG_HYDRATION_MAX_IDENTIFIERS: usize = 25;

/// Maximum known record hashes accepted in a single hydration request.
pub const CATALOG_HYDRATION_MAX_KNOWN_RECORDS: usize = 5_000;

/// Maximum records emitted for a single hydrated root.
pub const CATALOG_HYDRATION_MAX_ROOT_RECORDS: usize = 500;

/// Maximum serialized NDJSON line byte length for a hydrated root.
pub const CATALOG_HYDRATION_MAX_LINE_BYTES: usize = 2 * 1024 * 1024;

const MAX_ID: usize = 256;
const MAX_TITLE: usize = 512;
const MAX_PROSE: usize = 64 * 1024;
const MAX_URL: usize = 4 * 1024;
const MAX_ARRAY: usize = 100_000;

/// Error raised when a catalog entity fails structural or size validation during projection.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
#[error("{0}")]
pub struct CatalogProjectionError(pub String);

/// Key image attached to a projected catalog offer or item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogImage {
    #[serde(rename = "type")]
    pub image_type: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub md5: Option<String>,
}

/// Tag attached to a projected catalog offer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogTag {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Custom attribute attached to a projected catalog offer or item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogCustomAttribute {
    pub key: String,
    pub value: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub attr_type: Option<String>,
}

/// Seller summary attached to a projected catalog offer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogSeller {
    pub id: String,
    pub name: String,
}

/// Storefront page mapping attached to a projected catalog offer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogOfferMapping {
    pub page_slug: String,
    pub page_type: String,
}

/// Projected catalog offer record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogOfferRecord {
    pub namespace: String,
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub long_description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offer_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seller: Option<CatalogSeller>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub developer_display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publisher_display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub product_slug: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url_slug: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub key_images: Vec<CatalogImage>,
    pub tags: Vec<CatalogTag>,
    pub categories: Vec<String>,
    pub custom_attributes: Vec<CatalogCustomAttribute>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creation_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_modified_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pc_release_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub viewable_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre_purchase: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_code_redemption_only: Option<bool>,
    pub countries_blacklist: Vec<String>,
    pub countries_whitelist: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refund_type: Option<String>,
    pub offer_mappings: Vec<CatalogOfferMapping>,
}

/// Projected catalog item record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogItemRecord {
    pub namespace: String,
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub long_description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub technical_details: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entitlement_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entitlement_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_type: Option<String>,
    pub key_images: Vec<CatalogImage>,
    pub categories: Vec<String>,
    pub custom_attributes: Vec<CatalogCustomAttribute>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creation_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_modified_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub developer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub developer_id: Option<String>,
    pub eula_ids: Vec<String>,
    pub install_modes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_of_support: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub self_refundable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub application_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unsearchable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_secure_account: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entitlement_start_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entitlement_end_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_count: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_offer_namespace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_offer_id: Option<String>,
}

/// Projected catalog asset record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogAssetRecord {
    pub namespace: String,
    pub artifact_id: String,
    pub platform: String,
    pub item_namespace: String,
    pub item_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_size_bytes: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_size_bytes: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_offer_namespace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_offer_id: Option<String>,
}

/// Projected catalog release-app record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogReleaseAppRecord {
    pub namespace: String,
    pub app_id: String,
    pub platform: String,
    pub item_namespace: String,
    pub item_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_offer_namespace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_offer_id: Option<String>,
}

/// Provenance of an offer-item relationship in the catalog graph.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CatalogOfferItemSource {
    Direct,
    Subitem,
    Linked,
}

impl CatalogOfferItemSource {
    fn rank(self) -> u8 {
        match self {
            Self::Direct => 0,
            Self::Subitem => 1,
            Self::Linked => 2,
        }
    }
}

/// Projected offer-to-item relationship edge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogOfferItemRecord {
    pub offer_namespace: String,
    pub offer_id: String,
    pub item_namespace: String,
    pub item_id: String,
    pub sources: Vec<CatalogOfferItemSource>,
    pub is_primary: bool,
}

/// Discriminated union of all projected catalog record types.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum CatalogRecord {
    #[serde(rename = "offer")]
    Offer(CatalogOfferRecord),
    #[serde(rename = "item")]
    Item(CatalogItemRecord),
    #[serde(rename = "asset")]
    Asset(CatalogAssetRecord),
    #[serde(rename = "release-app")]
    ReleaseApp(CatalogReleaseAppRecord),
    #[serde(rename = "offer-item")]
    OfferItem(CatalogOfferItemRecord),
}

/// Root identifier requested in a catalog hydration request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum CatalogHydrationIdentifier {
    #[serde(rename = "item")]
    Item { namespace: String, id: String },
    #[serde(rename = "asset")]
    Asset {
        namespace: String,
        #[serde(rename = "artifactId")]
        artifact_id: String,
        platform: String,
    },
    #[serde(rename = "release-app")]
    ReleaseApp {
        namespace: String,
        #[serde(rename = "appId")]
        app_id: String,
        platform: String,
    },
}

/// Client-supplied known root graph hash for conditional hydration skipping.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogHydrationKnownRoot {
    pub root_key: String,
    pub graph_hash: String,
}

/// Client-supplied known record content hash for delta record omission.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogHydrationKnownRecord {
    pub record_key: String,
    pub sha256: String,
}

/// Request payload for catalog hydration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogHydrationRequest {
    pub schema_version: u8,
    pub identifiers: Vec<CatalogHydrationIdentifier>,
    pub known_roots: Vec<CatalogHydrationKnownRoot>,
    pub known_records: Vec<CatalogHydrationKnownRecord>,
}

/// Content-addressed record envelope emitted by catalog hydration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogHydrationRecord {
    pub record_key: String,
    pub sha256: String,
    pub record: CatalogRecord,
}

/// Structured error attached to a failed hydrated root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogHydrationErrorDetail {
    pub code: String,
    pub message: String,
}

/// Per-root NDJSON response line outcome.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum CatalogHydrationRootResult {
    Unchanged {
        #[serde(rename = "schemaVersion")]
        schema_version: u8,
        #[serde(rename = "rootKey")]
        root_key: String,
        identifier: CatalogHydrationIdentifier,
        #[serde(rename = "hydratedAt")]
        hydrated_at: String,
        #[serde(rename = "graphHash")]
        graph_hash: String,
    },
    NotFound {
        #[serde(rename = "schemaVersion")]
        schema_version: u8,
        #[serde(rename = "rootKey")]
        root_key: String,
        identifier: CatalogHydrationIdentifier,
        #[serde(rename = "hydratedAt")]
        hydrated_at: String,
    },
    Resolved {
        #[serde(rename = "schemaVersion")]
        schema_version: u8,
        #[serde(rename = "rootKey")]
        root_key: String,
        identifier: CatalogHydrationIdentifier,
        #[serde(rename = "hydratedAt")]
        hydrated_at: String,
        #[serde(rename = "graphHash")]
        graph_hash: String,
        #[serde(rename = "recordKeys")]
        record_keys: Vec<String>,
        records: Vec<CatalogHydrationRecord>,
    },
    Error {
        #[serde(rename = "schemaVersion")]
        schema_version: u8,
        #[serde(rename = "rootKey")]
        root_key: String,
        identifier: CatalogHydrationIdentifier,
        #[serde(rename = "hydratedAt")]
        hydrated_at: String,
        error: CatalogHydrationErrorDetail,
    },
}

const URI_COMPONENT_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

/// Build the normalized compound key used by the catalog hydration wire format.
pub fn catalog_key(kind: &str, components: &[&str]) -> String {
    let mut key = String::from(kind);
    for component in components {
        key.push(':');
        let normalized = crate::v1::trim_js_whitespace(component).to_lowercase();
        key.extend(utf8_percent_encode(&normalized, URI_COMPONENT_SET));
    }
    key
}

/// Compute the canonical root key for a [`CatalogHydrationIdentifier`].
pub fn catalog_hydration_root_key(identifier: &CatalogHydrationIdentifier) -> String {
    match identifier {
        CatalogHydrationIdentifier::Item { namespace, id } => catalog_key("item", &[namespace, id]),
        CatalogHydrationIdentifier::Asset {
            namespace,
            artifact_id,
            platform,
        } => catalog_key("asset", &[namespace, artifact_id, platform]),
        CatalogHydrationIdentifier::ReleaseApp {
            namespace,
            app_id,
            platform,
        } => catalog_key("release-app", &[namespace, app_id, platform]),
    }
}

/// Compute the canonical content-addressing key for a [`CatalogRecord`].
pub fn catalog_record_key(record: &CatalogRecord) -> String {
    match record {
        CatalogRecord::Offer(offer) => catalog_key("offer", &[&offer.namespace, &offer.id]),
        CatalogRecord::Item(item) => catalog_key("item", &[&item.namespace, &item.id]),
        CatalogRecord::Asset(asset) => catalog_key(
            "asset",
            &[
                &asset.namespace,
                &asset.artifact_id,
                &asset.platform,
                &asset.item_namespace,
                &asset.item_id,
            ],
        ),
        CatalogRecord::ReleaseApp(app) => catalog_key(
            "release-app",
            &[
                &app.namespace,
                &app.app_id,
                &app.platform,
                &app.item_namespace,
                &app.item_id,
            ],
        ),
        CatalogRecord::OfferItem(edge) => catalog_key(
            "offer-item",
            &[
                &edge.offer_namespace,
                &edge.offer_id,
                &edge.item_namespace,
                &edge.item_id,
            ],
        ),
    }
}

fn normalize_json_value(value: &Value, collator: &CatalogCollation) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|value| normalize_json_value(value, collator))
                .collect(),
        ),
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by(|(left, _), (right, _)| {
                match (js_array_index(left), js_array_index(right)) {
                    (Some(left), Some(right)) => left.cmp(&right),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => collator.compare(left, right),
                }
            });
            let mut out = Map::new();
            for (key, value) in entries {
                out.insert(key.clone(), normalize_json_value(value, collator));
            }
            Value::Object(out)
        }
        _ => value.clone(),
    }
}

/// Serialize a JSON value deterministically with recursively sorted object keys.
pub fn stable_json(value: &Value) -> String {
    let collator = node_collator();
    stable_json_with_collation(value, &collator)
}

pub fn stable_json_with_collation(value: &Value, collator: &CatalogCollation) -> String {
    let normalized = normalize_json_value(value, collator);
    crate::v1::serialization::node_json(&normalized)
}

/// Compute the lowercase hex SHA-256 digest of a UTF-8 string.
pub fn sha256_hex(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    hex::encode(digest)
}

/// Compute the deterministic graph hash for a set of hydrated records.
pub fn graph_hash_for_records(records: &[CatalogHydrationRecord]) -> String {
    let collator = node_collator();
    graph_hash_for_records_with_collation(records, &collator)
}

pub fn graph_hash_for_records_with_collation(
    records: &[CatalogHydrationRecord],
    collator: &CatalogCollation,
) -> String {
    graph_hash_for_entries(
        records
            .iter()
            .map(|r| (r.record_key.as_str(), r.sha256.as_str())),
        collator,
    )
}

/// Hash Node's sorted JSON array of [record key, digest] string pairs.
pub fn graph_hash_for_entries<'a>(
    entries: impl Iterator<Item = (&'a str, &'a str)>,
    collator: &CatalogCollation,
) -> String {
    let mut pairs: Vec<_> = entries.collect();
    pairs.sort_by(|left, right| collator.compare(left.0, right.0));
    let mut digest = Sha256::new();
    serde_json::to_writer(&mut digest, &pairs)
        .expect("writing JSON strings to SHA-256 is infallible");
    hex::encode(digest.finalize())
}

fn slice_chars(value: &str, maximum: usize) -> String {
    value.chars().take(maximum).collect()
}

fn opt_text(value: Option<&Value>, maximum: usize) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(|s| slice_chars(s, maximum))
}

fn opt_id(value: Option<&Value>) -> Option<String> {
    opt_text(value, MAX_ID).filter(|s| !s.is_empty())
}

fn required_id(value: Option<&Value>, name: &str) -> Result<String, CatalogProjectionError> {
    opt_id(value).ok_or_else(|| CatalogProjectionError(format!("{name} is invalid")))
}

fn required_title(value: Option<&Value>, name: &str) -> Result<String, CatalogProjectionError> {
    opt_text(value, MAX_TITLE)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| CatalogProjectionError(format!("{name} is invalid")))
}

fn opt_bool(value: Option<&Value>) -> Option<bool> {
    value.and_then(Value::as_bool)
}

fn opt_non_negative_number(value: Option<&Value>) -> Option<Number> {
    let f = value?.as_f64().filter(|f| *f >= 0.0)?;
    if f.fract() == 0.0 && f <= (1u64 << 53) as f64 {
        return Some(Number::from(f as u64));
    }
    Number::from_f64(f)
}

/// Convert a catalog timestamp to the UTC wire representation used in record hashes.
pub fn catalog_date(value: Option<&Value>) -> Option<String> {
    let raw = value?;
    let source = raw
        .as_object()
        .and_then(|obj| obj.get("$date"))
        .unwrap_or(raw);

    match source {
        Value::String(s) => {
            if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
                return Some(
                    dt.with_timezone(&Utc)
                        .to_rfc3339_opts(SecondsFormat::Millis, true),
                );
            }
            if let Ok(ndt) = NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f") {
                return Some(ndt.and_utc().to_rfc3339_opts(SecondsFormat::Millis, true));
            }
            if let Ok(nd) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
                let dt = nd
                    .and_hms_opt(0, 0, 0)
                    .expect("00:00:00 is valid")
                    .and_utc();
                return Some(dt.to_rfc3339_opts(SecondsFormat::Millis, true));
            }
            None
        }
        Value::Number(n) => {
            let ms = n.as_f64().expect("json number fits in f64");
            let dt = DateTime::from_timestamp_millis(ms.trunc() as i64)?;
            Some(dt.to_rfc3339_opts(SecondsFormat::Millis, true))
        }
        _ => None,
    }
}

fn bounded_array<'a>(
    value: Option<&'a Value>,
    name: &str,
) -> Result<&'a [Value], CatalogProjectionError> {
    let Some(arr) = value.and_then(Value::as_array) else {
        return Ok(&[]);
    };
    if arr.len() > MAX_ARRAY {
        return Err(CatalogProjectionError(format!("{name} is oversized")));
    }
    Ok(arr.as_slice())
}

fn project_strings(
    value: Option<&Value>,
    maximum: usize,
    name: &str,
) -> Result<Vec<String>, CatalogProjectionError> {
    let arr = bounded_array(value, name)?;
    let mut strings: Vec<String> = arr
        .iter()
        .filter_map(|entry| opt_text(Some(entry), maximum))
        .collect();
    strings.sort_unstable_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    strings.dedup();
    Ok(strings)
}

fn project_images(
    value: Option<&Value>,
    name: &str,
    collator: &CatalogCollation,
) -> Result<Vec<CatalogImage>, CatalogProjectionError> {
    let arr = bounded_array(value, name)?;
    let mut out: Vec<CatalogImage> = arr
        .iter()
        .filter_map(|entry| {
            let obj = entry.as_object()?;
            let image_type = opt_text(obj.get("type"), MAX_TITLE).filter(|s| !s.is_empty())?;
            let url = opt_text(obj.get("url"), MAX_URL).filter(|s| !s.is_empty())?;
            let md5 = opt_id(obj.get("md5"));
            Some(CatalogImage {
                image_type,
                url,
                md5,
            })
        })
        .collect();
    out.sort_by(|left, right| {
        collator.compare(
            &format!("{}\0{}", left.image_type, left.url),
            &format!("{}\0{}", right.image_type, right.url),
        )
    });
    Ok(out)
}

fn project_tags(
    value: Option<&Value>,
    name: &str,
    collator: &CatalogCollation,
) -> Result<Vec<CatalogTag>, CatalogProjectionError> {
    let arr = bounded_array(value, name)?;
    let mut out: Vec<CatalogTag> = arr
        .iter()
        .filter_map(|entry| {
            let obj = entry.as_object()?;
            let id = opt_id(obj.get("id"))?;
            let name = opt_text(obj.get("name"), MAX_TITLE).filter(|s| !s.is_empty());
            Some(CatalogTag { id, name })
        })
        .collect();
    out.sort_by(|left, right| collator.compare(&left.id, &right.id));
    Ok(out)
}

fn project_attributes(
    value: Option<&Value>,
    name: &str,
    collator: &CatalogCollation,
) -> Result<Vec<CatalogCustomAttribute>, CatalogProjectionError> {
    let arr = bounded_array(value, name)?;
    let mut out: Vec<CatalogCustomAttribute> = arr
        .iter()
        .filter_map(|entry| {
            let obj = entry.as_object()?;
            let key = opt_id(obj.get("key"))?;
            let attr_value = opt_text(obj.get("value"), MAX_PROSE)?;
            let attr_type = opt_id(obj.get("type"));
            Some(CatalogCustomAttribute {
                key,
                value: attr_value,
                attr_type,
            })
        })
        .collect();
    out.sort_by(|left, right| {
        collator.compare(
            &format!("{}\0{}", left.key, left.value),
            &format!("{}\0{}", right.key, right.value),
        )
    });
    Ok(out)
}

fn project_categories(
    value: Option<&Value>,
    name: &str,
) -> Result<Vec<String>, CatalogProjectionError> {
    let arr = bounded_array(value, name)?;
    let mut strings: Vec<String> = arr
        .iter()
        .filter_map(|entry| match entry {
            Value::String(s) => Some(slice_chars(s, MAX_TITLE)),
            Value::Object(obj) => opt_text(obj.get("path"), MAX_TITLE).filter(|s| !s.is_empty()),
            _ => None,
        })
        .collect();
    strings.sort_unstable_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    strings.dedup();
    Ok(strings)
}

/// Direct item reference extracted from an offer's `items` array.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogDirectItemRef {
    pub namespace: Option<String>,
    pub id: String,
}

/// Projected offer plus its direct item references for graph projection.
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectedOffer {
    pub record: CatalogOfferRecord,
    pub direct_items: Vec<CatalogDirectItemRef>,
}

/// Extracted release-app metadata from an item's `releaseInfo` array.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogReleaseAppInfo {
    pub app_id: String,
    pub platforms: Vec<String>,
    pub release_id: Option<String>,
}

/// Projected item plus linked offer IDs and release apps for graph projection.
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectedItem {
    pub record: CatalogItemRecord,
    pub linked_offer_ids: Vec<String>,
    pub release_apps: Vec<CatalogReleaseAppInfo>,
}

/// Input collections passed to [`project_catalog_graph`].
#[derive(Debug, Clone, Default)]
pub struct CatalogProjectionSources<'a> {
    pub offers: &'a [Value],
    pub items: &'a [Value],
    pub assets: &'a [Value],
    pub sub_items: &'a [Value],
}

/// Validate and project a raw offer JSON document into [`ProjectedOffer`].
pub fn project_offer(value: &Value) -> Result<ProjectedOffer, CatalogProjectionError> {
    let collator = node_collator();
    project_offer_with_collation(value, &collator)
}

pub fn project_offer_with_collation(
    value: &Value,
    collator: &CatalogCollation,
) -> Result<ProjectedOffer, CatalogProjectionError> {
    let obj = value
        .as_object()
        .ok_or_else(|| CatalogProjectionError("Offer is invalid".to_string()))?;

    let namespace = required_id(obj.get("namespace"), "offer.namespace")?;
    let id = required_id(obj.get("id"), "offer.id")?;
    let title = required_title(obj.get("title"), "offer.title")?;

    let seller = obj.get("seller").and_then(Value::as_object).and_then(|s| {
        let seller_id = opt_id(s.get("id"))?;
        let seller_name = opt_text(s.get("name"), MAX_TITLE).filter(|n| !n.is_empty())?;
        Some(CatalogSeller {
            id: seller_id,
            name: seller_name,
        })
    });

    let offer_mappings = bounded_array(obj.get("offerMappings"), "offer.offerMappings")?
        .iter()
        .filter_map(|entry| {
            let map = entry.as_object()?;
            let page_slug = opt_text(map.get("pageSlug"), MAX_URL).filter(|s| !s.is_empty())?;
            let page_type = opt_id(map.get("pageType"))?;
            Some(CatalogOfferMapping {
                page_slug,
                page_type,
            })
        })
        .collect();

    let direct_items = bounded_array(obj.get("items"), "offer.items")?
        .iter()
        .filter_map(|entry| {
            let map = entry.as_object()?;
            let item_id = opt_id(map.get("id"))?;
            let item_namespace = opt_id(map.get("namespace"));
            Some(CatalogDirectItemRef {
                namespace: item_namespace,
                id: item_id,
            })
        })
        .collect();

    let record = CatalogOfferRecord {
        namespace,
        id,
        title,
        description: opt_text(obj.get("description"), MAX_PROSE),
        long_description: opt_text(obj.get("longDescription"), MAX_PROSE),
        offer_type: opt_id(obj.get("offerType")),
        seller,
        developer_display_name: opt_text(obj.get("developerDisplayName"), MAX_TITLE),
        publisher_display_name: opt_text(obj.get("publisherDisplayName"), MAX_TITLE),
        product_slug: opt_text(obj.get("productSlug"), MAX_URL),
        url_slug: opt_text(obj.get("urlSlug"), MAX_URL),
        url: opt_text(obj.get("url"), MAX_URL),
        key_images: project_images(obj.get("keyImages"), "offer.keyImages", collator)?,
        tags: project_tags(obj.get("tags"), "offer.tags", collator)?,
        categories: project_strings(obj.get("categories"), MAX_TITLE, "offer.categories")?,
        custom_attributes: project_attributes(
            obj.get("customAttributes"),
            "offer.customAttributes",
            collator,
        )?,
        effective_date: catalog_date(obj.get("effectiveDate")),
        creation_date: catalog_date(obj.get("creationDate")),
        last_modified_date: catalog_date(obj.get("lastModifiedDate")),
        release_date: catalog_date(obj.get("releaseDate")),
        pc_release_date: catalog_date(obj.get("pcReleaseDate")),
        viewable_date: catalog_date(obj.get("viewableDate")),
        pre_purchase: opt_bool(obj.get("prePurchase")),
        is_code_redemption_only: opt_bool(obj.get("isCodeRedemptionOnly")),
        countries_blacklist: project_strings(
            obj.get("countriesBlacklist"),
            MAX_ID,
            "offer.countriesBlacklist",
        )?,
        countries_whitelist: project_strings(
            obj.get("countriesWhitelist"),
            MAX_ID,
            "offer.countriesWhitelist",
        )?,
        refund_type: opt_id(obj.get("refundType")),
        offer_mappings,
    };

    Ok(ProjectedOffer {
        record,
        direct_items,
    })
}

/// Validate and project a raw item JSON document into [`ProjectedItem`].
pub fn project_item(value: &Value) -> Result<ProjectedItem, CatalogProjectionError> {
    let collator = node_collator();
    project_item_with_collation(value, &collator)
}

pub fn project_item_with_collation(
    value: &Value,
    collator: &CatalogCollation,
) -> Result<ProjectedItem, CatalogProjectionError> {
    let obj = value
        .as_object()
        .ok_or_else(|| CatalogProjectionError("Item is invalid".to_string()))?;

    let namespace = required_id(obj.get("namespace"), "item.namespace")?;
    let id = required_id(obj.get("id"), "item.id")?;
    let title = required_title(obj.get("title"), "item.title")?;

    let release_apps = bounded_array(obj.get("releaseInfo"), "item.releaseInfo")?
        .iter()
        .filter_map(|entry| {
            let map = entry.as_object()?;
            let app_id = opt_id(map.get("appId"))?;
            let release_id = opt_id(map.get("id"));
            let platforms =
                project_strings(map.get("platform"), MAX_ID, "item.releaseInfo.platform").ok()?;
            Some(CatalogReleaseAppInfo {
                app_id,
                platforms: if platforms.is_empty() {
                    vec!["Unknown".to_string()]
                } else {
                    platforms
                },
                release_id,
            })
        })
        .collect();

    let record = CatalogItemRecord {
        namespace,
        id,
        title,
        description: opt_text(obj.get("description"), MAX_PROSE),
        long_description: opt_text(obj.get("longDescription"), MAX_PROSE),
        technical_details: opt_text(obj.get("technicalDetails"), MAX_PROSE),
        status: opt_id(obj.get("status")),
        entitlement_name: opt_id(obj.get("entitlementName")),
        entitlement_type: opt_id(obj.get("entitlementType")),
        item_type: opt_id(obj.get("itemType")),
        key_images: project_images(obj.get("keyImages"), "item.keyImages", collator)?,
        categories: project_categories(obj.get("categories"), "item.categories")?,
        custom_attributes: project_attributes(
            obj.get("customAttributes"),
            "item.customAttributes",
            collator,
        )?,
        creation_date: catalog_date(obj.get("creationDate")),
        last_modified_date: catalog_date(obj.get("lastModifiedDate")),
        developer: opt_text(obj.get("developer"), MAX_TITLE),
        developer_id: opt_id(obj.get("developerId")),
        eula_ids: project_strings(obj.get("eulaIds"), MAX_ID, "item.eulaIds")?,
        install_modes: project_strings(obj.get("installModes"), MAX_ID, "item.installModes")?,
        end_of_support: opt_bool(obj.get("endOfSupport")),
        self_refundable: opt_bool(obj.get("selfRefundable")),
        application_id: opt_id(obj.get("applicationId")),
        unsearchable: opt_bool(obj.get("unsearchable")),
        requires_secure_account: opt_bool(obj.get("requiresSecureAccount")),
        entitlement_start_date: catalog_date(obj.get("entitlementStartDate")),
        entitlement_end_date: catalog_date(obj.get("entitlementEndDate")),
        use_count: opt_non_negative_number(obj.get("useCount")),
        primary_offer_namespace: None,
        primary_offer_id: None,
    };

    Ok(ProjectedItem {
        record,
        linked_offer_ids: project_strings(obj.get("linkedOffers"), MAX_ID, "item.linkedOffers")?,
        release_apps,
    })
}

/// Validate and project a raw asset JSON document into [`CatalogAssetRecord`].
pub fn project_asset(value: &Value) -> Result<CatalogAssetRecord, CatalogProjectionError> {
    let obj = value
        .as_object()
        .ok_or_else(|| CatalogProjectionError("Asset is invalid".to_string()))?;

    let namespace = required_id(obj.get("namespace"), "asset.namespace")?;
    let artifact_id = required_id(obj.get("artifactId"), "asset.artifactId")?;
    let platform = required_id(obj.get("platform"), "asset.platform")?;
    let item_id = required_id(obj.get("itemId"), "asset.itemId")?;

    Ok(CatalogAssetRecord {
        namespace: namespace.clone(),
        artifact_id,
        platform,
        item_namespace: namespace,
        item_id,
        download_size_bytes: opt_non_negative_number(obj.get("downloadSizeBytes")),
        installed_size_bytes: opt_non_negative_number(obj.get("installedSizeBytes")),
        primary_offer_namespace: None,
        primary_offer_id: None,
    })
}

fn composite(namespace: &str, value: &str) -> String {
    format!("{namespace}\0{value}")
}

fn offer_type_rank(offer_type: Option<&str>) -> u8 {
    match offer_type.unwrap_or("").to_uppercase().as_str() {
        "BASE_GAME" => 0,
        "DLC" => 1,
        "ADD_ON" => 2,
        "EDITION" => 3,
        "BUNDLE" => 4,
        "CONSUMABLE" => 5,
        _ => 99,
    }
}

fn resolve_from_by_id(by_id: &HashMap<String, Vec<String>>, value: &str) -> Option<String> {
    let matches = by_id.get(value)?;
    (matches.len() == 1).then(|| matches[0].clone())
}

fn resolve_entity<T>(
    map: &HashMap<String, &T>,
    by_id: &HashMap<String, Vec<String>>,
    value: &str,
    namespace: Option<&str>,
) -> Option<String> {
    if let Some(key) = namespace
        .map(|ns| composite(ns, value))
        .filter(|key| map.contains_key(key))
    {
        return Some(key);
    }
    resolve_from_by_id(by_id, value)
}

/// Project offers, items, assets, sub-items, release apps, and primary offer relationships
/// into a flat list of [`CatalogRecord`]s.
pub fn project_catalog_graph(
    sources: &CatalogProjectionSources<'_>,
) -> Result<Vec<CatalogRecord>, CatalogProjectionError> {
    let collator = node_collator();
    project_catalog_graph_with_collation(sources, &collator)
}

pub fn project_catalog_graph_with_collation(
    sources: &CatalogProjectionSources<'_>,
    collator: &CatalogCollation,
) -> Result<Vec<CatalogRecord>, CatalogProjectionError> {
    let offers: Vec<ProjectedOffer> = sources
        .offers
        .iter()
        .map(|value| project_offer_with_collation(value, collator))
        .collect::<Result<_, _>>()?;
    let items: Vec<ProjectedItem> = sources
        .items
        .iter()
        .map(|value| project_item_with_collation(value, collator))
        .collect::<Result<_, _>>()?;
    let assets: Vec<CatalogAssetRecord> = sources
        .assets
        .iter()
        .map(project_asset)
        .collect::<Result<_, _>>()?;

    assemble_catalog_graph(offers, items, assets, sources.sub_items, collator)
}

/// Join projected rows into the catalog graph, preserving input order and edge provenance.
pub fn assemble_catalog_graph(
    offers: Vec<ProjectedOffer>,
    items: Vec<ProjectedItem>,
    assets: Vec<CatalogAssetRecord>,
    sub_items: impl IntoIterator<Item = impl Borrow<Value>>,
    collator: &CatalogCollation,
) -> Result<Vec<CatalogRecord>, CatalogProjectionError> {
    let mut offers_by_key = HashMap::<String, &ProjectedOffer>::new();
    let mut offer_keys_by_id = HashMap::<String, Vec<String>>::new();
    for entry in &offers {
        let key = composite(&entry.record.namespace, &entry.record.id);
        offers_by_key.insert(key.clone(), entry);
        offer_keys_by_id
            .entry(entry.record.id.clone())
            .or_default()
            .push(key);
    }

    let mut items_by_key = HashMap::<String, &ProjectedItem>::new();
    let mut item_keys_by_id = HashMap::<String, Vec<String>>::new();
    for entry in &items {
        let key = composite(&entry.record.namespace, &entry.record.id);
        items_by_key.insert(key.clone(), entry);
        item_keys_by_id
            .entry(entry.record.id.clone())
            .or_default()
            .push(key);
    }

    type EdgeTuple = (String, String, String, String);
    let mut edge_order = Vec::<EdgeTuple>::new();
    let mut observed = HashMap::<EdgeTuple, BTreeSet<CatalogOfferItemSource>>::new();

    let mut add_edge =
        |offer_key: Option<String>, item_key: Option<String>, source: CatalogOfferItemSource| {
            let (Some(ok), Some(ik)) = (offer_key, item_key) else {
                return;
            };
            let offer = offers_by_key[&ok];
            let item = items_by_key[&ik];
            let tuple = (
                offer.record.namespace.clone(),
                offer.record.id.clone(),
                item.record.namespace.clone(),
                item.record.id.clone(),
            );
            if !observed.contains_key(&tuple) {
                edge_order.push(tuple.clone());
            }
            observed.entry(tuple).or_default().insert(source);
        };

    for offer in &offers {
        let offer_key = composite(&offer.record.namespace, &offer.record.id);
        for reference in &offer.direct_items {
            let ns = reference
                .namespace
                .as_deref()
                .unwrap_or(&offer.record.namespace);
            let item_key = resolve_entity(&items_by_key, &item_keys_by_id, &reference.id, Some(ns));
            add_edge(
                Some(offer_key.clone()),
                item_key,
                CatalogOfferItemSource::Direct,
            );
        }
    }

    for raw in sub_items {
        let Some(obj) = raw.borrow().as_object() else {
            continue;
        };
        let Some(offer_id) = opt_id(obj.get("offerId")).or_else(|| opt_id(obj.get("_id"))) else {
            continue;
        };
        let offer_ns = opt_id(obj.get("offerNamespace")).or_else(|| opt_id(obj.get("namespace")));
        let offer_key = resolve_entity(
            &offers_by_key,
            &offer_keys_by_id,
            &offer_id,
            offer_ns.as_deref(),
        );
        let offer_record_ns = offer_key
            .as_ref()
            .and_then(|k| offers_by_key.get(k))
            .map(|o| o.record.namespace.clone());
        for entry in bounded_array(obj.get("subItems"), "offersubitems.subItems")? {
            let Some(entry_obj) = entry.as_object() else {
                continue;
            };
            let Some(item_id) = opt_id(entry_obj.get("id")) else {
                continue;
            };
            let entry_ns = opt_id(entry_obj.get("namespace")).or_else(|| offer_record_ns.clone());
            let item_key = resolve_entity(
                &items_by_key,
                &item_keys_by_id,
                &item_id,
                entry_ns.as_deref(),
            );
            add_edge(offer_key.clone(), item_key, CatalogOfferItemSource::Subitem);
        }
    }

    for item in &items {
        let item_key = composite(&item.record.namespace, &item.record.id);
        for offer_id in &item.linked_offer_ids {
            let offer_key = resolve_entity(
                &offers_by_key,
                &offer_keys_by_id,
                offer_id,
                Some(&item.record.namespace),
            );
            add_edge(
                offer_key,
                Some(item_key.clone()),
                CatalogOfferItemSource::Linked,
            );
        }
    }

    let mut edges: Vec<CatalogOfferItemRecord> = edge_order
        .into_iter()
        .map(|tuple| {
            let sources_set = observed.remove(&tuple).unwrap_or_default();
            let mut sorted_sources: Vec<CatalogOfferItemSource> = sources_set.into_iter().collect();
            sorted_sources.sort_by_key(|s| s.rank());
            CatalogOfferItemRecord {
                offer_namespace: tuple.0,
                offer_id: tuple.1,
                item_namespace: tuple.2,
                item_id: tuple.3,
                sources: sorted_sources,
                is_primary: false,
            }
        })
        .collect();

    let mut by_item = HashMap::<String, Vec<usize>>::new();
    for (idx, edge) in edges.iter().enumerate() {
        by_item
            .entry(composite(&edge.item_namespace, &edge.item_id))
            .or_default()
            .push(idx);
    }

    let mut primary = HashMap::<String, (String, String)>::new();
    for (item_key, mut indices) in by_item {
        indices.sort_by(|&li, &ri| {
            let left = &edges[li];
            let right = &edges[ri];
            let a = &offers_by_key[&composite(&left.offer_namespace, &left.offer_id)].record;
            let b = &offers_by_key[&composite(&right.offer_namespace, &right.offer_id)].record;

            let pre_cmp =
                u8::from(a.pre_purchase == Some(true)).cmp(&u8::from(b.pre_purchase == Some(true)));
            if pre_cmp != std::cmp::Ordering::Equal {
                return pre_cmp;
            }
            let src_cmp = left
                .sources
                .first()
                .copied()
                .unwrap_or(CatalogOfferItemSource::Linked)
                .rank()
                .cmp(
                    &right
                        .sources
                        .first()
                        .copied()
                        .unwrap_or(CatalogOfferItemSource::Linked)
                        .rank(),
                );
            if src_cmp != std::cmp::Ordering::Equal {
                return src_cmp;
            }
            let type_cmp = offer_type_rank(a.offer_type.as_deref())
                .cmp(&offer_type_rank(b.offer_type.as_deref()));
            if type_cmp != std::cmp::Ordering::Equal {
                return type_cmp;
            }
            let date_cmp = collator.compare(
                b.last_modified_date.as_deref().unwrap_or(""),
                a.last_modified_date.as_deref().unwrap_or(""),
            );
            if date_cmp != std::cmp::Ordering::Equal {
                return date_cmp;
            }
            collator.compare(
                &composite(&left.offer_namespace, &left.offer_id),
                &composite(&right.offer_namespace, &right.offer_id),
            )
        });

        let winner_idx = indices[0];
        edges[winner_idx].is_primary = true;
        primary.insert(
            item_key,
            (
                edges[winner_idx].offer_namespace.clone(),
                edges[winner_idx].offer_id.clone(),
            ),
        );
    }

    let mut app_records = Vec::<CatalogReleaseAppRecord>::new();
    let mut app_index = HashMap::<(String, String, String, String), usize>::new();
    for item in &items {
        let primary_offer = primary.get(&composite(&item.record.namespace, &item.record.id));
        for release in &item.release_apps {
            for platform in &release.platforms {
                let record = CatalogReleaseAppRecord {
                    namespace: item.record.namespace.clone(),
                    app_id: release.app_id.clone(),
                    platform: platform.clone(),
                    item_namespace: item.record.namespace.clone(),
                    item_id: item.record.id.clone(),
                    release_id: release.release_id.clone(),
                    primary_offer_namespace: primary_offer.map(|(ns, _)| ns.clone()),
                    primary_offer_id: primary_offer.map(|(_, id)| id.clone()),
                };
                let key = (
                    record.namespace.clone(),
                    record.app_id.clone(),
                    record.platform.clone(),
                    record.item_id.clone(),
                );
                if let Some(&idx) = app_index.get(&key) {
                    app_records[idx] = record;
                } else {
                    app_index.insert(key, app_records.len());
                    app_records.push(record);
                }
            }
        }
    }
    let mut result = Vec::with_capacity(
        offers.len() + items.len() + assets.len() + app_records.len() + edges.len(),
    );
    for offer in offers {
        result.push(CatalogRecord::Offer(offer.record));
    }
    for item in items {
        let mut record = item.record;
        if let Some((ns, id)) = primary.get(&composite(&record.namespace, &record.id)) {
            record.primary_offer_namespace = Some(ns.clone());
            record.primary_offer_id = Some(id.clone());
        }
        result.push(CatalogRecord::Item(record));
    }
    for mut asset in assets {
        if let Some((ns, id)) = primary.get(&composite(&asset.item_namespace, &asset.item_id)) {
            asset.primary_offer_namespace = Some(ns.clone());
            asset.primary_offer_id = Some(id.clone());
        }
        result.push(CatalogRecord::Asset(asset));
    }

    for app in app_records {
        result.push(CatalogRecord::ReleaseApp(app));
    }
    for edge in edges {
        result.push(CatalogRecord::OfferItem(edge));
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn catalog_sorting_matches_node_locale_compare_and_integer_keys() {
        let values = ["10", "2", "_", "-", "a", "A", "á", "ä", "e", "É", "z"];
        let collator = node_collator();
        assert!(CatalogCollation::for_locale("invalid locale!").is_err());
        for locale in [None, Some("invalid locale!"), Some("en-US-u-co-unknown")] {
            assert!(collator_for_host(locale).compare("ä", "z").is_lt());
        }
        assert!(collator_for_host(Some("sv-SE")).compare("ä", "z").is_gt());
        assert_eq!(
            serde_json::to_string(&normalize_json_value(
                &json!({"name": "fixture", "2": "two"}),
                &collator
            ))
            .unwrap(),
            r#"{"2":"two","name":"fixture"}"#
        );
        let mut sorted = values.to_vec();
        sorted.sort_by(|left, right| collator.compare(left, right));
        assert_eq!(
            sorted,
            ["_", "-", "10", "2", "a", "A", "á", "ä", "e", "É", "z"]
        );

        let raw = json!({
            "namespace": "ns", "id": "offer", "title": "Sorted",
            "items": [], "keyImages": values.map(|value| json!({"type":value,"url":format!("https://example.test/{value}")})),
            "tags": values.map(|id| json!({"id":id})), "categories": [],
            "customAttributes": values.map(|key| json!({"key":key,"value":"v"})),
        });
        let projected = project_offer(&raw).unwrap().record;
        assert_eq!(
            projected
                .key_images
                .iter()
                .map(|image| image.image_type.as_str())
                .collect::<Vec<_>>(),
            sorted
        );
        assert_eq!(
            projected
                .tags
                .iter()
                .map(|tag| tag.id.as_str())
                .collect::<Vec<_>>(),
            sorted
        );
        assert_eq!(
            projected
                .custom_attributes
                .iter()
                .map(|attribute| attribute.key.as_str())
                .collect::<Vec<_>>(),
            sorted
        );

        let items = [json!({"namespace":"ns","id":"item","title":"Item"})];
        let offers: Vec<_> = ["á", "_", "-", "2", "10"]
            .into_iter()
            .map(|id| {
                json!({
                    "namespace":"ns", "id":id, "title":"Offer", "offerType":"BASE_GAME",
                    "prePurchase":false, "items":[{"namespace":"ns","id":"item"}]
                })
            })
            .collect();
        let graph = project_catalog_graph(&CatalogProjectionSources {
            offers: &offers,
            items: &items,
            assets: &[],
            sub_items: &[],
        })
        .unwrap();
        let primary = graph.iter().find_map(|record| match record {
            CatalogRecord::OfferItem(edge) if edge.is_primary => Some(edge.offer_id.as_str()),
            _ => None,
        });
        assert_eq!(primary, Some("_"));

        let keys = json!({"10":"ten","2":"two","01":"leading","4294967295":"max","á":"accent","_":"under","-":"dash"});
        assert_eq!(
            stable_json(&keys),
            "{\"2\":\"two\",\"10\":\"ten\",\"_\":\"under\",\"-\":\"dash\",\"01\":\"leading\",\"4294967295\":\"max\",\"á\":\"accent\"}"
        );

        let records: Vec<_> = ["á", "_", "-", "2", "10"]
            .into_iter()
            .map(|record_key| CatalogHydrationRecord {
                record_key: record_key.into(),
                sha256: format!("{record_key:0<64}"),
                record: serde_json::from_value(json!({
                    "type":"item", "namespace":"n", "id":record_key, "title":"",
                    "keyImages":[], "categories":[], "customAttributes":[], "eulaIds":[], "installModes":[]
                })).unwrap(),
            })
            .collect();
        assert_eq!(
            graph_hash_for_records(&records),
            "38f18bf793168a485e8144c01399495c2fcef4779be7a9956f875307c902067a"
        );
    }

    #[test]
    fn hydration_keys_stable_json_and_graph_hash_work_deterministically() {
        assert_eq!(CATALOG_HYDRATION_SCHEMA_VERSION, 2);
        assert_eq!(CATALOG_HYDRATION_MAX_IDENTIFIERS, 25);
        assert_eq!(CATALOG_HYDRATION_MAX_KNOWN_RECORDS, 5_000);
        assert_eq!(CATALOG_HYDRATION_MAX_ROOT_RECORDS, 500);
        assert_eq!(CATALOG_HYDRATION_MAX_LINE_BYTES, 2 * 1024 * 1024);

        assert_eq!(
            catalog_hydration_root_key(&CatalogHydrationIdentifier::Item {
                namespace: " NS ".into(),
                id: "Item 1".into(),
            }),
            "item:ns:item%201"
        );
        assert_eq!(
            catalog_hydration_root_key(&CatalogHydrationIdentifier::Asset {
                namespace: "ns".into(),
                artifact_id: "Art".into(),
                platform: "Windows".into(),
            }),
            "asset:ns:art:windows"
        );
        assert_eq!(
            catalog_hydration_root_key(&CatalogHydrationIdentifier::ReleaseApp {
                namespace: "ns".into(),
                app_id: "App".into(),
                platform: "Mac".into(),
            }),
            "release-app:ns:app:mac"
        );

        let a = stable_json(&json!({ "b": 1, "a": [{ "d": 2, "c": 3 }] }));
        let b = stable_json(&json!({ "a": [{ "c": 3, "d": 2 }], "b": 1 }));
        assert_eq!(a, b);
        assert_eq!(a, r#"{"a":[{"c":3,"d":2}],"b":1}"#);

        let make_hash = |title: &str| {
            let record = CatalogRecord::Item(CatalogItemRecord {
                namespace: "ns".into(),
                id: "item".into(),
                title: title.into(),
                description: None,
                long_description: None,
                technical_details: None,
                status: None,
                entitlement_name: None,
                entitlement_type: None,
                item_type: None,
                key_images: vec![],
                categories: vec![],
                custom_attributes: vec![],
                creation_date: None,
                last_modified_date: None,
                developer: None,
                developer_id: None,
                eula_ids: vec![],
                install_modes: vec![],
                end_of_support: None,
                self_refundable: None,
                application_id: None,
                unsearchable: None,
                requires_secure_account: None,
                entitlement_start_date: None,
                entitlement_end_date: None,
                use_count: None,
                primary_offer_namespace: None,
                primary_offer_id: None,
            });
            let envelope = CatalogHydrationRecord {
                record_key: catalog_record_key(&record),
                sha256: sha256_hex(&stable_json(&serde_json::to_value(&record).unwrap())),
                record,
            };
            let second = CatalogHydrationRecord {
                record_key: "offer:ns:off".into(),
                sha256: "abc".into(),
                record: envelope.record.clone(),
            };
            graph_hash_for_records(&[envelope, second])
        };
        assert_ne!(make_hash("First"), make_hash("Second"));
    }

    #[test]
    fn record_keys_cover_all_catalog_record_variants() {
        let offer = CatalogRecord::Offer(CatalogOfferRecord {
            namespace: "ns".into(),
            id: "off".into(),
            title: "t".into(),
            description: None,
            long_description: None,
            offer_type: None,
            seller: None,
            developer_display_name: None,
            publisher_display_name: None,
            product_slug: None,
            url_slug: None,
            url: None,
            key_images: vec![],
            tags: vec![],
            categories: vec![],
            custom_attributes: vec![],
            effective_date: None,
            creation_date: None,
            last_modified_date: None,
            release_date: None,
            pc_release_date: None,
            viewable_date: None,
            pre_purchase: None,
            is_code_redemption_only: None,
            countries_blacklist: vec![],
            countries_whitelist: vec![],
            refund_type: None,
            offer_mappings: vec![],
        });
        assert_eq!(catalog_record_key(&offer), "offer:ns:off");

        let asset = CatalogRecord::Asset(CatalogAssetRecord {
            namespace: "ns".into(),
            artifact_id: "art".into(),
            platform: "Win".into(),
            item_namespace: "ns".into(),
            item_id: "it".into(),
            download_size_bytes: None,
            installed_size_bytes: None,
            primary_offer_namespace: None,
            primary_offer_id: None,
        });
        assert_eq!(catalog_record_key(&asset), "asset:ns:art:win:ns:it");

        let app = CatalogRecord::ReleaseApp(CatalogReleaseAppRecord {
            namespace: "ns".into(),
            app_id: "app".into(),
            platform: "Win".into(),
            item_namespace: "ns".into(),
            item_id: "it".into(),
            release_id: None,
            primary_offer_namespace: None,
            primary_offer_id: None,
        });
        assert_eq!(catalog_record_key(&app), "release-app:ns:app:win:ns:it");

        let edge = CatalogRecord::OfferItem(CatalogOfferItemRecord {
            offer_namespace: "ns".into(),
            offer_id: "off".into(),
            item_namespace: "ns".into(),
            item_id: "it".into(),
            sources: vec![CatalogOfferItemSource::Direct],
            is_primary: true,
        });
        assert_eq!(catalog_record_key(&edge), "offer-item:ns:off:ns:it");
    }

    #[test]
    fn project_catalog_graph_deduplicates_sources_and_ranks_primary_offer() {
        let item_doc = |id: &str, linked: Vec<&str>| {
            json!({
                "namespace": "ns",
                "id": id,
                "title": format!("Item {id}"),
                "linkedOffers": linked,
                "keyImages": [{ "type": "Thumbnail", "url": "https://cdn/a.png", "md5": "abc" }],
                "categories": ["games", { "path": "action" }],
                "customAttributes": [{ "key": "canRunOffline", "value": "true", "type": "STRING" }],
                "installModes": [],
                "releaseInfo": [{ "id": format!("release-{id}"), "appId": format!("app-{id}"), "platform": ["Windows"] }],
                "unsearchable": true,
                "useCount": 1.0,
                "creationDate": { "$date": "2024-01-01" },
                "lastModifiedDate": "2024-01-02T00:00:00Z",
                "entitlementStartDate": 1704067200000_i64,
                "entitlementEndDate": "2024-01-03T00:00:00.000"
            })
        };

        let offers = vec![
            json!({
                "namespace": "ns",
                "id": "base",
                "title": "Base",
                "offerType": "BASE_GAME",
                "prePurchase": false,
                "seller": { "id": "sel", "name": "Seller" },
                "offerMappings": [{ "pageSlug": "base", "pageType": "productHome" }],
                "tags": [{ "id": "123", "name": "Tag" }],
                "items": [{ "namespace": "ns", "id": "owned" }],
                "lastModifiedDate": "2024-01-01T00:00:00Z"
            }),
            json!({
                "namespace": "ns",
                "id": "prepurchase",
                "title": "Prepurchase",
                "offerType": "BASE_GAME",
                "prePurchase": true,
                "items": [{ "namespace": "ns", "id": "owned" }]
            }),
            json!({
                "namespace": "ns",
                "id": "dlc",
                "title": "DLC",
                "offerType": "DLC",
                "prePurchase": false,
                "items": [{ "id": "sibling" }],
                "lastModifiedDate": "2024-01-01T00:00:00Z"
            }),
            json!({
                "namespace": "ns",
                "id": "edition",
                "title": "Edition",
                "offerType": "EDITION",
                "prePurchase": false,
                "items": [{ "id": "sibling" }],
                "lastModifiedDate": "2024-02-01T00:00:00Z"
            }),
        ];
        let items = vec![
            item_doc("owned", vec!["base"]),
            item_doc("sibling", vec!["dlc", "edition"]),
            json!({
                "namespace": "ns",
                "id": "unlinked",
                "title": "Unlinked",
                "releaseInfo": [{ "appId": "app-unlinked", "platform": [] }, { "appId": "app-unlinked", "platform": ["Mac"] }]
            }),
        ];
        let assets = vec![json!({
            "namespace": "ns",
            "artifactId": "artifact",
            "platform": "Windows",
            "itemId": "owned",
            "downloadSizeBytes": 100,
            "installedSizeBytes": 200.5
        })];
        let sub_items = vec![
            json!("ignored"),
            json!({
                "_id": "base",
                "namespace": "ns",
                "subItems": [
                    { "namespace": "ns", "id": "owned" },
                    { "namespace": "ns", "id": "sibling" },
                    { "id": "" }
                ]
            }),
        ];

        let records = project_catalog_graph(&CatalogProjectionSources {
            offers: &offers,
            items: &items,
            assets: &assets,
            sub_items: &sub_items,
        })
        .unwrap();

        let owned_edge = records
            .iter()
            .find_map(|r| match r {
                CatalogRecord::OfferItem(e) if e.offer_id == "base" && e.item_id == "owned" => {
                    Some(e)
                }
                _ => None,
            })
            .expect("owned edge");
        assert_eq!(
            owned_edge.sources,
            vec![
                CatalogOfferItemSource::Direct,
                CatalogOfferItemSource::Subitem,
                CatalogOfferItemSource::Linked,
            ]
        );
        assert!(owned_edge.is_primary);

        let owned_item = records
            .iter()
            .find_map(|r| match r {
                CatalogRecord::Item(i) if i.id == "owned" => Some(i),
                _ => None,
            })
            .unwrap();
        assert_eq!(owned_item.primary_offer_id.as_deref(), Some("base"));
        assert_eq!(owned_item.unsearchable, Some(true));

        let sibling_primary = records
            .iter()
            .find_map(|r| match r {
                CatalogRecord::OfferItem(e) if e.item_id == "sibling" && e.is_primary => Some(e),
                _ => None,
            })
            .unwrap();
        // `base` has subitem vs `dlc`/`edition` direct, and direct ranks before subitem;
        // between `dlc` (DLC) and `edition` (EDITION), DLC ranks before EDITION!
        assert_eq!(sibling_primary.offer_id, "dlc");

        assert!(records.iter().any(|r| matches!(
            r,
            CatalogRecord::ReleaseApp(app) if app.app_id == "app-owned" && app.platform == "Windows"
        )));
    }

    #[test]
    fn project_validation_rejects_invalid_and_oversized_inputs() {
        assert!(project_offer(&json!(null)).is_err());
        assert!(project_offer(&json!({ "id": "1", "title": "t" })).is_err());
        assert!(project_offer(&json!({ "namespace": "ns", "title": "t" })).is_err());
        assert!(project_offer(&json!({ "namespace": "ns", "id": "1" })).is_err());

        assert!(project_item(&json!(null)).is_err());
        assert!(project_item(&json!({ "id": "1", "title": "t" })).is_err());
        assert!(project_item(&json!({ "namespace": "ns", "title": "t" })).is_err());
        assert!(project_item(&json!({ "namespace": "ns", "id": "1" })).is_err());

        assert!(project_asset(&json!(null)).is_err());
        assert!(
            project_asset(&json!({ "artifactId": "a", "platform": "p", "itemId": "i" })).is_err()
        );
        assert!(project_asset(&json!({ "namespace": "ns" })).is_err());
        assert!(project_asset(&json!({ "namespace": "ns", "artifactId": "a" })).is_err());
        assert!(
            project_asset(&json!({ "namespace": "ns", "artifactId": "a", "platform": "p" }))
                .is_err()
        );

        // Graph error propagation for invalid offers, items, and assets
        assert!(
            project_catalog_graph(&CatalogProjectionSources {
                offers: &[json!(null)],
                items: &[],
                assets: &[],
                sub_items: &[],
            })
            .is_err()
        );
        assert!(
            project_catalog_graph(&CatalogProjectionSources {
                offers: &[],
                items: &[json!(null)],
                assets: &[],
                sub_items: &[],
            })
            .is_err()
        );
        assert!(
            project_catalog_graph(&CatalogProjectionSources {
                offers: &[],
                items: &[],
                assets: &[json!(null)],
                sub_items: &[],
            })
            .is_err()
        );

        let huge_array = vec![json!("a"); MAX_ARRAY + 1];
        assert!(
            project_item(&json!({
                "namespace": "ns",
                "id": "1",
                "title": "t",
                "releaseInfo": [{ "appId": "app", "platform": huge_array }]
            }))
            .is_ok()
        );
        for field in [
            "offerMappings",
            "items",
            "keyImages",
            "tags",
            "categories",
            "customAttributes",
            "countriesBlacklist",
            "countriesWhitelist",
        ] {
            assert!(
                project_offer(&json!({
                    "namespace": "ns",
                    "id": "1",
                    "title": "t",
                    field: huge_array
                }))
                .is_err()
            );
        }
        for field in [
            "releaseInfo",
            "keyImages",
            "categories",
            "customAttributes",
            "eulaIds",
            "installModes",
            "linkedOffers",
        ] {
            assert!(
                project_item(&json!({
                    "namespace": "ns",
                    "id": "1",
                    "title": "t",
                    field: huge_array
                }))
                .is_err()
            );
        }
        assert!(
            project_catalog_graph(&CatalogProjectionSources {
                offers: &[],
                items: &[],
                assets: &[],
                sub_items: &[json!({ "_id": "off", "subItems": huge_array })],
            })
            .is_err()
        );

        // Exercise edge-case date/number branches
        assert!(opt_non_negative_number(Some(&json!(-1))).is_none());
        assert!(opt_non_negative_number(Some(&json!(-1.5))).is_none());
        assert!(opt_non_negative_number(Some(&json!(1.5))).is_some());
        assert!(opt_non_negative_number(Some(&json!("1"))).is_none());
        assert!(catalog_date(Some(&json!("not-a-date"))).is_none());
        assert!(catalog_date(Some(&json!(1e20))).is_none());
        assert!(catalog_date(Some(&json!(true))).is_none());
        assert_eq!(offer_type_rank(Some("ADD_ON")), 2);
        assert_eq!(offer_type_rank(Some("BUNDLE")), 4);
        assert_eq!(offer_type_rank(Some("CONSUMABLE")), 5);
        assert_eq!(offer_type_rank(Some("OTHER")), 99);
    }

    #[test]
    fn project_graph_exercises_sorting_resolution_and_tiebreakers() {
        let records = project_catalog_graph(&CatalogProjectionSources {
            offers: &[
                json!({
                    "namespace": "ns-a",
                    "id": "same-date-a",
                    "title": "A",
                    "offerType": "BASE_GAME",
                    "lastModifiedDate": "2024-01-01T00:00:00Z",
                    "seller": { "id": "", "name": "Bad" },
                    "offerMappings": [123, { "pageSlug": "", "pageType": "x" }, { "pageSlug": "s" }],
                    "keyImages": [
                        123,
                        { "type": "", "url": "https://x" },
                        { "type": "T", "url": "" },
                        { "type": "B", "url": "https://b" },
                        { "type": "A", "url": "https://a" }
                    ],
                    "tags": [123, { "id": "" }, { "id": "2" }, { "id": "1", "name": "One" }],
                    "customAttributes": [
                        123,
                        { "key": "", "value": "x" },
                        { "key": "k" },
                        { "key": "z", "value": "1" },
                        { "key": "a", "value": "2" }
                    ],
                    "items": [
                        123,
                        { "id": "" },
                        { "id": "missing-item" },
                        { "id": "ambiguous" },
                        { "id": "unique-in-b" }
                    ]
                }),
                json!({
                    "namespace": "ns-b",
                    "id": "newer",
                    "title": "Newer",
                    "offerType": "BASE_GAME",
                    "seller": { "id": "s", "name": "" },
                    "lastModifiedDate": "2024-06-01T00:00:00Z",
                    "items": [{ "namespace": "ns-b", "id": "unique-in-b" }]
                }),
                json!({
                    "namespace": "ns-c",
                    "id": "same-date-b",
                    "title": "B",
                    "offerType": "BASE_GAME",
                    "lastModifiedDate": "2024-06-01T00:00:00Z",
                    "items": [{ "namespace": "ns-b", "id": "unique-in-b" }]
                }),
            ],
            items: &[
                json!({
                    "namespace": "ns-b",
                    "id": "ambiguous",
                    "title": "Amb B",
                    "categories": [123, { "path": "cat-a" }, "cat-b"],
                    "releaseInfo": [
                        123,
                        { "id": "no-app" },
                        { "appId": "dup-app", "platform": ["Windows"], "id": "r1" },
                        { "appId": "dup-app", "platform": ["Windows"], "id": "r2" }
                    ]
                }),
                json!({
                    "namespace": "ns-c",
                    "id": "ambiguous",
                    "title": "Amb C"
                }),
                json!({
                    "namespace": "ns-b",
                    "id": "unique-in-b",
                    "title": "Unique"
                }),
            ],
            assets: &[json!({
                "namespace": "ns-b",
                "artifactId": "unlinked-art",
                "platform": "Windows",
                "itemId": "ambiguous"
            })],
            sub_items: &[
                json!({ "no_id": true }),
                json!({
                    "_id": "newer",
                    "subItems": [{ "id": "unique-in-b" }]
                }),
                json!({
                    "_id": "same-date-a",
                    "subItems": [123, { "id": "unique-in-b" }]
                }),
            ],
        })
        .unwrap();

        let unique_item = records
            .iter()
            .find_map(|r| match r {
                CatalogRecord::Item(i) if i.id == "unique-in-b" => Some(i),
                _ => None,
            })
            .unwrap();
        // `newer` (ns-b) and `same-date-b` (ns-c) tie on date, so `ns-b\0newer` wins lexicographically.
        assert_eq!(unique_item.primary_offer_id.as_deref(), Some("newer"));

        // Hydration wire types serde roundtrip
        let req = CatalogHydrationRequest {
            schema_version: 2,
            identifiers: vec![CatalogHydrationIdentifier::Item {
                namespace: "ns".into(),
                id: "1".into(),
            }],
            known_roots: vec![CatalogHydrationKnownRoot {
                root_key: "item:ns:1".into(),
                graph_hash: "h".into(),
            }],
            known_records: vec![CatalogHydrationKnownRecord {
                record_key: "item:ns:1".into(),
                sha256: "s".into(),
            }],
        };
        let req_rt: CatalogHydrationRequest =
            serde_json::from_value(serde_json::to_value(&req).unwrap()).unwrap();
        assert_eq!(req_rt, req);

        let root_res = CatalogHydrationRootResult::NotFound {
            schema_version: 2,
            root_key: "item:ns:1".into(),
            identifier: req.identifiers[0].clone(),
            hydrated_at: "2026-01-01T00:00:00.000Z".into(),
        };
        let res_rt: CatalogHydrationRootResult =
            serde_json::from_value(serde_json::to_value(&root_res).unwrap()).unwrap();
        assert_eq!(res_rt, root_res);
    }
}
