//! Native Rust Takumi OG image renderer (`src/utils/database-og.ts`, `src/utils/offer-og.ts`).

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use chrono::{DateTime, Datelike, NaiveDate, Utc};
use futures::{StreamExt, stream};
use reqwest::Client;
use takumi::prelude::*;
use takumi::{from_html, render, write_image};
use thiserror::Error;

const ROBOTO_REGULAR: &[u8] = include_bytes!("../../../../src/static/Roboto.ttf");
const ROBOTO_BOLD: &[u8] = include_bytes!("../../../../src/static/Roboto-Bold.woff");

/// Supported OG output image formats.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OgImageFormat {
    Png,
    Webp,
}

impl OgImageFormat {
    pub fn content_type(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Webp => "image/webp",
        }
    }

    fn into_output_format(self) -> OutputFormat {
        match self {
            Self::Png => OutputFormat::Png,
            Self::Webp => OutputFormat::WebP {
                quality: Quality::new(90),
            },
        }
    }
}

/// Errors produced during Takumi layout, HTML parsing, or image encoding.
#[derive(Debug, Error)]
pub enum OgRendererError {
    #[error("takumi error: {0}")]
    Takumi(#[from] takumi::prelude::Error),
    #[error("html parse error: {0}")]
    Html(#[from] HtmlError),
    #[error("font error: {0}")]
    Font(#[from] FontError),
}

/// Single metric column in [`DatabaseOgCard`] (`src/utils/database-og.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatabaseOgMetric {
    pub label: String,
    pub value: String,
    pub detail: String,
}

/// Card data for [`database_og_tree`] and [`render_database_og`] (`src/utils/database-og.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatabaseOgCard {
    pub title: String,
    pub subtitle: String,
    pub metrics: [DatabaseOgMetric; 3],
    pub footer_label: String,
    pub footer_value: String,
}

/// Card data for [`offer_og_tree`] and [`render_offer_og`] (`src/utils/offer-og.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OfferOgCard {
    pub title: String,
    pub subtitle: String,
    pub price: String,
    pub price_detail: String,
    pub last_update: String,
    pub asset_size: String,
    pub asset_detail: String,
    pub release_date: String,
}

impl OfferOgCard {
    pub fn into_database_card(self) -> DatabaseOgCard {
        DatabaseOgCard {
            title: self.title,
            subtitle: self.subtitle,
            metrics: [
                DatabaseOgMetric {
                    label: "PRICE".into(),
                    value: self.price,
                    detail: self.price_detail,
                },
                DatabaseOgMetric {
                    label: "LAST UPDATE".into(),
                    value: self.last_update,
                    detail: "Catalog record".into(),
                },
                DatabaseOgMetric {
                    label: "ASSET SIZE".into(),
                    value: self.asset_size,
                    detail: self.asset_detail,
                },
            ],
            footer_label: "Release date".into(),
            footer_value: self.release_date,
        }
    }
}

/// Minimal asset input for [`latest_og_download`] (`src/utils/offer-og.ts`).
#[derive(Debug, Clone, PartialEq)]
pub struct OfferOgAsset {
    pub artifact_id: String,
    pub platform: Option<String>,
    pub download_size_bytes: Option<f64>,
    pub updated_at_ms: Option<i64>,
    pub created_at_ms: Option<i64>,
}

/// Minimal build input for [`latest_og_download`] (`src/utils/offer-og.ts`).
#[derive(Debug, Clone, PartialEq)]
pub struct OfferOgBuild {
    pub app_name: String,
    pub label_name: String,
    pub platform: Option<String>,
    pub download_size_bytes: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LatestOgDownload {
    pub bytes: Option<f64>,
    pub platform: Option<String>,
}

/// Formats a UTC date in `dd MMM yyyy` (`en-GB` UTC) matching `formatOgDate` in `src/utils/offer-og.ts`.
pub fn format_og_date(dt: Option<DateTime<Utc>>) -> String {
    match dt {
        Some(d) => {
            let month = if d.month() == 9 {
                "Sept".into()
            } else {
                d.format("%b").to_string()
            };
            format!("{:02} {month} {}", d.day(), d.year_ce().1)
        }
        None => "Not available".to_string(),
    }
}

/// Parses an ISO-8601 date string and formats via [`format_og_date`].
pub fn format_og_date_str(value: Option<&str>) -> String {
    format_og_date(value.and_then(parse_og_date))
}

pub fn parse_og_date(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .or_else(|_| DateTime::parse_from_rfc2822(s))
        .ok()
        .map(|d| d.with_timezone(&Utc))
        .or_else(|| {
            Some(
                NaiveDate::parse_from_str(s, "%Y-%m-%d")
                    .ok()?
                    .and_hms_opt(0, 0, 0)?
                    .and_utc(),
            )
        })
}

/// Formats a byte count into `GB` matching `formatOgSize` in `src/utils/offer-og.ts`.
pub fn format_og_size(bytes: Option<f64>) -> String {
    let Some(bytes) = bytes else {
        return "Not available".to_string();
    };
    if !bytes.is_finite() || bytes < 0.0 {
        return "Not available".to_string();
    }
    if bytes > 0.0 && bytes < 10_000_000.0 {
        return "< 0.01 GB".to_string();
    }
    format!(
        "{} GB",
        ryu_js::Buffer::new().format_to_fixed(bytes / 1_000_000_000.0, 2)
    )
}

/// Computes latest download size & platform matching `latestOgDownload` in `src/utils/offer-og.ts`.
pub fn latest_og_download(
    assets: &[OfferOgAsset],
    build: Option<&OfferOgBuild>,
) -> LatestOgDownload {
    if let Some(build) = build {
        let platform = build
            .platform
            .as_deref()
            .or_else(|| build.label_name.rsplit('-').next())
            .unwrap_or("Unknown")
            .to_string();
        let matching: Vec<&OfferOgAsset> = assets
            .iter()
            .filter(|a| a.artifact_id == build.app_name)
            .collect();
        let asset = matching
            .iter()
            .copied()
            .find(|a| a.platform.as_deref() == Some(platform.as_str()))
            .or_else(|| {
                matching
                    .iter()
                    .copied()
                    .find(|a| a.platform.as_deref().is_none_or(str::is_empty))
            })
            .or_else(|| match matching.as_slice() {
                [only] if platform == "Unknown" => Some(*only),
                _ => None,
            });
        let bytes = build
            .download_size_bytes
            .or_else(|| asset.and_then(|a| a.download_size_bytes));
        let out_platform = if platform == "Unknown" {
            asset.and_then(|a| a.platform.clone())
        } else {
            Some(platform)
        };
        return LatestOgDownload {
            bytes,
            platform: out_platform,
        };
    }

    let latest = assets
        .iter()
        .min_by_key(|a| std::cmp::Reverse(a.updated_at_ms.or(a.created_at_ms).unwrap_or(0)));
    LatestOgDownload {
        bytes: latest.and_then(|a| a.download_size_bytes),
        platform: latest.and_then(|a| a.platform.clone()),
    }
}

/// Fetches a cover image with a 5s timeout, returning `None` on any failure (`src/utils/database-og.ts`).
pub async fn fetch_og_cover(url: Option<&str>, http: &Client) -> Option<Vec<u8>> {
    let url = url?.trim();
    if url.is_empty() {
        return None;
    }
    let resp = http
        .get(url)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.bytes().await.ok().map(|b| b.to_vec())
}

fn css_style(css: &str) -> Style {
    css.parse::<Style>().unwrap_or_default()
}

fn text_node(value: &str, extra_css: &str) -> Node {
    let full = format!("color: #FFFFFF; line-height: 1.2; flex-shrink: 0; {extra_css}");
    Node::text(value).with_style(css_style(&full))
}

fn container_node(css: &str, children: Vec<Node>) -> Node {
    Node::container(children).with_style(css_style(css))
}

/// Builds the Takumi node tree for a database OG card (`databaseOgTree` in `src/utils/database-og.ts`).
pub fn database_og_tree(card: &DatabaseOgCard, has_cover: bool) -> Node {
    let left: u32 = if has_cover { 298 } else { 48 };
    let width: u32 = 1152 - left;
    let title: String = card.title.chars().take(160).collect();
    let char_count = title.chars().count();
    let title_size = if char_count > 60 {
        36
    } else if char_count > 30 {
        44
    } else {
        64
    };

    let metric_nodes: Vec<Node> = card
        .metrics
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let val_len = item.value.chars().count();
            let val_size = if val_len > 14 {
                24
            } else if val_len > 11 {
                28
            } else {
                32
            };
            let pad_left = if index > 0 { 40 } else { 0 };
            let border = if index > 0 {
                "border-left: 1px solid #235B80;"
            } else {
                ""
            };
            let col_width = width / 3;
            container_node(
                &format!(
                    "width: {col_width}px; padding-left: {pad_left}px; padding-right: 12px; {border} display: flex; flex-direction: column; gap: 8px;"
                ),
                vec![
                    text_node(
                        &item.label,
                        "font-size: 20px; color: #92B0D0; letter-spacing: 0.7px;",
                    ),
                    text_node(
                        &item.value,
                        &format!(
                            "font-size: {val_size}px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"
                        ),
                    ),
                    text_node(&item.detail, "font-size: 22px; color: #92B0D0;"),
                ],
            )
        })
        .collect();

    let mut children: Vec<Node> = Vec::new();
    if has_cover {
        children.push(Node::image("cover").with_style(css_style(
            "position: absolute; right: 0px; top: 0px; width: 1200px; height: 630px; object-fit: cover; opacity: 0.04;",
        )));
    }

    children.push(container_node(
        "position: absolute; left: 48px; top: 48px; display: flex;",
        vec![
            text_node("egdata", "font-size: 34px; font-weight: 700;"),
            text_node(".app", "font-size: 34px; font-weight: 700; color: #0078F2;"),
        ],
    ));

    children.push(text_node(
        "Epic Games Store Database",
        "position: absolute; top: 57px; right: 48px; font-size: 24px; color: #92B0D0;",
    ));

    if has_cover {
        children.push(Node::image("cover").with_style(css_style(
            "position: absolute; left: 48px; top: 132px; width: 224px; height: 280px; object-fit: cover; border-radius: 8px; border: 1px solid #235B80;",
        )));
    }

    children.push(container_node(
        &format!(
            "position: absolute; left: {left}px; top: 166px; width: {width}px; height: 168px; display: flex; flex-direction: column; justify-content: center; gap: 12px;"
        ),
        vec![
            text_node(
                &title,
                &format!(
                    "font-size: {title_size}px; font-weight: 700; line-height: 1.08; line-clamp: 2; overflow: hidden; text-overflow: ellipsis; word-break: break-word;"
                ),
            ),
            text_node(
                &card.subtitle,
                "font-size: 24px; color: #92B0D0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;",
            ),
        ],
    ));

    children.push(container_node(
        &format!(
            "position: absolute; left: {left}px; top: 348px; width: {width}px; height: 132px; padding-top: 22px; border-top: 1px solid #235B80; display: flex;"
        ),
        metric_nodes,
    ));

    children.push(container_node(
        "position: absolute; left: 48px; top: 496px; width: 1104px; padding-top: 32px; border-top: 1px solid #235B80; display: flex; align-items: center;",
        vec![
            text_node(
                &card.footer_label,
                "font-size: 24px; color: #92B0D0; padding-right: 38px;",
            ),
            text_node(
                &card.footer_value,
                "font-size: 32px; font-weight: 700; border-left: 1px solid #235B80; padding-left: 40px;",
            ),
        ],
    ));

    container_node(
        "width: 1200px; height: 630px; position: relative; overflow: hidden; background-color: #00162D; font-family: Roboto;",
        children,
    )
}

/// Builds the Takumi node tree for an offer OG card (`offerOgTree` in `src/utils/offer-og.ts`).
pub fn offer_og_tree(card: &OfferOgCard, has_cover: bool) -> Node {
    database_og_tree(&card.clone().into_database_card(), has_cover)
}

/// Returns shared initialized Roboto fonts (`Roboto.ttf` @ 400 and `Roboto-Bold.woff` @ 700).
pub fn shared_fonts() -> std::result::Result<&'static Fonts, OgRendererError> {
    static FONTS: OnceLock<Fonts> = OnceLock::new();
    if let Some(fonts) = FONTS.get() {
        return Ok(fonts);
    }
    let mut fonts = Fonts::default();
    fonts
        .register(
            FontResource::new(ROBOTO_REGULAR).override_info(FontOverride {
                family_name: Some(Arc::from("Roboto")),
                weight: Some(400.0),
                ..FontOverride::default()
            }),
        )
        .expect("embedded Roboto regular font is valid");
    fonts
        .register(FontResource::new(ROBOTO_BOLD).override_info(FontOverride {
            family_name: Some(Arc::from("Roboto")),
            weight: Some(700.0),
            ..FontOverride::default()
        }))
        .expect("embedded Roboto bold font is valid");
    let _ = FONTS.set(fonts);
    Ok(FONTS.get().expect("fonts initialized"))
}

/// Renders an arbitrary Takumi [`Node`] tree to PNG or WebP bytes.
pub fn render_node_to_image(
    node: Node,
    viewport: (u32, u32),
    format: OgImageFormat,
    images: HashMap<Arc<str>, ImageSource>,
) -> std::result::Result<Vec<u8>, OgRendererError> {
    let fonts = shared_fonts()?;
    let options = RenderOptions::builder()
        .viewport(Viewport::new(viewport))
        .node(node)
        .fonts(fonts)
        .images(images)
        .build();
    let bitmap = render(options)?;
    let mut out = Vec::new();
    write_image(&bitmap, &mut out, format.into_output_format())?;
    Ok(out)
}

/// Parses HTML markup via `takumi::from_html` and renders it to PNG or WebP bytes.
pub fn render_html_to_image(
    html: &str,
    viewport: (u32, u32),
    format: OgImageFormat,
    images: HashMap<Arc<str>, ImageSource>,
) -> std::result::Result<Vec<u8>, OgRendererError> {
    let node = from_html(html, FromHtmlOptions::default())?;
    render_node_to_image(node, viewport, format, images)
}

/// Load the external images named by a server-generated editorial card before painting it.
pub async fn render_editorial_html(
    html: &str,
    template: egdata_core::ports::EditorialOgTemplate,
    http: &Client,
) -> std::result::Result<Vec<u8>, OgRendererError> {
    let node = from_html(html, FromHtmlOptions::default())?;
    let urls: Vec<Arc<str>> = node
        .image_urls()
        .filter(|url| url.starts_with("https://") || url.starts_with("http://"))
        .map(Arc::from)
        .collect();
    let images = stream::iter(urls)
        .map(|url| async move {
            let bytes = fetch_og_cover(Some(&url), http).await?;
            Some((url, ImageSource::from_bytes(&bytes).ok()?))
        })
        .buffer_unordered(4)
        .filter_map(std::future::ready)
        .collect()
        .await;
    use egdata_core::ports::EditorialOgTemplate;
    // Free games and collections register only Roboto Light under weight 400.
    // Awards registers the same face under 300 and adds a bold font.
    static LIGHT: OnceLock<Fonts> = OnceLock::new();
    static AWARDS: OnceLock<Fonts> = OnceLock::new();
    let awards = template == EditorialOgTemplate::GameAwards;
    let fonts = if awards { &AWARDS } else { &LIGHT }.get_or_init(|| {
        let mut fonts = Fonts::default();
        let font = FontResource::new(include_bytes!("../../../../src/static/Roboto-Light.ttf"))
            .override_info(FontOverride {
                family_name: Some(Arc::from("Roboto")),
                weight: Some(if awards { 300. } else { 400. }),
                ..Default::default()
            });
        fonts.register(font).expect("valid bundled Roboto Light");
        if awards {
            fonts
                .register(FontResource::new(ROBOTO_BOLD).override_info(FontOverride {
                    family_name: Some(Arc::from("Roboto")),
                    weight: Some(700.),
                    ..Default::default()
                }))
                .expect("valid bundled Roboto Bold");
        }
        fonts
    });
    let scale = template.output_width() as f32 / template.layout_width() as f32;
    let viewport = Viewport::new((template.output_width(), (630.0 * scale).round() as u32))
        .with_device_pixel_ratio(scale);
    let options = RenderOptions::builder()
        .viewport(viewport)
        .node(node)
        .fonts(fonts)
        .images(images)
        .build();
    let mut output = Vec::new();
    write_image(&render(options)?, &mut output, OutputFormat::Png)?;
    Ok(output)
}

/// Renders HTML with image URLs resolved from deterministic byte inputs.
pub fn render_html_to_image_with_image_bytes(
    html: &str,
    viewport: (u32, u32),
    format: OgImageFormat,
    image_bytes: impl IntoIterator<Item = (Arc<str>, Vec<u8>)>,
) -> std::result::Result<Vec<u8>, OgRendererError> {
    let images = image_bytes
        .into_iter()
        .filter_map(|(url, bytes)| {
            ImageSource::from_bytes(&bytes)
                .ok()
                .map(|source| (url, source))
        })
        .collect();
    render_html_to_image(html, viewport, format, images)
}

/// Checks whether fetched cover bytes can be decoded by Takumi.
pub fn og_cover_bytes_are_renderable(bytes: &[u8]) -> bool {
    ImageSource::from_bytes(bytes).is_ok()
}

/// Renders a [`DatabaseOgCard`] as a 1200x630 PNG or WebP, gracefully falling back if `cover` fails to decode.
pub fn render_database_og(
    card: &DatabaseOgCard,
    format: OgImageFormat,
    cover: Option<&[u8]>,
) -> std::result::Result<Vec<u8>, OgRendererError> {
    if let Some(cover_bytes) = cover
        && let Ok(source) = ImageSource::from_bytes(cover_bytes)
    {
        let mut images = HashMap::new();
        images.insert(Arc::from("cover"), source);
        return render_node_to_image(database_og_tree(card, true), (1200, 630), format, images);
    }
    render_node_to_image(
        database_og_tree(card, false),
        (1200, 630),
        format,
        HashMap::new(),
    )
}

/// Renders an [`OfferOgCard`] as a 1200x630 PNG or WebP.
pub fn render_offer_og(
    card: &OfferOgCard,
    format: OgImageFormat,
    cover: Option<&[u8]>,
) -> std::result::Result<Vec<u8>, OgRendererError> {
    render_database_og(&card.clone().into_database_card(), format, cover)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn sample_offer_card() -> OfferOgCard {
        OfferOgCard {
            title: "Alan Wake 2".into(),
            subtitle: "Epic Games Publishing • Offer".into(),
            price: "$49.99".into(),
            price_detail: "US • Base".into(),
            last_update: "14 Mar 2025".into(),
            asset_size: "92.50 GB".into(),
            asset_detail: "Windows".into(),
            release_date: "27 Oct 2023".into(),
        }
    }

    #[test]
    fn date_size_and_latest_download_helpers() {
        let dt = Utc.with_ymd_and_hms(2025, 3, 14, 15, 0, 0).unwrap();
        assert_eq!(format_og_date(Some(dt)), "14 Mar 2025");
        assert_eq!(format_og_date(None), "Not available");
        assert_eq!(
            format_og_date_str(Some("2025-03-14T15:00:00Z")),
            "14 Mar 2025"
        );
        assert_eq!(format_og_date_str(Some("bad")), "Not available");

        assert_eq!(format_og_size(None), "Not available");
        assert_eq!(format_og_size(Some(-1.0)), "Not available");
        assert_eq!(format_og_size(Some(f64::NAN)), "Not available");
        assert_eq!(format_og_size(Some(0.0)), "0.00 GB");
        assert_eq!(format_og_size(Some(5_000_000.0)), "< 0.01 GB");
        assert_eq!(format_og_size(Some(1_500_000_000.0)), "1.50 GB");

        let assets = vec![
            OfferOgAsset {
                artifact_id: "app1".into(),
                platform: Some("Windows".into()),
                download_size_bytes: Some(2_000_000_000.0),
                updated_at_ms: Some(100),
                created_at_ms: Some(50),
            },
            OfferOgAsset {
                artifact_id: "app2".into(),
                platform: None,
                download_size_bytes: Some(3_000_000_000.0),
                updated_at_ms: Some(200),
                created_at_ms: Some(150),
            },
        ];
        let build = OfferOgBuild {
            app_name: "app1".into(),
            label_name: "Live-Windows".into(),
            platform: None,
            download_size_bytes: None,
        };
        let dl = latest_og_download(&assets, Some(&build));
        assert_eq!(dl.bytes, Some(2_000_000_000.0));
        assert_eq!(dl.platform.as_deref(), Some("Windows"));

        let unknown_build = OfferOgBuild {
            app_name: "app2".into(),
            label_name: "Unknown".into(),
            platform: Some("Unknown".into()),
            download_size_bytes: Some(500.0),
        };
        let dl2 = latest_og_download(&assets, Some(&unknown_build));
        assert_eq!(dl2.bytes, Some(500.0));
        assert_eq!(dl2.platform, None);

        let dl_no_build = latest_og_download(&assets, None);
        assert_eq!(dl_no_build.bytes, Some(3_000_000_000.0));

        let no_asset = latest_og_download(&[], Some(&build));
        assert_eq!(no_asset.bytes, None);
        assert_eq!(no_asset.platform.as_deref(), Some("Windows"));
        let unmatched = OfferOgBuild {
            app_name: "other".into(),
            download_size_bytes: None,
            ..unknown_build.clone()
        };
        assert_eq!(
            latest_og_download(&assets, Some(&unmatched)),
            LatestOgDownload {
                bytes: None,
                platform: None
            }
        );
        let unknown = OfferOgBuild {
            platform: Some("Unknown".into()),
            ..build.clone()
        };
        assert_eq!(latest_og_download(&assets, Some(&unknown)), dl);
        let empty_platform = OfferOgAsset {
            platform: Some(String::new()),
            ..assets[0].clone()
        };
        assert_eq!(latest_og_download(&[empty_platform], Some(&build)), dl);
        let tied = OfferOgAsset {
            created_at_ms: Some(100),
            updated_at_ms: None,
            ..assets[1].clone()
        };
        assert_eq!(latest_og_download(&[assets[0].clone(), tied], None), dl);
    }

    #[test]
    fn renders_offer_and_database_og_png_webp_with_and_without_cover_and_html() {
        assert_eq!(OgImageFormat::Png.content_type(), "image/png");
        assert_eq!(OgImageFormat::Webp.content_type(), "image/webp");

        let card = sample_offer_card();
        let png = render_offer_og(&card, OgImageFormat::Png, None).unwrap();
        assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));

        // Use the rendered PNG itself as a valid cover image
        let webp = render_offer_og(&card, OgImageFormat::Webp, Some(&png)).unwrap();
        assert_eq!(&webp[0..4], b"RIFF");
        assert_eq!(&webp[8..12], b"WEBP");

        // Long title + broken cover falls back cleanly
        let long_card = DatabaseOgCard {
            title: "A very long game title that exceeds sixty characters to exercise the smallest font size branch in database_og_tree".into(),
            subtitle: "Subtitle".into(),
            metrics: [
                DatabaseOgMetric { label: "M1".into(), value: "123456789012345".into(), detail: "D1".into() },
                DatabaseOgMetric { label: "M2".into(), value: "123456789012".into(), detail: "D2".into() },
                DatabaseOgMetric { label: "M3".into(), value: "Short".into(), detail: "D3".into() },
            ],
            footer_label: "Footer".into(),
            footer_value: "Value".into(),
        };
        let fallback_png =
            render_database_og(&long_card, OgImageFormat::Png, Some(b"broken-image")).unwrap();
        assert!(fallback_png.starts_with(b"\x89PNG\r\n\x1a\n"));

        // Medium title (31..=60 chars)
        let med_tree = offer_og_tree(
            &OfferOgCard {
                title: "A medium length title around thirty five chars".into(),
                ..card
            },
            false,
        );
        assert!(
            render_node_to_image(med_tree, (1200, 630), OgImageFormat::Png, HashMap::new()).is_ok()
        );

        // HTML rendering helper
        let html_png = render_html_to_image(
            r#"<div style="width:200px;height:80px;background:#00162D;color:#FFFFFF;font-family:Roboto;">egdata.app</div>"#,
            (200, 80),
            OgImageFormat::Png,
            HashMap::new(),
        )
        .unwrap();
        assert!(html_png.starts_with(b"\x89PNG\r\n\x1a\n"));
    }

    #[tokio::test]
    async fn fetch_og_cover_handles_ok_404_and_empty() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 2048];
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let path = req
                        .lines()
                        .next()
                        .unwrap_or("")
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or("/");
                    let resp: &[u8] = if path == "/ok" {
                        b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc"
                    } else {
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    };
                    let _ = socket.write_all(resp).await;
                });
            }
        });

        let client = Client::new();
        assert!(fetch_og_cover(None, &client).await.is_none());
        assert!(fetch_og_cover(Some("  "), &client).await.is_none());
        assert_eq!(
            fetch_og_cover(Some(&format!("http://{addr}/ok")), &client)
                .await
                .as_deref(),
            Some(b"abc".as_slice())
        );
        assert!(
            fetch_og_cover(Some(&format!("http://{addr}/404")), &client)
                .await
                .is_none()
        );
        assert!(
            fetch_og_cover(Some("http://127.0.0.1:1/fail"), &client)
                .await
                .is_none()
        );
    }
}
