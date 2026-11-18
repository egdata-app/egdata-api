//! Custom attribute normalization, game feature extraction, key-image selection, and offer key ordering.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// A normalized Epic custom attribute entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttributeValue {
    #[serde(rename = "type")]
    pub attr_type: String,
    pub value: String,
}

/// An array/map item representation of a custom attribute before normalization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttributeEntry {
    pub key: String,
    #[serde(rename = "type")]
    pub attr_type: Option<String>,
    pub value: String,
}

/// Supported custom attribute input shapes matching TypeScript `CustomAttributes`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CustomAttributesInput {
    Object(BTreeMap<String, AttributeValue>),
    Array(Vec<AttributeEntry>),
    Map(Vec<AttributeEntry>),
}

/// Normalize custom attributes from an object, array, or map-entry list into a keyed map.
pub fn attributes_to_object(
    attributes: &CustomAttributesInput,
) -> BTreeMap<String, AttributeValue> {
    match attributes {
        CustomAttributesInput::Object(map) => map.clone(),
        CustomAttributesInput::Array(items) => items
            .iter()
            .filter(|item| !item.key.is_empty())
            .map(|item| {
                let attr_type = item
                    .attr_type
                    .as_deref()
                    .filter(|t| !t.is_empty())
                    .unwrap_or("STRING")
                    .to_string();
                (
                    item.key.clone(),
                    AttributeValue {
                        attr_type,
                        value: item.value.clone(),
                    },
                )
            })
            .collect(),
        CustomAttributesInput::Map(items) => items
            .iter()
            .filter(|item| !item.key.is_empty())
            .map(|item| {
                (
                    item.key.clone(),
                    AttributeValue {
                        attr_type: item.attr_type.clone().unwrap_or_default(),
                        value: item.value.clone(),
                    },
                )
            })
            .collect(),
    }
}

/// Normalize custom attributes from a dynamic JSON value (array or object/map).
pub fn attributes_to_object_value(value: &Value) -> BTreeMap<String, AttributeValue> {
    match value {
        Value::Array(items) => {
            let entries = items
                .iter()
                .filter_map(|item| {
                    let obj = item.as_object()?;
                    let key = obj.get("key")?.as_str()?.to_string();
                    let attr_type = obj
                        .get("type")
                        .and_then(Value::as_str)
                        .map(ToString::to_string);
                    let val = obj
                        .get("value")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    Some(AttributeEntry {
                        key,
                        attr_type,
                        value: val,
                    })
                })
                .collect();
            attributes_to_object(&CustomAttributesInput::Array(entries))
        }
        Value::Object(map) => map
            .iter()
            .filter_map(|(k, v)| {
                let obj = v.as_object()?;
                let entry_key = obj
                    .get("key")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(k.as_str());
                if entry_key.is_empty() {
                    return None;
                }
                let attr_type = obj
                    .get("type")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("STRING")
                    .to_string();
                let val = obj
                    .get("value")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                Some((
                    entry_key.to_string(),
                    AttributeValue {
                        attr_type,
                        value: val,
                    },
                ))
            })
            .collect(),
        _ => BTreeMap::new(),
    }
}

/// Launcher client inferred from offer/item custom attributes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Launcher {
    Epic,
    Ea,
    Ubisoft,
    Eos,
}

const KNOWN_3RD_PARTY_CLIENTS: &[(&str, Launcher)] = &[
    ("ThirdPartyManagedApp", Launcher::Ea),
    ("MonitorPresense", Launcher::Eos),
    ("PresenceId", Launcher::Eos),
    ("parentPartnerLinkType", Launcher::Ubisoft),
    ("partnerType", Launcher::Ubisoft),
    ("partnerLinkId", Launcher::Ubisoft),
    ("partnerLinkType", Launcher::Ubisoft),
    ("isUplay", Launcher::Ubisoft),
];

const KNOWN_GAME_FEATURES: &[(&str, &str)] = &[
    ("27343", "Alexa Game Control"),
    ("1264", "Co-op"),
    ("1299", "Competitive"),
    ("9549", "Controller Support"),
    ("22776", "Cross Platform"),
    ("1183", "Local Multiplayer"),
    ("22775", "MMO"),
    ("1203", "Multiplayer"),
    ("29088", "Online Multiplayer"),
    ("1370", "Single Player"),
    ("1179", "VR"),
];

const KNOWN_EPIC_FEATURES: &[(&str, &str)] = &[("19847", "Achievements"), ("21894", "Cloud Saves")];

/// Tag reference used when resolving game and Epic features.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeatureTag {
    pub id: String,
    pub name: String,
}

/// Resolved launcher and gameplay/Epic feature labels.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameFeatures {
    pub launcher: Launcher,
    pub features: Vec<String>,
    pub epic_features: Vec<String>,
}

/// Derive launcher and feature flags from normalized custom attributes and tags.
pub fn get_game_features(
    attributes: &BTreeMap<String, AttributeValue>,
    tags: &[FeatureTag],
) -> GameFeatures {
    let mut game_features = GameFeatures {
        launcher: Launcher::Epic,
        features: Vec::new(),
        epic_features: Vec::new(),
    };

    for (key, client) in KNOWN_3RD_PARTY_CLIENTS {
        if attributes.contains_key(*key) {
            if *client == Launcher::Eos {
                game_features
                    .epic_features
                    .push("Epic Online Services".to_string());
                continue;
            }
            game_features.launcher = *client;
        }
    }

    for tag in tags {
        if let Some((_, name)) = KNOWN_GAME_FEATURES.iter().find(|(id, _)| *id == tag.id) {
            game_features.features.push((*name).to_string());
        }
    }

    for tag in tags {
        if let Some((_, name)) = KNOWN_EPIC_FEATURES.iter().find(|(id, _)| *id == tag.id) {
            game_features.epic_features.push((*name).to_string());
        }
    }

    game_features
}

/// Known Epic Games Store `keyImages` type variants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EgsImageType {
    OfferImageTall,
    OfferImageWide,
    Thumbnail,
    Screenshot,
    DieselStoreFrontWide,
    #[serde(rename = "featuredMedia")]
    FeaturedMedia,
    DieselStoreFrontTall,
    DieselGameBox,
    DieselGameBoxWide,
    DieselGameBoxTall,
    DieselGameBoxLogo,
    TakeoverLogo,
    TakeoverLogoSmall,
    TakeoverTall,
    TakeoverWide,
    GalleryImage,
    VaultClosed,
    Sale,
    ComingSoon,
    #[serde(rename = "ComingSoon_Small")]
    ComingSoonSmall,
    Featured,
    #[serde(rename = "ESRB")]
    Esrb,
    OgImage,
    ProductLogo,
    #[serde(rename = "CodeRedemption_340x440")]
    CodeRedemption340x440,
    #[serde(rename = "heroCarouselVideo")]
    HeroCarouselVideo,
    AndroidIcon,
    #[serde(rename = "horizontal")]
    Horizontal,
    #[serde(rename = "img_banner")]
    ImgBanner,
    #[serde(rename = "img_small")]
    ImgSmall,
    #[serde(rename = "img_thumbnail")]
    ImgThumbnail,
    #[serde(rename = "storefront")]
    Storefront,
    #[serde(rename = "vertical")]
    Vertical,
    #[serde(rename = "image name")]
    ImageName,
}

impl EgsImageType {
    /// Return the wire string for this EGS key-image type.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OfferImageTall => "OfferImageTall",
            Self::OfferImageWide => "OfferImageWide",
            Self::Thumbnail => "Thumbnail",
            Self::Screenshot => "Screenshot",
            Self::DieselStoreFrontWide => "DieselStoreFrontWide",
            Self::FeaturedMedia => "featuredMedia",
            Self::DieselStoreFrontTall => "DieselStoreFrontTall",
            Self::DieselGameBox => "DieselGameBox",
            Self::DieselGameBoxWide => "DieselGameBoxWide",
            Self::DieselGameBoxTall => "DieselGameBoxTall",
            Self::DieselGameBoxLogo => "DieselGameBoxLogo",
            Self::TakeoverLogo => "TakeoverLogo",
            Self::TakeoverLogoSmall => "TakeoverLogoSmall",
            Self::TakeoverTall => "TakeoverTall",
            Self::TakeoverWide => "TakeoverWide",
            Self::GalleryImage => "GalleryImage",
            Self::VaultClosed => "VaultClosed",
            Self::Sale => "Sale",
            Self::ComingSoon => "ComingSoon",
            Self::ComingSoonSmall => "ComingSoon_Small",
            Self::Featured => "Featured",
            Self::Esrb => "ESRB",
            Self::OgImage => "OgImage",
            Self::ProductLogo => "ProductLogo",
            Self::CodeRedemption340x440 => "CodeRedemption_340x440",
            Self::HeroCarouselVideo => "heroCarouselVideo",
            Self::AndroidIcon => "AndroidIcon",
            Self::Horizontal => "horizontal",
            Self::ImgBanner => "img_banner",
            Self::ImgSmall => "img_small",
            Self::ImgThumbnail => "img_thumbnail",
            Self::Storefront => "storefront",
            Self::Vertical => "vertical",
            Self::ImageName => "image name",
        }
    }
}

/// Key image entry attached to an offer or item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyImage {
    #[serde(rename = "type")]
    pub image_type: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub md5: Option<String>,
}

/// Select the preferred image from `key_images` matching `types` in priority order,
/// falling back to the first entry if none of `types` match.
pub fn get_image<'a>(key_images: &'a [KeyImage], types: &[&str]) -> Option<&'a KeyImage> {
    for target in types {
        if let Some(image) = key_images.iter().find(|img| img.image_type == *target) {
            return Some(image);
        }
    }
    key_images.first()
}

/// Typed wrapper around [`get_image`] using [`EgsImageType`].
pub fn get_image_by_types<'a>(
    key_images: &'a [KeyImage],
    types: &[EgsImageType],
) -> Option<&'a KeyImage> {
    let type_strs: Vec<&str> = types.iter().map(|t| t.as_str()).collect();
    get_image(key_images, &type_strs)
}

/// Canonical field order emitted by [`order_offers_object`].
pub const ORDERED_OFFER_KEYS: [&str; 31] = [
    "_id",
    "id",
    "namespace",
    "title",
    "description",
    "longDescription",
    "offerType",
    "effectiveDate",
    "creationDate",
    "lastModifiedDate",
    "isCodeRedemptionOnly",
    "keyImages",
    "currentPrice",
    "seller",
    "productSlug",
    "offerMappings",
    "urlSlug",
    "url",
    "tags",
    "items",
    "customAttributes",
    "categories",
    "developerDisplayName",
    "publisherDisplayName",
    "prePurchase",
    "releaseDate",
    "pcReleaseDate",
    "viewableDate",
    "countriesBlacklist",
    "countriesWhitelist",
    "refundType",
];

/// Offer projection with fields declared in the exact documented JSON output order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderedOffer {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub mongo_id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub namespace: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub long_description: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offer_type: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_date: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creation_date: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_modified_date: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_code_redemption_only: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_images: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_price: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seller: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub product_slug: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offer_mappings: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url_slug: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_attributes: Option<BTreeMap<String, AttributeValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub categories: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub developer_display_name: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publisher_display_name: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre_purchase: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_date: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pc_release_date: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub viewable_date: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub countries_blacklist: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub countries_whitelist: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refund_type: Option<Value>,
}

/// Reorder an offer JSON map into [`OrderedOffer`] and normalize `customAttributes`.
pub fn order_offers_object(offer: &Map<String, Value>) -> OrderedOffer {
    let field = |name: &str| offer.get(name).cloned();
    let custom_attributes = offer
        .get("customAttributes")
        .filter(|v| !v.is_null() && !matches!(v, Value::Bool(false)))
        .map(attributes_to_object_value);

    OrderedOffer {
        mongo_id: field("_id"),
        id: field("id"),
        namespace: field("namespace"),
        title: field("title"),
        description: field("description"),
        long_description: field("longDescription"),
        offer_type: field("offerType"),
        effective_date: field("effectiveDate"),
        creation_date: field("creationDate"),
        last_modified_date: field("lastModifiedDate"),
        is_code_redemption_only: field("isCodeRedemptionOnly"),
        key_images: field("keyImages"),
        current_price: field("currentPrice"),
        seller: field("seller"),
        product_slug: field("productSlug"),
        offer_mappings: field("offerMappings"),
        url_slug: field("urlSlug"),
        url: field("url"),
        tags: field("tags"),
        items: field("items"),
        custom_attributes,
        categories: field("categories"),
        developer_display_name: field("developerDisplayName"),
        publisher_display_name: field("publisherDisplayName"),
        pre_purchase: field("prePurchase"),
        release_date: field("releaseDate"),
        pc_release_date: field("pcReleaseDate"),
        viewable_date: field("viewableDate"),
        countries_blacklist: field("countriesBlacklist"),
        countries_whitelist: field("countriesWhitelist"),
        refund_type: field("refundType"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn attributes_to_object_handles_all_input_variants() {
        let mut obj = BTreeMap::new();
        obj.insert(
            "foo".to_string(),
            AttributeValue {
                attr_type: "STRING".to_string(),
                value: "bar".to_string(),
            },
        );
        assert_eq!(
            attributes_to_object(&CustomAttributesInput::Object(obj.clone())),
            obj
        );

        let arr = CustomAttributesInput::Array(vec![
            AttributeEntry {
                key: "color".into(),
                attr_type: Some("STRING".into()),
                value: "red".into(),
            },
            AttributeEntry {
                key: "x".into(),
                attr_type: None,
                value: "y".into(),
            },
            AttributeEntry {
                key: "".into(),
                attr_type: Some("STRING".into()),
                value: "skip".into(),
            },
        ]);
        let arr_res = attributes_to_object(&arr);
        assert_eq!(arr_res.len(), 2);
        assert_eq!(
            arr_res.get("x"),
            Some(&AttributeValue {
                attr_type: "STRING".into(),
                value: "y".into(),
            })
        );

        let map_res = attributes_to_object(&CustomAttributesInput::Map(vec![
            AttributeEntry {
                key: "a".into(),
                attr_type: Some("STRING".into()),
                value: "1".into(),
            },
            AttributeEntry {
                key: "".into(),
                attr_type: Some("STRING".into()),
                value: "ignored".into(),
            },
        ]));
        assert_eq!(map_res.len(), 1);
        assert_eq!(map_res["a"].value, "1");
    }

    #[test]
    fn attributes_to_object_value_handles_json_shapes() {
        let from_arr = attributes_to_object_value(&json!([
            { "key": "FeatureA", "type": "STRING", "value": "yes" },
            { "key": "FeatureB", "value": "no" },
            "not-an-object",
            { "type": "STRING", "value": "missing-key" },
            { "key": 123, "value": "non-string-key" }
        ]));
        assert_eq!(from_arr["FeatureA"].attr_type, "STRING");
        assert_eq!(from_arr["FeatureB"].attr_type, "STRING");
        assert_eq!(from_arr["FeatureB"].value, "no");

        let from_obj = attributes_to_object_value(&json!({
            "a": { "key": "a", "type": "NUMBER", "value": "2" },
            "b": { "type": "STRING", "value": "3" },
            "bad": 123,
            "": { "value": "ignored" }
        }));
        assert_eq!(from_obj.len(), 2);
        assert_eq!(from_obj["a"].attr_type, "NUMBER");
        assert_eq!(from_obj["b"].value, "3");

        assert!(attributes_to_object_value(&json!(123)).is_empty());

        // Round-trip deserialize coverage for public structs/enums.
        let attr_rt: AttributeValue =
            serde_json::from_value(serde_json::to_value(&from_obj["a"]).unwrap()).unwrap();
        assert_eq!(attr_rt, from_obj["a"]);
        let entry_rt: AttributeEntry =
            serde_json::from_str(r#"{"key":"k","type":"STRING","value":"v"}"#).unwrap();
        assert_eq!(entry_rt.key, "k");
    }

    #[test]
    fn get_game_features_resolves_launchers_and_tags() {
        let mut attrs = BTreeMap::new();
        attrs.insert(
            "ThirdPartyManagedApp".into(),
            AttributeValue {
                attr_type: "STRING".into(),
                value: "Origin".into(),
            },
        );
        attrs.insert(
            "PresenceId".into(),
            AttributeValue {
                attr_type: "STRING".into(),
                value: "abc".into(),
            },
        );
        let tags = vec![
            FeatureTag {
                id: "1264".into(),
                name: "Co-op".into(),
            },
            FeatureTag {
                id: "19847".into(),
                name: "Achievements".into(),
            },
            FeatureTag {
                id: "999999".into(),
                name: "Unknown".into(),
            },
        ];

        let features = get_game_features(&attrs, &tags);
        assert_eq!(features.launcher, Launcher::Ea);
        assert_eq!(features.features, vec!["Co-op"]);
        assert_eq!(
            features.epic_features,
            vec!["Epic Online Services", "Achievements"]
        );

        let mut ubi_attrs = BTreeMap::new();
        ubi_attrs.insert(
            "isUplay".into(),
            AttributeValue {
                attr_type: "STRING".into(),
                value: "true".into(),
            },
        );
        assert_eq!(
            get_game_features(&ubi_attrs, &[]).launcher,
            Launcher::Ubisoft
        );
        assert_eq!(
            get_game_features(&BTreeMap::new(), &[]).launcher,
            Launcher::Epic
        );
    }

    #[test]
    fn get_image_respects_preference_order_and_fallback() {
        let images = vec![
            KeyImage {
                image_type: "Thumbnail".into(),
                url: "https://cdn/thumb.png".into(),
                md5: Some("1".into()),
            },
            KeyImage {
                image_type: "OfferImageWide".into(),
                url: "https://cdn/wide.png".into(),
                md5: None,
            },
        ];

        let preferred = get_image_by_types(
            &images,
            &[
                EgsImageType::DieselGameBoxWide,
                EgsImageType::OfferImageWide,
            ],
        )
        .expect("finds OfferImageWide");
        assert_eq!(preferred.url, "https://cdn/wide.png");

        let fallback =
            get_image_by_types(&images, &[EgsImageType::OgImage]).expect("falls back to first");
        assert_eq!(fallback.image_type, "Thumbnail");

        assert!(get_image(&[], &["Thumbnail"]).is_none());

        // Exercise every EgsImageType variant's as_str mapping.
        let all_variants = [
            EgsImageType::OfferImageTall,
            EgsImageType::OfferImageWide,
            EgsImageType::Thumbnail,
            EgsImageType::Screenshot,
            EgsImageType::DieselStoreFrontWide,
            EgsImageType::FeaturedMedia,
            EgsImageType::DieselStoreFrontTall,
            EgsImageType::DieselGameBox,
            EgsImageType::DieselGameBoxWide,
            EgsImageType::DieselGameBoxTall,
            EgsImageType::DieselGameBoxLogo,
            EgsImageType::TakeoverLogo,
            EgsImageType::TakeoverLogoSmall,
            EgsImageType::TakeoverTall,
            EgsImageType::TakeoverWide,
            EgsImageType::GalleryImage,
            EgsImageType::VaultClosed,
            EgsImageType::Sale,
            EgsImageType::ComingSoon,
            EgsImageType::ComingSoonSmall,
            EgsImageType::Featured,
            EgsImageType::Esrb,
            EgsImageType::OgImage,
            EgsImageType::ProductLogo,
            EgsImageType::CodeRedemption340x440,
            EgsImageType::HeroCarouselVideo,
            EgsImageType::AndroidIcon,
            EgsImageType::Horizontal,
            EgsImageType::ImgBanner,
            EgsImageType::ImgSmall,
            EgsImageType::ImgThumbnail,
            EgsImageType::Storefront,
            EgsImageType::Vertical,
            EgsImageType::ImageName,
        ];
        assert_eq!(all_variants.len(), 34);
        assert!(all_variants.iter().all(|v| !v.as_str().is_empty()));
    }

    #[test]
    fn order_offers_object_preserves_key_order_and_normalizes_attributes() {
        let input = json!({
            "refundType": "NO_REFUND",
            "title": "T",
            "_id": "abc",
            "id": "offer-1",
            "namespace": "ns",
            "description": "D",
            "longDescription": "LD",
            "offerType": "BASE_GAME",
            "effectiveDate": "2024-01-01",
            "creationDate": "2024-01-01",
            "lastModifiedDate": "2024-01-01",
            "isCodeRedemptionOnly": false,
            "keyImages": [],
            "currentPrice": null,
            "seller": { "id": "s", "name": "Seller" },
            "productSlug": "slug",
            "offerMappings": [{ "pageSlug": "slug" }],
            "urlSlug": "slug",
            "url": null,
            "tags": [],
            "items": [],
            "customAttributes": [
                { "key": "FeatureA", "type": "STRING", "value": "yes" }
            ],
            "categories": [],
            "developerDisplayName": "Dev",
            "publisherDisplayName": "Pub",
            "prePurchase": false,
            "releaseDate": "2024-01-01",
            "pcReleaseDate": "2024-01-01",
            "viewableDate": "2024-01-01",
            "countriesBlacklist": [],
            "countriesWhitelist": []
        });

        let ordered = order_offers_object(input.as_object().unwrap());
        let json_str = serde_json::to_string(&ordered).unwrap();
        let mut last_idx = 0;
        for key in ORDERED_OFFER_KEYS {
            let needle = format!("\"{key}\":");
            let idx = json_str[last_idx..].find(&needle).expect("missing key");
            last_idx += idx + needle.len();
        }
        assert_eq!(
            ordered.custom_attributes.as_ref().unwrap()["FeatureA"],
            AttributeValue {
                attr_type: "STRING".into(),
                value: "yes".into(),
            }
        );

        let without_attrs = json!({ "id": "offer-2", "customAttributes": false });
        let ordered_no_attrs = order_offers_object(without_attrs.as_object().unwrap());
        assert!(ordered_no_attrs.custom_attributes.is_none());
        let rt: OrderedOffer =
            serde_json::from_value(serde_json::to_value(&ordered).unwrap()).unwrap();
        assert_eq!(rt.id, ordered.id);

        let tag_rt: FeatureTag = serde_json::from_str(r#"{"id":"1264","name":"Co-op"}"#).unwrap();
        let gf = get_game_features(&BTreeMap::new(), &[tag_rt]);
        let gf_rt: GameFeatures =
            serde_json::from_value(serde_json::to_value(&gf).unwrap()).unwrap();
        assert_eq!(gf_rt, gf);
        let img_type_rt: EgsImageType = serde_json::from_str(r#""OgImage""#).unwrap();
        assert_eq!(img_type_rt, EgsImageType::OgImage);
        let img_rt: KeyImage =
            serde_json::from_str(r#"{"type":"OgImage","url":"https://cdn/og.png"}"#).unwrap();
        assert_eq!(img_rt.image_type, "OgImage");
    }
}
