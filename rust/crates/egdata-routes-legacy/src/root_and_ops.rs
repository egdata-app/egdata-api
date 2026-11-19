//! Root `/`, `/refresh*`, `/free-games/index`, `/free-games/og`, `/collections/{slug}/{week}/og`, and `/offers/regen*`.
//! Note: `GET /offers/{id}/reviews-summary` is already registered in `legacy::offer_prices`.
use super::{
    Routes,
    common::*,
    og_editorial::{iso_week_range_utc, weekly_position},
    system::{missing_country, query, selected_region},
};
use crate::{state::AppState};
use egdata_http_core::shared::collation::for_locale;
use axum::{
    body::{Body, Bytes},
    extract::{Path, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, Uri, header},
    response::Response,
};
use bson::{Bson, doc};
#[cfg(test)]
use chrono::Duration;
use chrono::{DateTime, Datelike, Utc};
use egdata_core::{
    ports::{JobApiJobType, MongoFindOptions, UpstreamHttpMultipartFile, UpstreamHttpRequest},
    v1::{currency_precision, serialization::node_json},
};
use futures::future::join_all;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

mod multisearch;
mod root_reads;

fn enumerable_fields(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(fields) => fields.clone(),
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v.clone()))
            .collect(),
        Value::String(s) => s
            .encode_utf16()
            .enumerate()
            .map(|(i, unit)| (i.to_string(), json!(String::from_utf16_lossy(&[unit]))))
            .collect(),
        _ => Map::new(),
    }
}

fn item_attributes(value: &Value) -> Result<Value> {
    egdata_http_core::shared::offers::checked_attributes(value).map_err(|_| Error::Internal)
}

#[test]
fn every_node_root_listing_has_a_mounted_handler() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../egdata-api/tests/fixtures/legacy-root-ops-http-node.json"
    ))
    .unwrap();
    let root = fixture
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["request"]["path"] == "/")
        .unwrap();
    let registered = super::registration_sources();
    let mut missing = Vec::new();
    for entry in root["response"]["body"]["endpoints"].as_array().unwrap() {
        let (method, path) = entry.as_str().unwrap().split_once(' ').unwrap();
        // GraphQL, versioned operations and CORS preflights are mounted outside this router.
        if path == "/graphql" || path.starts_with("/v1/") || method == "OPTIONS" {
            continue;
        }
        let path = path
            .split('/')
            .map(|p| {
                p.strip_prefix(':')
                    .map_or_else(|| p.to_owned(), |name| format!("{{{name}}}"))
            })
            .collect::<Vec<_>>()
            .join("/");
        if !registered.contains_key(&(method.to_owned(), path.clone())) {
            missing.push(format!("{method} {path}"));
        }
    }
    assert!(
        missing.is_empty(),
        "Node lists unmounted handlers: {missing:?}"
    );
}

const API_VERSION: &str = "0.1.0-alpha.0";
const DEFAULT_CLOUDFLARE_ACCOUNT_ID: &str = "7da0b3179a5b5ef4f1a2d1189f072d0b";
const CF_DELIVERY_BASE: &str =
    "https://cdn.egdata.app/cdn-cgi/imagedelivery/RlN2EBAhhGSZh5aeUaPz3Q";

const OG_CACHE_CONTROL: &str = "public, max-age=86400, stale-while-revalidate=604800";
const OG_CDN_CACHE_CONTROL: &str = "public, max-age=2592000, stale-while-revalidate=604800";
const OG_IMMUTABLE_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";
const OG_IMMUTABLE_CDN_CACHE_CONTROL: &str =
    "public, max-age=31536000, stale-while-revalidate=604800";

const FREE_GAMES_OG_IMAGE_PRIORITY: &[&str] = &[
    "DieselGameBoxWide",
    "OfferImageWide",
    "Featured",
    "DieselStoreFrontWide",
    "VaultClosed",
];

const NODE_ENDPOINTS: &[(&str, &str)] = &[
    ("GET", "/accounts"),
    ("GET", "/active-sales"),
    ("GET", "/admin"),
    ("PATCH", "/admin/offers"),
    ("POST", "/admin/offers"),
    ("GET", "/assets/:id"),
    ("GET", "/auth"),
    ("POST", "/auth/avatar"),
    ("GET", "/auth/discord/callback"),
    ("GET", "/auth/discord/link"),
    ("GET", "/auth/logout"),
    ("POST", "/auth/persist"),
    ("GET", "/auth/refresh"),
    ("PATCH", "/auth/refresh"),
    ("PATCH", "/auth/refresh-admin"),
    ("POST", "/auth/v2/persist"),
    ("GET", "/auth/v2/refresh"),
    ("POST", "/auth/v2/save-state"),
    ("POST", "/auth/v2/validate-state"),
    ("GET", "/autocomplete"),
    ("GET", "/base-game/:namespace"),
    ("GET", "/builds"),
    ("GET", "/builds/:id"),
    ("GET", "/builds/:id/files"),
    ("GET", "/builds/:id/history"),
    ("GET", "/builds/:id/install-options"),
    ("GET", "/builds/:id/items"),
    ("GET", "/builds/:id/tree"),
    ("GET", "/builds/:targetId/compare/:baseId"),
    ("POST", "/builds/resolve-launcher-records"),
    ("POST", "/catalog/hydrate"),
    ("GET", "/changelist"),
    ("GET", "/changelist/:id"),
    ("GET", "/changelog"),
    ("GET", "/collections/:slug"),
    ("GET", "/collections/:slug/:week"),
    ("GET", "/collections/:slug/:week/og"),
    ("GET", "/countries"),
    ("GET", "/doc"),
    ("GET", "/donate/key/:code"),
    ("POST", "/donate/key/:code"),
    ("GET", "/featured"),
    ("GET", "/franchises/:slug"),
    ("GET", "/free-games"),
    ("GET", "/free-games/history"),
    ("PATCH", "/free-games/index"),
    ("GET", "/free-games/mobile"),
    ("GET", "/free-games/og"),
    ("GET", "/free-games/search"),
    ("GET", "/free-games/sellers"),
    ("GET", "/free-games/stats"),
    ("GET", "/game-awards"),
    ("GET", "/game-awards/og"),
    ("ALL", "/graphql"),
    ("GET", "/health"),
    ("GET", "/items"),
    ("GET", "/items-from-offer/:id"),
    ("GET", "/items-sitemap.xml"),
    ("GET", "/items/:id"),
    ("GET", "/items/:id/assets"),
    ("GET", "/items/:id/builds"),
    ("GET", "/items/:id/changelog"),
    ("GET", "/items/:id/offer"),
    ("POST", "/items/bulk"),
    ("POST", "/items/bulk-regen"),
    ("POST", "/items/bulk/offers"),
    ("PUT", "/items/regen/:id"),
    ("GET", "/items/sitemap.xml"),
    ("GET", "/latest-games"),
    ("GET", "/launcher/sandbox/:id"),
    ("GET", "/launcher/sandbox/:id/items"),
    ("GET", "/launcher/sandbox/:id/offers"),
    ("GET", "/multisearch"),
    ("GET", "/multisearch/items"),
    ("GET", "/multisearch/offers"),
    ("GET", "/multisearch/sellers"),
    ("GET", "/offer-by-slug/:slug"),
    ("GET", "/offers"),
    ("GET", "/offers/:id"),
    ("GET", "/offers/:id/achievements"),
    ("GET", "/offers/:id/age-rating"),
    ("GET", "/offers/:id/assets"),
    ("GET", "/offers/:id/builds"),
    ("GET", "/offers/:id/bundle"),
    ("GET", "/offers/:id/changelog"),
    ("GET", "/offers/:id/changelog/stats"),
    ("GET", "/offers/:id/collection"),
    ("GET", "/offers/:id/collections/:collection"),
    ("GET", "/offers/:id/features"),
    ("GET", "/offers/:id/franchises"),
    ("GET", "/offers/:id/genres"),
    ("GET", "/offers/:id/giveaways"),
    ("GET", "/offers/:id/has-prepurchase"),
    ("GET", "/offers/:id/has-regular"),
    ("GET", "/offers/:id/hltb"),
    ("GET", "/offers/:id/igdb"),
    ("GET", "/offers/:id/in-bundle"),
    ("GET", "/offers/:id/items"),
    ("GET", "/offers/:id/mappings"),
    ("GET", "/offers/:id/media"),
    ("GET", "/offers/:id/og"),
    ("GET", "/offers/:id/og.webp"),
    ("GET", "/offers/:id/overview"),
    ("GET", "/offers/:id/ownership"),
    ("GET", "/offers/:id/polls"),
    ("GET", "/offers/:id/price"),
    ("GET", "/offers/:id/price-history"),
    ("GET", "/offers/:id/price-stats"),
    ("GET", "/offers/:id/price/fairness"),
    ("GET", "/offers/:id/ratings"),
    ("GET", "/offers/:id/regional-price"),
    ("GET", "/offers/:id/related"),
    ("GET", "/offers/:id/requirements"),
    ("DELETE", "/offers/:id/reviews"),
    ("GET", "/offers/:id/reviews"),
    ("PATCH", "/offers/:id/reviews"),
    ("POST", "/offers/:id/reviews"),
    ("GET", "/offers/:id/reviews-summary"),
    ("GET", "/offers/:id/reviews/permissions"),
    ("GET", "/offers/:id/suggestions"),
    ("GET", "/offers/:id/technologies"),
    ("GET", "/offers/:id/tops"),
    ("POST", "/offers/bulk-regen"),
    ("GET", "/offers/events"),
    ("GET", "/offers/events/:id"),
    ("POST", "/offers/exists"),
    ("GET", "/offers/featured-discounts"),
    ("GET", "/offers/genres"),
    ("GET", "/offers/latest-achievements"),
    ("GET", "/offers/latest-released"),
    ("PUT", "/offers/regen-by-id/:id"),
    ("PUT", "/offers/regen/:slug"),
    ("POST", "/offers/slugs"),
    ("GET", "/offers/top-sellers"),
    ("GET", "/offers/top-wishlisted"),
    ("GET", "/offers/upcoming"),
    ("GET", "/open-api.json"),
    ("GET", "/ping"),
    ("OPTIONS", "/ping"),
    ("POST", "/ping"),
    ("GET", "/profiles/:id"),
    ("GET", "/profiles/:id/achievements"),
    ("GET", "/profiles/:id/achievements/:sandboxId"),
    ("GET", "/profiles/:id/games"),
    ("GET", "/profiles/:id/information"),
    ("GET", "/profiles/:id/random-game"),
    ("GET", "/profiles/:id/rare-achievements"),
    ("GET", "/profiles/:id/rare-achievements/:sandboxId"),
    ("PUT", "/profiles/:id/refresh"),
    ("GET", "/profiles/:id/refresh-status"),
    ("GET", "/profiles/leaderboard"),
    ("GET", "/profiles/me"),
    ("GET", "/profiles/sitemap.xml"),
    ("GET", "/promotions"),
    ("GET", "/promotions-sitemap.xml"),
    ("GET", "/promotions/:id"),
    ("GET", "/promotions/:id/cover"),
    ("POST", "/push/send"),
    ("POST", "/push/send-to-user"),
    ("GET", "/push/subscribe"),
    ("POST", "/push/subscribe"),
    ("GET", "/push/subscriptions"),
    ("GET", "/push/subscriptions/:subscriptionId"),
    ("GET", "/push/topics/stats"),
    ("POST", "/push/topics/subscribe"),
    ("POST", "/push/topics/unsubscribe"),
    ("DELETE", "/push/unsubscribe/:subscriptionId"),
    ("GET", "/push/vapid-public-key"),
    ("PATCH", "/refresh-meilisearch"),
    ("PATCH", "/refresh/changelog"),
    ("PATCH", "/refresh/items"),
    ("PATCH", "/refresh/offers"),
    ("PATCH", "/refresh/sellers"),
    ("GET", "/region"),
    ("GET", "/regions"),
    ("GET", "/robots.txt"),
    ("GET", "/sales"),
    ("GET", "/sandboxes"),
    ("GET", "/sandboxes/:sandboxId"),
    ("GET", "/sandboxes/:sandboxId/achievements"),
    ("GET", "/sandboxes/:sandboxId/assets"),
    ("GET", "/sandboxes/:sandboxId/base-game"),
    ("GET", "/sandboxes/:sandboxId/builds"),
    ("GET", "/sandboxes/:sandboxId/changelog"),
    ("GET", "/sandboxes/:sandboxId/items"),
    ("GET", "/sandboxes/:sandboxId/offers"),
    ("GET", "/sandboxes/:sandboxId/og"),
    ("GET", "/sandboxes/:sandboxId/og.webp"),
    ("GET", "/sandboxes/:sandboxId/stats"),
    ("GET", "/sandboxes/sitemap.xml"),
    ("GET", "/search"),
    ("POST", "/search"),
    ("GET", "/search/:id"),
    ("GET", "/search/:id/count"),
    ("GET", "/search/changelog"),
    ("GET", "/search/developers"),
    ("POST", "/search/natural-language"),
    ("GET", "/search/offer-types"),
    ("GET", "/search/publishers"),
    ("GET", "/search/tags"),
    ("GET", "/search/v2/search"),
    ("POST", "/search/v2/search"),
    ("GET", "/sellers"),
    ("GET", "/sellers/:id"),
    ("GET", "/sellers/:id/cover"),
    ("GET", "/sellers/:id/stats"),
    ("GET", "/sitemap.xml"),
    ("GET", "/stats"),
    ("GET", "/stats/creations/monthly"),
    ("GET", "/stats/creations/yearly"),
    ("GET", "/stats/homepage"),
    ("GET", "/stats/releases/monthly"),
    ("GET", "/stats/releases/yearly"),
    ("GET", "/tags"),
    ("GET", "/ui"),
    ("GET", "/users"),
    ("GET", "/users-service"),
    ("POST", "/users-service/ownership"),
    ("POST", "/users-service/playtime"),
    ("GET", "/users/check-epic"),
    ("GET", "/users/discord"),
    ("POST", "/users/discord"),
    ("DELETE", "/users/epic"),
    ("PUT", "/users/epic"),
    ("POST", "/users/find-or-create"),
    ("ALL", "/v1/*"),
    ("OPTIONS", "/v1/*"),
    ("GET", "/v1/active-sales"),
    ("GET", "/v1/assets/:id"),
    ("GET", "/v1/autocomplete"),
    ("GET", "/v1/base-game/:namespace"),
    ("GET", "/v1/builds"),
    ("GET", "/v1/builds/:id"),
    ("GET", "/v1/builds/:id/files"),
    ("GET", "/v1/builds/:id/history"),
    ("GET", "/v1/builds/:id/install-options"),
    ("GET", "/v1/builds/:id/items"),
    ("GET", "/v1/builds/:id/tree"),
    ("GET", "/v1/builds/:targetId/compare/:baseId"),
    ("POST", "/v1/builds/resolve-launcher-records"),
    ("POST", "/v1/catalog/hydrate"),
    ("GET", "/v1/changelist/:id"),
    ("GET", "/v1/collections/:slug"),
    ("GET", "/v1/collections/:slug/:week"),
    ("GET", "/v1/collections/:slug/:week/og"),
    ("GET", "/v1/countries"),
    ("GET", "/v1/featured"),
    ("GET", "/v1/franchises/:slug"),
    ("GET", "/v1/free-games"),
    ("GET", "/v1/free-games/history"),
    ("GET", "/v1/free-games/mobile"),
    ("GET", "/v1/free-games/og"),
    ("GET", "/v1/free-games/search"),
    ("GET", "/v1/free-games/sellers"),
    ("GET", "/v1/free-games/stats"),
    ("GET", "/v1/game-awards"),
    ("GET", "/v1/game-awards/og"),
    ("GET", "/v1/health"),
    ("GET", "/v1/items"),
    ("GET", "/v1/items-from-offer/:id"),
    ("GET", "/v1/items-sitemap.xml"),
    ("GET", "/v1/items/:id"),
    ("GET", "/v1/items/:id/assets"),
    ("GET", "/v1/items/:id/builds"),
    ("GET", "/v1/items/:id/changelog"),
    ("GET", "/v1/items/:id/offer"),
    ("POST", "/v1/items/bulk"),
    ("POST", "/v1/items/bulk/offers"),
    ("GET", "/v1/items/sitemap.xml"),
    ("GET", "/v1/latest-games"),
    ("GET", "/v1/multisearch/items"),
    ("GET", "/v1/multisearch/offers"),
    ("GET", "/v1/multisearch/sellers"),
    ("GET", "/v1/offer-by-slug/:slug"),
    ("GET", "/v1/offers"),
    ("GET", "/v1/offers/:id"),
    ("GET", "/v1/offers/:id/achievements"),
    ("GET", "/v1/offers/:id/age-rating"),
    ("GET", "/v1/offers/:id/assets"),
    ("GET", "/v1/offers/:id/builds"),
    ("GET", "/v1/offers/:id/bundle"),
    ("GET", "/v1/offers/:id/changelog"),
    ("GET", "/v1/offers/:id/changelog/stats"),
    ("GET", "/v1/offers/:id/collection"),
    ("GET", "/v1/offers/:id/collections/:collection"),
    ("GET", "/v1/offers/:id/features"),
    ("GET", "/v1/offers/:id/franchises"),
    ("GET", "/v1/offers/:id/genres"),
    ("GET", "/v1/offers/:id/giveaways"),
    ("GET", "/v1/offers/:id/has-prepurchase"),
    ("GET", "/v1/offers/:id/has-regular"),
    ("GET", "/v1/offers/:id/hltb"),
    ("GET", "/v1/offers/:id/igdb"),
    ("GET", "/v1/offers/:id/in-bundle"),
    ("GET", "/v1/offers/:id/items"),
    ("GET", "/v1/offers/:id/mappings"),
    ("GET", "/v1/offers/:id/media"),
    ("GET", "/v1/offers/:id/og"),
    ("GET", "/v1/offers/:id/og.webp"),
    ("GET", "/v1/offers/:id/overview"),
    ("GET", "/v1/offers/:id/polls"),
    ("GET", "/v1/offers/:id/price"),
    ("GET", "/v1/offers/:id/price-history"),
    ("GET", "/v1/offers/:id/price-stats"),
    ("GET", "/v1/offers/:id/price/fairness"),
    ("GET", "/v1/offers/:id/ratings"),
    ("GET", "/v1/offers/:id/regional-price"),
    ("GET", "/v1/offers/:id/related"),
    ("GET", "/v1/offers/:id/requirements"),
    ("GET", "/v1/offers/:id/reviews"),
    ("GET", "/v1/offers/:id/reviews-summary"),
    ("GET", "/v1/offers/:id/suggestions"),
    ("GET", "/v1/offers/:id/technologies"),
    ("GET", "/v1/offers/:id/tops"),
    ("GET", "/v1/offers/events"),
    ("GET", "/v1/offers/events/:id"),
    ("POST", "/v1/offers/exists"),
    ("GET", "/v1/offers/featured-discounts"),
    ("GET", "/v1/offers/genres"),
    ("GET", "/v1/offers/latest-achievements"),
    ("GET", "/v1/offers/latest-released"),
    ("POST", "/v1/offers/slugs"),
    ("GET", "/v1/offers/top-sellers"),
    ("GET", "/v1/offers/top-wishlisted"),
    ("GET", "/v1/offers/upcoming"),
    ("GET", "/v1/open-api.json"),
    ("GET", "/v1/profiles/:id"),
    ("GET", "/v1/profiles/:id/achievements"),
    ("GET", "/v1/profiles/:id/achievements/:sandboxId"),
    ("GET", "/v1/profiles/:id/games"),
    ("GET", "/v1/profiles/:id/information"),
    ("GET", "/v1/profiles/:id/random-game"),
    ("GET", "/v1/profiles/:id/rare-achievements"),
    ("GET", "/v1/profiles/:id/rare-achievements/:sandboxId"),
    ("GET", "/v1/profiles/leaderboard"),
    ("GET", "/v1/profiles/sitemap.xml"),
    ("GET", "/v1/promotions"),
    ("GET", "/v1/promotions-sitemap.xml"),
    ("GET", "/v1/promotions/:id"),
    ("GET", "/v1/promotions/:id/cover"),
    ("GET", "/v1/region"),
    ("GET", "/v1/regions"),
    ("GET", "/v1/robots.txt"),
    ("GET", "/v1/sales"),
    ("GET", "/v1/sandboxes"),
    ("GET", "/v1/sandboxes/:sandboxId"),
    ("GET", "/v1/sandboxes/:sandboxId/achievements"),
    ("GET", "/v1/sandboxes/:sandboxId/assets"),
    ("GET", "/v1/sandboxes/:sandboxId/base-game"),
    ("GET", "/v1/sandboxes/:sandboxId/builds"),
    ("GET", "/v1/sandboxes/:sandboxId/changelog"),
    ("GET", "/v1/sandboxes/:sandboxId/items"),
    ("GET", "/v1/sandboxes/:sandboxId/offers"),
    ("GET", "/v1/sandboxes/:sandboxId/og"),
    ("GET", "/v1/sandboxes/:sandboxId/og.webp"),
    ("GET", "/v1/sandboxes/:sandboxId/stats"),
    ("GET", "/v1/sandboxes/sitemap.xml"),
    ("GET", "/v1/search"),
    ("POST", "/v1/search"),
    ("GET", "/v1/search/:id"),
    ("GET", "/v1/search/:id/count"),
    ("GET", "/v1/search/changelog"),
    ("GET", "/v1/search/developers"),
    ("POST", "/v1/search/natural-language"),
    ("GET", "/v1/search/offer-types"),
    ("GET", "/v1/search/publishers"),
    ("GET", "/v1/search/tags"),
    ("GET", "/v1/sellers"),
    ("GET", "/v1/sellers/:id"),
    ("GET", "/v1/sellers/:id/cover"),
    ("GET", "/v1/sellers/:id/stats"),
    ("GET", "/v1/sitemap.xml"),
    ("GET", "/v1/stats"),
    ("GET", "/v1/stats/creations/monthly"),
    ("GET", "/v1/stats/creations/yearly"),
    ("GET", "/v1/stats/homepage"),
    ("GET", "/v1/stats/releases/monthly"),
    ("GET", "/v1/stats/releases/yearly"),
    ("GET", "/v1/tags"),
];

pub(super) fn routes() -> Routes {
    Routes::new("")
        .get("/", root_index)
        .patch("/refresh-meilisearch", refresh_ok)
        .patch("/refresh/changelog", refresh_ok)
        .patch("/refresh/offers", refresh_ok)
        .patch("/refresh/items", refresh_ok)
        .patch("/refresh/sellers", refresh_ok)
        .patch("/free-games/index", refresh_ok)
        .get("/free-games/og", free_games_og)
        .get("/collections/{slug}/{week}/og", collection_week_og)
        .put("/offers/regen/{slug}", offer_regen_by_slug)
        .put("/offers/regen-by-id/{id}", offer_regen_by_id)
        .post("/offers/bulk-regen", offer_bulk_regen)
        .merge(root_reads::routes())
        .merge(multisearch::routes())
}

// ---------------------------------------------------------------------------
// Root, refresh, and offer regen endpoints
// ---------------------------------------------------------------------------

async fn root_index(State(state): State<AppState>) -> Result<Response> {
    let collator = for_locale(&state.config.collation_locale)?;
    let mut entries = NODE_ENDPOINTS.to_vec();
    entries.sort_by(|a, b| {
        collator
            .compare(a.1, b.1)
            .then_with(|| collator.compare(a.0, b.0))
    });
    let endpoints: Vec<String> = entries
        .into_iter()
        .map(|(method, path)| format!("{method} {path}"))
        .collect();
    Ok(ok(&json!({
        "app": "egdata",
        "version": API_VERSION,
        "endpoints": endpoints,
    })))
}

async fn refresh_ok() -> Response {
    ok(&json!({ "message": "ok" }))
}

async fn offer_regen_by_slug(
    State(state): State<AppState>,
    Path(slug): Path<String>,
) -> Result<Response> {
    state
        .job_api
        .submit(JobApiJobType::OfferRegen, &json!({ "slug": slug }), None)
        .await?;
    Ok(ok(&json!({ "message": "Offer regen requested" })))
}

async fn offer_regen_by_id(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response> {
    state
        .job_api
        .submit(JobApiJobType::OfferRegen, &json!({ "id": id }), None)
        .await?;
    Ok(ok(&json!({ "message": "Offer regen requested" })))
}

async fn offer_bulk_regen(State(state): State<AppState>, body: Bytes) -> Result<Response> {
    let payload: Value = serde_json::from_slice(&body)?;
    let offers = payload["offers"].as_array().ok_or(Error::Internal)?;
    let jobs: Vec<Value> = offers.iter().map(|id| json!({ "id": id })).collect();
    state
        .job_api
        .submit_batch(JobApiJobType::OfferRegen, &jobs, None)
        .await?;
    Ok(ok(&json!({ "message": "Offer regen requested" })))
}

// ---------------------------------------------------------------------------
// Shared Cloudflare Images & formatting helpers
// ---------------------------------------------------------------------------

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn og_headers_response(
    mut response: Response,
    cache_control: &'static str,
    cdn_cache_control: &'static str,
) -> Response {
    let headers = response.headers_mut();
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(cache_control),
    );
    headers.insert(
        HeaderName::from_static("cdn-cache-control"),
        HeaderValue::from_static(cdn_cache_control),
    );
    headers.insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    response
}

fn og_json_response(
    value: &Value,
    cache_control: &'static str,
    cdn_cache_control: &'static str,
) -> Response {
    og_headers_response(ok(value), cache_control, cdn_cache_control)
}

/// A missing upstream id is omitted in JSON. The Node Mongo driver encodes both
/// missing and explicit null ids as BSON null in these upserts.
struct UploadedImage(Option<Value>);

impl UploadedImage {
    async fn persist(
        &self,
        state: &AppState,
        collection: &str,
        field: &str,
        hash: &str,
    ) -> Result<()> {
        let id = node_bson(self.0.as_ref().unwrap_or(&Value::Null));
        // Document-valued ids are data, including any operator-shaped keys.
        let filter_id = match &id {
            Bson::Document(doc) if doc.keys().next().is_some_and(|k| k.starts_with('$')) => {
                Bson::Document(doc! {"$eq":&id})
            }
            _ => id.clone(),
        };
        state
            .mongo
            .update_one(
                collection,
                doc! {field:filter_id},
                doc! {"$set":{"imageId":id,"hash":hash}},
                true,
            )
            .await?;
        Ok(())
    }

    fn response(&self, delivery_url: bool) -> Value {
        let mut body = json!({});
        if let Some(id) = self.0.as_ref() {
            body["id"] = id.clone();
        }
        if delivery_url {
            let id = self
                .0
                .as_ref()
                .map(egdata_core::v1::serialization::js_string)
                .unwrap_or_else(|| "undefined".into());
            body["url"] = format!("{CF_DELIVERY_BASE}/{id}/og").into();
        }
        body
    }
}

async fn upload_cf_image(
    state: &AppState,
    filename: String,
    png_bytes: Vec<u8>,
) -> Result<std::result::Result<UploadedImage, Response>> {
    let account_id = state
        .config
        .cloudflare_account_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_CLOUDFLARE_ACCOUNT_ID);
    let token = state
        .config
        .cloudflare_images_token
        .as_deref()
        .unwrap_or("");
    let request = UpstreamHttpRequest {
        method: "POST".to_string(),
        url: format!("https://api.cloudflare.com/client/v4/accounts/{account_id}/images/v1"),
        headers: BTreeMap::from([("Authorization".to_string(), format!("Bearer {token}"))]),
        body: None,
        multipart_file: Some(UpstreamHttpMultipartFile {
            field_name: "file".to_string(),
            filename,
            content_type: "image/png".to_string(),
            bytes: png_bytes,
        }),
    };
    let response = state.http.send(request).await?;
    let parsed: Value = serde_json::from_slice(&response.body)?;
    if !(200..300).contains(&response.status) {
        return Ok(Err(super::json_response(
            StatusCode::BAD_REQUEST,
            &json!({ "error": "Failed to upload image" }),
        )));
    }
    let result = parsed
        .get("result")
        .filter(|v| !v.is_null())
        .ok_or(Error::Internal)?;
    Ok(Ok(UploadedImage(result.get("id").cloned())))
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

fn format_short_uk_date(value: Option<&Bson>) -> Result<String> {
    // Giveaway documents may predate BSON date normalization. The Node template
    // calls the value's own toLocaleString, so a stored string stays unchanged.
    match value {
        None | Some(Bson::Null | Bson::Undefined) => Err(Error::Internal),
        Some(Bson::DateTime(date)) => {
            let local = date.to_chrono().with_timezone(&chrono::Local);
            Ok(if local.month() == 9 {
                format!("{} Sept", local.day())
            } else {
                local.format("%-d %b").to_string()
            })
        }
        Some(Bson::Array(values)) => {
            let parts: Result<Vec<_>> = values
                .iter()
                .map(|v| {
                    if matches!(v, Bson::Null | Bson::Undefined) {
                        Ok(String::new())
                    } else {
                        format_short_uk_date(Some(v))
                    }
                })
                .collect();
            Ok(parts?.join(","))
        }
        Some(v) => {
            let value = egdata_infra::bson_json::bson_to_js_json(v);
            if let Some(n) = value.as_f64() {
                let digits = format!("{:.3}", n.abs());
                let (whole, fraction) = digits.split_once('.').unwrap_or((&digits, ""));
                let mut out = String::new();
                if n.is_sign_negative() {
                    out.push('-');
                }
                for (i, c) in whole.chars().enumerate() {
                    if i > 0 && (whole.len() - i).is_multiple_of(3) {
                        out.push(',');
                    }
                    out.push(c);
                }
                let fraction = fraction.trim_end_matches('0');
                if !fraction.is_empty() {
                    out.push('.');
                    out.push_str(fraction);
                }
                Ok(out)
            } else {
                Ok(egdata_core::v1::serialization::js_string(&value))
            }
        }
    }
}

fn free_cover(offer: &Value) -> Result<Option<String>> {
    let Some(images) = offer["keyImages"].as_array() else {
        return Ok(None);
    };
    for kind in FREE_GAMES_OG_IMAGE_PRIORITY {
        for image in images {
            if image.is_null() {
                return Err(Error::Internal);
            }
            if image["type"].as_str() == Some(kind) {
                return Ok(image["url"].as_str().map(str::to_owned));
            }
        }
    }
    Ok(images
        .first()
        .and_then(|image| image["url"].as_str())
        .map(str::to_owned))
}

fn format_thousands_en_us(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (idx, ch) in s.chars().rev().enumerate() {
        if idx > 0 && idx % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out.chars().rev().collect()
}

fn format_currency_en_us(amount_minor: f64, currency: &str) -> String {
    let precision = currency_precision(Some(currency));
    let divisor = 10_f64.powi(i32::from(precision));
    let rounded_units = (amount_minor * (divisor / 100.0)).round() as u64;
    let whole = rounded_units / divisor as u64;
    let whole_str = format_thousands_en_us(whole);
    let numeric = if precision == 0 {
        whole_str
    } else {
        let frac = rounded_units % divisor as u64;
        format!("{whole_str}.{frac:0width$}", width = usize::from(precision))
    };

    match currency.to_ascii_uppercase().as_str() {
        "USD" => format!("${numeric}"),
        "EUR" => format!("€{numeric}"),
        "GBP" => format!("£{numeric}"),
        "JPY" => format!("¥{numeric}"),
        "CNY" => format!("CN¥{numeric}"),
        "KRW" => format!("₩{numeric}"),
        "INR" => format!("₹{numeric}"),
        "VND" => format!("₫{numeric}"),
        "ILS" => format!("₪{numeric}"),
        "PHP" => format!("₱{numeric}"),
        "BRL" => format!("R${numeric}"),
        "CAD" => format!("CA${numeric}"),
        "AUD" => format!("A${numeric}"),
        "MXN" => format!("MX${numeric}"),
        "HKD" => format!("HK${numeric}"),
        "NZD" => format!("NZ${numeric}"),
        "TWD" => format!("NT${numeric}"),
        other => format!("{other}\u{00a0}{numeric}"),
    }
}

// ---------------------------------------------------------------------------
// GET /free-games/og
// ---------------------------------------------------------------------------

struct FreeGameOgCard {
    title: String,
    cover_url: Option<String>,
    start_label: String,
    end_label: String,
}

fn render_free_games_og_html(cards: &[FreeGameOgCard]) -> String {
    let mut grid = String::new();
    for card in cards {
        let img = card
            .cover_url
            .as_deref()
            .map(|url| {
                format!(
                    r#"<img alt="{}" src="{}" style="width:100%;height:100%;object-fit:cover;border-radius:8px;" />"#,
                    html_escape(&card.title),
                    html_escape(url)
                )
            })
            .unwrap_or_default();
        grid.push_str(&format!(
            r#"<div style="display:flex;flex-direction:column;flex:1;background:rgba(255, 255, 255, 0.05);border-radius:12px;padding:24px;border:1px solid rgba(255, 255, 255, 0.1);box-shadow:0 20px 40px rgba(0, 0, 0, 0.3);"><div style="width:100%;height:200px;background:rgba(0, 120, 242, 0.1);border-radius:8px;margin-bottom:16px;display:flex;align-items:center;justify-content:center;font-size:48px;color:#0078F2;font-weight:400;">{img}</div><div style="font-size:24px;font-weight:400;color:white;margin-bottom:8px;">{}</div><div style="font-size:16px;color:rgba(255, 255, 255, 1);display:flex;">{} - {}</div></div>"#,
            html_escape(&card.title),
            html_escape(&card.start_label),
            html_escape(&card.end_label),
        ));
    }

    format!(
        r#"<div style="width:1300px;height:630px;display:flex;flex-direction:column;background:#001B3D;font-family:Roboto,sans-serif;position:relative;overflow:hidden;"><div style="position:absolute;top:0;left:0;right:0;bottom:0;background:linear-gradient(135deg, rgba(0, 27, 61, 1) 0%, rgba(0, 9, 19, 1) 100%);"></div><div style="position:absolute;top:0;left:0;right:0;bottom:0;background-image:linear-gradient(to bottom, rgba(0, 120, 242, 0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(0, 120, 242, 0.05) 1px, transparent 1px);background-size:30px 30px;opacity:0.3;"></div><div style="padding:60px;flex:1;display:flex;flex-direction:column;position:relative;z-index:1;"><div style="margin-bottom:40px;display:flex;flex-direction:column;"><div style="font-size:32px;color:rgba(255, 255, 255, 0.9);margin-bottom:16px;text-transform:uppercase;letter-spacing:0.05em;">This Week on Epic Games</div><div style="font-size:72px;font-weight:400;color:#FFFFFF;text-shadow:0 0 30px rgba(0, 120, 242, 0.3);">FREE GAMES</div></div><div style="display:flex;gap:20px;">{grid}</div></div></div>"#
    )
}

async fn free_games_og(
    State(state): State<AppState>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Response> {
    let Some((region_code, _)) = selected_region(&uri, &headers) else {
        return Ok(missing_country());
    };

    let now = bson::DateTime::from_chrono((state.now)());
    let free_games = state
        .mongo
        .find_many(
            "freegames",
            doc! { "endDate": { "$gte": now } },
            MongoFindOptions {
                sort: Some(doc! { "endDate": 1 }),
                ..Default::default()
            },
        )
        .await?;

    let hex_hash = sha256_hex(
        node_json(&Value::Array(
            free_games
                .iter()
                .map(egdata_infra::bson_json::bson_doc_to_js_json)
                .collect(),
        ))
        .as_bytes(),
    );

    if let Some(cached_image) = one(&state, "freebies-og", doc! { "hash": &hex_hash }).await? {
        let mut body = json!({});
        if let Some(image_id) = cached_image.get("imageId") {
            body["id"] = image_id.clone();
        }
        return Ok(og_json_response(
            &body,
            OG_CACHE_CONTROL,
            OG_CDN_CACHE_CONTROL,
        ));
    }

    let cards = join_all(free_games.iter().map(|game| {
        let state = &state;
        async move {
            let game_id = game.get("id").cloned().unwrap_or(Bson::Null);
            let (offer_res, _price_res, _historical_res) = tokio::join!(
                one(state, "offers", doc! { "id": game_id.clone() }),
                one(
                    state,
                    "pricev2",
                    doc! { "offerId": game_id.clone(), "region": region_code }
                ),
                many(
                    state,
                    "freegames",
                    doc! { "id": game_id },
                    Default::default()
                ),
            );
            let offer = offer_res.ok().flatten();
            let offer = offer
                .as_ref()
                .map(super::catalog::checked_ordered_offer)
                .transpose()?;
            let game_json = egdata_infra::bson_json::bson_doc_to_js_json(game);
            let title = offer
                .as_ref()
                .and_then(|o| o.get("title"))
                .filter(|v| !v.is_null())
                .or_else(|| game_json.get("title").filter(|v| !v.is_null()));
            let title = match title {
                None => "Free game".into(),
                Some(Value::Bool(_)) => String::new(),
                Some(value) => egdata_core::v1::serialization::js_string(value),
            };
            Ok::<_, Error>(FreeGameOgCard {
                title,
                cover_url: offer.as_ref().map(free_cover).transpose()?.flatten(),
                start_label: format_short_uk_date(game.get("startDate"))?,
                end_label: format_short_uk_date(game.get("endDate"))?,
            })
        }
    }))
    .await
    .into_iter()
    .collect::<Result<Vec<_>>>()?;

    let html = render_free_games_og_html(&cards);
    let png_bytes = state
        .og
        .render_editorial(&html, egdata_core::ports::EditorialOgTemplate::FreeGames)
        .await?;

    let image_id =
        match upload_cf_image(&state, format!("freebies-og/{hex_hash}.png"), png_bytes).await? {
            Ok(id) => id,
            Err(err_response) => return Ok(err_response),
        };

    image_id
        .persist(&state, "freebies-og", "id", &hex_hash)
        .await?;
    Ok(og_json_response(
        &image_id.response(false),
        OG_CACHE_CONTROL,
        OG_CDN_CACHE_CONTROL,
    ))
}

// ---------------------------------------------------------------------------
// GET /collections/{slug}/{week}/og
// ---------------------------------------------------------------------------

struct RankedTopEntry {
    offer: Value,
    position: f64,
    price: Value,
}

fn collection_og_cell(content: &str, flex: &str, is_header: bool) -> String {
    if is_header {
        format!(
            r#"<div style="display:flex;flex-grow:{flex};flex-shrink:1;flex-basis:0;min-width:0;font-weight:400;color:white;font-size:24px;padding:10px 14px;align-items:center;">{}</div>"#,
            html_escape(content)
        )
    } else {
        format!(
            r#"<div style="display:flex;flex-grow:{flex};flex-shrink:1;flex-basis:0;min-width:0;font-size:20px;color:#ddd;padding:10px 14px;align-items:center;">{}</div>"#,
            html_escape(content)
        )
    }
}

fn render_collection_og_html(
    week: &str,
    region_code: &str,
    entries: &[RankedTopEntry],
    start: DateTime<Utc>,
    end_exclusive: DateTime<Utc>,
) -> String {
    let mut rows_html = String::new();
    for (idx, entry) in entries.iter().take(10).enumerate() {
        let bg = if idx % 2 == 0 { "#1a1a3e" } else { "#20204a" };
        let title = entry
            .offer
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("N/A");
        let price_inner = entry.price.get("price");
        let currency = price_inner
            .and_then(|p| p.get("currencyCode"))
            .and_then(Value::as_str)
            .unwrap_or("USD");
        let original_price = price_inner
            .and_then(|p| p.get("originalPrice"))
            .and_then(Value::as_f64);
        let discount_price = price_inner
            .and_then(|p| p.get("discountPrice"))
            .and_then(Value::as_f64);

        let discount_col = match (original_price, discount_price) {
            (Some(op), Some(dp)) if op != 0.0 && dp != 0.0 && op != dp => {
                let pct = (((op - dp) / op) * 100.0).round() as i64;
                format!("-{pct}%")
            }
            _ => String::new(),
        };
        let original_col = match (original_price, discount_price) {
            (Some(op), dp) if op != 0.0 && Some(op) != dp => format_currency_en_us(op, currency),
            _ => String::new(),
        };
        let price_col = match discount_price {
            Some(0.0) => "Free".to_string(),
            Some(dp) => format_currency_en_us(dp, currency),
            None => format_currency_en_us(0.0, currency),
        };

        let rank_col = format!("#{}", idx + 1);
        rows_html.push_str(&format!(
            r#"<div style="display:flex;flex-direction:row;align-items:center;width:100%;border-top:1px solid #3a3a6e;background-color:{bg};">{}{}{}{}{}</div>"#,
            collection_og_cell(&rank_col, "0.6", false),
            collection_og_cell(title, "3", false),
            collection_og_cell(&discount_col, "1", false),
            collection_og_cell(&original_col, "1", false),
            collection_og_cell(&price_col, "1.3", false),
        ));
    }

    let header_row = format!(
        "{}{}{}{}{}",
        collection_og_cell("Rank", "0.6", true),
        collection_og_cell("Title", "3", true),
        collection_og_cell("Discount", "1", true),
        collection_og_cell("Original", "1", true),
        collection_og_cell("Price", "1.3", true),
    );
    let start_str = start.format("%d/%m/%Y");
    let end_str = end_exclusive.format("%d/%m/%Y");

    format!(
        r#"<div style="height:630px;width:1200px;display:flex;flex-direction:column;align-items:stretch;justify-content:flex-start;background-color:#0f0f23;background-image:linear-gradient(45deg, #0f0f23 0%, #1a1a3e 100%);font-family:Roboto,sans-serif;padding:32px;box-sizing:border-box;gap:16px;"><div style="display:flex;align-items:center;gap:12px;color:white;"><div style="display:flex;font-size:40px;">🎮</div><div style="display:flex;font-size:36px;font-weight:400;">Epic Games Store — Top Sellers</div><div style="display:flex;margin-left:auto;color:#aaa;">{} · {}</div></div><div style="display:flex;flex-direction:column;flex-shrink:0;border:2px solid #3a3a6e;border-radius:10px;overflow:hidden;width:100%;background-color:#20204a;"><div style="display:flex;flex-direction:row;align-items:center;background-color:#2a2a4e;">{header_row}</div><div style="display:flex;flex-direction:column;width:100%;">{rows_html}</div></div><div style="display:flex;align-items:center;gap:8px;color:#999;font-size:14px;"><div style="display:flex;flex-direction:row;align-items:center;gap:8px;">{start_str}<span style="color:#666;">•</span>{end_str}</div></div></div>"#,
        html_escape(week),
        html_escape(region_code),
    )
}

async fn collection_week_og(
    State(state): State<AppState>,
    Path((slug, week)): Path<(String, String)>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Response> {
    let render = query(&uri, "svg").is_some_and(|v| !v.is_empty());
    let direct = query(&uri, "direct").is_some_and(|v| !v.is_empty());
    let has_stable_version = ["v", "hash"].iter().any(|key| {
        query(&uri, key).is_some_and(|v| !egdata_core::v1::trim_js_whitespace(&v).is_empty())
    });

    let (og_cache_control, og_cdn_cache_control) = if has_stable_version {
        (OG_IMMUTABLE_CACHE_CONTROL, OG_IMMUTABLE_CDN_CACHE_CONTROL)
    } else {
        (OG_CACHE_CONTROL, OG_CDN_CACHE_CONTROL)
    };

    let Some((region_code, _)) = selected_region(&uri, &headers) else {
        return Ok(missing_country());
    };

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

    let positions = state
        .mongo
        .find_many(
            "game_positions",
            doc! { "collectionId": &collection_id },
            Default::default(),
        )
        .await?;
    let mut top_items = Vec::new();
    for mut row in positions {
        let positions = row.remove("positions").unwrap_or(Bson::Null);
        if let Some(position) = weekly_position(
            &mut egdata_infra::bson_json::bson_to_js_json(&positions),
            start,
            end_exclusive,
        )? {
            top_items.push((position, row.remove("offerId")));
        }
    }
    top_items.sort_by(|a, b| a.0.total_cmp(&b.0));
    top_items.truncate(10);
    let ids: Vec<_> = top_items
        .iter()
        .map(|(_, id)| id.clone().unwrap_or(Bson::Null))
        .collect();
    let (offers, prices) = tokio::join!(biased;
        state.mongo.find_many("offers",doc! {"id":{"$in":&ids}},Default::default()),
        state.mongo.find_many("pricev2",doc! {"offerId":{"$in":ids},"region":region_code},Default::default()),
    );
    let (offers, prices) = (offers?, prices?);
    // Array.find takes the first matching primitive ID, including undefined.
    // ObjectIds belong to independent driver results and cannot match by reference.
    fn first_by_id(
        rows: &[bson::Document],
        field: &str,
    ) -> std::collections::HashMap<super::catalog::PrimitiveId, Value> {
        let mut result = std::collections::HashMap::new();
        for doc in rows {
            if let Some(key) = super::catalog::primitive_id(doc.get(field)) {
                result
                    .entry(key)
                    .or_insert_with(|| egdata_infra::bson_json::bson_doc_to_js_json(doc));
            }
        }
        result
    }
    let offers = first_by_id(&offers, "id");
    let prices = first_by_id(&prices, "offerId");
    let offers_with_metadata: Vec<_> = top_items
        .into_iter()
        .filter_map(|(position, id)| {
            let key = super::catalog::primitive_id(id.as_ref())?;
            Some(RankedTopEntry {
                offer: offers.get(&key)?.clone(),
                position,
                price: prices.get(&key)?.clone(),
            })
        })
        .collect();

    let hash_items: Vec<Value> = offers_with_metadata
        .iter()
        .map(|entry| {
            let price_inner = entry.price.get("price");
            let mut item = Map::new();
            for key in ["id", "title"] {
                if let Some(value) = entry.offer.get(key) {
                    item.insert(key.into(), value.clone());
                }
            }
            item.insert("pos".into(), json!(entry.position));
            item.insert(
                "dp".into(),
                price_inner
                    .and_then(|p| p.get("discountPrice"))
                    .filter(|v| !v.is_null())
                    .cloned()
                    .unwrap_or(Value::Null),
            );
            item.insert(
                "op".into(),
                price_inner
                    .and_then(|p| p.get("originalPrice"))
                    .filter(|v| !v.is_null())
                    .cloned()
                    .unwrap_or(Value::Null),
            );
            item.insert(
                "d".into(),
                price_inner
                    .and_then(|p| p.get("discount"))
                    .filter(|v| !v.is_null())
                    .cloned()
                    .unwrap_or(Value::Null),
            );
            Value::Object(item)
        })
        .collect();

    let mut hash_obj = Map::new();
    hash_obj.insert("week".into(), json!(&week));
    hash_obj.insert("region".into(), json!(region_code));
    hash_obj.insert("items".into(), Value::Array(hash_items));
    let hex_hash = sha256_hex(node_json(&Value::Object(hash_obj)).as_bytes());

    let existing_image = if !render {
        one(&state, "tops-og", doc! { "hash": &hex_hash }).await?
    } else {
        None
    };

    if let Some(existing) = existing_image
        && !direct
        && !render
    {
        let mut body = Map::new();
        let id_str = existing
            .get("imageId")
            .map(egdata_core::v1::serialization::js_string)
            .unwrap_or_else(|| "undefined".into());
        if let Some(id_val) = existing.get("imageId") {
            body.insert("id".into(), id_val.clone());
        }
        body.insert(
            "url".into(),
            json!(format!("{CF_DELIVERY_BASE}/{id_str}/og")),
        );
        return Ok(og_json_response(
            &Value::Object(body),
            og_cache_control,
            og_cdn_cache_control,
        ));
    }

    // The Node table dereferences the record key in each of its ten rows.
    if offers_with_metadata.len() < 10 {
        return Err(Error::Internal);
    }
    let html = render_collection_og_html(
        &week,
        region_code,
        &offers_with_metadata,
        start,
        end_exclusive,
    );
    let png_bytes = state
        .og
        .render_editorial(&html, egdata_core::ports::EditorialOgTemplate::Collection)
        .await?;

    if direct {
        let resp = Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "image/png")
            .body(Body::from(png_bytes))
            .unwrap();
        return Ok(og_headers_response(
            resp,
            og_cache_control,
            og_cdn_cache_control,
        ));
    }

    let image_id =
        match upload_cf_image(&state, format!("tops-og/{hex_hash}.png"), png_bytes).await? {
            Ok(id) => id,
            Err(err_response) => return Ok(err_response),
        };

    image_id
        .persist(&state, "tops-og", "imageId", &hex_hash)
        .await?;
    Ok(og_json_response(
        &image_id.response(true),
        og_cache_control,
        og_cdn_cache_control,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{test_support::test_app_state, state::ApiConfig};
    use async_trait::async_trait;
    use axum::http::Request;
    use bson::Document;
    use chrono::Weekday;
    use egdata_core::{
        error::CoreError,
        ports::{
            AcceptedJobSubmission, JobApiPort, MongoStorePort, OgImageFormat, OgRendererPort,
            ResponseCachePort, UpstreamHttpPort, UpstreamHttpResponse,
        },
    };
    use egdata_infra::bson_json::bson_doc_to_js_json;
    use std::collections::HashMap;
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
                .unwrap_or_else(|| {
                    panic!(
                        "{}: unexpected {call}; expected {:?}",
                        self.name,
                        remaining.first().map(|e| &e["call"])
                    )
                });
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
            let value = self.replay(json!({
                "collection": collection,
                "method": "one",
                "query": fixture_doc(&filter),
                "options": find_options(MongoFindOptions { projection, ..Default::default() }),
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
            Ok(value.as_array().unwrap().iter().map(result_doc).collect())
        }

        async fn aggregate(
            &self,
            _: &str,
            _: Vec<Document>,
        ) -> StdResult<Vec<Document>, CoreError> {
            unreachable!()
        }

        async fn count_documents(&self, _: &str, _: Document) -> StdResult<u64, CoreError> {
            unreachable!()
        }

        async fn distinct(&self, _: &str, _: &str, _: Document) -> StdResult<Vec<Bson>, CoreError> {
            unreachable!()
        }

        async fn insert_one(&self, _: &str, _: Document) -> StdResult<(), CoreError> {
            unreachable!()
        }

        async fn update_one(
            &self,
            collection: &str,
            filter: Document,
            update: Document,
            upsert: bool,
        ) -> StdResult<u64, CoreError> {
            let res = self.replay(json!({
                "collection": collection,
                "method": "update",
                "query": fixture_doc(&filter),
                "options": {
                    "update": fixture_doc(&update),
                    "upsert": upsert,
                },
            }))?;
            Ok(res["modifiedCount"].as_u64().unwrap())
        }

        async fn delete_one(&self, _: &str, _: Document) -> StdResult<u64, CoreError> {
            unreachable!()
        }

        async fn ping(&self) -> StdResult<bool, CoreError> {
            unreachable!()
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
            unreachable!()
        }

        async fn ping(&self) -> StdResult<bool, CoreError> {
            unreachable!()
        }
    }

    #[async_trait]
    impl JobApiPort for OracleIo {
        async fn submit(
            &self,
            job_type: JobApiJobType,
            payload: &Value,
            request_id: Option<&str>,
        ) -> StdResult<AcceptedJobSubmission, CoreError> {
            let result = self.replay(json!({
                "service": "job",
                "method": "submit",
                "jobType": job_type,
                "payload": payload,
                "requestId": request_id,
            }))?;
            Ok(serde_json::from_value(result).unwrap())
        }

        async fn submit_batch(
            &self,
            job_type: JobApiJobType,
            payloads: &[Value],
            request_id: Option<&str>,
        ) -> StdResult<Vec<AcceptedJobSubmission>, CoreError> {
            let result = self.replay(json!({
                "service": "job",
                "method": "submitBatch",
                "jobType": job_type,
                "payloads": payloads,
                "requestId": request_id,
            }))?;
            Ok(serde_json::from_value(result).unwrap())
        }
    }

    #[async_trait]
    impl OgRendererPort for OracleIo {
        async fn render_image(
            &self,
            html: &str,
            _width: u32,
            _height: u32,
            _format: OgImageFormat,
        ) -> StdResult<Vec<u8>, CoreError> {
            self.rendered_html.lock().unwrap().push(html.to_owned());
            Ok(vec![137, 80, 78, 71])
        }
    }

    #[async_trait]
    impl UpstreamHttpPort for OracleIo {
        async fn send(
            &self,
            request: UpstreamHttpRequest,
        ) -> StdResult<UpstreamHttpResponse, CoreError> {
            let file = request.multipart_file.expect("multipart file");
            let mut remaining = self.remaining.lock().unwrap();
            let call = json!({
                "service": "http",
                "method": request.method,
                "url": request.url,
                "authorization": request.headers.get("Authorization"),
                "fileName": file.filename,
                "contentType": file.content_type,
                "byteLength": file.bytes.len(),
            });
            let index = remaining
                .iter()
                .position(|entry| entry["call"] == call)
                .unwrap_or_else(|| {
                    panic!(
                        "{}: unexpected http {call}; expected {:?}",
                        self.name,
                        remaining.first().map(|e| &e["call"])
                    )
                });
            let entry = remaining.remove(index);
            if entry["error"] == true {
                return Err(CoreError::Internal("fixture transport failed".into()));
            }
            Ok(UpstreamHttpResponse {
                status: entry["status"].as_u64().unwrap() as u16,
                body: entry["rawBody"]
                    .as_str()
                    .map(|raw| raw.as_bytes().to_vec())
                    .unwrap_or_else(|| serde_json::to_vec(&entry["result"]).unwrap()),
            })
        }
    }

    #[tokio::test]
    async fn legacy_root_ops_http_node_oracle() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../egdata-api/tests/fixtures/legacy-root-ops-http-node.json"
        ))
        .unwrap();

        for case in cases {
            let name = case["name"].as_str().unwrap();
            let io = Arc::new(OracleIo {
                name: name.into(),
                remaining: Mutex::new(case["trace"].as_array().unwrap().clone()),
                rendered_html: Mutex::new(Vec::new()),
            });
            let mut state = test_app_state(ApiConfig {
                cloudflare_images_token: Some("cf-test-token".into()),
                ..Default::default()
            });
            state.now = || "2026-11-17T00:00:00.000Z".parse().unwrap();
            state.mongo = io.clone();
            state.cache = io.clone();
            state.job_api = io.clone();
            state.og = io.clone();
            state.http = io.clone();

            let app = egdata_api::runtime::application(state);
            let source = &case["request"];
            let mut builder = Request::builder()
                .method(source["method"].as_str().unwrap())
                .uri(source["path"].as_str().unwrap());
            if let Some(headers) = source["headers"].as_object() {
                for (k, v) in headers {
                    builder = builder.header(k, v.as_str().unwrap());
                }
            }
            let body = source
                .get("rawBody")
                .and_then(Value::as_str)
                .map(|raw| Body::from(raw.to_owned()))
                .unwrap_or_default();
            let response = app.oneshot(builder.body(body).unwrap()).await.unwrap();
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
                egdata_api_test_support::capture_response(response).await,
                case["response"],
                "{name}"
            );
            assert!(
                io.remaining.lock().unwrap().is_empty(),
                "{name} missing reads"
            );

            if let Some(labels) = case["renderedLabels"].as_array() {
                let templates = io.rendered_html.lock().unwrap();
                assert_eq!(templates.len(), 1, "{name}");
                for label in labels {
                    assert!(
                        templates[0].contains(label.as_str().unwrap()),
                        "{name}: {label}"
                    );
                }
            }

            if let Some(rendered) = case.get("rendered").and_then(Value::as_str) {
                let html_list = io.rendered_html.lock().unwrap();
                assert_eq!(html_list.len(), 1, "{name} expected rendered HTML");
                let html = &html_list[0];
                if rendered.contains("FREE GAMES") {
                    assert!(html.contains("This Week on Epic Games"));
                    assert!(html.contains("FREE GAMES"));
                    assert!(html.contains("Free Game One"));
                    assert!(html.contains("12 Nov - 19 Nov"));
                } else {
                    assert!(html.contains("Epic Games Store — Top Sellers"));
                    assert!(html.contains("2025W31 · US"));
                    assert!(html.contains("Top Game 1"));
                    assert!(html.contains("-50%"));
                    assert!(html.contains("$14.99"));
                    assert!(html.contains("28/07/2025"));
                }
            }
        }
    }

    #[derive(Default)]
    struct MockRootStore {
        free_games: Mutex<Vec<Document>>,
        offers: Mutex<Vec<Document>>,
        prices: Mutex<Vec<Document>>,
        collections: Mutex<Vec<Document>>,
        positions: Mutex<Vec<Document>>,
        freebies_og: Mutex<Vec<Document>>,
        tops_og: Mutex<Vec<Document>>,
        fail_collection: Mutex<Option<&'static str>>,
        fail_og: Mutex<bool>,
        fail_http: Mutex<bool>,
        http_status: Mutex<u16>,
        http_body: Mutex<Vec<u8>>,
    }

    #[async_trait]
    impl MongoStorePort for MockRootStore {
        async fn find_one(
            &self,
            collection: &str,
            filter: Document,
            _p: Option<Document>,
        ) -> StdResult<Option<Document>, CoreError> {
            if *self.fail_collection.lock().unwrap() == Some(collection) {
                return Err(CoreError::Internal("mock mongo failure".into()));
            }
            let list = match collection {
                "offers" => self.offers.lock().unwrap().clone(),
                "pricev2" => self.prices.lock().unwrap().clone(),
                "collections_v2" => self.collections.lock().unwrap().clone(),
                "freebies-og" => self.freebies_og.lock().unwrap().clone(),
                "tops-og" => self.tops_og.lock().unwrap().clone(),
                _ => Vec::new(),
            };
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
                "freegames" => self.free_games.lock().unwrap().clone(),
                "offers" => self.offers.lock().unwrap().clone(),
                "pricev2" => self.prices.lock().unwrap().clone(),
                "game_positions" => self.positions.lock().unwrap().clone(),
                _ => Vec::new(),
            })
        }

        async fn aggregate(
            &self,
            _: &str,
            _: Vec<Document>,
        ) -> StdResult<Vec<Document>, CoreError> {
            Ok(vec![])
        }

        async fn count_documents(&self, _: &str, _: Document) -> StdResult<u64, CoreError> {
            Ok(0)
        }

        async fn distinct(&self, _: &str, _: &str, _: Document) -> StdResult<Vec<Bson>, CoreError> {
            Ok(vec![])
        }

        async fn insert_one(&self, _: &str, _: Document) -> StdResult<(), CoreError> {
            Ok(())
        }

        async fn update_one(
            &self,
            collection: &str,
            _f: Document,
            _u: Document,
            _up: bool,
        ) -> StdResult<u64, CoreError> {
            if *self.fail_collection.lock().unwrap() == Some(collection) {
                return Err(CoreError::Internal("mock update failure".into()));
            }
            Ok(1)
        }

        async fn delete_one(&self, _: &str, _: Document) -> StdResult<u64, CoreError> {
            Ok(0)
        }

        async fn ping(&self) -> StdResult<bool, CoreError> {
            Ok(true)
        }
    }

    #[async_trait]
    impl OgRendererPort for MockRootStore {
        async fn render_image(
            &self,
            _html: &str,
            _width: u32,
            _height: u32,
            _format: OgImageFormat,
        ) -> StdResult<Vec<u8>, CoreError> {
            if *self.fail_og.lock().unwrap() {
                return Err(CoreError::Internal("og failure".into()));
            }
            Ok(vec![137, 80, 78, 71])
        }
    }

    #[async_trait]
    impl UpstreamHttpPort for MockRootStore {
        async fn send(
            &self,
            _request: UpstreamHttpRequest,
        ) -> StdResult<UpstreamHttpResponse, CoreError> {
            if *self.fail_http.lock().unwrap() {
                return Err(CoreError::Upstream("http failure".into()));
            }
            Ok(UpstreamHttpResponse {
                status: *self.http_status.lock().unwrap(),
                body: self.http_body.lock().unwrap().clone(),
            })
        }
    }

    #[test]
    fn helpers_cover_all_branches_and_formats() {
        assert_eq!(
            html_escape("a&b<c>d\"e'f"),
            "a&amp;b&lt;c&gt;d&quot;e&#39;f"
        );

        assert!(format_short_uk_date(None).is_err());
        assert_eq!(
            format_short_uk_date(Some(&Bson::String("stored date".into())))
                .ok()
                .as_deref(),
            Some("stored date")
        );
        for (date, expected) in [
            ("2026-09-05T12:00:00Z", "5 Sept"),
            ("2026-11-12T16:00:00Z", "12 Nov"),
        ] {
            let date = Bson::DateTime(bson::DateTime::parse_rfc3339_str(date).unwrap());
            assert_eq!(
                format_short_uk_date(Some(&date)).ok().as_deref(),
                Some(expected)
            );
        }

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
            assert_eq!(format_currency_en_us(1999.0, cur), expected);
        }

        assert!(iso_week_range_utc("bad").is_err());
        assert!(iso_week_range_utc("2025X01").is_err());
        assert!(iso_week_range_utc("2025Wab").is_err());
        let (s99, e99) = iso_week_range_utc("0099W01").ok().unwrap();
        assert_eq!((e99 - s99).num_days(), 7);
        let (s_sun, _) = iso_week_range_utc("2026W01").ok().unwrap();
        assert_eq!(s_sun.weekday(), Weekday::Mon);

        // Render HTML with missing discountPrice/originalPrice & non-empty cover URL
        let free_html = render_free_games_og_html(&[
            FreeGameOgCard {
                title: "A".into(),
                cover_url: Some("https://cdn.test/a.png".into()),
                start_label: "1 Nov".into(),
                end_label: "8 Nov".into(),
            },
            FreeGameOgCard {
                title: "B".into(),
                cover_url: None,
                start_label: String::new(),
                end_label: String::new(),
            },
        ]);
        let real_free_png = egdata_infra::og_renderer::render_html_to_image(
            &free_html,
            (1300, 630),
            egdata_infra::og_renderer::OgImageFormat::Png,
            HashMap::new(),
        )
        .unwrap();
        assert_eq!(&real_free_png[..4], &[137, 80, 78, 71]);

        let col_html = render_collection_og_html(
            "2025W31",
            "US",
            &[
                RankedTopEntry {
                    offer: json!({ "id": "1", "title": "Free" }),
                    position: 1.0,
                    price: json!({ "price": { "currencyCode": "USD", "originalPrice": 1000, "discountPrice": 0 } }),
                },
                RankedTopEntry {
                    offer: json!({ "id": "2", "title": "Half" }),
                    position: 2.0,
                    price: json!({ "price": { "currencyCode": "USD", "originalPrice": 1000, "discountPrice": 500 } }),
                },
                RankedTopEntry {
                    offer: json!({ "id": "3", "title": "Unpriced" }),
                    position: 3.0,
                    price: json!({}),
                },
            ],
            s_sun,
            s_sun + Duration::days(7),
        );
        let real_col_png = egdata_infra::og_renderer::render_html_to_image(
            &col_html,
            (1200, 630),
            egdata_infra::og_renderer::OgImageFormat::Png,
            HashMap::new(),
        )
        .unwrap();
        assert_eq!(&real_col_png[..4], &[137, 80, 78, 71]);
    }

    #[tokio::test]
    async fn real_editorial_template_render_references() {
        use axum::routing::get;
        use egdata_core::ports::EditorialOgTemplate;
        use egdata_infra::port_adapters::TakumiOgRenderer;

        let cover = include_bytes!("../../egdata-api/tests/fixtures/og-parity-cover.png");
        let router = axum::Router::new().route(
            "/cover",
            get(|| async { ([(header::CONTENT_TYPE, "image/png")], cover.as_slice()) }),
        );
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let cover_url = format!("http://{}/cover", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let free_games = render_free_games_og_html(&[FreeGameOgCard {
            title: "Free Game One".into(),
            cover_url: Some(cover_url.clone()),
            start_label: "12 Nov".into(),
            end_label: "19 Nov".into(),
        }]);
        let entries = (1..=10)
            .map(|rank| RankedTopEntry {
                offer: json!({"title":format!("Top Game {rank}")}),
                position: f64::from(rank),
                price: json!({"price":{"currencyCode":"USD","originalPrice":2999,
                "discountPrice": match rank {1=>0,2=>1499,_=>2999}}}),
            })
            .collect::<Vec<_>>();
        let (start, end) = iso_week_range_utc("2025W31").ok().unwrap();
        let collection = render_collection_og_html("2025W31", "US", &entries, start, end);
        let awards = crate::og_editorial::game_awards_og_html(
            "2026-11-17T00:00:00Z".parse().unwrap(),
        )
        .replace(
            "https://cdn.egdata.app/logo_simple_white_clean.png",
            &cover_url,
        );
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../egdata-api/tests/fixtures");
        for (name, template, html) in [
            ("free-games", EditorialOgTemplate::FreeGames, free_games),
            ("collection", EditorialOgTemplate::Collection, collection),
            ("game-awards", EditorialOgTemplate::GameAwards, awards),
        ] {
            let bytes = TakumiOgRenderer::new()
                .render_editorial(&html, template)
                .await
                .unwrap();
            let path = directory.join(format!("og-rust-{name}.png"));
            if std::env::var("OG_RENDER_WRITE").as_deref() == Ok("1") {
                std::fs::write(&path, &bytes).unwrap();
            }
            assert!(
                std::fs::read(path).unwrap() == bytes,
                "Rust {name} image changed"
            );
        }
        server.abort();
    }

    #[tokio::test]
    async fn edge_cases_and_error_paths() {
        let store = Arc::new(MockRootStore::default());
        *store.http_status.lock().unwrap() = 200;
        *store.http_body.lock().unwrap() = br#"{"result":{"id":"cf-id"}}"#.to_vec();

        store.free_games.lock().unwrap().push(doc! {
            "id": "fg1",
            "startDate": bson::DateTime::from_millis(1_762_905_600_000),
            "endDate": bson::DateTime::from_millis(1_763_510_400_000),
        });
        store.offers.lock().unwrap().push(doc! {
            "id": "fg1",
            "title": "FG",
            "keyImages": ["bad", { "type": "DieselGameBoxWide", "url": "https://img/fg.png" }],
        });
        store.collections.lock().unwrap().push(doc! {
            "_id": "top",
            "name": "Top",
        });
        store.positions.lock().unwrap().push(doc! {
            "offerId": "fg1",
            "positions": [
                { "position": 2, "date": "bad-date" },
                { "position": 0, "date": "2025-07-30T00:00:00.000Z" },
                { "position": 3, "date": "2025-07-29T00:00:00.000Z" },
                { "position": 1, "date": "2025-07-30T00:00:00.000Z" },
                { "position": 4, "date": "2025-07-28T00:00:00.000Z" },
            ],
        });
        store.positions.lock().unwrap().push(doc! {
            "offerId": "missing-offer",
            "positions": [{ "position": 2, "date": "2025-07-30T00:00:00.000Z" }],
        });
        store.prices.lock().unwrap().push(doc! {
            "offerId": "fg1",
            "region": "US",
            "price": { "currencyCode": "USD", "originalPrice": 1000, "discountPrice": 500, "discount": 500 },
        });

        let mut state = test_app_state(ApiConfig {
            cloudflare_account_id: Some("custom-acc".into()),
            cloudflare_images_token: Some("tok".into()),
            ..Default::default()
        });
        state.now = || "2026-11-17T00:00:00Z".parse().unwrap();
        state.mongo = store.clone();
        state.og = store.clone();
        state.http = store.clone();
        let app = egdata_api::runtime::application(state);

        // free-games/og with Promise.allSettled price failure & custom account id
        *store.fail_collection.lock().unwrap() = Some("pricev2");
        let r_fg = app
            .clone()
            .oneshot(Request::get("/free-games/og").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(r_fg.status(), StatusCode::OK);

        // collections/{slug}/{week}/og with whitespace ?v=  and pricev2 failure -> 500
        let r_col_err = app
            .clone()
            .oneshot(
                Request::get("/collections/top/2025W31/og?v=%20")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_col_err.status(), StatusCode::INTERNAL_SERVER_ERROR);

        // collections/{slug}/{week}/og with cached image without imageId & non-versioned headers
        *store.fail_collection.lock().unwrap() = None;
        store.tops_og.lock().unwrap().push(doc! { "other": 1 });
        let r_col_hit = app
            .clone()
            .oneshot(
                Request::get("/collections/top/2025W31/og")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_col_hit.status(), StatusCode::OK);
        assert_eq!(
            r_col_hit.headers().get(header::CACHE_CONTROL).unwrap(),
            OG_CACHE_CONTROL
        );

        // freebies-og cached without imageId
        store.freebies_og.lock().unwrap().push(doc! { "other": 1 });
        let r_fg_hit = app
            .clone()
            .oneshot(Request::get("/free-games/og").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(r_fg_hit.status(), StatusCode::OK);

        // An incomplete leaderboard cannot be rendered, even when a cached image exists.
        let incomplete = app
            .clone()
            .oneshot(
                Request::get("/collections/top/2025W31/og?svg=1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(incomplete.status(), StatusCode::INTERNAL_SERVER_ERROR);

        store
            .positions
            .lock()
            .unwrap()
            .retain(|row| row.get_str("offerId") == Ok("fg1"));
        for rank in 2..=10 {
            let id = format!("top-{rank}");
            store.positions.lock().unwrap().push(doc!{"offerId":&id,"positions":[{"position":rank,"date":"2025-07-30T00:00:00.000Z"}]});
            store
                .offers
                .lock()
                .unwrap()
                .push(doc! {"id":&id,"title":&id});
            store
                .prices
                .lock()
                .unwrap()
                .push(doc! {"offerId":&id,"price":{"currencyCode":"USD","discountPrice":1500}});
        }

        // OG render error -> 500
        *store.fail_og.lock().unwrap() = true;
        let r_og_err = app
            .clone()
            .oneshot(
                Request::get("/collections/top/2025W31/og?svg=1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_og_err.status(), StatusCode::INTERNAL_SERVER_ERROR);

        // HTTP send error -> 500
        *store.fail_og.lock().unwrap() = false;
        *store.fail_http.lock().unwrap() = true;
        let r_http_err = app
            .clone()
            .oneshot(
                Request::get("/collections/top/2025W31/og?svg=1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_http_err.status(), StatusCode::INTERNAL_SERVER_ERROR);

        // Invalid JSON from CF Images -> 500
        *store.fail_http.lock().unwrap() = false;
        *store.http_body.lock().unwrap() = b"not-json".to_vec();
        let r_bad_json = app
            .clone()
            .oneshot(
                Request::get("/collections/top/2025W31/og?svg=1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_bad_json.status(), StatusCode::INTERNAL_SERVER_ERROR);

        // Node omits an absent result.id from the JSON and interpolates undefined in the delivery URL.
        *store.http_body.lock().unwrap() = br#"{"result":{}}"#.to_vec();
        let r_missing_id = app
            .clone()
            .oneshot(
                Request::get("/collections/top/2025W31/og?svg=1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_missing_id.status(), StatusCode::OK);
        let body = axum::body::to_bytes(r_missing_id.into_body(), 4096)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({"url":format!("{CF_DELIVERY_BASE}/undefined/og")})
        );

        // Update failure in tops-og -> 500
        *store.http_body.lock().unwrap() = br#"{"result":{"id":"ok"}}"#.to_vec();
        *store.fail_collection.lock().unwrap() = Some("tops-og");
        let r_upd_err = app
            .clone()
            .oneshot(
                Request::get("/collections/top/2025W31/og?svg=1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_upd_err.status(), StatusCode::INTERNAL_SERVER_ERROR);

        // Invalid collation_locale on GET /
        let bad_state = test_app_state(ApiConfig {
            collation_locale: "bad_locale!".into(),
            ..Default::default()
        });
        let bad_app = egdata_api::runtime::application(bad_state);
        let r_root_err = bad_app
            .oneshot(Request::get("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(r_root_err.status(), StatusCode::INTERNAL_SERVER_ERROR);

        // Invalid JSON in POST /offers/bulk-regen
        let r_bulk_bad = app
            .oneshot(
                Request::post("/offers/bulk-regen")
                    .body(Body::from("{"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r_bulk_bad.status(), StatusCode::INTERNAL_SERVER_ERROR);

        // Exercise unused trait methods on MockRootStore & OracleIo
        let _ = MongoStorePort::aggregate(store.as_ref(), "x", vec![]).await;
        let _ = MongoStorePort::count_documents(store.as_ref(), "x", doc! {}).await;
        let _ = MongoStorePort::distinct(store.as_ref(), "x", "y", doc! {}).await;
        let _ = MongoStorePort::insert_one(store.as_ref(), "x", doc! {}).await;
        let _ = MongoStorePort::delete_one(store.as_ref(), "x", doc! {}).await;
        let _ = MongoStorePort::ping(store.as_ref()).await;
        let _ = store.find_one("unknown", doc! {}, None).await;
        let _ = store
            .find_many("unknown", doc! {}, Default::default())
            .await;

        let io = OracleIo {
            name: "err-test".into(),
            remaining: Mutex::new(vec![json!({
                "call": { "collection": "offers", "method": "one", "query": {}, "options": {} },
                "error": true,
            })]),
            rendered_html: Mutex::new(vec![]),
        };
        assert!(io.find_one("offers", doc! {}, None).await.is_err());
    }
}
