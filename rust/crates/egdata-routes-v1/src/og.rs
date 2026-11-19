//! OpenGraph image rendering and legacy OG redirect handlers for `/v1`.
pub use egdata_http_core::shared::og::*;

use std::collections::HashSet;

use axum::{
    Extension, Router,
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri},
    response::Response,
};
use bson::{Bson, Document, doc};
use egdata_core::{
    ports::{MongoFindOptions, OgImageFormat},
    pricing::{PriceAvailability, is_price_country_eligible},
    v1::serialization::stored_identifier,
    v1::{ProblemError, REGIONS, country_and_region, not_found},
};
use egdata_infra::og_renderer::format_og_size;

use crate::{
    state::AppState,
    helpers::{V1RequestContext, primitive_id, problem_response},
};

const OG_IMAGE_PRIORITY: &[&str] = &[
    "DieselGameBoxTall",
    "OfferImageTall",
    "DieselStoreFrontTall",
    "DieselStoreFrontWide",
    "OfferImageWide",
    "Featured",
    "DieselGameBoxWide",
];

const IMAGE_CACHE_CONTROL: &str = "private, no-cache";
const IMAGE_CDN_CACHE_CONTROL: &str = "no-store";

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

pub fn router() -> Router<AppState> {
    route_group("").router
}

pub fn route_group(prefix: &str) -> super::RouteGroup {
    super::RouteGroup::new(prefix)
        .get("/offers/{id}/og", offer_og_png)
        .get("/offers/{id}/og.webp", offer_og_webp)
        .get("/sandboxes/{sandboxId}/og", sandbox_og_png)
        .get("/sandboxes/{sandboxId}/og.webp", sandbox_og_webp)
        .get("/free-games/og", redirect_free_games_og)
        .get("/game-awards/og", redirect_game_awards_og)
        .get("/collections/{slug}/{week}/og", redirect_collections_og)
}

fn request_id_from(headers: &HeaderMap, ctx: Option<&Extension<V1RequestContext>>) -> String {
    if let Some(Extension(c)) = ctx {
        return c.request_id.clone();
    }
    headers
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())
        .unwrap_or("req_v1")
        .to_string()
}

fn query_param(uri: &Uri, name: &str) -> Option<String> {
    let query = uri.query()?;
    for (k, v) in url::form_urlencoded::parse(query.as_bytes()) {
        if k == name {
            return Some(v.into_owned());
        }
    }
    None
}

fn insert_request_id(headers: &mut HeaderMap, request_id: &str) {
    if let Ok(value) = HeaderValue::from_str(request_id) {
        headers.insert("x-request-id", value);
    }
}

fn og_error_response(err: &ProblemError, path: &str, req_id: &str) -> Response {
    let custom_not_found =
        matches!(err.code.as_str(), "OFFER_NOT_FOUND" | "SANDBOX_NOT_FOUND") && err.status == 404;
    if !custom_not_found {
        return problem_response(err, path, Some(req_id));
    }
    let mut headers = HeaderMap::new();
    headers.insert(
        "content-type",
        HeaderValue::from_static("application/problem+json"),
    );
    headers.insert(
        "cache-control",
        HeaderValue::from_static("private, no-cache"),
    );
    headers.insert("cdn-cache-control", HeaderValue::from_static("no-store"));
    headers.insert(
        "cloudflare-cdn-cache-control",
        HeaderValue::from_static("no-store"),
    );
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    insert_request_id(&mut headers, req_id);
    let body = serde_json::json!({
        "type": egdata_core::v1::problem_type(&err.code),
        "title": err.title,
        "status": err.status,
        "detail": err.detail,
        "code": err.code,
        "requestId": req_id,
    });
    let mut response = Response::new(Body::from(body.to_string()));
    *response.status_mut() = StatusCode::NOT_FOUND;
    *response.headers_mut() = headers;
    response
}

fn image_response(
    method: &Method,
    req_id: &str,
    format: OgImageFormat,
    bytes: Vec<u8>,
) -> Response {
    let content_type = match format {
        OgImageFormat::Png => "image/png",
        OgImageFormat::Webp => "image/webp",
    };
    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static("content-type"),
        HeaderValue::from_static(content_type),
    );
    headers.insert(
        HeaderName::from_static("cache-control"),
        HeaderValue::from_static(IMAGE_CACHE_CONTROL),
    );
    headers.insert(
        HeaderName::from_static("cdn-cache-control"),
        HeaderValue::from_static(IMAGE_CDN_CACHE_CONTROL),
    );
    headers.insert(
        HeaderName::from_static("cloudflare-cdn-cache-control"),
        HeaderValue::from_static(IMAGE_CDN_CACHE_CONTROL),
    );
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    insert_request_id(&mut headers, req_id);
    let body = if *method == Method::HEAD {
        Body::empty()
    } else {
        Body::from(bytes)
    };
    let mut resp = Response::new(body);
    *resp.status_mut() = StatusCode::OK;
    *resp.headers_mut() = headers;
    resp
}

fn redirect_response(uri: &Uri, req_id: &str, path: &str) -> Response {
    let mut location = url::Url::parse(&format!("https://api.egdata.app{path}"))
        .expect("OG redirect path is constructed from encoded segments");
    location.set_query(uri.query().filter(|q| !q.is_empty()));
    let mut headers = HeaderMap::new();
    headers.insert(
        "content-type",
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    headers.insert(
        "location",
        HeaderValue::from_str(location.as_str())
            .expect("percent-encoded redirect path and URI query are valid header bytes"),
    );
    headers.insert(
        HeaderName::from_static("cache-control"),
        HeaderValue::from_static(IMAGE_CACHE_CONTROL),
    );
    headers.insert(
        HeaderName::from_static("cdn-cache-control"),
        HeaderValue::from_static(IMAGE_CDN_CACHE_CONTROL),
    );
    headers.insert(
        HeaderName::from_static("cloudflare-cdn-cache-control"),
        HeaderValue::from_static(IMAGE_CDN_CACHE_CONTROL),
    );
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    insert_request_id(&mut headers, req_id);
    let mut resp = Response::new(Body::empty());
    *resp.status_mut() = StatusCode::FOUND;
    *resp.headers_mut() = headers;
    resp
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
    let title: Vec<_> = card.title.encode_utf16().take(160).collect();
    let title_len = title.len();
    let title = String::from_utf16_lossy(&title);
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
        let val_len = metric.value.encode_utf16().count();
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









fn stored_date(doc: &Document, fields: &[&str]) -> String {
    let value = fields.iter().find_map(|key| present(doc.get(*key)));
    let date = match value {
        Some(Bson::String(text) | Bson::Symbol(text)) => Some(text.as_str()),
        Some(Bson::DateTime(date)) => {
            return format_og_date(Some(&egdata_infra::bson_json::bson_to_js_json(
                &Bson::DateTime(*date),
            )));
        }
        _ => None,
    };
    egdata_infra::og_renderer::format_og_date_str(date)
}

fn cover_url(images: Option<&Bson>) -> Result<Option<String>, ProblemError> {
    let Some(images) = present(images) else {
        return Ok(None);
    };
    let images = images
        .as_array()
        .ok_or_else(super::system::internal_error)?;
    let url = |image: &Bson| {
        image
            .as_document()?
            .get("url")
            .filter(|v| super::item_serialization::truthy(v))
            .and_then(stored_identifier)
    };
    for wanted in OG_IMAGE_PRIORITY {
        for image in images {
            if present(Some(image)).is_none() {
                return Err(super::system::internal_error());
            }
            if image.as_document().and_then(|d| d.get_str("type").ok()) == Some(*wanted) {
                return Ok(url(image));
            }
        }
    }
    Ok(images.first().and_then(url))
}

fn country_list(value: Option<&Bson>) -> Result<Option<Vec<String>>, ProblemError> {
    present(value)
        .map(|v| {
            v.as_array()
                .ok_or_else(super::system::internal_error)?
                .iter()
                .map(|v| {
                    v.as_str()
                        .map(str::to_owned)
                        .ok_or_else(super::system::internal_error)
                })
                .collect()
        })
        .transpose()
}

fn subtitle(kind: String, identity: Option<&Document>) -> String {
    let publisher = identity
        .and_then(|doc| {
            present(doc.get("publisherDisplayName"))
                .or_else(|| doc.get_document("seller").ok()?.get("name"))
        })
        .filter(|v| super::item_serialization::truthy(v))
        .and_then(stored_identifier);
    (!kind.is_empty())
        .then_some(kind)
        .into_iter()
        .chain(publisher)
        .collect::<Vec<_>>()
        .join(" · ")
}

fn card_title(value: Option<&Bson>, fallback: &str) -> Result<String, ProblemError> {
    present(value)
        .map_or(Ok(fallback), |v| {
            v.as_str().ok_or_else(super::system::internal_error)
        })
        .map(str::to_owned)
}






// The two reductions in Node use JS addition. A stored string length switches
// the containing reductions to concatenation, including their initial zeros.
fn add_length(left: Bson, right: &Bson) -> Bson {
    pub fn number(v: &Bson) -> Option<f64> {
        match v {
            Bson::Boolean(b) => Some(u8::from(*b).into()),
            _ => og_number(v),
        }
    }
    match (number(&left), number(right)) {
        (Some(a), Some(b)) => Bson::Double(a + b),
        _ => Bson::String(format!(
            "{}{}",
            stored_identifier(&left).unwrap_or_default(),
            stored_identifier(right).unwrap_or_default()
        )),
    }
}

fn count_sandbox_og_assets(
    assets: &[Document],
    items: &[Document],
) -> Result<String, ProblemError> {
    let known: HashSet<_> = assets
        .iter()
        .filter_map(|a| primitive_id(a.get("artifactId")))
        .collect();
    let mut total = Bson::Int32(0);
    for item in items {
        let mut count = Bson::Int32(0);
        if let Some(releases) = present(item.get("releaseInfo")) {
            for release in releases
                .as_array()
                .ok_or_else(super::system::internal_error)?
            {
                if present(Some(release)).is_none() {
                    return Err(super::system::internal_error());
                }
                let doc = release.as_document();
                let id = doc.and_then(|doc| doc.get("appId"));
                let length = if id.is_some_and(super::item_serialization::truthy)
                    && !primitive_id(id).is_some_and(|key| known.contains(&key))
                {
                    match doc.and_then(|doc| doc.get("platform")) {
                        Some(Bson::Array(a)) => Bson::Double(a.len() as f64),
                        Some(Bson::String(s)) => Bson::Double(s.encode_utf16().count() as f64),
                        Some(Bson::Document(d)) => {
                            present(d.get("length")).cloned().unwrap_or(Bson::Int32(0))
                        }
                        _ => Bson::Int32(0),
                    }
                } else {
                    Bson::Int32(0)
                };
                count = add_length(count, &length);
            }
        }
        total = add_length(total, &count);
    }
    let total = add_length(Bson::Double(assets.len() as f64), &total);
    Ok(match total {
        Bson::Double(n) if n.fract() == 0.0 && n >= 0.0 && n < u64::MAX as f64 => {
            format_thousands_en_us(n as u64)
        }
        Bson::Double(n) if n.is_finite() => {
            let value = decimal_price(n.abs(), 3);
            let value = value.trim_end_matches('0').trim_end_matches('.');
            if n.is_sign_negative() {
                format!("-{value}")
            } else {
                value.into()
            }
        }
        Bson::Double(n) if n == f64::INFINITY => "∞".into(),
        Bson::Double(n) if n == f64::NEG_INFINITY => "-∞".into(),
        _ => stored_identifier(&total).unwrap_or_default(),
    })
}

async fn sorted_one(
    state: &AppState,
    collection: &str,
    filter: bson::Document,
    sort: bson::Document,
) -> Result<Option<bson::Document>, ProblemError> {
    state
        .mongo
        .find_one_with_options(
            collection,
            filter,
            MongoFindOptions {
                sort: Some(sort),
                ..Default::default()
            },
        )
        .await
        .map_err(|_| super::system::internal_error())
}



async fn render_offer_og(
    state: &AppState,
    method: &Method,
    uri: &Uri,
    req_id: &str,
    id: String,
    format: OgImageFormat,
) -> Result<Response, ProblemError> {
    let country_raw = query_param(uri, "country");
    let cr = country_and_region(country_raw.as_deref())?;

    let offer_doc = state
        .mongo
        .find_one("offers", doc! { "id": &id }, None)
        .await
        .map_err(|_| super::system::internal_error())?
        .ok_or_else(|| not_found("OFFER_NOT_FOUND", "No offer exists with this ID."))?;

    let cover_url = cover_url(offer_doc.get("keyImages"))?;
    let availability = PriceAvailability {
        countries_whitelist: country_list(offer_doc.get("countriesWhitelist"))?,
        countries_blacklist: country_list(offer_doc.get("countriesBlacklist"))?,
    };

    let price_fut = async {
        if is_price_country_eligible(&availability, &cr.country) {
            sorted_one(
                state,
                "pricev2",
                doc! {"offerId":&id,"region":&cr.region},
                doc! {"updatedAt":-1},
            )
            .await
        } else {
            Ok(None)
        }
    };
    let subitems_fut = async {
        state
            .mongo
            .find_many(
                "offersubitems",
                doc! { "_id": &id },
                MongoFindOptions {
                    projection: Some(doc! { "_id": 1, "subItems": 1 }),
                    ..Default::default()
                },
            )
            .await
            .map_err(|_| super::system::internal_error())
    };

    let (price_doc, subitem_docs) = tokio::try_join!(price_fut, subitems_fut)?;
    let price = price_doc
        .as_ref()
        .and_then(|d| d.get_document("price").ok());

    let (download_bytes, download_platform) =
        offer_card_download(state, &id, &offer_doc, &subitem_docs)
            .await
            .map_err(|_| super::system::internal_error())?;

    let region_currency = REGIONS
        .iter()
        .find(|r| r.code == cr.region)
        .map_or("USD", |r| r.currency_code);
    let currency = price
        .and_then(|p| p.get("currencyCode"))
        .and_then(stored_identifier)
        .unwrap_or_else(|| region_currency.to_owned());
    let amount = price
        .and_then(|p| p.get("discountPrice"))
        .and_then(og_number);
    let price_str =
        offer_card_price(amount, &currency).ok_or_else(super::system::internal_error)?;

    let raw_type = offer_doc
        .get("offerType")
        .and_then(stored_identifier)
        .unwrap_or_else(|| "Offer".into())
        .to_lowercase()
        .replace('_', " ");
    let mut chars = raw_type.chars();
    let offer_type_label = match chars.next() {
        Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
        None => String::new(),
    };
    let card = DatabaseOgCard {
        title: card_title(offer_doc.get("title"), "Untitled offer")?,
        subtitle: subtitle(offer_type_label, Some(&offer_doc)),
        metrics: [
            OgMetric {
                label: "PRICE".to_string(),
                value: price_str,
                detail: format!("{currency} · {}", cr.country),
            },
            OgMetric {
                label: "LAST UPDATE".to_string(),
                value: stored_date(&offer_doc, &["lastModifiedDate", "updatedAt"]),
                detail: "Catalog record".to_string(),
            },
            OgMetric {
                label: "ASSET SIZE".to_string(),
                value: format_og_size(download_bytes),
                detail: asset_detail(download_platform.as_ref()),
            },
        ],
        footer_label: "Release date".to_string(),
        footer_value: stored_date(
            &offer_doc,
            &["releaseDate", "effectiveDate", "viewableDate"],
        ),
    };

    let html = render_database_og_html(&card, cover_url.as_deref());
    let html_without_cover = render_database_og_html(&card, None);
    let image = state
        .og
        .render_image_with_cover(
            &html,
            &html_without_cover,
            cover_url.as_deref(),
            1200,
            630,
            format,
        )
        .await
        .map_err(|_| super::system::internal_error())?;

    Ok(image_response(method, req_id, format, image))
}

async fn render_sandbox_og(
    state: &AppState,
    method: &Method,
    req_id: &str,
    sandbox_id: String,
    format: OgImageFormat,
) -> Result<Response, ProblemError> {
    let sandbox_doc = state
        .mongo
        .find_one("sandboxes", doc! { "_id": {"$eq":&sandbox_id} }, None)
        .await
        .map_err(|_| super::system::internal_error())?
        .ok_or_else(|| not_found("SANDBOX_NOT_FOUND", "No sandbox exists with this ID."))?;

    let offers_count_fut = async {
        state
            .mongo
            .count_documents("offers", doc! { "namespace": &sandbox_id })
            .await
            .map_err(|_| super::system::internal_error())
    };
    let items_fut = async {
        state
            .mongo
            .find_many(
                "items",
                doc! { "namespace": &sandbox_id },
                MongoFindOptions {
                    projection: Some(doc! { "releaseInfo": 1 }),
                    ..Default::default()
                },
            )
            .await
            .map_err(|_| super::system::internal_error())
    };
    let assets_fut = async {
        state
            .mongo
            .find_many(
                "assets",
                doc! { "namespace": &sandbox_id },
                MongoFindOptions {
                    projection: Some(doc! { "artifactId": 1 }),
                    ..Default::default()
                },
            )
            .await
            .map_err(|_| super::system::internal_error())
    };
    let sort = doc! {"creationDate":1,"id":1};
    let released_offer_fut = sorted_one(
        state,
        "offers",
        doc! {"namespace":{"$eq":&sandbox_id},"offerType":"BASE_GAME","prePurchase":{"$ne":true},"isCodeRedemptionOnly":false},
        sort.clone(),
    );
    let (offers_count, item_docs, asset_docs, mut identity) =
        tokio::try_join!(offers_count_fut, items_fut, assets_fut, released_offer_fut)?;
    if identity.is_none() {
        identity = sorted_one(
            state,
            "offers",
            doc! {"namespace":{"$eq":&sandbox_id},"offerType":"BASE_GAME","prePurchase":true},
            sort.clone(),
        )
        .await?;
    }
    if identity.is_none() {
        identity=sorted_one(state,"items",doc!{"namespace":{"$eq":&sandbox_id},"entitlementType":"EXECUTABLE","releaseInfo.0":{"$exists":true}},sort).await?;
    }
    let identity = identity.as_ref();
    let cover_url = cover_url(identity.and_then(|v| v.get("keyImages")))?;
    let asset_count = count_sandbox_og_assets(&asset_docs, &item_docs)?;
    let card = DatabaseOgCard {
        title: card_title(
            present(identity.and_then(|d| d.get("title")))
                .or_else(|| present(sandbox_doc.get("title")))
                .or_else(|| sandbox_doc.get("displayName")),
            "Sandbox",
        )?,
        subtitle: subtitle("Sandbox".into(), identity),
        metrics: [
            OgMetric {
                label: "OFFERS".to_string(),
                value: format_thousands_en_us(offers_count),
                detail: "Store entries".to_string(),
            },
            OgMetric {
                label: "ITEMS".to_string(),
                value: format_thousands_en_us(item_docs.len() as u64),
                detail: "Catalog items".to_string(),
            },
            OgMetric {
                label: "ASSETS".to_string(),
                value: asset_count,
                detail: "Distribution records".to_string(),
            },
        ],
        footer_label: "Last update".to_string(),
        footer_value: stored_date(&sandbox_doc, &["updated", "lastModifiedDate", "updatedAt"]),
    };

    let html = render_database_og_html(&card, cover_url.as_deref());
    let html_without_cover = render_database_og_html(&card, None);
    let image = state
        .og
        .render_image_with_cover(
            &html,
            &html_without_cover,
            cover_url.as_deref(),
            1200,
            630,
            format,
        )
        .await
        .map_err(|_| super::system::internal_error())?;

    Ok(image_response(method, req_id, format, image))
}

async fn offer_og_png(
    State(state): State<AppState>,
    Path(id): Path<String>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    ctx: Option<Extension<V1RequestContext>>,
) -> Response {
    let req_id = request_id_from(&headers, ctx.as_ref());
    match render_offer_og(&state, &method, &uri, &req_id, id, OgImageFormat::Png).await {
        Ok(resp) => resp,
        Err(err) => og_error_response(&err, uri.path(), &req_id),
    }
}

async fn offer_og_webp(
    State(state): State<AppState>,
    Path(id): Path<String>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    ctx: Option<Extension<V1RequestContext>>,
) -> Response {
    let req_id = request_id_from(&headers, ctx.as_ref());
    match render_offer_og(&state, &method, &uri, &req_id, id, OgImageFormat::Webp).await {
        Ok(resp) => resp,
        Err(err) => og_error_response(&err, uri.path(), &req_id),
    }
}

async fn sandbox_og_png(
    State(state): State<AppState>,
    Path(sandbox_id): Path<String>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    ctx: Option<Extension<V1RequestContext>>,
) -> Response {
    let req_id = request_id_from(&headers, ctx.as_ref());
    match render_sandbox_og(&state, &method, &req_id, sandbox_id, OgImageFormat::Png).await {
        Ok(resp) => resp,
        Err(err) => og_error_response(&err, uri.path(), &req_id),
    }
}

async fn sandbox_og_webp(
    State(state): State<AppState>,
    Path(sandbox_id): Path<String>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    ctx: Option<Extension<V1RequestContext>>,
) -> Response {
    let req_id = request_id_from(&headers, ctx.as_ref());
    match render_sandbox_og(&state, &method, &req_id, sandbox_id, OgImageFormat::Webp).await {
        Ok(resp) => resp,
        Err(err) => og_error_response(&err, uri.path(), &req_id),
    }
}

async fn redirect_free_games_og(
    uri: Uri,
    headers: HeaderMap,
    ctx: Option<Extension<V1RequestContext>>,
) -> Response {
    let req_id = request_id_from(&headers, ctx.as_ref());
    redirect_response(&uri, &req_id, "/free-games/og")
}

async fn redirect_game_awards_og(
    uri: Uri,
    headers: HeaderMap,
    ctx: Option<Extension<V1RequestContext>>,
) -> Response {
    let req_id = request_id_from(&headers, ctx.as_ref());
    redirect_response(&uri, &req_id, "/game-awards/og")
}

fn encode_component(text: &str) -> String {
    urlencoding::encode(text)
        .replace("%21", "!")
        .replace("%27", "'")
        .replace("%28", "(")
        .replace("%29", ")")
        .replace("%2A", "*")
}

async fn redirect_collections_og(
    Path((slug, week)): Path<(String, String)>,
    uri: Uri,
    headers: HeaderMap,
    ctx: Option<Extension<V1RequestContext>>,
) -> Response {
    let req_id = request_id_from(&headers, ctx.as_ref());
    let path = format!(
        "/collections/{}/{}/og",
        encode_component(&slug),
        encode_component(&week)
    );
    redirect_response(&uri, &req_id, &path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::sync::Arc;

    use async_trait::async_trait;
    use axum::http::Request;
    use bson::Document;
    use egdata_core::error::CoreError;
    use egdata_core::ports::{MongoStorePort, OgRendererPort};
    use http_body_util::BodyExt;
    use serde_json::json;
    use tokio::sync::Mutex;
    use tower::ServiceExt;

    use crate::state::ApiConfig;

    #[derive(Default)]
    struct MockMongo {
        offers: Mutex<Vec<Document>>,
        sandboxes: Mutex<Vec<Document>>,
        prices: Mutex<Vec<Document>>,
        subitems: Mutex<Vec<Document>>,
        items: Mutex<Vec<Document>>,
        assets: Mutex<Vec<Document>>,
        builds: Mutex<Vec<Document>>,
        fail_find_one: Mutex<bool>,
        fail_read: Mutex<String>,
    }

    #[async_trait]
    impl MongoStorePort for MockMongo {
        async fn find_one(
            &self,
            collection: &str,
            filter: Document,
            _p: Option<Document>,
        ) -> Result<Option<Document>, CoreError> {
            if *self.fail_find_one.lock().await || *self.fail_read.lock().await == collection {
                return Err(CoreError::Internal("mongo down".into()));
            }
            match collection {
                "offers" => {
                    let id = filter.get_str("id").ok();
                    Ok(self
                        .offers
                        .lock()
                        .await
                        .iter()
                        .find(|d| id.is_none_or(|v| d.get_str("id").ok() == Some(v)))
                        .cloned())
                }
                "sandboxes" => {
                    let id = filter
                        .get_document("_id")
                        .ok()
                        .and_then(|f| f.get_str("$eq").ok());
                    Ok(self
                        .sandboxes
                        .lock()
                        .await
                        .iter()
                        .find(|d| id.is_none_or(|v| d.get_str("_id").ok() == Some(v)))
                        .cloned())
                }
                _ => Ok(None),
            }
        }
        async fn find_many(
            &self,
            collection: &str,
            filter: Document,
            opts: MongoFindOptions,
        ) -> Result<Vec<Document>, CoreError> {
            if *self.fail_read.lock().await == collection {
                return Err(CoreError::Internal("fixture read failed".into()));
            }
            if (collection == "offers"
                && filter.get_bool("prePurchase") == Ok(true)
                && *self.fail_read.lock().await == "prepurchase")
                || (collection == "items"
                    && filter.contains_key("entitlementType")
                    && *self.fail_read.lock().await == "identity")
            {
                return Err(CoreError::Internal("fixture fallback unavailable".into()));
            }
            let mut rows = match collection {
                "pricev2" => self.prices.lock().await.clone(),
                "offersubitems" => self.subitems.lock().await.clone(),
                "items" => {
                    let items = self.items.lock().await.clone();
                    if filter.get_str("entitlementType").ok() == Some("EXECUTABLE") {
                        items
                            .into_iter()
                            .filter(|d| d.get_str("entitlementType").ok() == Some("EXECUTABLE"))
                            .collect()
                    } else {
                        items
                    }
                }
                "assets" => self.assets.lock().await.clone(),
                "builds" => self.builds.lock().await.clone(),
                "offers" => {
                    let offers = self.offers.lock().await.clone();
                    if let Ok(b) = filter.get_bool("prePurchase") {
                        offers
                            .into_iter()
                            .filter(|d| d.get_bool("prePurchase").ok() == Some(b))
                            .collect()
                    } else if filter.get_document("prePurchase").is_ok() {
                        offers
                            .into_iter()
                            .filter(|d| d.get_bool("prePurchase").ok() != Some(true))
                            .collect()
                    } else {
                        offers
                    }
                }
                _ => vec![],
            };
            if let Some(lim) = opts.limit {
                rows.truncate(lim as usize);
            }
            Ok(rows)
        }
        async fn aggregate(&self, _c: &str, _p: Vec<Document>) -> Result<Vec<Document>, CoreError> {
            Ok(vec![])
        }
        async fn count_documents(&self, collection: &str, _f: Document) -> Result<u64, CoreError> {
            if *self.fail_read.lock().await == collection {
                return Err(CoreError::Internal("fixture read failed".into()));
            }
            match collection {
                "offers" => Ok(self.offers.lock().await.len() as u64),
                _ => Ok(0),
            }
        }
        async fn distinct(
            &self,
            _c: &str,
            _field: &str,
            _f: Document,
        ) -> Result<Vec<Bson>, CoreError> {
            Ok(vec![])
        }
        async fn insert_one(&self, _c: &str, _d: Document) -> Result<(), CoreError> {
            Ok(())
        }
        async fn update_one(
            &self,
            _c: &str,
            _f: Document,
            _u: Document,
            _up: bool,
        ) -> Result<u64, CoreError> {
            Ok(1)
        }
        async fn delete_one(&self, _c: &str, _f: Document) -> Result<u64, CoreError> {
            Ok(1)
        }
        async fn ping(&self) -> Result<bool, CoreError> {
            Ok(true)
        }
    }

    struct MockRenderer {
        fail_og: bool,
    }

    #[async_trait]
    impl OgRendererPort for MockRenderer {
        async fn render_image(
            &self,
            _h: &str,
            _w: u32,
            _ht: u32,
            fmt: OgImageFormat,
        ) -> Result<Vec<u8>, CoreError> {
            if self.fail_og {
                return Err(CoreError::Internal("render failed".into()));
            }
            Ok(match fmt {
                OgImageFormat::Png => vec![137, 80, 78, 71],
                OgImageFormat::Webp => vec![82, 73, 70, 70],
            })
        }
    }
    fn make_state(mongo: Arc<MockMongo>, fail_og: bool) -> AppState {
        let mut state = egdata_api_test_support::test_app_state(ApiConfig::default());
        state.mongo = mongo;
        state.og = Arc::new(MockRenderer { fail_og });
        state
    }

    #[test]
    fn og_prices_and_downloads_match_node_fixtures() {
        let fixtures: Value =
            serde_json::from_str(include_str!("../../egdata-api/tests/fixtures/og-node.json")).unwrap();
        for case in fixtures["prices"].as_array().unwrap() {
            assert_eq!(
                format_currency_en_us(
                    case["amount"].as_f64().unwrap(),
                    case["currency"].as_str().unwrap()
                ),
                case["output"].as_str().unwrap(),
                "price fixture: {case}"
            );
        }
        for case in fixtures["priceStates"].as_array().unwrap() {
            assert_eq!(
                offer_card_price(case["amount"].as_f64(), case["currency"].as_str().unwrap())
                    .as_deref(),
                case["output"].as_str(),
                "offer card price: {case}"
            );
        }
        for case in fixtures["downloads"].as_array().unwrap() {
            let (bytes, platform) =
                latest_og_download(case["assets"].as_array().unwrap(), case.get("build"));
            assert_eq!(
                bytes,
                case["output"]["bytes"].as_f64(),
                "download bytes: {case}"
            );
            assert_eq!(
                json!(platform),
                case["output"]["platform"],
                "download platform: {case}"
            );
        }
        for case in fixtures["sizes"].as_array().unwrap() {
            assert_eq!(
                format_og_size(case["input"].as_f64()),
                case["output"].as_str().unwrap(),
                "size fixture: {case}"
            );
        }
        for case in fixtures["dates"].as_array().unwrap() {
            assert_eq!(
                format_og_date(case.get("input")),
                case["output"].as_str().unwrap(),
                "date fixture: {case}"
            );
        }
    }

    #[test]
    fn helpers_formatting_and_html_cover_variants() {
        assert_eq!(format_og_date(None), "Not available");
        assert_eq!(format_og_date(Some(&json!(123))), "Not available");
        assert_eq!(format_og_date(Some(&json!("not-a-date"))), "Not available");
        assert_eq!(
            format_og_date(Some(&json!("2025-01-02T03:04:05.000Z"))),
            "02 Jan 2025"
        );

        assert_eq!(format_og_size(None), "Not available");
        assert_eq!(format_og_size(Some(500.0)), "< 0.01 GB");
        assert_eq!(format_og_size(Some(1_500_000_000.0)), "1.50 GB");

        assert_eq!(format_currency_en_us(1999.0, "USD"), "$19.99");
        assert_eq!(format_currency_en_us(199900.0, "USD"), "$1,999.00");
        assert_eq!(format_currency_en_us(500.0, "EUR"), "€5.00");
        assert_eq!(format_currency_en_us(500.0, "GBP"), "£5.00");
        assert_eq!(format_currency_en_us(500.0, "JPY"), "¥5");
        assert_eq!(format_currency_en_us(500.0, "KRW"), "₩5");
        assert_eq!(format_currency_en_us(500.0, "INR"), "₹5.00");
        assert_eq!(format_currency_en_us(500.0, "VND"), "₫5");
        assert_eq!(format_currency_en_us(500.0, "ILS"), "₪5.00");
        assert_eq!(format_currency_en_us(500.0, "PHP"), "₱5.00");
        assert_eq!(format_currency_en_us(500.0, "THB"), "THB\u{00a0}5.00");
        assert_eq!(format_currency_en_us(500.0, "BRL"), "R$5.00");
        assert_eq!(format_currency_en_us(500.0, "CAD"), "CA$5.00");
        assert_eq!(format_currency_en_us(500.0, "AUD"), "A$5.00");
        assert_eq!(format_currency_en_us(500.0, "MXN"), "MX$5.00");
        assert_eq!(format_currency_en_us(500.0, "HKD"), "HK$5.00");
        assert_eq!(format_currency_en_us(500.0, "NZD"), "NZ$5.00");
        assert_eq!(format_currency_en_us(500.0, "TWD"), "NT$5.00");
        assert_eq!(format_currency_en_us(500.0, "PLN"), "PLN\u{00a0}5.00");

        assert_eq!(
            html_escape(r#"a&b<c>d"e'f"#),
            "a&amp;b&lt;c&gt;d&quot;e&#39;f"
        );

        let long_card = DatabaseOgCard {
            title: "A".repeat(70),
            subtitle: "Base game".into(),
            metrics: [
                OgMetric {
                    label: "L1".into(),
                    value: "123456789012345".into(),
                    detail: "D1".into(),
                },
                OgMetric {
                    label: "L2".into(),
                    value: "123456789012".into(),
                    detail: "D2".into(),
                },
                OgMetric {
                    label: "L3".into(),
                    value: "OK".into(),
                    detail: "D3".into(),
                },
            ],
            footer_label: "F".into(),
            footer_value: "V".into(),
        };
        let html = render_database_og_html(&long_card, Some("https://cdn.test/a.png"));
        assert!(html.contains("font-size:36px"));
        assert!(html.contains("https://cdn.test/a.png"));

        let med_card = DatabaseOgCard {
            title: "A".repeat(35),
            ..long_card
        };
        let med_html = render_database_og_html(&med_card, None);
        assert!(med_html.contains("font-size:44px"));

        // latest_og_download without build & with Unknown platform
        let assets = vec![
            json!({"artifactId": "app1", "downloadSizeBytes": 100, "updatedAt": "2024-01-01T00:00:00.000Z"}),
            json!({"artifactId": "app2", "platform": "Windows", "downloadSizeBytes": 200, "updatedAt": "2025-01-01T00:00:00.000Z"}),
        ];
        assert_eq!(
            latest_og_download(&assets, None),
            (Some(200.0), Some("Windows".into()))
        );
        let unknown_build = json!({"appName": "app1", "labelName": "Unknown"});
        assert_eq!(
            latest_og_download(&assets, Some(&unknown_build)),
            (Some(100.0), None)
        );
        let mac_build =
            json!({"appName": "app1", "labelName": "Live-Mac", "downloadSizeBytes": 300});
        assert_eq!(
            latest_og_download(&assets, Some(&mac_build)),
            (Some(300.0), Some("Mac".into()))
        );
    }

    #[tokio::test]
    async fn og_routes_pass_node_price_and_nullish_date_fallbacks_to_renderer() {
        #[derive(Default)]
        struct RecordingRenderer(Mutex<Vec<String>>);
        #[async_trait]
        impl OgRendererPort for RecordingRenderer {
            async fn render_image(
                &self,
                html: &str,
                width: u32,
                height: u32,
                _format: OgImageFormat,
            ) -> Result<Vec<u8>, CoreError> {
                assert_eq!((width, height), (1200, 630));
                self.0.lock().await.push(html.to_owned());
                Ok(vec![137, 80, 78, 71])
            }
        }
        let mongo = Arc::new(MockMongo::default());
        mongo.offers.lock().await.push(doc! {
            "id": "offer-jp", "title": "Date and price fixture", "items": [],
            "lastModifiedDate": Bson::Null, "updatedAt": "2026-09-01T00:00:00Z",
            "releaseDate": Bson::Null, "effectiveDate": Bson::Null, "viewableDate": "2026-09-02",
        });
        mongo.prices.lock().await.push(doc! {
            "offerId": "offer-jp", "region": "JP", "price": {"currencyCode": "JPY", "discountPrice": 550},
        });
        mongo.sandboxes.lock().await.push(doc! {
            "_id": "sandbox", "title": "Sandbox", "updated": Bson::Null,
            "lastModifiedDate": Bson::Null, "updatedAt": "2026-09-03T00:00:00Z",
        });
        let renderer = Arc::new(RecordingRenderer::default());
        let mut state = make_state(mongo, false);
        state.og = renderer.clone();
        let app = router().with_state(state);
        for path in ["/offers/offer-jp/og?country=JP", "/sandboxes/sandbox/og"] {
            assert_eq!(
                app.clone()
                    .oneshot(Request::get(path).body(Body::empty()).unwrap())
                    .await
                    .unwrap()
                    .status(),
                StatusCode::OK
            );
        }
        let rendered = renderer.0.lock().await;
        assert!(rendered[0].contains("¥6"));
        assert!(rendered[0].contains("JPY · JP"));
        assert!(rendered[0].contains("01 Sept 2026"));
        assert!(rendered[0].contains("02 Sept 2026"));
        assert!(rendered[1].contains("03 Sept 2026"));
    }

    #[tokio::test]
    async fn offer_and_sandbox_og_and_redirects() {
        let mongo = Arc::new(MockMongo::default());
        mongo.offers.lock().await.push(doc! {
            "id": "offer-1",
            "namespace": "ns-1",
            "title": "Test Game",
            "offerType": "BASE_GAME",
            "publisherDisplayName": "Pub",
            "prePurchase": false,
            "keyImages": [{ "type": "DieselGameBoxTall", "url": "https://cdn.test/cover.png" }],
            "items": [{ "id": "item-1" }],
            "lastModifiedDate": "2025-01-02T00:00:00Z",
            "releaseDate": "2025-02-01T00:00:00Z",
        });
        mongo.prices.lock().await.push(doc! {
            "offerId": "offer-1",
            "region": "US",
            "price": { "currencyCode": "USD", "discountPrice": 1999 },
        });
        mongo.subitems.lock().await.push(doc! {
            "_id": "offer-1",
            "subItems": [{ "id": "item-2" }],
        });
        mongo.items.lock().await.push(doc! {
            "id": "item-1",
            "entitlementType": "EXECUTABLE",
            "releaseInfo": [{ "appId": "app-missing", "platform": ["Windows", "Mac"] }],
        });
        mongo.assets.lock().await.push(doc! {
            "itemId": "item-1",
            "artifactId": "art-1",
            "platform": "Windows",
            "downloadSizeBytes": 500000000_i64,
        });
        mongo.builds.lock().await.push(doc! {
            "_id":"build-a",
            "appName": "art-1",
            "labelName": "Live-Windows",
            "downloadSizeBytes": 600000000_i64,
        });
        mongo.sandboxes.lock().await.push(doc! {
            "_id": "ns-1",
            "title": "Sandbox Title",
            "updated": "2025-01-03T00:00:00Z",
        });

        let app = router().with_state(make_state(mongo.clone(), false));

        // PNG + WebP offer OG
        let resp = app
            .clone()
            .oneshot(
                Request::get("/offers/offer-1/og?country=US&v=1")
                    .header("x-request-id", "req_og_1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.headers().get("content-type").unwrap(), "image/png");
        assert_eq!(resp.headers().get("x-request-id").unwrap(), "req_og_1");
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(bytes.as_ref(), &[137, 80, 78, 71]);

        let resp_webp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::HEAD)
                    .uri("/offers/offer-1/og.webp")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp_webp.status(), StatusCode::OK);
        assert_eq!(
            resp_webp.headers().get("content-type").unwrap(),
            "image/webp"
        );
        assert!(
            resp_webp
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .is_empty()
        );

        // Offer not found & invalid country & blacklisted country & free price
        let missing = app
            .clone()
            .oneshot(
                Request::get("/offers/missing/og")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);

        let bad_country = app
            .clone()
            .oneshot(
                Request::get("/offers/offer-1/og?country=ZZ")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(bad_country.status(), StatusCode::BAD_REQUEST);

        // Free & country blacklisted fallback
        mongo.offers.lock().await.push(doc! {
            "id": "offer-free",
            "namespace": "ns-1",
            "title": "",
            "countriesBlacklist": ["US"],
            "seller": { "name": "Dev" },
        });
        let resp_free = app
            .clone()
            .oneshot(
                Request::get("/offers/offer-free/og?country=US")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp_free.status(), StatusCode::OK);

        // Price 0
        mongo.offers.lock().await.push(doc! {
            "id": "offer-zero",
            "namespace": "ns-1",
            "title": "Zero",
        });
        mongo.prices.lock().await.clear();
        mongo.prices.lock().await.push(doc! {
            "offerId": "offer-zero",
            "region": "US",
            "price": { "currencyCode": "USD", "discountPrice": 0 },
        });
        let resp_zero = app
            .clone()
            .oneshot(
                Request::get("/offers/offer-zero/og")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp_zero.status(), StatusCode::OK);

        // Sandbox OG PNG & WebP & fallbacks
        let s_png = app
            .clone()
            .oneshot(
                Request::get("/sandboxes/ns-1/og")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(s_png.status(), StatusCode::OK);
        assert_eq!(s_png.headers().get("content-type").unwrap(), "image/png");

        let s_webp = app
            .clone()
            .oneshot(
                Request::get("/sandboxes/ns-1/og.webp")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(s_webp.status(), StatusCode::OK);
        assert_eq!(s_webp.headers().get("content-type").unwrap(), "image/webp");

        // Sandbox prePurchase fallback then executable item fallback
        mongo.offers.lock().await.clear();
        mongo
            .offers
            .lock()
            .await
            .push(doc! { "id": "pre", "prePurchase": true, "title": "Pre" });
        let s_pre = app
            .clone()
            .oneshot(
                Request::get("/sandboxes/ns-1/og")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(s_pre.status(), StatusCode::OK);

        mongo.offers.lock().await.clear();
        let s_item = app
            .clone()
            .oneshot(
                Request::get("/sandboxes/ns-1/og")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(s_item.status(), StatusCode::OK);

        let s_missing = app
            .clone()
            .oneshot(
                Request::get("/sandboxes/nope/og")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(s_missing.status(), StatusCode::NOT_FOUND);

        // Redirects
        let r1 = app
            .clone()
            .oneshot(
                Request::get("/free-games/og?country=ES")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r1.status(), StatusCode::FOUND);
        assert_eq!(
            r1.headers().get("location").unwrap(),
            "https://api.egdata.app/free-games/og?country=ES"
        );

        let r2 = app
            .clone()
            .oneshot(Request::get("/game-awards/og").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(r2.status(), StatusCode::FOUND);
        assert_eq!(
            r2.headers().get("location").unwrap(),
            "https://api.egdata.app/game-awards/og"
        );

        let r3 = app
            .clone()
            .oneshot(
                Request::get("/collections/top%20sellers/2025-W01/og?v=2")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r3.status(), StatusCode::FOUND);
        assert_eq!(
            r3.headers().get("location").unwrap(),
            "https://api.egdata.app/collections/top%20sellers/2025-W01/og?v=2"
        );

        // Error branches: OG renderer failure & mongo failure
        let fail_og_app = router().with_state(make_state(mongo.clone(), true));
        let err_og = fail_og_app
            .clone()
            .oneshot(
                Request::get("/sandboxes/ns-1/og")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(err_og.status(), StatusCode::INTERNAL_SERVER_ERROR);

        *mongo.fail_find_one.lock().await = true;
        let err_mongo = fail_og_app
            .oneshot(
                Request::get("/offers/offer-1/og")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(err_mongo.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn registered_og_routes_match_node_http_oracle() {
        #[derive(Default)]
        struct RecordingRenderer(Mutex<Vec<String>>);
        #[async_trait]
        impl OgRendererPort for RecordingRenderer {
            async fn render_image(
                &self,
                html: &str,
                width: u32,
                height: u32,
                format: OgImageFormat,
            ) -> Result<Vec<u8>, CoreError> {
                assert_eq!((width, height), (1200, 630));
                self.0.lock().await.push(html.to_owned());
                Ok(match format {
                    OgImageFormat::Png => vec![137, 80, 78, 71],
                    OgImageFormat::Webp => vec![82, 73, 70, 70],
                })
            }
        }
        let fixture: Vec<Value> =
            serde_json::from_str(include_str!("../../egdata-api/tests/fixtures/og-http-node.json")).unwrap();
        let renderer = Arc::new(RecordingRenderer::default());
        let mut rendered_index = 0;
        for expected in &fixture {
            let source = &expected["input"]["source"];
            let to_docs = |key: &str| {
                source[key]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|v| bson::to_document(v).unwrap())
                    .collect::<Vec<_>>()
            };
            let mongo = Arc::new(MockMongo::default());
            if source["offer"].is_object() {
                mongo
                    .offers
                    .lock()
                    .await
                    .push(bson::to_document(&source["offer"]).unwrap());
            }
            if source["sandbox"].is_object() {
                mongo
                    .sandboxes
                    .lock()
                    .await
                    .push(bson::to_document(&source["sandbox"]).unwrap());
            }
            if source["price"].is_object() {
                mongo
                    .prices
                    .lock()
                    .await
                    .push(bson::to_document(&source["price"]).unwrap());
            }
            mongo.subitems.lock().await.extend(to_docs("subItems"));
            mongo.items.lock().await.extend(to_docs("items"));
            mongo.assets.lock().await.extend(to_docs("assets"));
            mongo.builds.lock().await.extend(to_docs("builds"));
            let mut state = make_state(mongo, false);
            state.og = renderer.clone();
            let app = router().with_state(state);
            let path = expected["request"]["path"]
                .as_str()
                .unwrap()
                .strip_prefix("/v1")
                .unwrap_or(expected["request"]["path"].as_str().unwrap());
            let mut request = Request::builder().uri(path).body(Body::empty()).unwrap();
            request.extensions_mut().insert(V1RequestContext {
                request_id: "req_node_oracle".into(),
                key: None,
            });
            let response = app.oneshot(request).await.unwrap();
            let actual = egdata_api_test_support::capture_response(response).await;
            assert_eq!(actual, expected["response"], "{}", expected["name"]);
            if let Some(card) = expected["input"]["renderer"]["card"].as_object() {
                let html = renderer.0.lock().await[rendered_index].clone();
                for field in ["title", "subtitle"] {
                    if let Some(value) = card[field].as_str() {
                        assert!(
                            html.contains(value),
                            "{} renderer lacks {field}: {value}",
                            expected["name"]
                        );
                    }
                }
                rendered_index += 1;
            }
        }
    }

    struct FixtureImage {
        sandbox: bool,
        fail: bool,
        card: Value,
        cover: Option<String>,
        name: String,
    }
    #[async_trait]
    impl OgRendererPort for FixtureImage {
        async fn render_image(
            &self,
            html: &str,
            width: u32,
            height: u32,
            format: OgImageFormat,
        ) -> Result<Vec<u8>, CoreError> {
            assert_eq!((width, height), (1200, 630));
            if self.fail {
                return Err(CoreError::Internal("fixture render failed".into()));
            }
            let node = &self.card;
            let text = |value: &Value| value.as_str().unwrap().to_owned();
            let metric = |label: &str, value: &str, detail: &str| OgMetric {
                label: label.into(),
                value: node[value].as_str().unwrap().into(),
                detail: detail.into(),
            };
            let (metrics, footer_label, footer_value) = if self.sandbox {
                (
                    std::array::from_fn(|i| {
                        let m = &node["metrics"][i];
                        OgMetric {
                            label: text(&m["label"]),
                            value: text(&m["value"]),
                            detail: text(&m["detail"]),
                        }
                    }),
                    text(&node["footer"]["label"]),
                    text(&node["footer"]["value"]),
                )
            } else {
                (
                    [
                        metric("PRICE", "price", node["priceDetail"].as_str().unwrap()),
                        metric("LAST UPDATE", "lastUpdate", "Catalog record"),
                        metric(
                            "ASSET SIZE",
                            "assetSize",
                            node["assetDetail"].as_str().unwrap(),
                        ),
                    ],
                    "Release date".into(),
                    text(&node["releaseDate"]),
                )
            };
            let card = DatabaseOgCard {
                title: text(&node["title"]),
                subtitle: text(&node["subtitle"]),
                metrics,
                footer_label,
                footer_value,
            };
            assert_eq!(
                html,
                render_database_og_html(&card, self.cover.as_deref()),
                "{}",
                self.name
            );
            let bytes: &[u8] = match (self.sandbox, format) {
                (false, OgImageFormat::Png) => {
                    include_bytes!("../../egdata-api/tests/fixtures/og-rust-offer.png")
                }
                (false, OgImageFormat::Webp) => {
                    include_bytes!("../../egdata-api/tests/fixtures/og-rust-offer.webp")
                }
                (true, OgImageFormat::Png) => {
                    include_bytes!("../../egdata-api/tests/fixtures/og-rust-sandbox.png")
                }
                (true, OgImageFormat::Webp) => {
                    include_bytes!("../../egdata-api/tests/fixtures/og-rust-sandbox.webp")
                }
            };
            Ok(bytes.to_vec())
        }
    }

    #[tokio::test]
    async fn og_http_cache_matches_node() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../egdata-api/tests/fixtures/og-http-cache-node.json"))
                .unwrap();
        let mut differences = Vec::new();
        for case in cases {
            let document = |row: &Value| {
                Bson::try_from(row.clone())
                    .unwrap()
                    .as_document()
                    .unwrap()
                    .clone()
            };
            let source = &case["source"];
            let mongo = Arc::new(MockMongo::default());
            for (field, rows) in [
                ("offer", &mongo.offers),
                ("sandbox", &mongo.sandboxes),
                ("price", &mongo.prices),
            ] {
                if let Some(row) = source.get(field) {
                    rows.lock().await.push(document(row));
                }
            }
            for (field, rows) in [
                ("items", &mongo.items),
                ("assets", &mongo.assets),
                ("subItems", &mongo.subitems),
                ("builds", &mongo.builds),
            ] {
                if let Some(entries) = source[field].as_array() {
                    rows.lock().await.extend(entries.iter().map(document));
                }
            }
            let failure = source["failure"].as_str().unwrap_or_default();
            *mongo.fail_read.lock().await = failure.to_owned();
            let request = &case["request"];
            let path = request["path"].as_str().unwrap();
            let mut state = make_state(mongo, false);
            state.og = Arc::new(FixtureImage {
                sandbox: path.starts_with("/v1/sandboxes"),
                fail: failure == "render",
                card: case["card"].clone(),
                cover: case["cover"].as_str().map(str::to_owned),
                name: case["name"].as_str().unwrap().into(),
            });
            let app = crate::router(&state).with_state(state);
            let mut req = Request::builder()
                .uri(path)
                .method(request["method"].as_str().unwrap())
                .header("x-egdata-key-id", "key_oracle")
                .header("x-egdata-key-tier", "free")
                .header("x-request-id", "req_node_oracle");
            for (k, v) in request["headers"].as_object().unwrap() {
                req = req.header(k, v.as_str().unwrap());
            }
            let response = app.oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
            let actual = egdata_api_test_support::capture_response(response).await;
            if actual != case["response"] {
                differences.push(format!(
                    "{}: {actual} expected {}",
                    case["name"], case["response"]
                ));
            }
        }
        assert!(differences.is_empty(), "{}", differences.join("\n"));
    }

    #[test]
    fn og_omits_invalid_internal_header_values() {
        let mut headers = HeaderMap::new();
        insert_request_id(&mut headers, "invalid\r\nvalue");
        assert!(!headers.contains_key("x-request-id"));
    }

    #[tokio::test]
    async fn native_og_images_revalidate_by_their_rendered_bytes() {
        use sha1::{Digest, Sha1};
        let mongo = Arc::new(MockMongo::default());
        mongo
            .offers
            .lock()
            .await
            .push(doc! {"id":"demo","title":"Native offer"});
        mongo
            .sandboxes
            .lock()
            .await
            .push(doc! {"_id":"ns","title":"Native sandbox"});
        let mut state = make_state(mongo, false);
        state.og = Arc::new(egdata_infra::port_adapters::TakumiOgRenderer);
        let app = crate::router(&state).with_state(state);
        for (base, format) in [("/v1/offers/demo", "png"), ("/v1/sandboxes/ns", "webp")] {
            let path = format!("{base}/og{}", if format == "webp" { ".webp" } else { "" });
            let get = || {
                Request::builder()
                    .uri(&path)
                    .header("x-egdata-key-id", "key_oracle")
                    .header("x-egdata-key-tier", "free")
                    .header("x-request-id", "req_og")
            };
            let response = app
                .clone()
                .oneshot(get().body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers()["content-type"],
                format!("image/{format}")
            );
            let etag = response.headers()["etag"].clone();
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            assert_eq!(etag, format!("\"{:x}\"", Sha1::digest(&bytes)));
            if format == "png" {
                assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
                assert_eq!(&bytes[16..20], &1200_u32.to_be_bytes());
                assert_eq!(&bytes[20..24], &630_u32.to_be_bytes());
            } else {
                assert_eq!(&bytes[..4], b"RIFF");
                assert_eq!(&bytes[8..12], b"WEBP");
            }
            let validated = app
                .clone()
                .oneshot(
                    get()
                        .header("if-none-match", etag)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(validated.status(), StatusCode::NOT_MODIFIED);
            assert!(
                validated
                    .into_body()
                    .collect()
                    .await
                    .unwrap()
                    .to_bytes()
                    .is_empty()
            );
        }
    }

    #[tokio::test]
    async fn storefront_cover_updates_change_the_offers_image_etag() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/cover", listener.local_addr().unwrap());
        let covers = axum::Router::new().route(
            "/cover",
            axum::routing::get(|| async {
                (
                    [(axum::http::header::CONTENT_TYPE, "image/png")],
                    include_bytes!("../../egdata-api/tests/fixtures/og-parity-cover.png").as_slice(),
                )
            }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, covers).await.unwrap() });
        let mongo = Arc::new(MockMongo::default());
        mongo
            .offers
            .lock()
            .await
            .push(doc! {"id":"with-cover","title":"With Cover"});
        let mut state = make_state(mongo.clone(), false);
        state.og = Arc::new(egdata_infra::port_adapters::TakumiOgRenderer);
        let app = crate::router(&state).with_state(state);
        let request = || {
            Request::builder()
                .uri("/v1/offers/with-cover/og")
                .header("x-egdata-key-id", "key_oracle")
                .header("x-egdata-key-tier", "free")
        };
        let no_cover = app
            .clone()
            .oneshot(request().body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(no_cover.status(), StatusCode::OK);
        let initial = no_cover.headers()["etag"].clone();
        mongo.offers.lock().await[0]
            .insert("keyImages", vec![doc! {"type":"OfferImageTall","url":url}]);
        let with_cover = app
            .clone()
            .oneshot(
                request()
                    .header("if-none-match", &initial)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(with_cover.status(), StatusCode::OK);
        assert_ne!(with_cover.headers()["etag"], initial);
        let cached = app
            .oneshot(
                request()
                    .header("if-none-match", &with_cover.headers()["etag"])
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(cached.status(), StatusCode::NOT_MODIFIED);
        server.abort();
    }

    #[test]
    fn real_rust_og_template_render_references() {
        let cards = [
            (
                "offer",
                DatabaseOgCard {
                    title: "Operation Parity: A Long Title for OG".into(),
                    subtitle: "Base game · Parity Studio".into(),
                    metrics: [
                        OgMetric {
                            label: "PRICE".into(),
                            value: "€19.99".into(),
                            detail: "EUR · ES".into(),
                        },
                        OgMetric {
                            label: "LAST UPDATE".into(),
                            value: "12 Dec 2026".into(),
                            detail: "Catalog record".into(),
                        },
                        OgMetric {
                            label: "ASSET SIZE".into(),
                            value: "23.45 GB".into(),
                            detail: "Windows download".into(),
                        },
                    ],
                    footer_label: "Release date".into(),
                    footer_value: "14 Jan 2027".into(),
                },
            ),
            (
                "sandbox",
                DatabaseOgCard {
                    title: "Project Ω Sandbox".into(),
                    subtitle: "Sandbox · Parity Studio".into(),
                    metrics: [
                        OgMetric {
                            label: "OFFERS".into(),
                            value: "1,234".into(),
                            detail: "Store entries".into(),
                        },
                        OgMetric {
                            label: "ITEMS".into(),
                            value: "56".into(),
                            detail: "Catalog items".into(),
                        },
                        OgMetric {
                            label: "ASSETS".into(),
                            value: "78".into(),
                            detail: "Distribution records".into(),
                        },
                    ],
                    footer_label: "Last update".into(),
                    footer_value: "12 Dec 2026".into(),
                },
            ),
        ];
        let output_dir =
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../egdata-api/tests/fixtures");
        if std::env::var("OG_RENDER_WRITE").as_deref() == Ok("1") {
            std::fs::create_dir_all(&output_dir).unwrap();
        }
        let cover = std::fs::read(output_dir.join("og-parity-cover.png")).unwrap();
        for (name, card) in cards {
            let cover_url = "https://local.test/og-parity-cover.png";
            for (variant, with_cover) in [("", false), ("-cover", true)] {
                let html = render_database_og_html(&card, with_cover.then_some(cover_url));
                for (fmt, format) in [
                    ("png", egdata_infra::og_renderer::OgImageFormat::Png),
                    ("webp", egdata_infra::og_renderer::OgImageFormat::Webp),
                ] {
                    let bytes = if with_cover {
                        egdata_infra::og_renderer::render_html_to_image_with_image_bytes(
                            &html,
                            (1200, 630),
                            format,
                            [(std::sync::Arc::<str>::from(cover_url), cover.clone())],
                        )
                    } else {
                        egdata_infra::og_renderer::render_html_to_image(
                            &html,
                            (1200, 630),
                            format,
                            std::collections::HashMap::new(),
                        )
                    }
                    .unwrap();
                    let path = output_dir.join(format!("og-rust-{name}{variant}.{fmt}"));
                    if std::env::var("OG_RENDER_WRITE").as_deref() == Ok("1") {
                        std::fs::write(&path, &bytes).unwrap();
                    }
                    let golden = std::fs::read(&path).unwrap_or_else(|error| {
                        panic!("missing Rust OG golden {}: {error}", path.display())
                    });
                    assert_eq!(
                        bytes, golden,
                        "fresh Rust {name}{variant}/{fmt} render differs from checked golden; review and regenerate with OG_RENDER_WRITE=1",
                    );
                    assert!(bytes.len() > 4);
                    match fmt {
                        "png" => assert_eq!(&bytes[..4], &[137, 80, 78, 71]),
                        _ => assert_eq!(&bytes[..4], b"RIFF"),
                    }
                }
            }
        }
    }
}
