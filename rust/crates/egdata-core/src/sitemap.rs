//! Offer sitemap URL generation, sandbox OG asset counting, DLC requirements inheritance, and token encryption.

use crate::error::CoreError;
use aes::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit, block_padding::Pkcs7};
use chrono::{DateTime, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;
type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;

/// Maximum URLs permitted per sitemap file by the sitemap specification.
pub const SITEMAP_URL_LIMIT: usize = 50_000;

/// Sub-sections emitted per offer in sitemaps (currently empty).
pub const OFFER_SITEMAP_SECTIONS: &[&str] = &[];

/// All 32 localized route prefixes supported for offer sitemap `hreflang` alternates.
pub const OFFER_SITEMAP_LOCALES: &[&str] = &[
    "id", "ms", "da", "de", "en-US", "es-ES", "es-MX", "fil", "fr", "it", "hu", "nl", "no", "pl",
    "pt-BR", "pt", "ro", "fi", "sv", "vi", "tr", "cs", "bg", "ru", "uk", "ar", "hi", "th", "ja",
    "zh-CN", "zh-Hant", "ko",
];

/// Number of canonical sitemap URLs generated per offer.
pub const OFFER_SITEMAP_URLS_PER_OFFER: usize = OFFER_SITEMAP_SECTIONS.len() + 1;

/// Safe upper bound on offers per sitemap page to keep generated XML compact.
pub const OFFER_SITEMAP_FILE_SIZE_SAFE_PAGE_LIMIT: usize = 500;

/// Effective number of offers per sitemap page.
pub const OFFER_SITEMAP_PAGE_LIMIT: usize =
    if SITEMAP_URL_LIMIT / OFFER_SITEMAP_URLS_PER_OFFER < OFFER_SITEMAP_FILE_SIZE_SAFE_PAGE_LIMIT {
        SITEMAP_URL_LIMIT / OFFER_SITEMAP_URLS_PER_OFFER
    } else {
        OFFER_SITEMAP_FILE_SIZE_SAFE_PAGE_LIMIT
    };

/// Alternate localized URL entry in an offer sitemap record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OfferSitemapAlternate {
    pub hreflang: String,
    pub href: String,
}

/// Canonical sitemap URL with its `x-default` and localized alternates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OfferSitemapEntry {
    pub loc: String,
    pub alternates: Vec<OfferSitemapAlternate>,
}

fn offer_sitemap_alternates(offer_id: &str, route_suffix: &str) -> Vec<OfferSitemapAlternate> {
    let mut alternates = Vec::with_capacity(OFFER_SITEMAP_LOCALES.len() + 1);
    alternates.push(OfferSitemapAlternate {
        hreflang: "x-default".to_string(),
        href: format!("https://egdata.app/offers/{offer_id}{route_suffix}"),
    });
    for locale in OFFER_SITEMAP_LOCALES {
        alternates.push(OfferSitemapAlternate {
            hreflang: (*locale).to_string(),
            href: format!("https://egdata.app/{locale}/offers/{offer_id}{route_suffix}"),
        });
    }
    alternates
}

/// Generate sitemap entries (canonical `loc` and 33 `hreflang` alternates) for `offer_id`.
pub fn get_offer_sitemap_entries(offer_id: &str) -> Vec<OfferSitemapEntry> {
    get_offer_sitemap_entries_with_sections(offer_id, OFFER_SITEMAP_SECTIONS)
}

fn get_offer_sitemap_entries_with_sections(
    offer_id: &str,
    sections: &[&str],
) -> Vec<OfferSitemapEntry> {
    std::iter::once("")
        .chain(sections.iter().copied())
        .map(|section| {
            let suffix = if section.is_empty() {
                String::new()
            } else {
                format!("/{section}")
            };
            OfferSitemapEntry {
                loc: format!("https://egdata.app/offers/{offer_id}{suffix}"),
                alternates: offer_sitemap_alternates(offer_id, &suffix),
            }
        })
        .collect()
}

/// Return only the canonical sitemap URLs for `offer_id`.
pub fn get_offer_sitemap_urls(offer_id: &str) -> Vec<String> {
    get_offer_sitemap_entries(offer_id)
        .into_iter()
        .map(|entry| entry.loc)
        .collect()
}

/// Minimal asset representation for sandbox OG counting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxOgAsset {
    pub artifact_id: String,
}

/// Release metadata inside a catalog item for sandbox OG counting.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxOgReleaseInfo {
    pub app_id: Option<String>,
    pub platform: Option<Vec<String>>,
}

/// Minimal catalog item representation for sandbox OG counting.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxOgItem {
    pub release_info: Option<Vec<SandboxOgReleaseInfo>>,
}

/// Count stored assets plus virtual release platforms not already represented by a stored `artifactId`.
pub fn count_sandbox_og_assets(assets: &[SandboxOgAsset], items: &[SandboxOgItem]) -> usize {
    let known: HashSet<&str> = assets.iter().map(|a| a.artifact_id.as_str()).collect();
    let virtual_count: usize = items
        .iter()
        .flat_map(|item| item.release_info.as_deref().unwrap_or(&[]))
        .map(|release| match release.app_id.as_deref() {
            Some(app_id) if !app_id.is_empty() && !known.contains(app_id) => {
                release.platform.as_ref().map_or(0, Vec::len)
            }
            _ => 0,
        })
        .sum();

    assets.len() + virtual_count
}

/// Supported platforms for `offer_requirements` documents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RequirementsPlatform {
    Windows,
    Macos,
}

/// Offer type stored on an `offer_requirements` document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RequirementsOfferType {
    #[serde(rename = "BASE_GAME")]
    BaseGame,
    #[serde(rename = "DLC")]
    Dlc,
}

/// Ingestion source classification for `offer_requirements`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequirementsSourceType {
    ProductPage,
    StoreConfiguration,
    ConfirmedAbsent,
    Inherited,
}

/// Processing lifecycle state of an `offer_requirements` document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequirementsProcessingState {
    Pending,
    InProgress,
    Normalized,
    Inherited,
    Empty,
    Stale,
    Failed,
    Unknown,
}

/// Source provenance block on an `offer_requirements` document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequirementsSource {
    pub source_type: RequirementsSourceType,
    pub observed_at: DateTime<Utc>,
    pub raw_rows: Vec<Value>,
}

/// Processing metadata block on an `offer_requirements` document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequirementsProcessing {
    pub source_generation: u64,
    pub state: RequirementsProcessingState,
}

/// Optional parent base-game link on a DLC requirements document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequirementsParentRef {
    pub parent_namespace: Option<String>,
    pub parent_offer_id: Option<String>,
    pub relationship_type: Option<String>,
    pub resolved_inheritance: bool,
}

/// Minimum and recommended system requirement tiers.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RequirementsTiers {
    pub minimum: Option<Value>,
    pub recommended: Option<Value>,
}

/// Stored `offer_requirements` MongoDB document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfferRequirementsDocument {
    pub namespace: String,
    pub offer_id: String,
    pub platform: RequirementsPlatform,
    pub offer_type: RequirementsOfferType,
    pub source: RequirementsSource,
    pub processing: RequirementsProcessing,
    pub parent: Option<RequirementsParentRef>,
    pub requirements: RequirementsTiers,
}

/// Parent reference exposed on a [`ResolvedOfferRequirements`] response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedRequirementsParent {
    pub namespace: Option<String>,
    pub offer_id: Option<String>,
    pub relationship_type: Option<String>,
}

/// Resolved offer requirements response after applying DLC inheritance rules.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedOfferRequirements {
    pub namespace: String,
    pub offer_id: String,
    pub platform: RequirementsPlatform,
    pub offer_type: RequirementsOfferType,
    pub inherited: bool,
    pub is_inherited: bool,
    pub parent_offer_id: Option<String>,
    pub parent: Option<ResolvedRequirementsParent>,
    pub state: RequirementsProcessingState,
    pub source_generation: u64,
    pub observed_at: DateTime<Utc>,
    pub requirements: RequirementsTiers,
}

fn has_requirements(tiers: &RequirementsTiers) -> bool {
    tiers.minimum.is_some() || tiers.recommended.is_some()
}

/// Determine whether the caller should fetch a parent base-game requirements document.
pub fn should_fetch_parent_requirements(
    own_doc: &OfferRequirementsDocument,
) -> Option<(String, String, RequirementsPlatform)> {
    if has_requirements(&own_doc.requirements)
        || own_doc.offer_type != RequirementsOfferType::Dlc
        || matches!(
            own_doc.processing.state,
            RequirementsProcessingState::Failed | RequirementsProcessingState::Stale
        )
    {
        return None;
    }

    let parent_offer_id = own_doc
        .parent
        .as_ref()
        .and_then(|p| p.parent_offer_id.as_deref())
        .filter(|id| !id.is_empty())?;
    let parent_namespace = own_doc
        .parent
        .as_ref()
        .and_then(|p| p.parent_namespace.as_deref())
        .filter(|ns| !ns.is_empty())
        .unwrap_or(&own_doc.namespace);

    Some((
        parent_namespace.to_string(),
        parent_offer_id.to_string(),
        own_doc.platform,
    ))
}

/// Pure DLC inheritance decision helper matching `resolveOfferRequirements` in TypeScript.
pub fn resolve_dlc_inheritance(
    own_doc: &OfferRequirementsDocument,
    parent_doc: Option<&OfferRequirementsDocument>,
) -> ResolvedOfferRequirements {
    let own_parent_offer_id = own_doc
        .parent
        .as_ref()
        .and_then(|p| p.parent_offer_id.clone())
        .filter(|id| !id.is_empty());
    let own_parent_namespace = own_doc
        .parent
        .as_ref()
        .and_then(|p| p.parent_namespace.clone())
        .filter(|ns| !ns.is_empty())
        .unwrap_or_else(|| own_doc.namespace.clone());
    let relationship_type = own_doc
        .parent
        .as_ref()
        .and_then(|p| p.relationship_type.clone())
        .filter(|rel| !rel.is_empty());

    let make_parent = || {
        own_parent_offer_id
            .as_ref()
            .map(|id| ResolvedRequirementsParent {
                namespace: Some(own_parent_namespace.clone()),
                offer_id: Some(id.clone()),
                relationship_type: relationship_type.clone(),
            })
    };

    if has_requirements(&own_doc.requirements) {
        return ResolvedOfferRequirements {
            namespace: own_doc.namespace.clone(),
            offer_id: own_doc.offer_id.clone(),
            platform: own_doc.platform,
            offer_type: own_doc.offer_type,
            inherited: false,
            is_inherited: false,
            parent_offer_id: own_parent_offer_id.clone(),
            parent: make_parent(),
            state: own_doc.processing.state,
            source_generation: own_doc.processing.source_generation,
            observed_at: own_doc.source.observed_at,
            requirements: own_doc.requirements.clone(),
        };
    }

    if own_doc.offer_type != RequirementsOfferType::Dlc {
        return ResolvedOfferRequirements {
            namespace: own_doc.namespace.clone(),
            offer_id: own_doc.offer_id.clone(),
            platform: own_doc.platform,
            offer_type: own_doc.offer_type,
            inherited: false,
            is_inherited: false,
            parent_offer_id: None,
            parent: None,
            state: own_doc.processing.state,
            source_generation: own_doc.processing.source_generation,
            observed_at: own_doc.source.observed_at,
            requirements: own_doc.requirements.clone(),
        };
    }

    if matches!(
        own_doc.processing.state,
        RequirementsProcessingState::Failed | RequirementsProcessingState::Stale
    ) {
        return ResolvedOfferRequirements {
            namespace: own_doc.namespace.clone(),
            offer_id: own_doc.offer_id.clone(),
            platform: own_doc.platform,
            offer_type: own_doc.offer_type,
            inherited: false,
            is_inherited: false,
            parent_offer_id: None,
            parent: None,
            state: own_doc.processing.state,
            source_generation: own_doc.processing.source_generation,
            observed_at: own_doc.source.observed_at,
            requirements: RequirementsTiers::default(),
        };
    }

    let valid_parent = own_parent_offer_id.as_deref().and_then(|parent_id| {
        let p = parent_doc?;
        let own_parent = own_doc
            .parent
            .as_ref()
            .expect("parent present when parent_offer_id is Some");
        let valid = own_doc.source.source_type == RequirementsSourceType::ConfirmedAbsent
            && own_doc.source.raw_rows.is_empty()
            && own_parent.resolved_inheritance
            && relationship_type.is_some()
            && p.offer_type == RequirementsOfferType::BaseGame
            && p.offer_id == parent_id
            && p.namespace == own_parent_namespace
            && p.platform == own_doc.platform
            && matches!(
                p.processing.state,
                RequirementsProcessingState::Normalized | RequirementsProcessingState::Stale
            )
            && has_requirements(&p.requirements);
        valid.then_some(p)
    });

    let Some(parent) = valid_parent else {
        return ResolvedOfferRequirements {
            namespace: own_doc.namespace.clone(),
            offer_id: own_doc.offer_id.clone(),
            platform: own_doc.platform,
            offer_type: own_doc.offer_type,
            inherited: false,
            is_inherited: false,
            parent_offer_id: own_parent_offer_id.clone(),
            parent: make_parent(),
            state: RequirementsProcessingState::Unknown,
            source_generation: own_doc.processing.source_generation,
            observed_at: own_doc.source.observed_at,
            requirements: RequirementsTiers::default(),
        };
    };

    ResolvedOfferRequirements {
        namespace: own_doc.namespace.clone(),
        offer_id: own_doc.offer_id.clone(),
        platform: own_doc.platform,
        offer_type: own_doc.offer_type,
        inherited: true,
        is_inherited: true,
        parent_offer_id: own_parent_offer_id.clone(),
        parent: make_parent(),
        state: if parent.processing.state == RequirementsProcessingState::Stale {
            RequirementsProcessingState::Stale
        } else {
            RequirementsProcessingState::Inherited
        },
        source_generation: own_doc.processing.source_generation,
        observed_at: parent.source.observed_at,
        requirements: parent.requirements.clone(),
    }
}

/// Encrypt `text` using AES-256-CBC with a random 16-byte IV, formatted as `${ivHex}:${cipherHex}`.
pub fn encrypt(text: &str, key: &[u8]) -> Result<String, CoreError> {
    let mut iv = [0u8; 16];
    rand::rng().fill_bytes(&mut iv);
    encrypt_with_iv(text, key, &iv)
}

/// Deterministic AES-256-CBC encryption with caller-supplied 16-byte IV.
pub fn encrypt_with_iv(text: &str, key: &[u8], iv: &[u8; 16]) -> Result<String, CoreError> {
    encrypt_bytes_with_iv(text.as_bytes(), key, iv)
}

fn encrypt_bytes_with_iv(plaintext: &[u8], key: &[u8], iv: &[u8; 16]) -> Result<String, CoreError> {
    let cipher = Aes256CbcEnc::new_from_slices(key, iv)
        .map_err(|err| CoreError::InvalidInput(format!("Invalid encryption key: {err}")))?;
    let mut buf = vec![0u8; plaintext.len() + 16];
    buf[..plaintext.len()].copy_from_slice(plaintext);
    let encrypted = cipher
        .encrypt_padded_mut::<Pkcs7>(&mut buf, plaintext.len())
        .expect("buffer has 16 bytes spare for PKCS7 padding");
    Ok(format!("{}:{}", hex::encode(iv), hex::encode(encrypted)))
}

/// Decrypt a `${ivHex}:${cipherHex}` token produced by [`encrypt`].
pub fn decrypt(token: &str, key: &[u8]) -> Result<String, CoreError> {
    let (iv_hex, cipher_hex) = token
        .split_once(':')
        .ok_or_else(|| CoreError::InvalidInput("Invalid encrypted token format".to_string()))?;
    let iv = hex::decode(iv_hex)
        .map_err(|err| CoreError::InvalidInput(format!("Invalid IV hex: {err}")))?;
    let mut ciphertext = hex::decode(cipher_hex)
        .map_err(|err| CoreError::InvalidInput(format!("Invalid ciphertext hex: {err}")))?;

    let decipher = Aes256CbcDec::new_from_slices(key, &iv)
        .map_err(|err| CoreError::InvalidInput(format!("Invalid key or IV length: {err}")))?;
    let decrypted = decipher
        .decrypt_padded_mut::<Pkcs7>(&mut ciphertext)
        .map_err(|err| CoreError::InvalidInput(format!("Decryption failed: {err}")))?;

    String::from_utf8(decrypted.to_vec())
        .map_err(|err| CoreError::InvalidInput(format!("Decrypted token is not UTF-8: {err}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn offer_sitemap_generates_canonical_and_alternate_urls() {
        let urls = get_offer_sitemap_urls("offer-1");
        assert_eq!(urls, vec!["https://egdata.app/offers/offer-1"]);
        assert_eq!(OFFER_SITEMAP_LOCALES.len(), 32);
        assert_eq!(OFFER_SITEMAP_PAGE_LIMIT, 500);
        const { assert!(OFFER_SITEMAP_PAGE_LIMIT * OFFER_SITEMAP_URLS_PER_OFFER <= SITEMAP_URL_LIMIT) };

        let entries = get_offer_sitemap_entries("offer-1");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].loc, "https://egdata.app/offers/offer-1");
        assert_eq!(entries[0].alternates.len(), 33);
        assert_eq!(
            entries[0].alternates[0],
            OfferSitemapAlternate {
                hreflang: "x-default".into(),
                href: "https://egdata.app/offers/offer-1".into(),
            }
        );
        assert!(entries[0].alternates.contains(&OfferSitemapAlternate {
            hreflang: "es-ES".into(),
            href: "https://egdata.app/es-ES/offers/offer-1".into(),
        }));

        let with_section = get_offer_sitemap_entries_with_sections("offer-1", &["prices"]);
        assert_eq!(with_section.len(), 2);
        assert_eq!(
            with_section[1].loc,
            "https://egdata.app/offers/offer-1/prices"
        );
        let entry_rt: OfferSitemapEntry =
            serde_json::from_value(serde_json::to_value(&with_section[1]).unwrap()).unwrap();
        assert_eq!(entry_rt, with_section[1]);
    }

    #[test]
    fn count_sandbox_og_assets_excludes_stored_and_counts_virtual_platforms() {
        let assets = vec![SandboxOgAsset {
            artifact_id: "stored".into(),
        }];
        let items = vec![
            SandboxOgItem {
                release_info: Some(vec![
                    SandboxOgReleaseInfo {
                        app_id: Some("stored".into()),
                        platform: Some(vec!["Windows".into(), "Mac".into()]),
                    },
                    SandboxOgReleaseInfo {
                        app_id: Some("virtual".into()),
                        platform: Some(vec!["Windows".into(), "Mac".into()]),
                    },
                ]),
            },
            SandboxOgItem {
                release_info: Some(vec![
                    SandboxOgReleaseInfo {
                        app_id: Some("virtual".into()),
                        platform: None,
                    },
                    SandboxOgReleaseInfo {
                        app_id: None,
                        platform: Some(vec!["Windows".into()]),
                    },
                ]),
            },
            SandboxOgItem { release_info: None },
        ];
        assert_eq!(count_sandbox_og_assets(&assets, &items), 3);
        assert_eq!(count_sandbox_og_assets(&[], &[]), 0);
    }

    fn req_doc(
        offer_type: RequirementsOfferType,
        state: RequirementsProcessingState,
        source_type: RequirementsSourceType,
        minimum: Option<Value>,
    ) -> OfferRequirementsDocument {
        OfferRequirementsDocument {
            namespace: "ns".into(),
            offer_id: "offer-1".into(),
            platform: RequirementsPlatform::Windows,
            offer_type,
            source: RequirementsSource {
                source_type,
                observed_at: "2026-08-01T12:00:00Z".parse().unwrap(),
                raw_rows: vec![],
            },
            processing: RequirementsProcessing {
                source_generation: 4,
                state,
            },
            parent: Some(RequirementsParentRef {
                parent_namespace: Some("base-ns".into()),
                parent_offer_id: Some("base-offer".into()),
                relationship_type: Some("explicit_dlc".into()),
                resolved_inheritance: true,
            }),
            requirements: RequirementsTiers {
                minimum,
                recommended: None,
            },
        }
    }

    #[test]
    fn resolve_dlc_inheritance_covers_all_resolution_paths() {
        let min = json!({ "os": { "name": "Windows" } });

        // 1. Own requirements present -> no inheritance
        let own = req_doc(
            RequirementsOfferType::Dlc,
            RequirementsProcessingState::Normalized,
            RequirementsSourceType::ProductPage,
            Some(min.clone()),
        );
        assert!(should_fetch_parent_requirements(&own).is_none());
        let res_own = resolve_dlc_inheritance(&own, None);
        assert!(!res_own.inherited);
        assert_eq!(res_own.state, RequirementsProcessingState::Normalized);
        assert_eq!(res_own.parent_offer_id.as_deref(), Some("base-offer"));

        // 2. Non-DLC with empty requirements -> returns own state without parent
        let base_empty = req_doc(
            RequirementsOfferType::BaseGame,
            RequirementsProcessingState::Empty,
            RequirementsSourceType::ConfirmedAbsent,
            None,
        );
        assert!(should_fetch_parent_requirements(&base_empty).is_none());
        let res_base = resolve_dlc_inheritance(&base_empty, None);
        assert!(!res_base.inherited);
        assert!(res_base.parent.is_none());
        assert_eq!(res_base.state, RequirementsProcessingState::Empty);

        // 3. Failed / stale DLC -> avoids inheritance
        for terminal in [
            RequirementsProcessingState::Failed,
            RequirementsProcessingState::Stale,
        ] {
            let dlc_term = req_doc(
                RequirementsOfferType::Dlc,
                terminal,
                RequirementsSourceType::ConfirmedAbsent,
                None,
            );
            assert!(should_fetch_parent_requirements(&dlc_term).is_none());
            let res_term = resolve_dlc_inheritance(&dlc_term, None);
            assert!(!res_term.inherited);
            assert_eq!(res_term.state, terminal);
            assert!(res_term.parent.is_none());
        }

        // 4. Valid DLC inheritance (normalized parent and stale parent)
        let dlc_empty = req_doc(
            RequirementsOfferType::Dlc,
            RequirementsProcessingState::Empty,
            RequirementsSourceType::ConfirmedAbsent,
            None,
        );
        assert_eq!(
            should_fetch_parent_requirements(&dlc_empty),
            Some((
                "base-ns".into(),
                "base-offer".into(),
                RequirementsPlatform::Windows
            ))
        );
        let mut parent = req_doc(
            RequirementsOfferType::BaseGame,
            RequirementsProcessingState::Normalized,
            RequirementsSourceType::ProductPage,
            Some(min.clone()),
        );
        parent.namespace = "base-ns".into();
        parent.offer_id = "base-offer".into();
        parent.source.observed_at = "2026-08-05T00:00:00Z".parse().unwrap();

        let inherited = resolve_dlc_inheritance(&dlc_empty, Some(&parent));
        assert!(inherited.inherited);
        assert!(inherited.is_inherited);
        assert_eq!(inherited.state, RequirementsProcessingState::Inherited);
        assert_eq!(inherited.observed_at, parent.source.observed_at);
        assert_eq!(inherited.requirements.minimum, Some(min.clone()));

        parent.processing.state = RequirementsProcessingState::Stale;
        let inherited_stale = resolve_dlc_inheritance(&dlc_empty, Some(&parent));
        assert!(inherited_stale.inherited);
        assert_eq!(inherited_stale.state, RequirementsProcessingState::Stale);

        // 5. Missing/invalid parent -> unknown (including non-normalized parent state)
        let unknown = resolve_dlc_inheritance(&dlc_empty, None);
        assert!(!unknown.inherited);
        assert_eq!(unknown.state, RequirementsProcessingState::Unknown);
        assert_eq!(unknown.parent_offer_id.as_deref(), Some("base-offer"));

        parent.processing.state = RequirementsProcessingState::Pending;
        let pending_parent = resolve_dlc_inheritance(&dlc_empty, Some(&parent));
        assert!(!pending_parent.inherited);
        assert_eq!(pending_parent.state, RequirementsProcessingState::Unknown);

        let mut dlc_no_parent = dlc_empty.clone();
        dlc_no_parent.parent = None;
        assert!(should_fetch_parent_requirements(&dlc_no_parent).is_none());

        // Parent namespace defaults to own namespace when parent_namespace is None, and mismatch rejects
        let mut dlc_same_ns = dlc_empty.clone();
        dlc_same_ns.parent.as_mut().unwrap().parent_namespace = None;
        dlc_same_ns.parent.as_mut().unwrap().relationship_type = None;
        assert_eq!(
            should_fetch_parent_requirements(&dlc_same_ns),
            Some((
                "ns".into(),
                "base-offer".into(),
                RequirementsPlatform::Windows
            ))
        );
        parent.processing.state = RequirementsProcessingState::Normalized;
        let wrong_ns = resolve_dlc_inheritance(&dlc_same_ns, Some(&parent));
        assert_eq!(wrong_ns.state, RequirementsProcessingState::Unknown);

        // Serde roundtrips
        let doc_rt: OfferRequirementsDocument =
            serde_json::from_value(serde_json::to_value(&dlc_empty).unwrap()).unwrap();
        assert_eq!(doc_rt.offer_id, "offer-1");
        let res_rt: ResolvedOfferRequirements =
            serde_json::from_value(serde_json::to_value(&inherited).unwrap()).unwrap();
        assert_eq!(res_rt, inherited);
    }

    #[test]
    fn tokens_encrypt_and_decrypt_roundtrip_and_errors() {
        let key = b"0123456789abcdef0123456789abcdef";
        let payload = "epic-user-refresh-token-123";
        let token = encrypt(payload, key).expect("encrypts");
        assert_eq!(token.split(':').count(), 2);
        let iv_part = token.split(':').next().unwrap();
        assert_eq!(iv_part.len(), 32);
        assert_eq!(decrypt(&token, key).expect("decrypts"), payload);

        let fixed_iv = [0xabu8; 16];
        let det1 = encrypt_with_iv(payload, key, &fixed_iv).unwrap();
        let det2 = encrypt_with_iv(payload, key, &fixed_iv).unwrap();
        assert_eq!(det1, det2);
        assert_eq!(decrypt(&det1, key).unwrap(), payload);

        // Error branches
        assert!(encrypt(payload, b"short").is_err());
        assert!(decrypt("no-colon", key).is_err());
        assert!(decrypt("zzzz:0000", key).is_err());
        assert!(decrypt("0011:zzzz", key).is_err());
        assert!(decrypt("0011:0011", key).is_err());
        assert!(decrypt(&det1, b"wrong-32-byte-key-wrong-32-bytes").is_err());

        // Invalid UTF-8 after decryption
        let non_utf8_cipher = encrypt_bytes_with_iv(&[0xff, 0xfe], key, &fixed_iv).unwrap();
        assert!(decrypt(&non_utf8_cipher, key).is_err());
    }
}
