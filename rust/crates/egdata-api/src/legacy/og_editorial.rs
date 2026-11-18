//! Legacy OG image routes (`/offers/{id}/og(.webp)`, `/sandboxes/{sandboxId}/og(.webp)`) and editorial routes (`/collections`, `/promotions`, `/game-awards`).
use super::{
    Routes,
    catalog::{Page, locale, localize_legacy_offers, query, region},
    common::*,
    offer_relations::prices_by_id,
    system::{missing_country, query as uri_query, selected_country, selected_region},
};
#[cfg(test)]
use crate::v1::og::latest_og_download;
use crate::{
    state::AppState,
    v1::og::{
        asset_detail, format_og_date, format_thousands_en_us, offer_card_download, offer_card_price,
    },
};
use axum::{
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, Uri, header},
    response::Response,
};
use bson::{Bson, doc};
use chrono::{DateTime, Datelike, Duration, NaiveDate, Utc};
use egdata_core::{
    attributes::{KeyImage, get_image},
    countries::REGIONS,
    localization::{get_localized_cache_ttl_seconds, locale_cache_segment},
    ports::{MongoFindOptions, OgImageFormat},
    pricing::{PriceAvailability, is_price_country_eligible},
    v1::serialization::{iso_or_null, js_iso_datetime},
};
use egdata_infra::bson_json::bson_doc_to_js_json;
use egdata_infra::og_renderer::format_og_size;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

const LIST_CACHE_CONTROL: &str = "public, max-age=60, s-maxage=300, stale-while-revalidate=600";
const LIST_CDN_CACHE_CONTROL: &str = "public, max-age=300, stale-while-revalidate=3600";

fn editorial_card(offer: &Value, price: Option<&Value>) -> Result<Value> {
    let mut projected = crate::v1::offers::checked_ordered(offer)?;
    // Legacy JSON omits undefined properties, including falsy customAttributes.
    projected.as_object_mut().unwrap().retain(|key, value| {
        offer.get(key).is_some() && (key != "customAttributes" || !value.is_null())
    });
    projected["price"] = price.cloned().unwrap_or(Value::Null);
    Ok(projected)
}

const OG_CACHE_CONTROL: &str = "public, max-age=86400, stale-while-revalidate=604800";
const OG_IMMUTABLE_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";
const OG_CDN_CACHE_CONTROL: &str = "public, max-age=2592000, stale-while-revalidate=604800";
const OG_IMMUTABLE_CDN_CACHE_CONTROL: &str =
    "public, max-age=31536000, stale-while-revalidate=604800";

const OG_IMAGE_PRIORITY: &[&str] = &[
    "DieselGameBoxTall",
    "OfferImageTall",
    "DieselStoreFrontTall",
    "DieselStoreFrontWide",
    "OfferImageWide",
    "Featured",
    "DieselGameBoxWide",
];

const TGA_LOGO_PATHS: &[&str] = &[
    "M49.9535 48.3579L62.8789 35.425L66.2507 24.179L49.9535 40.4857V48.3579Z",
    "M3.87183 11.246L33.0943 40.4857V48.3579L37.0281 44.4218L41.5239 48.9202V56.7924L45.4577 52.8563L53.6288 61.0322L55.8542 55.3867L0.5 0L3.87183 11.246Z",
    "M11.1775 35.425L24.6648 48.9202L18.2021 55.3867L20.4275 61.0322L28.5986 52.8563L33.0944 57.3547L22.9789 67.4762H30.8465L37.0282 61.2909L43.2098 67.4762H51.0774L7.80564 24.179L11.1775 35.425Z",
    "M41.5239 32.0512V39.9234L70.1845 11.246L73.5563 0L41.5239 32.0512Z",
    "M95.9004 20.1356V4.08465H101.765V0H85.7523V4.08465H91.6457V20.1356H95.9004Z",
    "M93.8351 44.0946C99.5272 44.0946 103.782 40.1825 103.782 34.4007C103.782 33.6528 103.724 32.6461 103.609 32.0708H93.8126V36.1842H99.3835C98.7223 38.4566 96.7386 39.9524 94.1513 39.9524C90.529 39.9524 88.0279 37.2772 88.0279 33.7391C88.0279 30.201 90.529 27.5259 93.8351 27.5259C95.9337 27.5259 97.9461 28.6189 98.5785 30.3449H103.408C102.805 26.6629 98.636 23.3837 93.8351 23.3837C88.0279 23.3837 83.6582 27.8423 83.6582 33.7391C83.6582 39.636 88.0279 44.0946 93.8351 44.0946Z",
    "M115.124 23.6714H111.674L103.711 43.8069H108.224L109.518 40.4414H117.251L118.516 43.8069H123.144L115.124 23.6714ZM110.955 36.7307L113.399 30.3449L115.814 36.7307H110.955Z",
    "M95.4252 47.3427H91.9754L84.0121 67.4783H88.5256L89.8193 64.1128H97.5526L98.8175 67.4783H103.446L95.4252 47.3427ZM91.2567 60.4021L93.7003 54.0162L96.1151 60.4021H91.2567Z",
    "M126.137 47.3427L120.954 60.287L116.785 47.3427H113.364L109.196 60.287L103.954 47.3427H99.4122L107.384 67.4782H110.834L115.031 54.5339L119.257 67.4782H122.679L130.593 47.3427H126.137Z",
    "M138.059 47.3427H134.609L126.646 67.4783H131.16L132.453 64.1128H140.186L141.451 67.4783H146.08L138.059 47.3427ZM133.891 60.4021L136.334 54.0162L138.749 60.4021H133.891Z",
    "M147.849 67.4783H152.104V59.798H154.289L158.831 67.4783H164.006L158.716 59.1364C160.729 58.1584 161.936 56.1736 161.936 53.556C161.936 50.1042 158.975 47.3427 155.583 47.3427H147.849V67.4783ZM152.104 55.7134V51.4561H155.468C156.704 51.4561 157.652 52.3479 157.652 53.556C157.652 54.7641 156.704 55.7134 155.468 55.7134H152.104Z",
    "M172.492 47.3427H165.592V67.4783H172.492C178.27 67.4783 182.669 63.1635 182.669 57.3242C182.669 51.6 178.27 47.3427 172.492 47.3427ZM169.847 63.3937V51.4274H172.779C175.999 51.4274 178.299 53.9012 178.299 57.3242C178.299 60.8048 175.97 63.3937 172.779 63.3937H169.847Z",
    "M192.169 67.766C196.424 67.766 199.558 65.1196 199.558 61.5527C199.558 53.8724 188.921 56.3174 188.921 52.9807C188.921 51.8013 189.927 51.0822 191.537 51.0822C193.377 51.0822 194.498 52.2328 194.527 53.7573H198.925C198.925 50.2192 196.654 47.0551 191.681 47.0551C187.713 47.0551 184.752 49.5576 184.752 53.0095C184.752 60.3733 195.332 57.9858 195.332 61.5527C195.332 62.8759 194.038 63.7388 192.169 63.7388C190.157 63.7388 188.748 62.5882 188.748 60.8048H184.551C184.551 64.8319 187.771 67.766 192.169 67.766Z",
    "M149.768 23.6714V43.8069H162.072V39.7223H154.023V35.465H161.21V31.3804H154.023V27.756H162.072V23.6714H149.768Z",
    "M117.557 0V7.68028H108.99V0H104.735V20.1356H108.99V11.7649H117.557V20.1356H121.812V0H117.557Z",
    "M124.865 43.8069H129.12V31.9845L134.122 43.8069H137.227L142.344 31.9845V43.8069H146.628V23.6714H142.258L135.991 37.5361L130.04 23.6714H124.865V43.8069Z",
    "M124.865 0V20.1356H137.169V16.0509H129.12V11.7937H136.307V7.70905H129.12V4.08465H137.169V0H124.865Z",
];

pub(super) fn routes() -> Routes {
    Routes::new("")
        .get("/offers/{id}/og", offer_og_png)
        .get("/offers/{id}/og.webp", offer_og_webp)
        .get("/sandboxes/{sandboxId}/og", sandbox_og_png)
        .get("/sandboxes/{sandboxId}/og.webp", sandbox_og_webp)
        .get("/promotions", promotions_list)
        .get("/promotions/{id}", promotion_detail)
        .get("/promotions/{id}/cover", promotion_cover)
        .get("/collections/{slug}", collection_current)
        .get("/collections/{slug}/{week}", collection_week)
        .get("/game-awards", game_awards)
        .get("/game-awards/og", game_awards_og)
}

// ---------------------------------------------------------------------------
// Shared response & OG helpers
// ---------------------------------------------------------------------------

fn list_response(value: &Value) -> Response {
    let mut response = ok(value);
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(LIST_CACHE_CONTROL),
    );
    response.headers_mut().insert(
        HeaderName::from_static("cdn-cache-control"),
        HeaderValue::from_static(LIST_CDN_CACHE_CONTROL),
    );
    response
}

fn og_image_response(
    format: OgImageFormat,
    bytes: Vec<u8>,
    versioned: bool,
    cdn_always_unversioned: bool,
    vary: &'static str,
) -> Response {
    let content_type = match format {
        OgImageFormat::Png => "image/png",
        OgImageFormat::Webp => "image/webp",
    };
    let cache_control = if versioned {
        OG_IMMUTABLE_CACHE_CONTROL
    } else {
        OG_CACHE_CONTROL
    };
    let cdn_cache_control = if versioned && !cdn_always_unversioned {
        OG_IMMUTABLE_CDN_CACHE_CONTROL
    } else {
        OG_CDN_CACHE_CONTROL
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, cache_control)
        .header("cdn-cache-control", cdn_cache_control)
        .header(header::VARY, vary)
        .body(Body::from(bytes))
        .unwrap()
}

fn wants_expanded(q: &HashMap<String, String>) -> bool {
    q.get("expand").is_some_and(|v| {
        matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "true" | "1" | "full"
        )
    })
}

fn bson_value(value: &Value) -> Bson {
    bson::to_bson(value).unwrap_or(Bson::Null)
}

struct OgMetric {
    label: String,
    value: String,
    detail: String,
}

struct DatabaseOgCard {
    title: String,
    subtitle: String,
    metrics: [OgMetric; 3],
    footer_label: String,
    footer_value: String,
}

fn html_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

fn render_database_og_html(card: &DatabaseOgCard, cover_url: Option<&str>) -> String {
    let has_cover = cover_url.is_some();
    let left = if has_cover { 298 } else { 48 };
    let width = 1152 - left;
    let title: String = card.title.chars().take(160).collect();
    let title_len = title.chars().count();
    let title_size = if title_len > 60 {
        36
    } else if title_len > 30 {
        44
    } else {
        64
    };
    let metric_width = width / 3;

    let cover_bg = cover_url
        .map(|u| {
            format!(
                r#"<img src="{}" style="position:absolute;right:0;top:0;width:1200px;height:630px;object-fit:cover;opacity:0.04;" />"#,
                html_escape(u)
            )
        })
        .unwrap_or_default();
    let cover_thumb = cover_url
        .map(|u| {
            format!(
                r#"<img src="{}" style="position:absolute;left:48px;top:132px;width:224px;height:280px;object-fit:cover;border-radius:8px;border:1px solid #235B80;" />"#,
                html_escape(u)
            )
        })
        .unwrap_or_default();

    let mut metrics_html = String::new();
    for (idx, metric) in card.metrics.iter().enumerate() {
        let pad_left = if idx > 0 { 40 } else { 0 };
        let border_left = if idx > 0 {
            "border-left:1px solid #235B80;"
        } else {
            ""
        };
        let val_len = metric.value.chars().count();
        let val_size = if val_len > 14 {
            24
        } else if val_len > 11 {
            28
        } else {
            32
        };
        metrics_html.push_str(&format!(
            r#"<div style="width:{metric_width}px;padding-left:{pad_left}px;padding-right:12px;{border_left}display:flex;flex-direction:column;gap:8px;"><span style="font-size:20px;color:#92B0D0;letter-spacing:0.7px;">{}</span><span style="font-size:{val_size}px;font-weight:700;color:#FFFFFF;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">{}</span><span style="font-size:22px;color:#92B0D0;">{}</span></div>"#,
            html_escape(&metric.label),
            html_escape(&metric.value),
            html_escape(&metric.detail),
        ));
    }

    format!(
        r#"<div style="width:1200px;height:630px;position:relative;overflow:hidden;background-color:#00162D;font-family:Roboto,sans-serif;color:#FFFFFF;">{cover_bg}<div style="position:absolute;left:48px;top:48px;display:flex;"><span style="font-size:34px;font-weight:700;color:#FFFFFF;">egdata</span><span style="font-size:34px;font-weight:700;color:#0078F2;">.app</span></div><span style="position:absolute;top:57px;right:48px;font-size:24px;color:#92B0D0;">Epic Games Store Database</span>{cover_thumb}<div style="position:absolute;left:{left}px;top:166px;width:{width}px;height:168px;display:flex;flex-direction:column;justify-content:center;gap:12px;"><span style="font-size:{title_size}px;font-weight:700;line-height:1.08;color:#FFFFFF;overflow:hidden;text-overflow:ellipsis;">{}</span><span style="font-size:24px;color:#92B0D0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">{}</span></div><div style="position:absolute;left:{left}px;top:348px;width:{width}px;height:132px;padding-top:22px;border-top:1px solid #235B80;display:flex;">{metrics_html}</div><div style="position:absolute;left:48px;top:496px;width:1104px;padding-top:32px;border-top:1px solid #235B80;display:flex;align-items:center;"><span style="font-size:24px;color:#92B0D0;padding-right:38px;">{}</span><span style="font-size:32px;font-weight:700;color:#FFFFFF;border-left:1px solid #235B80;padding-left:40px;">{}</span></div></div>"#,
        html_escape(&title),
        html_escape(&card.subtitle),
        html_escape(&card.footer_label),
        html_escape(&card.footer_value),
    )
}

fn extract_key_images(val: Option<&Value>) -> Vec<KeyImage> {
    val.and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|item| serde_json::from_value::<KeyImage>(item.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

fn extract_string_list(val: Option<&Value>) -> Option<Vec<String>> {
    val.and_then(Value::as_array).map(|arr| {
        arr.iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect()
    })
}

fn count_sandbox_og_assets(assets: &[Value], items: &[Value]) -> usize {
    let known: HashSet<&str> = assets
        .iter()
        .filter_map(|a| a.get("artifactId").and_then(Value::as_str))
        .collect();
    let virtual_count: usize = items
        .iter()
        .map(|item| {
            item.get("releaseInfo")
                .and_then(Value::as_array)
                .map(|releases| {
                    releases
                        .iter()
                        .map(|release| {
                            let app_id = release.get("appId").and_then(Value::as_str);
                            if app_id.is_some_and(|id| !id.is_empty() && !known.contains(id)) {
                                release
                                    .get("platform")
                                    .and_then(Value::as_array)
                                    .map_or(0, Vec::len)
                            } else {
                                0
                            }
                        })
                        .sum::<usize>()
                })
                .unwrap_or(0)
        })
        .sum();
    assets.len() + virtual_count
}

// ---------------------------------------------------------------------------
// 1. GET /offers/{id}/og & GET /offers/{id}/og.webp
// ---------------------------------------------------------------------------

async fn offer_og_png(
    State(state): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Response> {
    render_offer_og(&state, &uri, &headers, &id, OgImageFormat::Png).await
}

async fn offer_og_webp(
    State(state): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Response> {
    render_offer_og(&state, &uri, &headers, &id, OgImageFormat::Webp).await
}

async fn render_offer_og(
    state: &AppState,
    uri: &Uri,
    headers: &HeaderMap,
    id: &str,
    format: OgImageFormat,
) -> Result<Response> {
    let versioned = uri_query(uri, "v").is_some_and(|v| !v.is_empty());
    let country_query = uri_query(uri, "country");
    let country = selected_country(uri, headers);
    let Some((region_code, _)) = selected_region(uri, headers) else {
        return Ok(missing_country());
    };

    let offer_doc = state
        .mongo
        .find_one("offers", doc! { "id": id }, None)
        .await?
        .ok_or_else(|| not_found("Offer not found"))?;

    let offer = bson_doc_to_js_json(&offer_doc);
    let key_images = extract_key_images(offer.get("keyImages"));
    let cover_url = get_image(&key_images, OG_IMAGE_PRIORITY).map(|img| img.url.clone());

    let availability = PriceAvailability {
        countries_whitelist: extract_string_list(offer.get("countriesWhitelist")),
        countries_blacklist: extract_string_list(offer.get("countriesBlacklist")),
    };

    let price_query = async {
        if is_price_country_eligible(&availability, &country) {
            state
                .mongo
                .find_one_with_options(
                    "pricev2",
                    doc! { "offerId": id, "region": region_code },
                    MongoFindOptions {
                        sort: Some(doc! { "updatedAt": -1 }),
                        ..Default::default()
                    },
                )
                .await
        } else {
            Ok(None)
        }
    };
    let subitem_query = state.mongo.find_many(
        "offersubitems",
        doc! { "_id": id },
        MongoFindOptions {
            projection: Some(doc! { "_id": 1, "subItems": 1 }),
            ..Default::default()
        },
    );
    let (price, subitems) = tokio::join!(price_query, subitem_query);
    let price = price?.as_ref().map(bson_doc_to_js_json);
    let subitems = subitems?;
    let (download_bytes, download_platform) =
        offer_card_download(state, id, &offer_doc, &subitems).await?;

    let region_currency = REGIONS
        .iter()
        .find(|(code, _)| *code == region_code)
        .map_or("USD", |(_, info)| info.currency_code);
    let currency = price
        .as_ref()
        .and_then(|p| p.get("price"))
        .and_then(|p| p.get("currencyCode"))
        .filter(|value| !value.is_null())
        .map_or_else(
            || region_currency.to_string(),
            egdata_core::v1::serialization::js_string,
        );
    let amount = price
        .as_ref()
        .and_then(|p| p.get("price"))
        .and_then(|p| p.get("discountPrice"))
        .and_then(Value::as_f64);

    let price_str = offer_card_price(amount, &currency).ok_or(Error::Internal)?;

    let raw_type = offer
        .get("offerType")
        .and_then(Value::as_str)
        .unwrap_or("Offer")
        .to_ascii_lowercase()
        .replace('_', " ");
    let mut chars = raw_type.chars();
    let offer_type_label = match chars.next() {
        Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
        None => String::new(),
    };
    let publisher = offer
        .get("publisherDisplayName")
        .and_then(Value::as_str)
        .or_else(|| {
            offer
                .get("seller")
                .and_then(|s| s.get("name"))
                .and_then(Value::as_str)
        })
        .unwrap_or("");
    let subtitle = [offer_type_label.as_str(), publisher]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");

    let card = DatabaseOgCard {
        title: offer
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Untitled offer")
            .to_string(),
        subtitle,
        metrics: [
            OgMetric {
                label: "PRICE".to_string(),
                value: price_str,
                detail: format!("{currency} · {country}"),
            },
            OgMetric {
                label: "LAST UPDATE".to_string(),
                value: format_og_date(
                    offer
                        .get("lastModifiedDate")
                        .filter(|value| !value.is_null())
                        .or_else(|| offer.get("updatedAt")),
                ),
                detail: "Catalog record".to_string(),
            },
            OgMetric {
                label: "ASSET SIZE".to_string(),
                value: format_og_size(download_bytes),
                detail: asset_detail(download_platform.as_ref()),
            },
        ],
        footer_label: "Release date".to_string(),
        footer_value: format_og_date(
            offer
                .get("releaseDate")
                .filter(|value| !value.is_null())
                .or_else(|| offer.get("effectiveDate"))
                .filter(|value| !value.is_null())
                .or_else(|| offer.get("viewableDate")),
        ),
    };

    let html = render_database_og_html(&card, cover_url.as_deref());
    let html_without_cover = render_database_og_html(&card, None);
    let bytes = state
        .og
        .render_image_with_cover(
            &html,
            &html_without_cover,
            cover_url.as_deref(),
            1200,
            630,
            format,
        )
        .await?;

    let vary = if country_query.is_some_and(|v| !v.is_empty()) {
        "Accept-Encoding"
    } else {
        "Cookie, Accept-Encoding"
    };
    Ok(og_image_response(format, bytes, versioned, false, vary))
}

// ---------------------------------------------------------------------------
// 2. GET /sandboxes/{sandboxId}/og & GET /sandboxes/{sandboxId}/og.webp
// ---------------------------------------------------------------------------

async fn sandbox_og_png(
    State(state): State<AppState>,
    Path(sandbox_id): Path<String>,
    uri: Uri,
) -> Result<Response> {
    render_sandbox_og(&state, &uri, &sandbox_id, OgImageFormat::Png).await
}

async fn sandbox_og_webp(
    State(state): State<AppState>,
    Path(sandbox_id): Path<String>,
    uri: Uri,
) -> Result<Response> {
    render_sandbox_og(&state, &uri, &sandbox_id, OgImageFormat::Webp).await
}

async fn render_sandbox_og(
    state: &AppState,
    uri: &Uri,
    sandbox_id: &str,
    format: OgImageFormat,
) -> Result<Response> {
    let versioned = uri_query(uri, "v").is_some_and(|v| !v.is_empty());
    let sandbox = one(state, "sandboxes", doc! { "_id": { "$eq": sandbox_id } })
        .await?
        .ok_or_else(|| not_found("Sandbox not found"))?;

    let count_query = state
        .mongo
        .count_documents("offers", doc! { "namespace": sandbox_id });
    let items_query = many(
        state,
        "items",
        doc! { "namespace": sandbox_id },
        MongoFindOptions {
            projection: Some(doc! { "releaseInfo": 1 }),
            ..Default::default()
        },
    );
    let assets_query = many(
        state,
        "assets",
        doc! { "namespace": sandbox_id },
        MongoFindOptions {
            projection: Some(doc! { "artifactId": 1 }),
            ..Default::default()
        },
    );
    let released_query = state.mongo.find_one_with_options(
        "offers",
        doc! {
            "namespace": { "$eq": sandbox_id },
            "offerType": "BASE_GAME",
            "prePurchase": { "$ne": true },
            "isCodeRedemptionOnly": false,
        },
        MongoFindOptions {
            sort: Some(doc! { "creationDate": 1, "id": 1 }),
            ..Default::default()
        },
    );
    let (count, items, assets, released) =
        tokio::join!(count_query, items_query, assets_query, released_query);
    let offers_count = count?;
    let items = items?;
    let assets = assets?;
    let released_offer = released?.as_ref().map(bson_doc_to_js_json);

    let mut identity = released_offer;
    if identity.is_none() {
        identity = state
            .mongo
            .find_one_with_options(
                "offers",
                doc! {
                    "namespace": { "$eq": sandbox_id },
                    "offerType": "BASE_GAME",
                    "prePurchase": true,
                },
                MongoFindOptions {
                    sort: Some(doc! { "creationDate": 1, "id": 1 }),
                    ..Default::default()
                },
            )
            .await?
            .as_ref()
            .map(bson_doc_to_js_json);
    }
    if identity.is_none() {
        identity = state
            .mongo
            .find_one_with_options(
                "items",
                doc! {
                    "namespace": { "$eq": sandbox_id },
                    "entitlementType": "EXECUTABLE",
                    "releaseInfo.0": { "$exists": true },
                },
                MongoFindOptions {
                    sort: Some(doc! { "creationDate": 1, "id": 1 }),
                    ..Default::default()
                },
            )
            .await?
            .as_ref()
            .map(bson_doc_to_js_json);
    }

    let key_images = extract_key_images(identity.as_ref().and_then(|v| v.get("keyImages")));
    let cover_url = get_image(&key_images, OG_IMAGE_PRIORITY).map(|img| img.url.clone());

    let publisher = identity
        .as_ref()
        .and_then(|v| {
            v.get("publisherDisplayName")
                .and_then(Value::as_str)
                .or_else(|| {
                    v.get("seller")
                        .and_then(|s| s.get("name"))
                        .and_then(Value::as_str)
                })
        })
        .unwrap_or("");
    let subtitle = ["Sandbox", publisher]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");

    let asset_count = count_sandbox_og_assets(&assets, &items);
    let card = DatabaseOgCard {
        title: identity
            .as_ref()
            .and_then(|v| v.get("title"))
            .and_then(Value::as_str)
            .or_else(|| sandbox.get("title").and_then(Value::as_str))
            .or_else(|| sandbox.get("displayName").and_then(Value::as_str))
            .unwrap_or("Sandbox")
            .to_string(),
        subtitle,
        metrics: [
            OgMetric {
                label: "OFFERS".to_string(),
                value: format_thousands_en_us(offers_count),
                detail: "Store entries".to_string(),
            },
            OgMetric {
                label: "ITEMS".to_string(),
                value: format_thousands_en_us(items.len() as u64),
                detail: "Catalog items".to_string(),
            },
            OgMetric {
                label: "ASSETS".to_string(),
                value: format_thousands_en_us(asset_count as u64),
                detail: "Distribution records".to_string(),
            },
        ],
        footer_label: "Last update".to_string(),
        footer_value: format_og_date(
            sandbox
                .get("updated")
                .filter(|value| !value.is_null())
                .or_else(|| sandbox.get("lastModifiedDate"))
                .filter(|value| !value.is_null())
                .or_else(|| sandbox.get("updatedAt")),
        ),
    };

    let html = render_database_og_html(&card, cover_url.as_deref());
    let html_without_cover = render_database_og_html(&card, None);
    let bytes = state
        .og
        .render_image_with_cover(
            &html,
            &html_without_cover,
            cover_url.as_deref(),
            1200,
            630,
            format,
        )
        .await?;

    Ok(og_image_response(
        format,
        bytes,
        versioned,
        false,
        "Accept-Encoding",
    ))
}

// ---------------------------------------------------------------------------
// 3. GET /promotions, GET /promotions/{id}, GET /promotions/{id}/cover
// ---------------------------------------------------------------------------

async fn promotions_list(State(state): State<AppState>) -> Result<Response> {
    let events = many(
        &state,
        "tags",
        doc! { "groupName": "event", "status": "ACTIVE" },
        MongoFindOptions {
            sort: Some(doc! { "referenceCount": -1 }),
            ..Default::default()
        },
    )
    .await?;
    Ok(cache_header(
        ok(&Value::Array(events)),
        "private, max-age=0",
    ))
}

async fn promotion_detail(
    State(state): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Response> {
    let q = query(&uri);
    let loc = locale(&q)?;
    let reg = region(&uri, &headers)?;
    let params = Page::new(&q, 10, 50);
    let skip = params.skip(0)?;
    let limit = params.limit.ok_or(Error::Internal)?;
    let page = params.page.ok_or(Error::Internal)?;
    let query_text = q.get("q");
    let sort_by = q
        .get("sortBy")
        .map(String::as_str)
        .unwrap_or("lastModifiedDate");
    let sort_dir = q.get("sortDir").map(String::as_str).unwrap_or("desc");
    let expand = wants_expanded(&q);

    let cache_key = format!(
        "promotion:{id}:{reg}:{}:{sort_by}:{sort_dir}:{}:{}:{}:v0.1",
        params.key(),
        query_text.map_or("no-query", String::as_str),
        locale_cache_segment(&loc),
        if expand { "full" } else { "card" }
    );

    if let Some(hit) = cached(&state, &cache_key).await? {
        return Ok(list_response(&hit));
    }

    let event = one(&state, "tags", doc! { "id": &id })
        .await?
        .ok_or_else(|| not_found("Event not found"))?;

    let q_filter = query_text.filter(|s| !s.is_empty()).map(|pattern| {
        Bson::RegularExpression(bson::Regex {
            pattern: pattern.clone(),
            options: "i".into(),
        })
    });
    let dir_num = if sort_dir == "asc" { 1 } else { -1 };

    let mut offers: Vec<Value> = if sort_by == "price" {
        let lookup_pipeline = match &q_filter {
            Some(re) => vec![doc! { "$match": { "title": { "$regex": re.clone() } } }],
            None => Vec::new(),
        };
        let pipeline = vec![
            doc! { "$match": { "region": reg } },
            doc! { "$sort": { "price.discountPrice": dir_num } },
            doc! {
                "$lookup": {
                    "from": "offers",
                    "localField": "offerId",
                    "foreignField": "id",
                    "as": "offer",
                    "pipeline": lookup_pipeline,
                }
            },
            doc! { "$unwind": "$offer" },
            doc! { "$match": { "offer.tags": { "$elemMatch": { "id": &id } } } },
            doc! { "$addFields": { "price": "$$ROOT" } },
            doc! { "$replaceRoot": { "newRoot": { "$mergeObjects": ["$offer", { "price": "$price" }] } } },
            doc! { "$skip": skip as i64 },
            doc! { "$limit": limit },
            doc! { "$project": { "price.offer": 0 } },
        ];
        state
            .mongo
            .aggregate("pricev2", pipeline)
            .await?
            .iter()
            .map(bson_doc_to_js_json)
            .collect()
    } else {
        let mut match_doc = doc! { "tags": { "$elemMatch": { "id": &id } } };
        if let Some(re) = &q_filter {
            match_doc.insert("title", doc! { "$regex": re.clone() });
        }
        let pipeline = vec![
            doc! { "$match": match_doc },
            doc! { "$sort": { sort_by: dir_num } },
            doc! { "$skip": skip as i64 },
            doc! { "$limit": limit },
            doc! { "$unwind": { "path": "$price", "preserveNullAndEmptyArrays": true } },
        ];
        let mut docs: Vec<Value> = state
            .mongo
            .aggregate("offers", pipeline)
            .await?
            .iter()
            .map(bson_doc_to_js_json)
            .collect();

        let offer_ids: Vec<Bson> = docs.iter().map(|o| bson_value(&o["id"])).collect();
        let prices = many(
            &state,
            "pricev2",
            doc! { "region": reg, "offerId": { "$in": offer_ids } },
            Default::default(),
        )
        .await?;
        let by_id = prices_by_id(&prices);
        for offer in &mut docs {
            let p = offer["id"].as_str().and_then(|oid| by_id.get(oid)).copied();
            offer["price"] = p.cloned().unwrap_or(Value::Null);
        }
        docs
    };

    let elements = if expand {
        localize_legacy_offers(&state, &offers, &loc, false).await?
    } else {
        for offer in &mut offers {
            let price = offer.get("price").filter(|p| !p.is_null()).cloned();
            *offer = editorial_card(offer, price.as_ref())?;
        }
        localize_legacy_offers(&state, &offers, &loc, true).await?
    };

    let mut count_filter = doc! { "tags": { "$elemMatch": { "id": &id } } };
    if let Some(q_str) = query_text.filter(|s| !s.is_empty()) {
        count_filter.insert(
            "$text",
            doc! {
                "$search": q_str,
                "$caseSensitive": false,
                "$diacriticSensitive": false,
            },
        );
    }
    let count = state.mongo.count_documents("offers", count_filter).await?;

    let result = json!({
        "elements": elements,
        "title": event.get("name").and_then(Value::as_str).unwrap_or(""),
        "start": skip,
        "page": page,
        "count": count,
    });

    store(
        &state,
        &cache_key,
        &result,
        get_localized_cache_ttl_seconds(&result, 3600),
    )
    .await?;

    Ok(list_response(&result))
}

async fn promotion_cover(
    State(state): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
) -> Result<Response> {
    let q = query(&uri);
    let loc = locale(&q)?;
    let cache_key = format!("promotion-cover:{id}:{}", locale_cache_segment(&loc));

    if let Some(hit) = cached(&state, &cache_key).await? {
        return Ok(cache_header(ok(&hit), ONE_MINUTE));
    }

    let offers = state
        .mongo
        .find_many(
            "offers",
            doc! { "tags": { "$elemMatch": { "id": &id } } },
            MongoFindOptions {
                projection: Some(doc! { "namespace": 1, "id": 1 }),
                ..Default::default()
            },
        )
        .await?;

    let namespaces: Vec<_> = offers
        .into_iter()
        .map(|mut o| o.remove("namespace").unwrap_or(Bson::Null))
        .collect();
    let base_game = state
        .mongo
        .find_one(
            "offers",
            doc! { "namespace": { "$in": namespaces }, "offerType": "BASE_GAME" },
            Some(doc! { "id": 1, "namespace": 1, "title": 1, "keyImages": 1 }),
        )
        .await?
        .as_ref()
        .map(bson_doc_to_js_json)
        .ok_or_else(|| not_found("Base game not found"))?;

    let result = localize_legacy_offers(&state, &[base_game], &loc, false)
        .await?
        .into_iter()
        .next()
        .unwrap();

    store(
        &state,
        &cache_key,
        &result,
        get_localized_cache_ttl_seconds(&result, 3600),
    )
    .await?;

    Ok(cache_header(ok(&result), ONE_MINUTE))
}

// ---------------------------------------------------------------------------
// 4. GET /collections/{slug}, GET /collections/{slug}/{week}
// ---------------------------------------------------------------------------

pub(super) fn iso_week_range_utc(week: &str) -> Result<(DateTime<Utc>, DateTime<Utc>)> {
    let bytes = week.as_bytes();
    if bytes.len() != 7
        || bytes[4] != b'W'
        || !bytes[..4].iter().chain(&bytes[5..]).all(u8::is_ascii_digit)
    {
        return Err(Error::Internal);
    }
    let year: i32 = week[..4].parse().map_err(|_| Error::Internal)?;
    let wn: i64 = week[5..].parse().map_err(|_| Error::Internal)?;
    let js_year = if (0..=99).contains(&year) {
        1900 + year
    } else {
        year
    };
    let jan4 = NaiveDate::from_ymd_opt(js_year, 1, 4)
        .ok_or(Error::Internal)?
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc();
    let jan4_day = i64::from(jan4.weekday().num_days_from_sunday());
    let offset = if jan4_day == 0 { 6 } else { jan4_day - 1 };
    let iso_mon_week1 = jan4 - Duration::days(offset);
    let start = iso_mon_week1 + Duration::days((wn - 1) * 7);
    let end_exclusive = start + Duration::days(7);
    Ok((start, end_exclusive))
}

/// Both weekly routes first filter by JavaScript Number(position), then require the latest retained value to be numeric.
pub(super) fn weekly_ranked(
    offers: Vec<Value>,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<Vec<(f64, Value)>> {
    let mut ranked = Vec::new();
    for mut offer in offers {
        if let Some(position) = weekly_position(&mut offer["positions"], start, end)? {
            offer["position"] = json!(position);
            ranked.push((position, offer));
        }
    }
    ranked.sort_by(|a, b| a.0.total_cmp(&b.0));
    Ok(ranked)
}

pub(super) fn weekly_position(
    positions: &mut Value,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<Option<f64>> {
    let range = start.timestamp_millis()..end.timestamp_millis();
    let positions = positions.as_array_mut().ok_or(Error::Internal)?;
    if positions.iter().any(Value::is_null) {
        return Err(Error::Internal);
    }
    let mut latest = None;
    positions.retain(|row| {
        let raw = row.get("date");
        let millis = match raw {
            Some(Value::Null) => Some(0),
            Some(Value::Bool(b)) => Some(i64::from(*b)),
            Some(Value::Number(n)) => n.as_f64().map(|v| v.trunc() as i64),
            Some(Value::String(s)) => DateTime::parse_from_rfc3339(s)
                .ok()
                .map(|d| d.timestamp_millis())
                .or_else(|| {
                    let timestamp = egdata_core::catalog::catalog_date(raw)?;
                    DateTime::parse_from_rfc3339(&timestamp)
                        .ok()
                        .map(|d| d.timestamp_millis())
                }),
            _ => None,
        };
        let Some(ms) = millis.filter(|ms| range.contains(ms)) else {
            return false;
        };
        if crate::v1::system::js_number_or_zero(row.get("position")) <= 0.0 {
            return false;
        }
        if latest.is_none_or(|(when, _)| ms > when) {
            latest = Some((ms, row["position"].as_f64()));
        }
        true
    });
    Ok(latest.and_then(|(_, position)| position))
}

fn collection_updated_at(collection: &Value) -> Result<String> {
    collection
        .get("updatedAt")
        .and_then(iso_or_null)
        .filter(|s| DateTime::parse_from_rfc3339(s).is_ok())
        .ok_or(Error::Internal)
}

async fn collection_current(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Response> {
    let q = query(&uri);
    let loc = locale(&q)?;
    let reg = region(&uri, &headers)?;
    let params = Page::new(&q, 10, 50);
    let skip = params.skip(0)?;
    let limit = params.limit.ok_or(Error::Internal)?;
    let page = params.page.ok_or(Error::Internal)?;
    let expand = wants_expanded(&q);

    let cache_key = format!(
        "collections:{slug}:{reg}:{}:{}:{}:v0.1",
        params.key(),
        locale_cache_segment(&loc),
        if expand { "full" } else { "card" }
    );

    if let Some(hit) = cached(&state, &cache_key).await? {
        return Ok(list_response(&hit));
    }

    let collection_doc = state
        .mongo
        .find_one("collections_v2", doc! { "_id": &slug }, None)
        .await?
        .ok_or_else(|| not_found("Collection not found"))?;
    let collection_id = collection_doc.get("_id").cloned().unwrap_or(Bson::Null);
    let collection = bson_doc_to_js_json(&collection_doc);

    let total_count = state
        .mongo
        .count_documents(
            "game_positions",
            doc! { "collectionId": &collection_id, "position": { "$gt": 0 } },
        )
        .await?;

    let offers_list = many(
        &state,
        "game_positions",
        doc! { "collectionId": &collection_id, "position": { "$gt": 0 } },
        MongoFindOptions {
            sort: Some(doc! { "position": 1 }),
            limit: Some(limit),
            skip: Some(skip),
            ..Default::default()
        },
    )
    .await?;

    let offer_ids: Vec<Bson> = offers_list
        .iter()
        .map(|o| bson_value(&o["offerId"]))
        .collect();

    let (offers_res, prices_res) = tokio::join!(
        many(
            &state,
            "offers",
            doc! { "id": { "$in": &offer_ids } },
            Default::default()
        ),
        many(
            &state,
            "pricev2",
            doc! { "offerId": { "$in": offer_ids }, "region": reg },
            Default::default()
        )
    );
    let offers = offers_res.unwrap_or_default();
    let prices = prices_res.unwrap_or_default();
    let by_id = prices_by_id(&prices);

    struct Ranked<'a> {
        offer: &'a Value,
        position: Value,
        previous: Option<&'a Value>,
        metadata: Option<&'a Value>,
    }

    let mut ranked: Vec<Ranked<'_>> = offers
        .iter()
        .map(|o| {
            let oid = o["id"].as_str();
            let col_offer = offers_list.iter().find(|i| i["offerId"].as_str() == oid);
            let position = col_offer
                .and_then(|c| c.get("position"))
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or_else(|| json!(total_count));
            let previous = col_offer.and_then(|c| c.get("previous"));
            Ranked {
                offer: o,
                position,
                previous,
                metadata: col_offer,
            }
        })
        .collect();

    ranked.sort_by(|a, b| {
        let pa = a.position.as_f64().unwrap_or(0.0);
        let pb = b.position.as_f64().unwrap_or(0.0);
        pa.total_cmp(&pb)
    });

    let elements = if expand {
        let rows: Vec<Value> = ranked
            .iter()
            .map(|r| {
                let mut obj = r.offer.clone();
                let price = r.offer["id"].as_str().and_then(|id| by_id.get(id)).copied();
                obj["price"] = price.cloned().unwrap_or(Value::Null);
                obj["position"] = r.position.clone();
                if let Some(prev) = r.previous {
                    obj["previousPosition"] = prev.clone();
                }
                if let Some(meta) = r.metadata {
                    obj["metadata"] = meta.clone();
                }
                obj
            })
            .collect();
        localize_legacy_offers(&state, &rows, &loc, false).await?
    } else {
        let cards: Vec<Value> = ranked
            .iter()
            .map(|r| {
                let price = r.offer["id"].as_str().and_then(|id| by_id.get(id)).copied();
                editorial_card(r.offer, price)
            })
            .collect::<Result<_>>()?;
        let mut localized = localize_legacy_offers(&state, &cards, &loc, true).await?;
        for (entry, r) in localized.iter_mut().zip(&ranked) {
            entry["position"] = r.position.clone();
            if let Some(prev) = r.previous {
                entry["previousPosition"] = prev.clone();
            }
            if let Some(meta) = r.metadata {
                entry["metadata"] = meta.clone();
            }
        }
        localized
    };

    let updated_at = collection_updated_at(&collection)?;
    let mut map = serde_json::Map::new();
    map.insert("elements".into(), Value::Array(elements));
    map.insert("page".into(), json!(page));
    map.insert("limit".into(), json!(limit));
    if let Some(title) = collection.get("name") {
        map.insert("title".into(), title.clone());
    }
    map.insert("total".into(), json!(total_count));
    map.insert("updatedAt".into(), json!(updated_at));
    let result = Value::Object(map);

    store(
        &state,
        &cache_key,
        &result,
        get_localized_cache_ttl_seconds(&result, 3600),
    )
    .await?;

    Ok(list_response(&result))
}

async fn collection_week(
    State(state): State<AppState>,
    Path((slug, week)): Path<(String, String)>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Response> {
    let q = query(&uri);
    let loc = locale(&q)?;
    let reg = region(&uri, &headers)?;
    let params = Page::new(&q, 10, 50);
    let skip = params.skip(0)? as usize;
    let raw_limit = params.limit.ok_or(Error::Internal)?;
    let limit = usize::try_from(raw_limit).unwrap_or(0);
    let page = params.page.ok_or(Error::Internal)?;
    let expand = wants_expanded(&q);

    let cache_key = format!(
        "collections:{week}:{slug}:{reg}:{}:{}:{}",
        params.key(),
        locale_cache_segment(&loc),
        if expand { "full" } else { "card" }
    );

    let (start, end_exclusive) = iso_week_range_utc(&week)?;

    let Some(collection_doc) = state
        .mongo
        .find_one("collections_v2", doc! { "_id": &slug }, None)
        .await?
    else {
        return Err(Error::Json(
            StatusCode::NOT_FOUND,
            json!({ "error": "Collection not found" }),
        ));
    };
    let collection_id = collection_doc.get("_id").cloned().unwrap_or(Bson::Null);
    let collection = bson_doc_to_js_json(&collection_doc);

    let offers = many(
        &state,
        "game_positions",
        doc! { "collectionId": &collection_id },
        Default::default(),
    )
    .await?;

    let ranked = weekly_ranked(offers, start, end_exclusive)?;
    let total = ranked.len();
    let page_items: Vec<Value> = ranked
        .into_iter()
        .skip(skip)
        .take(limit)
        .map(|(_, meta)| meta)
        .collect();

    let page_offer_ids: Vec<Bson> = page_items
        .iter()
        .map(|o| bson_value(&o["offerId"]))
        .collect();

    let (offers_data, prices_data) = tokio::join!(
        many(
            &state,
            "offers",
            doc! { "id": { "$in": &page_offer_ids } },
            Default::default()
        ),
        many(
            &state,
            "pricev2",
            doc! { "offerId": { "$in": page_offer_ids }, "region": reg },
            Default::default()
        )
    );
    let offers_data = offers_data?;
    let prices_data = prices_data?;

    let by_id = prices_by_id(&prices_data);

    struct PageEntry<'a> {
        offer: &'a Value,
        metadata: Value,
        price: &'a Value,
    }

    let entries: Vec<PageEntry<'_>> = page_items
        .into_iter()
        .filter_map(|meta| {
            let oid = meta["offerId"].as_str()?;
            let offer = offers_data.iter().find(|x| x["id"].as_str() == Some(oid))?;
            let price = *by_id.get(oid)?;
            Some(PageEntry {
                offer,
                metadata: meta,
                price,
            })
        })
        .collect();

    let elements = if expand {
        let rows: Vec<Value> = entries
            .into_iter()
            .map(|e| {
                let mut obj = e.offer.clone();
                obj["metadata"] = e.metadata;
                obj["price"] = e.price.clone();
                obj
            })
            .collect();
        localize_legacy_offers(&state, &rows, &loc, false).await?
    } else {
        let cards: Vec<Value> = entries
            .iter()
            .map(|e| editorial_card(e.offer, Some(e.price)))
            .collect::<Result<_>>()?;
        let mut localized = localize_legacy_offers(&state, &cards, &loc, true).await?;
        for (item, entry) in localized.iter_mut().zip(entries) {
            item["metadata"] = entry.metadata;
        }
        localized
    };

    let updated_at = collection_updated_at(&collection)?;
    let mut map = serde_json::Map::new();
    map.insert("elements".into(), Value::Array(elements));
    map.insert("page".into(), json!(page));
    map.insert("limit".into(), json!(raw_limit));
    if let Some(title) = collection.get("name") {
        map.insert("title".into(), title.clone());
    }
    map.insert("total".into(), json!(total));
    map.insert("updatedAt".into(), json!(updated_at));
    map.insert("start".into(), json!(js_iso_datetime(start)));
    map.insert("end".into(), json!(js_iso_datetime(end_exclusive)));
    let result = Value::Object(map);

    store(
        &state,
        &cache_key,
        &result,
        get_localized_cache_ttl_seconds(&result, 3600),
    )
    .await?;

    Ok(list_response(&result))
}

// ---------------------------------------------------------------------------
// 5. GET /game-awards, GET /game-awards/og
// ---------------------------------------------------------------------------

async fn game_awards(
    State(state): State<AppState>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Response> {
    let q = query(&uri);
    let loc = locale(&q)?;
    let reg = region(&uri, &headers)?;
    let expand = wants_expanded(&q);

    use crate::v1::helpers::primitive_id;
    let modules = state
        .mongo
        .find_many(
            "storefront-modules",
            doc! { "eventSlug": "the-game-awards" },
            Default::default(),
        )
        .await?;
    let mut groups = Vec::with_capacity(modules.len());
    let mut offer_ids = Vec::new();
    for module in &modules {
        let references = module.get_array("offers").map_err(|_| Error::Internal)?;
        if references.is_empty() {
            continue;
        }
        let mut group = Vec::with_capacity(references.len());
        for reference in references {
            if matches!(reference, Bson::Null | Bson::Undefined) {
                return Err(Error::Internal);
            }
            let id = reference.as_document().and_then(|r| r.get("id"));
            offer_ids.push(id.cloned().unwrap_or(Bson::Null));
            group.push(id);
        }
        groups.push((module, group));
    }
    let offers = state
        .mongo
        .find_many(
            "offers",
            doc! { "id": { "$in": &offer_ids } },
            Default::default(),
        )
        .await?;
    let prices = state
        .mongo
        .find_many(
            "pricev2",
            doc! { "offerId": { "$in": offer_ids }, "region": reg },
            Default::default(),
        )
        .await?;
    let offers_by_id: HashMap<_, _> = offers
        .iter()
        .filter_map(|offer| Some((primitive_id(offer.get("id"))?, offer)))
        .collect();
    let prices_by_id: HashMap<_, _> = prices
        .iter()
        .filter_map(|price| {
            Some((
                primitive_id(price.get("offerId"))?,
                bson_doc_to_js_json(price),
            ))
        })
        .collect();

    use futures::{StreamExt, stream::FuturesUnordered};
    let mut pending = FuturesUnordered::new();
    let mut result = Vec::with_capacity(groups.len());
    let mut error = None;
    let (state, loc, offers_by_id, prices_by_id) = (&state, &loc, &offers_by_id, &prices_by_id);
    for (module, references) in groups {
        let mut group = Box::pin(async move {
            let title = module.get_str("title").map_err(|_| Error::Internal)?;
            let rows: Vec<_> = references
                .into_iter()
                .filter_map(primitive_id)
                .filter_map(|key| Some((offers_by_id.get(&key)?, prices_by_id.get(&key))))
                .map(|(doc, price)| {
                    let mut offer = bson_doc_to_js_json(doc);
                    if expand {
                        offer["price"] = price.cloned().unwrap_or(Value::Null);
                        Ok(offer)
                    } else {
                        editorial_card(&offer, price)
                    }
                })
                .collect::<Result<_>>()?;
            let localized = localize_legacy_offers(state, &rows, loc, !expand).await?;
            Ok(json!({
                "title": egdata_core::v1::query::trim_js_whitespace(title),
                "offers": localized,
            }))
        });
        // Promise.all starts every module even if a sibling immediately rejects.
        match futures::poll!(group.as_mut()) {
            std::task::Poll::Ready(Ok(value)) => result.push(value),
            std::task::Poll::Ready(Err(err)) => {
                error.get_or_insert(err);
            }
            std::task::Poll::Pending => pending.push(group),
        }
    }
    if let Some(err) = error {
        return Err(err);
    }
    while let Some(group) = pending.next().await {
        result.push(group?);
    }

    Ok(list_response(&Value::Array(result)))
}

pub(super) fn game_awards_og_html(now: DateTime<Utc>) -> String {
    let cutoff = "2025-12-11T00:00:00Z"
        .parse::<DateTime<Utc>>()
        .expect("valid cutoff");
    let kind = if now < cutoff {
        "Nominees"
    } else {
        "Announcements and winners"
    };
    let paths: String = TGA_LOGO_PATHS
        .iter()
        .map(|d| format!(r##"<path d="{d}" fill="#FF9F59" />"##))
        .collect();
    format!(
        r#"<div style="width:1200px;height:630px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#001B3D;background-image:linear-gradient(135deg, #001B3D 0%, #000913 100%);font-family:Roboto,sans-serif;position:relative;overflow:hidden;padding:48px;"><div style="display:flex;align-items:center;gap:32px;margin-bottom:48px;"><svg width="360" viewBox="0 0 200 68" style="color:#FF9F59;">{paths}</svg><img src="https://cdn.egdata.app/logo_simple_white_clean.png" width="160" height="160" /></div><div style="display:flex;flex-direction:column;align-items:center;gap:0px;"><div style="font-size:48px;color:#FFFFFF;text-align:center;line-height:1.3;max-width:900px;font-weight:300;">Explore all the {kind} for</div><div style="font-size:56px;font-weight:700;color:#FFFFFF;text-align:center;line-height:1.1;margin-top:8px;">The Game Awards 2025</div></div><div style="margin-top:64px;font-size:24px;color:rgba(255,255,255,0.5);font-weight:300;letter-spacing:0.05em;">egdata.app/the-game-awards</div></div>"#
    )
}

async fn game_awards_og(State(state): State<AppState>, uri: Uri) -> Result<Response> {
    let versioned = uri_query(&uri, "v").is_some_and(|v| !v.is_empty());
    let html = game_awards_og_html((state.now)());
    let bytes = state
        .og
        .render_editorial(&html, egdata_core::ports::EditorialOgTemplate::GameAwards)
        .await?;
    Ok(og_image_response(
        OgImageFormat::Png,
        bytes,
        versioned,
        true,
        "Accept-Encoding",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{middleware::test_support::test_app_state, state::ApiConfig};
    use async_trait::async_trait;
    use axum::http::Request;
    use bson::Document;
    use chrono::Weekday;
    use egdata_core::{
        error::CoreError,
        ports::{MongoStorePort, OgRendererPort, ResponseCachePort},
    };
    use std::result::Result as StdResult;
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;

    struct OracleIo {
        name: String,
        remaining: Mutex<Vec<Value>>,
        rendered_html: Mutex<Vec<String>>,
    }

    impl OracleIo {
        fn replay(&self, call: Value) -> StdResult<Value, CoreError> {
            let mut remaining = self.remaining.lock().unwrap();
            let index = remaining
                .iter()
                .position(|entry| entry["call"] == call)
                .expect("unexpected oracle call");
            let entry = remaining.remove(index);
            if index > 0 {
                assert_eq!(index, 1, "{} read order", self.name);
                let pending = &remaining[0]["call"];
                let price_join = call["method"] == "many"
                    && pending["method"] == "many"
                    && matches!(
                        (call["collection"].as_str(), pending["collection"].as_str()),
                        (Some("pricev2"), Some("offers")) | (Some("offers"), Some("pricev2"))
                    );
                assert!(
                    price_join,
                    "{} read order: {call} before {pending}",
                    self.name
                );
            }
            if entry["error"] == true {
                Err(CoreError::Internal("fixture read failed".into()))
            } else {
                Ok(entry["result"].clone())
            }
        }
    }

    fn fixture_bson(value: &Bson) -> Value {
        match value {
            Bson::DateTime(date) => {
                json!({ "$date": egdata_infra::bson_json::bson_datetime_to_iso_string(*date) })
            }
            Bson::ObjectId(id) => json!({ "$oid": id.to_hex() }),
            Bson::RegularExpression(regex) => {
                json!({ "$regularExpression": { "pattern": regex.pattern, "options": regex.options } })
            }
            Bson::Document(doc) => fixture_doc(doc),
            Bson::Array(items) => Value::Array(items.iter().map(fixture_bson).collect()),
            other => egdata_infra::bson_json::bson_to_js_json(other),
        }
    }

    fn fixture_doc(doc: &Document) -> Value {
        Value::Object(
            doc.iter()
                .map(|(k, v)| (k.clone(), fixture_bson(v)))
                .collect(),
        )
    }

    fn result_doc(value: &Value) -> Document {
        Bson::try_from(value.clone())
            .unwrap()
            .as_document()
            .unwrap()
            .clone()
    }

    fn find_options(opt: MongoFindOptions) -> Value {
        let mut options = json!({});
        if let Some(v) = opt.sort {
            options["sort"] = bson_doc_to_js_json(&v);
        }
        if let Some(v) = opt.projection {
            options["projection"] = bson_doc_to_js_json(&v);
        }
        if let Some(v) = opt.limit {
            options["limit"] = json!(v);
        }
        if let Some(v) = opt.skip {
            options["skip"] = json!(v);
        }
        options
    }

    #[async_trait]
    impl MongoStorePort for OracleIo {
        async fn find_one(
            &self,
            collection: &str,
            filter: Document,
            projection: Option<Document>,
        ) -> StdResult<Option<Document>, CoreError> {
            self.find_one_with_options(
                collection,
                filter,
                MongoFindOptions {
                    projection,
                    ..Default::default()
                },
            )
            .await
        }

        async fn find_one_with_options(
            &self,
            collection: &str,
            filter: Document,
            opt: MongoFindOptions,
        ) -> StdResult<Option<Document>, CoreError> {
            let value = self.replay(json!({
                "collection": collection,
                "method": "one",
                "query": fixture_doc(&filter),
                "options": find_options(opt),
            }))?;
            Ok((!value.is_null()).then(|| result_doc(&value)))
        }

        async fn find_many(
            &self,
            collection: &str,
            filter: Document,
            opt: MongoFindOptions,
        ) -> StdResult<Vec<Document>, CoreError> {
            let value = self.replay(json!({
                "collection": collection,
                "method": "many",
                "query": fixture_doc(&filter),
                "options": find_options(opt),
            }))?;
            if collection == "egs_localizations"
                && self.name.starts_with("game-awards-failed-sibling-")
            {
                // Another module already rejected. The response must not wait for this read.
                std::future::pending::<()>().await;
            }
            // A database result resolves asynchronously, even when a mock already has its rows.
            tokio::task::yield_now().await;
            Ok(value.as_array().unwrap().iter().map(result_doc).collect())
        }

        async fn aggregate(
            &self,
            collection: &str,
            pipeline: Vec<Document>,
        ) -> StdResult<Vec<Document>, CoreError> {
            let stages: Vec<Value> = pipeline.iter().map(fixture_doc).collect();
            let value = self.replay(json!({
                "collection": collection,
                "method": "aggregate",
                "query": stages,
                "options": {},
            }))?;
            Ok(value.as_array().unwrap().iter().map(result_doc).collect())
        }

        async fn count_documents(
            &self,
            collection: &str,
            filter: Document,
        ) -> StdResult<u64, CoreError> {
            let value = self.replay(json!({
                "collection": collection,
                "method": "count",
                "query": fixture_doc(&filter),
                "options": {},
            }))?;
            Ok(value.as_u64().unwrap())
        }

        async fn distinct(&self, _: &str, _: &str, _: Document) -> StdResult<Vec<Bson>, CoreError> {
            Ok(vec![])
        }

        async fn insert_one(&self, _: &str, _: Document) -> StdResult<(), CoreError> {
            Ok(())
        }

        async fn update_one(
            &self,
            _: &str,
            _: Document,
            _: Document,
            _: bool,
        ) -> StdResult<u64, CoreError> {
            Ok(0)
        }

        async fn delete_one(&self, _: &str, _: Document) -> StdResult<u64, CoreError> {
            Ok(0)
        }

        async fn ping(&self) -> StdResult<bool, CoreError> {
            Ok(true)
        }
    }

    #[async_trait]
    impl ResponseCachePort for OracleIo {
        async fn get(&self, key: &str) -> StdResult<Option<String>, CoreError> {
            let hit = self.replay(json!({ "method": "get", "key": key }))?;
            Ok((!hit.is_null()).then(|| hit.to_string()))
        }

        async fn set(&self, key: &str, payload: &str, ttl: u64) -> StdResult<(), CoreError> {
            let call = json!({
                "method": "set",
                "key": key,
                "payload": serde_json::from_str::<Value>(payload).unwrap(),
                "ttl": ttl,
            });
            self.replay(call)?;
            Ok(())
        }

        async fn del(&self, _: &str) -> StdResult<(), CoreError> {
            Ok(())
        }

        async fn ping(&self) -> StdResult<bool, CoreError> {
            Ok(true)
        }
    }

    #[async_trait]
    impl OgRendererPort for OracleIo {
        async fn render_image(
            &self,
            html: &str,
            width: u32,
            height: u32,
            format: OgImageFormat,
        ) -> StdResult<Vec<u8>, CoreError> {
            assert_eq!((width, height), (1200, 630));
            self.rendered_html.lock().unwrap().push(html.to_owned());
            Ok(match format {
                OgImageFormat::Png => vec![137, 80, 78, 71],
                OgImageFormat::Webp => vec![82, 73, 70, 70],
            })
        }
    }

    #[tokio::test]
    async fn legacy_og_editorial_http_node_oracle() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../tests/fixtures/legacy-og-editorial-http-node.json"
        ))
        .unwrap();

        for case in cases {
            let name = case["name"].as_str().unwrap();
            let io = Arc::new(OracleIo {
                name: name.into(),
                remaining: Mutex::new(case["trace"].as_array().unwrap().clone()),
                rendered_html: Mutex::new(Vec::new()),
            });
            let mut state = test_app_state(ApiConfig::default());
            state.now = || "2026-11-17T00:00:00Z".parse().unwrap();
            state.mongo = io.clone();
            state.cache = io.clone();
            state.og = io.clone();

            let app = crate::runtime::application(state);
            let source = &case["request"];
            let mut builder = Request::builder()
                .method(source["method"].as_str().unwrap())
                .uri(source["path"].as_str().unwrap());
            if let Some(headers) = source["headers"].as_object() {
                for (k, v) in headers {
                    builder = builder.header(k, v.as_str().unwrap());
                }
            }
            let response = tokio::time::timeout(
                std::time::Duration::from_secs(10),
                app.oneshot(builder.body(Body::empty()).unwrap()),
            )
            .await
            .unwrap_or_else(|_| panic!("{name} did not finish"))
            .unwrap();
            if let Some(headers) = case["additionalHeaders"].as_object() {
                for (h_name, expected) in headers {
                    assert_eq!(
                        response.headers().get(h_name).map(|v| v.to_str().unwrap()),
                        expected.as_str(),
                        "{name} {h_name}"
                    );
                }
            }
            assert_eq!(
                crate::v1::oracle_test_support::capture_response(response).await,
                case["response"],
                "{name}"
            );
            assert!(
                io.remaining.lock().unwrap().is_empty(),
                "{name} missing reads"
            );

            if let Some(renderer) = case.get("renderer") {
                let html = io.rendered_html.lock().unwrap();
                assert_eq!(html.len(), 1, "{name} expected rendered HTML");
                let html = &html[0];
                if let Some(card) = renderer.get("card").and_then(Value::as_object) {
                    for field in [
                        "title",
                        "subtitle",
                        "price",
                        "priceDetail",
                        "lastUpdate",
                        "assetSize",
                        "assetDetail",
                        "releaseDate",
                    ] {
                        if let Some(val) = card.get(field).and_then(Value::as_str) {
                            assert!(html.contains(val), "{name} missing {field}={val}");
                        }
                    }
                    if let Some(metrics) = card.get("metrics").and_then(Value::as_array) {
                        for metric in metrics {
                            for key in ["label", "value", "detail"] {
                                let val = metric[key].as_str().unwrap();
                                assert!(html.contains(val), "{name} missing metric {key}={val}");
                            }
                        }
                    }
                    if let Some(footer) = card.get("footer").and_then(Value::as_object) {
                        for key in ["label", "value"] {
                            let val = footer[key].as_str().unwrap();
                            assert!(html.contains(val), "{name} missing footer {key}={val}");
                        }
                    }
                } else if renderer.get("kind").and_then(Value::as_str) == Some("game-awards") {
                    assert!(html.contains("Announcements and winners"));
                    assert!(html.contains("The Game Awards 2025"));
                    assert!(html.contains("egdata.app/the-game-awards"));
                    assert!(html.contains("https://cdn.egdata.app/logo_simple_white_clean.png"));
                    assert!(html.contains(TGA_LOGO_PATHS[0]));
                }
            }
        }
    }

    #[derive(Default)]
    struct MockStore {
        offers: Mutex<Vec<Document>>,
        prices: Mutex<Vec<Document>>,
        subitems: Mutex<Vec<Document>>,
        items: Mutex<Vec<Document>>,
        assets: Mutex<Vec<Document>>,
        builds: Mutex<Vec<Document>>,
        sandboxes: Mutex<Vec<Document>>,
        tags: Mutex<Vec<Document>>,
        collections: Mutex<Vec<Document>>,
        positions: Mutex<Vec<Document>>,
        modules: Mutex<Vec<Document>>,
        cache: Mutex<HashMap<String, String>>,
        fail_collection: Mutex<Option<&'static str>>,
        fail_og: Mutex<bool>,
    }

    #[async_trait]
    impl MongoStorePort for MockStore {
        async fn find_one(
            &self,
            collection: &str,
            filter: Document,
            projection: Option<Document>,
        ) -> StdResult<Option<Document>, CoreError> {
            self.find_one_with_options(
                collection,
                filter,
                MongoFindOptions {
                    projection,
                    ..Default::default()
                },
            )
            .await
        }

        async fn find_one_with_options(
            &self,
            collection: &str,
            filter: Document,
            _opt: MongoFindOptions,
        ) -> StdResult<Option<Document>, CoreError> {
            if *self.fail_collection.lock().unwrap() == Some(collection) {
                return Err(CoreError::Internal("mock mongo failure".into()));
            }
            let list = match collection {
                "offers" => self.offers.lock().unwrap().clone(),
                "pricev2" => self.prices.lock().unwrap().clone(),
                "sandboxes" => self.sandboxes.lock().unwrap().clone(),
                "tags" => self.tags.lock().unwrap().clone(),
                "collections_v2" => self.collections.lock().unwrap().clone(),
                "items" => self.items.lock().unwrap().clone(),
                _ => Vec::new(),
            };
            if let Ok(id) = filter.get_str("id") {
                return Ok(list.into_iter().find(|d| d.get_str("id").ok() == Some(id)));
            }
            if let Ok(id) = filter.get_str("_id") {
                return Ok(list.into_iter().find(|d| d.get_str("_id").ok() == Some(id)));
            }
            Ok(list.into_iter().next())
        }

        async fn find_many(
            &self,
            collection: &str,
            _filter: Document,
            _opt: MongoFindOptions,
        ) -> StdResult<Vec<Document>, CoreError> {
            if *self.fail_collection.lock().unwrap() == Some(collection) {
                return Err(CoreError::Internal("mock mongo failure".into()));
            }
            Ok(match collection {
                "offers" => self.offers.lock().unwrap().clone(),
                "pricev2" => self.prices.lock().unwrap().clone(),
                "offersubitems" => self.subitems.lock().unwrap().clone(),
                "items" => self.items.lock().unwrap().clone(),
                "assets" => self.assets.lock().unwrap().clone(),
                "builds" => self.builds.lock().unwrap().clone(),
                "tags" => self.tags.lock().unwrap().clone(),
                "game_positions" => self.positions.lock().unwrap().clone(),
                "storefront-modules" => self.modules.lock().unwrap().clone(),
                _ => Vec::new(),
            })
        }

        async fn aggregate(
            &self,
            collection: &str,
            _pipeline: Vec<Document>,
        ) -> StdResult<Vec<Document>, CoreError> {
            if *self.fail_collection.lock().unwrap() == Some(collection) {
                return Err(CoreError::Internal("mock mongo failure".into()));
            }
            Ok(self.offers.lock().unwrap().clone())
        }

        async fn count_documents(
            &self,
            collection: &str,
            _filter: Document,
        ) -> StdResult<u64, CoreError> {
            if *self.fail_collection.lock().unwrap() == Some(collection) {
                return Err(CoreError::Internal("mock mongo failure".into()));
            }
            Ok(match collection {
                "offers" => self.offers.lock().unwrap().len() as u64,
                "game_positions" => self.positions.lock().unwrap().len() as u64,
                _ => 0,
            })
        }

        async fn distinct(&self, _: &str, _: &str, _: Document) -> StdResult<Vec<Bson>, CoreError> {
            Ok(vec![])
        }
        async fn insert_one(&self, _: &str, _: Document) -> StdResult<(), CoreError> {
            Ok(())
        }
        async fn update_one(
            &self,
            _: &str,
            _: Document,
            _: Document,
            _: bool,
        ) -> StdResult<u64, CoreError> {
            Ok(0)
        }
        async fn delete_one(&self, _: &str, _: Document) -> StdResult<u64, CoreError> {
            Ok(0)
        }
        async fn ping(&self) -> StdResult<bool, CoreError> {
            Ok(true)
        }
    }

    #[async_trait]
    impl ResponseCachePort for MockStore {
        async fn get(&self, key: &str) -> StdResult<Option<String>, CoreError> {
            Ok(self.cache.lock().unwrap().get(key).cloned())
        }
        async fn set(&self, key: &str, payload: &str, _ttl: u64) -> StdResult<(), CoreError> {
            self.cache
                .lock()
                .unwrap()
                .insert(key.to_string(), payload.to_string());
            Ok(())
        }
        async fn del(&self, _: &str) -> StdResult<(), CoreError> {
            Ok(())
        }
        async fn ping(&self) -> StdResult<bool, CoreError> {
            Ok(true)
        }
    }

    #[async_trait]
    impl OgRendererPort for MockStore {
        async fn render_image(
            &self,
            _html: &str,
            _width: u32,
            _height: u32,
            format: OgImageFormat,
        ) -> StdResult<Vec<u8>, CoreError> {
            if *self.fail_og.lock().unwrap() {
                return Err(CoreError::Internal("og failure".into()));
            }
            Ok(match format {
                OgImageFormat::Png => vec![137, 80, 78, 71],
                OgImageFormat::Webp => vec![82, 73, 70, 70],
            })
        }
    }

    #[test]
    fn helpers_cover_all_branches_and_formats() {
        assert_eq!(
            html_escape("a&b<c>d\"e'f"),
            "a&amp;b&lt;c&gt;d&quot;e&#39;f"
        );

        let card_short = DatabaseOgCard {
            title: "Short".into(),
            subtitle: "Sub".into(),
            metrics: [
                OgMetric {
                    label: "A".into(),
                    value: "1".into(),
                    detail: "d".into(),
                },
                OgMetric {
                    label: "B".into(),
                    value: "123456789012".into(),
                    detail: "d".into(),
                },
                OgMetric {
                    label: "C".into(),
                    value: "123456789012345".into(),
                    detail: "d".into(),
                },
            ],
            footer_label: "F".into(),
            footer_value: "V".into(),
        };
        let html_no_cover = render_database_og_html(&card_short, None);
        assert!(html_no_cover.contains("font-size:64px"));
        assert!(html_no_cover.contains("font-size:28px"));
        assert!(html_no_cover.contains("font-size:24px"));

        let mut card_med = card_short;
        card_med.title = "A".repeat(31);
        assert!(
            render_database_og_html(&card_med, Some("https://img.test/a.png"))
                .contains("font-size:44px")
        );
        card_med.title = "A".repeat(61);
        assert!(render_database_og_html(&card_med, None).contains("font-size:36px"));

        assert_eq!(format_og_date(None), "Not available");
        assert_eq!(format_og_date(Some(&json!(123))), "Not available");
        assert_eq!(format_og_date(Some(&json!("not-a-date"))), "Not available");
        assert_eq!(
            format_og_date(Some(&json!("2026-09-05T00:00:00Z"))),
            "05 Sept 2026"
        );
        assert_eq!(
            format_og_date(Some(&json!("2026-01-15T00:00:00Z"))),
            "15 Jan 2026"
        );

        assert_eq!(format_og_size(None), "Not available");
        assert_eq!(format_og_size(Some(0.0)), "0.00 GB");
        assert_eq!(format_og_size(Some(9_999_999.0)), "< 0.01 GB");
        assert_eq!(format_og_size(Some(1_500_000_000.0)), "1.50 GB");

        assert_eq!(format_thousands_en_us(1234567), "1,234,567");
        for (cur, expected) in [
            ("USD", "$19.99"),
            ("EUR", "€19.99"),
            ("GBP", "£19.99"),
            ("JPY", "¥20"),
            ("CNY", "CN¥19.99"),
            ("KRW", "₩20"),
            ("INR", "₹19.99"),
            ("VND", "₫20"),
            ("ILS", "₪19.99"),
            ("PHP", "₱19.99"),
            ("BRL", "R$19.99"),
            ("CAD", "CA$19.99"),
            ("AUD", "A$19.99"),
            ("MXN", "MX$19.99"),
            ("HKD", "HK$19.99"),
            ("NZD", "NZ$19.99"),
            ("TWD", "NT$19.99"),
            ("PLN", "PLN\u{00a0}19.99"),
        ] {
            assert_eq!(
                offer_card_price(Some(1999.0), cur).as_deref(),
                Some(expected)
            );
        }

        // latest_og_download branches
        assert_eq!(latest_og_download(&[], None), (None, None));
        let assets = vec![
            json!({ "artifactId": "a1", "platform": "Windows", "downloadSizeBytes": 100, "createdAt": "2026-01-01T00:00:00Z" }),
            json!({ "artifactId": "a1", "downloadSizeBytes": 200, "updatedAt": "2026-02-01T00:00:00Z" }),
        ];
        assert_eq!(latest_og_download(&assets, None), (Some(200.0), None));
        let build_unknown_multi = json!({ "appName": "a1", "labelName": "Unknown" });
        assert_eq!(
            latest_og_download(&assets, Some(&build_unknown_multi)),
            (Some(200.0), None)
        );
        let single_asset =
            vec![json!({ "artifactId": "a1", "platform": "Linux", "downloadSizeBytes": 300 })];
        assert_eq!(
            latest_og_download(&single_asset, Some(&build_unknown_multi)),
            (Some(300.0), Some("Linux".into()))
        );
        let build_explicit_plat = json!({ "appName": "a1", "platform": "Windows", "labelName": "L", "downloadSizeBytes": 400 });
        assert_eq!(
            latest_og_download(&assets, Some(&build_explicit_plat)),
            (Some(400.0), Some("Windows".into()))
        );
        let two_plat_assets = vec![
            json!({ "artifactId": "a1", "platform": "Windows", "downloadSizeBytes": 10 }),
            json!({ "artifactId": "a1", "platform": "Mac", "downloadSizeBytes": 20 }),
        ];
        assert_eq!(
            latest_og_download(&two_plat_assets, Some(&build_unknown_multi)),
            (None, None)
        );

        // count_sandbox_og_assets branches
        let s_items = vec![
            json!({}),
            json!({ "releaseInfo": [
                { "appId": "", "platform": ["Win"] },
                { "appId": "known", "platform": ["Win"] },
                { "appId": "v1" },
                { "appId": "v2", "platform": ["Win", "Mac"] }
            ]}),
        ];
        assert_eq!(
            count_sandbox_og_assets(&[json!({ "artifactId": "known" })], &s_items),
            3
        );

        // iso_week_range_utc branches
        assert!(iso_week_range_utc("bad").is_err());
        assert!(iso_week_range_utc("2025X01").is_err());
        assert!(iso_week_range_utc("2025Wab").is_err());
        let (s99, e99) = iso_week_range_utc("0099W01").ok().unwrap();
        assert_eq!((e99 - s99).num_days(), 7);
        let (s_sun, _) = iso_week_range_utc("2026W01").ok().unwrap();
        assert_eq!(s_sun.weekday(), Weekday::Mon);

        // collection_updated_at branches
        assert!(collection_updated_at(&json!({})).is_err());
        assert!(collection_updated_at(&json!({ "updatedAt": "bad" })).is_err());
        assert_eq!(
            collection_updated_at(&json!({ "updatedAt": "2026-01-02T00:00:00Z" }))
                .ok()
                .unwrap(),
            "2026-01-02T00:00:00.000Z"
        );
    }

    #[tokio::test]
    async fn edge_cases_and_error_paths() {
        let store = Arc::new(MockStore::default());
        store.offers.lock().unwrap().push(doc! {
            "id": "o1",
            "namespace": "ns1",
            "offerType": "",
            "title": "Edge Offer",
            "items": [{ "id": "i1" }],
            "countriesWhitelist": ["US"],
            "seller": { "name": "Dev" },
            "customAttributes": [],
        });
        store.offers.lock().unwrap().push(doc! {
            "id": "o2",
            "namespace": "ns1",
            "offerType": "BASE_GAME",
            "title": "Second Offer",
        });
        store.prices.lock().unwrap().push(doc! {
            "offerId": "o1",
            "region": "US",
            "price": { "currencyCode": "USD", "discountPrice": -5 },
        });
        store
            .tags
            .lock()
            .unwrap()
            .push(doc! { "id": "ev", "name": "Ev" });
        store.collections.lock().unwrap().push(doc! {
            "_id": "col",
            "updatedAt": bson::DateTime::from_millis(1_700_000_000_000),
        });
        store.positions.lock().unwrap().push(doc! {
            "offerId": "o1",
            "position": 2,
            "positions": [
                { "position": 2, "date": "bad-date" },
                { "position": 2, "date": "2025-07-30T00:00:00.000Z" },
                { "position": 3, "date": "2025-07-29T00:00:00.000Z" },
                { "position": 1, "date": "2025-07-30T00:00:00.000Z" },
                { "position": 0, "date": "2025-07-31T00:00:00.000Z" },
            ],
        });
        store.positions.lock().unwrap().push(doc! {
            "offerId": "o2",
            "position": 1,
            "positions": [],
        });
        store
            .modules
            .lock()
            .unwrap()
            .push(doc! { "eventSlug": "the-game-awards", "title": "NoOffers" });
        store.modules.lock().unwrap().push(doc! {
            "eventSlug": "the-game-awards",
            "title": "WithOffers",
            "offers": [{ "id": "o1" }],
        });

        let mut state = test_app_state(ApiConfig::default());
        state.now = || "2025-12-01T00:00:00Z".parse().unwrap();
        state.mongo = store.clone();
        state.cache = store.clone();
        state.og = store.clone();
        let app = crate::runtime::application(state);

        // Offer OG with empty offerType & negative price -> "Unavailable"
        let r_og = app
            .clone()
            .oneshot(Request::get("/offers/o1/og").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(r_og.status(), StatusCode::OK);

        // Promotion detail with default sort + regex query, sortBy=price without q, and NaN limit error
        let r_promo = app
            .clone()
            .oneshot(
                Request::get("/promotions/ev?q=Edge")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_promo.status(), StatusCode::OK);

        let r_promo_price = app
            .clone()
            .oneshot(
                Request::get("/promotions/ev?sortBy=price")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_promo_price.status(), StatusCode::OK);

        let r_nan = app
            .clone()
            .oneshot(
                Request::get("/promotions/ev?limit=abc")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_nan.status(), StatusCode::INTERNAL_SERVER_ERROR);

        // Collection current with 2 ranked items, missing collection.name & Promise.allSettled price failure
        *store.fail_collection.lock().unwrap() = Some("pricev2");
        let r_col = app
            .clone()
            .oneshot(
                Request::get("/collections/col")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_col.status(), StatusCode::OK);

        // Collection week with Promise.all failure -> 500
        let r_week_err = app
            .clone()
            .oneshot(
                Request::get("/collections/col/2025W31")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_week_err.status(), StatusCode::INTERNAL_SERVER_ERROR);

        // Collection week with negative limit -> empty slice & bad-date position skipped
        *store.fail_collection.lock().unwrap() = None;
        let r_week_neg = app
            .clone()
            .oneshot(
                Request::get("/collections/col/2025W31?limit=-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_week_neg.status(), StatusCode::OK);

        // Node reads module.offers.map before either catalog lookup.
        let r_ga = app
            .clone()
            .oneshot(Request::get("/game-awards").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(r_ga.status(), StatusCode::INTERNAL_SERVER_ERROR);

        // Game awards OG before cutoff ("Nominees") + real Takumi PNG render check
        let r_ga_og = app
            .clone()
            .oneshot(Request::get("/game-awards/og").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(r_ga_og.status(), StatusCode::OK);
        let html_before = game_awards_og_html("2025-12-01T00:00:00Z".parse().unwrap());
        assert!(html_before.contains("Nominees"));
        let real_png = egdata_infra::og_renderer::render_html_to_image(
            &html_before,
            (1200, 630),
            egdata_infra::og_renderer::OgImageFormat::Png,
            HashMap::new(),
        )
        .unwrap();
        assert_eq!(&real_png[..4], &[137, 80, 78, 71]);

        // OG renderer failure -> 500
        *store.fail_og.lock().unwrap() = true;
        let r_og_fail = app
            .oneshot(Request::get("/game-awards/og").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(r_og_fail.status(), StatusCode::INTERNAL_SERVER_ERROR);

        // Exercise remaining test-double trait branches & Bson conversion paths
        let oid = bson::oid::ObjectId::new();
        assert_eq!(
            fixture_bson(&Bson::ObjectId(oid)),
            json!({ "$oid": oid.to_hex() })
        );
        assert_eq!(
            fixture_bson(&Bson::DateTime(bson::DateTime::from_millis(0))),
            json!({ "$date": "1970-01-01T00:00:00.000Z" })
        );
        let _ = store.find_one("unknown", doc! {}, None).await;
        let _ = store
            .find_many("unknown", doc! {}, Default::default())
            .await;
        let _ = store.count_documents("unknown", doc! {}).await;
        let _ = MongoStorePort::distinct(store.as_ref(), "x", "y", doc! {}).await;
        let _ = MongoStorePort::insert_one(store.as_ref(), "x", doc! {}).await;
        let _ = MongoStorePort::update_one(store.as_ref(), "x", doc! {}, doc! {}, false).await;
        let _ = MongoStorePort::delete_one(store.as_ref(), "x", doc! {}).await;
        let _ = MongoStorePort::ping(store.as_ref()).await;
        let _ = ResponseCachePort::del(store.as_ref(), "x").await;
        let _ = ResponseCachePort::ping(store.as_ref()).await;
        let _ = OgRendererPort::render_image(store.as_ref(), "", 1, 1, OgImageFormat::Webp).await;

        let io = OracleIo {
            name: "join-and-err".into(),
            remaining: Mutex::new(vec![
                json!({ "call": { "collection": "offers", "method": "many", "query": {}, "options": {} }, "result": [] }),
                json!({ "call": { "collection": "pricev2", "method": "many", "query": {}, "options": {} }, "result": [] }),
                json!({ "call": { "collection": "offers", "method": "one", "query": {}, "options": {} }, "error": true }),
            ]),
            rendered_html: Mutex::new(vec![]),
        };
        assert!(
            io.find_many("pricev2", doc! {}, Default::default())
                .await
                .is_ok()
        );
        assert!(
            io.find_many("offers", doc! {}, Default::default())
                .await
                .is_ok()
        );
        assert!(io.find_one("offers", doc! {}, None).await.is_err());
        let _ = MongoStorePort::distinct(&io, "x", "y", doc! {}).await;
        let _ = MongoStorePort::insert_one(&io, "x", doc! {}).await;
        let _ = MongoStorePort::update_one(&io, "x", doc! {}, doc! {}, false).await;
        let _ = MongoStorePort::delete_one(&io, "x", doc! {}).await;
        let _ = MongoStorePort::ping(&io).await;
        let _ = ResponseCachePort::del(&io, "x").await;
        let _ = ResponseCachePort::ping(&io).await;
    }
}
